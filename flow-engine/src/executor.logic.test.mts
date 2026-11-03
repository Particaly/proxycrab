import { describe, expect, it, vi } from "vitest";
import { executeWorkflow } from "./executor";
import type { DownstreamSelection, NodeRunner } from "./executor";
import type { NodeRun } from "./types";
import { asEdgeId, asNodeId, asWorkflowId } from "./types";
import type { WorkflowEdge, WorkflowNode } from "./types";

/**
 * M7-T1 执行器扩展点测试（纯增量：既有 executor.test.ts 锁定的调度语义不在此
 * 重复）：ExecutorOptions.selectDownstream（下游选择——未注册时行为不变、数组
 * 过滤、被排除节点经其它路径再激活）、ExecutorOptions.nestedNodeRun（收尾时
 * pending 节点的嵌套快照解析）。全部用 fake runner，零环境依赖。
 */

let idSeq = 0;

/** 构造画布节点（默认 httpReplay 类型） */
function makeNode(id: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id: asNodeId(id), type: "httpReplay", position: { x: 0, y: 0 }, config };
}

/** 构造连线 */
function makeEdge(source: string, target: string): WorkflowEdge {
  return {
    id: asEdgeId(`${source}->${target}`),
    source: asNodeId(source),
    target: asNodeId(target),
  };
}

/** 构造最小可执行工作流入参 */
function makeWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  return { id: asWorkflowId(`wf-${++idSeq}`), nodes, edges };
}

/** no-op runner（condition / loop 等节点类型的占位，使节点照常 success） */
const noop: NodeRunner = async () => null;

/** 记录执行顺序的假 runner */
function recording(
  order: string[],
  output: (node: WorkflowNode) => unknown = () => null,
): NodeRunner {
  return async (node) => {
    order.push(node.id);
    return output(node);
  };
}

describe("ExecutorOptions.selectDownstream（下游选择扩展点）", () => {
  it("未注册选择器：所有下游照常执行（既有行为，测试锁定）", async () => {
    const workflow = makeWorkflow(
      [
        { id: asNodeId("s"), type: "start", position: { x: 0, y: 0 }, config: {} },
        makeNode("a"),
        makeNode("b"),
      ],
      [makeEdge("s", "a"), makeEdge("s", "b")],
    );
    const order: string[] = [];
    const summary = await executeWorkflow(workflow, { runners: { httpReplay: recording(order) } });
    expect(summary.status).toBe("success");
    expect(order).toEqual(["a", "b"]);
  });

  it("选择器返回数组：只调度命中的 target，未命中者收尾 skipped", async () => {
    const workflow = makeWorkflow(
      [
        { id: asNodeId("s"), type: "start", position: { x: 0, y: 0 }, config: {} },
        { id: asNodeId("c"), type: "condition", position: { x: 0, y: 0 }, config: {} },
        makeNode("t"),
        makeNode("f"),
      ],
      [makeEdge("s", "c"), makeEdge("c", "t"), makeEdge("c", "f")],
    );
    const order: string[] = [];
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: recording(order), condition: noop, loop: noop },
      // 伪选择器：condition 节点只放行 t（模拟真分支命中）
      selectDownstream: (node): DownstreamSelection =>
        node.type === "condition" ? [asNodeId("t")] : "all",
    });
    expect(summary.status).toBe("success");
    expect(order).toEqual(["t"]);
    expect(summary.nodeRuns[asNodeId("f")]?.status).toBe("skipped");
  });

  it("被排除的节点可从其它路径再激活：其它成功路径在条件节点之后结算 → 正常执行", async () => {
    // s → c（condition，排除 f）、s → m、m → f：m 在 c 之后完成，
    // scheduleDownstream(m) 时 f 的全部上游已结算 → f 正常执行（仅一次）
    const workflow = makeWorkflow(
      [
        { id: asNodeId("s"), type: "start", position: { x: 0, y: 0 }, config: {} },
        { id: asNodeId("c"), type: "condition", position: { x: 0, y: 0 }, config: {} },
        makeNode("m"),
        makeNode("f"),
      ],
      [makeEdge("s", "c"), makeEdge("s", "m"), makeEdge("m", "f"), makeEdge("c", "f")],
    );
    const order: string[] = [];
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: recording(order), condition: noop, loop: noop },
      selectDownstream: (node): DownstreamSelection => (node.type === "condition" ? [] : "all"), // 条件节点不放行任何直接下游
    });
    expect(summary.status).toBe("success");
    expect(order).toEqual(["m", "f"]);
    expect(summary.nodeRuns[asNodeId("f")]?.status).toBe("success");
  });

  it("选择器返回空数组且无其它路径：目标节点 skipped，运行照常 success", async () => {
    const workflow = makeWorkflow(
      [
        { id: asNodeId("s"), type: "start", position: { x: 0, y: 0 }, config: {} },
        { id: asNodeId("c"), type: "condition", position: { x: 0, y: 0 }, config: {} },
        makeNode("t"),
      ],
      [makeEdge("s", "c"), makeEdge("c", "t")],
    );
    const order: string[] = [];
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: recording(order), condition: noop },
      selectDownstream: () => [],
    });
    expect(summary.status).toBe("success");
    expect(order).toEqual([]);
    expect(summary.nodeRuns[asNodeId("t")]?.status).toBe("skipped");
  });
});

