<script setup lang="ts">
import { computed, ref } from "vue";
import type { CurlParsedRequest, ImportRequestItem, ImportSkipped, ImportSubmitOutcome, ImportSubmitPayload } from "../../utils/request-library-import";
import {
  buildCurlItem,
  buildDefaultRequestName,
  parseCurlCommand,
  parseHarImport,
  parsePostmanImport,
} from "../../utils/request-library-import";
import { errorMessage } from "../../utils/har-export";
import { parseTagInput } from "./request-library-view";

/**
 * 请求库导入对话框（ReqFlow 复刻 Task 8 Step 3）：三个标签页——
 *   - cURL 命令：粘贴命令 → 「解析」得到预览（方法 / 默认名 / 头·查询·Cookie·体摘要）
 *     → 确认导入；解析失败行内报错。
 *   - HAR 文件 / Postman Collection：选择文件 → 条目多选预览（默认全选，可全选 /
 *     全不选与逐条勾选）→ 批量导入；损坏条目跳过并提示条数；文件级失败行内报错。
 *
 * 解析全部在纯函数模块 request-library-import.ts；本组件只做状态编排。
 * 落库经 importRequests 回调（窗口注入：去重执行 + 逐条 create + 列表刷新），
 * 全部成功即关闭弹窗，部分失败行内提示结果并保持打开。
 */
const props = defineProps<{
  /** 执行导入（窗口注入）。resolve 后按 failed 数决定关闭或展示结果。 */
  importRequests: (payload: ImportSubmitPayload) => Promise<ImportSubmitOutcome>;
}>();

const emit = defineEmits<{ close: [] }>();

/** 标签页取值。 */
type ImportTab = "curl" | "har" | "postman";

const TAB_OPTIONS: ReadonlyArray<{ value: ImportTab; label: string }> = [
  { value: "curl", label: "cURL 命令" },
  { value: "har", label: "HAR 文件" },
  { value: "postman", label: "Postman Collection" },
];

const tab = ref<ImportTab>("curl");

// cURL 页：输入原文 / 解析结果 / 解析错误
const curlText = ref("");
const curlParsed = ref<CurlParsedRequest | null>(null);
const curlError = ref("");

// 文件页（HAR / Postman 共用一套状态，切换文件类型时清空）
const fileItems = ref<ImportRequestItem[] | null>(null);
const fileSkipped = ref<ImportSkipped[]>([]);
const fileSelected = ref<Set<number>>(new Set());
const fileError = ref("");

// 公共：标签 / 去重策略 / 提交状态
const tagsDraft = ref("");
const skipDuplicates = ref(true);
const importing = ref(false);
const resultMessage = ref("");

/** 解析 cURL 命令（「解析」按钮）：成功设置预览，失败行内报错。 */
function parseCurl(): void {
  resultMessage.value = "";
  const result = parseCurlCommand(curlText.value);
  if (result.ok) {
    curlParsed.value = result.request;
    curlError.value = "";
  } else {
    curlParsed.value = null;
    curlError.value = result.error;
  }
}

/** 选择 HAR / Postman 文件：读文本 → 解析 → 默认全选；文件级失败行内报错。 */
async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // 允许重复选择同一文件
  resultMessage.value = "";
  fileError.value = "";
  fileItems.value = null;
  fileSkipped.value = [];
  fileSelected.value = new Set();
  if (!file) return;
  try {
    const text = await file.text();
    const result = tab.value === "har" ? parseHarImport(text) : parsePostmanImport(text);
    if (result.ok) {
      fileItems.value = result.items;
      fileSkipped.value = result.skipped;
      fileSelected.value = new Set(result.items.map((_, index) => index));
    } else {
      fileError.value = result.error;
    }
  } catch (error) {
    fileError.value = errorMessage(error);
  }
}

const fileSelectedCount = computed(() =>
  fileItems.value === null ? 0 : fileItems.value.filter((_, index) => fileSelected.value.has(index)).length,
);
const fileAllSelected = computed(
  () => fileItems.value !== null && fileItems.value.length > 0 && fileSelected.value.size === fileItems.value.length,
);

