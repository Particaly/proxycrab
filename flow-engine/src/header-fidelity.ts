/**
 * header 保真（M9-T3）纯逻辑：按节点配置解析「该注入哪些头、取什么值」，
 * 并构造 chrome.declarativeNetRequest.modifyHeaders 动态规则描述。
 *
 * 背景（docs/m9-t1-findings.md 结论 ②）：重放的最终出口闸门
 * （engine/replay.ts 的 stripBrowserOnlyHeaders）默认剥离 Origin / Referer，
 * 且两者是 fetch 层 forbidden header——override / fetch init 都设不进去；
 * 服务端校验这些头的接口重放必失败。唯一通道是 DNR 的 modifyHeaders 规则
 * （网络层改写）。本模块只做规则「构造」，安装 / 清理 / 冷启动清扫的生命周期在
 * src/background/replay-headers.ts（依赖 chrome API，本模块零环境依赖、可单测）。
 *
 * 【session 规则】规则经 updateSessionRules 安装（浏览器会话级运行时规则）：
 * 真机实证 dynamic 规则（updateDynamicRules）不支持 tabIds（Chrome 拒绝并提示
 * "only supported for session-scoped rules"），而 tabIds:[-1] 是本能力的硬约束，
 * 故必须走 session 规则。session 规则同为运行时动态增删；SW 回收后仍存活，
 * 由后台的冷启动清扫兜底（详见 replay-headers.ts）。
 *
 * 规则形态（安全约束，缺一不可）：
 *   - condition.tabIds: [-1] —— 只匹配「不关联任何 tab」的请求，即扩展自身
 *     （service worker fetch）发起的请求；页面 / 其他 tab 的流量完全不受影响；
 *   - condition.regexFilter: ^<目标 origin 转义>/ —— 只匹配本次重放的目标 origin，
 *     重定向跳转到其他 origin 的后续请求不匹配（Origin / Referer 不跨源泄漏）；
 *   - action.modifyHeaders: 对配置的头做 set（有则覆盖、无则新增）。
 *
 * 取值来源（NodeHeaderFidelity；键缺省 = 回放捕获值）：
 *   - 'fromCapture'：从 HAR 基线按头名大小写不敏感查找捕获值（找不到则跳过该头）；
 *   - 'static'：手动指定值，传入 templateContext 时先按 {{ }} 模板渲染
 *     （渲染后为空串则跳过——DNR 的 set 不允许空值）。
 *
 * 默认语义：Origin / Referer / User-Agent 是浏览器默认携带的请求上下文头，
 * 重放时默认按捕获值还原（三个键都不配 = 全部 fromCapture）；只有需要改写
 * 取值时才在节点配置里落 static 项。这与配置面板「无勾选开关」的形态一致。
 *
 * Cookie 快照 / 自定义值（resolveCookieDecision，另一个入口）：节点
 * config.cookieMode 缺省 / 'snapshot' 时把捕获快照的 Cookie（结构化
 * request.cookies 优先、回退 Cookie 请求头）经同一条 DNR 规则在网络层
 * set——fetch 层 Cookie 是 forbidden header，jar 之外的回放只能走网络层；
 * 'custom' 时注入 config.cookieValue（支持 `{{ }}` 模板，渲染后为空串则跳过）；
 * 无注入值时自然退化为浏览器 jar。DNR 的 modifyHeaders 允许
 * set Cookie（仅 append 操作有头名白名单，Cookie 恰好也在白名单内）。
 *
 * DNR 规则 ID 管理：本模块保留一段专用 ID 区间（HEADER_RULE_ID_MIN..MAX），
 * 后台按分配器自增取号；SW 冷启动时后台清扫整段区间（防 SW 被回收后遗留的
 * 僵尸规则，思路同 M9-T4 对孤儿 run 的启动扫描）。
 *
 * 本模块纯函数、零环境依赖（不依赖存储 / 网络 / chrome API），node 可直接单测。
 * 按任务约定不经 src/engine/index.ts 桶文件导出，消费方以
 * `@/engine/header-fidelity` 深路径引入。
 *
 * 【载荷移植差异（ProxyCrab 基座）】Rust 重放管线直接发送请求头、无 forbidden
 * header 与 DNR：决策产物不再经 updateSessionRules 安装，而是由宿主侧（或
 * run-workflow 装配的 httpReplay runner）把决策头直接并入出站 headers；规则
 * 构造函数保留为纯数据产物（形态不变，供测试与后续宿主实现复用）。
 */

