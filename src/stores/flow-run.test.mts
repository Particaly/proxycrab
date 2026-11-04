import { beforeEach, expect, test, vi } from "vitest";
import type { FlowRunRecord } from "../api/types";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
}));
vi.mock("../api/runtime-backend", () => ({
  getBackend: () => ({ flowRuns: { list: mocks.list } }),
}));
vi.mock("./http-api-sync", () => ({
  HTTP_API_CHANGE_EVENT: "proxycrab-http-api-change",
}));

import {
  applyRunningRuns,
  changeTouchesFlowRuns,
  flowRunStore,
  isWorkflowRunning,
  latestRunningRunId,
  refreshFlowRuns,
} from "./flow-run";

/**
 * 流程运行态单测（Task 22 薄片 B）：在途映射重建、最新在途定位、事件域判定、
 * 对账拉取。后端与事件桥 mock 掉（形态参照 http-api-sync.test.mts），node 环境跑。
 */

/** FlowRunRecord 测试桩（只含对账用到的键）。 */
function run(id: string, workflowId: string, status: string): FlowRunRecord {
  return {
    id,
    workflowId,
    workflowName: `w-${workflowId}`,
    trigger: "manual",
    status: status as FlowRunRecord["status"],
    startedAt: 1,
  } as FlowRunRecord;
}

beforeEach(() => {
  vi.resetAllMocks();
  flowRunStore.runningRuns = {};
  flowRunStore.listening = false;
});

test("重建映射：只保留 running，顺序保留（最新在前）", () => {
  applyRunningRuns([
    run("run-3", "wf-1", "running"),
    run("run-2", "wf-2", "running"),
    run("run-1", "wf-1", "finished"),
    run("run-0", "wf-1", "cancelled"),
    run("run-x", "wf-1", "interrupted"),
  ]);
  expect(Object.keys(flowRunStore.runningRuns)).toEqual(["run-3", "run-2"]);
  expect(Object.values(flowRunStore.runningRuns)).toEqual(["wf-1", "wf-2"]);
});

test("锁定与最新在途：多 run 取列表首位（最新），无在途为 null", () => {
  applyRunningRuns([run("run-7", "wf-1", "running"), run("run-6", "wf-1", "running")]);
  expect(isWorkflowRunning("wf-1")).toBe(true);
  expect(isWorkflowRunning("wf-9")).toBe(false);
  expect(latestRunningRunId("wf-1")).toBe("run-7");
  expect(latestRunningRunId("wf-9")).toBeNull();
});

test("对账清空：下次刷新无在途时映射归零（事件丢失兜底路径）", () => {
  applyRunningRuns([run("run-1", "wf-1", "running")]);
  expect(isWorkflowRunning("wf-1")).toBe(true);
  applyRunningRuns([]);
  expect(flowRunStore.runningRuns).toEqual({});
  expect(isWorkflowRunning("wf-1")).toBe(false);
});

test("事件域判定：flow_runs 与 all 触发，其余资源不触发", () => {
  expect(changeTouchesFlowRuns(["flow_runs"])).toBe(true);
  expect(changeTouchesFlowRuns(["sessions", "flow_runs"])).toBe(true);
  expect(changeTouchesFlowRuns(["all"])).toBe(true);
  expect(changeTouchesFlowRuns(["sessions"])).toBe(false);
  expect(changeTouchesFlowRuns([])).toBe(false);
});

test("refreshFlowRuns：以 running 过滤拉取并重建映射；后端失败静默保留旧态", async () => {
  mocks.list.mockResolvedValueOnce({ runs: [run("run-1", "wf-1", "running")], total: 1 });
  await refreshFlowRuns();
  expect(mocks.list).toHaveBeenCalledWith({ status: "running", limit: 200 });
  expect(latestRunningRunId("wf-1")).toBe("run-1");

  mocks.list.mockRejectedValueOnce(new Error("backend gone"));
  await refreshFlowRuns();
  expect(latestRunningRunId("wf-1")).toBe("run-1");
});
