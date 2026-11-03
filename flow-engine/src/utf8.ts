/**
 * UTF-8 编解码纯函数（宿主注入点替换）。
 *
 * 归档（@ 485fa00）的 run-record / run-graph-snapshot 用 TextEncoder /
 * TextDecoder 计量与截断 UTF-8 字节；QuickJS 无 TextEncoder/TextDecoder 全局，
 * 故按规格自实现等价纯函数（宿主桥不注入编码器——算法确定性、零环境依赖）。
 *
 * 语义对齐 TextEncoder / TextDecoder：
 *   - encode 按 Unicode 码点输出 1~4 字节；孤立代理对（不成对的 high/low
 *     surrogate）替换为 U+FFFD（EF BF BD），与 WHATWG Encoding 一致；
 *   - decode 按 UTF-8 解码；非法序列以 U+FFFD 替换继续（非抛错模式）；
 *   - cutToUtf8Bytes 在字节预算内回退到字符边界（不切半），与归档
 *     run-record 的同名内部函数逐字节同口径。
 *
 * 快路径：宿主已有 TextEncoder / TextDecoder（Node / 浏览器单测环境）时直接
 * 取用（原生实现远快于逐码点循环——run-record 的降级测试构造 MB 级载荷）；
 * QuickJS 无该全局时走下方纯 JS 实现。两条路径语义一致（快路径同样是
 * WHATWG Encoding 行为）。
 */

/** 宿主原生编码器（可用性惰性检测一次；QuickJS 下恒为 undefined） */
const NATIVE_ENCODER =
  typeof (globalThis as { TextEncoder?: new () => { encode(text: string): Uint8Array } })
    .TextEncoder === "function"
    ? new (
        globalThis as { TextEncoder: new () => { encode(text: string): Uint8Array } }
      ).TextEncoder()
    : undefined;

/** 宿主原生解码器（同上） */
const NATIVE_DECODER =
  typeof (globalThis as { TextDecoder?: new () => { decode(bytes: Uint8Array): string } })
    .TextDecoder === "function"
    ? new (
        globalThis as { TextDecoder: new () => { decode(bytes: Uint8Array): string } }
      ).TextDecoder()
    : undefined;

/** 字符串的 UTF-8 字节数（中文等多字节字符按实际字节数计，不按字符数） */
export function utf8ByteLength(text: string): number {
  if (NATIVE_ENCODER !== undefined) return NATIVE_ENCODER.encode(text).length;
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0x10000) bytes += 4;
    else bytes += 3;
  }
  return bytes;
}

/** 把字符串编码为 UTF-8 字节（TextEncoder().encode 等价，孤立代理替换为 U+FFFD） */
export function utf8Encode(text: string): Uint8Array {
  if (NATIVE_ENCODER !== undefined) return NATIVE_ENCODER.encode(text);
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code <= 0x7f) {
      out.push(code);
    } else if (code <= 0x7ff) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0x10000) {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else if (code >= 0xd800 && code <= 0xdfff) {
      // for...of 已按码点迭代，正常不会走到；防御孤立代理（理论上不可达）
      out.push(0xef, 0xbf, 0xbd);
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

/** 把 UTF-8 字节解码为字符串（TextDecoder 等价；非法序列以 U+FFFD 替换） */
export function utf8Decode(bytes: Uint8Array): string {
  if (NATIVE_DECODER !== undefined) return NATIVE_DECODER.decode(bytes);
  let text = "";
  let index = 0;
  const total = bytes.length;
  while (index < total) {
    const byte = bytes[index] as number;
    let code: number;
    let length: number;
    if (byte < 0x80) {
      code = byte;
      length = 1;
    } else if (
      (byte & 0xe0) === 0xc0 &&
      index + 1 < total &&
      ((bytes[index + 1] as number) & 0xc0) === 0x80
    ) {
      code = ((byte & 0x1f) << 6) | ((bytes[index + 1] as number) & 0x3f);
      length = 2;
    } else if (
      (byte & 0xf0) === 0xe0 &&
      index + 2 < total &&
      ((bytes[index + 1] as number) & 0xc0) === 0x80 &&
      ((bytes[index + 2] as number) & 0xc0) === 0x80
    ) {
      code =
        ((byte & 0x0f) << 12) |
        (((bytes[index + 1] as number) & 0x3f) << 6) |
        ((bytes[index + 2] as number) & 0x3f);
      length = 3;
    } else if (
      (byte & 0xf8) === 0xf0 &&
      index + 3 < total &&
      ((bytes[index + 1] as number) & 0xc0) === 0x80 &&
      ((bytes[index + 2] as number) & 0xc0) === 0x80 &&
      ((bytes[index + 3] as number) & 0xc0) === 0x80
    ) {
      code =
        ((byte & 0x07) << 18) |
        (((bytes[index + 1] as number) & 0x3f) << 12) |
        (((bytes[index + 2] as number) & 0x3f) << 6) |
        ((bytes[index + 3] as number) & 0x3f);
      length = 4;
    } else {
      // 非法序列（坏首字节 / 截断的多字节序列）：替换 U+FFFD 后前进 1 字节
      code = 0xfffd;
      length = 1;
    }
    // UTF-16 编码：BMP 直接 String.fromCharCode；增补平面拼代理对
    if (code >= 0x10000) {
      const offset = code - 0x10000;
      text += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
    } else {
      text += String.fromCharCode(code);
    }
    index += length;
  }
  return text;
}

/**
 * 把字符串按 UTF-8 字节数截断到 budget 内（多字节字符不切半，切点回退到
 * 字符边界，避免产生非法 UTF-8 序列）。与归档 run-record 同名内部函数同口径。
 */
export function cutToUtf8Bytes(text: string, budget: number): string {
  if (budget <= 0 || text.length === 0) return "";
  const bytes = utf8Encode(text);
  if (bytes.length <= budget) return text;
  let end = budget;
  // 回退跳过 UTF-8 连续字节（0b10xxxxxx），停在多字节字符的起始字节上
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end--;
  return utf8Decode(bytes.subarray(0, end));
}