import type { HarEntry, HeaderFidelitySource, NodeCookieMode, NodeHeaderFidelity } from "./types";
import { renderTemplate } from "./template";
import type { RenderContext } from "./template";
import { parseUrl } from "./url-lite";

/* ------------------------------------------------------------------ *
 * 常量与类型
 * ------------------------------------------------------------------ */

/** 保真目标的配置键 → 实际注入的 HTTP 头名（键顺序即决策 / 规则头顺序，保持稳定） */
export const HEADER_FIDELITY_TARGETS = {
  origin: "Origin",
  referer: "Referer",
  userAgent: "User-Agent",
} as const;

/** 保真配置键字面量联合 */
export type HeaderFidelityKey = keyof typeof HEADER_FIDELITY_TARGETS;

/**
 * 本模块专用的 DNR session 规则 ID 区间（含两端）。
 * 区间内 ID 只归 header 保真使用：后台冷启动清扫按「ID 落在区间内」整段移除，
 * 不依赖对规则内容的识别（DNR 规则没有自定义标签字段）。取 900 万段远离
 * 其他可能的规则使用方；单次 SW 生命周期至多分配 10 万条（自增回绕），足够。
 */
export const HEADER_RULE_ID_MIN = 9_000_000;
export const HEADER_RULE_ID_MAX = 9_099_999;

/**
 * 判断 DNR 规则 ID 是否落在本模块保留区间内（冷启动清扫的删除判据）。
 *
 * @param id DNR 规则 id
 * @returns true = 属于 header 保真专用区间，清扫时应移除
 */
export function isReservedHeaderRuleId(id: number): boolean {
  return Number.isInteger(id) && id >= HEADER_RULE_ID_MIN && id <= HEADER_RULE_ID_MAX;
}

/** 单个头的注入决策（解析产物，规则构造的输入） */
export interface HeaderFidelityDecision {
  /** 配置键（origin / referer / userAgent；cookie 为 Cookie 快照注入） */
  key: HeaderFidelityKey | "cookie";
  /** 实际注入的 HTTP 头名（如 'Origin' / 'Cookie'） */
  header: string;
  /** 注入值（fromCapture 的捕获值或 static 的模板渲染结果，非空） */
  value: string;
  /** 取值来源（记录用，便于测试与排查；'snapshot' = 捕获快照的 Cookie） */
  source: HeaderFidelitySource | "snapshot";
}

/**
 * DNR modifyHeaders 的单头操作（chrome.declarativeNetRequest.ModifyHeaderInfo
 * 的结构子集；字段为字符串字面量，与 chrome 类型的模板字面量枚举联合兼容，
 * 可直接作为普通对象传给 updateDynamicRules，无需 chrome 类型依赖）。
 */
export interface DnrModifyHeader {
  /** 要修改的请求头名 */
  header: string;
  /** 操作：set（有则覆盖、无则新增） */
  operation: "set";
  /** 头值（非空） */
  value: string;
}

/**
 * header 保真 DNR 规则描述（chrome.declarativeNetRequest.Rule 的结构子集，
 * 尚未分配 id——id 由后台管理器安装时从保留区间统一取号）。
 */
export interface DnrHeaderRuleSpec {
  /** 规则优先级（固定 1，无其他规则竞争） */
  priority: number;
  /** 匹配条件：目标 origin 正则 + 仅扩展自身请求 */
  condition: {
    /** RE2 正则：^<目标 origin 转义>/ —— 只匹配目标 origin 的请求 */
    regexFilter: string;
    /** [-1] = 只匹配不关联 tab 的请求（扩展 service worker 发起） */
    tabIds: number[];
  };
  /** 动作：modifyHeaders（对请求头做 set） */
  action: {
    type: "modifyHeaders";
    requestHeaders: DnrModifyHeader[];
  };
}

