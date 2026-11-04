/**
 * 请求库导出的纯函数生成器（ReqFlow 复刻 Task 9；移植上游 request-export.ts）。
 *
 * 输入请求库条目（RequestLibraryEntry，快照恒为单 entry，取 log.entries[0] 为
 * 请求描述），输出六种常用格式的字符串；无 Vue / store / DOM 依赖，可被 vitest
 * node 环境直测。与请求库导入（request-library-import.ts，Task 8）同一分层约定：
 * 解析 / 生成全部在本模块，下载动作在 request-export-download.ts，UI 编排在
 * RequestLibraryWindow.vue 的独立「导出」区块。
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
  /** 交付方式：copy = 生成后复制到剪贴板；download = 生成后保存/下载文件 */
  kind: "copy" | "download";
  /** 文件扩展名（kind='download' 时使用；copy 格式为 null） */
  extension: string | null;
}

/** 六种导出格式清单（顺序即 UI 展示顺序：三种数据交换格式 + 三种代码生成） */
export const REQUEST_EXPORT_FORMATS: readonly RequestExportFormat[] = [
  { id: "curl", kind: "copy", extension: null },
  { id: "har", kind: "download", extension: "har" },
  { id: "postman", kind: "download", extension: "postman_collection.json" },
  { id: "fetch", kind: "copy", extension: null },
  { id: "axios", kind: "copy", extension: null },
  { id: "python", kind: "copy", extension: null },
];

/* ------------------------------------------------------------------ *
 * 共用：entry 解析与请求体规范化
 * ------------------------------------------------------------------ */

/** 快照第一条 entry；log.entries 为空时返回 null（调用方按空产物处理）。 */
function snapshotEntry(entry: RequestLibraryEntry): RequestLibraryEntry["har"]["log"]["entries"][0] | null {
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
