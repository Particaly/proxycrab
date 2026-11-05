<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Io5Refresh } from "vue-icons-plus/io5";
import { useBackend } from "../../api";
import type { FlowRunDetail, Workflow, WorkflowNode } from "../../api/types";
import { errorMessage } from "../../utils/har-export";
import { reportError } from "../../stores/app";
import { confirmDialog } from "../../stores/dialog";
import { formatDateTime } from "../../utils/format";
import RunGraphView from "../flow/RunGraphView.vue";
import NodeRunPanel from "../flow/NodeRunPanel.vue";
import {
  countFailedNodeRuns,
  formatRunDuration,
  listStaleNodeRuns,
  nodeRunStatusLabel,
  nodeTypeLabel,
  resolveRunGraph,
  runGraphDisclosures,
  runStatusLabel,
  runTriggerLabel,
  shortId,
  sortNodeRunsByExecution,
  nodeRunsToRunStates,
  type RunNodeStateMap,
} from "../flow/run-view";

/**
 * 运行详情视图（原浮窗 RunDetailWindow 内容平移，ReqFlow 复刻计划 Task 22
 * Step 2 / 3）：只读运行画布 + 节点快照面板，由「运行记录」区块主区按
 * runId 挂载。
 *
 * 图还原口径（快照优先三态，见 run-view.resolveRunGraph）：
 *   - run.graphSnapshot 存在 → 按运行创建时刻的快照还原（流程改 / 删不影响）；
 *     超 256KB 的降级骨架照常渲染骨架节点，并在顶部披露「图快照已降级」；
 *   - 无快照（旧记录）→ 回落拉当前流程定义渲染，顶部提示「图快照缺失，按
 *     当前流程定义显示」；
 *   - 流程已删除且无快照 → 画布空态。
 *
 * 节点状态着色：success / failed / cancelled / running / skipped 按语义档
 * （见 flow.css 运行态样式）；interrupted 运行里停留在 running 的节点按
 * 中性档呈现（不转圈误导为仍在执行）。
 *
 * 运行中每 2s 轮询详情（终态后停止）；running 状态提供「取消运行」。
 */
const props = defineProps<{
  runId: string;
}>();

const backend = useBackend();

const run = ref<FlowRunDetail | null>(null);
const loadError = ref<string | null>(null);
const loading = ref(false);
const cancelling = ref(false);

/** 当前流程定义（图回落与固定输出动作的目标；仅在需要时拉取）。 */
const workflow = ref<Workflow | null>(null);

const selectedNodeId = ref<string | null>(null);

/* ------------------------------ 数据加载 ------------------------------ */

async function loadWorkflow(): Promise<void> {
  const api = backend.workflows;
  const workflowId = run.value?.workflowId;
  if (!api || workflowId === undefined) {
    workflow.value = null;
    return;
  }
  try {
    workflow.value = await api.getWorkflow(workflowId);
  } catch {
    // 流程已删除 / 拉取失败：回落空，由披露文案说明口径
    workflow.value = null;
  }
}

async function load(): Promise<void> {
  const api = backend.flowRuns;
  if (!api) return;
  loading.value = true;
  try {
    const detail = await api.get(props.runId);
    run.value = detail;
    loadError.value = null;
    // 无图快照（旧记录）时才需要当前流程定义做回落渲染
    if (detail.graphSnapshot === undefined || detail.graphSnapshot === null) {
      await loadWorkflow();
    }
  } catch (error) {
    loadError.value = errorMessage(error);
    reportError(error, "加载运行详情失败");
  } finally {
    loading.value = false;
  }
}

/** 固定输出成功后刷新流程定义（刷新「已固定」标记）。 */
function onPinned(): void {
  if (backend.workflows) {
    void loadWorkflow();
  }
}

/* ------------------------------ 图还原与披露 ------------------------------ */

const resolvedGraph = computed(() =>
  resolveRunGraph(
    run.value ?? {
      id: "",
      workflowId: "",
      workflowName: "",
      trigger: "",
      status: "running",
      startedAt: 0,
    },
    workflow.value,
  ),
);

const disclosures = computed(() =>
  runGraphDisclosures(resolvedGraph.value, backend.workflows !== undefined),
);

const runStates = computed<RunNodeStateMap>(() =>
  run.value === null ? {} : nodeRunsToRunStates(run.value.nodeRuns, run.value.status),
);

const failedCount = computed(() =>
  run.value === null ? 0 : countFailedNodeRuns(run.value.nodeRuns),
);

/* ------------------------------ 执行记录清单 ------------------------------ */

