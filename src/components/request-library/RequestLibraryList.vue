<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Io5Close, Io5Trash } from "vue-icons-plus/io5";
import {
  MAX_ROW_TAGS,
  REQUEST_GROUP_OPTIONS,
  REQUEST_KEYWORD_PLACEHOLDER,
  REQUEST_SORT_OPTIONS,
  REQUEST_SOURCE_OPTIONS,
  SOURCE_LABELS,
  formatUrlParts,
  requestMethod,
  requestUrl,
  type RequestGroup,
  type RequestGroupKey,
  type RequestSortKey,
} from "./request-library-view";
import type { RequestLibraryEntry, RequestLibrarySource } from "../../api/types";
import { formatRelativeTime } from "../../utils/format";

/**
 * 请求库左栏：搜索/标签/来源/分组/排序工具栏 + 分组列表 + 批量勾选。
 * 关键字/标签/来源过滤经 props 由窗口转成服务端查询；分组与排序为
 * 窗口侧派生结果。列表遵循 API 的 limit/offset：滚动近底部或点「加载更多」
 * 触发 loadMore。数据与回调全部经 props/emits 由窗口注入。
 */
const props = defineProps<{
  groups: RequestGroup[];
  groupBy: RequestGroupKey;
  sortBy: RequestSortKey;
  keyword: string;
  source: RequestLibrarySource | "";
  activeTags: string[];
  /** 全部可选标签（来自当前已加载条目，供标签筛选下拉）。 */
  tagOptions: string[];
  loadedCount: number;
  total: number;
  loading: boolean;
  /** 首次加载是否已完成（区分「加载中」与「暂无条目」）。 */
  loaded: boolean;
  loadingMore: boolean;
  selectedId: string | null;
  checkedIds: string[];
}>();

const emit = defineEmits<{
  "update:keyword": [value: string];
  "update:groupBy": [value: RequestGroupKey];
  "update:sortBy": [value: RequestSortKey];
  "update:source": [value: RequestLibrarySource | ""];
  toggleTag: [tag: string];
  select: [id: string];
  import: [];
  toggleChecked: [id: string];
  toggleAll: [ids: string[]];
  removeChecked: [];
  clearChecked: [];
  loadMore: [];
}>();

/** tag 筛选输入（回车或全角逗号成签）。 */
const tagDraft = ref("");

function commitTagDraft(): void {
  const tag = tagDraft.value.trim();
  tagDraft.value = "";
  if (tag !== "") emit("toggleTag", tag);
}

const checkedSet = computed(() => new Set(props.checkedIds));
const hasMatch = computed(() => props.groups.some((group) => group.items.length > 0));
const visibleIds = computed(() =>
  props.groups.flatMap((group) => group.items.map((item) => item.id)),
);
const allChecked = computed(
  () => visibleIds.value.length > 0 && visibleIds.value.every((id) => checkedSet.value.has(id)),
);
const someChecked = computed(() => props.checkedIds.length > 0 && !allChecked.value);
const canLoadMore = computed(() => props.loadedCount < props.total);

const selectAllRef = ref<HTMLInputElement | null>(null);
watch(someChecked, (value) => {
  if (selectAllRef.value) selectAllRef.value.indeterminate = value;
});

/** 滚动近底部时自动续页；到底部前留一屏余量。 */
function onScroll(event: Event): void {
  if (!canLoadMore.value || props.loadingMore || props.loading) return;
  const el = event.target as HTMLElement;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) emit("loadMore");
}

function visibleTags(entry: RequestLibraryEntry): string[] {
  return entry.tags.slice(0, MAX_ROW_TAGS);
}

function hiddenTagCount(entry: RequestLibraryEntry): number {
  return Math.max(0, entry.tags.length - MAX_ROW_TAGS);
}

function methodClass(entry: RequestLibraryEntry): string {
  switch (requestMethod(entry).toUpperCase()) {
    case "GET":
      return "m-get";
    case "POST":
      return "m-post";
    case "PUT":
      return "m-put";
    case "PATCH":
      return "m-patch";
    case "DELETE":
      return "m-delete";
    default:
      return "m-other";
  }
}

function urlParts(entry: RequestLibraryEntry): { host: string; path: string } {
  return formatUrlParts(requestUrl(entry));
}
</script>

