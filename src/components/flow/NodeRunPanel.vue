<script setup lang="ts">
import { computed, ref } from "vue";
import type { FlowRunDetail, Workflow, WorkflowNode } from "../../api/types";
import { useBackend } from "../../api";
import JsonTree from "./JsonTree.vue";
import { isTruncatedSnapshot } from "./json-tree";
import { appStore, reportError } from "../../stores/app";
import { requestEditorFocus } from "../../stores/editor-focus";
import { workspaceStore } from "../../stores/workspace-view";
import {
  formatDurationMs,
  formatLoopIterationProgress,
  iterationProgress,
  nodeRunStatusLabel,
  nodeTypeLabel,
  shortId,
} from "./run-view";

/**
 * 节点快照详情面板（ReqFlow 复刻 Task 22 薄片 A，形态移植上游 NodeRunPanel /
 * NodeRunViewer）：运行详情窗口右栏——点选画布节点（或执行记录清单条目）后
 * 展示该节点本次运行的 checkpoint。
 *
 * 铺排：头部（状态点 + 节点展示名 + 短 id + 状态 + 耗时 / 循环迭代进度）+
 * 动作区 + 快照查看器（error 块 + 逐迭代明细 + 入参 / 返回值双 tab JSON 树，
 * JsonTree 撑满面板余量）。
 *
 * 动作区口径（「无 API 不开入口」）：
 *   - 固定输出：写入当前流程定义的 config.pinnedOutput（Rust 侧运行引擎已
 *     支持 pinned 语义），仅在 flowRuns + workflows 能力齐备、当前流程可解析
 *     且节点仍存在时渲染；已固定的节点显示「已固定」标记；
 *   - 「从此起重跑」「重跑该轮」「在编辑器打开」所需 API 参数 / 接线尚未
 *     交付（运行 API 无 rerun-from / rerun-iteration 入参；编辑器聚焦通道
 *     属 Step 4 接线点），本薄片一律不渲染——接缝见下方 RERUN_SEAM 注释。
 *
 * 本次运行未执行该节点（图中存在但无 checkpoint）→ 明确提示而非空白面板；
 * 陈旧节点（不在本次运行的图中）额外披露来源。
 */
const props = defineProps<{
  /** 运行详情（快照与运行状态来源）。 */
  run: FlowRunDetail;
  /** 选中的节点 id。 */
  nodeId: string;
  /** 本次运行渲染图（快照 / 回落）的节点集合（展示名解析与陈旧判定）。 */
  nodes: WorkflowNode[];
  /** 当前流程定义（固定输出动作的写入目标；null = 不可固定）。 */
  workflow: Workflow | null;
}>();

const emit = defineEmits<{
  close: [];
  /** 固定输出成功后上抛（父级刷新流程定义，刷新「已固定」标记）。 */
  pinned: [];
}>();

const backend = useBackend();

const nodeRun = computed(() => props.run.nodeRuns.find((entry) => entry.nodeId === props.nodeId));
const node = computed(() => props.nodes.find((candidate) => candidate.id === props.nodeId));
const runInterrupted = computed(() => props.run.status === "interrupted");

const displayName = computed(() =>
  node.value === undefined
    ? shortId(props.nodeId)
    : nodeTypeLabel(node.value.type, node.value.label),
);
const isTypeLabel = computed(() => node.value !== undefined && !node.value.label?.trim());

/** 耗时展示：中断运行里停留在 running 的节点永远等不到终态，展示 '—'。 */
const durationLabel = computed(() => {
  const checkpoint = nodeRun.value;
  if (checkpoint === undefined) return null;
  if (checkpoint.status === "running") return runInterrupted.value ? "—" : "进行中…";
  return checkpoint.durationMs === undefined ? "—" : formatDurationMs(checkpoint.durationMs);
});

/** 循环节点迭代进度（防御提取）。 */
const iterationsProgress = computed(() => iterationProgress(nodeRun.value?.iterations));

/** 头部状态点的修饰类（中性档覆盖中断停留的 running）。 */
const dotClass = computed(() => {
  const checkpoint = nodeRun.value;
  if (checkpoint === undefined) return "none";
  if (checkpoint.status === "running") return runInterrupted.value ? "neutral" : "running";
  if (checkpoint.status === "success") return "success";
  if (checkpoint.status === "failed") return "failed";
  return "neutral";
});

/* ------------------------------ 固定输出 ------------------------------ */

/**
 * 当前流程定义中同 id 节点的 pinnedOutput 配置（「已固定」判定来源）。
 * 注意口径：与运行图快照无关——固定动作写的是当前流程定义。
 */
const pinnedConfig = computed(() => {
  const target = props.workflow?.nodes.find((candidate) => candidate.id === props.nodeId);
  const pinned = target?.config?.["pinnedOutput"];
  return typeof pinned === "object" && pinned !== null ? pinned : null;
});