/** 默认面板的执行记录清单（按 startedAt 升序）。 */
const executionList = computed(() =>
  run.value === null ? [] : sortNodeRunsByExecution(run.value.nodeRuns),
);

/** 未在图中的执行节点（流程改版后的陈旧节点）。 */
const staleEntries = computed(() =>
  run.value === null ? [] : listStaleNodeRuns(run.value.nodeRuns, resolvedGraph.value.nodes),
);

function nodeDisplayName(nodeId: string): string {
  const node: WorkflowNode | undefined = resolvedGraph.value.nodes.find(
    (candidate) => candidate.id === nodeId,
  );
  return node === undefined ? shortId(nodeId) : nodeTypeLabel(node.type, node.label);
}

/** 清单行的状态点修饰类（与面板/画布同口径）。 */
function dotClass(nodeId: string): string {
  const state = runStates.value[nodeId];
  if (state === undefined) return "neutral";
  if (state.status === "running") return "running";
  if (state.status === "success") return "success";
  if (state.status === "failed") return "failed";
  return "neutral";
}

/* ------------------------------ 取消与轮询 ------------------------------ */

async function cancelRun(): Promise<void> {
  const api = backend.flowRuns;
  if (!api || run.value?.status !== "running" || cancelling.value) return;
  const ok = await confirmDialog({
    title: "取消运行",
    message: "确定取消该运行吗？运行将尽快中断并标记为已取消。",
    confirmText: "取消运行",
    danger: true,
  });
  if (!ok) return;
  cancelling.value = true;
  try {
    await api.cancel(props.runId);
    await load();
  } catch (error) {
    reportError(error, "取消运行失败");
  } finally {
    cancelling.value = false;
  }
}

let timer: number | undefined;

onMounted(() => {
  void load();
  timer = window.setInterval(() => {
    if (run.value?.status === "running") void load();
  }, 2000);
});

onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer);
});
</script>

