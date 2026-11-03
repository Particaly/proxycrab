<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Io5Checkmark, Io5Close, Io5Copy, Io5Create, Io5Trash } from "vue-icons-plus/io5";
import BodyViewer from "../BodyViewer.vue";
import type { RequestLibraryEntry } from "../../api/types";
import type { BodyTarget } from "../../api/body";
import { appStore } from "../../stores/app";
import { openDropdownMenu } from "../../stores/dialog";

import { copyText as writeClipboardText } from "../../utils/clipboard";
import { formatBytes, formatDateTimeWithZone, formatRelativeTime } from "../../utils/format";
import {
  SOURCE_LABELS,
  parseTagInput,
  requestHeaders,
  requestResponse,
  requestBodyPayload,
  tagsEqual,
} from "./request-library-view";

/**
 * 请求库右栏详情：可编辑名称与标签的头部信息卡 + Headers / Query / Body /
 * Response 四 tab。名称/标签经 PUT 部分更新（id/source/createdAt 不可改）；
 * Body 复用 BodyViewer（请求体经请求库 body 端点取原始字节）。
 * 数据与回调经 props/emits 由窗口注入。
 */
const props = defineProps<{
  entry: RequestLibraryEntry;
  saving: boolean;
}>();

const emit = defineEmits<{
  updateMeta: [patch: { name?: string; tags?: string[] }];
  remove: [];
}>();

type DetailTab = "headers" | "query" | "body" | "response";

const activeTab = ref<DetailTab>("headers");

const tabs: Array<{ key: DetailTab; label: string }> = [
  { key: "headers", label: "Headers" },
  { key: "query", label: "Query" },
  { key: "body", label: "Body" },
  { key: "response", label: "Response" },
];

const headers = computed(() => requestHeaders(props.entry));
const queryParams = computed(() => props.entry.har?.log?.entries?.[0]?.request?.queryString ?? []);
const response = computed(() => requestResponse(props.entry));
const bodyPayload = computed(() => requestBodyPayload(props.entry));
const bodyTarget = computed<BodyTarget>(() => ({ kind: "request-library", id: props.entry.id }));
const bodySize = computed(() => (bodyPayload.value.type === "empty" ? 0 : bodyPayload.value.size));

// ---------- 名称编辑 ----------

const nameEditing = ref(false);
const nameDraft = ref("");
const nameInput = ref<HTMLInputElement | null>(null);

watch(nameEditing, async (editing) => {
  if (editing) {
    nameDraft.value = props.entry.name;
    await nextTick();
    nameInput.value?.select();
  }
});

function commitNameEdit(): void {
  if (!nameEditing.value || props.saving) return;
  const next = nameDraft.value.trim();
  nameEditing.value = false;
  // 去空白后为空（视为取消）或与原名一致：不发起保存。
  if (next === "" || next === props.entry.name) return;
  emit("updateMeta", { name: next });
}

// ---------- 标签编辑 ----------

const tagDraft = ref("");

function commitTagDraft(): void {
  if (props.saving) return;
  const parsed = parseTagInput(tagDraft.value);
  tagDraft.value = "";
  if (parsed.length === 0) return;
  const merged = [...props.entry.tags];
  for (const tag of parsed) if (!merged.includes(tag)) merged.push(tag);
  if (!tagsEqual(merged, props.entry.tags)) emit("updateMeta", { tags: merged });
}

function removeTag(tag: string): void {
  if (props.saving) return;
  emit("updateMeta", { tags: props.entry.tags.filter((existing) => existing !== tag) });
}

// ---------- 复制 ----------

const copied = ref<string | null>(null);
let copiedTimer: number | undefined;

async function copy(key: string, value: string): Promise<void> {
  try {
    await writeClipboardText(value);
    copied.value = key;
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => (copied.value = null), 1200);
  } catch {
    appStore.toast("复制失败", "error");
  }
}

function openCopyMenu(event: MouseEvent): void {
  openDropdownMenu(event.currentTarget as HTMLElement, [
    {
      label: "复制名称",
      icon: Io5Copy,
      action: () => void copy("name", props.entry.name),
    },
    {
      label: "复制 URL",
      icon: Io5Copy,
      action: () => void copy("url", props.entry.har?.log?.entries?.[0]?.request?.url ?? ""),
    },
  ]);
}

