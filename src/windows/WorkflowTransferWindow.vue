<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Io5Refresh } from "vue-icons-plus/io5";
import { useBackend } from "../api";
import { selectFile } from "../api/select-file";
import type {
  FlowProject,
  Workflow,
  WorkflowExportEnvelope,
  WorkflowImportResult,
} from "../api/types";
import {
  confirmedScriptKeys,
  downloadWorkflowExport,
  inspectWorkflowEnvelope,
  SCRIPT_KIND_LABELS,
  WORKFLOW_EXPORT_FILENAME,
  type ImportedScriptRef,
  type WorkflowEnvelopeSummary,
} from "../api/workflow-transfer";
import { getWorkflowNodeMeta } from "../components/flow/node-meta";
import { appStore, reportError } from "../stores/app";
import { errorMessage } from "../utils/har-export";
import { formatDateTime, formatRelativeTime } from "../utils/format";

/**
 * 工作流导入导出窗口（ReqFlow 复刻 Task 23 薄片 C）：两个标签页——
 *   - 导出：项目分组的流程多选列表 → 「导出并下载」拉取服务端原始信封
 *     （secret 值已置空），经既有 saveFile 通路落盘为 reqflow-workflows.json。
 *   - 导入：选择信封文件 → 解析预览（版本/流程/脚本/请求条目/环境集计数）→
 *     脚本逐条确认清单（缺省全不勾，未勾选脚本将被置空）→ 目标项目 →
 *     提交 → 结果面板（成功/跳过+原因/issues、requests/envSets 逐条裁决）。
 * 入口依赖 Backend.workflows 能力位（launcher 把关）。
 */
const backend = useBackend();

type TransferTab = "export" | "import";
const tab = ref<TransferTab>("export");

// ---- 导出页：项目分组流程多选 ----

interface ProjectWorkflows {
  project: FlowProject;
  workflows: Workflow[];
}

const groups = ref<ProjectWorkflows[]>([]);
const loadingExport = ref(false);
const exportError = ref<string | null>(null);
/** 已勾选的流程 id（跨项目；导出顺序按列表分组顺序）。 */
const checkedIds = ref<string[]>([]);
const exporting = ref(false);
const exportFeedback = ref<string | null>(null);
let exportFeedbackTimer: number | undefined;

const allWorkflows = computed(() => groups.value.flatMap((group) => group.workflows));
const canExport = computed(() => checkedIds.value.length > 0 && !exporting.value);

function showExportFeedback(message: string): void {
  exportFeedback.value = message;
  if (exportFeedbackTimer !== undefined) window.clearTimeout(exportFeedbackTimer);
  exportFeedbackTimer = window.setTimeout(() => {
    exportFeedbackTimer = undefined;
    exportFeedback.value = null;
  }, 2000);
}

async function loadExportData(): Promise<void> {
  const api = backend.workflows;
  if (!api) return;
  loadingExport.value = true;
  exportError.value = null;
  try {
    const { projects } = await api.listProjects();
    const knownIds = new Set(allWorkflows.value.map((workflow) => workflow.id));
    const next: ProjectWorkflows[] = [];
    for (const project of projects) {
      const { workflows } = await api.listWorkflows(project.id);
      next.push({ project, workflows });
      for (const workflow of workflows) knownIds.add(workflow.id);
    }
    groups.value = next;
    // 刷新后丢弃已不存在的勾选，保留仍然在列的勾选。
    checkedIds.value = checkedIds.value.filter((id) => knownIds.has(id));
  } catch (error) {
    exportError.value = reportError(error, "加载工作流列表失败");
  } finally {
    loadingExport.value = false;
  }
}

function toggleWorkflow(id: string): void {
  checkedIds.value = checkedIds.value.includes(id)
    ? checkedIds.value.filter((current) => current !== id)
    : [...checkedIds.value, id];
}

function toggleAllWorkflows(): void {
  const all = allWorkflows.value;
  const allChecked = all.length > 0 && checkedIds.value.length === all.length;
  checkedIds.value = allChecked ? [] : all.map((workflow) => workflow.id);
}

