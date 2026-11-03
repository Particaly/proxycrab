/**
 * 依赖自动推断器（M10-T1）。
 *
 * ROADMAP M10-T1：在已捕获的响应中反查后续请求用到的值（token / id / csrf），
 * 自动生成「请求 B 的 header 引用请求 A 响应 `$.data.token`」这类连线与变量
 * 绑定，免手写模板。本模块实现其纯逻辑核心：推断（枚举候选值 → 匹配下游
 * 字段 → 产出建议）与应用（建议 → 连线 + 下游字段改写 + 上游输出暴露），
 * 全部为纯函数、零环境依赖（不依赖 React / 存储 / 网络），node 可直接单测。
 *
 * 推断模型：
 *   - 上游候选值来源（快照首个 HAR entry 的响应）：
 *     1. 响应 JSON body 的叶子原始值（字符串 / 数字，点分路径，如 `data.token`）；
 *     2. 响应头值（路径 `headers.<小写头名>`，如 `headers.authorization`）。
 *   - 下游匹配槽位（快照基线 + override 合并后的有效请求，与 M5-T2 重放合并
 *     语义一致）：URL 查询参数、URL 路径段、请求头（含 `Bearer <token>` 等
 *     scheme 包裹形式）、JSON body 字符串叶子字段；精确匹配候选值即命中。
 *   - 同一下游槽位被多个上游命中时取「最近」上游：已有连线上 BFS 距离小者
 *     优先，其次快照捕获时间新者优先（新值更可能是当前有效的凭据），再次
 *     节点 id 字典序保证确定性。
 *   - 仅「捕获时间严格早于下游」的响应参与推断（响应先于请求发生的时序语义）。
 *
 * 运行时正确性（重要约定）：httpReplay 节点无后置脚本时 output 为响应包裹
 * `{ status, statusText, headers, body(text), json?, bodyType, durationMs }`，
 * 其中 body 是响应体原文文本、json 是自动类型判断给出的解析值（M12-T3，仅
 * JSON 响应存在；见 engine/replay-response.ts）。要取响应 JSON 字段，无脚本时
 * 模板路径以 `json.` 开头（`{{ node.<id>.json.data.token }}`），或按本模块的
 * 既定做法补脚本吃下 body。为让推断产出的模板路径短且稳定
 * （`{{ node.<id>.data.token }}`），JSON body 类建议在应用时会**顺带给上游
 * 节点补上后置脚本** `return JSON.parse(response.body)`（JSON_EXTRACT_POST_SCRIPT，
 * 使 output = 解析后的 body 本身；body 保持文本，脚本与历史形态一致），上游已
 * 有自定义后置脚本（输出形状不可知）时该上游不产出 JSON body 类候选——
 * 保证生成的模板表达式在运行时确实可解析。
 *
 * 应用语义（applySuggestions）：
 *   1. 下游字段改写落在 `config.override`（URL / headers / body），与 M5-T2
 *      重放的「override 逐键覆盖 HAR 基线」语义一致；改写以「当前值中仍存在
 *      匹配值」为前提——用户已改动该字段时该条建议按失效跳过（不应用、不加线）；
 *   2. 为每条成功应用的建议补上游 → 下游连线（已存在则不重复）；
 *   3. JSON body 类建议为上游补 JSON 解析后置脚本（仅在其无后置脚本时）。
 *
 * 边界（推断不出的情况，UI 空态与说明照此措辞）：
 *   - 画布上引用请求快照的 httpReplay 节点少于 2 个；
 *   - 上游响应体非 JSON / 被 M2-T4 体积管理截断 / base64 二进制（无 body 候选，
 *     仅剩响应头候选）；上游已有自定义后置脚本（无 body 候选）；
 *   - 值长度 < 4（过短易误命中）或 > 512、布尔 / null / 含控制字符的值不参与；
 *   - 结构性响应头（content-type / date / server 等）不作候选来源；
 *   - 下游 cookie 头不作为改写目标（重放时被剥离，见 replay 的 HEADERS_POLICY；
 *     cookie 携带交由 fetch credentials 通道）；
 *   - 已含 `{{ }}` 模板的字段整槽跳过（不覆盖既有绑定）；
 *   - 表单编码等非 JSON body 不做字段级改写（仅 JSON body 支持）；
 *   - 查询参数解码值与原始编码形态不一致（如含空格被编码为 %20）时不产出
 *     URL 参数建议（改写后无法逐字还原，宁缺毋滥）。
 *
 * 注意：本文件不通过 src/engine/index.ts 桶文件再导出（与 template.ts 同一
 * 约定，避免共享文件合并冲突），调用方按路径 `@/engine/dependency-inference`
 * 直接引入。
 */

import type {
  NodeConfig,
  NodeId,
  RequestId,
  RequestRecord,
  WorkflowEdge,
  WorkflowNode,
} from "./types";
import { asEdgeId, asNodeId, HTTP_METHODS } from "./types";
import { stripBrowserOnlyHeaders } from "./replay";
import { parseUrl } from "./url-lite";
import type { LiteUrl } from "./url-lite";
import { hostRandomUuid } from "./host-env";

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 候选值最小长度：过短的值（如 '1'、'abc'）易产生大量误命中，不参与匹配 */
export const MIN_MATCH_VALUE_LENGTH = 4;

/** 候选值最大长度：超长值（长文本 / 截断体）不具备「凭据 / 标识」语义 */
export const MAX_MATCH_VALUE_LENGTH = 512;

/** JSON 树下钻最大深度（防超深嵌套导致的组合爆炸） */
export const MAX_JSON_WALK_DEPTH = 8;

/** 单个上游的候选值上限（防御性截断，超出按枚举顺序丢弃） */
export const MAX_CANDIDATES_PER_UPSTREAM = 200;

/**
 * 「暴露响应 JSON」的规范后置脚本：应用 JSON body 类建议时，为无后置脚本的
 * 上游节点写入该脚本，使节点 output = JSON.parse(response.body)（脚本失败即
 * 节点 failed——响应不再是 JSON 属数据变更，由运行期暴露，不做静默兜底）。
 *
 * M12-T3 说明：重放输出的 body 保持原文文本（自动类型判断的解析值在并列的
 * json 字段，见 engine/replay-response.ts），故本脚本语义不变；无脚本的上游
 * 也可直接用 `{{ node.<id>.json.<path> }}` 取字段（本推断仍补脚本，让生成的
 * 模板路径与历史形态一致，且对非 JSON 响应尽早如实失败）。
 */