<template>
  <div class="rl-list">
    <div class="rl-toolbar">
      <input
        :value="keyword"
        class="input rl-search"
        type="text"
        :placeholder="REQUEST_KEYWORD_PLACEHOLDER"
        aria-label="搜索请求"
        spellcheck="false"
        @input="emit('update:keyword', ($event.target as HTMLInputElement).value)"
      />
      <div class="rl-toolbar-row">
        <select
          class="select rl-control"
          :value="source"
          aria-label="来源过滤"
          @change="
            emit(
              'update:source',
              ($event.target as HTMLSelectElement).value as RequestLibrarySource | '',
            )
          "
        >
          <option
            v-for="option in REQUEST_SOURCE_OPTIONS"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
        <select
          class="select rl-control"
          :value="groupBy"
          aria-label="分组方式"
          @change="
            emit('update:groupBy', ($event.target as HTMLSelectElement).value as RequestGroupKey)
          "
        >
          <option v-for="option in REQUEST_GROUP_OPTIONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
        <select
          class="select rl-control"
          :value="sortBy"
          aria-label="排序方式"
          @change="
            emit('update:sortBy', ($event.target as HTMLSelectElement).value as RequestSortKey)
          "
        >
          <option v-for="option in REQUEST_SORT_OPTIONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
        <button
          class="btn rl-import-btn"
          title="从 cURL / HAR / Postman 导入请求"
          @click="emit('import')"
        >
          导入
        </button>
      </div>
      <div class="rl-toolbar-row">
        <div class="rl-tag-filter">
          <span
            v-for="tag in activeTags"
            :key="tag"
            class="rl-tag-chip active"
            role="button"
            :title="`移除标签过滤 ${tag}`"
            @click="emit('toggleTag', tag)"
          >
            {{ tag }}
            <Io5Close :size="9" />
          </span>
          <input
            v-model="tagDraft"
            class="input rl-tag-input"
            type="text"
            placeholder="按标签过滤，回车添加"
            list="rl-tag-options"
            spellcheck="false"
            @keydown.enter.prevent="commitTagDraft"
          />
          <datalist id="rl-tag-options">
            <option v-for="tag in tagOptions" :key="tag" :value="tag" />
          </datalist>
        </div>
      </div>
    </div>

    <div class="rl-rows" @scroll.passive="onScroll">
      <template v-if="loaded && hasMatch">
        <label class="rl-select-all">
          <input
            ref="selectAllRef"
            type="checkbox"
            :checked="allChecked"
            title="全选当前结果（已加载部分）"
            @change="emit('toggleAll', visibleIds)"
          />
          <span>共 {{ loadedCount }} / {{ total }} 条</span>
        </label>
        <template v-for="group in groups" :key="group.key">
          <div v-if="groupBy !== 'none'" class="rl-group-head">
            <span class="rl-group-name" :title="group.label">{{ group.label }}</span>
            <span class="rl-group-count">{{ group.items.length }}</span>
          </div>
          <div
            v-for="entry in group.items"
            :key="group.key === 'all' ? entry.id : `${group.key}:${entry.id}`"
            class="rl-row"
            :class="{ selected: entry.id === selectedId }"
            @click="emit('select', entry.id)"
          >
            <input
              type="checkbox"
              :checked="checkedSet.has(entry.id)"
              :aria-label="`选择 ${entry.name}`"
              @click.stop
              @change="emit('toggleChecked', entry.id)"
            />
            <div class="rl-row-body">
              <div class="rl-row-line">
                <span class="rl-row-name" :title="entry.name">{{ entry.name }}</span>
                <span class="rl-row-time">{{ formatRelativeTime(entry.createdAt) }}</span>
              </div>
              <div class="rl-row-line">
                <span class="method-chip mono" :class="methodClass(entry)">{{
                  requestMethod(entry) || "—"
                }}</span>
                <span class="source-chip" :class="`src-${entry.source}`">
                  {{ SOURCE_LABELS[entry.source] }}
                </span>
                <span class="rl-row-url mono" :title="requestUrl(entry)">
                  {{ urlParts(entry).host
                  }}<span class="rl-row-path">{{ urlParts(entry).path }}</span>
                </span>
              </div>
              <div v-if="entry.tags.length > 0" class="rl-row-line rl-row-tags">
                <span
                  v-for="tag in visibleTags(entry)"
                  :key="tag"
                  class="rl-tag-chip"
                  :title="`按标签 ${tag} 过滤`"
                  @click.stop="emit('toggleTag', tag)"
                >
                  {{ tag }}
                </span>
                <span v-if="hiddenTagCount(entry) > 0" class="rl-tag-chip muted">
                  +{{ hiddenTagCount(entry) }}
                </span>
              </div>
            </div>
          </div>
        </template>
        <div v-if="canLoadMore" class="rl-load-more">
          <button class="btn" :disabled="loadingMore" @click="emit('loadMore')">
            {{ loadingMore ? "加载中…" : `加载更多（剩余 ${total - loadedCount} 条）` }}
          </button>
        </div>
      </template>
      <div v-else-if="!loaded" class="empty-hint">正在加载…</div>
      <div v-else-if="loading" class="empty-hint">正在加载…</div>
      <div v-else class="rl-empty">
        <p>{{ total > 0 ? "无匹配请求" : "请求库暂无条目" }}</p>
        <p class="rl-empty-detail">
          {{
            total > 0
              ? "当前过滤条件下没有命中任何请求，试试更换关键字或清空筛选。"
              : "在日志详情右键「存入请求库」，或点上方「导入」从 cURL / HAR / Postman 汇入。"
          }}
        </p>
        <button
          v-if="keyword !== '' || source !== '' || activeTags.length > 0"
          class="btn"
          @click="
            (emit('update:keyword', ''),
            emit('update:source', ''),
            activeTags.forEach((tag) => emit('toggleTag', tag)))
          "
        >
          清空筛选
        </button>
      </div>
    </div>

    <div v-if="checkedIds.length > 0" class="rl-batch-bar">
      <span class="rl-batch-count"
        >已选 <b>{{ checkedIds.length }}</b> 条</span
      >
      <button class="btn danger" @click="emit('removeChecked')">
        <Io5Trash :size="13" /> 删除
      </button>
      <button class="btn" @click="emit('toggleAll', visibleIds)">
        {{ allChecked ? "取消全选" : "全选" }}
      </button>
      <button class="btn" @click="emit('clearChecked')">取消</button>
    </div>
  </div>
