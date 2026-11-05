import { computed, ref } from "vue";
import { getBackend } from "../api/runtime-backend";
import type { HttpApiChange, RequestLibraryEntry, RequestLibrarySource } from "../api/types";
import { appStore, reportError } from "./app";
import { confirmDialog, openDropdownMenu } from "./dialog";
import { copyText as writeClipboardText } from "../utils/clipboard";
import {
  REQUEST_EXPORT_FORMATS,
  exportRequestSnapshot,
  type RequestExportFormatId,
} from "../utils/request-export";
import { downloadRequestExport } from "../utils/request-export-download";
import {
  buildRequestGroups,
  requestMethod,
  requestUrl,
  type RequestGroupKey,
  type RequestSortKey,
} from "../components/request-library/request-library-view";
// 导入：解析与去重均为纯函数；落库复用既有 POST /api/request-library。
import {
  buildImportRequest,
  filterDuplicateItems,
  importDedupKey,
  type ImportSubmitOutcome,
  type ImportSubmitPayload,
} from "../utils/request-library-import";

/**
 * 请求库共享状态（原浮窗 RequestLibraryWindow 的 script 提升）：工作区级
 * 可重放请求集合。手风琴导航下「侧栏列表（服务端过滤 + limit/offset 续页 +
 * 客户端分组/排序 + 批量删除）」与「主区详情（名称/标签编辑 + 四 tab）+
 * 导入/导出」是两个组件，列表与选中态在此共享；`request_library` 资源变更
 * 时自动刷新列表与当前详情。入口依赖 Backend.requestLibrary 能力位
 * （workspace-view / 手风琴区块把关）。
 */

export const REQUEST_PAGE_SIZE = 200;
/** 关键字输入防抖（毫秒），避免逐键打后端。 */
export const REQUEST_KEYWORD_DEBOUNCE_MS = 300;

const entries = ref<RequestLibraryEntry[]>([]);
const total = ref(0);
const loading = ref(false);
const loadingMore = ref(false);
const loaded = ref(false);
const loadError = ref<string | null>(null);
const saving = ref(false);

const keyword = ref("");
const debouncedKeyword = ref("");
const source = ref<RequestLibrarySource | "">("");
const activeTags = ref<string[]>([]);
const groupBy = ref<RequestGroupKey>("none");
const sortBy = ref<RequestSortKey>("created-desc");

const selectedId = ref<string | null>(null);
const selected = ref<RequestLibraryEntry | null>(null);
const checkedIds = ref<string[]>([]);

let loadGeneration = 0;

export const groups = computed(() =>
  buildRequestGroups(entries.value, { groupBy: groupBy.value, sortBy: sortBy.value }),
);

export const tagOptions = computed(() => {
  const seen = new Set<string>();
  for (const entry of entries.value) {
    for (const tag of entry.tags) seen.add(tag);
  }
  return [...seen].sort((a, b) => (a < b ? -1 : 1));
});