export const JSON_EXTRACT_POST_SCRIPT = "return JSON.parse(response.body)";

/**
 * 结构性响应头（小写）：作为「候选值来源」时几乎必然造成误命中
 * （如 B 的 accept 与 A 的 content-type 同值），不参与候选枚举。
 */
const STRUCTURAL_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "date",
  "server",
  "connection",
  "cache-control",
  "expires",
  "pragma",
  "vary",
  "keep-alive",
  "age",
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
  "host",
]);

/** 请求头包裹形式的识别：scheme 前缀 + 空白 + 值（如 'Bearer <token>'） */
const WRAPPED_HEADER_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]+(\S.*)$/;

/** 模板表达式核心的识别（应用侧从 suggestedValue 反取 {{ ... }} 部分） */
const TEMPLATE_CORE_PATTERN = /\{\{[\s\S]*?\}\}/;

/** 连线去重 / 待办集合的键分隔符（竖线不会出现在节点 id 中，安全可读） */
const PAIR_KEY_SEPARATOR = "|";

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 上游候选值：响应中可被下游引用的一个值及其输出路径 */
export interface UpstreamCandidate {
  /** 值的字符串形式（原始值；数字经 String()） */
  value: string;
  /** 节点 output 上的点分取值路径（'data.token' / 'headers.authorization'） */
  responsePath: string;
  /** 是否取自响应 JSON body（true 时应用侧需确保上游 output 已解析 JSON） */
  fromJsonBody: boolean;
}

/** 下游字段位置：值将被写入 / 被引用的具体槽位 */
export type DependencyTargetLocation =
  | { kind: "url-query"; name: string }
  | { kind: "url-path"; segment: string }
  | { kind: "header"; name: string }
  | { kind: "body-field"; path: string };

/** 一条依赖推断建议（用户逐条确认后应用） */
export interface DependencySuggestion {
  /** 稳定唯一 key（上游 → 下游 → 槽位 → 响应路径），UI 列表追踪 / 去重用 */
  id: string;
  /** 上游节点 id（值提供方） */
  upstreamNodeId: NodeId;
  /** 上游响应中被引用值的输出路径（点分，如 'data.token'） */
  responsePath: string;
  /** 被引用的原始值（上游响应中出现的字符串形式） */
  upstreamValue: string;
  /** 上游值是否取自响应 JSON body（应用时需为上游补 JSON 解析后置脚本） */
  upstreamValueFromJsonBody: boolean;
  /** 下游节点 id（值消费方） */
  downstreamNodeId: NodeId;
  /** 下游字段位置 */
  target: DependencyTargetLocation;
  /** 下游侧匹配到的原文（含包裹前缀，如 'Bearer abc123'） */
  matchedText: string;
  /** 建议写入下游字段的完整模板表达式（如 'Bearer {{ node.a1.data.token }}'） */
  suggestedValue: string;
  /**
   * 应用回退基线（推断时下游的生效请求形态）：override 缺省时改写以此为起点；
   * 新建 override 时以 method 种子（避免配置抽屉保存时把 method 误写为 GET）。
   */
  baseline: {
    method: string;
    url: string;
    body?: string;
    headerValue?: string;
  };
}

/* ------------------------------------------------------------------ *
 * 值匹配的基本判定
 * ------------------------------------------------------------------ */

/** 控制字符（换行 / 制表等）：出现在凭据类值中通常意味着解析噪声 */
const CONTROL_CHAR_PATTERN = new RegExp("[\\u0000-\\u001f\\u007f]");

/**
 * 判断一个字符串值是否可作为候选值 / 匹配槽位值：不含 `{{ }}` 模板标记与
 * 控制字符、无首尾空白、长度在 [MIN, MAX] 区间内。
 *
 * @param value 待判断的字符串值
 * @returns 可参与匹配时 true
 */
function isMatchableValue(value: string): boolean {
  if (value.length < MIN_MATCH_VALUE_LENGTH || value.length > MAX_MATCH_VALUE_LENGTH) return false;
  if (value.trim() !== value) return false;
  if (value.includes("{{")) return false;
  if (CONTROL_CHAR_PATTERN.test(value)) return false;
  return true;
}

/**
 * 把数字值转为候选字符串：非有限数 / 过长过短拒绝（长度按字符串形式计）。
 *
 * @param value JSON number 叶子值
 * @returns 可匹配的字符串形式；不可匹配返回 null
 */
function matchableNumberValue(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const text = String(value);
  if (text.length < MIN_MATCH_VALUE_LENGTH || text.length > MAX_MATCH_VALUE_LENGTH) return null;
  return text;
}

/* ------------------------------------------------------------------ *
 * 上游候选值枚举
 * ------------------------------------------------------------------ */

/**
 * 判断上游 JSON body 候选是否可产出：无后置脚本（output 为原始响应，应用侧
 * 会补解析脚本）或后置脚本恰为本模块的规范解析脚本（output 已是解析后 JSON）
 * 时可产出；自定义后置脚本的输出形状不可知，不产出（避免生成运行时取不到
 * 值的模板引用）。
 *
 * @param postProcess 上游节点的后置脚本文本（可缺省 / 空串）
 * @returns 允许产出 JSON body 候选时 true
 */
function canEmitJsonBodyCandidates(postProcess: string | undefined): boolean {
  const trimmed = postProcess?.trim() ?? "";
  return trimmed === "" || trimmed === JSON_EXTRACT_POST_SCRIPT;
}

/**
 * 深度优先枚举 JSON 树中的候选值（叶子字符串 / 数字），产出带点分路径的候选。
 * 数组以十进制下标入路径；键含点号会破坏路径语义、原型链键不安全，均跳过。
 *
 * @param value 当前子树
 * @param path 当前点分路径（根为空串）
 * @param depth 当前深度（根为 0）
 * @param out 候选收集容器（就地追加，受 MAX_CANDIDATES_PER_UPSTREAM 截断）
 */
function walkJsonCandidates(
  value: unknown,
  path: string,
  depth: number,
  out: UpstreamCandidate[],
): void {
  if (out.length >= MAX_CANDIDATES_PER_UPSTREAM) return;
  if (typeof value === "string") {
    if (isMatchableValue(value)) out.push({ value, responsePath: path, fromJsonBody: true });
    return;
  }
  if (typeof value === "number") {
    const text = matchableNumberValue(value);
    if (text !== null) out.push({ value: text, responsePath: path, fromJsonBody: true });
    return;
  }
  if (value === null || typeof value !== "object" || depth >= MAX_JSON_WALK_DEPTH) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkJsonCandidates(item, path === "" ? String(index) : `${path}.${index}`, depth + 1, out);
    });
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key.includes(".")) continue;
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    walkJsonCandidates(item, path === "" ? key : `${path}.${key}`, depth + 1, out);
  }
}