/** createHeaderRuleIdAllocator 的可调区间（缺省用本模块保留区间） */
export interface HeaderRuleIdRange {
  /** 区间下界（含） */
  min?: number;
  /** 区间上界（含） */
  max?: number;
}

/* ------------------------------------------------------------------ *
 * 取值解析
 * ------------------------------------------------------------------ */

/**
 * 在 HAR 基线请求头中按头名大小写不敏感查找捕获值。
 *
 * @param harEntry HAR 快照条目（捕获基线）
 * @param headerName 目标头名（如 'Origin'；比较前转小写）
 * @returns 捕获值；基线未携带该头时返回 undefined
 */
function findCapturedHeader(harEntry: HarEntry, headerName: string): string | undefined {
  const lowered = headerName.toLowerCase();
  for (const header of harEntry.request.headers) {
    if (header.name.toLowerCase() === lowered) return header.value;
  }
  return undefined;
}

/**
 * 解析单个保真头的注入值（决策项；不可注入时返回 undefined）。
 *
 * 取值规则：
 *   - 'fromCapture'：HAR 基线大小写不敏感查找，找不到 → undefined（跳过）；
 *   - 'static'：原始值为非空字符串才继续；传入 templateContext 时先渲染
 *     （渲染永不失败，缺数据替换为空串）；渲染 / 原始结果 trim 后为空 → undefined
 *     （DNR set 不允许空值）。
 *
 * @param key 配置键
 * @param item 该头的配置项（已确保存在）
 * @param harEntry HAR 基线（fromCapture 取值来源）
 * @param templateContext 模板渲染上下文（可缺省；缺省按原文透传）
 */
function resolveDecision(
  key: HeaderFidelityKey,
  item: NonNullable<NodeHeaderFidelity[HeaderFidelityKey]>,
  harEntry: HarEntry,
  templateContext?: RenderContext,
): HeaderFidelityDecision | undefined {
  const header = HEADER_FIDELITY_TARGETS[key];

  if (item.source === "fromCapture") {
    const captured = findCapturedHeader(harEntry, header);
    if (captured === undefined) return undefined;
    return { key, header, value: captured, source: "fromCapture" };
  }

  // source === 'static'
  const raw = typeof item.value === "string" ? item.value : "";
  const rendered = templateContext ? renderTemplate(raw, templateContext).value : raw;
  if (rendered.trim() === "") return undefined;
  return { key, header, value: rendered, source: "static" };
}

/**
 * 按节点 header 保真配置解析注入决策（纯函数）。
 *
 * 遍历顺序固定为 origin → referer → userAgent（HEADER_FIDELITY_TARGETS 键序），
 * 配置键缺省时按 fromCapture 处理（默认回放捕获值）；不可注入的项静默跳过
 * （基线未携带 / static 值为空）。removedHeaders 命中的头（大小写不敏感）整体
 * 跳过——用户在配置面板删除了该头，重放不应再经 DNR 注回。
 *
 * @param params.fidelity 节点 header 保真配置（undefined / 缺键 = 该头 fromCapture）
 * @param params.harEntry HAR 基线（fromCapture 取值来源）
 * @param params.templateContext 模板渲染上下文（可缺省）
 * @param params.removedHeaders 已删除头名（override.removedHeaders，可缺省）
 * @returns 注入决策列表（保序；可能为空 = 基线未捕获、本次重放无需 DNR 规则）
 */
export function resolveHeaderFidelityPlan(params: {
  fidelity?: NodeHeaderFidelity;
  harEntry: HarEntry;
  templateContext?: RenderContext;
  removedHeaders?: readonly string[];
}): HeaderFidelityDecision[] {
  const { fidelity, harEntry, templateContext } = params;
  const removed = new Set((params.removedHeaders ?? []).map((name) => name.trim().toLowerCase()));

  const decisions: HeaderFidelityDecision[] = [];
  for (const key of Object.keys(HEADER_FIDELITY_TARGETS) as HeaderFidelityKey[]) {
    const header = HEADER_FIDELITY_TARGETS[key];
    if (removed.has(header.toLowerCase())) continue;
    // 键缺省 = 回放捕获值（默认携带）：三个头不再需要显式开启
    const item = fidelity?.[key] ?? { source: "fromCapture" as const };
    const decision = resolveDecision(key, item, harEntry, templateContext);
    if (decision) decisions.push(decision);
  }
  return decisions;
}

