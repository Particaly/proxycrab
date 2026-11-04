import type {
  CreateRequestLibraryRequest,
  RequestLibraryHarEntry,
  RequestLibraryHarPair,
  RequestLibraryHarPostData,
  RequestLibraryHarSnapshot,
} from "../api/types";

/**
 * 请求库导入纯函数（ReqFlow 复刻 Task 8；移植自归档 reqflow 的
 * curl-import.ts / har-import.ts，落库形状改为本仓库请求库的最小 HAR 快照）。
 *
 * 无 Vue / DOM / backend 依赖的纯函数：把用户提供的 cURL 命令、HAR 1.2 文本或
 * Postman Collection v2.1 文本解析为可入库的请求条目列表。返回值均为纯数据，
 * 解析失败以 { ok:false, error } 表达，绝不向上抛未捕获异常。
 *
 * 容错分层：文件级失败（非 JSON / 缺 log.entries / 缺 item 数组）整体报错；
 * 条目级失败（缺 method / url 等）跳过并记入 skipped，不中断其余条目。
 *
 * 体积策略：请求体超过 IMPORT_BODY_MAX_BYTES（64 KiB，对齐 request_library.rs
 * 的 REQUEST_BODY_INLINE_LIMIT）时按 UTF-8 字符边界截断。最小快照的响应侧只留
 * 摘要（status / content.size / mimeType，不含响应体文本，重放只消费请求侧）。
 *
 * 落库组装：buildImportSnapshot 把单条 entry 包成 {log:{version,creator,entries}}
 * 快照；name 省略时由后端按 `METHOD host+path` 默认命名并做数字后缀去重，
 * 前端仅在预览时用 buildDefaultRequestName 生成同名规则文案。
 * 去重策略（importDedupKey / filterDuplicateItems）：以 `METHOD URL` 为身份键，
 * 由调用方对库内既有条目键集合做跳过或全量导入。
 */

/* ------------------------------------------------------------------ *
 * 类型与常量
 * ------------------------------------------------------------------ */

/** 请求体 / 响应体入库内联上限（64 KiB，对齐 REQUEST_BODY_INLINE_LIMIT）。 */
export const IMPORT_BODY_MAX_BYTES = 64 * 1024;

/** 解析产物：一条可入库请求（entry 为本仓库请求库的最小 HAR 条目形状）。 */
export interface ImportRequestItem {
  method: string;
  url: string;
  /** 响应状态（HAR 导入携带；cURL / Postman 无响应为 -1）。 */
  status: number;
  entry: RequestLibraryHarEntry;
}

/** 按 UTF-8 字符边界截断文本（超 maxBytes 时），保证不含半字符（U+FFFD）。 */
export function truncateUtf8Safe(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end--;
  if (end > 0 && (bytes[end - 1] & 0x80) !== 0) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 从 URL 解析 origin：非法 URL 或 origin 为 'null'（file:// 等）返回空串。 */
export function parseUrlOrigin(url: string): string {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? "" : origin;
  } catch {
    return "";
  }
}

/** URL → host（含端口）+ path 拆分；解析失败整体回退原文（与后端同一规则）。 */
function splitUrlParts(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: parsed.pathname };
  } catch {
    return { host: url, path: "" };
  }
}

/**
 * 默认条目名：`METHOD host+path`（根路径省略 `/`；方法为空只留目标；
 * 非法 URL 回退原文）。与后端 request_library.rs 的 build_default_request_name
 * 同一规则，仅用于导入预览展示——落库 name 省略时后端会生成同名默认值。
 */
export function buildDefaultRequestName(method: string, url: string): string {
  const { host, path } = splitUrlParts(url);
  const target = path === "/" || path === "" ? host : `${host}${path}`;
  const upper = method.trim().toUpperCase();
  return upper === "" ? target : `${upper} ${target}`;
}

/** 组装入库快照：单条（或多条）entry 包一层最小 HAR log。 */
export function buildImportSnapshot(entries: RequestLibraryHarEntry[]): RequestLibraryHarSnapshot {
  return {
    log: {
      version: "1.2",
      creator: { name: "ProxyCrab", version: "1.0" },
      entries,
    },
  };
}

/* ------------------------------------------------------------------ *
 * cURL 解析
 * ------------------------------------------------------------------ */

/** cURL 解析成功产物：足以组装 HarEntry 的请求描述。 */
export interface CurlParsedRequest {
  method: string;
  url: string;
  headers: RequestLibraryHarPair[];
  queryString: RequestLibraryHarPair[];
  cookies: RequestLibraryHarPair[];
  body?: string;
  mimeType?: string;
}

export type CurlImportResult = { ok: true; request: CurlParsedRequest } | { ok: false; error: string };

/** 引号未闭合的统一错误文案。 */
const UNBALANCED_QUOTE_ERROR = "引号未闭合：请检查命令中的单引号 / 双引号";

/**
 * 把命令原文切分为 argv 形态 token（bash 语义子集）：单引号内全字面量（`'\'''`
 * 惯用法成立）、双引号内仅 \$ \` \" \\ 与 \换行 转义、反斜杠行续接（含引号内）、
 * 未加引号区域 \x 转 x。不支持 shell 重定向 / 管道 / 多命令。
 */
