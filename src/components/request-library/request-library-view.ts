import type { BodyPayload, RequestLibraryEntry, RequestLibrarySource } from "../../api/types";

/**
 * 请求库列表/详情的展示纯函数（形态移植自 ReqFlow 请求中心 requests-view-model）。
 *
 * 关键字 / 标签 / 来源过滤由后端 `GET /api/request-library` 承担（query/tags/source
 * 参数），这里只做纯展示派生：HAR 快照字段安全读取、URL/域名拆分、排序 comparator、
 * 分组（不分组/按标签多对多/按域名）、请求体 BodyPayload 推导与标签输入解析。
 * 返回值均为纯数据，便于 vitest node 环境直接锁定规则。
 */

/** 分组方式：不分组 / 按标签 / 按来源域名（首个 HAR entry 的 request.url host）。 */
export type RequestGroupKey = "none" | "tag" | "host";

/** 排序方式：创建时间倒序/正序、名称 A-Z、体积大小（大在前）。 */
export type RequestSortKey = "created-desc" | "created-asc" | "name-asc" | "size-desc";

/** 分组下拉选项（顺序即展示顺序）。 */
export const REQUEST_GROUP_OPTIONS: ReadonlyArray<{ value: RequestGroupKey; label: string }> = [
  { value: "none", label: "不分组" },
  { value: "tag", label: "按标签" },
  { value: "host", label: "按域名" },
];

/** 排序下拉选项（顺序即展示顺序）。 */
export const REQUEST_SORT_OPTIONS: ReadonlyArray<{ value: RequestSortKey; label: string }> = [
  { value: "created-desc", label: "创建时间倒序" },
  { value: "created-asc", label: "创建时间正序" },
  { value: "name-asc", label: "名称 A-Z" },
  { value: "size-desc", label: "响应体积" },
];

/** 来源过滤下拉选项（"" 表示不过滤）。 */
export const REQUEST_SOURCE_OPTIONS: ReadonlyArray<{
  value: RequestLibrarySource | "";
  label: string;
}> = [
  { value: "", label: "全部来源" },
  { value: "capture", label: "抓包入库" },
  { value: "import", label: "导入" },
  { value: "manual", label: "手工" },
];

/** 来源徽标文案。 */
export const SOURCE_LABELS: Record<RequestLibrarySource, string> = {
  capture: "抓包",
  import: "导入",
  manual: "手工",
};

/** 搜索框占位文案（关键字经服务端匹配名称与 URL）。 */
export const REQUEST_KEYWORD_PLACEHOLDER = "搜索名称或 URL";

/** 未打标签请求的兜底分组名（按标签分组时）。 */
export const UNTAGGED_GROUP_LABEL = "未打标签";

/** 无法提取来源域名的请求兜底分组名（按域名分组时）。 */
export const UNKNOWN_HOST_GROUP_LABEL = "未知来源";

/** 行内最多直接展示的标签数，超出部分收进「+N」。 */
export const MAX_ROW_TAGS = 2;

/* --------------------------- HAR 快照字段安全读取 --------------------------- */

/** 展示用主 URL：首个 HAR entry 的 request.url；快照不完整时兜底空串。 */
export function requestUrl(entry: RequestLibraryEntry): string {
  return entry.har?.log?.entries?.[0]?.request?.url ?? "";
}

/** 展示用 HTTP 方法：首个 HAR entry 的 request.method；缺失时兜底空串。 */
export function requestMethod(entry: RequestLibraryEntry): string {
  return entry.har?.log?.entries?.[0]?.request?.method ?? "";
}

/** 请求头列表：首个 HAR entry 的 request.headers。 */
export function requestHeaders(entry: RequestLibraryEntry): Array<{ name: string; value: string }> {
  return entry.har?.log?.entries?.[0]?.request?.headers ?? [];
}

/** 响应摘要：首个 HAR entry 的 response（未收到响应时为 null）。 */
export function requestResponse(entry: RequestLibraryEntry) {
  return entry.har?.log?.entries?.[0]?.response ?? null;
}

/** 响应体积（字节）：response.content.size，非法（负数表示未知）按 0 计。 */
export function requestSize(entry: RequestLibraryEntry): number {
  const size = requestResponse(entry)?.content?.size;
  return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 0;
}

/* ------------------------------ 域名与 URL 展示 ------------------------------ */

/**
 * 从 URL 提取来源域名 host（分组用）：完整 URL 解析取 hostname；解析失败按
 * `scheme://authority` 宽松提取；仍失败返回空串（归入「未知来源」组）。
 */
