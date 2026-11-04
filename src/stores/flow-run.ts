import { reactive } from "vue";
import { HTTP_API_CHANGE_EVENT } from "./http-api-sync";
import type { FlowRunRecord, HttpApiChange } from "../api/types";
import { getBackend } from "../api/runtime-backend";

/**
 * 流程运行态（计划 Task 19/22）：「某流程是否正在运行」的唯一前端来源。
 *
 * 后端把运行编排的运行级 / 节点级事件折算成 `FlowRuns` 资源经变更广播推送
 * （`/ui-api/changes` → http-api-sync → 窗口事件）；本 store 监听该事件后
 * 以「拉一次 running 列表」对账，而不是增量维护事件流——事件丢失（窗口关闭
 * 期间运行结束、常驻进程重启扫描收敛 interrupted）都能被下一次对账纠正。
 *
 * 订阅 + 对账都在 `ensureFlowRunListening()` 里懒启动（编辑器窗口挂载时调用）：
 * - 事件触发的对账按 1s 防抖合并（逐节点事件会突发）；
 * - 30s 周期对账兜底「运行中止广播丢失」（计划 Task 22 Step 4 的常驻进程处置）。
 */
export const flowRunStore = reactive({
  /** 在途 run（runId → workflowId），插入顺序 = 后端返回顺序（最新在前）。 */
  runningRuns: {} as Record<string, string>,
  /** 事件监听与周期对账是否已启动（幂等）。 */
  listening: false,
});

/** 事件触发对账的防抖间隔（逐节点事件突发时只拉一次）。 */
const REFRESH_DEBOUNCE_MS = 1_000;
/** 周期对账间隔：兜底「运行中止广播丢失」。 */
const RECONCILE_INTERVAL_MS = 30_000;

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let reconcileTimer: ReturnType<typeof setInterval> | undefined;

/**
 * 用后端 running 列表重建在途映射（对账入口；刷新与测试共用）。
 * 列表按开始时间倒序（最新在前），finished/cancelled/interrupted 直接丢弃。
 */
export function applyRunningRuns(runs: FlowRunRecord[]): void {
  const next: Record<string, string> = {};
  for (const run of runs) {
    if (run.status === "running") next[run.id] = run.workflowId;
  }
  flowRunStore.runningRuns = next;
}

/** 事件是否涉及运行域（决定是否调度对账）。 */
export function changeTouchesFlowRuns(resources: readonly string[]): boolean {
  return resources.includes("all") || resources.includes("flow_runs");
}

/** 该流程是否有在途运行（编辑器画布锁定依据）。 */
export function isWorkflowRunning(workflowId: string): boolean {
  return Object.values(flowRunStore.runningRuns).includes(workflowId);
}

/** 该流程最新在途 run 的 id（取消按钮目标；无在途时 null）。 */
export function latestRunningRunId(workflowId: string): string | null {
  for (const [runId, owner] of Object.entries(flowRunStore.runningRuns)) {
    if (owner === workflowId) return runId;
  }
  return null;
}

/** 拉一次后端 running 列表重建映射；后端未提供运行域能力时静默跳过。 */
export async function refreshFlowRuns(): Promise<void> {
  const flowRuns = getBackend().flowRuns;
  if (!flowRuns) return;
  try {
    const page = await flowRuns.list({ status: "running", limit: 200 });
    applyRunningRuns(page.runs);
  } catch {
    // 运行态对账失败不打扰用户（下一条事件或周期对账会再试）。
  }
}

function scheduleRefresh(): void {
  if (refreshTimer !== undefined) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refreshFlowRuns();
  }, REFRESH_DEBOUNCE_MS);
}

function onHttpApiChange(event: Event): void {
  const change = (event as CustomEvent<HttpApiChange>).detail;
  if (changeTouchesFlowRuns(change.resources)) scheduleRefresh();
}

/** 启动事件监听与周期对账（幂等；编辑器窗口挂载时调用）。 */
export function ensureFlowRunListening(): void {
  if (flowRunStore.listening) return;
  flowRunStore.listening = true;
  void refreshFlowRuns();
  if (typeof window === "undefined") return;
  window.addEventListener(HTTP_API_CHANGE_EVENT, onHttpApiChange);
  reconcileTimer = setInterval(() => void refreshFlowRuns(), RECONCILE_INTERVAL_MS);
}

/** 停止事件监听与周期对账（当前无常驻调用方；供测试与后续需要时使用）。 */
export function stopFlowRunListening(): void {
  if (!flowRunStore.listening) return;
  flowRunStore.listening = false;
  if (typeof window === "undefined") return;
  window.removeEventListener(HTTP_API_CHANGE_EVENT, onHttpApiChange);
  if (reconcileTimer !== undefined) {
    clearInterval(reconcileTimer);
    reconcileTimer = undefined;
  }
  if (refreshTimer !== undefined) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
}