function tokenize(input: string): { tokens: string[]; error: string | null } {
  const tokens: string[] = [];
  let current = "";
  let hasCurrent = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (hasCurrent) {
        tokens.push(current);
        current = "";
        hasCurrent = false;
      }
      i += 1;
      continue;
    }

    if (ch === "\\") {
      const next = input[i + 1];
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (next === "\r") {
        i += input[i + 2] === "\n" ? 3 : 2;
        continue;
      }
      if (next === undefined) {
        i += 1;
        continue;
      }
      current += next;
      hasCurrent = true;
      i += 2;
      continue;
    }

    if (ch === "'") {
      hasCurrent = true;
      i += 1;
      let closed = false;
      while (i < input.length) {
        if (input[i] === "'") {
          closed = true;
          i += 1;
          break;
        }
        current += input[i];
        i += 1;
      }
      if (!closed) return { tokens: [], error: UNBALANCED_QUOTE_ERROR };
      continue;
    }

    if (ch === '"') {
      hasCurrent = true;
      i += 1;
      let closed = false;
      while (i < input.length) {
        const c = input[i];
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (c === "\\") {
          const n = input[i + 1];
          if (n === undefined) {
            i += 1;
            continue;
          }
          if (n === "\n") {
            i += 2;
            continue;
          }
          if (n === "$" || n === "`" || n === '"' || n === "\\") {
            current += n;
            i += 2;
            continue;
          }
          current += c;
          i += 1;
          continue;
        }
        current += c;
        i += 1;
      }
      if (!closed) return { tokens: [], error: UNBALANCED_QUOTE_ERROR };
      continue;
    }

    current += ch;
    hasCurrent = true;
    i += 1;
  }

  if (hasCurrent) tokens.push(current);
  return { tokens, error: null };
}

/** 选项值语义归类。 */
type OptionValueKind =
  | "header"
  | "method"
  | "data"
  | "data-urlencode"
  | "form"
  | "cookie"
  | "user-agent"
  | "referer"
  | "user"
  | "url";

/** 带参且值被使用的短选项。 */
const SHORT_WITH_VALUE: Record<string, OptionValueKind> = {
  H: "header",
  X: "method",
  d: "data",
  F: "form",
  b: "cookie",
  A: "user-agent",
  e: "referer",
  u: "user",
};

/** 带参但值被忽略的短选项（只为吃掉参数，避免其参数被误当 URL）。 */
const SHORT_IGNORED_WITH_VALUE = new Set(["o", "m", "c", "C", "D", "T", "x", "t", "z", "w", "Q", "K", "E"]);

/** 无参短选项：-I 触发 HEAD、-G 触发 GET 查询串形态，其余忽略。 */
const SHORT_FLAGLESS = new Set([
  "k", "s", "S", "v", "i", "I", "f", "l", "g", "G", "L", "n", "N", "q", "a", "B", "h", "M", "0", "1", "2", "4", "6",
]);

/** 带参且值被使用的长选项。 */
const LONG_WITH_VALUE: Record<string, OptionValueKind> = {
  "--header": "header",
  "--request": "method",
  "--data": "data",
  "--data-raw": "data",
  "--data-binary": "data",
  "--data-urlencode": "data-urlencode",
  "--form": "form",
  "--cookie": "cookie",
  "--user-agent": "user-agent",
  "--referer": "referer",
  "--user": "user",
  "--url": "url",
};

/** 带参但值被忽略的长选项。 */
const LONG_IGNORED_WITH_VALUE = new Set([
  "--output", "--proxy", "--max-time", "--connect-timeout", "--retry", "--cacert", "--capath",
  "--cert", "--key", "--dump-header", "--cookie-jar", "--resolve", "--connect-to", "--proto",
  "--pass", "--pubkey", "--continue-at",
]);

/** 无参长选项：--head / --get 有语义，其余忽略。 */
const LONG_FLAGLESS = new Set([
  "--compressed", "--insecure", "--silent", "--verbose", "--location", "--fail", "--head",
  "--get", "--no-buffer", "--http1.0", "--http1.1", "--http2", "--ipv4", "--ipv6",
  "--progress-bar", "--no-keepalive", "--tr-encoding", "--anyauth", "--ntlm", "--digest",
  "--negotiate", "--basic", "--location-trusted",
]);

/** 解析期收集的选项值。 */
interface CollectedOptions {
  urls: string[];
  headers: RequestLibraryHarPair[];
  explicitMethod: string | null;
  headFlag: boolean;
  getFlag: boolean;
  dataParts: string[];
  formFields: Array<{ name: string; value: string }>;
  cookieString: string | null;
  userAgent: string | null;
  referer: string | null;
  basicAuth: string | null;
}

