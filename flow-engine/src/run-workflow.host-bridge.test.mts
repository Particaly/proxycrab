import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkflow } from "./run-workflow";
import { computeUpstreamClosure } from "./executor";
import type { WorkflowNode } from "./types";

/**
 * runWorkflow 宿主桥适配收口测试（ReqFlow 复刻计划 Task 20）：
 *   - 宿主取消接线：全局 host.cancelled 可用且未显式传 signal 时，载荷以
 *     轮询驱动引擎级取消信号——取消优先于失败（run = cancelled）、循环节点
 *     已完成轮次照常结算；显式 signal / 无宿主桥时不接线（既有行为不变）；
 *   - resume 透传：指定节点重跑的上游闭包预置与「缺输出建档前判 failed」
 *     经公开契约可用（执行器语义由 executor.pinned-resume.test.mts 锁定，
 *     此处只锁装配面透传）。
 *
 * 全部用桩宿主（假重放）与 fake timers，不发请求、不落库。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** 构造画布节点（httpReplay 缺省，config 可覆盖） */
function makeNode(
  id: string,
  type: WorkflowNode["type"] = "httpReplay",
  config: WorkflowNode["config"] = {},
): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, config };
}

/** 构造连线（id 由 source→target 拼出） */
function makeEdge(source: string, target: string) {
  return { id: `${source}->${target}`, source, target };
}

/** 桩重放宿主：按 url 记录出站请求并回 200 JSON 信封 */
function stubReplayHost(extra: Record<string, unknown> = {}): ReturnType<typeof vi.fn> {
  const replay = vi.fn(async (payload: { url: string }) => ({
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: payload.url }),
    durationMs: 1,
  }));
  vi.stubGlobal("host", { replay, ...extra });
  return replay;
}

describe("runWorkflow 宿主取消接线（Task 20）", () => {
  it("host.cancelled 置真后运行以 cancelled 收尾（取消优先于失败）", async () => {
    vi.stubGlobal("host", { cancelled: async () => true });
    vi.useFakeTimers();
    const workflow = {
      id: "wf-cancel",
      nodes: [
        makeNode("s", "start"),
        makeNode("d1", "delay", { durationMs: 2000 }),
        makeNode("end", "httpReplay", {
          manualRequest: { method: "GET", url: "https://example.test/end" },
        }),
      ],
      edges: [makeEdge("s", "d1"), makeEdge("d1", "end")],
    };
    const promise = runWorkflow(workflow);
    // 轮询睡眠（50ms）后探得取消 → signal 中止 → 延时节点被打断 → 停止调度
    await vi.advanceTimersByTimeAsync(100);
    const summary = await promise;
    expect(summary.status).toBe("cancelled");
    expect(summary.error).toBe("运行已被取消");
    expect(summary.nodeRuns.d1?.status).toBe("failed");
    // 取消后不再启动新节点：end 保持 skipped
    expect(summary.nodeRuns.end?.status).toBe("skipped");
  });

  it("显式传入 signal 时不轮询宿主取消（调用方信号优先）", async () => {
    const cancelled = vi.fn(async () => false);
    stubReplayHost({ cancelled });
    const controller = new AbortController();
    const summary = await runWorkflow(
      {
        id: "wf-explicit-signal",
        nodes: [
          makeNode("s", "start"),
          makeNode("a", "httpReplay", {
            manualRequest: { method: "GET", url: "https://example.test/a" },
          }),
        ],
        edges: [makeEdge("s", "a")],
      },
      { signal: controller.signal },
    );
    expect(summary.status).toBe("success");
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("无宿主桥时不接线：运行行为与既有逐字节一致", async () => {
    const summary = await runWorkflow({
      id: "wf-no-bridge",
      nodes: [makeNode("s", "start")],
      edges: [],
    });
    expect(summary.status).toBe("success");
    expect(summary.nodeRuns.s?.status).toBe("success");
  });

  it("取消时循环节点已完成轮次照常结算：聚合输出保留、在途轮记 cancelled", async () => {
    let calls = 0;
    const controller = new AbortController();
    const replay = vi.fn(async (payload: { url: string }) => {
      calls += 1;
      if (calls === 2) controller.abort(); // 第 2 轮出站后取消（第 1 轮已完整结算）
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ item: payload.url }),
        durationMs: 1,
      };
    });
    vi.stubGlobal("host", { replay });
    const summary = await runWorkflow(
      {
        id: "wf-loop-cancel",
        nodes: [
          makeNode("s", "start"),
          makeNode("loop", "loop", { items: [1, 2, 3] }),
          makeNode("body1", "httpReplay", {
            manualRequest: { method: "GET", url: "https://example.test/it-{{ var.loop.item }}" },
          }),
        ],
        edges: [makeEdge("s", "loop"), makeEdge("loop", "body1")],
      },
      { signal: controller.signal },
    );
    expect(summary.status).toBe("cancelled");
    // 循环节点自然结算（success）：已完成轮次聚合保留
    expect(summary.nodeRuns.loop?.status).toBe("success");
    const output = summary.nodeRuns.loop?.output as Array<{ body: string }>;
    expect(output).toHaveLength(1);
    expect(output[0]?.body).toBe(JSON.stringify({ item: "https://example.test/it-1" }));
    // 逐迭代明细：第 1 轮 success、第 2 轮 cancelled（第 3 轮未启动）
    const iterations = summary.nodeRuns.loop?.iterations as {
      total: number;
      done: number;
      records: Array<{ index: number; status: string }>;
    };
    expect(iterations.done).toBe(2);
    expect(iterations.records.map((r) => [r.index, r.status])).toEqual([
      [0, "success"],
      [1, "cancelled"],
    ]);
    // 取消后不再发起新一轮出站
    expect(calls).toBe(2);
  });
});

