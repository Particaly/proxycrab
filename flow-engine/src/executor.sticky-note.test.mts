import { describe, expect, it, vi } from "vitest";
import type { WorkflowEdge, WorkflowNode } from "./types";
import { asEdgeId, asNodeId, asWorkflowId } from "./types";
import { createWorkflowDownstreamSelector, computeLoopBody } from "./logic-nodes";
import { executeWorkflow, validateWorkflowGraph } from "./executor";

/**
 * 便签（stickyNote）执行拓扑零影响测试（M13-T5，node 环境）：
 *   - 图校验：触及便签的连线判非法（fail-fast），正常便签图合法；
 *   - 执行：孤立便签天然不执行、运行记录（nodeRuns）不含便签条目，
 *     正常节点链路不受影响；脏数据（便签被连线）在建档前整体判 failed；
 *   - 循环体计划：computeLoopBody 对便签显式排除（脏数据下也不准入体内）；
 *   - 下游选择器：便签存在时既有语义不变（loop 空体 'all' 等既有约定）。
 */

/** 节点夹具 */
function makeNode(
  id: string,
  type: WorkflowNode["type"],
  config: WorkflowNode["config"] = {},
): WorkflowNode {
  return { id: asNodeId(id), type, position: { x: 0, y: 0 }, config };
}
/** 连线夹具 */
function makeEdge(id: string, source: string, target: string): WorkflowEdge {
  return { id: asEdgeId(id), source: asNodeId(source), target: asNodeId(target) };
}

/** 便签节点夹具（可带注释文本） */
function makeSticky(id: string, text = "token 10 分钟过期"): WorkflowNode {
  return makeNode(id, "stickyNote", { text, color: "amber" });
}

describe("validateWorkflowGraph：便签连线校验（M13-T5）", () => {
  it("含孤立便签的正常图合法（便签不触发任何错误）", () => {
    const nodes = [makeNode("s", "start"), makeNode("h", "httpReplay"), makeSticky("note")];
    expect(validateWorkflowGraph(nodes, [makeEdge("e1", "s", "h")])).toEqual([]);
  });

  it("连线以便签为 source 判非法（错误信息点名便签）", () => {
    const nodes = [makeNode("s", "start"), makeNode("h", "httpReplay"), makeSticky("note")];
    const errors = validateWorkflowGraph(nodes, [makeEdge("e1", "note", "h")]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("便签");
    expect(errors[0]).toContain("e1");
  });

  it("连线以便签为 target 同样判非法", () => {
    const nodes = [makeNode("s", "start"), makeSticky("note")];
    const errors = validateWorkflowGraph(nodes, [makeEdge("e1", "s", "note")]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("便签");
  });
});

describe("executeWorkflow：便签不入执行拓扑（M13-T5）", () => {
  it("孤立便签不执行：run success，nodeRuns 只含真实节点（无便签 skipped 条目）", async () => {
    const nodes = [makeNode("s", "start"), makeNode("h", "httpReplay"), makeSticky("note")];
    const summary = await executeWorkflow(
      { id: asWorkflowId("w1"), nodes, edges: [makeEdge("e1", "s", "h")] },
      { runners: { httpReplay: async () => "replayed" } },
    );
    expect(summary.status).toBe("success");
    expect(Object.keys(summary.nodeRuns).sort()).toEqual(["h", "s"]);
    expect(summary.nodeRuns[asNodeId("h")]?.output).toBe("replayed");
    expect(summary.nodeRuns[asNodeId("note")]).toBeUndefined();
  });

  it("脏数据（便签被连线）：执行前置校验整体判 failed，不启动任何节点", async () => {
    const nodes = [makeNode("s", "start"), makeNode("h", "httpReplay"), makeSticky("note")];
    const onNodeStart = vi.fn();
    const summary = await executeWorkflow(
      {
        id: asWorkflowId("w1"),
        nodes,
        edges: [makeEdge("e1", "s", "h"), makeEdge("e2", "note", "h")],
      },
      { runners: { httpReplay: async () => "replayed" }, onNodeStart },
    );
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("便签");
    expect(summary.nodeRuns).toEqual({});
    expect(onNodeStart).not.toHaveBeenCalled();
  });

  it("含便签的流程照常走分支 / 变量等既有调度（便签对调度零参与）", async () => {
    const nodes = [
      makeNode("s", "start"),
      makeNode("h1", "httpReplay"),
      makeNode("h2", "httpReplay"),
      makeSticky("note"),
    ];
    const order: string[] = [];
    const summary = await executeWorkflow(
      {
        id: asWorkflowId("w1"),
        nodes,
        edges: [makeEdge("e1", "s", "h1"), makeEdge("e2", "h1", "h2")],
      },
      {
        runners: {
          httpReplay: async (node) => {
            order.push(node.id);
            return `out-${node.id}`;
          },
        },
        // 下游选择器（M7-T1 标准装配）在含便签的图上照常工作
        selectDownstream: createWorkflowDownstreamSelector(nodes, [
          makeEdge("e1", "s", "h1"),
          makeEdge("e2", "h1", "h2"),
        ]),
      },
    );
    expect(summary.status).toBe("success");
    // start 为内置 runner（不进 order），httpReplay 链按序执行
    expect(order).toEqual(["h1", "h2"]);
    expect(summary.nodeRuns[asNodeId("note")]).toBeUndefined();
  });
});

describe("computeLoopBody：循环体计划排除便签（M13-T5）", () => {
  it("脏数据下 loop → 便签：便签不准入体内（计划为空，不会被子运行执行）", () => {
    const nodes = [makeNode("loop", "loop"), makeSticky("note")];
    const edges = [makeEdge("e1", "loop", "note")];
    const plan = computeLoopBody(asNodeId("loop"), nodes, edges);
    expect(plan.bodyNodes).toEqual([]);
    expect(plan.entryIds).toEqual([]);
    expect(plan.bodyEdges).toEqual([]);
  });

  it("脏数据下 loop → 体内节点 → 便签：体内真实节点照常入体，便签被排除", () => {
    const nodes = [makeNode("loop", "loop"), makeNode("a", "httpReplay"), makeSticky("note")];
    const edges = [makeEdge("e1", "loop", "a"), makeEdge("e2", "a", "note")];
    const plan = computeLoopBody(asNodeId("loop"), nodes, edges);
    expect(plan.bodyNodes.map((node) => node.id)).toEqual([asNodeId("a")]);
    expect(plan.entryIds).toEqual([asNodeId("a")]);
    expect(plan.bodyEdges).toEqual([]);
    // 便签不入体 → a 无体内出边 → a 成为汇点（聚合语义保持）
    expect(plan.sinkIds).toEqual([asNodeId("a")]);
  });
});

describe("createWorkflowDownstreamSelector：便签存在时语义不变（M13-T5）", () => {
  it("loop 空体（下游仅便签的脏数据被 computeLoopBody 排除）照常返回 all", () => {
    const nodes = [makeNode("loop", "loop"), makeSticky("note")];
    const edges = [makeEdge("e1", "loop", "note")];
    const select = createWorkflowDownstreamSelector(nodes, edges);
    expect(select(makeNode("loop", "loop"), null)).toBe("all");
  });

  it("普通节点（含便签邻居）返回 all，不受便签影响", () => {
    const nodes = [makeNode("s", "start"), makeNode("h", "httpReplay"), makeSticky("note")];
    const edges = [makeEdge("e1", "s", "h")];
    const select = createWorkflowDownstreamSelector(nodes, edges);
    expect(select(nodes[1] as WorkflowNode, "out")).toBe("all");
  });
});
