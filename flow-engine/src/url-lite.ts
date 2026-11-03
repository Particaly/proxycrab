/**
 * 极简 URL 解析（宿主注入点替换，QuickJS 无 URL / URLSearchParams 全局）。
 *
 * 归档（@ 485fa00）的 header-fidelity（origin 提取）与 dependency-inference
 * （pathname / search / hash 区间定位、查询参数枚举）依赖 WHATWG URL 与
 * URLSearchParams。载荷运行在 QuickJS 内，故按需自实现**常用子集**并披露边界：
 *
 * 支持：`<scheme>://[userinfo@]host[:port][/path][?query][#fragment]` 形态的
 * 绝对 URL（scheme 不限大小写；host 归一小写；http 80 / https 443 / ws 80 /
 * wss 443 / ftp 21 为缺省端口、不落 port 字段；origin 对非特殊 scheme /
 * file 返回 'null'，与 WHATWG 的 opaque origin 一致）。
 *
 * searchParams 按 application/x-www-form-urlencoded 解析：'+' → 空格、%XX
 * 解码（非法 % 序列按原样保留——与 WHATWG 一致，不抛错；多字节 % 序列按
 * UTF-8 组装还原）；同名参数多条目全部保留（entries 逐一产出），get 取首个。
 *
 * 不支持（引擎路径未用到，出现即按解析失败处理）：相对 URL（无 base 解析）、
 * 非法端口（非数字 / 超 65535）、IPv6 括号缺失、国际化域名（IDN 不做 punycode
 * 转换，host 按原文小写保留）、pathname 的百分号补编码（保留原文——引擎只做
 * 区间定位与整段匹配，不做逐字规范化断言）。
 *
 * 解析失败（非绝对 URL / 非法端口 / 空 host）返回 null，调用方与归档
 * `new URL` 抛错的 catch 路径同一处理。
 */

/** 查询参数条目（searchParams 的键值对） */
export type LiteUrlParamEntry = [name: string, value: string];

/** searchParams 子集：依赖推断与测试消费的两个成员 */
export interface LiteUrlSearchParams {
  /** 全部参数条目（按出现序；同名多条目逐一产出） */
  entries(): IterableIterator<LiteUrlParamEntry>;
  /** 首个同名参数值；不存在返回 undefined */
  get(name: string): string | undefined;
}

/** 解析产物：引擎消费的 URL 字段子集 */
export interface LiteUrl {
  /** 协议（含尾冒号，小写，如 'https:'） */
  protocol: string;
  /** host（小写；含非缺省端口，如 'api.example.com:8443'） */
  host: string;
  /** host 不含端口（小写） */
  hostname: string;
  /** 端口（缺省端口 / 未写端口为空串） */
  port: string;
  /** origin（特殊 scheme 为 scheme://host[:port]；非特殊 scheme / file 为 'null'） */
  origin: string;
  /** 路径（恒以 / 开头；无路径时为 '/'） */
  pathname: string;
  /** 查询串（含前导 ?；无查询为空串） */
  search: string;
  /** 片段（含前导 #；无片段为空串） */
  hash: string;
  /** 查询参数（urlencoded 解析语义，见文件头） */
  searchParams: LiteUrlSearchParams;
}

/** 各 scheme 的缺省端口（与 WHATWG special scheme 表一致） */
const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "ws:": "80",
  "wss:": "443",
  "ftp:": "21",
};

/** origin 参与特殊 scheme 表（file 的 origin 亦为 opaque 'null'） */
const SPECIAL_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

/**
 * application/x-www-form-urlencoded 的百分号解码（不抛错）：
 * '+' → 空格；%XX 十六进制解码（多字节序列按 UTF-8 组装，非法字节替换
 * U+FFFD）；非法 % 序列按原字面保留（与 WHATWG 一致）。
 */
function urlDecodePercent(text: string): string {
  if (!text.includes("%") && !text.includes("+")) return text;
  let out = "";
  let utf8Buffer: number[] = [];
  /** 把累积的 UTF-8 字节序列还原为字符后清空缓冲（单字节序列直出） */
  const flushUtf8 = (): void => {
    if (utf8Buffer.length === 0) return;
    const buffer = utf8Buffer;
    utf8Buffer = [];
    let index = 0;
    while (index < buffer.length) {
      const byte = buffer[index] as number;
      let code: number;
      let length: number;
      if (byte < 0x80) {
        code = byte;
        length = 1;
      } else if (
        (byte & 0xe0) === 0xc0 &&
        index + 1 < buffer.length &&
        ((buffer[index + 1] as number) & 0xc0) === 0x80
      ) {
        code = ((byte & 0x1f) << 6) | ((buffer[index + 1] as number) & 0x3f);
        length = 2;
      } else if (
        (byte & 0xf0) === 0xe0 &&
        index + 2 < buffer.length &&
        ((buffer[index + 1] as number) & 0xc0) === 0x80 &&
        ((buffer[index + 2] as number) & 0xc0) === 0x80
      ) {
        code =
          ((byte & 0x0f) << 12) |
          (((buffer[index + 1] as number) & 0x3f) << 6) |
          ((buffer[index + 2] as number) & 0x3f);
        length = 3;
      } else if (
        (byte & 0xf8) === 0xf0 &&
        index + 3 < buffer.length &&
        ((buffer[index + 1] as number) & 0xc0) === 0x80 &&
        ((buffer[index + 2] as number) & 0xc0) === 0x80 &&
        ((buffer[index + 3] as number) & 0xc0) === 0x80
      ) {
        code =
          ((byte & 0x07) << 18) |
          (((buffer[index + 1] as number) & 0x3f) << 12) |
          (((buffer[index + 2] as number) & 0x3f) << 6) |
          ((buffer[index + 3] as number) & 0x3f);
        length = 4;
      } else {
        // 非法 / 截断序列：替换 U+FFFD 后前进 1 字节
        code = 0xfffd;
        length = 1;
      }
      if (code >= 0x10000) {
        const offset = code - 0x10000;
        out += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
      } else {
        out += String.fromCharCode(code);
      }
      index += length;
    }
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (char === "+") {
      flushUtf8();
      out += " ";
    } else if (char === "%") {
      const hex = text.slice(index + 1, index + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        utf8Buffer.push(Number.parseInt(hex, 16));
        index += 2;
      } else {
        flushUtf8();
        out += "%";
      }
    } else {
      flushUtf8();
      out += char;
    }
  }
  flushUtf8();
  return out;
}