</template>

<style scoped>
.rl-list {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--bg-panel);
}

.rl-toolbar {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border-bottom: 1px solid var(--border);
}

.rl-search {
  width: 100%;
}

.rl-toolbar-row {
  display: flex;
  gap: var(--space-1);
}

.rl-control {
  flex: 1;
  min-width: 0;
  font-size: 12px;
}

.rl-import-btn {
  flex: none;
  font-size: 12px;
}

.rl-tag-filter {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

.rl-tag-input {
  flex: 1;
  min-width: 120px;
  padding: 2px 8px;
  font-size: 11px;
}

.rl-tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 7px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 16px;
  cursor: pointer;
  white-space: nowrap;
}

.rl-tag-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.rl-tag-chip.active {
  border-color: var(--accent);
  background: var(--bg-selected);
  color: var(--accent);
}

.rl-tag-chip.muted {
  cursor: default;
  color: var(--text-faint);
}
.rl-tag-chip.muted:hover {
  border-color: var(--border);
  color: var(--text-faint);
}

.rl-rows {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: var(--space-2);
}

.rl-select-all {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 26px;
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
}

.rl-group-head {
  position: sticky;
  top: 26px;
  z-index: 1;
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  padding: 3px var(--space-2);
  border-bottom: 1px solid var(--border);
  background: var(--bg-app);
}

.rl-group-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.rl-group-count {
  flex: none;
  color: var(--text-faint);
  font-size: 10px;
}

.rl-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2) var(--space-1) var(--space-1);
  border-bottom: 1px solid var(--border);
  border-left: 2px solid transparent;
  cursor: pointer;
}

.rl-row:hover {
  background: var(--bg-hover);
}

.rl-row.selected {
  border-left-color: var(--accent);
  background: var(--bg-selected);
}

.rl-row input[type="checkbox"] {
  margin-top: 3px;
  flex: none;
}

.rl-row-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rl-row-line {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.rl-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 12px;
}

.rl-row-time {
  flex: none;
  color: var(--text-faint);
  font-size: 10px;
}

.rl-row-url {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--text-secondary);
}

.rl-row-path {
  color: var(--text-faint);
}

.rl-row-tags {
  flex-wrap: wrap;
}

.method-chip {
  flex: none;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 9px;
  font-weight: 700;
  line-height: 14px;
  color: #fff;
}

.m-get {
  background: var(--success);
}
.m-post {
  background: var(--accent);
}
.m-put {
  background: var(--warning);
}
.m-patch {
  background: #8b5cf6;
}
.m-delete {
  background: var(--danger);
}
.m-other {
  background: var(--text-faint);
}

/* 来源徽标：抓包=蓝、导入=紫、手工=灰。 */
.source-chip {
  flex: none;
  padding: 0 5px;
  border-radius: 7px;
  font-size: 9px;
  line-height: 14px;
}

.src-capture {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
}

.src-import {
  background: color-mix(in srgb, #8b5cf6 14%, transparent);
  color: #8b5cf6;
}

.src-manual {
  background: var(--bg-active);
  color: var(--text-secondary);
}

.rl-load-more {
  display: flex;
  justify-content: center;
  padding: var(--space-2);
}

.rl-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-6, 24px) var(--space-4);
  text-align: center;
}

.rl-empty p {
  margin: 0;
  color: var(--text-secondary);
}

.rl-empty-detail {
  color: var(--text-faint) !important;
  font-size: 11px;
}

.rl-batch-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2);
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}

.rl-batch-count {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text);
}

.rl-batch-count b {
  color: var(--accent);
}
</style>