/* ------------------------------------------------------------------ *
 * Cookie 快照（捕获值回放）
 * ------------------------------------------------------------------ */

/** Cookie 注入的目标头名（DNR modifyHeaders 的 header 字段） */
export const COOKIE_HEADER_NAME = "Cookie";

/**
 * 从 HAR 基线提取捕获时的 Cookie 串（纯函数）。
 *
 * 取值优先级：
 *   1. 结构化 `request.cookies`（捕获链路正常时会写入 name/value 数组）——
 *      按数组顺序拼成 `name=value; name2=value2`；
 *   2. 回退 `Cookie` 请求头原文（大小写不敏感），原样 trim 返回。
 *
 * 两者都取不到 / 结果为空串时返回 undefined（快照未捕获 Cookie，无可回放值）。
 *
 * @param harEntry HAR 快照基线
 * @returns 可用于回放的 Cookie 串；未捕获时为 undefined
 */
export function extractSnapshotCookie(harEntry: HarEntry): string | undefined {
  const cookies = harEntry.request.cookies;
  if (Array.isArray(cookies)) {
    const parts: string[] = [];
    for (const cookie of cookies) {
      if (typeof cookie?.name !== "string" || cookie.name === "") continue;
      parts.push(`${cookie.name}=${typeof cookie.value === "string" ? cookie.value : ""}`);
    }
    if (parts.length > 0) return parts.join("; ");
  }
  const header = harEntry.request.headers.find(
    (item) => item.name.toLowerCase() === COOKIE_HEADER_NAME.toLowerCase(),
  )?.value;
  if (typeof header === "string" && header.trim() !== "") return header.trim();
  return undefined;
}

/**
 * 解析 Cookie 携带方式的注入决策（纯函数）。
 *
 * 语义（NodeConfig.cookieMode）：
 *   - mode 缺省 / 'snapshot'：回放捕获快照的 Cookie——快照未捕获 Cookie 时
 *     返回 undefined（无可注入值，退化为浏览器 jar）；
 *   - mode 'custom'：注入 cookieValue 指定的值（支持 `{{ }}` 模板，便于把
 *     运行时变量拼进 Cookie，如 `session={{ var.sid }}`）——原始值非空字符串
 *     才继续，渲染 / 原始结果 trim 后为空 → undefined（退化为浏览器 jar，
 *     DNR 的 set 不允许空值）；不读快照，无引用也可用。
 *
 * 注入经 DNR modifyHeaders 在网络层 set Cookie 头（fetch 层 Cookie 是
 * forbidden header 设不进去，与 Origin / Referer 同一通道）。
 *
 * @param params.mode 节点 Cookie 携带方式（缺省 = 'snapshot'）
 * @param params.cookieValue 自定义 Cookie 值模板（mode='custom' 时取值来源）
 * @param params.harEntry HAR 基线（快照捕获值来源；custom 模式不读）
 * @param params.templateContext 模板渲染上下文（可缺省；缺省按原文透传）
 * @param params.removedHeaders 已删除头名（override.removedHeaders，可缺省）——
 *   用户删除了 Cookie 头时整体跳过注入（捕获值与自定义值都不再带上）
 * @returns Cookie 注入决策；无需注入时为 undefined
 */
export function resolveCookieDecision(params: {
  mode?: NodeCookieMode;
  cookieValue?: string;
  harEntry: HarEntry;
  templateContext?: RenderContext;
  removedHeaders?: readonly string[];
}): HeaderFidelityDecision | undefined {
  const { mode, cookieValue, harEntry, templateContext } = params;
  const removed = (params.removedHeaders ?? []).some(
    (name) => name.trim().toLowerCase() === COOKIE_HEADER_NAME.toLowerCase(),
  );
  if (removed) return undefined;

  if (mode === "custom") {
    const raw = typeof cookieValue === "string" ? cookieValue : "";
    const rendered = templateContext ? renderTemplate(raw, templateContext).value : raw;
    if (rendered.trim() === "") return undefined;
    return { key: "cookie", header: COOKIE_HEADER_NAME, value: rendered, source: "static" };
  }

  // 缺省 / 'snapshot'（历史配置残留的 'browser' 值同样按缺省快照语义处理）
  const captured = extractSnapshotCookie(harEntry);
  if (captured === undefined) return undefined;
  const rendered = templateContext ? renderTemplate(captured, templateContext).value : captured;
  if (rendered.trim() === "") return undefined;
  return { key: "cookie", header: COOKIE_HEADER_NAME, value: rendered, source: "snapshot" };
}