/** 遍历 token 应用选项；遇到不支持的取值形态（文件读取等）返回错误信息。 */
function collectOptions(tokens: string[]): { collected: CollectedOptions; error: string | null } {
  const collected: CollectedOptions = {
    urls: [],
    headers: [],
    explicitMethod: null,
    headFlag: false,
    getFlag: false,
    dataParts: [],
    formFields: [],
    cookieString: null,
    userAgent: null,
    referer: null,
    basicAuth: null,
  };

  const applyValue = (kind: OptionValueKind, value: string): string | null => {
    switch (kind) {
      case "url":
        collected.urls.push(value);
        return null;
      case "header": {
        const header = parseHeaderField(value);
        if (header !== null && header.name !== "") collected.headers.push(header);
        return null;
      }
      case "method":
        collected.explicitMethod = value;
        return null;
      case "data":
        if (value.startsWith("@") || value.startsWith("<")) {
          return "不支持从文件读取请求体（-d @file / <file）";
        }
        collected.dataParts.push(value);
        return null;
      case "data-urlencode": {
        const encoded = encodeDataUrlEncodeValue(value);
        return encoded.ok ? (collected.dataParts.push(encoded.value), null) : encoded.error;
      }
      case "form": {
        const field = splitFormField(value);
        return field.ok ? (collected.formFields.push(field.field), null) : field.error;
      }
      case "cookie":
        if (!value.includes("=")) return "不支持从文件读取 Cookie（-b cookiejar）";
        collected.cookieString = value.trim();
        return null;
      case "user-agent":
        collected.userAgent = value;
        return null;
      case "referer":
        collected.referer = value;
        return null;
      case "user":
        collected.basicAuth = value;
        return null;
    }
  };

  let index = 0;
  // `--` 之后的 token 一律视为位置参数（curl 与 getopt 通用约定）。
  let optionsEnded = false;

  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;

    if (optionsEnded || token === "-" || !token.startsWith("-")) {
      collected.urls.push(token);
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      continue;
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token : token.slice(0, eq);
      const attachedValue = eq === -1 ? undefined : token.slice(eq + 1);
      const kind = LONG_WITH_VALUE[name];
      if (kind !== undefined) {
        const value = attachedValue ?? tokens[index];
        if (value === undefined) return { collected, error: `选项 ${name} 缺少参数` };
        if (attachedValue === undefined) index += 1;
        const applyError = applyValue(kind, value);
        if (applyError !== null) return { collected, error: applyError };
        continue;
      }
      if (LONG_IGNORED_WITH_VALUE.has(name)) {
        if (attachedValue === undefined) index += 1;
        continue;
      }
      if (LONG_FLAGLESS.has(name)) {
        if (name === "--head") collected.headFlag = true;
        if (name === "--get") collected.getFlag = true;
        continue;
      }
      continue;
    }

    // 短选项簇：逐字符处理；带参选项吃掉簇内剩余字符或下一个 token。
    const cluster = token.slice(1);
    let cursor = 0;
    while (cursor < cluster.length) {
      const flag = cluster[cursor];
      cursor += 1;
      const kind = SHORT_WITH_VALUE[flag];
      if (kind !== undefined) {
        const rest = cluster.slice(cursor);
        const value = rest !== "" ? rest : tokens[index];
        if (value === undefined) return { collected, error: `选项 -${flag} 缺少参数` };
        if (rest === "") index += 1;
        cursor = cluster.length;
        const applyError = applyValue(kind, value);
        if (applyError !== null) return { collected, error: applyError };
        continue;
      }
      if (SHORT_IGNORED_WITH_VALUE.has(flag)) {
        if (cluster.slice(cursor) === "") index += 1;
        cursor = cluster.length;
        continue;
      }
      if (SHORT_FLAGLESS.has(flag)) {
        if (flag === "I") collected.headFlag = true;
        if (flag === "G") collected.getFlag = true;
        continue;
      }
    }
  }

  return { collected, error: null };
}

/**
 * 解析 -H 头字段值：`Name: value` → 头；`Name;` → 空值头；无冒号的删头写法
 * → null（HAR 无对应语义，忽略）。
 */
function parseHeaderField(field: string): RequestLibraryHarPair | null {
  const colon = field.indexOf(":");
  if (colon === -1) {
    return field.endsWith(";") ? { name: field.slice(0, -1).trim(), value: "" } : null;
  }
  return { name: field.slice(0, colon).trim(), value: field.slice(colon + 1).trim() };
}

/**
 * 编码 --data-urlencode 的值：`name=content` → `name=encodeURIComponent(content)`
 * （name 不编码）；`=content` / `content` → 全量编码；'@' 在 '=' 之前（读文件）
 * 返回错误。
 */
function encodeDataUrlEncodeValue(
  value: string,
): { ok: true; value: string; error: null } | { ok: false; value: ""; error: string } {
  const at = value.indexOf("@");
  const eq = value.indexOf("=");
  if (at !== -1 && (eq === -1 || at < eq)) {
    return { ok: false, value: "", error: "不支持从文件读取请求体（--data-urlencode @file）" };
  }
  if (eq > 0) {
    return { ok: true, value: `${value.slice(0, eq)}=${encodeURIComponent(value.slice(eq + 1))}`, error: null };
  }
  const content = eq === 0 ? value.slice(1) : value;
  return { ok: true, value: encodeURIComponent(content), error: null };
}

/** 拆分 -F 表单字段（first '='）；@file / <file 读文件上传不支持。 */
function splitFormField(
  value: string,
): { ok: true; field: { name: string; value: string }; error: null } | { ok: false; field: null; error: string } {
  const eq = value.indexOf("=");
  if (eq === -1) {
    return { ok: false, field: null, error: `-F 表单字段缺少 = 分隔（应为 name=value）：${value}` };
  }
  const name = value.slice(0, eq);
  const raw = value.slice(eq + 1);
  if (raw.startsWith("@") || raw.startsWith("<")) {
    return { ok: false, field: null, error: "不支持从文件读取表单字段（-F name=@file）" };
  }
  return { ok: true, field: { name, value: raw }, error: null };
}

