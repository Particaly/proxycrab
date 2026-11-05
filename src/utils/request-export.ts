/**
 * 请求库导出的纯函数生成器（ReqFlow 复刻 Task 9；移植上游 request-export.ts）。
 *
 * 输入请求库条目（RequestLibraryEntry，快照恒为单 entry，取 log.entries[0] 为
 * 请求描述），输出六种常用格式的字符串；无 Vue / store / DOM 依赖，可被 vitest
 * node 环境直测。与请求库导入（request-library-import.ts，Task 8）同一分层约定：
 * 解析 / 生成全部在本模块，下载动作在 request-export-download.ts，UI 编排在
 * 请求库视图的「导出」区块（stores/request-library.ts runExport）。
 *
 * 六种格式与关键决策（均为文档化选择，测试逐条锁定）：
 *   1. cURL：复用既有 src/utils/curl.ts 的命令形态与 POSIX 引号规则（--request /
 *      --url / --header 逐行 + ` \\` 续行；剔除 content-length；单引号按 `'"'"'`
 *      惯用法转义），适配请求库条目数据。body 用 --data-raw（@ 不被展开为文件
 *      引用）；二进制 body 无法忠实内联进单引号（内联 base64 或存于 bodyRef
 *      blob），按既有实现在顶部加注释披露并追加 `--data-binary @-`（由调用方
 *      经 stdin 传入原始字节）。
 *   2. HAR：单条 HAR 1.2（{ log: { entries: [entry] } }）从入库快照逐字导出
 *      （preserving 原样，理由见 HAR_EXPORT_INLINE_DISCLOSURE）：请求库入库只
 *      内联 ≤64 KiB 的 UTF-8 文本 body，二进制或更大的 body 存为独立 blob
 *      （bodyRef），纯函数取不到 blob 字节，故不做推测性补全，仅在 log.comment
 *      （HAR 1.2 官方可选字段）统一披露。
 *   3. Postman Collection v2.1：info.schema 指向官方 v2.1 schema，item.request
 *      含 method / header / url（对象形态：raw + protocol/host/path/query）/
 *      body（raw 模式），Postman 可直接导入。
 *   4. fetch / axios / Python requests：生成可直接运行的代码。内联 base64 的
 *      二进制 body 字节级重建（fetch/axios 用 atob + Uint8Array，Python 用
 *      base64.b64decode，产物可直接运行且字节级保真）；长字符串按块换行拼接
 *      （JS 用 `+` 拼接、Python 用括号内相邻字面量隐式拼接，逐块独立字面量化
 *      保证转义序列永不跨块断裂）；凭据行为对齐浏览器捕获（fetch
 *      credentials: 'include'、axios withCredentials: true——捕获时请求携带了
 *      Cookie，保持重放行为一致）。bodyRef 外置 body 取不到字节：以无 body
 *      生成并加注释行披露（代码类）或 description 字段披露（Postman）。
 *
 * body 解析（resolveRequestBody，各格式共用）：
 *   - postData.text 为 base64（encoding === 'base64'）→ 二进制 body：代码类
 *     格式解码重建字节；cURL 省略 body 并注释披露；
 *   - postData.text 非空（普通文本）→ 文本 body 原样使用；
 *   - text 为空而 params 非空（部分抓取链路只留参数表）→ 按 urlencoded 重建
 *     （multipart 除外：缺 boundary 的伪表单体比缺 body 误导性更强，按无 body）;
 *   - 无内联文本但 bodyRef 存在 → 外置 body（代码类注释披露 / cURL
 *     --data-binary @- / Postman description）；
 *   - postData 缺失 / text 与 params 均空 → 无 body（各格式均不输出 body 部分）。
 *
 * Cookie：只依赖请求头里的 Cookie 头（入库链路已并入 headers），HAR 的
 * cookies 数组不再单独展开，避免重复。
 *
 * 快照无 entry（log.entries 为空；正常入库链路不会产生，防御性处理）：
 * HAR / Postman 输出合法的空产物，代码类返回空串（UI 层对空串不做动作）。
 */

import type { RequestLibraryEntry } from "../api/types";
import { shellQuote } from "./curl";

/* ------------------------------------------------------------------ *
 * 常量与格式清单
 * ------------------------------------------------------------------ */

