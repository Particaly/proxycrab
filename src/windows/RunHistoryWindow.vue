<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Io5Refresh } from "vue-icons-plus/io5";
import { useBackend } from "../api";
import type { FlowProject, FlowRunRecord, Workflow } from "../api/types";
import { reportError } from "../stores/app";
import { formatDateTime } from "../utils/format";
import { openRunDetail } from "./launcher";
import {
  buildRunListQuery,
  computeRunDuration,
  formatDurationMs,
  hasActiveFilters,
  RUN_STATUS_FILTER_VALUES,
  runPageCount,
  runStatusLabel,
  runTriggerLabel,
} from "../components/flow/run-view";

/**
 * 运行记录窗口（ReqFlow 复刻计划 Task 22 Step 1）：流程运行的分页列表。
 *
 * 形态对齐既有窗口的筛选条 + 高密度表格：按流程 / 状态筛选（流程下拉依赖
 * workflows 能力位，缺省不渲染该筛选——「无 API 不开入口」）、状态与触发
 * 方式徽标、开始时间 / 耗时 / 错误摘要列；行点击打开运行详情窗口。分页按
 * 条数（每页 20，总条数取自列表响应 total）。可见页存在 running 记录时
 * 每 2s 自动刷新（终态后停止）。
 *
 * 重跑类入口（从此起重跑 / 重跑该轮）所需 API 参数尚未交付，本窗口不渲染
 * 任何运行发起按钮（接缝见 NodeRunPanel 的 RERUN_SEAM 注释）。
 */
const backend = useBackend();

const runs = ref<FlowRunRecord[]>([]);
const total = ref(0);
const page = ref(0);
const loading = ref(false);
const loadError = ref<string | null>(null);

const filters = ref({ workflowId: "all", status: "all" });

/** 流程筛选选项（id + 名称；依赖 workflows 能力位）。 */
const workflowOptions = ref<Array<{ id: string; name: string }>>([]);

const pageCount = computed(() => runPageCount(total.value));
const pageLabel = computed(() => `${Math.min(page.value + 1, pageCount.value)} / ${pageCount.value}`);

/** 表格行的耗时列（running 显示「进行中…」）。 */
function durationOf(run: FlowRunRecord): string {
  if (run.status === "running") return "进行中…";
  const duration = computeRunDuration(run);
  return duration === undefined ? "—" : formatDurationMs(duration);
}

async function loadWorkflows(): Promise<void> {
  const api = backend.workflows;
  if (!api) return;
  try {
    const { projects } = await api.listProjects();
    const options: Array<{ id: string; name: string; updatedAt: number }> = [];
    for (const project of projects as FlowProject[]) {
      const { workflows } = await api.listWorkflows(project.id);
      for (const workflow of workflows as Workflow[]) {
        options.push({ id: workflow.id, name: workflow.name, updatedAt: workflow.updatedAt });
      }
    }
    workflowOptions.value = options
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, name }) => ({ id, name }));
  } catch (error) {
    // 筛选下拉是辅助能力：加载失败不阻断列表，只提示
    reportError(error, "加载流程列表失败");
  }
}

async function loadRuns(): Promise<void> {
  const api = backend.flowRuns;
  if (!api) return;
  loading.value = true;
  loadError.value = null;
  try {
    const result = await api.list(buildRunListQuery(filters.value, page.value));
    runs.value = result.runs;
    total.value = result.total;
    // 筛选变化或末页收缩后页码越界时回退到末页
    if (page.value > 0 && page.value >= pageCount.value && result.runs.length === 0) {
      page.value = pageCount.value - 1;
      await loadRuns();
    }
  } catch (error) {
    loadError.value = reportError(error, "加载运行记录失败");
  } finally {
    loading.value = false;
  }
}

function switchFilter(): void {
  page.value = 0;
  void loadRuns();
}

function switchPage(delta: number): void {
  const next = page.value + delta;
  if (next < 0 || next >= pageCount.value) return;
  page.value = next;
  void loadRuns();
}

/** 可见页存在进行中的运行时自动刷新（终态后停止）。 */
const hasRunning = computed(() => runs.value.some((run) => run.status === "running"));
let timer: number | undefined;

onMounted(() => {
  void loadRuns();
  void loadWorkflows();
  timer = window.setInterval(() => {
    if (hasRunning.value) void loadRuns();
  }, 2000);
});

onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer);
});
</script>