<template>
  <div class="rd-root">
    <!-- 头部：run 标识 + 状态 / 触发 / 时间 / 取消 -->
    <div class="rd-header">
      <template v-if="run !== null">
        <span class="rd-id mono" :title="run.id">运行 {{ shortId(run.id) }}</span>
        <span class="badge rd-status-badge" :class="`is-${run.status}`">{{
          runStatusLabel(run.status)
        }}</span>
        <span class="badge">{{ runTriggerLabel(run.trigger) }}</span>
        <span class="rd-name" :title="run.workflowName">{{
          run.workflowName || run.workflowId
        }}</span>
        <span class="rd-meta text-secondary">
          开始 {{ formatDateTime(run.startedAt) }}
          <template v-if="run.finishedAt !== undefined">
            · 结束 {{ formatDateTime(run.finishedAt) }}</template
          >
          · 耗时 {{ formatRunDuration(run) }}
        </span>
        <span v-if="failedCount > 0" class="rd-failed">{{ failedCount }} 个节点失败</span>
        <span class="rd-spacer" />
        <span v-if="loading" class="text-faint rd-loading">加载中…</span>
        <button
          v-if="run.status === 'running'"
          class="btn danger"
          :disabled="cancelling"
          @click="cancelRun"
        >
          {{ cancelling ? "取消中…" : "取消运行" }}
        </button>
        <button class="btn icon" title="刷新" @click="load">
          <Io5Refresh :size="14" />
        </button>
      </template>
      <span v-else class="text-faint">运行 {{ shortId(props.runId) }}</span>
    </div>

    <div v-if="run !== null && run.error" class="rd-run-error" :title="run.error">
      {{ run.error }}
    </div>

    <!-- 图来源披露（降级 / 回落 / 不可还原） -->
    <div v-for="message in disclosures" :key="message" class="rd-disclosure">
      <span aria-hidden="true">ⓘ</span>
      {{ message }}
    </div>

    <div v-if="run === null" class="empty-hint">
      {{ loadError !== null ? `加载失败：${loadError}` : "加载中…" }}
    </div>
    <div v-else class="rd-body">
      <!-- 左：只读运行画布 -->
      <RunGraphView
        :nodes="resolvedGraph.nodes"
        :edges="resolvedGraph.edges"
        :run-states="runStates"
        :selected-node-id="selectedNodeId"
        @select="selectedNodeId = $event"
      />
      <!-- 右：节点快照面板 / 默认执行记录清单 -->
      <div class="rd-side">
        <NodeRunPanel
          v-if="selectedNodeId !== null"
          :run="run"
          :node-id="selectedNodeId"
          :nodes="resolvedGraph.nodes"
          :workflow="workflow"
          @close="selectedNodeId = null"
          @pinned="onPinned"
        />
        <div v-else class="rd-legend-root">
          <div class="rd-list-title">执行记录（{{ executionList.length }}）</div>
          <div class="rd-list-body">
            <div v-if="executionList.length === 0" class="empty-hint">本次运行尚无节点执行记录</div>
            <button
              v-for="entry in executionList"
              :key="entry.nodeId"
              type="button"
              class="rd-list-row"
              @click="selectedNodeId = entry.nodeId"
            >
              <span class="rd-dot" :class="dotClass(entry.nodeId)" />
              <span class="rd-list-name" :title="entry.nodeId">{{
                nodeDisplayName(entry.nodeId)
              }}</span>
              <span
                class="rd-list-status"
                :class="{ 'text-danger': entry.nodeRun.status === 'failed' }"
              >
                {{ nodeRunStatusLabel(entry.nodeRun.status, run.status === "interrupted") }}
              </span>
              <span class="rd-list-duration mono">
                {{ entry.nodeRun.durationMs === undefined ? "—" : `${entry.nodeRun.durationMs}ms` }}
              </span>
            </button>
            <template v-if="staleEntries.length > 0">
              <div class="rd-list-title stale">未在图中的执行节点（{{ staleEntries.length }}）</div>
              <button
                v-for="entry in staleEntries"
                :key="`stale-${entry.nodeId}`"
                type="button"
                class="rd-list-row stale"
                @click="selectedNodeId = entry.nodeId"
              >
                <span class="rd-dot" :class="dotClass(entry.nodeId)" />
                <span class="rd-list-name" :title="entry.nodeId">{{
                  nodeDisplayName(entry.nodeId)
                }}</span>
                <span class="badge rd-stale-badge">陈旧</span>
              </button>
            </template>
          </div>
          <div class="rd-legend">
            <span class="rd-legend-item"><span class="rd-dot success" />成功</span>
            <span class="rd-legend-item"><span class="rd-dot failed" />失败</span>
            <span class="rd-legend-item"><span class="rd-dot running" />执行中</span>
            <span class="rd-legend-item"><span class="rd-dot neutral" />跳过 / 未完成</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rd-root {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.rd-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  min-height: 34px;
}
.rd-id {
  font-weight: 600;
}
.rd-status-badge {
  min-width: 48px;
  text-align: center;
}
.rd-status-badge.is-running {
  background: var(--accent);
  color: var(--accent-text);
}
.rd-status-badge.is-success {
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: var(--success);
}
.rd-status-badge.is-failed {
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  color: var(--danger);
}
.rd-status-badge.is-cancelled,
.rd-status-badge.is-interrupted {
  background: var(--bg-active);
  color: var(--text-faint);
}
.rd-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.rd-meta {
  flex: none;
  font-size: 12px;
}
.rd-failed {
  flex: none;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
  font-size: 11px;
  line-height: 18px;
}
.rd-spacer {
  flex: 1;
}
.rd-loading {
  font-size: 12px;
}
.rd-header .btn {
  padding: 2px 10px;
  font-size: 12px;
}

.rd-run-error {
  flex: none;
  padding: var(--space-1) var(--space-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-bottom: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  color: var(--danger);
  font-size: 12px;
}

.rd-disclosure {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: var(--space-1) var(--space-3);
  border-bottom: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  color: var(--warning);
  font-size: 12px;
}

.rd-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* 右栏：节点面板 / 执行记录清单 */
.rd-side {
  flex: none;
  width: 340px;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  min-height: 0;
}

.rd-legend-root {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.rd-list-title {
  flex: none;
  padding: var(--space-2) var(--space-3) var(--space-1);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}
.rd-list-title.stale {
  padding-top: var(--space-2);
}
.rd-list-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.rd-list-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 26px;
  padding: 0 var(--space-3);
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.rd-list-row:hover {
  background: var(--bg-hover);
}
.rd-list-row.stale {
  opacity: 0.8;
}
.rd-list-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rd-list-status {
  flex: none;
  font-size: 11px;
  color: var(--text-secondary);
}
.rd-list-duration {
  flex: none;
  min-width: 52px;
  text-align: right;
  color: var(--text-faint);
}
.rd-stale-badge {
  flex: none;
}

/* 图例（默认面板底部） */
.rd-legend {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border);
}
.rd-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-secondary);
}

/* 状态点 */
.rd-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-faint);
}
.rd-dot.success {
  background: var(--success);
}
.rd-dot.failed {
  background: var(--danger);
}
.rd-dot.running {
  background: var(--accent);
  animation: rd-pulse 1.2s ease-in-out infinite;
}
@keyframes rd-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent);
  }
  50% {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 15%, transparent);
  }
}
</style>