/** Postman Collection v2.1 官方 schema 地址（Postman 导入时校验） */
export const POSTMAN_COLLECTION_SCHEMA =
  "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

/**
 * HAR 导出在 log.comment 里统一披露的入库 body 内联策略（决策说明见文件头第 2 条）。
 *
 * 背景：请求库入库链路只把 ≤64 KiB 的 UTF-8 文本请求体内联进快照
 * （crates/proxy-crab-mitm/src/flow/request_library.rs 的 REQUEST_BODY_INLINE_LIMIT），
 * 二进制或更大的 body 写入独立 blob 并以 bodyRef 引用；本导出为纯函数，不回读
 * blob，因此 entries 与快照逐字一致、不对具体 body 做推测性补全。
 */
export const HAR_EXPORT_INLINE_DISCLOSURE =
  "导出自 ProxyCrab 请求库：entries 与入库快照逐字一致（原样导出）。" +
  "请求库入库时只内联不超过 64 KiB 的 UTF-8 文本请求体，二进制或更大的请求体存为" +
  "独立 blob（bodyRef）且不随本文件导出；如需完整请求体请在请求库详情中查看。";

/** 导出格式 id（六种，与计划 Task 9 一一对应） */
export type RequestExportFormatId = "curl" | "har" | "postman" | "fetch" | "axios" | "python";

/** 导出格式元信息（UI 菜单与交付方式判定共用） */
export interface RequestExportFormat {
  id: RequestExportFormatId;
  /** UI 菜单项文案 */
  label: string;
  /** 交付方式：copy = 生成后复制到剪贴板；download = 生成后保存/下载文件 */
  kind: "copy" | "download";
  /** 文件扩展名（kind='download' 时使用；copy 格式为 null） */
  extension: string | null;
}

/** 六种导出格式清单（顺序即 UI 展示顺序：三种数据交换格式 + 三种代码生成） */
export const REQUEST_EXPORT_FORMATS: readonly RequestExportFormat[] = [
  { id: "curl", label: "cURL 命令", kind: "copy", extension: null },
  { id: "har", label: "HAR 文件", kind: "download", extension: "har" },
  {
    id: "postman",
    label: "Postman Collection",
    kind: "download",
    extension: "postman_collection.json",
  },
  { id: "fetch", label: "fetch 代码", kind: "copy", extension: null },
  { id: "axios", label: "axios 代码", kind: "copy", extension: null },
  { id: "python", label: "Python requests 代码", kind: "copy", extension: null },
];

/* ------------------------------------------------------------------ *
 * 共用：entry 解析与请求体规范化
 * ------------------------------------------------------------------ */

/** 快照第一条 entry；log.entries 为空时返回 null（调用方按空产物处理）。 */
function snapshotEntry(
  entry: RequestLibraryEntry,
): RequestLibraryEntry["har"]["log"]["entries"][0] | null {
  return entry.har?.log?.entries?.[0] ?? null;
}

/** 请求体规范化结果（导出各格式的统一中间形态，语义见文件头「body 解析」） */
type ResolvedRequestBody =
  | { kind: "none" }
  | { kind: "text"; text: string; mimeType: string }
  | { kind: "base64"; base64: string; mimeType: string; byteLength: number }
  | { kind: "external"; byteLength: number };

/**
 * 按 UTF-8 字节数估算 base64 文本解码后的长度（按 padding 精确计算）。
 *
 * @param base64 base64 文本（长度按 4 对齐的标准形态；畸形输入给出近似值即可）
 */
function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * 规范化快照里的请求体（postData / bodyRef）为统一中间形态（语义见文件头
 * 「body 解析」）。
 *
 * @param entry 请求库条目
 */