/** -d / -F 共用的表单 MIME（curl 的 -d 默认 Content-Type）。 */
const FORM_MIME_TYPE = "application/x-www-form-urlencoded";

/** 把 -b Cookie 串拆为键值对（分号分隔、first '=' 拆键值）。 */
function parseCookieString(cookie: string): RequestLibraryHarPair[] {
  return cookie
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "")
    .map((pair) => {
      const eq = pair.indexOf("=");
      return eq === -1 ? { name: pair, value: "" } : { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    });
}

/** 在头数组中按大小写不敏感查找头名下标（找不到返回 -1）。 */
function findHeaderIndex(headers: readonly RequestLibraryHarPair[], name: string): number {
  const lower = name.toLowerCase();
  return headers.findIndex((header) => header.name.toLowerCase() === lower);
}

/** 设置（或按大小写不敏感覆盖）一个派生头。 */
function setDerivedHeader(headers: RequestLibraryHarPair[], name: string, value: string): void {
  const existing = findHeaderIndex(headers, name);
  if (existing !== -1) headers[existing] = { name, value };
  else headers.push({ name, value });
}

/** 规范化 URL：无协议头补 http://；解析出 queryString；失败返回 null。 */
function normalizeUrl(rawUrl: string): { url: string; queryString: RequestLibraryHarPair[] } | null {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`;
  try {
    const parsed = new URL(candidate);
    const queryString: RequestLibraryHarPair[] = [];
    parsed.searchParams.forEach((value, name) => {
      queryString.push({ name, value });
    });
    return { url: parsed.href, queryString };
  } catch {
    return null;
  }
}

/**
 * 解析 cURL 命令（纯函数，永不抛出）。
 *
 * 选项覆盖：-H/--header（可重复）、-X/--request、-d/--data/--data-raw/
 * --data-binary/--data-urlencode（可重复，多段按 & 拼接）、-F/--form（multipart
 * 简化为表单体）、-b/--cookie、--url、-I/--head、-G/--get、-A/--user-agent、
 * -e/--referer、-u/--user；无参开关忽略；已知带参选项只吃掉参数。
 * 方法推断：-X 显式 > -I(HEAD) > -G(GET，-d 数据并入查询串) > 有体 POST > GET。
 * -F 取舍：不构造 multipart（boundary 组装复杂且 @file 不可行），转为
 * x-www-form-urlencoded 简单体。
 */
export function parseCurlCommand(input: string): CurlImportResult {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, error: "请输入 curl 命令" };
  }

  const { tokens, error: tokenizeError } = tokenize(input);
  if (tokenizeError !== null) return { ok: false, error: tokenizeError };
  if (tokens.length === 0) return { ok: false, error: "请输入 curl 命令" };

  // 首 token 须为 curl（容忍路径前缀 / .exe 后缀 / 前置 sudo）。
  let command = tokens;
  const baseOf = (token: string) => token.replace(/^.*[/\\]/, "").replace(/\.exe$/i, "").toLowerCase();
  if (baseOf(command[0]) === "sudo" && command.length > 1) command = command.slice(1);
  if (baseOf(command[0]) !== "curl") {
    return { ok: false, error: "不是 curl 命令：应以 curl 开头" };
  }

  const { collected, error: collectError } = collectOptions(command.slice(1));
  if (collectError !== null) return { ok: false, error: collectError };

  const rawUrl = collected.urls[0];
  if (rawUrl === undefined || rawUrl.trim() === "") {
    return { ok: false, error: "未找到请求 URL" };
  }
  const normalized = normalizeUrl(rawUrl);
  if (normalized === null) {
    return { ok: false, error: `URL 无法解析：${rawUrl}` };
  }

  // 请求体：-d 系与 -F 字段统一为 & 拼接的表单形态。
  const formPart = collected.formFields
    .map((field) => `${field.name}=${encodeURIComponent(field.value)}`)
    .join("&");
  const parts = [...collected.dataParts, ...(formPart === "" ? [] : [formPart])];
  let body = parts.length === 0 ? undefined : parts.join("&");

  // -G：-d 数据并入查询串（curl 语义），方法回到 GET，body 清空。
  let queryString = normalized.queryString;
  if (collected.getFlag && body !== undefined && body !== "") {
    const merged = normalized.url + (normalized.url.includes("?") ? `&${body}` : `?${body}`);
    const reparsed = normalizeUrl(merged);
    if (reparsed !== null) {
      normalized.url = reparsed.url;
      queryString = reparsed.queryString;
    }
    body = undefined;
  }

  // 头组装：-H 顺序在前，派生头（-A/-e/-u/-b）按大小写不敏感覆盖。
  const headers = collected.headers.map((header) => ({ ...header }));
  if (collected.userAgent !== null) setDerivedHeader(headers, "User-Agent", collected.userAgent);
  if (collected.referer !== null) setDerivedHeader(headers, "Referer", collected.referer);
  if (collected.basicAuth !== null) {
    setDerivedHeader(headers, "Authorization", `Basic ${btoa(collected.basicAuth)}`);
  }
  const cookies = collected.cookieString === null ? [] : parseCookieString(collected.cookieString);
  if (collected.cookieString !== null) {
    const cookieIndex = findHeaderIndex(headers, "Cookie");
    if (cookieIndex !== -1 && headers[cookieIndex].value !== "") {
      headers[cookieIndex] = {
        name: headers[cookieIndex].name,
        value: `${headers[cookieIndex].value}; ${collected.cookieString}`,
      };
    } else {
      setDerivedHeader(headers, "Cookie", collected.cookieString);
    }
  }

  // mimeType：Content-Type 头优先；有体时按 curl 默认行为补表单 MIME。
  const contentTypeIndex = findHeaderIndex(headers, "Content-Type");
  const mimeType =
    contentTypeIndex !== -1 && headers[contentTypeIndex].value !== ""
      ? headers[contentTypeIndex].value
      : body !== undefined
        ? FORM_MIME_TYPE
        : undefined;

  const explicitMethod = collected.explicitMethod?.trim().toUpperCase();
  const method =
    explicitMethod !== undefined && explicitMethod !== ""
      ? explicitMethod
      : collected.headFlag
        ? "HEAD"
        : collected.getFlag
          ? "GET"
          : body !== undefined
            ? "POST"
            : "GET";

  return {
    ok: true,
    request: {
      method,
      url: normalized.url,
      headers,
      queryString,
      cookies,
      ...(body !== undefined ? { body, mimeType } : {}),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 条目组装（cURL / HAR / Postman 三条路径共用）
 * ------------------------------------------------------------------ */

/** 条目组装输入：请求侧字段 + 可选响应摘要与时间信息。 */
interface EntryInput {
  method: string;
  url: string;
  headers: RequestLibraryHarPair[];
  queryString: RequestLibraryHarPair[];
  cookies?: RequestLibraryHarPair[];
  postData?: RequestLibraryHarPostData;
  startedDateTime?: string;
  time?: number;
  /** 响应状态（无响应 / 未知为 -1，此时不携带 response）。 */
  status?: number;
  statusText?: string;
  /** 响应体字节摘要（content.size，未知 -1）。 */
  responseSize?: number;
  responseMimeType?: string;
}

/** 组装最小 HAR 条目（本仓库请求库的落库形状；请求体已在上层截断）。 */
function buildEntry(input: EntryInput): RequestLibraryHarEntry {
  const entry: RequestLibraryHarEntry = {
    request: {
      method: input.method,
      url: input.url,
      httpVersion: "HTTP/1.1",
      headers: input.headers,
      queryString: input.queryString,
      ...(input.cookies !== undefined && input.cookies.length > 0 ? { cookies: input.cookies } : {}),
      ...(input.postData !== undefined ? { postData: input.postData } : {}),
    },
  };
  if (input.startedDateTime !== undefined) entry.startedDateTime = input.startedDateTime;
  if (input.time !== undefined) entry.time = input.time;
  // status 0（部分导出器以 0 表示未收到响应）与负值同样视为无响应，不携带 response。
  if (input.status !== undefined && input.status > 0) {
    entry.response = {
      status: input.status,
      statusText: input.statusText ?? "",
      httpVersion: "unknown",
      headers: [],
      content: { size: input.responseSize ?? -1, mimeType: input.responseMimeType ?? "" },
      redirectURL: "",
    };
  }
  return entry;
}

/** 组装可入库请求条目（method / url 平铺供预览与去重使用）。 */
function buildItem(input: EntryInput): ImportRequestItem {
  const entry = buildEntry(input);
  return {
    method: entry.request.method,
    url: entry.request.url,
    status: entry.response?.status ?? -1,
    entry,
  };
}

/** 单条目 → CreateRequestLibraryRequest（origin 取 URL；name 省略走后端默认命名）。 */
export function buildImportRequest(
  item: ImportRequestItem,
  tags: string[] = [],
): CreateRequestLibraryRequest {
  return {
    har: buildImportSnapshot([item.entry]),
    tags: [...tags],
    origin: parseUrlOrigin(item.url),
  };
}

/** mimeType 是否为表单系（urlencoded / multipart，HAR 惯例这两类带 params）。 */
function isFormMimeType(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return (
    lower.startsWith("application/x-www-form-urlencoded") || lower.startsWith("multipart/form-data")
  );
}

/** 表单体 → HAR params 键值对（& 分段、first '=' 拆键值；解码失败保留原文）。 */
function parseFormParams(body: string): RequestLibraryHarPair[] {
  if (body === "") return [];
  return body.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq === -1) return { name: pair, value: "" };
    const name = pair.slice(0, eq);
    const rawValue = pair.slice(eq + 1);
    try {
      return { name, value: decodeURIComponent(rawValue) };
    } catch {
      return { name, value: rawValue };
    }
  });
}

/**
 * cURL 解析产物 → 可入库条目（纯函数）。请求体过 64 KiB 截断（与 HAR 导入同一
 * 策略，防御粘贴超大 body）；表单系 mimeType 补 params 键值对供键值表展示；
 * 无响应交换（response 不携带），startedDateTime / time 不注入（入库时刻由
 * 后端 createdAt 承担）。
 */
export function buildCurlItem(request: CurlParsedRequest): ImportRequestItem {
  const safeBody =
    request.body === undefined
      ? undefined
      : truncateUtf8Safe(request.body, IMPORT_BODY_MAX_BYTES).text;
  const mimeType = request.mimeType ?? "";
  const postData: RequestLibraryHarPostData | undefined =
    safeBody === undefined
      ? undefined
      : {
          mimeType,
          ...(isFormMimeType(mimeType) ? { params: parseFormParams(safeBody) } : {}),
          text: safeBody,
        };
  return buildItem({
    method: request.method,
    url: request.url,
    headers: request.headers.map((header) => ({ ...header })),
    queryString: request.queryString.map((pair) => ({ ...pair })),
    cookies: request.cookies.length > 0 ? request.cookies.map((cookie) => ({ ...cookie })) : undefined,
    postData,
  });
}

/* ------------------------------------------------------------------ *
 * 去重策略
 * ------------------------------------------------------------------ */

/** 条目身份键：`METHOD URL`（方法大小写归一；URL 原样），用于跳过库内已有条目。 */
export function importDedupKey(method: string, url: string): string {
  return `${method.trim().toUpperCase()} ${url}`;
}

/** 导入提交载荷（对话框 → 窗口回调；窗口负责去重执行与逐条入库）。 */
export interface ImportSubmitPayload {
  items: ImportRequestItem[];
  /** 追加到每条入库条目的标签（可空）。 */
  tags: string[];
  /** true 时窗口按 importDedupKey 跳过库内已有条目。 */
  skipDuplicates: boolean;
}

/** 导入执行结果（窗口回调 → 对话框展示）。 */
export interface ImportSubmitOutcome {
  imported: number;
  failed: number;
  /** 因重复被跳过的条数（仅 skipDuplicates 生效时）。 */
  skipped: number;
}

/** 按既有键集合分流：kept 为待导入，duplicates 为与库内重复的条目（纯函数）。 */
export function filterDuplicateItems(
  items: readonly ImportRequestItem[],
  existingKeys: ReadonlySet<string>,
): { kept: ImportRequestItem[]; duplicates: ImportRequestItem[] } {
  const kept: ImportRequestItem[] = [];
  const duplicates: ImportRequestItem[] = [];
  for (const item of items) {
    (existingKeys.has(importDedupKey(item.method, item.url)) ? duplicates : kept).push(item);
  }
  return { kept, duplicates };
}

/* ------------------------------------------------------------------ *
 * HAR 1.2 解析
 * ------------------------------------------------------------------ */

/** 被跳过的损坏条目（含在 entries 中的下标与原因）。 */
export interface ImportSkipped {
  /** 原始 entries 数组中的下标（从 0 计）。 */
  index: number;
  /** 可展示的中文原因。 */
  reason: string;
}

export type HarImportResult =
  | { ok: true; items: ImportRequestItem[]; skipped: ImportSkipped[] }
  | { ok: false; error: string };

/** 归一化 HAR 头 / 查询串 / params 数组：仅保留 name / value 均为字符串的项。 */
function normalizePairs(value: unknown): RequestLibraryHarPair[] {
  if (!Array.isArray(value)) return [];
  const pairs: RequestLibraryHarPair[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const name = readString(item["name"]);
    const itemValue = readString(item["value"]);
    if (name === undefined || itemValue === undefined) continue;
    pairs.push({ name, value: itemValue });
  }
  return pairs;
}

/** 归一化 cookies：合法项取 name / value（path / domain 等属性最小快照不承载）。 */
function normalizeCookiePairs(value: unknown): RequestLibraryHarPair[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cookies: RequestLibraryHarPair[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const name = readString(item["name"]);
    const itemValue = readString(item["value"]);
    if (name === undefined || itemValue === undefined) continue;
    cookies.push({ name, value: itemValue });
  }
  return cookies;
}

/** 归一化请求体：text 截断到 64 KiB；params 仅保留字符串键值项。 */
function normalizePostData(value: unknown): RequestLibraryHarPostData | undefined {
  if (!isPlainObject(value)) return undefined;
  const postData: RequestLibraryHarPostData = { mimeType: readString(value["mimeType"]) ?? "" };
  const params = normalizePairs(value["params"]);
  if (params.length > 0) postData.params = params;
  const text = readString(value["text"]);
  if (text !== undefined) {
    postData.text = truncateUtf8Safe(text, IMPORT_BODY_MAX_BYTES).text;
  }
  const encoding = readString(value["encoding"]) ?? readString(value["_encoding"]);
  if (encoding !== undefined) postData.encoding = encoding;
  return postData;
}

/**
 * 解析 HAR 1.2 JSON 文本（纯函数，永不抛出）。
 *
 * 文件级失败（非 JSON / 缺 log / 缺 log.entries 数组）返回 ok:false；条目级失败
 * （非对象 / 缺 request.method 或 request.url）跳过并记入 skipped，不中断其余。
 * 响应侧只保留摘要（status / content.size / mimeType），响应体文本不落库
 * （最小快照不含响应体，重放只消费请求侧）。
 *
 * @param text HAR 文件文本（通常来自 File.text()）
 */
export function parseHarImport(text: string): HarImportResult {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, error: "HAR 文件内容为空" };
  }

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { ok: false, error: "文件内容不是有效的 JSON" };
  }
  if (!isPlainObject(root) || !isPlainObject(root["log"])) {
    return { ok: false, error: "HAR 格式不正确：缺少 log 对象" };
  }
  const rawEntries = (root["log"] as Record<string, unknown>)["entries"];
  if (!Array.isArray(rawEntries)) {
    return { ok: false, error: "HAR 格式不正确：缺少 log.entries 数组" };
  }

  const items: ImportRequestItem[] = [];
  const skipped: ImportSkipped[] = [];
  for (let index = 0; index < rawEntries.length; index++) {
    const raw = rawEntries[index];
    if (!isPlainObject(raw)) {
      skipped.push({ index, reason: "条目不是对象" });
      continue;
    }
    const request = raw["request"];
    if (!isPlainObject(request)) {
      skipped.push({ index, reason: "缺少 request 对象" });
      continue;
    }
    const method = readString(request["method"]);
    const url = readString(request["url"]);
    if (method === undefined || method === "" || url === undefined || url === "") {
      skipped.push({ index, reason: "缺少 request.method 或 request.url" });
      continue;
    }
    const response = isPlainObject(raw["response"]) ? raw["response"] : {};
    const content = isPlainObject(response["content"]) ? response["content"] : {};
    items.push(
      buildItem({
        method,
        url,
        headers: normalizePairs(request["headers"]),
        queryString: normalizePairs(request["queryString"]),
        cookies: normalizeCookiePairs(request["cookies"]),
        postData: normalizePostData(request["postData"]),
        startedDateTime: readString(raw["startedDateTime"]),
        time: readFiniteNumber(raw["time"]),
        status: readFiniteNumber(response["status"]),
        statusText: readString(response["statusText"]),
        responseSize: readFiniteNumber(content["size"]),
        responseMimeType: readString(content["mimeType"]),
      }),
    );
  }

  return { ok: true, items, skipped };
}

/* ------------------------------------------------------------------ *
 * Postman Collection v2.1 解析
 * ------------------------------------------------------------------ */

export type PostmanImportResult =
  | { ok: true; items: ImportRequestItem[]; skipped: ImportSkipped[] }
  | { ok: false; error: string };

/** Postman 表单字段（urlencoded / formdata / cookie / query 共用的读取形状）。 */
interface PostmanFormEntry {
  name: string;
  value: string;
}

/** 读取 Postman 键值项数组（key/value；跳过 disabled 与非法项）。 */
function readPostmanPairs(value: unknown): PostmanFormEntry[] {
  if (!Array.isArray(value)) return [];
  const pairs: PostmanFormEntry[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    if (item["disabled"] === true) continue;
    const key = readString(item["key"]);
    if (key === undefined || key === "") continue;
    pairs.push({ name: key, value: readString(item["value"]) ?? "" });
  }
  return pairs;
}

/** Postman raw body 的 language 选项 → MIME（未知回退调用方提供的兜底）。 */
const RAW_LANGUAGE_MIME: Record<string, string> = {
  json: "application/json",
  javascript: "application/javascript",
  html: "text/html",
  xml: "application/xml",
};

/** multipart 分隔边界（导入产物固定同一边界，重放组装语义一致即可）。 */
const MULTIPART_BOUNDARY = "----ProxyCrabImportBoundary";

/** 把表单字段组装为 multipart/form-data 文本体（文件字段由上层跳过）。 */
function buildMultipartBody(fields: readonly PostmanFormEntry[]): string {
  const parts = fields.map(
    (field) =>
      `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
  );
  return `${parts.join("")}--${MULTIPART_BOUNDARY}--\r\n`;
}