/**
 * 解析绝对 URL（纯函数；子集边界见文件头）。
 *
 * @param raw 原始 URL 文本（首尾 C0 控制字符与空格、内嵌 tab/换行按 WHATWG 容忍剥离）
 * @returns 解析产物；非绝对 URL / 非法端口 / 空 host 等解析失败返回 null
 */
export function parseUrl(raw: string): LiteUrl | null {
  // WHATWG 预处理：去首尾 C0 控制与空格、剔除内嵌 tab / LF / CR
  const text = raw
    .replace(/^[\u0000-\u0020]+/, "")
    .replace(/[\u0000-\u0020]+$/, "")
    .replace(/[\t\n\r]/g, "");
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(text);
  if (schemeMatch === null) return null;
  const protocol = `${(schemeMatch[1] as string).toLowerCase()}:`;
  const isSpecial = SPECIAL_SCHEMES.has(protocol);

  // authority = protocol:// 之后到 path/query/hash 起点的区间
  let authorityEnd = text.length;
  for (let index = schemeMatch[0].length; index < text.length; index++) {
    const char = text[index];
    if (char === "/" || char === "?" || char === "#") {
      authorityEnd = index;
      break;
    }
  }
  let authority = text.slice(schemeMatch[0].length, authorityEnd);

  // hash / search / pathname 区间（自 authorityEnd 起）
  const rest = text.slice(authorityEnd);
  const hashAt = rest.indexOf("#");
  const hash = hashAt === -1 ? "" : rest.slice(hashAt);
  const beforeHash = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const searchAt = beforeHash.indexOf("?");
  const search = searchAt === -1 ? "" : beforeHash.slice(searchAt);
  const rawPathname = searchAt === -1 ? beforeHash : beforeHash.slice(0, searchAt);
  const pathname = rawPathname === "" ? "/" : rawPathname;

  // userinfo 剥离（引擎不消费，仅去除以免污染 host 解析）
  const userinfoAt = authority.lastIndexOf("@");
  if (userinfoAt !== -1) authority = authority.slice(userinfoAt + 1);

  // host:port（IPv6 字面量 [..]:port 按括号保护）
  let hostname = "";
  let port = "";
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return null;
    hostname = authority.slice(0, close + 1);
    const remainder = authority.slice(close + 1);
    if (remainder !== "") {
      if (!remainder.startsWith(":")) return null;
      port = remainder.slice(1);
    }
  } else {
    const colonAt = authority.lastIndexOf(":");
    if (colonAt === -1) {
      hostname = authority;
    } else {
      hostname = authority.slice(0, colonAt);
      port = authority.slice(colonAt + 1);
    }
  }
  if (hostname === "") return null;
  hostname = hostname.toLowerCase();
  if (port !== "") {
    if (!/^\d+$/.test(port)) return null;
    const numeric = Number.parseInt(port, 10);
    if (numeric > 65535) return null;
    port = String(numeric);
  }
  const defaultPort = DEFAULT_PORTS[protocol];
  const effectivePort = port !== "" && port !== defaultPort ? port : "";
  const origin = isSpecial
    ? `${protocol}//${hostname}${effectivePort !== "" ? `:${effectivePort}` : ""}`
    : "null";

  const entries: LiteUrlParamEntry[] = [];
  if (search.length > 1) {
    for (const pair of search.slice(1).split("&")) {
      if (pair === "") continue;
      const eq = pair.indexOf("=");
      if (eq === -1) {
        entries.push([urlDecodePercent(pair), ""]);
      } else {
        entries.push([urlDecodePercent(pair.slice(0, eq)), urlDecodePercent(pair.slice(eq + 1))]);
      }
    }
  }

  const searchParams: LiteUrlSearchParams = {
    entries(): IterableIterator<LiteUrlParamEntry> {
      return entries[Symbol.iterator]();
    },
    get(name: string): string | undefined {
      return entries.find(([entryName]) => entryName === name)?.[1];
    },
  };

  return {
    protocol,
    host: `${hostname}${effectivePort !== "" ? `:${effectivePort}` : ""}`,
    hostname,
    port: effectivePort,
    origin,
    pathname,
    search,
    hash,
    searchParams,
  };
}