/* ------------------------------------------------------------------ *
 * 规则构造
 * ------------------------------------------------------------------ */

/** 转义正则元字符（RE2 兼容的最小转义：DNR regexFilter 使用 RE2 语法） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从目标 URL 构造 origin 匹配正则（DNR regexFilter）。
 *
 * 形如 `^https://api\.example\.com:8443/`：锚定 origin 全串 + 路径分隔符，
 * 子域 / 相近域不会误匹配（保真头不外溢到非目标源）。
 *
 * 【宿主注入点替换】归档用 WHATWG URL 提取 origin；QuickJS 无 URL 全局，改用
 * url-lite.ts 的纯 JS 子集解析（host 小写 / 缺省端口省略 / 非特殊 scheme 的
 * opaque origin 均与 WHATWG 同口径），可解析性边界见 url-lite.ts 文件头。
 *
 * @param url 本次重放的最终 URL（模板渲染后）
 * @returns RE2 正则文本；URL 不可解析或 origin 为 'null'（opaque）时返回 null
 */
export function buildOriginRegexFilter(url: string): string | null {
  const parsed = parseUrl(url);
  if (parsed === null) return null;
  const origin = parsed.origin;
  if (origin === "" || origin === "null") return null;
  return `^${escapeRegExp(origin)}/`;
}

/**
 * 把注入决策构造成一条 DNR modifyHeaders 规则描述（纯函数，未含 id）。
 *
 * 一条规则承载全部决策头（一次 updateSessionRules 完成）；决策为空或目标 URL
 * 无法构造 origin 正则时返回 null（调用方跳过安装，不产生空规则）。
 * 规则经 session 规则通道安装（tabIds 仅 session 规则支持，见文件头）。
 *
 * @param params.targetUrl 本次重放的最终 URL（决定匹配 origin）
 * @param params.decisions 注入决策（resolveHeaderFidelityPlan 产物）
 * @returns 规则描述；无可安装内容时为 null
 */
export function buildHeaderFidelityRule(params: {
  targetUrl: string;
  decisions: readonly HeaderFidelityDecision[];
}): DnrHeaderRuleSpec | null {
  const { targetUrl, decisions } = params;
  if (decisions.length === 0) return null;
  const regexFilter = buildOriginRegexFilter(targetUrl);
  if (regexFilter === null) return null;

  return {
    priority: 1,
    condition: {
      regexFilter,
      // [-1]：仅匹配扩展自身发起（不关联 tab）的请求，页面流量不受影响
      tabIds: [-1],
    },
    action: {
      type: "modifyHeaders",
      requestHeaders: decisions.map((decision) => ({
        header: decision.header,
        operation: "set",
        value: decision.value,
      })),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 规则 ID 分配器
 * ------------------------------------------------------------------ */

/**
 * 创建保留区间内的自增规则 ID 分配器（工厂——每个 SW 生命周期一个实例，
 * 由后台管理器持有；区间回绕时从下界重新开始，冷启动清扫保证区间在分配前为空）。
 *
 * @param range 可调区间（缺省 HEADER_RULE_ID_MIN..MAX）
 * @returns 分配器：next() 依序返回区间内的下一个 id（确定性，便于单测）
 */
export function createHeaderRuleIdAllocator(range?: HeaderRuleIdRange): { next(): number } {
  const min = range?.min ?? HEADER_RULE_ID_MIN;
  const max = range?.max ?? HEADER_RULE_ID_MAX;
  const span = max - min + 1;
  let cursor = 0;
  return {
    next(): number {
      const offset = cursor % span;
      cursor += 1;
      return min + offset;
    },
  };
}
