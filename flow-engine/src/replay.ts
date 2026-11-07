/**
 * 请求重放纯函数（M5-T2）。
 *
 * ROADMAP M5-T2：基于 HAR 快照重建请求。本模块只做「重建」——把
 * RequestRecord.har 的首个 entry 加上节点覆盖（override）与前置脚本覆盖
 * （extraOverride）合并、剥离浏览器专属头、渲染 {{ }} 模板，产出一份可直接交给
 * fetch 的 ReplayRequest。真正发起请求（credentials / 超时 signal / 响应归一）在
 * src/background/replay-executor.ts（NodeRunner 扩展点，M5-T4 接线）。
 *
 * 合并策略（文档化选择，后到优先）：
 *   - method / url / body：整体替换（覆盖值非法时保持基线，见 applyReplayOverride）；
 *   - headers：**逐键覆盖合并**（不是整体替换）——基线 = HAR 请求头，override 与
 *     extraOverride 依次逐键写入：键存在即整体取覆盖值（含空串，无「空串 = 删除」
 *     语义；用户想删头应从 override 中移除该键），未提及的键原样保留。选择逐键而非
 *     整体替换，是因为 UI 覆盖与前置脚本通常只想改个别头（如 Authorization），整体
 *     替代会把 HAR 捕获的 accept / authorization 等一并丢掉；
 *   - 两份覆盖结构上兼容 NodeConfig.override（RequestOverride）与前置脚本返回的
 *     PreScriptOverrides（script.ts，多出 timeoutMs / body 可为对象），统一收窄为
 *     ReplayOverride；
 *   - PreScriptOverrides 各值的合法性由本层校验（script.ts 约定「值的具体合法性由
 *     M5 执行器校验」）：method / url 仅接受非空字符串，headers 仅应用字符串值，
 *     timeoutMs 仅接受有限正数，body 接受 string 或对象（对象 JSON 序列化）。
 *
 * 模板渲染：url / headers 值 / body 中的 `{{ }}` 以 RenderContext 渲染
 * （renderTemplate / renderValueDeep，渲染永不失败，缺数据按空串替换）。未传
 * templateContext 时跳过渲染、按原文透传（纯静态重建 / 单测场景的约定出口）。
 *
 * 浏览器专属头策略（HEADERS_POLICY + stripBrowserOnlyHeaders，作为重建的最终
 * 出口闸门，在覆盖合并之后统一执行——override 也无法把禁改头带上线）：
 *   - 一律剥离：sec-fetch-*、sec-ch-ua*（浏览器注入的请求上下文元数据，重放环境
 *     语义已变）、content-length（由 fetch 按最终 body 重算）、host / origin
 *     （由浏览器按目标 URL 重设）、referer（默认剥离，keepReferer 可保留）、
 *     cookie（fetch 层不携带捕获值——cookie 的两种取值方式见下）、
 *   - user-agent：默认透传 HAR 原值（R3：透传原 UA），KEEP_UA 开关可关；
 *   - accept 系（accept / accept-encoding / accept-language 等）默认保留。
 *
 *   M9-T3 补充：剥离闸门维持不变；「服务端校验 Origin / Referer 的接口」的保真
 *   由 DNR modifyHeaders 动态规则在网络层注入（Origin / Referer 是 fetch 层
 *   forbidden header，headers 通道设不进去）——决策与规则构造见
 *   engine/header-fidelity.ts，安装 / 清理生命周期见 background/replay-headers.ts。
 *   注入发生在剥离之后的网络层，两者不冲突（先剥离重建头、DNR 再按需补写）。
 *
 *   M12-T3 补充：Cookie 同样在剥离名单内（fetch 层不带捕获值），取值方式按节点
 *   配置二选一——'browser'（缺省之外的显式选择）走 fetch credentials:'include'
 *   从浏览器 cookie jar 取新鲜值；缺省 / 'snapshot' 由 DNR 在网络层 set 捕获值
 *   （快照未捕获 Cookie 时无注入、自然退化为 jar，见 resolveCookieDecision）。
 *
 * 请求体（M9-T3 顺手修复二进制 body 重建）：HAR 1.2 规范对二进制 body 以
 * postData.text + encoding:'base64' 记录——此前重建忽略 encoding，把 base64
 * 文本原样发出（字节不等价）。现按 encoding 解码为字节（Uint8Array）交 fetch
 * 按原始字节发送；解码失败（非法 base64）退化为原文文本。multipart 等文本类
 * body（无 encoding 标记）仍按原文透传——HAR text 即完整原始 body（含
 * boundary），配合保留的 content-type（含 boundary）字节级等价（text 被 M2-T4
 * 截断的快照除外，属存储截断语义、非重建问题）。
 *
 * 本模块纯函数、零环境依赖（不依赖存储 / 网络 / chrome API），node 可直接单测。
 * 按任务约定不经 src/engine/index.ts 桶文件导出（集成者统一处理），消费方以
 * `@/engine/replay` 深路径引入。
 */