describe("runWorkflow 指定节点重跑装配面（Task 20）", () => {
  it("上游闭包预置输出与快照（不再出站），起点及其下游重新执行", async () => {
    const replay = stubReplayHost();
    const workflow = {
      id: "wf-resume",
      nodes: [
        makeNode("s", "start"),
        makeNode("a", "httpReplay", {
          manualRequest: { method: "GET", url: "https://example.test/a" },
        }),
        makeNode("b", "httpReplay", {
          manualRequest: { method: "GET", url: "https://example.test/b" },
        }),
      ],
      edges: [makeEdge("s", "a"), makeEdge("a", "b")],
    };
    const first = await runWorkflow(workflow);
    expect(first.status).toBe("success");
    expect(replay).toHaveBeenCalledTimes(2);

    // 重跑 b：上游闭包（a 与 start）以源运行输出 / 快照预置（start 输出为 null）
    const closure = computeUpstreamClosure(workflow.nodes, workflow.edges, "b");
    expect(closure).toEqual(["a", "s"]);
    const second = await runWorkflow(workflow, {
      resume: {
        fromNode: "b",
        outputs: { a: first.nodeRuns.a?.output, s: first.nodeRuns.s?.output },
        nodeRuns: { a: first.nodeRuns.a as never, s: first.nodeRuns.s as never },
      },
    });
    expect(second.status).toBe("success");
    // 只有 b 重新出站（a 沿用源运行）
    expect(replay).toHaveBeenCalledTimes(3);
    expect(second.nodeRuns.a?.status).toBe("success");
    expect(second.nodeRuns.a?.output).toEqual(first.nodeRuns.a?.output);
    expect(second.nodeRuns.b?.status).toBe("success");
    expect(second.nodeRuns.b?.input).toEqual(first.nodeRuns.a?.output);
  });

  it("上游闭包缺输出：建档前整单判 failed 并列出缺输出节点，不执行任何节点", async () => {
    const replay = stubReplayHost();
    const workflow = {
      id: "wf-resume-missing",
      nodes: [
        makeNode("s", "start"),
        makeNode("a", "httpReplay", {
          manualRequest: { method: "GET", url: "https://example.test/a" },
        }),
        makeNode("b", "httpReplay", {
          manualRequest: { method: "GET", url: "https://example.test/b" },
        }),
      ],
      edges: [makeEdge("s", "a"), makeEdge("a", "b")],
    };
    const summary = await runWorkflow(workflow, {
      resume: { fromNode: "b", outputs: { s: null }, nodeRuns: {} },
    });
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("a");
    expect(summary.error).toContain("无成功输出");
    expect(Object.keys(summary.nodeRuns)).toEqual([]);
    expect(replay).not.toHaveBeenCalled();
  });
});