/** 执行一次导出：拉取原始信封并经既有 saveFile 通路下载（用户取消不提示）。 */
async function runExport(): Promise<void> {
  const api = backend.workflows;
  if (!api || !canExport.value) return;
  exporting.value = true;
  exportError.value = null;
  try {
    const envelope = await api.exportWorkflows(checkedIds.value);
    const saved = await downloadWorkflowExport(backend, envelope);
    if (saved) showExportFeedback(`已开始下载 ${WORKFLOW_EXPORT_FILENAME}`);
  } catch (error) {
    exportError.value = `导出失败：${errorMessage(error)}`;
  } finally {
    exporting.value = false;
  }
}

// ---- 导入页：文件解析预览 + 脚本确认 + 结果面板 ----

const envelope = ref<WorkflowExportEnvelope | null>(null);
const summary = ref<WorkflowEnvelopeSummary | null>(null);
const importFileName = ref("");
const parseError = ref("");
/** 已确认保留的脚本键（`workflowIndex:nodeIndex:kind`）；缺省全不勾 = 全部置空。 */
const confirmedScripts = ref<Set<string>>(new Set());
/** 导入副本的目标项目 id（必选）。 */
const targetProjectId = ref("");
const importing = ref(false);
const importError = ref<string | null>(null);
const importResult = ref<WorkflowImportResult | null>(null);

/** 解析信封文件：校验口径与服务端 parse_workflow_import 一致。 */
async function pickEnvelope(): Promise<void> {
  const file = await selectFile(".json,application/json");
  if (!file) return;
  parseError.value = "";
  importError.value = null;
  importResult.value = null;
  envelope.value = null;
  summary.value = null;
  confirmedScripts.value = new Set();
  importFileName.value = file.name;
  try {
    const parsed: unknown = JSON.parse(await file.text());
    const result = inspectWorkflowEnvelope(parsed);
    if (!result.ok) {
      parseError.value = result.reason;
      return;
    }
    envelope.value = parsed as WorkflowExportEnvelope;
    summary.value = result.summary;
  } catch {
    parseError.value = "文件不是合法的 JSON";
  }
}