function statusClass(status: number): string {
  if (status >= 200 && status < 300) return "s-2xx";
  if (status >= 300 && status < 400) return "s-3xx";
  if (status >= 400 && status < 500) return "s-4xx";
  if (status >= 500) return "s-5xx";
  return "s-other";
}
</script>

<template>
  <div class="rl-detail">
    <header class="rl-head">
      <div class="rl-head-line">
        <template v-if="nameEditing">
          <input
            ref="nameInput"
            v-model="nameDraft"
            class="input rl-name-input"
            aria-label="请求名称"
            maxlength="256"
            :disabled="saving"
            @keydown.enter.prevent="commitNameEdit"
            @keydown.esc="nameEditing = false"
            @blur="commitNameEdit"
          />
        </template>
        <template v-else>
          <span class="rl-name" :title="entry.name">{{ entry.name }}</span>
          <button
            class="btn icon"
            title="重命名"
            aria-label="重命名请求"
            :disabled="saving"
            @click="nameEditing = true"
          >
            <Io5Create :size="13" />
          </button>
        </template>
        <span v-if="saving" class="rl-saving">保存中…</span>
        <span class="rl-head-spacer" />
        <button class="btn icon" title="复制" @click="openCopyMenu">
          <Io5Checkmark
            v-if="copied === 'name' || copied === 'url'"
            :size="13"
            class="text-success"
          />
          <Io5Copy v-else :size="13" />
        </button>
        <button class="btn danger" :disabled="saving" title="删除该条目" @click="emit('remove')">
          <Io5Trash :size="13" /> 删除
        </button>
      </div>
      <div class="rl-head-line rl-tags-line">
        <span
          v-for="tag in entry.tags"
          :key="tag"
          class="rl-tag-chip"
          role="button"
          :title="`删除标签 ${tag}`"
          @click="removeTag(tag)"
        >
          {{ tag }}
          <Io5Close :size="9" />
        </span>
        <input
          v-model="tagDraft"
          class="input rl-tag-input"
          type="text"
          placeholder="添加标签，回车确认"
          :disabled="saving"
          spellcheck="false"
          @keydown.enter.prevent="commitTagDraft"
        />
      </div>
      <div class="rl-meta">
        <span class="meta-item">
          <span class="meta-label">来源</span>
          <span class="source-chip" :class="`src-${entry.source}`">{{
            SOURCE_LABELS[entry.source]
          }}</span>
        </span>
        <span class="meta-item">
          <span class="meta-label">页面</span>
          <span class="rl-meta-value" :title="entry.origin">{{
            entry.origin === "" ? "—" : entry.origin
          }}</span>
        </span>
        <span class="meta-item" :title="formatDateTimeWithZone(entry.createdAt)">
          <span class="meta-label">创建</span>{{ formatRelativeTime(entry.createdAt) }}
        </span>
        <span class="meta-item" :title="formatDateTimeWithZone(entry.updatedAt)">
          <span class="meta-label">更新</span>{{ formatRelativeTime(entry.updatedAt) }}
        </span>
        <span v-if="bodyPayload.type !== 'empty'" class="meta-item">
          <span class="meta-label">请求体</span>{{ formatBytes(bodySize) }}
        </span>
        <span v-if="response" class="meta-item">
          <span class="meta-label">响应</span>
          <span class="mono rl-meta-status" :class="statusClass(response.status)">{{
            response.status
          }}</span>
          <span v-if="response.content && response.content.size > 0" class="rl-meta-value">
            {{ formatBytes(response.content.size) }}
          </span>
        </span>
      </div>
    </header>

    <nav class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </nav>

    <div v-show="activeTab === 'headers'" class="tab-page">
      <section class="card">
        <div class="card-title">
          请求头
          <span class="count-badge">{{ headers.length }}</span>
        </div>
        <table v-if="headers.length > 0" class="kv-table">
          <tbody>
            <tr v-for="(h, i) in headers" :key="i">
              <td class="mono kv-name">{{ h.name }}</td>
              <td class="mono kv-value">{{ h.value }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty-hint">无请求头</div>
      </section>
    </div>

    <div v-show="activeTab === 'query'" class="tab-page">
      <section class="card">
        <div class="card-title">
          Query 参数
          <span class="count-badge">{{ queryParams.length }}</span>
        </div>
        <table v-if="queryParams.length > 0" class="kv-table">
          <tbody>
            <tr v-for="(p, i) in queryParams" :key="i">
              <td class="mono kv-name">{{ p.name }}</td>
              <td class="mono kv-value">{{ p.value }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty-hint">无 Query 参数</div>
      </section>
    </div>

    <div v-show="activeTab === 'body'" class="tab-page tab-page-body">
      <BodyViewer
        label="请求体"
        :body="bodyPayload"
        :headers="headers"
        side="request"
        :target="bodyTarget"
      />
    </div>

    <div v-show="activeTab === 'response'" class="tab-page">
      <template v-if="response">
        <section class="card">
          <div class="card-title">
            响应状态
            <span class="card-title-extra mono">{{ response.httpVersion || "" }}</span>
          </div>
          <div class="rl-response-status">
            <span class="mono rl-meta-status status-large" :class="statusClass(response.status)">
              {{ response.status }}
            </span>
            <span class="mono">{{ response.statusText }}</span>
            <span v-if="response.content" class="rl-meta-value mono">
              {{ response.content.mimeType || "未知类型" }} ·
              {{ response.content.size >= 0 ? formatBytes(response.content.size) : "大小未知" }}
            </span>
          </div>
        </section>
        <section class="card">
          <div class="card-title">
            响应头
            <span class="count-badge">{{ response.headers?.length ?? 0 }}</span>
          </div>
          <table v-if="(response.headers?.length ?? 0) > 0" class="kv-table">
            <tbody>
              <tr v-for="(h, i) in response.headers" :key="i">
                <td class="mono kv-name">{{ h.name }}</td>
                <td class="mono kv-value">{{ h.value }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty-hint">无响应头</div>
        </section>
      </template>
      <div v-else class="empty-hint rl-response-empty">无响应（入库快照未包含上游响应）</div>
    </div>
  </div>
</template>

<style scoped>
.rl-detail {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
}

.rl-head {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
}

.rl-head-line {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.rl-head-spacer {
  flex: 1;
}

.rl-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 14px;
}

.rl-name-input {
  flex: 1;
  min-width: 0;
}

.rl-saving {
  flex: none;
  color: var(--text-faint);
  font-size: 11px;
}

.rl-tags-line {
  flex-wrap: wrap;
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
  border-color: var(--danger);
  color: var(--danger);
}

.rl-tag-input {
  width: 150px;
  padding: 2px 8px;
  font-size: 11px;
}

.rl-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-3);
  min-width: 0;
}

.meta-item {
  font-size: 11px;
  color: var(--text);
  font-family: var(--font-mono);
  min-width: 0;
}

.meta-label {
  color: var(--text-faint);
  font-family: var(--font-ui);
  margin-right: 5px;
}

.rl-meta-value {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
  vertical-align: bottom;
}

.rl-meta-status {
  font-weight: 700;
}

.status-large {
  font-size: 16px;
}

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

/* ---------- tabs（与 LogDetailWindow 同形态） ---------- */

.tab-bar {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--border);
}

