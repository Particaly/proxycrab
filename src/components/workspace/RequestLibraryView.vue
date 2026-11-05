<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from "vue";
import { Io5Download } from "vue-icons-plus/io5";
import RequestLibraryDetail from "../request-library/RequestLibraryDetail.vue";
import RequestLibraryImportDialog from "../request-library/RequestLibraryImportDialog.vue";
import {
  REQUEST_KEYWORD_DEBOUNCE_MS,
  clearExportFeedbackTimer,
  onRequestLibraryHttpApiChange,
  refresh,
  useRequestLibraryStore,
} from "../../stores/request-library";
import { HTTP_API_CHANGE_EVENT } from "../../stores/http-api-sync";

/**
 * 请求库主区视图（原浮窗主区区块）：详情（名称/标签编辑 + 四 tab）、
 * 导入对话框与右下角导出条。列表在手风琴侧栏（RequestLibraryList）。
 * 过滤条件（防抖关键字 / 来源 / 标签）变化即刷新列表；`request_library`
 * 资源变更经 HTTP 变更广播对账。
 */
const {
  keyword,
  debouncedKeyword,
  source,
  activeTags,
  selectedId,
  selected,
  loadError,
  saving,
  importOpen,
  exportFeedback,
  exportFailed,
  updateMeta,
  removeOne,
  importRequests,
  openExportMenu,
} = useRequestLibraryStore();

let keywordTimer: number | undefined;

watch(keyword, (value) => {
  if (keywordTimer !== undefined) window.clearTimeout(keywordTimer);
  keywordTimer = window.setTimeout(() => {
    keywordTimer = undefined;
    if (debouncedKeyword.value !== value.trim()) {
      debouncedKeyword.value = value.trim();
    }
  }, REQUEST_KEYWORD_DEBOUNCE_MS);
});

watch([debouncedKeyword, source, activeTags], () => void refresh());

onMounted(() => {
  void refresh();
  window.addEventListener(HTTP_API_CHANGE_EVENT, onRequestLibraryHttpApiChange);
});

onBeforeUnmount(() => {
  if (keywordTimer !== undefined) window.clearTimeout(keywordTimer);
  clearExportFeedbackTimer();
  window.removeEventListener(HTTP_API_CHANGE_EVENT, onRequestLibraryHttpApiChange);
});
</script>

<template>
  <div class="rl-view">
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
    <!-- 导入对话框（Teleport 到 body，独立于列表/详情布局） -->
    <RequestLibraryImportDialog
      v-if="importOpen"
      :import-requests="importRequests"
      @close="importOpen = false"
    />
    <!-- 导出（独立区块：浮在详情右下角，仅当前选中条目可导出） -->
    <div v-if="selected" class="rl-export-bar">
      <span
        v-if="exportFeedback"
        class="rl-export-feedback"
        :class="{ failed: exportFailed }"
        aria-live="polite"
      >
        {{ exportFeedback }}
      </span>
      <button class="btn" @click="openExportMenu"><Io5Download :size="13" /> 导出为…</button>
    </div>
  </div>
</template>

<style scoped>
.rl-view {
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
