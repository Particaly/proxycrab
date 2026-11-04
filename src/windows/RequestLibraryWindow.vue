<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Io5Download } from "vue-icons-plus/io5";
import { useBackend } from "../api";
import type { HttpApiChange, RequestLibraryEntry, RequestLibrarySource } from "../api/types";
import { appStore, reportError } from "../stores/app";
import { confirmDialog, openDropdownMenu } from "../stores/dialog";
import { HTTP_API_CHANGE_EVENT } from "../stores/http-api-sync";
import RequestLibraryList from "../components/request-library/RequestLibraryList.vue";
import RequestLibraryDetail from "../components/request-library/RequestLibraryDetail.vue";
import { copyText as writeClipboardText } from "../utils/clipboard";
import {
  REQUEST_EXPORT_FORMATS,
  exportRequestSnapshot,
  type RequestExportFormatId,
} from "../utils/request-export";
import { downloadRequestExport } from "../utils/request-export-download";
import {
  buildRequestGroups,
  type RequestGroupKey,
  type RequestSortKey,
} from "../components/request-library/request-library-view";

/**
 * 请求库窗口：工作区级可重放请求集合（ReqFlow「请求中心」形态）。
 * 左列表（服务端过滤 + limit/offset 续页 + 客户端分组/排序 + 批量删除）、
 * 右详情（名称/标签编辑 + 四 tab）。入口依赖 Backend.requestLibrary 能力位；
 * `request_library` 资源变更时自动刷新列表与当前详情。
 */
const backend = useBackend();

const PAGE_SIZE = 200;
/** 关键字输入防抖（毫秒），避免逐键打后端。 */
const KEYWORD_DEBOUNCE_MS = 300;

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

let keywordTimer: number | undefined;
let loadGeneration = 0;

watch(keyword, (value) => {
  if (keywordTimer !== undefined) window.clearTimeout(keywordTimer);
  keywordTimer = window.setTimeout(() => {
    keywordTimer = undefined;
    if (debouncedKeyword.value !== value.trim()) {
      debouncedKeyword.value = value.trim();
    }
  }, KEYWORD_DEBOUNCE_MS);
});

watch([debouncedKeyword, source, activeTags], () => void refresh());

const groups = computed(() =>
  buildRequestGroups(entries.value, { groupBy: groupBy.value, sortBy: sortBy.value }),
);

const tagOptions = computed(() => {
  const seen = new Set<string>();
  for (const entry of entries.value) {
    for (const tag of entry.tags) seen.add(tag);
  }
  return [...seen].sort((a, b) => (a < b ? -1 : 1));
});

