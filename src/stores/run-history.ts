import { computed, ref } from "vue";
import { getBackend } from "../api/runtime-backend";
import type { FlowProject, FlowRunRecord, Workflow } from "../api/types";
import { reportError } from "./app";
import { buildRunListQuery, runPageCount } from "../components/flow/run-view";

/**
 * 运行记录共享状态（原浮窗 RunHistoryWindow 的 script 提升）：手风琴导航下
 * 「侧栏筛选 + 运行列表」与「主区运行详情画布」是两个组件，列表态与选中
 * 运行在此共享。
 *
 * 分页按条数（每页 20，总条数取自列表响应 total）；流程筛选下拉依赖
 * workflows 能力位，缺省不加载——「无 API 不开入口」，加载失败不阻断列表。
 * 可见页存在 running 记录时每 2s 自动刷新（终态后停止）；轮询随运行记录
 * 区块主区视图挂载启停（startPolling / stopPolling，切走区块即停）。
 * 入口依赖 Backend.flowRuns 能力位（workspace-view / 手风琴区块把关）。
 *
 * 重跑类入口所需 API 参数尚未交付，本区块不渲染任何运行发起按钮
 * （接缝见 NodeRunPanel 的 RERUN_SEAM 注释）。
 */
const runs = ref<FlowRunRecord[]>([]);
const total = ref(0);
const page = ref(0);
const loading = ref(false);
const loadError = ref<string | null>(null);

const filters = ref({ workflowId: "all", status: "all" });

/** 流程筛选选项（id + 名称；依赖 workflows 能力位）。 */
const workflowOptions = ref<Array<{ id: string; name: string }>>([]);

/** 主区详情选中的运行 id（null 时空态提示；切换区块不丢选中）。 */
const selectedRunId = ref<string | null>(null);

const pageCount = computed(() => runPageCount(total.value));
const pageLabel = computed(
  () => `${Math.min(page.value + 1, pageCount.value)} / ${pageCount.value}`,
);

/** 可见页存在进行中的运行时自动刷新（终态后停止）。 */
const hasRunning = computed(() => runs.value.some((run) => run.status === "running"));

async function loadWorkflows(): Promise<void> {
  const api = getBackend().workflows;
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
  const api = getBackend().flowRuns;
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

/** 筛选变化：回第一页重新拉取。 */
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

/** 选中运行（主区切到对应详情画布）。 */
function select(runId: string): void {
  selectedRunId.value = runId;
}

/** 列表轮询（2s，仅在可见页存在 running 记录时拉取）；幂等可重复启动。 */
let pollTimer: number | undefined;

function startPolling(): void {
  if (pollTimer !== undefined) return;
  void loadRuns();
  void loadWorkflows();
  pollTimer = window.setInterval(() => {
    if (hasRunning.value) void loadRuns();
  }, 2000);
}

function stopPolling(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

export function useRunHistoryStore() {
  return {
    runs,
    total,
    page,
    loading,
    loadError,
    filters,
    workflowOptions,
    selectedRunId,
    pageCount,
    pageLabel,
    hasRunning,
    loadRuns,
    switchFilter,
    switchPage,
    select,
    startPolling,
    stopPolling,
  };
}