<template>
  <div class="rh-root">
    <!-- 筛选条：流程 / 状态 + 刷新 -->
    <div class="rh-toolbar">
      <select
        v-if="workflowOptions.length > 0 || filters.workflowId !== 'all'"
        v-model="filters.workflowId"
        class="select"
        title="按流程筛选"
        aria-label="按流程筛选"
        @change="switchFilter"
      >
        <option value="all">全部流程</option>
        <option v-for="option in workflowOptions" :key="option.id" :value="option.id">
          {{ option.name }}
        </option>
      </select>
      <select
        v-model="filters.status"
        class="select"
        title="按状态筛选"
        aria-label="按状态筛选"
        @change="switchFilter"
      >
        <option value="all">全部状态</option>
        <option v-for="status in RUN_STATUS_FILTER_VALUES" :key="status" :value="status">
          {{ runStatusLabel(status) }}
        </option>
      </select>
      <span v-if="loading" class="rh-loading text-faint">加载中…</span>
      <span class="rh-spacer" />
      <button class="btn icon" title="刷新" @click="loadRuns">
        <Io5Refresh :size="14" />
      </button>
    </div>

    <div v-if="loadError" class="rh-error">{{ loadError }}</div>

    <!-- 表头 -->
    <div v-if="runs.length > 0" class="rh-head mono" aria-hidden="true">
      <span class="rh-time">开始时间</span>
      <span class="rh-name">流程</span>
      <span class="rh-trigger">触发</span>
      <span class="rh-status">状态</span>
      <span class="rh-duration">耗时</span>
      <span class="rh-error-col">错误</span>
    </div>

    <!-- 行（空态按「无数据 / 筛选无命中」区分） -->
    <div v-if="runs.length === 0" class="empty-hint">
      {{ loadError !== null ? "加载失败" : hasActiveFilters(filters) ? "没有符合筛选条件的运行记录" : "暂无运行记录" }}
    </div>
    <div v-else class="rh-body">
      <button
        v-for="run in runs"
        :key="run.id"
        type="button"
        class="rh-row"
        :title="`查看运行详情 ${run.id}`"
        @click="openRunDetail(run.id)"
      >
        <span class="rh-time mono">{{ formatDateTime(run.startedAt) }}</span>
        <span class="rh-name" :title="run.workflowName">{{ run.workflowName || run.workflowId }}</span>
        <span class="rh-trigger"><span class="badge">{{ runTriggerLabel(run.trigger) }}</span></span>
        <span class="rh-status">
          <span class="badge rh-status-badge" :class="`is-${run.status}`">{{ runStatusLabel(run.status) }}</span>
        </span>
        <span class="rh-duration mono">{{ durationOf(run) }}</span>
        <span class="rh-error-col" :class="{ 'text-danger': run.error }" :title="run.error ?? ''">
          {{ run.error ?? "—" }}
        </span>
      </button>
    </div>

    <!-- 分页脚 -->
    <div v-if="runs.length > 0" class="rh-footer">
      <span class="text-faint">共 {{ total }} 条</span>
      <span class="rh-page mono text-secondary">{{ pageLabel }}</span>
      <button class="btn" :disabled="page === 0" @click="switchPage(-1)">上一页</button>
      <button class="btn" :disabled="page >= pageCount - 1" @click="switchPage(1)">下一页</button>
    </div>
  </div>
</template>

<style scoped>
.rh-root {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.rh-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  flex: none;
}
.rh-loading {
  font-size: 12px;
}
.rh-spacer {
  flex: 1;
}

.rh-error {
  flex: none;
  padding: var(--space-1) var(--space-3);
  color: var(--danger);
  font-size: 12px;
}

/* 表头与行共用网格列（时间 / 流程 / 触发 / 状态 / 耗时 / 错误） */
.rh-head,
.rh-row {
  display: grid;
  grid-template-columns: 150px minmax(120px, 1.2fr) 52px 64px 72px minmax(100px, 1fr);
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
}
.rh-head {
  flex: none;
  height: 26px;
  font-size: 11px;
  color: var(--text-faint);
  border-bottom: 1px solid var(--border);
}

.rh-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.rh-row {
  width: 100%;
  height: 28px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.rh-row:hover {
  background: var(--bg-hover);
}

.rh-time {
  flex: none;
  overflow: hidden;
  white-space: nowrap;
}
.rh-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.rh-trigger,
.rh-status {
  flex: none;
  text-align: center;
}

/* 状态徽标（语义色底） */
.rh-status-badge {
  min-width: 48px;
  text-align: center;
}
.rh-status-badge.is-running {
  background: var(--accent);
  color: var(--accent-text);
}
.rh-status-badge.is-success {
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: var(--success);
}
.rh-status-badge.is-failed {
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  color: var(--danger);
}
.rh-status-badge.is-cancelled,
.rh-status-badge.is-interrupted {
  background: var(--bg-active);
  color: var(--text-faint);
}

.rh-duration {
  flex: none;
  color: var(--text-secondary);
}
.rh-error-col {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-faint);
}

.rh-footer {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border);
}
.rh-footer .btn {
  padding: 2px 10px;
  font-size: 12px;
}
.rh-page {
  min-width: 48px;
  text-align: center;
}
</style>