.tab-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 14px 7px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  border-radius: 6px 6px 0 0;
}

.tab-btn:hover:not(.active) {
  color: var(--text);
  background: var(--bg-hover);
}

.tab-btn.active {
  color: var(--accent);
  font-weight: 600;
}

.tab-btn.active::after {
  content: "";
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
}

.tab-page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.tab-page-body {
  padding: var(--space-2);
}

.rl-response-status {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}

.rl-response-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.s-2xx {
  color: var(--success);
}
.s-3xx {
  color: var(--accent);
}
.s-4xx {
  color: var(--warning);
}
.s-5xx {
  color: var(--danger);
}
.s-other {
  color: var(--text-secondary);
}

.card {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  overflow: hidden;
  flex: none;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
  background: var(--bg-app);
  position: sticky;
  top: 0;
  z-index: 1;
}

.card-title-extra {
  margin-left: auto;
  font-weight: 400;
  color: var(--text-faint);
}

.count-badge {
  font-size: 10px;
  font-weight: 500;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--bg-active);
}

.kv-table {
  width: 100%;
  border-collapse: collapse;
}

.kv-table tr + tr {
  border-top: 1px solid var(--border);
}

.kv-table tr:hover {
  background: var(--bg-hover);
}

.kv-table td {
  padding: 4px 10px;
  vertical-align: top;
  font-size: 11px;
}

.kv-name {
  color: var(--text);
  white-space: nowrap;
  width: 1%;
  padding-right: 16px;
}

.kv-value {
  color: var(--success);
  word-break: break-all;
}
</style>