function resolveRequestBody(entry: RequestLibraryEntry): ResolvedRequestBody {
  const postData = snapshotEntry(entry)?.request?.postData;
  if (postData === undefined || postData === null) return externalBodyRef(entry);
  const mimeType = postData.mimeType;

  // 二进制 body：HAR 以 base64 文本记录原始字节（encoding 字段标注），文本为
  // 空时同样视为无 body（空二进制与无 body 无法区分，按无 body 处理）
  if (postData.encoding === "base64" && (postData.text ?? "") !== "") {
    const base64 = postData.text ?? "";
    return { kind: "base64", base64, mimeType, byteLength: base64ByteLength(base64) };
  }

  const text = postData.text ?? "";
  if (text !== "") return { kind: "text", text, mimeType };

  // text 为空而 params 非空：按 urlencoded 重建（params 值为解码原文，重新编码）；
  // multipart 不重建——缺 boundary 的伪表单体比缺 body 误导性更强（见文件头）
  const params = postData.params ?? [];
  const isMultipart = mimeType.split(";")[0]?.trim().toLowerCase() === "multipart/form-data";
  if (params.length > 0 && !isMultipart) {
    const rebuilt = params
      .map((param) => `${param.name}=${encodeURIComponent(param.value)}`)
      .join("&");
    if (rebuilt !== "") return { kind: "text", text: rebuilt, mimeType };
  }
  return externalBodyRef(entry);
}

/** 无内联文本但 blob 外置 body 存在（bodyRef）时的规范化结果。 */
function externalBodyRef(entry: RequestLibraryEntry): ResolvedRequestBody {
  const size = entry.bodyRef?.size ?? 0;
  return size > 0 ? { kind: "external", byteLength: size } : { kind: "none" };
}

/* ------------------------------------------------------------------ *
 * cURL（复用既有 src/utils/curl.ts 的命令形态，见文件头第 1 条）
 * ------------------------------------------------------------------ */

/** 二进制 / 外置 body 的披露注释（`--data-binary @-` 需调用方经 stdin 供数）。 */
function curlBodyNote(body: { kind: "base64" | "external"; byteLength: number }): string {
  return body.kind === "base64"
    ? `# 请求体为二进制内容（快照以 base64 记录，约 ${body.byteLength} 字节）：` +
        "请将原始字节通过 stdin 传给 curl。"
    : `# 请求体未内联在快照中（约 ${body.byteLength} 字节，存于请求库 blob）：` +
        "请将原始字节通过 stdin 传给 curl。";
}

/**
 * 生成可执行 cURL 命令（POSIX shell 语法，多行反斜杠续行）。
 *
 * 命令形态与既有 fullCurl（src/utils/curl.ts）逐条对齐：`curl \` 起始、
 * --request / --url / --header 逐行（剔除 content-length）、文本 body 用
 * --data-raw、二进制/外置 body 顶部注释 + `--data-binary @-`（既有实现的
 * stdin 供数方案）。
 *
 * @param entry 请求库条目；快照无 entry 时返回空串
 */