/** urlencoded 字段 → 请求体原文（name 不编码，值 encodeURIComponent，& 拼接）。 */
function buildUrlencodedBody(fields: readonly PostmanFormEntry[]): string {
  return fields.map((field) => `${field.name}=${encodeURIComponent(field.value)}`).join("&");
}

/** 归一化 Postman body → 最小 postData（不支持的形态返回 undefined）。 */
function readPostmanBody(
  body: Record<string, unknown>,
  contentType: string | undefined,
): RequestLibraryHarPostData | undefined {
  const mode = readString(body["mode"]);
  if (mode === "raw" && typeof body["raw"] === "string") {
    const options = isPlainObject(body["options"]) ? (body["options"] as Record<string, unknown>) : {};
    const rawOptions = isPlainObject(options["raw"]) ? (options["raw"] as Record<string, unknown>) : {};
    const language = readString(rawOptions["language"]);
    return {
      mimeType: RAW_LANGUAGE_MIME[language ?? ""] ?? contentType ?? "text/plain",
      text: truncateUtf8Safe(body["raw"], IMPORT_BODY_MAX_BYTES).text,
    };
  }
  if (mode === "urlencoded") {
    const fields = readPostmanPairs(body["urlencoded"]);
    if (fields.length === 0) return undefined;
    return {
      mimeType: "application/x-www-form-urlencoded",
      params: fields.map((field) => ({ name: field.name, value: field.value })),
      text: buildUrlencodedBody(fields),
    };
  }
  if (mode === "formdata") {
    // 文件字段（src 指向客户端本地文件）无法读取，跳过；文本字段组装为 multipart 体。
    const all = Array.isArray(body["formdata"]) ? body["formdata"] : [];
    const fields: PostmanFormEntry[] = [];
    for (const item of all) {
      if (!isPlainObject(item) || item["disabled"] === true) continue;
      const key = readString(item["key"]);
      if (key === undefined || key === "") continue;
      if (item["type"] === "file" || item["src"] !== undefined) continue;
      fields.push({ name: key, value: readString(item["value"]) ?? "" });
    }
    if (fields.length === 0) return undefined;
    return {
      mimeType: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      params: fields.map((field) => ({ name: field.name, value: field.value })),
      text: truncateUtf8Safe(buildMultipartBody(fields), IMPORT_BODY_MAX_BYTES).text,
    };
  }
  if (mode === "graphql" && isPlainObject(body["graphql"])) {
    const graphql = body["graphql"] as Record<string, unknown>;
    const payload = JSON.stringify({
      query: readString(graphql["query"]) ?? "",
      variables: graphql["variables"] ?? {},
    });
    return { mimeType: "application/json", text: truncateUtf8Safe(payload, IMPORT_BODY_MAX_BYTES).text };
  }
  return undefined;
}