function toggleFileItem(index: number): void {
  const next = new Set(fileSelected.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  fileSelected.value = next;
}

function toggleAllFileItems(): void {
  fileSelected.value =
    fileItems.value !== null && fileSelected.value.size === fileItems.value.length
      ? new Set<number>()
      : new Set((fileItems.value ?? []).map((_, index) => index));
}

/** 待提交条目（cURL 页为解析产物；文件页为勾选条目）。 */
function pendingItems(): ImportRequestItem[] {
  if (tab.value === "curl") return curlParsed.value === null ? [] : [buildCurlItem(curlParsed.value)];
  return (fileItems.value ?? []).filter((_, index) => fileSelected.value.has(index));
}

const pendingCount = computed(() => pendingItems().length);

/** 统一提交：busy 期间忽略重复提交；全部成功关闭，否则行内展示结果。 */
async function submit(): Promise<void> {
  const items = pendingItems();
  if (items.length === 0 || importing.value) return;
  importing.value = true;
  resultMessage.value = "";
  try {
    const outcome = await props.importRequests({
      items,
      tags: parseTagInput(tagsDraft.value),
      skipDuplicates: skipDuplicates.value,
    });
    if (outcome.failed === 0) {
      emit("close");
      return;
    }
    const parts = [`成功 ${outcome.imported} 条`, `失败 ${outcome.failed} 条`];
    if (outcome.skipped > 0) parts.push(`跳过重复 ${outcome.skipped} 条`);
    resultMessage.value = `导入完成：${parts.join("，")}（失败详情见应用提示）`;
  } catch (error) {
    resultMessage.value = `导入失败：${errorMessage(error)}`;
  } finally {
    importing.value = false;
  }
}

/** cURL 预览摘要（头 / 查询 / Cookie / 体计数）。 */
function curlSummary(parsed: CurlParsedRequest): string {
  const parts = [`请求头 ${parsed.headers.length} 个`];
  if (parsed.queryString.length > 0) parts.push(`查询参数 ${parsed.queryString.length} 个`);
  if (parsed.cookies.length > 0) parts.push(`Cookie ${parsed.cookies.length} 个`);
  parts.push(parsed.body !== undefined ? "含请求体" : "无请求体");
  return parts.join(" · ");
}
</script>

<template>
  <Teleport to="body">
    <div class="import-mask" @click.self="emit('close')">
      <div class="import-box">
        <div class="import-head">
          <span>导入请求</span>
          <button class="btn icon" aria-label="关闭" @click="emit('close')">×</button>
        </div>

        <div class="import-tabs" role="tablist" aria-label="导入方式">
          <button
            v-for="option in TAB_OPTIONS"
            :key="option.value"
            type="button"
            role="tab"
            class="import-tab"
            :class="{ active: tab === option.value }"
            :aria-selected="tab === option.value"
            @click="tab = option.value"
          >
            {{ option.label }}
          </button>
        </div>

        <div v-if="resultMessage" class="import-result">{{ resultMessage }}</div>

        <!-- cURL 命令页 -->
        <div v-if="tab === 'curl'" class="import-body">
          <p class="import-hint">粘贴完整的 curl 命令（支持多行续行与引号转义），解析确认后入库。</p>
          <textarea
            v-model="curlText"
            class="input import-curl-input mono"
            rows="5"
            spellcheck="false"
            placeholder='curl -X POST "https://api.example.com/v1/orders" \'
          ></textarea>
          <div class="import-actions-row">
            <button class="btn" :disabled="importing" @click="parseCurl()">解析</button>
          </div>
          <div v-if="curlError" class="import-error" role="alert">{{ curlError }}</div>
          <div v-if="curlParsed" class="import-preview">
            <div class="import-preview-line">
              <span class="import-method" :class="curlParsed.method === 'GET' ? 'm-get' : 'm-other'">{{
                curlParsed.method
              }}</span>
              <span class="import-name" :title="curlParsed.url">{{
                buildDefaultRequestName(curlParsed.method, curlParsed.url)
              }}</span>
            </div>
            <div class="import-preview-sub">{{ curlSummary(curlParsed) }}</div>
          </div>
        </div>

        <!-- HAR / Postman 文件页 -->
        <div v-else class="import-body">
          <p class="import-hint">
            {{
              tab === "har"
                ? "选择导出的 HAR 1.2 文件（.har / .json），勾选需要的条目批量入库。"
                : "选择 Postman Collection v2.1 文件（.json），请求条目批量入库（目录递归展开）。"
            }}
          </p>
          <input
            :key="tab"
            type="file"
            class="import-file"
            :aria-label="tab === 'har' ? '选择 HAR 文件' : '选择 Postman Collection 文件'"
            accept=".har,.json,application/json"
            @change="onFileChange"
          />
          <div v-if="fileError" class="import-error" role="alert">{{ fileError }}</div>
          <template v-if="fileItems !== null">
            <div v-if="fileItems.length === 0" class="import-empty">该文件未包含请求条目</div>
            <div v-else class="import-file-list">
              <div class="import-file-head">
                <span>共 {{ fileItems.length }} 条 · 已选 {{ fileSelectedCount }} 条</span>
                <button class="btn" @click="toggleAllFileItems()">
                  {{ fileAllSelected ? "全不选" : "全选" }}
                </button>
              </div>
              <p
                v-if="fileSkipped.length > 0"
                class="import-skipped"
                :title="fileSkipped.map((item) => `#${item.index + 1} ${item.reason}`).join('\n')"
              >
                已跳过 {{ fileSkipped.length }} 条无法解析的条目
              </p>
              <div class="import-rows">
                <label
                  v-for="(item, index) in fileItems"
                  :key="`${index}:${item.url}`"
                  class="import-row"
                >
                  <input
                    type="checkbox"
                    :checked="fileSelected.has(index)"
                    :aria-label="`选择条目 ${item.method} ${item.url}`"
                    @change="toggleFileItem(index)"
                  />
                  <span class="import-method" :class="item.method === 'GET' ? 'm-get' : 'm-other'">{{
                    item.method
                  }}</span>
                  <span v-if="item.status >= 0" class="import-status">{{ item.status }}</span>
                  <span class="import-name" :title="item.url">{{ item.url }}</span>
                </label>
              </div>
            </div>
          </template>
        </div>

        <!-- 公共：标签与去重策略 -->
        <div class="import-options">
          <input
            v-model="tagsDraft"
            class="input import-tags"
            type="text"
            placeholder="标签，逗号分隔（可空）"
            spellcheck="false"
          />
          <label class="import-dedup" title="按「方法 + URL」识别库内已有请求，重复条目不再导入">
            <input v-model="skipDuplicates" type="checkbox" />
            <span>跳过库内已有请求（同方法 + URL）</span>
          </label>
        </div>

        <div class="import-foot">
          <button class="btn" :disabled="importing" @click="emit('close')">取消</button>
          <button class="btn primary" :disabled="pendingCount === 0 || importing" @click="submit()">
            {{ importing ? "导入中…" : pendingCount === 0 ? "导入" : `导入 ${pendingCount} 条` }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.import-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100001;
}

.import-box {
  width: 620px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-window);
  padding: var(--space-3);
  gap: var(--space-2);
}

