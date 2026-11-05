<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Io5Close, Io5Search } from "vue-icons-plus/io5";
import { useBackend } from "../../../api";
import type { RequestLibraryEntry, RequestLibraryQuery } from "../../../api/types";
import { formatBytes } from "../../../utils/format";
import {
  SOURCE_LABELS,
  requestMethod,
  requestBodyPayload,
  requestUrl,
} from "../../request-library/request-library-view";

/**
 * 请求选择弹窗（计划 Task 14 Step 1）：节点配置抽屉「请求引用」的请求库
 * 挑选入口。数据走既有 `GET /api/request-library`（query 关键字 + tags 服务端
 * 过滤，标签候选来自已加载条目）；点行选中预览、再点「选择」或双击行提交
 * （pick 回传完整条目）。遮罩点击 / Esc / 关闭按钮关闭（close）。
 * 父组件负责开关（v-if）与 pick 后的回填。
 */
const emit = defineEmits<{ pick: [entry: RequestLibraryEntry]; close: [] }>();

const backend = useBackend();

const PAGE_SIZE = 50;
const KEYWORD_DEBOUNCE_MS = 300;

const entries = ref<RequestLibraryEntry[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
const keyword = ref("");
const debouncedKeyword = ref("");
const activeTags = ref<string[]>([]);
/** 预览选中的条目 id（null = 未选中）。 */
const previewId = ref<string | null>(null);

let keywordTimer: number | undefined;
let loadGeneration = 0;

const previewEntry = computed(
  () => entries.value.find((entry) => entry.id === previewId.value) ?? null,
);

const tagOptions = computed(() => {
  const seen = new Set<string>();
  for (const entry of entries.value) {
    for (const tag of entry.tags) seen.add(tag);
  }
  return [...seen].sort((a, b) => (a < b ? -1 : 1));
});

watch(keyword, (value) => {
  if (keywordTimer !== undefined) window.clearTimeout(keywordTimer);
  keywordTimer = window.setTimeout(() => {
    keywordTimer = undefined;
    const next = value.trim();
    if (debouncedKeyword.value !== next) debouncedKeyword.value = next;
  }, KEYWORD_DEBOUNCE_MS);
});

watch(debouncedKeyword, () => void load());

async function load(): Promise<void> {
  const requestLibrary = backend.requestLibrary;
  if (!requestLibrary) return;
  const generation = ++loadGeneration;
  loading.value = true;
  loadError.value = null;
  const query: RequestLibraryQuery = {
    query: debouncedKeyword.value === "" ? null : debouncedKeyword.value,
    tags: activeTags.value.length === 0 ? null : activeTags.value.join(","),
    limit: PAGE_SIZE,
    offset: 0,
  };
  try {
    const page = await requestLibrary.page(query);
    if (generation !== loadGeneration) return;
    entries.value = page.entries;
    if (previewId.value !== null && !page.entries.some((entry) => entry.id === previewId.value)) {
      previewId.value = null;
    }
  } catch (error) {
    if (generation !== loadGeneration) return;
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

function toggleTag(tag: string): void {
  activeTags.value = activeTags.value.includes(tag)
    ? activeTags.value.filter((existing) => existing !== tag)
    : [...activeTags.value, tag];
}

function select(entry: RequestLibraryEntry): void {
  previewId.value = entry.id;
}

function confirmPick(): void {
  if (!previewEntry.value) return;
  emit("pick", previewEntry.value);
}

function splitUrl(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    return { host: parsed.host, path: path === "" ? "/" : path };
  } catch {
    return { host: "", path: url };
  }
}

function methodBadgeClass(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
      return "m-get";
    case "POST":
      return "m-post";
    case "PUT":
    case "PATCH":
      return "m-put";
    case "DELETE":
      return "m-delete";
    default:
      return "m-other";
  }
}

function previewSummary(entry: RequestLibraryEntry): string {
  const headers = entry.har?.log?.entries?.[0]?.request?.headers ?? [];
  const payload = requestBodyPayload(entry);
  const body =
    payload.type === "empty"
      ? "无 body"
      : payload.type === "text"
        ? `body ${formatBytes(payload.size)}`
        : `二进制 body ${formatBytes(payload.size)}`;
  const status = entry.har?.log?.entries?.[0]?.response?.status;
  return `${headers.length} 请求头 · ${body}${status !== undefined ? ` · 响应 ${status}` : ""}`;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  void load();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  if (keywordTimer !== undefined) window.clearTimeout(keywordTimer);
});
</script>