export async function refresh(): Promise<void> {
  const requestLibrary = getBackend().requestLibrary;
  if (!requestLibrary) return;
  const generation = ++loadGeneration;
  loading.value = true;
  loadError.value = null;
  try {
    const page = await requestLibrary.page({
      query: debouncedKeyword.value === "" ? null : debouncedKeyword.value,
      tags: activeTags.value.length === 0 ? null : activeTags.value.join(","),
      source: source.value === "" ? null : source.value,
      limit: REQUEST_PAGE_SIZE,
      offset: 0,
    });
    if (generation !== loadGeneration) return;
    entries.value = page.entries;
    total.value = page.total;
    loaded.value = true;
    if (page.total > page.entries.length && page.entries.length > 0) {
      // 首页未覆盖全部条目时静默续页，保证排序/分组在已加载范围内完整。
      void loadMore();
    }
  } catch (error) {
    if (generation !== loadGeneration) return;
    loadError.value = reportError(error, "加载请求库失败");
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

/** 续页：按 offset 取下一页并追加（滚动近底部或点「加载更多」时触发）。 */
export async function loadMore(): Promise<void> {
  const requestLibrary = getBackend().requestLibrary;
  if (!requestLibrary || loadingMore.value || entries.value.length >= total.value) return;
  loadingMore.value = true;
  try {
    const page = await requestLibrary.page({
      query: debouncedKeyword.value === "" ? null : debouncedKeyword.value,
      tags: activeTags.value.length === 0 ? null : activeTags.value.join(","),
      source: source.value === "" ? null : source.value,
      limit: REQUEST_PAGE_SIZE,
      offset: entries.value.length,
    });
    const known = new Set(entries.value.map((entry) => entry.id));
    entries.value.push(...page.entries.filter((entry) => !known.has(entry.id)));
    total.value = page.total;
  } catch (error) {
    reportError(error, "加载请求库更多条目失败");
  } finally {
    loadingMore.value = false;
  }
}

export async function select(id: string): Promise<void> {
  if (selectedId.value === id) return;
  selectedId.value = id;
  await loadSelected();
}

async function loadSelected(): Promise<void> {
  const requestLibrary = getBackend().requestLibrary;
  const id = selectedId.value;
  if (!requestLibrary || id === null) return;
  try {
    const entry = await requestLibrary.get(id);
    if (selectedId.value !== id) return;
    selected.value = entry;
    replaceInList(entry);
  } catch (error) {
    if (selectedId.value === id) selected.value = null;
    reportError(error, "加载请求详情失败");
  }
}

function replaceInList(entry: RequestLibraryEntry): void {
  const index = entries.value.findIndex((item) => item.id === entry.id);
  if (index >= 0) entries.value.splice(index, 1, entry);
}

export async function updateMeta(patch: { name?: string; tags?: string[] }): Promise<void> {
  const requestLibrary = getBackend().requestLibrary;
  const entry = selected.value;
  if (!requestLibrary || !entry || saving.value) return;
  saving.value = true;
  try {
    const updated = await requestLibrary.update(entry.id, patch);
    selected.value = updated;
    replaceInList(updated);
  } catch (error) {
    reportError(error, "保存请求信息失败");
  } finally {
    saving.value = false;
  }
}

export async function removeOne(): Promise<void> {
  const entry = selected.value;
  if (!entry) return;
  await removeEntries([entry.id]);
}

export async function removeCheckedEntries(): Promise<void> {
  if (checkedIds.value.length === 0) return;
  await removeEntries([...checkedIds.value]);
}

/** 批量删除：确认弹窗明确数量与不可恢复；逐条调用 DELETE（无批量端点）。 */
async function removeEntries(ids: string[]): Promise<void> {
  const requestLibrary = getBackend().requestLibrary;
  if (!requestLibrary) return;
  const ok = await confirmDialog({
    title: ids.length === 1 ? "删除请求库条目" : "批量删除请求库条目",
    message: `确定删除选中的 ${ids.length} 条请求吗？删除后不可恢复。`,
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  let failed = 0;
  for (const id of ids) {
    try {
      await requestLibrary.remove(id);
    } catch (error) {
      failed += 1;
      reportError(error, "删除请求库条目失败");
    }
  }
  if (ids.includes(selectedId.value ?? "")) {
    selectedId.value = null;
    selected.value = null;
  }
  checkedIds.value = checkedIds.value.filter((id) => !ids.includes(id));
  if (failed === 0) appStore.toast(`已删除 ${ids.length} 条请求`, "success");
  await refresh();
  if (selectedId.value !== null) void loadSelected();
}

export function toggleChecked(id: string): void {
  checkedIds.value = checkedIds.value.includes(id)
    ? checkedIds.value.filter((current) => current !== id)
    : [...checkedIds.value, id];
}

export function toggleAll(ids: string[]): void {
  const allChecked = ids.length > 0 && ids.every((id) => checkedIds.value.includes(id));
  checkedIds.value = allChecked
    ? checkedIds.value.filter((id) => !ids.includes(id))
    : [...new Set([...checkedIds.value, ...ids])];
}

export function toggleTag(tag: string): void {
  activeTags.value = activeTags.value.includes(tag)
    ? activeTags.value.filter((current) => current !== tag)
    : [...activeTags.value, tag];
}

// ---- 导入入口（独立区块，与列表/详情逻辑无耦合） ----

export const importOpen = ref(false);

/**
 * 导入对话框回调：skipDuplicates 时全量拉取库内既有条目构建 `METHOD URL` 键集
 * 去重，随后逐条走既有 POST /api/request-library 入库（服务端做默认命名与重名
 * 后缀），最后刷新列表并汇总提示。
 */
export async function importRequests(payload: ImportSubmitPayload): Promise<ImportSubmitOutcome> {
  const requestLibrary = getBackend().requestLibrary;
  if (!requestLibrary) return { imported: 0, failed: payload.items.length, skipped: 0 };
  let existingKeys: Set<string> | null = null;
  if (payload.skipDuplicates) {
    existingKeys = new Set();
    let offset = 0;
    for (;;) {
      const page = await requestLibrary.page({
        query: null,
        tags: null,
        source: null,
        limit: REQUEST_PAGE_SIZE,
        offset,
      });
      for (const entry of page.entries) {
        existingKeys.add(importDedupKey(requestMethod(entry), requestUrl(entry)));
      }
      offset += page.entries.length;
      if (page.entries.length === 0 || offset >= page.total) break;
    }
  }
  const { kept, duplicates } = existingKeys
    ? filterDuplicateItems(payload.items, existingKeys)
    : { kept: payload.items, duplicates: [] };
  let imported = 0;
  let failed = 0;
  for (const item of kept) {
    try {
      await requestLibrary.create(buildImportRequest(item, payload.tags));
      imported += 1;
    } catch (error) {
      failed += 1;
      reportError(error, "导入请求库条目失败");
    }
  }
  if (imported > 0 || duplicates.length > 0) {
    const parts = [`导入 ${imported} 条`];
    if (duplicates.length > 0) parts.push(`跳过重复 ${duplicates.length} 条`);
    if (failed > 0) parts.push(`失败 ${failed} 条`);
    appStore.toast(parts.join("，"), failed > 0 && imported === 0 ? "error" : "success");
  }
  await refresh();
  return { imported, failed, skipped: duplicates.length };
}

// ---- 导出入口（独立区块：仅针对当前选中条目，与列表/导入逻辑无耦合） ----

/** 结果反馈文案（null = 无反馈）；1.5s 后自动清除。 */
const exportFeedback = ref<string | null>(null);
const exportFailed = ref(false);
let exportFeedbackTimer: number | undefined;

/** 展示导出反馈并重置清除计时（重复触发时重置）。 */
function showExportFeedback(message: string, failed: boolean): void {
  exportFeedback.value = message;
  exportFailed.value = failed;
  if (exportFeedbackTimer !== undefined) window.clearTimeout(exportFeedbackTimer);
  exportFeedbackTimer = window.setTimeout(() => {
    exportFeedbackTimer = undefined;
    exportFeedback.value = null;
  }, 1500);
}

/** 「导出为…」下拉菜单：六格式按 REQUEST_EXPORT_FORMATS 顺序。 */
export function openExportMenu(event: MouseEvent): void {
  if (!selected.value) return;
  openDropdownMenu(
    event.currentTarget as HTMLElement,
    REQUEST_EXPORT_FORMATS.map((format) => ({
      label: format.label,
      action: () => void runExport(format.id),
    })),
  );
}

/**
 * 执行一次导出：download 型（HAR / Postman）经既有 saveFile 通路保存（用户
 * 取消时提示）；copy 型（cURL / fetch / axios / Python）复制到剪贴板。
 * 快照无 entry 的条目（防御性形态）生成空串：不做任何动作。
 */
export async function runExport(format: RequestExportFormatId): Promise<void> {
  const backend = getBackend();
  const entry = selected.value;
  if (!entry) return;
  const meta = REQUEST_EXPORT_FORMATS.find((candidate) => candidate.id === format);
  if (meta?.kind === "download" && (format === "har" || format === "postman")) {
    try {
      const saved = await downloadRequestExport(backend, entry, format);
      // 用户取消（saveFile 返回 null）不做反馈，与既有导出窗一致。
      if (saved) showExportFeedback(`已开始下载 ${meta.label}`, false);
    } catch (error) {
      reportError(error, "导出请求失败");
    }
    return;
  }
  const content = exportRequestSnapshot(entry, format);
  if (content === "") return;
  try {
    await writeClipboardText(content);
    showExportFeedback(`已复制 ${meta?.label ?? format}`, false);
  } catch {
    appStore.toast("复制失败", "error");
    showExportFeedback("复制失败", true);
  }
}

/** 清除导出反馈计时（视图卸载时调用，防跨挂载期定时器回流）。 */
export function clearExportFeedbackTimer(): void {
  if (exportFeedbackTimer !== undefined) window.clearTimeout(exportFeedbackTimer);
}

/** `request_library` 资源变更（其他窗口 / CLI 改动）对账入口。 */
export function onRequestLibraryHttpApiChange(event: Event): void {
  const { resources } = (event as CustomEvent<HttpApiChange>).detail;
  if (!resources.includes("all") && !resources.includes("request_library")) return;
  // 名称/标签均为即时提交，无未保存草稿；直接刷新列表与详情。
  void refresh();
  if (selectedId.value !== null) void loadSelected();
}

export function useRequestLibraryStore() {
  return {
    entries,
    total,
    loading,
    loadingMore,
    loaded,
    loadError,
    saving,
    keyword,
    debouncedKeyword,
    source,
    activeTags,
    groupBy,
    sortBy,
    selectedId,
    selected,
    checkedIds,
    groups,
    tagOptions,
    importOpen,
    exportFeedback,
    exportFailed,
    refresh,
    loadMore,
    select,
    updateMeta,
    removeOne,
    removeCheckedEntries,
    toggleChecked,
    toggleAll,
    toggleTag,
    importRequests,
    openExportMenu,
    runExport,
  };
}