/**
 * 按值去重（同值保留最短路径——路径最短者通常是数据模型上的主字段；
 * 同长路径保留先枚举者，顺序稳定）。纯函数，不改动入参。
 *
 * @param candidates 原始候选列表（可含同值多条）
 * @returns 去重后的候选列表（值首次出现顺序）
 */
function dedupeCandidatesByValue(candidates: readonly UpstreamCandidate[]): UpstreamCandidate[] {
  const best = new Map<string, UpstreamCandidate>();
  for (const candidate of candidates) {
    const current = best.get(candidate.value);
    if (current === undefined || candidate.responsePath.length < current.responsePath.length) {
      best.set(candidate.value, candidate);
    }
  }
  return [...best.values()];
}

/**
 * 从一条请求快照枚举上游候选值（快照首个 HAR entry 的响应）。
 *
 * 来源与顺序：响应头值（跳过结构性头 / 空值；路径用小写头名对齐运行期 output
 * 的 Headers 迭代语义）→ 响应 JSON body 叶子值（仅当 body 可解析且上游后置
 * 脚本允许，见 canEmitJsonBodyCandidates；base64 / 截断导致的解析失败静默
 * 跳过）。最终按值去重（保留最短路径），响应头候选优先于 body 候选（头取值
 * 无需解析脚本，运行时更稳）。
 *
 * @param record 上游节点引用的请求快照
 * @param postProcess 上游节点的后置脚本文本（可缺省）
 * @returns 候选值列表（可能为空；顺序稳定）
 */
export function collectUpstreamCandidates(
  record: RequestRecord,
  postProcess?: string,
): UpstreamCandidate[] {
  const entry = record.har?.log?.entries?.[0];
  if (!entry) return [];

  const candidates: UpstreamCandidate[] = [];

  // 1) 响应头候选：路径 headers.<小写头名>（运行期 output.headers 键为小写）
  for (const header of entry.response?.headers ?? []) {
    const lower = header.name.toLowerCase();
    if (STRUCTURAL_RESPONSE_HEADERS.has(lower)) continue;
    if (header.value === "" || !isMatchableValue(header.value)) continue;
    candidates.push({ value: header.value, responsePath: `headers.${lower}`, fromJsonBody: false });
  }

  // 2) 响应 JSON body 候选：仅当后置脚本允许且 body 可解析
  if (canEmitJsonBodyCandidates(postProcess)) {
    const content = entry.response?.content;
    const text = content?.text;
    // base64（二进制）内容不尝试 JSON 解析
    if (typeof text === "string" && text !== "" && content?.encoding !== "base64") {
      try {
        const parsed: unknown = JSON.parse(text);
        walkJsonCandidates(parsed, "", 0, candidates);
      } catch {
        // 非 JSON / 截断体：无 body 候选（边界，见文件头说明）
      }
    }
  }

  return dedupeCandidatesByValue(candidates);
}

/* ------------------------------------------------------------------ *
 * 下游有效请求快照
 * ------------------------------------------------------------------ */

/** 下游节点的有效请求形态（HAR 基线 + override 合并后；与 M5-T2 重放一致） */
export interface DownstreamRequestSnapshot {
  /** 生效 method（override.method 非空字符串优先，否则 HAR 基线） */
  method: string;
  /** 生效 URL（override.url 非空字符串优先，否则 HAR 基线） */
  url: string;
  /** 生效请求头（HAR 数组转 Record 后逐键并入 override.headers，后者覆盖） */
  headers: Record<string, string>;
  /** 生效请求体原文（override.body 优先，否则 HAR postData.text；可缺省） */
  body?: string;
}

/**
 * 用覆盖值归一请求体文本（与 replay.normalizeBodyOverride 同策略）：
 * string 原样；对象 / 数组 JSON 序列化；其余返回 null 表示无效。
 *
 * @param value override.body 原始值
 * @returns 归一后的字符串；无效返回 null
 */