<template>
  <div class="rp-mask" @pointerdown.self="emit('close')">
    <div class="rp-panel" role="dialog" aria-label="选择请求">
      <header class="rp-head">
        <span class="rp-title">选择请求</span>
        <span class="text-faint">从工作区请求库挑选，作为本节点的请求基线</span>
        <button class="btn icon" title="关闭" @click="emit('close')">
          <Io5Close :size="14" />
        </button>
      </header>
      <div class="rp-filter">
        <div class="rp-search">
          <Io5Search :size="13" class="text-faint" />
          <input
            v-model="keyword"
            class="rp-search-input"
            placeholder="搜索名称、URL 或标签"
            spellcheck="false"
            aria-label="搜索请求"
          />
        </div>
        <div v-if="tagOptions.length > 0" class="rp-tags">
          <button
            v-for="tag in tagOptions"
            :key="tag"
            class="rp-tag"
            :class="{ active: activeTags.includes(tag) }"
            :title="`按标签 ${tag} 过滤`"
            @click="toggleTag(tag)"
          >
            {{ tag }}
          </button>
        </div>
      </div>
      <div class="rp-list">
        <div v-if="loading && entries.length === 0" class="empty-hint">正在加载…</div>
        <div v-else-if="loadError" class="rp-error">
          <span>加载请求库失败：{{ loadError }}</span>
          <button class="btn compact" @click="load">重试</button>
        </div>
        <div v-else-if="entries.length === 0" class="empty-hint">请求库还没有条目</div>
        <template v-else>
          <div
            v-for="entry in entries"
            :key="entry.id"
            class="rp-row"
            :class="{ selected: previewId === entry.id }"
            role="button"
            tabindex="0"
            @click="select(entry)"
            @keydown.enter="confirmPick"
            @dblclick="confirmPick"
          >
            <span class="rp-method mono" :class="methodBadgeClass(requestMethod(entry))">{{
              requestMethod(entry) || "—"
            }}</span>
            <span class="rp-row-main">
              <span class="rp-row-name" :title="entry.name">{{ entry.name }}</span>
              <span class="rp-row-url mono" :title="requestUrl(entry)">
                <span class="text-faint">{{ splitUrl(requestUrl(entry)).host }}</span
                >{{ splitUrl(requestUrl(entry)).path }}
              </span>
            </span>
            <span class="rp-row-side">
              <span class="rp-source">{{ SOURCE_LABELS[entry.source] }}</span>
              <span v-if="entry.tags.length > 0" class="rp-row-tag">{{ entry.tags[0] }}</span>
            </span>
          </div>
        </template>
      </div>
      <footer class="rp-foot">
        <div class="rp-preview">
          <template v-if="previewEntry">
            <span class="rp-preview-name" :title="previewEntry.name">{{ previewEntry.name }}</span>
            <span class="mono text-secondary" :title="requestUrl(previewEntry)">{{
              requestUrl(previewEntry)
            }}</span>
            <span class="text-faint">{{ previewSummary(previewEntry) }}</span>
          </template>
          <span v-else class="text-faint">点击条目预览，双击直接选择</span>
        </div>
        <button class="btn primary" :disabled="!previewEntry" @click="confirmPick">选择</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩铺满整个窗口：配置抽屉已绝对定位，若用 absolute 会以抽屉列为包含块，
 * 遮罩被困在抽屉内（画布仍可点、面板错位居中）。 */
.rp-mask {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--text) 28%, transparent);
}

.rp-panel {
  display: flex;
  flex-direction: column;
  width: min(520px, calc(100% - 32px));
  max-height: min(480px, calc(100% - 32px));
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-popup);
  overflow: hidden;
}

.rp-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  flex: none;
}

.rp-title {
  font-weight: 600;
}

.rp-filter {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border-bottom: 1px solid var(--border);
}

.rp-search {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  padding: 0 8px;
}
.rp-search:focus-within {
  border-color: var(--accent);
}
.rp-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  color: var(--text);
  font: inherit;
  padding: 5px 0;
}

.rp-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.rp-tag {
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-panel);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 18px;
  cursor: pointer;
}
.rp-tag:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.rp-tag.active {
  background: var(--bg-selected);
  border-color: var(--accent);
  color: var(--accent);
}

.rp-list {
  flex: 1;
  min-height: 120px;
  overflow-y: auto;
  padding: var(--space-1);
}

.rp-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  color: var(--danger);
  font-size: 12px;
}

.rp-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px var(--space-2);
  border-radius: var(--radius-md);
  cursor: pointer;
}
.rp-row:hover {
  background: var(--bg-hover);
}
.rp-row.selected {
  background: var(--bg-selected);
}

.rp-method {
  flex: none;
  width: 46px;
  padding: 0 4px;
  border-radius: var(--radius-sm);
  font-size: 10px;
  font-weight: 600;
  text-align: center;
  line-height: 16px;
}
.m-get {
  background: color-mix(in srgb, var(--success) 16%, transparent);
  color: var(--success);
}
.m-post {
  background: color-mix(in srgb, var(--warning) 16%, transparent);
  color: var(--warning);
}
.m-put {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}
.m-delete {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}
.m-other {
  background: var(--bg-active);
  color: var(--text-secondary);
}

.rp-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.rp-row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.rp-row-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
}

.rp-row-side {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}
.rp-source {
  padding: 0 5px;
  border-radius: 6px;
  background: var(--bg-active);
  color: var(--text-secondary);
  font-size: 9px;
  line-height: 14px;
}
.rp-row-tag {
  padding: 0 5px;
  border-radius: 6px;
  border: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 9px;
  line-height: 13px;
}

.rp-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border-top: 1px solid var(--border);
}

.rp-preview {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 11px;
}
.rp-preview-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rp-preview > span:not(.rp-preview-name) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