/** 固定输出入口渲染条件（无 API / 无流程 / 非成功 / 无返回值 / 已固定 → 不渲染）。 */
const canPin = computed(
  () =>
    backend.workflows !== undefined &&
    props.workflow !== null &&
    nodeRun.value?.status === "success" &&
    nodeRun.value.output !== undefined &&
    nodeRun.value.output !== null &&
    pinnedConfig.value === null,
);

const pinning = ref(false);

/** 固定输出：把本次返回值写入当前流程定义的 config.pinnedOutput（整体图保存）。 */
async function pinOutput(): Promise<void> {
  const api = backend.workflows;
  const workflow = props.workflow;
  const checkpoint = nodeRun.value;
  if (!api || workflow === null || checkpoint === undefined || pinning.value) return;
  const nodes = workflow.nodes.map((candidate) =>
    candidate.id === props.nodeId
      ? {
          ...candidate,
          config: {
            ...candidate.config,
            pinnedOutput: {
              value: checkpoint.output,
              pinnedAt: Date.now(),
              sourceRunId: props.run.id,
            },
          },
        }
      : candidate,
  );
  pinning.value = true;
  try {
    await api.saveWorkflowGraph(workflow.id, { nodes, edges: workflow.edges });
    appStore.toast("已固定节点输出：后续运行此节点不再执行", "success");
    emit("pinned");
  } catch (error) {
    reportError(error, "固定输出失败");
  } finally {
    pinning.value = false;
  }
}

/**
 * RERUN_SEAM（重跑类入口接缝，本薄片刻意不渲染）：
 *   - 「从此起重跑」：需运行 API 携带 rerunFrom + 上游输出沿用参数（未交付）；
 *   - 「重跑该轮」：需按迭代项构造 var.loop 的单轮重跑入参（未交付）；
 *   - 「在编辑器打开」已接 editor-focus 聚焦通道（Task 22C），动作区见 openInEditor。
 * API 交付后在此处补动作区按钮，勿另起面板区域。
 */

/** 「在编辑器打开」：定位运行来源流程并选中本节点（workflows 能力位把关）。 */
function openInEditor(): void {
  if (!backend.workflows) return;
  requestEditorFocus(props.run.workflowId, props.nodeId);
  workspaceStore.open("workflow");
}

/* ------------------------------ 快照查看器 ------------------------------ */

/** 入参 / 返回值双 tab。 */
const valueTab = ref<"input" | "output">("input");

/** 逐迭代明细的展开轮次（null = 全部折叠）。 */
const expandedIteration = ref<number | null>(null);
/** 展开轮内的查看 tab（缺省聚合输出）。 */
const iterationTab = ref<"item" | "output">("output");

function toggleIteration(index: number): void {
  iterationTab.value = "output";
  expandedIteration.value = expandedIteration.value === index ? null : index;
}