import type { HarEntry, HarPostData, ManualRequest, WorkflowNode } from "./types";
import { renderTemplate, renderValueDeep } from "./template";
import type { RenderContext } from "./template";
import { decodeBase64, encodeBase64 } from "./base64";
import { resolveCookieDecision, resolveHeaderFidelityPlan } from "./header-fidelity";

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/**
 * 重放请求覆盖（统一形态）。
 * NodeConfig.override（RequestOverride）与前置脚本返回的 PreScriptOverrides
 * 结构上均兼容本类型；body 允许 unknown 是为承载脚本返回的对象形态
 * （模板渲染前允许 string / 对象两种形态，见 script.ts）。
 */
export interface ReplayOverride {
  /** 覆盖请求方法（非空字符串才生效） */
  method?: string;
  /** 覆盖请求 URL（非空字符串才生效） */
  url?: string;
  /** 覆盖请求头：逐键覆盖合并（值仅接受字符串，其余跳过） */
  headers?: Record<string, string>;
  /** 从当前请求中移除的请求头名，大小写不敏感；仅节点配置覆盖使用 */
  removedHeaders?: string[];
  /** 覆盖请求体：string 原样 / 对象 JSON 序列化 / null·undefined 不修改 */
  body?: unknown;
  /** 覆盖重放超时毫秒数（有限正数才生效） */
  timeoutMs?: number;
}

/** 重建产物：可直接交给 fetch 的请求描述 */
export interface ReplayRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /**
   * 请求体原文；基线无 postData 且覆盖未给出时不存在。
   * string = 文本类 body（可模板渲染）；Uint8Array<ArrayBuffer> = 二进制 body
   * （HAR postData.encoding='base64' 解码产物，跳过模板渲染、按原始字节发送；
   * 泛型实参保证可直接赋给 fetch 的 BodyInit）。
   */
  body?: string | Uint8Array<ArrayBuffer>;
  /** 覆盖指定的重放超时毫秒数（extraOverride.timeoutMs）；未覆盖时不存在 */
  timeoutMs?: number;
}

/** buildReplayRequest 入参 */
export interface BuildReplayRequestParams {
  /** HAR 快照条目（重放基线来源；runner 侧取快照首个 entry） */
  harEntry: HarEntry;
  /** 节点配置覆盖（NodeConfig.override） */
  override?: ReplayOverride;
  /** 前置脚本返回的覆盖（后到优先，与 override 同策略） */
  extraOverride?: ReplayOverride;
}

/* ------------------------------------------------------------------ *
 * 浏览器专属头策略
 * ------------------------------------------------------------------ */

/**
 * 浏览器专属头处理策略（重放场景）。
 * 名单均为小写，匹配时对头名做 toLowerCase 后比较（大小写不敏感）。
 */
export const HEADERS_POLICY = {
  /** 一律剥离的请求头名（小写精确匹配） */
  STRIP_EXACT: ["content-length", "host", "origin", "cookie"] as readonly string[],
  /** 一律剥离的请求头名前缀（小写前缀匹配）：sec-fetch-site/mode/... 与 sec-ch-ua 系 */
  STRIP_PREFIXES: ["sec-fetch-", "sec-ch-ua"] as readonly string[],
  /** referer 头名：默认剥离，stripBrowserOnlyHeaders 的 keepReferer 可保留 */
  REFERER: "referer",
  /** user-agent 头名：默认透传 HAR 原值（R3），keepUserAgent=false 可关 */
  USER_AGENT: "user-agent",
} as const;

/** user-agent 默认保留（R3：透传 HAR 原 UA）；stripBrowserOnlyHeaders 的开关缺省值 */
export const KEEP_UA = true;