/** 归一化 Postman URL（string 或 UrlObject）→ 原文 URL + queryString。 */
function readPostmanUrl(value: unknown): { url: string; queryString: RequestLibraryHarPair[] } | null {
  if (typeof value === "string") {
    const queryIndex = value.indexOf("?");
    const query: RequestLibraryHarPair[] =
      queryIndex === -1
        ? []
        : value
            .slice(queryIndex + 1)
            .split("&")
            .filter((pair) => pair !== "")
            .map((pair) => {
              const eq = pair.indexOf("=");
              return {
                name: eq === -1 ? pair : pair.slice(0, eq),
                value: eq === -1 ? "" : pair.slice(eq + 1),
              };
            });
    return { url: value, queryString: query };
  }
  if (!isPlainObject(value)) return null;
  const raw = readString(value["raw"]);
  if (raw !== undefined && raw !== "") return readPostmanUrl(raw);
  // 无 raw 时按 protocol + host + path 拼接（host / path 为分段数组）。
  const segments = (part: unknown): string[] =>
    Array.isArray(part) ? part.filter((item): item is string => typeof item === "string") : [];
  const protocol = readString(value["protocol"]) ?? "https";
  const host = segments(value["host"]).join(".");
  const path = segments(value["path"]).join("/");
  if (host === "") return null;
  const suffix = path === "" ? "" : `/${path}`;
  return {
    url: `${protocol}://${host}${suffix}`,
    queryString: readPostmanPairs(value["query"]).map((pair) => ({
      name: pair.name,
      value: pair.value,
    })),
  };
}