/** 迭代项的行内预览文本（截断包装改道其 preview 前段，不解析 preview）。 */
function previewText(value: unknown, max = 48): string {
  const text = isTruncatedSnapshot(value) ? value.preview : safeStringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** JSON 序列化的展示兜底（不可序列化值退化为 String）。 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
</script>

<template>
  <section class="nrp-root" :data-node-id="nodeId">
    <!-- 头部：状态点 + 展示名 + 短 id + 状态 / 耗时（循环节点附迭代进度） -->
    <div class="nrp-header">
      <div class="nrp-header-main">
        <div class="nrp-title-row">
          <span
            v-if="nodeRun !== undefined"
            class="nrp-dot"
            :class="dotClass"
            :aria-label="nodeRunStatusLabel(nodeRun.status, runInterrupted)"
          />
          <span v-else class="nrp-dot none" aria-label="本次运行未执行该节点" />
          <span class="nrp-name" :title="displayName">{{ displayName }}</span>
          <span v-if="isTypeLabel" class="nrp-short-id mono">{{ shortId(nodeId) }}</span>
          <button
            class="btn icon nrp-close"
            title="收起节点详情"
            aria-label="收起节点详情"
            @click="emit('close')"
          >
            ✕
          </button>
        </div>
        <div class="nrp-meta-row">
          <span :data-status="nodeRun?.status ?? 'none'">
            {{
              nodeRun === undefined ? "未执行" : nodeRunStatusLabel(nodeRun.status, runInterrupted)
            }}
          </span>
          <span v-if="durationLabel !== null" class="mono">{{ durationLabel }}</span>
          <span
            v-if="iterationsProgress !== null"
            class="mono"
            :title="
              formatLoopIterationProgress(
                iterationsProgress.done,
                iterationsProgress.total,
                iterationsProgress.capped,
              )
            "
          >
            {{
              formatLoopIterationProgress(
                iterationsProgress.done,
                iterationsProgress.total,
                iterationsProgress.capped,
              )
            }}
          </span>
        </div>
      </div>
    </div>

    <!-- 动作区：「固定输出」+「在编辑器打开」（重跑类入口见 RERUN_SEAM 接缝注释） -->
    <div v-if="canPin || pinnedConfig !== null || backend.workflows" class="nrp-actions">
      <button
        v-if="backend.workflows"
        type="button"
        class="btn nrp-action"
        title="打开工作流编辑器并定位到本节点（按运行来源流程）"
        @click="openInEditor"
      >
        在编辑器打开
      </button>
      <button
        v-if="canPin"
        type="button"
        class="btn nrp-action"
        :disabled="pinning"
        title="把该节点本次输出固定为节点数据：后续运行此节点不再执行，便于迭代下游"
        @click="pinOutput"
      >
        {{ pinning ? "固定中…" : "固定输出" }}
      </button>
      <span
        v-if="pinnedConfig !== null"
        class="nrp-pinned-mark"
        title="该节点输出已固定（在编辑器中取消固定）"
      >
        已固定
      </span>
    </div>

    <!-- 快照正文：有 checkpoint → 查看器；无 → 明确提示 -->
    <template v-if="nodeRun !== undefined">
      <div class="nrp-viewer">
        <!-- 前置区（错误 / 逐迭代明细）：随内容定高，空间不足时自身滚动 -->
        <div v-if="nodeRun.error || nodeRun.iterations" class="nrp-preamble">
          <div v-if="nodeRun.error" class="nrp-error" :title="nodeRun.error">
            {{ nodeRun.error }}
          </div>

          <!-- 循环节点的逐迭代明细（进度 / 截断标注 / 逐轮查看） -->
          <div v-if="nodeRun.iterations" class="nrp-iterations">
            <div class="nrp-iteration-summary">
              <span>
                逐迭代明细：共 {{ nodeRun.iterations.total }} 轮 · 已结算
                {{ nodeRun.iterations.done }} 轮{{
                  nodeRun.iterations.capped ? "（轮数受上限截断）" : ""
                }}
              </span>
              <span v-if="nodeRun.iterations.truncated" class="nrp-iteration-truncated">
                明细已截断（仅前 {{ nodeRun.iterations.records.length }} 轮）
              </span>
            </div>
            <p v-if="nodeRun.iterations.records.length === 0" class="nrp-iteration-pending">
              逐轮明细在运行结束后随终态快照可见（当前进度见头部「已迭代」计数）。
            </p>
            <template v-else>
              <div
                v-for="record in nodeRun.iterations.records"
                :key="record.index"
                class="nrp-iteration"
                :class="{ failed: record.status === 'failed' }"
                :data-index="record.index"
                :data-status="record.status"
              >
                <button
                  type="button"
                  class="nrp-iteration-row"
                  :aria-expanded="expandedIteration === record.index"
                  @click="toggleIteration(record.index)"
                >
                  <span
                    class="nrp-dot"
                    :class="
                      record.status === 'failed'
                        ? 'failed'
                        : record.status === 'success'
                          ? 'success'
                          : 'neutral'
                    "
                  />
                  <span class="nrp-iteration-label">第 {{ record.index + 1 }} 轮</span>
                  <span class="nrp-iteration-item mono" :title="previewText(record.item, 400)">
                    {{ previewText(record.item) }}
                  </span>
                  <span
                    v-if="record.status === 'failed' && record.error"
                    class="nrp-iteration-error"
                    :title="record.error"
                  >
                    {{ record.error }}
                  </span>
                  <span class="nrp-iteration-duration mono">
                    {{ record.status === "cancelled" ? "—" : formatDurationMs(record.durationMs) }}
                  </span>
                  <span class="nrp-iteration-chevron" aria-hidden="true">
                    {{ expandedIteration === record.index ? "▾" : "▸" }}
                  </span>
                </button>
                <!-- 展开轮的迭代项 / 聚合输出双 tab JSON 树（重跑该轮入口见 RERUN_SEAM） -->
                <div v-if="expandedIteration === record.index" class="nrp-iteration-detail">
                  <div
                    class="nrp-tabs"
                    role="tablist"
                    :aria-label="`第 ${record.index + 1} 轮快照分页`"
                  >
                    <button
                      v-for="tab in [
                        { id: 'output', label: '聚合输出' },
                        { id: 'item', label: '迭代项' },
                      ]"
                      :key="tab.id"
                      type="button"
                      role="tab"
                      class="nrp-tab"
                      :class="{ active: iterationTab === tab.id }"
                      :aria-selected="iterationTab === tab.id"
                      @click="iterationTab = tab.id as 'item' | 'output'"
                    >
                      {{ tab.label }}
                    </button>
                  </div>
                  <JsonTree
                    :value="iterationTab === 'item' ? record.item : record.output"
                    :test-id="`iteration-json-tree-${iterationTab}`"
                    :search-label="
                      iterationTab === 'item'
                        ? '搜索迭代项的键、值或路径'
                        : '搜索聚合输出的键、值或路径'
                    "
                  />
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- 入参 / 返回值双 tab JSON 树（撑满面板余量） -->
        <div class="nrp-tabs" role="tablist" aria-label="节点快照分页">
          <button
            v-for="tab in [
              { id: 'input', label: '入参' },
              { id: 'output', label: '返回值' },
            ]"
            :key="tab.id"
            type="button"
            role="tab"
            class="nrp-tab"
            :class="{ active: valueTab === tab.id }"
            :aria-selected="valueTab === tab.id"
            @click="valueTab = tab.id as 'input' | 'output'"
          >
            {{ tab.label }}
          </button>
        </div>
        <JsonTree
          class="nrp-tree"
          :value="valueTab === 'input' ? nodeRun.input : nodeRun.output"
          :test-id="`node-json-tree-${valueTab}`"
          :search-label="
            valueTab === 'input' ? '搜索入参的键、值或路径' : '搜索返回值的键、值或路径'
          "
          fill-height
        />
      </div>
    </template>
    <div v-else class="nrp-empty">
      <p class="nrp-empty-main">本次运行未执行该节点。</p>
      <p v-if="node === undefined" class="nrp-empty-note">
        该节点不在本次运行的图中（流程改版后的陈旧节点）。
      </p>
    </div>
  </section>
