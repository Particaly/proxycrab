import { beforeEach, expect, test } from "vitest";
import { flowTrialStore } from "./flow-trial";

/**
 * 试跑结果会话态单测（Task 15 薄片 C Step 4）：分桶定位、pre/post 两侧合并
 * 互不覆盖、流程清理隔离。纯内存 reactive，node 环境直接跑。
 */

beforeEach(() => {
  flowTrialStore.clearWorkflow("wf-1");
  flowTrialStore.clearWorkflow("wf-2");
});

test("record 并入样本：post 只写 output，再跑 pre 只补 input（互不覆盖）", () => {
  flowTrialStore.record("wf-1", "n1", { output: { ok: true } });
  let trial = flowTrialStore.get("wf-1", "n1");
  expect(trial?.source).toBe("script-dry-run");
  expect(trial?.output).toEqual({ ok: true });
  expect(trial?.input).toBeUndefined();

  flowTrialStore.record("wf-1", "n1", { input: { headers: {} } });
  trial = flowTrialStore.get("wf-1", "n1");
  expect(trial?.input).toEqual({ headers: {} });
  expect(trial?.output).toEqual({ ok: true });
});

test("get 未记录节点返回 null（抽屉 / 预览走空态）", () => {
  expect(flowTrialStore.get("wf-1", "missing")).toBeNull();
});

test("clearWorkflow 只清本流程，其他流程桶保留", () => {
  flowTrialStore.record("wf-1", "n1", { output: 1 });
  flowTrialStore.record("wf-2", "n1", { output: 2 });
  flowTrialStore.clearWorkflow("wf-1");
  expect(flowTrialStore.get("wf-1", "n1")).toBeNull();
  expect(flowTrialStore.get("wf-2", "n1")?.output).toBe(2);
});

test("同节点重复试跑取最近一次（时间戳与值都刷新）", () => {
  flowTrialStore.record("wf-1", "n1", { output: 1 });
  const first = flowTrialStore.get("wf-1", "n1");
  flowTrialStore.record("wf-1", "n1", { output: 2 });
  const second = flowTrialStore.get("wf-1", "n1");
  expect(second?.output).toBe(2);
  expect(second?.at).toBeGreaterThanOrEqual(first?.at ?? 0);
});