function normalizeBodyText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    try {
      const serialized = JSON.stringify(value);
      return serialized ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 构建下游节点的有效请求快照（纯函数）：快照首个 HAR entry 为基线，节点
 * config.override 按 M5-T2 语义合并（method / url 整体替换、headers 逐键覆盖、
 * body 整体替换）。快照缺 entry（空快照）返回 null。
 *
 * @param node 下游画布节点（httpReplay）
 * @param record 节点引用的请求快照
 * @returns 有效请求快照；快照为空时 null
 */
export function buildDownstreamSnapshot(
  node: WorkflowNode,
  record: RequestRecord,
): DownstreamRequestSnapshot | null {
  const entry = record.har?.log?.entries?.[0];
  if (!entry) return null;

  const harRequest = entry.request;
  const headers: Record<string, string> = {};
  for (const header of harRequest.headers) {
    headers[header.name] = header.value;
  }

  const override = node.config.override;
  const manualRequest = node.config.manualRequest;
  const rawMethod: unknown = override?.method ?? manualRequest?.method;
  const method = typeof rawMethod === "string" && rawMethod !== "" ? rawMethod : harRequest.method;
  const url =
    typeof override?.url === "string" && override.url !== ""
      ? override.url
      : (manualRequest?.url ?? harRequest.url);
  if (manualRequest?.headers) Object.assign(headers, manualRequest.headers);
  if (override?.headers !== undefined) {
    for (const [key, value] of Object.entries(override.headers)) {
      if (typeof value !== "string") continue;
      headers[key] = value;
    }
  }
  if (override?.removedHeaders) {
    const removed = new Set(override.removedHeaders.map((name) => name.toLowerCase()));
    for (const name of Object.keys(headers)) {
      if (removed.has(name.toLowerCase())) delete headers[name];
    }
  }
  const overrideBody = override?.body !== undefined ? normalizeBodyText(override.body) : null;
  const body = overrideBody ?? manualRequest?.body ?? harRequest.postData?.text;

  const snapshot: DownstreamRequestSnapshot = { method, url, headers };
  if (body !== undefined) snapshot.body = body;
  return snapshot;
}

/* ------------------------------------------------------------------ *
 * 下游槽位枚举
 * ------------------------------------------------------------------ */

/** 下游匹配槽位：一个可被引用值命中的具体字段及其原文 */
interface DownstreamSlot {
  /** 槽位去重 key（kind:定位:值） */
  key: string;
  /** 字段位置（写回 override 的定位描述） */
  location: DependencyTargetLocation;
  /** 参与匹配的原文（URL 槽为原始子串；头槽为生效值） */
  value: string;
}

/** 槽位类别 → 输出排序权重（URL 参数 / 路径段 → 请求头 → 请求体字段） */
const SLOT_KIND_ORDER: Record<DependencyTargetLocation["kind"], number> = {
  "url-query": 0,
  "url-path": 1,
  header: 2,
  "body-field": 3,
};

/**
 * 计算 URL 的 pathname / query 区间起点（标准布局 origin + pathname + search +
 * hash）：pathnameStart 为 path 起点下标，queryStart 为 `?` 起点下标。供路径段
 * / 查询参数的定位改写使用。
 *
 * 【宿主注入点替换】归档传 WHATWG URL 解析结果；QuickJS 无 URL 全局，改传
 * url-lite.ts 的纯 JS 子集解析产物（pathname / search / hash 语义一致）。
 *
 * @param rawUrl 原始 URL 字符串
 * @param parsed url-lite 解析结果
 * @returns 两个区间的起点下标
 */
function urlRegionOffsets(
  rawUrl: string,
  parsed: LiteUrl,
): { pathnameStart: number; queryStart: number } {
  const pathnameStart =
    rawUrl.length - parsed.search.length - parsed.hash.length - parsed.pathname.length;
  return { pathnameStart, queryStart: pathnameStart + parsed.pathname.length };
}

/**
 * 从下游生效 URL 枚举匹配槽位（URL 查询参数 / 路径段）。
 * URL 已含模板（'{{'）时整段跳过（不覆盖既有绑定）；无法解析时返回空。
 * 查询参数以解码值匹配（HAR queryString 语义），且要求 query 区间原文中
 * 逐字存在该值——百分号编码后形态不一致的值不产出建议（无法安全改写）。
 *
 * @param rawUrl 下游生效 URL
 * @returns 槽位列表（可能为空；顺序稳定）
 */
function collectUrlSlots(rawUrl: string): DownstreamSlot[] {
  if (rawUrl.includes("{{")) return [];
  // 【宿主注入点替换】归档 new URL 抛错 → catch 返回空；url-lite 解析失败
  // 返回 null，同一处理
  const parsed = parseUrl(rawUrl);
  if (parsed === null) return [];
  const { pathnameStart, queryStart } = urlRegionOffsets(rawUrl, parsed);
  const slots: DownstreamSlot[] = [];
  const seen = new Set<string>();

  // 1) 查询参数槽：解码值精确匹配，且 query 区间原文逐字存在（可安全替换）
  if (parsed.search.length > 0) {
    const queryRegion = rawUrl.slice(queryStart, queryStart + parsed.search.length);
    for (const [name, value] of parsed.searchParams.entries()) {
      if (value === "" || !isMatchableValue(value)) continue;
      if (!queryRegion.includes(value)) continue;
      const key = `url-query:${name}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push({ key, location: { kind: "url-query", name }, value });
    }
  }

  // 2) 路径段槽：原始段整体精确匹配（按区间扫描定位段的实际偏移）
  const pathnameEnd = pathnameStart + parsed.pathname.length;
  let cursor = pathnameStart;
  while (cursor < pathnameEnd) {
    if (rawUrl[cursor] !== "/") break;
    const start = cursor + 1;
    let end = start;
    while (end < pathnameEnd && rawUrl[end] !== "/") end += 1;
    const segment = rawUrl.slice(start, end);
    if (segment !== "" && isMatchableValue(segment)) {
      const key = `url-path:${segment}`;
      if (!seen.has(key)) {
        seen.add(key);
        slots.push({ key, location: { kind: "url-path", segment }, value: segment });
      }
    }
    cursor = end;
  }
  return slots;
}

/**
 * 从下游生效请求头枚举匹配槽位：仅「重放后仍会发送」的头参与（经
 * stripBrowserOnlyHeaders 过滤——cookie 等剥离头改写无效，不产出建议）。
 * 值已含模板 / 为空的头整槽跳过；同名头（大小写不敏感）取首个。
 *
 * @param headers 下游生效请求头（HAR 基线 + override 合并后）
 * @returns 槽位列表（可能为空；顺序稳定）
 */
function collectHeaderSlots(headers: Record<string, string>): DownstreamSlot[] {
  const effective = stripBrowserOnlyHeaders(headers);
  const slots: DownstreamSlot[] = [];
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(effective)) {
    if (value === "" || !isMatchableValue(value)) continue;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    slots.push({ key: `header:${lower}`, location: { kind: "header", name }, value });
  }
  return slots;
}

/**
 * 从下游生效请求体枚举 JSON 字段槽位：解析成功后枚举字符串叶子（路径规则与
 * 上游候选一致：键含点号 / 原型链键跳过、深度受限）；body 已含模板 / 非 JSON
 * 时返回空（仅 JSON body 支持字段级改写——见文件头边界说明）。
 *
 * @param body 下游生效请求体原文（可缺省）
 * @returns 槽位列表（可能为空；顺序稳定）
 */
function collectBodySlots(body: string | undefined): DownstreamSlot[] {
  if (body === undefined || body === "" || body.includes("{{")) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const slots: DownstreamSlot[] = [];
  const collect = (value: unknown, path: string, depth: number): void => {
    if (typeof value === "string") {
      if (isMatchableValue(value)) {
        slots.push({ key: `body-field:${path}`, location: { kind: "body-field", path }, value });
      }
      return;
    }
    if (value === null || typeof value !== "object" || depth >= MAX_JSON_WALK_DEPTH) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => collect(item, `${path}.${index}`, depth + 1));
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.includes(".")) continue;
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      collect(item, path === "" ? key : `${path}.${key}`, depth + 1);
    }
  };
  collect(parsed, "", 0);
  return slots;
}

/* ------------------------------------------------------------------ *
 * 上游距离（「多上游取最近」）
 * ------------------------------------------------------------------ */

/**
 * 计算全图各节点到目标节点的有向最短距离（BFS，边方向 source → target 逆向
 * 展开）：距离 1 = 目标的直接上游；不可达不在结果表中。供「同一下游槽位被
 * 多个上游命中时取最近」的排序使用。
 *
 * @param targetId 目标（下游）节点 id
 * @param edges 当前画布连线
 * @returns 节点 id → 距离表（仅可达节点有键）
 */
function computeDistancesToTarget(
  targetId: NodeId,
  edges: readonly WorkflowEdge[],
): Map<NodeId, number> {
  // 逆向邻接表：target → sources（到 target 的一跳来源）
  const reverse = new Map<NodeId, NodeId[]>();
  for (const edge of edges) {
    const list = reverse.get(edge.target);
    if (list) list.push(edge.source);
    else reverse.set(edge.target, [edge.source]);
  }
  const distances = new Map<NodeId, number>([[targetId, 0]]);
  const queue: NodeId[] = [targetId];
  while (queue.length > 0) {
    const current = queue.shift() as NodeId;
    const nextDistance = (distances.get(current) as number) + 1;
    for (const source of reverse.get(current) ?? []) {
      if (distances.has(source)) continue;
      distances.set(source, nextDistance);
      queue.push(source);
    }
  }
  return distances;
}

/* ------------------------------------------------------------------ *
 * 匹配与建议产出（同步核心）
 * ------------------------------------------------------------------ */

/** 单个候选上游（匹配输入）：节点 + 快照记录 + 候选值清单 */
export interface InferUpstreamInput {
  /** 上游画布节点（httpReplay） */
  node: WorkflowNode;
  /** 上游节点引用的请求快照（取 createdAt 参与排序） */
  record: RequestRecord;
  /** 上游候选值清单（collectUpstreamCandidates 产物） */
  candidates: readonly UpstreamCandidate[];
}

/** 一次匹配的输入（下游 × 全部候选上游） */
export interface InferPairInput {
  /** 下游画布节点（httpReplay） */
  downstreamNode: WorkflowNode;
  /** 下游有效请求快照（buildDownstreamSnapshot 产物） */
  downstream: DownstreamRequestSnapshot;
  /** 下游节点在画布节点数组中的序位（仅用于输出排序稳定） */
  downstreamOrder: number;
  /** 候选上游清单（捕获时间早于下游、且候选值非空） */
  upstreams: readonly InferUpstreamInput[];
  /** 当前画布连线（上游距离计算） */
  edges: readonly WorkflowEdge[];
}

/**
 * 构造模板表达式核心：`{{ node.<上游节点引用键>.<响应路径> }}`。
 * M15-T2 起引用键为上游节点的 refId 短码（缺省回退内部 id），建议产物落库后
 * 直接被引擎的模板上下文（node 键 = refId ?? id）解析。
 *
 * @param upstreamRefKey 上游节点的模板引用键（refId ?? id）
 * @param responsePath 响应输出路径
 * @returns 模板表达式字符串
 */
function templateExpression(upstreamRefKey: string, responsePath: string): string {
  return `{{ node.${upstreamRefKey}.${responsePath} }}`;
}

/**
 * 单槽位 × 单上游的匹配：候选值与槽位原文精确相等即命中；请求头槽额外支持
 * 「scheme 前缀包裹」形式（如 'Bearer abc123' 中 abc123 命中——建议表达式保留
 * 前缀）。其余包裹形态（JSON 内拼接等）不做模糊匹配（避免误伤）。
 *
 * @param slot 下游槽位
 * @param upstreamRefKey 候选上游节点的模板引用键（refId ?? id，进建议表达式）
 * @param candidate 候选值
 * @returns 命中信息（matchedText / suggestedValue / 响应路径）；未命中 null
 */
function matchSlot(
  slot: DownstreamSlot,
  upstreamRefKey: string,
  candidate: UpstreamCandidate,
): { matchedText: string; suggestedValue: string; responsePath: string } | null {
  const core = templateExpression(upstreamRefKey, candidate.responsePath);
  if (slot.value === candidate.value) {
    return { matchedText: slot.value, suggestedValue: core, responsePath: candidate.responsePath };
  }
  if (slot.location.kind === "header") {
    const wrapped = WRAPPED_HEADER_PATTERN.exec(slot.value);
    if (wrapped !== null && wrapped[2] === candidate.value) {
      return {
        matchedText: slot.value,
        suggestedValue: `${wrapped[1]} ${core}`,
        responsePath: candidate.responsePath,
      };
    }
  }
  return null;
}

/** 建议产出过程中的内部排序载体（输出前剥离） */
interface RankedSuggestion {
  /** 对外建议（不含排序字段） */
  suggestion: DependencySuggestion;
  /** 排序键：下游序位 / 槽位类别权重 / 位置名字符串 */
  rank: [number, number, string];
}

/**
 * 槽位位置的排序键字符串（同类槽位间按位置名稳定排序）。
 *
 * @param location 槽位位置
 * @returns 排序键字符串
 */
function locationSortKey(location: DependencyTargetLocation): string {
  switch (location.kind) {
    case "url-query":
      return location.name;
    case "url-path":
      return location.segment;
    case "header":
      return location.name.toLowerCase();
    default:
      return location.path;
  }
}

/**
 * 同步匹配核心：下游有效请求 × 候选上游清单 → 建议列表。
 *
 * 规则：
 *   - 每个下游槽位至多产出一条建议（该槽位命中值的最优上游——已有连线距离
 *     小者优先，其次快照捕获时间新者，再次节点 id 字典序保证确定性）；
 *   - 同一上游对同一槽位至多命中一次（候选值已按值去重，且精确 / 包裹两种
 *     形式对同一候选值互斥）；
 *   - 输出按下游序位 → 槽位类别（URL → 头 → body）→ 位置名排序，稳定可快照。
 *
 * @param input 匹配输入（下游快照 + 候选上游 + 连线）
 * @returns 建议列表（无命中为空数组）
 */
export function matchDownstreamUpstreams(input: InferPairInput): DependencySuggestion[] {
  const { downstreamNode, downstream, downstreamOrder, upstreams, edges } = input;
  const distances = computeDistancesToTarget(downstreamNode.id, edges);

  const uniqueSlots = new Map<string, DownstreamSlot>();
  for (const slot of [
    ...collectUrlSlots(downstream.url),
    ...collectHeaderSlots(downstream.headers),
    ...collectBodySlots(downstream.body),
  ]) {
    if (!uniqueSlots.has(slot.key)) uniqueSlots.set(slot.key, slot);
  }

  const suggestions: RankedSuggestion[] = [];

  for (const slot of uniqueSlots.values()) {
    /** 该槽位的全部命中（每上游至多一条），带排序键 */
    const hits: Array<{
      distance: number;
      negCreatedAt: number;
      upstreamNodeId: NodeId;
      candidate: UpstreamCandidate;
      matched: NonNullable<ReturnType<typeof matchSlot>>;
    }> = [];
    for (const upstream of upstreams) {
      // M15-T2：建议表达式用上游引用键（refId ?? id）；排序 / 建议定位仍用内部 id
      const upstreamRefKey = upstream.node.refId ?? upstream.node.id;
      for (const candidate of upstream.candidates) {
        const matched = matchSlot(slot, upstreamRefKey, candidate);
        if (matched === null) continue;
        hits.push({
          distance: distances.get(upstream.node.id) ?? Number.POSITIVE_INFINITY,
          negCreatedAt: -upstream.record.createdAt,
          upstreamNodeId: upstream.node.id,
          candidate,
          matched,
        });
        break; // 该上游对该槽位的命中已确定（候选值按值去重，精确 / 包裹互斥）
      }
    }
    if (hits.length === 0) continue;
    hits.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      if (a.negCreatedAt !== b.negCreatedAt) return a.negCreatedAt - b.negCreatedAt;
      return a.upstreamNodeId < b.upstreamNodeId ? -1 : a.upstreamNodeId > b.upstreamNodeId ? 1 : 0;
    });
    const best = hits[0];
    const location = slot.location;
    suggestions.push({
      suggestion: {
        id: `${best.upstreamNodeId}=>${downstreamNode.id}:${slot.key}:${best.matched.responsePath}`,
        upstreamNodeId: best.upstreamNodeId,
        responsePath: best.matched.responsePath,
        upstreamValue: best.candidate.value,
        upstreamValueFromJsonBody: best.candidate.fromJsonBody,
        downstreamNodeId: downstreamNode.id,
        target: location,
        matchedText: best.matched.matchedText,
        suggestedValue: best.matched.suggestedValue,
        baseline: {
          method: downstream.method,
          url: downstream.url,
          ...(downstream.body !== undefined ? { body: downstream.body } : {}),
          ...(location.kind === "header" && downstream.headers[location.name] !== undefined
            ? { headerValue: downstream.headers[location.name] }
            : {}),
        },
      },
      rank: [downstreamOrder, SLOT_KIND_ORDER[location.kind], locationSortKey(location)],
    });
  }

  suggestions.sort((a, b) => {
    for (let i = 0; i < a.rank.length; i += 1) {
      if (a.rank[i] !== b.rank[i]) return a.rank[i] < b.rank[i] ? -1 : 1;
    }
    return 0;
  });
  return suggestions.map((ranked) => ranked.suggestion);
}

/* ------------------------------------------------------------------ *
 * 异步编排：加载快照并推断
 * ------------------------------------------------------------------ */

/** inferDependencies 入参：画布图 + 快照读取通道（IndexedDB / 测试 fake） */
export interface InferDependenciesInput {
  /** 当前画布节点（领域模型） */
  nodes: readonly WorkflowNode[];
  /** 当前画布连线 */
  edges: readonly WorkflowEdge[];
  /** 按快照 id 读取请求记录（缺记录返回 undefined，该节点不参与推断） */
  getRequestRecord: (requestId: RequestId) => Promise<RequestRecord | undefined>;
}

/**
 * 依赖推断主入口：收集画布上引用请求快照的 httpReplay 节点，加载其快照，
 * 对每个有序对（上游捕获时间 < 下游捕获时间）执行匹配核心，产出建议列表。
 *
 * 节点不足（< 2 个引用快照的节点）直接返回空数组——UI 据此展示「可推断的
 * 请求不足」空态。快照读取失败 / 缺失的节点按不参与处理，不抛错。
 *
 * @param input 画布图与快照读取通道
 * @returns 建议列表（可能为空；顺序稳定）
 */
export async function inferDependencies(
  input: InferDependenciesInput,
): Promise<DependencySuggestion[]> {
  const replayNodes = input.nodes.filter(
    (node) => node.type === "httpReplay" && typeof node.config.requestId === "string",
  );
  // M13-T5：stickyNote 便签天然不参与推断——候选上游 / 改写下游均只取
  // httpReplay 节点（上方过滤），且便签不可连线（无入边出边），「最近上游」
  // 的 BFS 沿既有连线遍历不会触及便签。画布上存在便签对推断零影响。
  if (replayNodes.length < 2) return [];

  // 快照按 requestId 去重并行读取（同一快照被多个节点引用只读一次）
  const requestIds = [...new Set(replayNodes.map((node) => node.config.requestId as RequestId))];
  const recordById = new Map<RequestId, RequestRecord | undefined>();
  await Promise.all(
    requestIds.map(async (id) => {
      try {
        recordById.set(id, await input.getRequestRecord(id));
      } catch {
        recordById.set(id, undefined);
      }
    }),
  );

  const suggestions: DependencySuggestion[] = [];
  replayNodes.forEach((downstreamNode, order) => {
    const downstreamRecord = recordById.get(downstreamNode.config.requestId as RequestId);
    if (downstreamRecord === undefined) return;
    const downstream = buildDownstreamSnapshot(downstreamNode, downstreamRecord);
    if (downstream === null) return;

    const upstreams: InferUpstreamInput[] = [];
    for (const upstreamNode of replayNodes) {
      if (upstreamNode.id === downstreamNode.id) continue;
      const record = recordById.get(upstreamNode.config.requestId as RequestId);
      // 时序门槛：仅捕获时间严格早于下游的响应参与（响应先于请求发生的语义）
      if (record === undefined || record.createdAt >= downstreamRecord.createdAt) continue;
      const candidates = collectUpstreamCandidates(record, upstreamNode.config.postProcess);
      if (candidates.length === 0) continue;
      upstreams.push({ node: upstreamNode, record, candidates });
    }
    if (upstreams.length === 0) return;

    suggestions.push(
      ...matchDownstreamUpstreams({
        downstreamNode,
        downstream,
        downstreamOrder: order,
        upstreams,
        edges: input.edges,
      }),
    );
  });
  return suggestions;
}

/* ------------------------------------------------------------------ *
 * 应用：建议 → 连线 + 下游字段改写
 * ------------------------------------------------------------------ */

/** 应用结果：新的节点 / 连线数组 + 增量信息（供画布 API 做视图同步） */
export interface SuggestionApplyResult {
  /** 应用后的完整节点数组（未被改写的节点保持原引用与原顺序） */
  nodes: WorkflowNode[];
  /** 应用后的完整连线数组（原连线 + 新增连线） */
  edges: WorkflowEdge[];
  /** 本次新增的连线（画布增量渲染用） */
  addedEdges: WorkflowEdge[];
  /** config 被改写的节点 id（画布回写节点卡用；保序去重） */
  changedNodeIds: NodeId[];
}

/** id 生成器类型（缺省 crypto.randomUUID；测试注入确定性生成器） */
export type SuggestionIdGenerator = () => string;

/**
 * 把 override.method 的字符串归一为合法 HttpMethod 字面量：命中 HTTP_METHODS
 * 原样返回，否则兜底 'GET'（与节点配置抽屉的 toHttpMethod 同策略——新建
 * override 必带合法 method，避免后续抽屉保存把重放方法误改写）。
 *
 * @param value 待归一的方法字符串
 * @returns 合法的 HttpMethod 字面量
 */
function toHttpMethodValue(value: string): (typeof HTTP_METHODS)[number] {
  return HTTP_METHODS.find((method) => method === value) ?? "GET";
}

/**
 * 在 JSON 结构中按点分路径就地写入值：路径必须已存在（与推断时的结构一致），
 * 任一段缺失 / 中途为原始值返回 null（按失效跳过）。原型链键不可写。
 *
 * @param root JSON 根值（将被就地修改）
 * @param path 点分路径（如 'data.token'）
 * @param value 待写入的值
 * @returns 写入成功返回 root；路径不可达返回 null
 */
function setByJsonPath(root: object, path: string, value: string): object | null {
  if (path === "") return null;
  let current: unknown = root;
  const segments = path.split(".");
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] as string;
    if (current === null || typeof current !== "object") return null;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;
      current = current[index];
    } else {
      const record = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, segment)) return null;
      current = record[segment];
    }
  }
  const last = segments[segments.length - 1] as string;
  if (current === null || typeof current !== "object") return null;
  if (Array.isArray(current)) {
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;
    current[index] = value;
    return root;
  }
  const record = current as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, last)) return null;
  record[last] = value;
  return root;
}

/**
 * 把 URL 中的查询参数值替换为模板表达式（区域感知：仅在 query 区间内查找并
 * 替换首个出现，避免 host / path 中的同形子串被误改；参数被用户删除时不改）。
 *
 * @param rawUrl 当前生效 URL
 * @param paramName 查询参数名（参数仍在的校验）
 * @param value 被替换的原始值
 * @param core 模板表达式核心（'{{ node.a1.data.token }}'）
 * @returns 改写后的 URL；无法安全替换时 null（按失效跳过）
 */
function substituteUrlQuery(
  rawUrl: string,
  paramName: string,
  value: string,
  core: string,
): string | null {
  const queryStart = rawUrl.lastIndexOf("?");
  if (queryStart === -1) return null;
  const hashStart = rawUrl.indexOf("#", queryStart);
  const queryEnd = hashStart === -1 ? rawUrl.length : hashStart;
  const queryRegion = rawUrl.slice(queryStart, queryEnd);
  if (!queryRegion.includes(`${paramName}=`)) return null;
  const indexInRegion = queryRegion.indexOf(value);
  if (indexInRegion === -1) return null;
  const index = queryStart + indexInRegion;
  return rawUrl.slice(0, index) + core + rawUrl.slice(index + value.length);
}

/**
 * 把 URL 路径段替换为模板表达式（段边界感知：仅整体等于目标值的段被替换，
 * 避免误改仅包含同形子串的更长段；authority 区间不参与）。
 *
 * @param rawUrl 当前生效 URL
 * @param segment 被替换的路径段（原始形态）
 * @param core 模板表达式核心
 * @returns 改写后的 URL；段已不存在时 null
 */
function substituteUrlPathSegment(rawUrl: string, segment: string, core: string): string | null {
  // 跳过 scheme://authority：path 从 authority 之后的第一个 / 开始
  const authorityEnd = rawUrl.indexOf("//");
  const slashStart =
    authorityEnd === -1 ? rawUrl.indexOf("/") : rawUrl.indexOf("/", authorityEnd + 2);
  if (slashStart === -1) return null;
  const queryStart = rawUrl.indexOf("?", slashStart);
  const pathnameEnd = queryStart === -1 ? rawUrl.length : queryStart;
  let cursor = slashStart;
  while (cursor < pathnameEnd) {
    if (rawUrl[cursor] !== "/") return null;
    const start = cursor + 1;
    let end = start;
    while (end < pathnameEnd && rawUrl[end] !== "/") end += 1;
    if (rawUrl.slice(start, end) === segment) {
      return rawUrl.slice(0, start) + core + rawUrl.slice(end);
    }
    cursor = end;
  }
  return null;
}

/**
 * 应用一条建议到下游节点的 config（纯函数，不改动入参）。
 *
 * 改写规则（字段当前值中已不含匹配值时返回 null = 建议失效，整条跳过）：
 *   - header：当前值 = override.headers[name] ?? 推断时生效值；首个匹配值子串
 *     替换为模板核心（保留用户既有前缀 / 后缀编辑）；
 *   - url-query / url-path：当前 URL = override.url ?? 推断时生效 URL，区域感知
 *     替换（见 substituteUrlQuery / substituteUrlPathSegment）；
 *   - body-field：当前 body = override.body ?? 推断时生效 body，JSON 解析后按
 *     路径写入模板表达式再紧凑序列化（解析失败 / 路径缺失 → 失效跳过）。
 *
 * 新建 override 时以建议基线的 method 种子（归一为合法 HttpMethod，与配置
 * 抽屉「override 必带 method」的落库形状一致）。
 *
 * @param config 下游节点当前 config（不改动）
 * @param suggestion 待应用建议
 * @returns 新 config；建议失效时 null
 */
function applySuggestionToConfig(
  config: NodeConfig,
  suggestion: DependencySuggestion,
): NodeConfig | null {
  const { target, upstreamValue, suggestedValue, baseline } = suggestion;
  const coreMatch = TEMPLATE_CORE_PATTERN.exec(suggestedValue);
  if (coreMatch === null) return null;
  const core = coreMatch[0];

  const override = config.override !== undefined ? { ...config.override } : undefined;
  let nextOverride: NonNullable<NodeConfig["override"]> | undefined = override;

  if (target.kind === "header") {
    const currentValue = override?.headers?.[target.name] ?? baseline.headerValue;
    if (currentValue === undefined) return null;
    const index = currentValue.indexOf(upstreamValue);
    if (index === -1) return null;
    const nextValue =
      currentValue.slice(0, index) + core + currentValue.slice(index + upstreamValue.length);
    if (nextOverride === undefined) nextOverride = { method: toHttpMethodValue(baseline.method) };
    nextOverride = {
      ...nextOverride,
      headers: { ...(nextOverride.headers ?? {}), [target.name]: nextValue },
    };
  } else if (target.kind === "url-query" || target.kind === "url-path") {
    const currentUrl = override?.url ?? baseline.url;
    const nextUrl =
      target.kind === "url-query"
        ? substituteUrlQuery(currentUrl, target.name, upstreamValue, core)
        : substituteUrlPathSegment(currentUrl, target.segment, core);
    if (nextUrl === null) return null;
    if (nextOverride === undefined) nextOverride = { method: toHttpMethodValue(baseline.method) };
    nextOverride = { ...nextOverride, url: nextUrl };
  } else {
    const rawCurrentBody: unknown = override?.body ?? baseline.body;
    if (rawCurrentBody === undefined) return null;
    const currentBody =
      typeof rawCurrentBody === "string" ? rawCurrentBody : normalizeBodyText(rawCurrentBody);
    if (currentBody === null) return null;
    let parsed: object;
    try {
      const value: unknown = JSON.parse(currentBody);
      if (value === null || typeof value !== "object") return null;
      parsed = value as object;
    } catch {
      return null;
    }
    const updated = setByJsonPath(parsed, target.path, core);
    if (updated === null) return null;
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(updated);
    } catch {
      return null;
    }
    if (serialized === undefined) return null;
    if (nextOverride === undefined) nextOverride = { method: toHttpMethodValue(baseline.method) };
    nextOverride = { ...nextOverride, body: serialized };
  }

  return { ...config, override: nextOverride };
}

/**
 * 批量应用建议（纯函数）：逐条改写下游字段 + 补连线 + 为 JSON body 类建议的
 * 上游补 JSON 解析后置脚本。单条失效（下游字段当前值已不含匹配值 / 结构已变）
 * 时该条整体跳过（不改写、不加线），其余建议照常应用。
 *
 * 连线与后置脚本只对「成功改写」的建议生效——失效建议视同撤回。
 * 输入建议应来自同一画布状态（inferDependencies 的产出），按列表顺序应用。
 *
 * @param nodes 当前画布节点
 * @param edges 当前画布连线
 * @param suggestions 待应用建议列表
 * @param generateId 连线 id 生成器（缺省 crypto.randomUUID）
 * @returns 应用结果（新数组 + 增量信息；全部失效时 nodes / edges 内容不变）
 */
export function applySuggestions(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  suggestions: readonly DependencySuggestion[],
  // 【宿主注入点替换】缺省生成器归档为 crypto.randomUUID；QuickJS 无 crypto
  // 全局，改走 host-env 注入链（Node / 浏览器单测环境行为不变）
  generateId: SuggestionIdGenerator = () => hostRandomUuid(),
): SuggestionApplyResult {
  const nodeById = new Map<NodeId, WorkflowNode>(nodes.map((node) => [node.id, node]));
  const nextEdges = [...edges];
  /** 已存在的连线对（source|target），防重复加线 */
  const edgePairs = new Set(
    edges.map((edge) => `${edge.source}${PAIR_KEY_SEPARATOR}${edge.target}`),
  );
  const addedEdges: WorkflowEdge[] = [];
  const changedSet = new Set<NodeId>();
  const changedNodeIds: NodeId[] = [];
  /** 待补 JSON 解析后置脚本的上游节点 id（保序去重） */
  const pendingJsonUpstreams: NodeId[] = [];
  const pendingJsonSet = new Set<NodeId>();

  /** 记录一个被改写的节点（保序去重） */
  const markChanged = (nodeId: NodeId): void => {
    if (changedSet.has(nodeId)) return;
    changedSet.add(nodeId);
    changedNodeIds.push(nodeId);
  };

  for (const suggestion of suggestions) {
    const downstreamNode = nodeById.get(suggestion.downstreamNodeId);
    if (downstreamNode === undefined) continue;
    const nextConfig = applySuggestionToConfig(downstreamNode.config, suggestion);
    if (nextConfig === null) continue;

    // 1) 下游字段改写
    nodeById.set(downstreamNode.id, { ...downstreamNode, config: nextConfig });
    markChanged(downstreamNode.id);

    // 2) 上游 → 下游连线（已存在则不重复）
    const pairKey = `${suggestion.upstreamNodeId}${PAIR_KEY_SEPARATOR}${suggestion.downstreamNodeId}`;
    if (!edgePairs.has(pairKey)) {
      const edge: WorkflowEdge = {
        id: asEdgeId(generateId()),
        source: asNodeId(suggestion.upstreamNodeId),
        target: asNodeId(suggestion.downstreamNodeId),
      };
      edgePairs.add(pairKey);
      nextEdges.push(edge);
      addedEdges.push(edge);
    }

    // 3) JSON body 类建议：上游无后置脚本时补规范解析脚本（每上游至多一次）
    if (suggestion.upstreamValueFromJsonBody && !pendingJsonSet.has(suggestion.upstreamNodeId)) {
      const upstreamNode = nodeById.get(suggestion.upstreamNodeId);
      const postProcess = upstreamNode?.config.postProcess;
      if (upstreamNode !== undefined && (postProcess === undefined || postProcess.trim() === "")) {
        pendingJsonSet.add(suggestion.upstreamNodeId);
        pendingJsonUpstreams.push(suggestion.upstreamNodeId);
      }
    }
  }

  for (const upstreamId of pendingJsonUpstreams) {
    const upstreamNode = nodeById.get(upstreamId) as WorkflowNode;
    nodeById.set(upstreamId, {
      ...upstreamNode,
      config: { ...upstreamNode.config, postProcess: JSON_EXTRACT_POST_SCRIPT },
    });
    markChanged(upstreamId);
  }

  // 保持原节点顺序输出（改写节点替换为克隆，其余保持原引用）
  const nextNodes = nodes.map((node) => nodeById.get(node.id) as WorkflowNode);
  return { nodes: nextNodes, edges: nextEdges, addedEdges, changedNodeIds };
}
