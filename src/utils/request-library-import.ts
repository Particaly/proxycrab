import type {
  RequestLibraryHarEntry,
  RequestLibraryHarPair,
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
 * 体积策略：请求体 / 响应体超过 IMPORT_BODY_MAX_BYTES（64 KiB，对齐
 * request_library.rs 的 REQUEST_BODY_INLINE_LIMIT）时按 UTF-8 字符边界截断，
 * 保留原文大小字段不丢元信息。
 *
 * 落库组装：buildImportSnapshot 把单条 entry 包成 {log:{version,creator,entries}}
 * 快照（creator 与后端 HAR_CREATOR 一致）；name 省略时由后端按
 * `METHOD host+path` 默认命名并做数字后缀去重，前端仅在预览时用
 * buildDefaultRequestName 生成同名规则文案。
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
