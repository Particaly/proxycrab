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

import type { HarEntry, HarPostData } from "./types";
import { renderTemplate, renderValueDeep } from "./template";
import type { RenderContext } from "./template";
import { decodeBase64 } from "./base64";

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
 * 与提示由上层（M5-T4 分类）统一处理。
 *
 * @param params HAR 条目与两份覆盖
 * @param templateContext 模板渲染上下文（可缺省；缺省跳过渲染）
 * @returns 可交给 fetch 的重放请求描述
 */
export function buildReplayRequest(
  params: BuildReplayRequestParams,
  templateContext?: RenderContext,
): ReplayRequest {
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
  let finalUrl = target.url;
  let finalHeaders: Record<string, string> = strippedHeaders;
  let finalBody = target.body;
  if (templateContext) {
    finalUrl = renderTemplate(finalUrl, templateContext).value;
    // headers 只渲染值（renderValueDeep 不改键）；值为字符串，渲染结果仍是字符串
    finalHeaders = renderValueDeep(strippedHeaders, templateContext).value as Record<
      string,
      string
    >;
    // 二进制 body（Uint8Array，base64 解码产物）不做模板渲染——按原始字节发送
    if (finalBody !== undefined && typeof finalBody === "string") {
      finalBody = renderTemplate(finalBody, templateContext).value;
    }
  }

  const request: ReplayRequest = {
    method: target.method,
    url: finalUrl,
    headers: finalHeaders,
  };
  if (finalBody !== undefined) request.body = finalBody;
  if (target.timeoutMs !== undefined) request.timeoutMs = target.timeoutMs;
  return request;
}