/** referer 默认剥离（重放环境页面上下文已变，携带旧 referer 易误导服务端） */
export const KEEP_REFERER = false;

/** stripBrowserOnlyHeaders 的可配置项 */
export interface HeaderPolicyOptions {
  /** 保留 user-agent（默认 KEEP_UA = true；false 时一并剥离） */
  keepUserAgent?: boolean;
  /** 保留 referer（默认 KEEP_REFERER = false） */
  keepReferer?: boolean;
}

/**
 * 按浏览器专属头策略剥离请求头（纯函数，不改动入参）。
 *
 * cookie 也在剥离名单内：重放的 cookie 携带不走 fetch headers 层——无注入值
 * 时由 credentials:'include' 让 cookie jar 自行携带，或由 DNR 在网络层 set
 * （快照捕获值 / cookieValue 自定义值，见 resolveCookieDecision）。
 *
 * @param headers 待处理的请求头（键大小写保留原样输出）
 * @param opts 可配置项（keepUserAgent / keepReferer）
 * @returns 剥离后的新请求头对象
 */
export function stripBrowserOnlyHeaders(
  headers: Record<string, string>,
  opts?: HeaderPolicyOptions,
): Record<string, string> {
  const keepUserAgent = opts?.keepUserAgent ?? KEEP_UA;
  const keepReferer = opts?.keepReferer ?? KEEP_REFERER;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HEADERS_POLICY.STRIP_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    if (HEADERS_POLICY.STRIP_EXACT.includes(lower)) continue;
    if (lower === HEADERS_POLICY.REFERER && !keepReferer) continue;
    if (lower === HEADERS_POLICY.USER_AGENT && !keepUserAgent) continue;
    out[name] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 覆盖合并
 * ------------------------------------------------------------------ */

/** 合并过程中的可变请求形态（中间态，函数内部使用） */
interface MutableRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | Uint8Array<ArrayBuffer> | undefined;
  timeoutMs: number | undefined;
}

/**
 * 解析 HAR 基线请求体（M9-T3 顺手修复二进制 body 重建）。
 *
 *   - postData.encoding === 'base64'（HAR 1.2 对二进制 body 的记录方式）→
 *     解码为字节（Uint8Array<ArrayBuffer>），重放按原始字节发送而非 base64 文本；
 *   - 解码失败（非法 base64 字符等）退化为按原文文本发送（与既有行为一致，不抛错）；
 *   - 其余（纯文本 body / 无 postData）按 text 原文（undefined = 无 body）。
 *
 * @param postData HAR 基线的 postData（可缺省）
 * @returns 可交给 fetch 的 body（文本或字节）；无 body 时为 undefined
 */
function decodeBaselinePostData(
  postData: HarPostData | undefined,
): string | Uint8Array<ArrayBuffer> | undefined {
  if (!postData || postData.text === undefined) return undefined;
  if (postData.encoding !== "base64") return postData.text;
  // 【宿主注入点替换】归档用浏览器 atob 解码；QuickJS 无 atob，改用 base64.ts
  // 的纯 JS 等价实现（非法 base64 同样抛错，catch 后退化为原文发送，语义一致）
  try {
    return decodeBase64(postData.text) as Uint8Array<ArrayBuffer>;
  } catch {
    return postData.text;
  }
}

/**
 * 把 body 覆盖值归一为字符串。
 * string 原样；对象 / 数组 JSON 序列化（与 script.ts「模板渲染前允许 string 或
 * 对象两种形态」对齐）；JSON 序列化失败的极端值（循环引用等）退化为 String()。
 */