</template>

<style scoped>
.nrp-root {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.nrp-header {
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
}
.nrp-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.nrp-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.nrp-close {
  flex: none;
  padding: 2px 6px;
}
.nrp-meta-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-secondary);
}

/* 状态点：running 脉冲 / success / failed / 中性 */
.nrp-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-faint);
}
.nrp-dot.success {
  background: var(--success);
}
.nrp-dot.failed {
  background: var(--danger);
}
.nrp-dot.running {
  background: var(--accent);
  animation: nrp-pulse 1.2s ease-in-out infinite;
}
@keyframes nrp-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent);
  }
  50% {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 15%, transparent);
  }
}

.nrp-actions {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--border);
}
.nrp-action {
  padding: 2px 10px;
  font-size: 12px;
}
.nrp-pinned-mark {
  flex: none;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  color: var(--warning);
  font-size: 11px;
  line-height: 16px;
}

.nrp-viewer {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}
.nrp-preamble {
  flex: none;
  max-height: 45%;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
}
.nrp-error {
  flex: none;
  padding: var(--space-1) var(--space-2);
  border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
  font-size: 12px;
  line-height: 1.5;
  word-break: break-all;
  user-select: text;
}

.nrp-tree {
  flex: 1;
  min-height: 0;
}

/* tab 行（入参 / 返回值与迭代明细复用） */
.nrp-tabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.nrp-tab {
  padding: 2px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-faint);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.nrp-tab:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.nrp-tab.active {
  background: var(--bg-active);
  color: var(--text);
}

/* 逐迭代明细列表 */
.nrp-iterations {
  flex: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.nrp-iteration-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
  padding: 4px var(--space-2);
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: 11px;
  color: var(--text-secondary);
}
.nrp-iteration-truncated {
  color: var(--warning);
}
.nrp-iteration-pending {
  margin: 0;
  padding: var(--space-2);
  font-size: 12px;
  color: var(--text-faint);
}
.nrp-iteration {
  border-bottom: 1px solid var(--border);
}
.nrp-iteration:last-child {
  border-bottom: none;
}
.nrp-iteration.failed {
  background: color-mix(in srgb, var(--danger) 6%, transparent);
}
.nrp-iteration-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px var(--space-2);
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.nrp-iteration-label {
  flex: none;
  font-size: 12px;
  font-weight: 600;
}
.nrp-iteration-item {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}
.nrp-iteration-error {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--danger);
}
.nrp-iteration-duration {
  flex: none;
  color: var(--text-secondary);
}
.nrp-iteration-chevron {
  flex: none;
  font-size: 10px;
  color: var(--text-faint);
}
.nrp-iteration-detail {
  padding: var(--space-1) var(--space-2) var(--space-2);
}

/* 未执行节点的空态 */
.nrp-empty {
  flex: none;
  padding: var(--space-3);
}
.nrp-empty-main {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}
.nrp-empty-note {
  margin: var(--space-1) 0 0;
  font-size: 11px;
  color: var(--text-faint);
}
</style>