export function extractHost(url: string): string {
  if (typeof url !== "string" || url.trim() === "") return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    const match = url.trim().match(/^(?:[a-z][a-z\d+.-]*:)?\/\/([^/?#]+)/i);
    if (!match) return "";
    const authority = match[1] ?? "";
    const withoutUserinfo = authority.includes("@")
      ? authority.slice(authority.lastIndexOf("@") + 1)
      : authority;
    return (withoutUserinfo.split(":")[0] ?? "").toLowerCase();
  }
}

/** URL → 行内展示的 host + path 拆分；host 保留端口，空 path 兜底 '/'。 */
export function formatUrlParts(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    return { host: parsed.host, path: path === "" ? "/" : path };
  } catch {
    return { host: extractHost(url), path: url };
  }
}

/* ---------------------------------- 排序 ---------------------------------- */

/** 名称比较（小写后逐字符比较，主键相同时以 id 兜底保证确定性）。 */
function compareByName(a: RequestLibraryEntry, b: RequestLibraryEntry): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const SORT_COMPARATORS: Record<
  RequestSortKey,
  (a: RequestLibraryEntry, b: RequestLibraryEntry) => number
> = {
  "created-desc": (a, b) => b.createdAt - a.createdAt || compareByName(a, b),
  "created-asc": (a, b) => a.createdAt - b.createdAt || compareByName(a, b),
  "name-asc": compareByName,
  // 响应体积大在前；同体积按创建时间倒序。
  "size-desc": (a, b) => requestSize(b) - requestSize(a) || b.createdAt - a.createdAt,
};

/** 排序请求条目（纯函数，返回新数组）。 */
export function sortRequests(
  entries: RequestLibraryEntry[],
  sortBy: RequestSortKey,
): RequestLibraryEntry[] {
  return [...entries].sort(SORT_COMPARATORS[sortBy]);
}

/* ---------------------------------- 分组 ---------------------------------- */

export interface RequestGroup {
  key: string;
  label: string;
  items: RequestLibraryEntry[];
}

/**
 * 分组请求条目（纯函数）。none 返回单一分组（不渲染组头）；tag 按标签多对多
 * 扁平化（无标签归入「未打标签」）；host 按来源域名分组（提取不到归入「未知来源」）。
 * 兜底组固定排最后，组内保持入参顺序（通常先过 sortRequests）。
 */
export function groupRequests(
  entries: RequestLibraryEntry[],
  groupBy: RequestGroupKey,
): RequestGroup[] {
  if (groupBy === "none") {
    return entries.length === 0 ? [] : [{ key: "all", label: "全部请求", items: [...entries] }];
  }

  const buckets = new Map<string, RequestGroup>();
  const bucketOf = (key: string, label: string): RequestGroup => {
    const existing = buckets.get(key);
    if (existing) return existing;
    const created: RequestGroup = { key, label, items: [] };
    buckets.set(key, created);
    return created;
  };

  if (groupBy === "tag") {
    for (const entry of entries) {
      if (entry.tags.length === 0) {
        bucketOf("tag:", UNTAGGED_GROUP_LABEL).items.push(entry);
        continue;
      }
      for (const tag of entry.tags) {
        bucketOf(`tag:${tag}`, tag).items.push(entry);
      }
    }
  } else {
    for (const entry of entries) {
      const host = extractHost(requestUrl(entry));
      bucketOf(
        host === "" ? "host:" : `host:${host}`,
        host === "" ? UNKNOWN_HOST_GROUP_LABEL : host,
      ).items.push(entry);
    }
  }

  // 兜底组按固定 key 识别（标签撞名时不受影响），固定排在最后。
  const FALLBACK_GROUP_KEYS = new Set(["tag:", "host:"]);
  const groups = [...buckets.values()];
  groups.sort((a, b) => {
    const fallback = (group: RequestGroup) => (FALLBACK_GROUP_KEYS.has(group.key) ? 1 : 0);
    if (fallback(a) !== fallback(b)) return fallback(a) - fallback(b);
    const an = a.label.toLowerCase();
    const bn = b.label.toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.key < b.key ? -1 : 1;
  });
  return groups;
}

/** 按顺序收集分组结果的全部条目 id（供「全选当前结果」）。 */
export function collectGroupItemIds(groups: RequestGroup[]): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    for (const entry of group.items) ids.push(entry.id);
  }
  return ids;
}

/** 组合派生：排序 → 分组（过滤由服务端承担），一步得到列表渲染模型。 */
export function buildRequestGroups(
  entries: RequestLibraryEntry[],
  view: { groupBy: RequestGroupKey; sortBy: RequestSortKey },
): RequestGroup[] {
  return groupRequests(sortRequests(entries, view.sortBy), view.groupBy);
}

/* ------------------------------ 请求体推导 ------------------------------ */

/**
 * 请求体 → BodyPayload（供 BodyViewer 消费）：
 *   - 无 postData 且无 bodyRef → empty；
 *   - postData.text 内联原文 → text（size 为 UTF-8 字节数）；
 *   - postData.text 为 base64 或 bodyRef blob → binary（BodyViewer 经
 *     `GET /api/request-library/{id}/body` 取解码后的原始字节）。
 */
export function requestBodyPayload(entry: RequestLibraryEntry): BodyPayload {
  const postData = entry.har?.log?.entries?.[0]?.request?.postData;
  if (postData?.text != null) {
    if (postData.encoding === "base64") {
      return { type: "binary", size: base64DecodedSize(postData.text) };
    }
    return { type: "text", content: postData.text, size: byteLength(postData.text) };
  }
  if (entry.bodyRef) return { type: "binary", size: entry.bodyRef.size };
  return { type: "empty" };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Base64 文本解码后的字节估算：`ceil(len * 3 / 4)`，含 padding 修正。 */
export function base64DecodedSize(text: string): number {
  let padding = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === "="; i -= 1) padding += 1;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

/* ------------------------------ 标签输入解析 ------------------------------ */

/**
 * 标签输入解析：半角/全角逗号均为分隔符，去首尾空白、去空段、按原文去重（保序）。
 */
export function parseTagInput(raw: string): string[] {
  const tags: string[] = [];
  for (const part of raw.split(/[,，]/)) {
    const tag = part.trim();
    if (tag !== "" && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/** 标签集合比较（顺序无关）。 */
export function tagsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag) => b.includes(tag));
}