function toggleScript(key: string): void {
  const next = new Set(confirmedScripts.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  confirmedScripts.value = next;
}

function toggleAllScripts(): void {
  const scripts = summary.value?.scripts ?? [];
  const allChecked = scripts.length > 0 && confirmedScripts.value.size === scripts.length;
  confirmedScripts.value = allChecked ? new Set() : new Set(scripts.map((script) => script.key));
}

/** 审查清单的节点定位文案：节点类型中文标签 + 原始节点 id（导入时会被重映射）。 */
function nodeLabel(script: ImportedScriptRef): string {
  return `${getWorkflowNodeMeta(script.nodeType).label} ${script.nodeId}`;
}

const canImport = computed(
  () => envelope.value !== null && targetProjectId.value !== "" && !importing.value,
);

/** 提交导入：勾选清单非空时才携带 confirmScripts，键构造排序保证请求体确定。 */
async function runImport(): Promise<void> {
  const api = backend.workflows;
  const file = envelope.value;
  if (!api || !file || targetProjectId.value === "" || importing.value) return;
  importing.value = true;
  importError.value = null;
  try {
    importResult.value = await api.importWorkflows({
      file,
      projectId: targetProjectId.value,
      confirmScripts: confirmedScripts.value.size > 0,
      confirmedScripts: confirmedScriptKeys(confirmedScripts.value),
    });
    appStore.toast("工作流导入完成", "success");
  } catch (error) {
    importError.value = `导入失败：${errorMessage(error)}`;
  } finally {
    importing.value = false;
  }
}

onMounted(() => {
  void loadExportData();
});

onBeforeUnmount(() => {
  if (exportFeedbackTimer !== undefined) window.clearTimeout(exportFeedbackTimer);
});
</script>

<template>
  <div class="wt-root">
    <div class="wt-tabs" role="tablist" aria-label="导入导出方式">
      <button
        type="button"
        role="tab"
        class="wt-tab"
        :class="{ active: tab === 'export' }"
        :aria-selected="tab === 'export'"
        @click="tab = 'export'"
      >
        导出
      </button>
      <button
        type="button"
        role="tab"
        class="wt-tab"
        :class="{ active: tab === 'import' }"
        :aria-selected="tab === 'import'"
        @click="tab = 'import'"
      >
        导入
      </button>
    </div>

    <!-- 导出页 -->
    <div v-if="tab === 'export'" class="wt-page">
      <div class="wt-toolbar">
        <span class="wt-count">
          共 {{ allWorkflows.length }} 条流程 · 已选 {{ checkedIds.length }} 条
        </span>
        <span class="wt-spacer" />
        <button class="btn" :disabled="allWorkflows.length === 0" @click="toggleAllWorkflows()">
          {{
            checkedIds.length === allWorkflows.length && allWorkflows.length > 0 ? "全不选" : "全选"
          }}
        </button>
        <button class="btn icon" title="刷新列表" @click="loadExportData()">
          <Io5Refresh :size="14" />
        </button>
      </div>

      <div v-if="exportError" class="wt-error" role="alert">{{ exportError }}</div>

      <div class="wt-list">
        <div v-if="loadingExport && groups.length === 0" class="empty-hint">正在加载…</div>
        <template v-else>
          <template v-for="group in groups" :key="group.project.id">
            <div v-if="group.workflows.length > 0" class="wt-group">
              <span
                class="wt-project-dot"
                :style="{ background: group.project.color || 'var(--accent)' }"
              />
              <span class="wt-group-name" :title="group.project.name">
                {{ group.project.name }}
              </span>
              <span class="badge">{{ group.workflows.length }}</span>
            </div>
            <label v-for="workflow in group.workflows" :key="workflow.id" class="wt-row">
              <input
                type="checkbox"
                :checked="checkedIds.includes(workflow.id)"
                :aria-label="`选择流程 ${workflow.name}`"
                @change="toggleWorkflow(workflow.id)"
              />
              <span class="wt-row-name" :title="workflow.name">{{ workflow.name }}</span>
              <span class="wt-row-meta">
                {{ workflow.nodes.length }}节点 · {{ formatRelativeTime(workflow.updatedAt) }}
              </span>
            </label>
          </template>
          <div v-if="!loadingExport && allWorkflows.length === 0" class="empty-hint">
            {{ groups.length === 0 ? "暂无项目，请先在工作流编辑器新建项目" : "暂无流程" }}
          </div>
        </template>
      </div>

      <div class="wt-foot">
        <span v-if="exportFeedback" class="wt-feedback" aria-live="polite">
          {{ exportFeedback }}
        </span>
        <span class="wt-spacer" />
        <button class="btn primary" :disabled="!canExport" @click="runExport()">
          {{
            exporting
              ? "导出中…"
              : checkedIds.length > 0
                ? `导出并下载 ${checkedIds.length} 条`
                : "导出并下载"
          }}
        </button>
      </div>
    </div>

    <!-- 导入页 -->
    <div v-else class="wt-page">
      <div class="wt-file-row">
        <button class="btn" @click="pickEnvelope()">
          {{ envelope ? "重新选择文件" : "选择导出文件" }}
        </button>
        <span v-if="importFileName" class="wt-file-name mono" :title="importFileName">
          {{ importFileName }}
        </span>
        <span v-else class="wt-file-hint">
          选择 ReqFlow 导出的 {{ WORKFLOW_EXPORT_FILENAME }}（.json）
        </span>
      </div>

      <div v-if="parseError" class="wt-error" role="alert">{{ parseError }}</div>
      <div v-if="importError" class="wt-error" role="alert">{{ importError }}</div>

      <template v-if="summary && envelope">
        <div class="wt-summary">
          <span>版本 v{{ summary.version }}</span>
          <span>流程 {{ summary.workflowCount }}</span>
          <span>可执行脚本 {{ summary.scriptCount }}</span>
          <span>请求条目 {{ summary.requestCount }}</span>
          <span>环境集 {{ summary.envSetCount }}</span>
          <span v-if="summary.exportedAt > 0" class="wt-summary-time">
            导出于 {{ formatDateTime(summary.exportedAt) }}
          </span>
        </div>
        <div
          class="wt-wf-names"
          :title="summary.workflowNames.map((name, index) => `#${index} ${name}`).join('\n')"
        >
          流程：{{ summary.workflowNames.join("、") }}
        </div>

        <!-- 脚本逐条确认清单（缺省全不勾 = 全部置空） -->
        <div class="wt-scripts">
          <div class="wt-scripts-head">
            <span>
              脚本确认（已勾选 {{ confirmedScripts.size }}/{{ summary.scripts.length }}）
            </span>
            <span class="wt-spacer" />
            <button v-if="summary.scripts.length > 0" class="btn" @click="toggleAllScripts()">
              {{ confirmedScripts.size === summary.scripts.length ? "全不选" : "全选" }}
            </button>
          </div>
          <p v-if="summary.scripts.length > 0" class="wt-warning">
            未勾选的脚本将置空导入：节点保留、脚本不再执行；勾选的脚本原样保留。
          </p>
          <div v-if="summary.scripts.length > 0" class="wt-scripts-rows">
            <label
              v-for="script in summary.scripts"
              :key="script.key"
              class="wt-script-row"
              :title="`${script.key}\n${script.source}`"
            >
              <input
                type="checkbox"
                :checked="confirmedScripts.has(script.key)"
                :aria-label="`确认保留脚本 ${script.key}`"
                @change="toggleScript(script.key)"
              />
              <span class="wt-script-key mono">{{ script.key }}</span>
              <span class="wt-script-kind">{{ SCRIPT_KIND_LABELS[script.kind] }}</span>
              <span class="wt-script-node">{{ nodeLabel(script) }}</span>
              <span class="wt-script-src mono">{{ script.source }}</span>
            </label>
          </div>
          <p v-else class="wt-hint">该文件不含可执行脚本，无需逐条确认。</p>
        </div>

        <!-- 目标项目与提交 -->
        <div class="wt-project-row">
          <span class="wt-field-label">目标项目</span>
          <select v-model="targetProjectId" class="select" aria-label="选择目标项目">
            <option value="" disabled>选择项目…</option>
            <option v-for="group in groups" :key="group.project.id" :value="group.project.id">
              {{ group.project.name }}
            </option>
          </select>
          <span class="wt-hint"
            >导入副本归入该项目；请求库/环境集条目与现有 id 冲突时跳过不覆盖</span
          >
        </div>

        <!-- 结果面板：成功/跳过 + reasons/issues + 扩展字段裁决 -->
        <div v-if="importResult" class="wt-result">
          <div class="wt-result-head">
            导入完成：成功 {{ importResult.imported.length }} 条 · 跳过
            {{ importResult.skipped.length }} 条
          </div>
          <div class="wt-result-rows">
            <div
              v-for="item in importResult.imported"
              :key="`ok-${item.index}`"
              class="wt-result-row"
            >
              <span class="badge wt-badge-ok">新建</span>
              <span class="wt-result-name" :title="item.name">
                #{{ item.index }} {{ item.name }}
              </span>
              <span class="wt-script-src mono">{{ item.id }}</span>
            </div>
            <div
              v-for="item in importResult.skipped"
              :key="`skip-${item.index}`"
              class="wt-result-row"
            >
              <span class="badge wt-badge-skip">跳过</span>
              <span class="wt-result-name" :title="item.name">
                #{{ item.index }} {{ item.name }}
              </span>
              <span class="wt-result-issues" :title="item.issues.join('\n')">
                {{ item.issues.join("；") }}
              </span>
            </div>
            <div
              v-for="family in [
                { label: '请求条目', outcome: importResult.requests },
                { label: '环境集', outcome: importResult.envSets },
              ]"
              :key="family.label"
              class="wt-result-family"
            >
              <span class="wt-result-family-label">{{ family.label }}：</span>
              <span>新增 {{ family.outcome.imported }} 条</span>
              <span v-if="family.outcome.skipped.length > 0" class="wt-result-issues">
                跳过 {{ family.outcome.skipped.length }} 条 （{{
                  family.outcome.skipped.map((s) => `${s.id}：${s.reason}`).join("；")
                }}）
              </span>
            </div>
          </div>
        </div>
      </template>

      <div v-else-if="!parseError && !importFileName" class="wt-import-empty">
        <p>尚未选择导出文件</p>
        <p class="wt-import-empty-detail">
          从「导出」页或其他 ReqFlow 实例导出的 JSON 文件可在此导入；解析预览后逐条确认脚本。
        </p>
      </div>

      <div class="wt-spacer" />

      <div v-if="summary" class="wt-foot">
        <span class="wt-hint">
          {{
            confirmedScripts.size === 0 && summary.scriptCount > 0
              ? `注意：${summary.scriptCount} 条脚本均未勾选，将全部置空导入`
              : ""
          }}
        </span>
        <span class="wt-spacer" />
        <button class="btn primary" :disabled="!canImport" @click="runImport()">
          {{ importing ? "导入中…" : `导入 ${summary.workflowCount} 条流程` }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wt-root {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: var(--space-3);
  gap: var(--space-2);
}

.wt-tabs {
  display: flex;
  gap: var(--space-1);
  flex: none;
}

.wt-tab {
  padding: 2px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 20px;
  cursor: pointer;
}

.wt-tab:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

.wt-tab.active {
  border-color: var(--accent);
  background: var(--bg-selected);
  color: var(--accent);
}

.wt-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.wt-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.wt-count {
  font-size: 12px;
  color: var(--text-secondary);
}

.wt-spacer {
  flex: 1;
}

.wt-error {
  flex: none;
  font-size: 12px;
  color: var(--danger);
  word-break: break-all;
}

.wt-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-app);
}