/**
 * 解析 Postman Collection v2.1 JSON 文本（纯函数，永不抛出）。
 *
 * 只导入请求（item.request），目录（folder）递归展开；示例响应不导入（最小快照
 * 响应侧仅摘要）。请求体支持 raw / urlencoded / formdata（文件字段跳过，文本字段
 * 组装 multipart 体）/ graphql；mode=file 无请求体。`{{variable}}` 模板占位保持
 * 原样（重放时可经环境变量替换）。
 *
 * @param text Collection 文件文本（通常来自 File.text()）
 */
export function parsePostmanImport(text: string): PostmanImportResult {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, error: "Postman Collection 内容为空" };
  }

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { ok: false, error: "文件内容不是有效的 JSON" };
  }
  if (!isPlainObject(root) || !Array.isArray(root["item"])) {
    return { ok: false, error: "Postman Collection 格式不正确：缺少 item 数组" };
  }

  const items: ImportRequestItem[] = [];
  const skipped: ImportSkipped[] = [];
  let order = 0;

  const walk = (nodes: unknown[], depth: number): void => {
    if (depth > 16) return; // 防御异常嵌套
    for (const node of nodes) {
      if (!isPlainObject(node)) continue;
      if (Array.isArray(node["item"])) {
        walk(node["item"], depth + 1);
        continue;
      }
      const index = order++;
      const request = node["request"];
      if (!isPlainObject(request)) {
        skipped.push({ index, reason: "条目没有 request 描述" });
        continue;
      }
      const parsedUrl = readPostmanUrl(request["url"]);
      if (parsedUrl === null || parsedUrl.url === "") {
        skipped.push({ index, reason: "缺少可解析的 request.url" });
        continue;
      }
      const headers = readPostmanPairs(request["header"]).map((pair) => ({
        name: pair.name,
        value: pair.value,
      }));
      const contentType = headers.find(
        (header) => header.name.toLowerCase() === "content-type",
      )?.value;
      const cookies = readPostmanPairs(request["cookie"]).map((pair) => ({
        name: pair.name,
        value: pair.value,
      }));
      const body = isPlainObject(request["body"])
        ? (request["body"] as Record<string, unknown>)
        : undefined;
      items.push(
        buildItem({
          method: readString(request["method"]) ?? "GET",
          url: parsedUrl.url,
          headers,
          queryString: parsedUrl.queryString,
          cookies: cookies.length > 0 ? cookies : undefined,
          postData: body === undefined ? undefined : readPostmanBody(body, contentType),
        }),
      );
    }
  };

  walk(root["item"], 0);
  return { ok: true, items, skipped };
}
