/**
 * 请求库导出的文件保存触发（ReqFlow 复刻 Task 9；对应上游 request-export-download.ts）。
 *
 * 下载胶水层：把 request-export.ts 的纯字符串产物落到用户文件——HAR 下载
 * .har、Postman 下载 .postman_collection.json（二者均为 JSON 文本）。桌面端与
 * 浏览器端统一走既有 backend.saveFile 通路（Tauri 弹保存对话框，用户取消时
 * 返回 null；浏览器后端在 markAsFinish 时触发下载），与 HarExportWindow 等
 * 既有导出窗一致（经 saveBytesFile 的 append → markAsFinish 生命周期）。
 * 复制到剪贴板的格式（cURL / fetch / axios / Python）不走本模块。
 */

import type { Backend } from "../api/backend";
import { saveBytesFile } from "../api/save-file";
import type { RequestLibraryEntry } from "../api/types";
import { buildRequestExportFileName, exportRequestSnapshot } from "./request-export";
import type { RequestExportFormatId } from "./request-export";

/** 下载型导出格式（copy 型走剪贴板，不经本模块） */
export type RequestDownloadFormat = Extract<RequestExportFormatId, "har" | "postman">;

/** 下载型格式 → 文件扩展名（Postman 用官方约定的 .postman_collection.json） */
const DOWNLOAD_EXTENSIONS: Record<RequestDownloadFormat, string> = {
  har: "har",
  postman: "postman_collection.json",
};

/**
 * 生成导出内容并经既有 saveFile 通路保存。
 *
 * @param backend 提供 saveFile 能力的后端
 * @param entry 待导出的请求库条目
 * @param format 下载型格式（'har' | 'postman'）
 * @param exportedAt 导出时间戳（Unix 毫秒；文件名日期按本地时区取 YYYY-MM-DD）
 * @returns true = 已发起保存；false = 用户取消（saveFile 返回 null）
 */
export async function downloadRequestExport(
  backend: Pick<Backend, "saveFile">,
  entry: RequestLibraryEntry,
  format: RequestDownloadFormat,
  exportedAt: number = Date.now(),
): Promise<boolean> {
  const content = exportRequestSnapshot(entry, format);
  const filename = buildRequestExportFileName(entry.name, exportedAt, DOWNLOAD_EXTENSIONS[format]);
  return saveBytesFile(backend, filename, new TextEncoder().encode(content));
}