.wt-group {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px var(--space-2);
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  position: sticky;
  top: 0;
  z-index: 1;
}

.wt-project-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.wt-group-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.wt-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 3px var(--space-2);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
}

.wt-row:last-child {
  border-bottom: none;
}

.wt-row:hover {
  background: var(--bg-hover);
}

.wt-row-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.wt-row-meta {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
}

.wt-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.wt-feedback {
  font-size: 11px;
  color: var(--success);
}

/* ---------- 导入页 ---------- */

.wt-file-row {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.wt-file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.wt-file-hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-faint);
}

.wt-summary {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: 4px var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-app);
  font-size: 12px;
}

.wt-summary-time {
  color: var(--text-faint);
}

.wt-wf-names {
  flex: none;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-secondary);
}

.wt-scripts {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.wt-scripts-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.wt-warning {
  flex: none;
  margin: 0;
  font-size: 11px;
  color: var(--warning);
}

.wt-hint {
  font-size: 11px;
  color: var(--text-faint);
}

.wt-scripts-rows {
  flex: 1;
  min-height: 60px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-app);
}

.wt-script-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 3px var(--space-2);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
}

.wt-script-row:last-child {
  border-bottom: none;
}

.wt-script-row:hover {
  background: var(--bg-hover);
}

.wt-script-key {
  flex: none;
  font-size: 10px;
  color: var(--text-faint);
}

.wt-script-kind {
  flex: none;
  font-size: 11px;
  color: var(--text-secondary);
}

.wt-script-node {
  flex: none;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

.wt-script-src {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-secondary);
}

.wt-project-row {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.wt-field-label {
  flex: none;
  font-size: 12px;
  color: var(--text-secondary);
}

.wt-project-row .wt-hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wt-import-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  text-align: center;
}

.wt-import-empty p {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.wt-import-empty-detail {
  font-size: 11px;
  color: var(--text-faint);
}

.wt-result {
  flex: none;
  max-height: 200px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-app);
  overflow: hidden;
}

.wt-result-head {
  flex: none;
  padding: 4px var(--space-2);
  font-size: 12px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}

.wt-result-rows {
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-1) var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wt-result-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: 12px;
}

.wt-badge-ok {
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: var(--success);
}

.wt-badge-skip {
  background: color-mix(in srgb, var(--warning) 18%, transparent);
  color: var(--warning);
}

.wt-result-name {
  flex: none;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wt-result-issues {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--danger);
}

.wt-result-family {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.wt-result-family-label {
  flex: none;
  font-weight: 600;
}
</style>