describe("ExecutorOptions.nestedNodeRun（嵌套运行快照解析）", () => {
  it("pending 节点能解析到快照 → 以快照代替统一 skipped；解析不到 → skipped 不变", async () => {
    const workflow = makeWorkflow(
      [
        { id: asNodeId("s"), type: "start", position: { x: 0, y: 0 }, config: {} },
        { id: asNodeId("L"), type: "loop", position: { x: 0, y: 0 }, config: {} },
        makeNode("a"),
        makeNode("lonely"),
      ],
      [makeEdge("s", "L"), makeEdge("L", "a")],
    );
    const lastRoundA: NodeRun = {
      status: "success",
      input: null,
      output: { item: "x" },
      startedAt: 1,
      durationMs: 2,
    };
    const summary = await executeWorkflow(workflow, {
      // 选择器恒空：模拟「循环体由子运行执行、父调度器不入队」的形态（a 恒 pending）
      runners: { loop: async () => ({ done: true }), httpReplay: noop },
      selectDownstream: () => [],
      nestedNodeRun: (node) => (node.id === asNodeId("a") ? lastRoundA : undefined),
    });
    expect(summary.status).toBe("success");
    // a 从未在本层调度器入队，但嵌套运行执行过 → 快照为「最后一轮」
    expect(summary.nodeRuns[asNodeId("a")]).toBe(lastRoundA);
    // lonely 从 start 不可达且无嵌套快照 → 保持既有 skipped 语义
    expect(summary.nodeRuns[asNodeId("lonely")]?.status).toBe("skipped");
  });

  it("未提供 nestedNodeRun：pending 节点统一 skipped（既有行为不变）", async () => {
    const workflow = makeWorkflow(
      [
        { id: asNodeId("s"), type: "start", position: { x: 0, y: 0 }, config: {} },
        { id: asNodeId("L"), type: "loop", position: { x: 0, y: 0 }, config: {} },
        makeNode("a"),
      ],
      [makeEdge("s", "L"), makeEdge("L", "a")],
    );
    const summary = await executeWorkflow(workflow, {
      runners: { loop: async () => ({ done: true }), httpReplay: noop },
      selectDownstream: () => [],
    });
    expect(summary.nodeRuns[asNodeId("a")]?.status).toBe("skipped");
    expect(summary.nodeRuns[asNodeId("a")]?.output).toBeNull();
  });

  it("扩展点全部缺席：调度语义与既有完全一致（事件照常发出）", async () => {
    const workflow = makeWorkflow(
      [{ id: asNodeId("s"), type: "start", position: { x: 0, y: 0 }, config: {} }, makeNode("a")],
      [makeEdge("s", "a")],
    );
    const onNodeStart = vi.fn();
    const summary = await executeWorkflow(workflow, {
      runners: { httpReplay: recording([]) },
      onNodeStart,
    });
    expect(summary.status).toBe("success");
    expect(onNodeStart).toHaveBeenCalledTimes(2); // start 与 a 各一次，与既有行为一致
  });
});
