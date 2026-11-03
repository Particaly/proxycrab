/**
 * Base64 编解码纯函数（宿主注入点替换）。
 *
 * 归档（@ 485fa00）的 replay.ts 用浏览器 atob 解码二进制请求体（HAR
 * postData.encoding='base64'）。QuickJS 无 atob / btoa，故按规格自实现；
 * 宿主桥不注入编解码器——算法确定性、零环境依赖。
 *
 * 载荷侧约定：`decodeBase64` 与 atob 同语义（输入含非法 base64 字符即抛错，
 * 由调用方按「退化为原文文本」降级）；`encodeBase64` 供 httpReplay runner 把
 * 二进制请求体编码进 host.replay 的 JSON 载荷（bodyBase64 字段——JSON 无法
 * 直接携带 Uint8Array，宿主侧解码后按原始字节发送）。
 */

/** 标准 base64 字符表（RFC 4648，含 / 与 +） */
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 字符 → 6bit 值的反查表（'=' 与表外字符为 -1，解码时抛错） */
const BASE64_LOOKUP: Record<string, number> = {};
for (let index = 0; index < BASE64_ALPHABET.length; index++) {
  BASE64_LOOKUP[BASE64_ALPHABET[index] as string] = index;
}

/**
 * 解码 base64 文本为字节（atob 等价）。
 *
 * 语义：忽略空白字符（atob 容忍换行）；'=' 仅允许作为结尾填充；遇表外字符
 * 抛 Error（调用方 replay.ts 按非法 base64 退化为原文发送，与归档一致）。
 * 输入长度（去填充后）非 4 的倍数同样抛错。
 */
export function decodeBase64(text: string): Uint8Array {
  // 预处理：剔除空白；截掉填充段后不允许再出现 '='
  let body = "";
  let padding = 0;
  for (const char of text) {
    if (char === "=") {
      padding += 1;
      continue;
    }
    if (char === " " || char === "\n" || char === "\r" || char === "\t") continue;
    if (padding > 0) throw new Error("InvalidCharacterError: base64 填充符后存在数据字符");
    if (BASE64_LOOKUP[char] === undefined) {
      throw new Error(`InvalidCharacterError: 非法 base64 字符「${char}」`);
    }
    body += char;
  }
  if (padding > 2) throw new Error("InvalidCharacterError: base64 填充符过多");
  const remainder = body.length % 4;
  if (remainder === 1) throw new Error("InvalidCharacterError: base64 长度非法（余 1 字符）");
  // 填充与长度的一致性按数据长度判断（余 2 → '=='、余 3 → '='）；不苛求填充
  // 字符恰好齐备（atob 容忍缺省填充），只拒绝「数据对齐后仍有多余填充」。
  // 余 2 补 'AA'、余 3 补 'A'：末组按位数取值（补位字符 'A' 值为 0，多余 bit
  // 恒为 0，与 atob 一致地忽略）
  const normalized = body + (remainder === 2 ? "AA" : remainder === 3 ? "A" : "");

  const bytes: number[] = [];
  for (let index = 0; index < normalized.length; index += 4) {
    const n =
      ((BASE64_LOOKUP[normalized[index] as string] as number) << 18) |
      ((BASE64_LOOKUP[normalized[index + 1] as string] as number) << 12) |
      ((BASE64_LOOKUP[normalized[index + 2] as string] as number) << 6) |
      (BASE64_LOOKUP[normalized[index + 3] as string] as number);
    if (remainder !== 0 && index + 4 === normalized.length) {
      // 末组按真实字符数取字节（余 2 → 1 字节，余 3 → 2 字节）
      if (remainder === 2) bytes.push((n >> 16) & 0xff);
      else {
        bytes.push((n >> 16) & 0xff, (n >> 8) & 0xff);
      }
      break;
    }
    bytes.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  return Uint8Array.from(bytes);
}

/** 把字节编码为 base64 文本（btoa 等价，RFC 4648 带填充） */
export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  const total = bytes.length;
  for (let index = 0; index < total; index += 3) {
    const b0 = bytes[index] as number;
    const b1 = index + 1 < total ? (bytes[index + 1] as number) : 0;
    const b2 = index + 2 < total ? (bytes[index + 2] as number) : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_ALPHABET[(triple >> 18) & 0x3f];
    out += BASE64_ALPHABET[(triple >> 12) & 0x3f];
    out += index + 1 < total ? BASE64_ALPHABET[(triple >> 6) & 0x3f] : "=";
    out += index + 2 < total ? BASE64_ALPHABET[triple & 0x3f] : "=";
  }
  return out;
}