function normalizeBodyOverride(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 应用一份覆盖到可变请求上（override 与 extraOverride 共用同一规则，后到优先）。
 * 值合法性校验在本层完成（非法值保持基线、不抛错）：
 *   - method / url：仅非空字符串生效；
 *   - headers：逐键覆盖合并，仅字符串值生效（含空串——键存在即整体取该值）；
 *   - body：undefined / null 不修改（「脚本未返回 body 覆盖」是常态）；空串合法
 *     （显式清空请求体）；对象 JSON 序列化；
 *   - timeoutMs：仅有限正数生效。
 */
function applyReplayOverride(target: MutableRequest, source: ReplayOverride | undefined): void {
  if (!source) return;
  if (typeof source.method === "string" && source.method !== "") target.method = source.method;
  if (typeof source.url === "string" && source.url !== "") target.url = source.url;
  if (source.headers) {
    for (const [key, value] of Object.entries(source.headers)) {
      if (typeof value !== "string") continue;
      target.headers[key] = value;
    }
  }
  if (source.removedHeaders) {
    const removed = new Set(source.removedHeaders.map((name) => name.toLowerCase()));
    for (const name of Object.keys(target.headers)) {
      if (removed.has(name.toLowerCase())) delete target.headers[name];
    }
  }
  if (source.body !== undefined && source.body !== null) {
    target.body = normalizeBodyOverride(source.body);
  }
  if (
    typeof source.timeoutMs === "number" &&
    Number.isFinite(source.timeoutMs) &&
    source.timeoutMs > 0
  ) {
    target.timeoutMs = source.timeoutMs;
  }
}

/* ------------------------------------------------------------------ *
 * 请求基线解析（自 run-workflow.ts 下沉：runner 与预览共用同一入口）
 * ------------------------------------------------------------------ */

/**
 * 把无引用节点的手动请求基线合成为 HAR 条目（buildReplayRequest 的入参形状）。
 * method / url / headers / body 逐字段映射；缺省 HTTP/1.1、空响应摘要。
 */
export function manualRequestToHarEntry(manual: ManualRequest): HarEntry {
  return {
    startedDateTime: new Date(0).toISOString(),
    time: 0,
    request: {
      method: manual.method,
      url: manual.url,
      httpVersion: "HTTP/1.1",
      headers: Object.entries(manual.headers ?? {}).map(([name, value]) => ({ name, value })),
      queryString: [],
      headersSize: -1,
      bodySize: -1,
      ...(manual.body !== undefined ? { postData: { mimeType: "", text: manual.body } } : {}),
    },
    response: {
      status: 0,
      statusText: "",
      httpVersion: "HTTP/1.1",
      headers: [],
      content: { size: 0, mimeType: "" },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
    },
    timings: { send: 0, wait: 0, receive: 0 },
  };
}

/**
 * 解析 httpReplay 节点的重放基线（runner 与 buildPreviewRequest 共用）：
 * harEntries[config.requestId]（请求库投影）优先，无引用 / 未命中时回退
 * config.manualRequest 合成基线；两者皆缺 → undefined（节点 failed / 预览报缺基线）。
 */
export function resolveHarEntryForNode(
  node: WorkflowNode,
  harEntries: Record<string, HarEntry> | undefined,
): HarEntry | undefined {
  const requestId = node.config.requestId;
  if (typeof requestId === "string" && requestId !== "") {
    const entry = harEntries?.[requestId];
    if (entry !== undefined) return entry;
  }
  const manual = node.config.manualRequest;
  return manual !== undefined ? manualRequestToHarEntry(manual) : undefined;
}

/* ------------------------------------------------------------------ *
 * 请求重建主入口
 * ------------------------------------------------------------------ */

/**
 * 基于 HAR 快照条目重建重放请求（纯函数）。
 *
 * 管线：HAR 基线（method / url / headers / postData.text）→ override 覆盖 →
 * extraOverride 覆盖（后到优先）→ 浏览器专属头剥离（最终出口闸门）→ 模板渲染。
 *
 * 模板渲染仅在传入 templateContext 时执行（url / headers 值 / body 中的 `{{ }}`）；
 * 不传时按原文透传——纯静态重建（如单测、无上游数据的孤立节点调试）不依赖渲染，
 * 显式跳过可避免「无上下文时引用被静默替换为空串」的意外改写。
 *
 * 渲染警告策略：renderTemplate / renderValueDeep 渲染永不失败（缺数据按空串替换
 * 并产生 warnings），本层不透出 warnings（ReplayRequest 保持规格形状），失败策略
 * 与提示由上层（M5-T4 分类）统一处理。需要警告的调用方（模板渲染预览）走
 * [`buildReplayRequestWithWarnings`] / [`buildPreviewRequest`]。
 *
 * @param params HAR 条目与两份覆盖
 * @param templateContext 模板渲染上下文（可缺省；缺省跳过渲染）
 * @returns 可交给 fetch 的重放请求描述
 */
export function buildReplayRequest(
  params: BuildReplayRequestParams,
  templateContext?: RenderContext,
): ReplayRequest {
  return buildReplayRequestWithWarnings(params, templateContext).request;
}

/** 重建产物 + 渲染警告（内部形态；公开的 [`buildReplayRequest`] 只取 request） */
interface ReplayRequestWithWarnings {
  request: ReplayRequest;
  warnings: string[];
}

/**
 * [`buildReplayRequest`] 的完整形态：同一管线，另透出渲染警告聚合
 * （url / headers 值 / body 三处渲染的 warnings 依次拼接）。
 */
function buildReplayRequestWithWarnings(
  params: BuildReplayRequestParams,
  templateContext?: RenderContext,
): ReplayRequestWithWarnings {
  const { harEntry, override, extraOverride } = params;
  const harRequest = harEntry.request;

  // 1) HAR 基线：headers 数组转 Record，重名头后者覆盖前者（与浏览器最终发送语义一致）
  const headers: Record<string, string> = {};
  for (const header of harRequest.headers) {
    headers[header.name] = header.value;
  }
  const target: MutableRequest = {
    method: harRequest.method,
    url: harRequest.url,
    headers,
    // 基线 body = postData.text（encoding='base64' 时解码为字节）；无 postData 为 undefined
    body: decodeBaselinePostData(harRequest.postData),
    timeoutMs: undefined,
  };

  // 2) 节点配置覆盖 + 3) 前置脚本覆盖（两份覆盖走同一 applyReplayOverride 规则，
  //    extraOverride 后写入即「后到优先」）
  applyReplayOverride(target, override);
  applyReplayOverride(target, extraOverride);

  // 4) 浏览器专属头剥离：策略是最终出口闸门（合并后统一执行，覆盖无法带禁改头上线）
  const strippedHeaders = stripBrowserOnlyHeaders(target.headers);

  // 5) 模板渲染（无 templateContext 时跳过，按原文透传）
  const warnings: string[] = [];
  let finalUrl = target.url;
  let finalHeaders: Record<string, string> = strippedHeaders;
  let finalBody = target.body;
  if (templateContext) {
    const urlRendered = renderTemplate(finalUrl, templateContext);
    finalUrl = urlRendered.value;
    warnings.push(...urlRendered.warnings);
    // headers 只渲染值（renderValueDeep 不改键）；值为字符串，渲染结果仍是字符串
    const headersRendered = renderValueDeep(strippedHeaders, templateContext);
    finalHeaders = headersRendered.value as Record<string, string>;
    warnings.push(...headersRendered.warnings);
    // 二进制 body（Uint8Array，base64 解码产物）不做模板渲染——按原始字节发送
    if (finalBody !== undefined && typeof finalBody === "string") {
      const bodyRendered = renderTemplate(finalBody, templateContext);
      finalBody = bodyRendered.value;
      warnings.push(...bodyRendered.warnings);
    }
  }

  const request: ReplayRequest = {
    method: target.method,
    url: finalUrl,
    headers: finalHeaders,
  };
  if (finalBody !== undefined) request.body = finalBody;
  if (target.timeoutMs !== undefined) request.timeoutMs = target.timeoutMs;
  return { request, warnings };
}

/* ------------------------------------------------------------------ *
 * httpReplay 节点请求面预览（模板渲染 dry-run，零出站）
 * ------------------------------------------------------------------ */

/** [`buildPreviewRequest`] 入参：预览目标节点与请求库投影 */
export interface BuildPreviewRequestParams {
  /** 预览目标节点（至少含 id 与 config；请求面字段仅 httpReplay 节点使用） */
  node: Pick<WorkflowNode, "id" | "config">;
  /** 请求库投影（requestId → HAR 条目，body blob 由宿主回填）；缺省视为空库 */
  harEntries?: Record<string, HarEntry>;
}

/**
 * 预览产物请求（与 httpReplay runner 出站载荷同形；body 已按类型归一）。
 * string body / base64 二进制 body 的二选一形态与 runner 的宿主桥载荷一致。
 */
export interface PreviewRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** 文本类请求体（模板渲染后的原文；无 body 时不存在） */
  body?: string;
  /** 二进制请求体（HAR postData.encoding='base64' 解码产物，base64 编码；跳过模板渲染） */
  bodyBase64?: string;
  /** 生效的重放超时毫秒（覆盖 timeoutMs ?? config.timeoutMs；两者皆缺省时不存在） */
  timeoutMs?: number;
}