.import-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 600;
}

.import-tabs {
  display: flex;
  gap: var(--space-1);
}

.import-tab {
  padding: 2px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-app);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 20px;
  cursor: pointer;
}

.import-tab:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

.import-tab.active {
  border-color: var(--accent);
  background: var(--bg-selected);
  color: var(--accent);
}

.import-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
}

.import-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.import-curl-input {
  width: 100%;
  resize: vertical;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}

.import-actions-row {
  display: flex;
  justify-content: flex-start;
}

.import-error {
  font-size: 12px;
  color: var(--danger);
  word-break: break-all;
}

.import-result {
  font-size: 12px;
  color: var(--warning);
  word-break: break-all;
}

.import-preview {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-app);
}

.import-preview-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.import-preview-sub {
  font-size: 11px;
  color: var(--text-secondary);
}

.import-method {
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

.m-other {
  background: var(--text-faint);
}

.import-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
}

.import-file {
  font-size: 12px;
  color: var(--text-secondary);
}

.import-empty {
  padding: var(--space-3);
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary);
}

.import-file-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-height: 0;
}

.import-file-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-secondary);
}

.import-skipped {
  margin: 0;
  font-size: 11px;
  color: var(--warning);
  cursor: default;
}

.import-rows {
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-app);
}

.import-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 3px var(--space-2);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}

.import-row:last-child {
  border-bottom: none;
}

.import-row:hover {
  background: var(--bg-hover);
}

.import-status {
  flex: none;
  min-width: 24px;
  text-align: right;
  font-size: 10px;
  color: var(--text-faint);
}

.import-options {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.import-tags {
  flex: 1;
  min-width: 180px;
  padding: 3px 8px;
  font-size: 12px;
}

.import-dedup {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}

.import-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
