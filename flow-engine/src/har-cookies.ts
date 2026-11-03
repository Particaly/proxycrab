/**
 * HAR 请求侧 Cookie 归一化（M12-T3）。
 *
 * 背景：两条捕获链路产出的 HAR entry 形状不完全一致——
 *   - chrome.devtools.network 的 HAR entry 由 Chrome 产出，通常带结构化
 *     `request.cookies`（name / value 数组）；
 *   - chrome.debugger（CDP Network 域）只给合并后的 `Cookie` 请求头文本
 *     （`a=1; b=2`），没有结构化数组（见 background/debugger-protocol.ts）。
 *
 * 节点配置面板的「Cookie 快照」与重放注入统一从 `request.cookies` 取值
 * （engine/header-fidelity.ts 的 extractSnapshotCookie 会回退 Cookie 头，
 * 但结构化数组是更稳的主来源）。本模块提供纯函数把 Cookie 头解析为结构化
 * 数组、并把「缺结构化 cookies 但有 Cookie 头」的 entry 补齐为同一形状，
 * 两条捕获链路（panel 入库组装 / 后台 debugger 转换）共用。
 *
 * 纯函数、零环境依赖（不依赖存储 / 网络 / chrome API），node 可直接单测。
 */

import type { HarCookie, HarEntry } from "./types";

/** Cookie 头名（大小写不敏感匹配用） */
const COOKIE_HEADER_NAME = "cookie";

/**
 * 解析 Cookie 请求头文本为 HAR 结构化 cookies（纯函数）。
 *
 * 规则：按 `;` 分段，仅保留含 `=` 的段（名称非空）；值取首个 `=` 之后原文并
 * trim。空段忽略；整体为空串时返回空数组（调用方按需决定是否写字段）。
 *
 * @param headerValue Cookie 头原文（如 `a=1; b=2`）
 * @returns 结构化 HarCookie 数组（可能为空）
 */
export function parseCookieHeader(headerValue: string): HarCookie[] {
  const cookies: HarCookie[] = [];
  for (const part of headerValue.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    cookies.push({
      name: trimmed.slice(0, separator).trim(),
      value: trimmed.slice(separator + 1).trim(),
    });
  }
  return cookies;
}

/**
 * 补齐 entry 的请求侧结构化 cookies（纯函数，返回新 entry；无改动时返回原引用）。
 *
 * 仅当 `request.cookies` 缺失 / 非数组，且请求头里存在非空 Cookie 头时才补齐
 * （已带结构化数组的 entry 原样返回——Chrome 的 devtools HAR 即属此类，不覆盖
 * 其更完整的信息）。
 *
 * @param entry HAR 条目（不改动入参）
 * @returns 补齐后的 entry；无需补齐时为原引用
 */
export function withNormalizedRequestCookies(entry: HarEntry): HarEntry {
  if (Array.isArray(entry.request.cookies)) return entry;
  const header = entry.request.headers.find(
    (item) => item.name.toLowerCase() === COOKIE_HEADER_NAME,
  );
  if (header === undefined || header.value.trim() === "") return entry;
  const cookies = parseCookieHeader(header.value);
  if (cookies.length === 0) return entry;
  return { ...entry, request: { ...entry.request, cookies } };
}