/** [`buildPreviewRequest`] 产物 */
export interface BuildPreviewRequestResult {
  /** 请求基线来源：requestLibrary = config.requestId 命中投影；manual = manualRequest 合成 */
  baseline: "requestLibrary" | "manual";
  /** 将要发出的请求（零出站，仅渲染） */
  request: PreviewRequest;
  /** 渲染警告聚合（未解析引用 / 缺数据按空串替换的提示，与运行期告警口径一致） */
  warnings: string[];
}

/**
 * httpReplay 节点请求面预览（纯函数，零出站）：渲染「将要发出」的完整请求。
 *
 * 与 runner（createHttpReplayRunner）的两点差异，调用方须知：
 *   - **不执行前置脚本**：extraOverride 恒缺省——预览覆盖不到 preProcess 的
 *     运行期改写（节点配置 preProcess 时调用方应自行提示；脚本验证走
 *     script_dry_run 组合）；
 *   - **无上游数据**：`{{ node.* }}` / `{{ input.* }}`（含裸路径）引用按缺数据
 *     渲染为空串并进 warnings——单节点预览没有上游节点输出。
 *
 * 其余与运行完全同口径：基线解析（[`resolveHarEntryForNode`]）、override 合并、
 * 浏览器专属头剥离、`{{ }}` 模板渲染（同一 templateContext 内 `{{ fake.* }}`
 * 跨 url / headers / body 取同一采样值，与单次节点执行语义一致；每次预览调用
 * 重新采样）、头保真 / Cookie 决策并入出站头（与 runner 步骤 3 同一纯函数）、
 * timeoutMs 兜底（覆盖 timeoutMs ?? config.timeoutMs）。
 *
 * @param params 预览目标节点与请求库投影
 * @param templateContext 模板渲染上下文（可缺省；缺省跳过渲染、按原文透传）
 * @returns 基线来源 + 预览请求 + 渲染警告
 * @throws Error 节点无可用请求基线（requestId 未命中投影且未配置 manualRequest）
 *         ——与 runner 的 failed 语义同源，调用方分类为 missing-baseline
 */