export function exportRequestAsCurl(entry: RequestLibraryEntry): string {
  const request = snapshotEntry(entry)?.request;
  if (request === undefined) return "";

  const lines = [
    "curl \\",
    `  --request ${shellQuote(request.method)} \\`,
    `  --url ${shellQuote(request.url)}`,
  ];
  const headers = request.headers.filter(
    (header) => header.name.toLowerCase() !== "content-length",
  );
  for (const header of headers) {
    lines[lines.length - 1] += " \\";
    lines.push(`  --header ${shellQuote(`${header.name}: ${header.value}`)}`);
  }

  const body = resolveRequestBody(entry);
  if (body.kind === "text") {
    // --data-raw：@ 不被解释为文件引用（curl -d 会展开 @file，快照正文以 @
    // 开头时会被误读，故统一用 --data-raw）
    lines[lines.length - 1] += " \\";
    lines.push(`  --data-raw ${shellQuote(body.text)}`);
  } else if (body.kind === "base64" || body.kind === "external") {
    lines.unshift(curlBodyNote(body));
    lines[lines.length - 1] += " \\";
    lines.push("  --data-binary @-");
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * HAR
 * ------------------------------------------------------------------ */

/**
 * 生成单条 HAR 1.2 文本（{ log: { entries: [entry] } }）。
 *
 * entries 逐字保留入库快照原样，不做推测性补全；仅在 log.comment（HAR 1.2
 * 官方可选字段）统一披露入库 body 内联策略（见 HAR_EXPORT_INLINE_DISCLOSURE）。
 *
 * @param entry 请求库条目；空 entries 时输出 entries: []（仍是合法 HAR）
 */
export function exportRequestAsHar(entry: RequestLibraryEntry): string {
  const payload = {
    log: {
      ...entry.har?.log,
      comment: HAR_EXPORT_INLINE_DISCLOSURE,
    },
  };
  return JSON.stringify(payload, null, 2);
}

/* ------------------------------------------------------------------ *
 * Postman Collection v2.1
 * ------------------------------------------------------------------ */

/** Postman URL 对象（v2.1 url 变体的子集，仅建模本模块会生成的字段） */
interface PostmanUrlExport {
  /** 原始 URL（Postman 发送时以此为准） */
  raw: string;
  protocol?: string;
  host?: string[];
  path?: string[];
  query?: Array<{ key: string; value: string }>;
}

/** Postman 请求对象（v2.1 request 变体的子集） */
interface PostmanRequestExport {
  method: string;
  header: Array<{ key: string; value: string }>;
  url: PostmanUrlExport;
  /** raw 模式 body（无 body 时缺省；Postman 允许） */
  body?: {
    mode: "raw";
    raw: string;
    /** JSON body 声明语言（Postman 编辑器高亮），其余 mimeType 不标注 */
    options?: { raw: { language: string } };
  };
  /** 二进制 / 外置 body 未包含时的披露说明（官方 description 字段） */
  description?: string;
}

/** Postman Collection v2.1 产物形状 */
interface PostmanCollectionExport {
  info: {
    name: string;
    schema: string;
  };
  item: Array<{ name: string; request: PostmanRequestExport }>;
}

/** mimeType 基本类型（去参数、小写）；Postman JSON 语言标注判定用。 */
function baseMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** JSON mimeType（application/json 或 +json 后缀）→ Postman raw 编辑器标注 json。 */
function isJsonMimeType(mimeType: string): boolean {
  const base = baseMimeType(mimeType);
  return base === "application/json" || base.endsWith("+json");
}

/**
 * 构造 Postman 的 url 对象：raw + 由 URL 解析出的 protocol / host / path / query。
 * path 段保留百分号编码原文（Postman 发送时自行处理编码）；URL 畸形时仅保留
 * raw——Postman 允许 url 对象只有 raw 字段。
 *
 * @param rawUrl 原始 URL
 */
function buildPostmanUrl(rawUrl: string): PostmanUrlExport {
  const url: PostmanUrlExport = { raw: rawUrl };
  try {
    const parsed = new URL(rawUrl);
    url.protocol = parsed.protocol.replace(/:$/, "");
    url.host = parsed.hostname.split(".");
    url.path = parsed.pathname.split("/").filter((segment) => segment !== "");
    const query = [...parsed.searchParams.entries()].map(([key, value]) => ({ key, value }));
    if (query.length > 0) url.query = query;
  } catch {
    // URL 无法解析（畸形快照）：仅保留 raw，Postman 仍可导入
  }
  return url;
}

/**
 * 构造 Postman 的 item（单请求）。
 *
 * @param name item 名（取请求条目名称）
 * @param entry 请求库条目
 */
function buildPostmanItem(
  name: string,
  entry: RequestLibraryEntry,
): { name: string; request: PostmanRequestExport } {
  const request = snapshotEntry(entry)?.request;
  if (request === undefined) return { name, request: { method: "", header: [], url: { raw: "" } } };
  const body = resolveRequestBody(entry);
  const postman: PostmanRequestExport = {
    method: request.method,
    header: request.headers.map((header) => ({ key: header.name, value: header.value })),
    url: buildPostmanUrl(request.url),
  };
  if (body.kind === "text") {
    postman.body = {
      mode: "raw",
      raw: body.text,
      ...(isJsonMimeType(body.mimeType) ? { options: { raw: { language: "json" } } } : {}),
    };
  } else if (body.kind === "base64") {
    // Postman 无注释语法：以官方 description 字段披露二进制 body 未包含
    postman.description = `请求体为二进制内容（快照以 base64 记录，约 ${body.byteLength} 字节），未包含在导出中。`;
  } else if (body.kind === "external") {
    postman.description = `请求体未包含在导出中（约 ${body.byteLength} 字节，存于请求库 blob）。`;
  }
  return { name, request: postman };
}

/**
 * 生成 Postman Collection v2.1 文本（Postman 可直接导入）。
 * info.name 取请求条目名称；快照无 entry 时输出 item: []（合法空 collection）。
 *
 * @param entry 请求库条目
 */
export function exportRequestAsPostman(entry: RequestLibraryEntry): string {
  const collection: PostmanCollectionExport = {
    info: {
      name: entry.name,
      schema: POSTMAN_COLLECTION_SCHEMA,
    },
    item: snapshotEntry(entry) === null ? [] : [buildPostmanItem(entry.name, entry)],
  };
  return JSON.stringify(collection, null, 2);
}

/* ------------------------------------------------------------------ *
 * fetch / axios / Python requests
 * ------------------------------------------------------------------ */

/** 长字符串换行拼接的单行上限（原始字符数；仅 body / base64 这类可能极长的值参与） */
const STRING_WRAP_CHARS = 72;

/**
 * 把长字符串按 STRING_WRAP_CHARS 切块。每块独立过 stringLiteral 字面量化，
 * 转义序列（\n / 引号 / unicode）天然不跨块断裂；跨块的代理对经 JSON.stringify
 * 的 well-formed 转义在运行时拼接后仍还原为原字符，逐块安全。
 *
 * @param value 原始字符串
 */
function splitForWrap(value: string): string[] {
  if (value.length <= STRING_WRAP_CHARS) return [value];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += STRING_WRAP_CHARS) {
    chunks.push(value.slice(index, index + STRING_WRAP_CHARS));
  }
  return chunks;
}

/**
 * JSON 字符串字面量：JSON.stringify 产物同时是合法的 JS 与 Python 字符串
 * 字面量（转义子集：\" \\ \n \t \uXXXX 等 Python 全部支持），三种代码生成共用。
 */
function stringLiteral(value: string): string {
  return JSON.stringify(value);
}

/**
 * JS 对象属性里的文本 body 行（fetch 的 body / axios 的 data 共用）。
 * 短值单行；长值生成 `'块1' +\n<缩进>'块2'` 形式的换行拼接（可直接运行）。
 *
 * @param key 属性名（body / data）
 * @param value body 文本
 * @param propIndent 属性所在缩进（续行比属性多一层）
 */
function jsTextBodyLines(key: string, value: string, propIndent: string): string[] {
  const contIndent = `${propIndent}  `;
  const chunks = splitForWrap(value);
  if (chunks.length === 1) return [`${propIndent}${key}: ${stringLiteral(value)},`];
  return chunks.map((chunk, index) => {
    const prefix = index === 0 ? `${propIndent}${key}: ` : contIndent;
    return `${prefix}${stringLiteral(chunk)}${index === chunks.length - 1 ? "," : " +"}`;
  });
}

/**
 * JS 对象属性里的二进制 body 行：Uint8Array.from(atob(base64), charCodeAt)。
 * base64 长文本在 atob 参数位换行拼接（产物对短 base64 也是可直接运行的）。
 *
 * @param key 属性名（body / data）
 * @param base64 base64 文本
 * @param propIndent 属性所在缩进
 */
function jsBase64BodyLines(key: string, base64: string, propIndent: string): string[] {
  const contIndent = `${propIndent}  `;
  const chunks = splitForWrap(base64);
  const lines: string[] = [`${propIndent}${key}: Uint8Array.from(`, `${contIndent}atob(`];
  chunks.forEach((chunk, index) => {
    // atob 的唯一参数是一个拼接表达式：块间用 +，末块后不加任何符号
    lines.push(`${contIndent}  ${stringLiteral(chunk)}${index === chunks.length - 1 ? "" : " +"}`);
  });
  lines.push(`${contIndent}),`);
  lines.push(`${contIndent}(charCode) => charCode.charCodeAt(0),`);
  lines.push(`${propIndent}),`);
  return lines;
}

/**
 * Python 调用参数行（requests.request 的 data 共用）。
 * 短值单行；长值生成括号内相邻字面量隐式拼接。注意末块后不能加逗号——
 * `("a" "b",)` 末尾逗号会把整个括号变成单元素元组，改变类型语义。
 *
 * @param assignPrefix 赋值前缀（'data=' 或 'data=base64.b64decode('）
 * @param value body 文本 / base64 文本
 * @param paramIndent 参数所在缩进
 */
function pyParamLines(assignPrefix: string, value: string, paramIndent: string): string[] {
  const contIndent = `${paramIndent}    `;
  if (value.length <= STRING_WRAP_CHARS) {
    return [`${paramIndent}${assignPrefix}${stringLiteral(value)},`];
  }
  const chunks = splitForWrap(value);
  const lines: string[] = [`${paramIndent}${assignPrefix}(`];
  for (const chunk of chunks) lines.push(`${contIndent}${stringLiteral(chunk)}`);
  lines.push(`${paramIndent}),`);
  return lines;
}

/** 外置 body（bodyRef blob）在代码类格式中的披露注释（JS 与 Python 前缀不同）。 */
function externalBodyComment(byteLength: number, commentPrefix: string): string {
  return (
    `${commentPrefix} 请求体未内联在快照中（约 ${byteLength} 字节，存于请求库 blob），` +
    "请自行附加原始请求体。"
  );
}

/**
 * 生成可直接运行的 fetch 代码（含 headers / body / credentials）。
 *
 * 形态：`const response = await fetch(url, { method, headers, body, credentials })`。
 * 决策：credentials 统一 'include'——浏览器捕获时请求携带了 Cookie（同源自动 /
 * 跨域凭据），include 使重放最接近捕获时的凭据行为，同源请求 include 与
 * same-origin 等价无副作用。headers 空时省略整个 headers 块；同名重复头按
 * 对象语义后值覆盖（对象字面量天然如此，请求侧重复头极罕见）。
 *
 * @param entry 请求库条目；快照无 entry 时返回空串
 */
export function exportRequestAsFetch(entry: RequestLibraryEntry): string {
  const request = snapshotEntry(entry)?.request;
  if (request === undefined) return "";

  const body = resolveRequestBody(entry);
  const lines: string[] = [];
  if (body.kind === "external") lines.push(externalBodyComment(body.byteLength, "//"));
  lines.push(`const response = await fetch(${stringLiteral(request.url)}, {`);
  lines.push(`  method: ${stringLiteral(request.method)},`);
  if (request.headers.length > 0) {
    lines.push("  headers: {");
    for (const header of request.headers) {
      lines.push(`    ${stringLiteral(header.name)}: ${stringLiteral(header.value)},`);
    }
    lines.push("  },");
  }
  if (body.kind === "text") lines.push(...jsTextBodyLines("body", body.text, "  "));
  else if (body.kind === "base64") lines.push(...jsBase64BodyLines("body", body.base64, "  "));
  lines.push('  credentials: "include",');
  lines.push("})");
  return lines.join("\n");
}

/**
 * 生成可直接运行的 axios 代码（axios.request 配置对象形态）。
 *
 * 形态：`const response = await axios.request({ method, url, headers, data })`。
 * 决策：withCredentials: true 与 fetch 生成器的 credentials: 'include' 对齐
 * （axios 跨域默认不带凭据，而浏览器捕获场景通常带 Cookie）。headers 空时
 * 省略整个 headers 块；同名重复头按对象语义后值覆盖。
 *
 * @param entry 请求库条目；快照无 entry 时返回空串
 */
export function exportRequestAsAxios(entry: RequestLibraryEntry): string {
  const request = snapshotEntry(entry)?.request;
  if (request === undefined) return "";

  const body = resolveRequestBody(entry);
  const lines: string[] = [];
  if (body.kind === "external") lines.push(externalBodyComment(body.byteLength, "//"));
  lines.push("const response = await axios.request({");
  lines.push(`  method: ${stringLiteral(request.method)},`);
  lines.push(`  url: ${stringLiteral(request.url)},`);
  if (request.headers.length > 0) {
    lines.push("  headers: {");
    for (const header of request.headers) {
      lines.push(`    ${stringLiteral(header.name)}: ${stringLiteral(header.value)},`);
    }
    lines.push("  },");
  }
  if (body.kind === "text") lines.push(...jsTextBodyLines("data", body.text, "  "));
  else if (body.kind === "base64") lines.push(...jsBase64BodyLines("data", body.base64, "  "));
  lines.push("  withCredentials: true,");
  lines.push("})");
  return lines.join("\n");
}

/**
 * 生成可直接运行的 Python requests 代码（requests.request 调用形态）。
 *
 * 形态：`response = requests.request(method, url, headers=..., data=...)`，
 * 4 空格缩进；headers 空时省略；无 body 时省略 data 参数。二进制 body 用
 * `base64.b64decode(...)` 重建（此时文件头多一行 `import base64`）。长 body
 * 以括号内相邻字面量隐式拼接（见 pyParamLines，末块后不得有逗号）。
 *
 * @param entry 请求库条目；快照无 entry 时返回空串
 */
export function exportRequestAsPython(entry: RequestLibraryEntry): string {
  const request = snapshotEntry(entry)?.request;
  if (request === undefined) return "";

  const body = resolveRequestBody(entry);
  const lines: string[] = [];
  if (body.kind === "external") lines.push(externalBodyComment(body.byteLength, "#"));
  if (body.kind === "base64") lines.push("import base64");
  lines.push("import requests");
  lines.push("");
  lines.push("response = requests.request(");
  lines.push(`    ${stringLiteral(request.method)},`);
  lines.push(`    ${stringLiteral(request.url)},`);
  if (request.headers.length > 0) {
    lines.push("    headers={");
    for (const header of request.headers) {
      lines.push(`        ${stringLiteral(header.name)}: ${stringLiteral(header.value)},`);
    }
    lines.push("    },");
  }
  if (body.kind === "text") lines.push(...pyParamLines("data=", body.text, "    "));
  else if (body.kind === "base64") {
    lines.push(...pyParamLines("data=base64.b64decode(", body.base64, "    "));
  }
  lines.push(")");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * 分发与文件名
 * ------------------------------------------------------------------ */

/**
 * 按格式生成导出内容（UI 层统一出口，各分支与对应导出函数逐字一致）。
 *
 * @param entry 请求库条目
 * @param format 格式 id（REQUEST_EXPORT_FORMATS 中的 id）
 */
export function exportRequestSnapshot(
  entry: RequestLibraryEntry,
  format: RequestExportFormatId,
): string {
  switch (format) {
    case "curl":
      return exportRequestAsCurl(entry);
    case "har":
      return exportRequestAsHar(entry);
    case "postman":
      return exportRequestAsPostman(entry);
    case "fetch":
      return exportRequestAsFetch(entry);
    case "axios":
      return exportRequestAsAxios(entry);
    case "python":
      return exportRequestAsPython(entry);
  }
}

/** 文件名中名称段的最大长度（超出截断，避免超出文件系统限制；与流程导出一致） */
const EXPORT_NAME_MAX_LENGTH = 60;

/** 文件名中的非法字符（路径分隔符、Windows 保留字符与控制字符；与流程导出一致） */
const FILENAME_ILLEGAL_PATTERN = /[/\\:*?"<>|\u0000-\u001f]/g;

/**
 * 由请求名称与导出时间构造下载文件名。
 * 规则与仓库既有导出命名一致：名称中不适合进文件名的字符替换为「-」、压缩
 * 空白并截断到安全长度，清洗后为空回退「request」；形如
 * `proxycrab-<名称>-<YYYY-MM-DD>.<extension>`（日期按本地时区）。
 * Postman 下载传 'postman_collection.json' 即得到官方约定的命名形态。
 *
 * @param name 请求名称（原文）
 * @param exportedAt 导出时间戳（Unix 毫秒）
 * @param extension 文件扩展名（如 'har' / 'postman_collection.json'）
 */
export function buildRequestExportFileName(
  name: string,
  exportedAt: number,
  extension: string,
): string {
  const safeName = name
    // 先压缩空白（含制表符等控制类空白），再替换路径分隔符 / Windows 保留字符
    .replace(/\s+/g, " ")
    .replace(FILENAME_ILLEGAL_PATTERN, "-")
    .replace(/^[-\s]+/, "")
    .replace(/[-\s.]+$/, "")
    .slice(0, EXPORT_NAME_MAX_LENGTH)
    .replace(/[-\s.]+$/, "");
  const date = new Date(exportedAt);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `proxycrab-${safeName === "" ? "request" : safeName}-${yyyy}-${mm}-${dd}.${extension}`;
}