async function refresh(): Promise<void> {
  const requestLibrary = backend.requestLibrary;
  if (!requestLibrary) return;
  const generation = ++loadGeneration;
  loading.value = true;
  loadError.value = null;
  try {
    const page = await requestLibrary.page({
      query: debouncedKeyword.value === "" ? null : debouncedKeyword.value,
      tags: activeTags.value.length === 0 ? null : activeTags.value.join(","),
      source: source.value === "" ? null : source.value,
      limit: PAGE_SIZE,
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
async function loadMore(): Promise<void> {
  const requestLibrary = backend.requestLibrary;
  if (!requestLibrary || loadingMore.value || entries.value.length >= total.value) return;
  loadingMore.value = true;
  try {
    const page = await requestLibrary.page({
      query: debouncedKeyword.value === "" ? null : debouncedKeyword.value,
      tags: activeTags.value.length === 0 ? null : activeTags.value.join(","),
      source: source.value === "" ? null : source.value,
      limit: PAGE_SIZE,
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

async function select(id: string): Promise<void> {
  if (selectedId.value === id) return;
  selectedId.value = id;
  await loadSelected();
}

async function loadSelected(): Promise<void> {
  const requestLibrary = backend.requestLibrary;
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

async function updateMeta(patch: { name?: string; tags?: string[] }): Promise<void> {
  const requestLibrary = backend.requestLibrary;
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

async function removeOne(): Promise<void> {
  const entry = selected.value;
  if (!entry) return;
  await removeEntries([entry.id]);
}

async function removeCheckedEntries(): Promise<void> {
  if (checkedIds.value.length === 0) return;
  await removeEntries([...checkedIds.value]);
}

/** 批量删除：确认弹窗明确数量与不可恢复；逐条调用 DELETE（无批量端点）。 */
async function removeEntries(ids: string[]): Promise<void> {
  const requestLibrary = backend.requestLibrary;
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

function toggleChecked(id: string): void {
  checkedIds.value = checkedIds.value.includes(id)
    ? checkedIds.value.filter((current) => current !== id)
    : [...checkedIds.value, id];
}

function toggleAll(ids: string[]): void {
  const allChecked = ids.length > 0 && ids.every((id) => checkedIds.value.includes(id));
  checkedIds.value = allChecked
    ? checkedIds.value.filter((id) => !ids.includes(id))
    : [...new Set([...checkedIds.value, ...ids])];
}

function toggleTag(tag: string): void {
  activeTags.value = activeTags.value.includes(tag)
    ? activeTags.value.filter((current) => current !== tag)
    : [...activeTags.value, tag];
}

// ---- 导出入口（Task 9；独立区块，仅针对当前选中条目，与列表/导入逻辑无耦合） ----

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
function openExportMenu(event: MouseEvent): void {
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
async function runExport(format: RequestExportFormatId): Promise<void> {
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

function onHttpApiChange(event: Event): void {
  const { resources } = (event as CustomEvent<HttpApiChange>).detail;
  if (!resources.includes("all") && !resources.includes("request_library")) return;
  // 名称/标签均为即时提交，无未保存草稿；直接刷新列表与详情。
  void refresh();
  if (selectedId.value !== null) void loadSelected();
}

onMounted(() => {
  void refresh();
  window.addEventListener(HTTP_API_CHANGE_EVENT, onHttpApiChange);
});

onBeforeUnmount(() => {
  if (keywordTimer !== undefined) window.clearTimeout(keywordTimer);
  if (exportFeedbackTimer !== undefined) window.clearTimeout(exportFeedbackTimer);
  window.removeEventListener(HTTP_API_CHANGE_EVENT, onHttpApiChange);
});
</script>

<template>
  <div class="rl-root">
    <RequestLibraryList
      v-model:keyword="keyword"
      v-model:group-by="groupBy"
      v-model:sort-by="sortBy"
      v-model:source="source"
      :groups="groups"
      :active-tags="activeTags"
      :tag-options="tagOptions"
      :loaded-count="entries.length"
      :total="total"
      :loading="loading"
      :loaded="loaded"
      :loading-more="loadingMore"
      :selected-id="selectedId"
      :checked-ids="checkedIds"
      @toggle-tag="toggleTag"
      @select="select"
      @toggle-checked="toggleChecked"
      @toggle-all="toggleAll"
      @remove-checked="removeCheckedEntries"
      @clear-checked="checkedIds = []"
      @load-more="loadMore"
    />
    <div v-if="loadError && !selected" class="rl-error">
      <span>加载请求库失败：{{ loadError }}</span>
      <button class="btn" @click="refresh()">重试</button>
    </div>
    <RequestLibraryDetail
      v-if="selected"
      :key="selected.id"
      :entry="selected"
      :saving="saving"
      @update-meta="updateMeta"
      @remove="removeOne"
    />
    <div v-else class="rl-no-selection">
      <p>{{ selectedId === null ? "未选择请求" : "请求详情加载失败" }}</p>
      <p class="rl-no-selection-detail">
        {{
          selectedId === null
            ? "从左侧列表选择一条请求，查看并编辑其 Headers / Query / Body / Response。"
            : "该条目可能已被删除，刷新列表后重试。"
        }}
      </p>
    </div>
    <!-- 导出（Task 9；独立区块：浮在详情右下角，仅当前选中条目可导出） -->
    <div v-if="selected" class="rl-export-bar">
      <span
        v-if="exportFeedback"
        class="rl-export-feedback"
        :class="{ failed: exportFailed }"
        aria-live="polite"
      >
        {{ exportFeedback }}
      </span>
      <button class="btn" @click="openExportMenu">
        <Io5Download :size="13" /> 导出为…
      </button>
    </div>
  </div>
</template>

<style scoped>
.rl-root {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  position: relative;
}

/* 导出区块：浮在详情右下角，不占用详情布局空间（独立于列表/详情/导入）。 */
.rl-export-bar {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-3);
  z-index: 5;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.rl-export-feedback {
  font-size: 11px;
  color: var(--success);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 3px 8px;
}

.rl-export-feedback.failed {
  color: var(--danger);
}

.rl-error {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--danger);
  font-size: 12px;
  padding: var(--space-4);
}

.rl-no-selection {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  padding: var(--space-4);
  text-align: center;
}

.rl-no-selection p {
  margin: 0;
  color: var(--text-secondary);
}

.rl-no-selection-detail {
  font-size: 11px;
  color: var(--text-faint);
}
</style>