export function buildPreviewRequest(
  params: BuildPreviewRequestParams,
  templateContext?: RenderContext,
): BuildPreviewRequestResult {
  const { node, harEntries } = params;
  const config = node.config;

  // 基线来源标注：requestId 命中投影为 requestLibrary，否则（含回退 manual）为 manual
  const requestId = config.requestId;
  const baseline: BuildPreviewRequestResult["baseline"] =
    typeof requestId === "string" && requestId !== "" && harEntries?.[requestId] !== undefined
      ? "requestLibrary"
      : "manual";

  const harEntry = resolveHarEntryForNode(node, harEntries);
  if (harEntry === undefined) {
    throw new Error(
      `节点 ${node.id} 无可用请求基线（config.requestId 未命中请求库且未配置 manualRequest）`,
    );
  }

  // 请求重建 + 渲染警告收集（预览不执行前置脚本，extraOverride 恒缺省）
  const { request, warnings } = buildReplayRequestWithWarnings(
    { harEntry, override: config.override },
    templateContext,
  );

  // 头保真 / Cookie 决策并入出站头（与 runner 步骤 3 同一纯函数，预览 = 将发送）
  const removedHeaders = config.override?.removedHeaders;
  const decisions = [
    ...resolveHeaderFidelityPlan({
      fidelity: config.headerFidelity,
      harEntry,
      templateContext,
      removedHeaders,
    }),
  ];
  const cookieDecision = resolveCookieDecision({
    mode: config.cookieMode,
    cookieValue: config.cookieValue,
    harEntry,
    templateContext,
    removedHeaders,
  });
  if (cookieDecision !== undefined) decisions.push(cookieDecision);
  const headers: Record<string, string> = { ...request.headers };
  for (const decision of decisions) headers[decision.header] = decision.value;

  // 出站载荷形状（与 runner 步骤 4 一致）：文本 body 走 body、二进制走 bodyBase64
  const preview: PreviewRequest = {
    method: request.method,
    url: request.url,
    headers,
  };
  if (request.body !== undefined) {
    if (typeof request.body === "string") preview.body = request.body;
    else preview.bodyBase64 = encodeBase64(request.body);
  }
  const timeoutMs = request.timeoutMs ?? config.timeoutMs;
  if (timeoutMs !== undefined) preview.timeoutMs = timeoutMs;

  return { baseline, request: preview, warnings };
}
