import { describe, expect, it } from "vitest";
import type { NodeConfig, WorkflowEdge, WorkflowNode } from "./types";
import { asEdgeId, asNodeId } from "./types";
import { createWorkflowDownstreamSelector } from "./logic-nodes";

/**
 * M16-T1 条件分支**手柄路由**测试（node 环境，纯函数）：出边带 sourceHandle
 * （'true' / 'false'）时按手柄放行（连线即分支）；未带手柄的出边照常放行
 * （未迁移存量数据的旧「未绑定」语义）；节点无任何带手柄出边时回退 legacy
 * 清单路由（M7-T1 原语义，见 logic-nodes.test.ts 既有用例锁定）。
 */

/** 条件节点夹具（config 可为 legacy 清单） */
function conditionNode(config: NodeConfig = {}): WorkflowNode {
  return { id: asNodeId("c1"), type: "condition", position: { x: 0, y: 0 }, config };
}

/** 普通节点夹具（仅作下游端点占位） */
function plainNode(id: string): WorkflowNode {
  return { id: asNodeId(id), type: "httpReplay", position: { x: 0, y: 0 }, config: {} };
}

/** 出边夹具（可选手柄） */
function outEdge(id: string, target: string, sourceHandle?: "true" | "false"): WorkflowEdge {
  return {
    id: asEdgeId(id),
    source: asNodeId("c1"),
    target: asNodeId(target),
    ...(sourceHandle !== undefined ? { sourceHandle } : {}),
  };
}

/** 选中结果（断言辅助：'all' 或 target id 数组） */
function select(nodes: WorkflowNode[], edges: WorkflowEdge[], branch: "true" | "false") {
  const selector = createWorkflowDownstreamSelector(nodes, edges);
  return selector(conditionNode(nodes[0]?.config), { branch, value: branch === "true" });
}

describe("条件分支出边手柄路由（M16-T1）", () => {
  const nodes = [conditionNode(), plainNode("t1"), plainNode("f1")];

  it("真分支：仅真出口出边放行（假出口下游不放行）", () => {
    const edges = [outEdge("e1", "t1", "true"), outEdge("e2", "f1", "false")];
    expect(select(nodes, edges, "true")).toEqual(["t1"]);
    expect(select(nodes, edges, "false")).toEqual(["f1"]);
  });

  it("同一对节点可真 / 假各连一条（走两个分支都执行：两条边各按自己的手柄放行）", () => {
    const edges = [outEdge("e1", "t1", "true"), outEdge("e2", "t1", "false")];
    expect(select(nodes, edges, "true")).toEqual(["t1"]);
    expect(select(nodes, edges, "false")).toEqual(["t1"]);
  });

  it("出口未连接任何下游：该分支不执行后续（空数组）", () => {
    const edges = [outEdge("e1", "t1", "true")];
    expect(select(nodes, edges, "true")).toEqual(["t1"]);
    expect(select(nodes, edges, "false")).toEqual([]);
  });

  it("未带手柄的旧出边（未迁移数据）照常放行：两个分支都执行", () => {
    const edges = [outEdge("e1", "t1", "true"), outEdge("e2", "f1")];
    expect(select(nodes, edges, "true")).toEqual(["t1", "f1"]);
    expect(select(nodes, edges, "false")).toEqual(["f1"]);
  });

  it("带手柄出边存在时忽略 legacy 清单（清单仅服务未迁移流程）", () => {
    const legacyConfig: NodeConfig = {
      trueTargets: [asNodeId("f1")],
      falseTargets: [asNodeId("t1")],
    };
    const selector = createWorkflowDownstreamSelector(
      [conditionNode(legacyConfig), plainNode("t1"), plainNode("f1")],
      [outEdge("e1", "t1", "true"), outEdge("e2", "f1", "false")],
    );
    // 按手柄路由：真 → t1（清单说真 → f1，被忽略）
    expect(selector(conditionNode(legacyConfig), { branch: "true", value: true })).toEqual(["t1"]);
  });

  it("输出非分支形态（失败 + continue 的 null 输出）→ 放行全部下游（失败不走任何分支）", () => {
    const selector = createWorkflowDownstreamSelector(nodes, [
      outEdge("e1", "t1", "true"),
      outEdge("e2", "f1", "false"),
    ]);
    expect(selector(conditionNode(), null)).toBe("all");
    expect(selector(conditionNode(), { value: true })).toBe("all"); // 非条件输出形态
    expect(selector(conditionNode(), "oops")).toBe("all");
  });

  it("无任何出边（两个出口都未连接）→ 不调度任何下游（零出边时 all 等价于空集）", () => {
    expect(select(nodes, [], "true")).toBe("all");
    expect(select(nodes, [], "false")).toBe("all");
  });

  it("回退路径不受影响：无手柄出边 + legacy 清单仍按清单路由（M7-T1 语义）", () => {
    const legacyConfig: NodeConfig = {
      trueTargets: [asNodeId("t1")],
      falseTargets: [asNodeId("f1")],
    };
    const selector = createWorkflowDownstreamSelector(
      [conditionNode(legacyConfig), plainNode("t1"), plainNode("f1"), plainNode("other")],
      [outEdge("e1", "t1"), outEdge("e2", "f1"), outEdge("e3", "other")],
    );
    // 真分支：命中清单的真目标 + 未列入任何清单的下游（旧「未绑定」语义）
    expect(selector(conditionNode(legacyConfig), { branch: "true", value: true })).toEqual([
      "t1",
      "other",
    ]);
    expect(selector(conditionNode(legacyConfig), { branch: "false", value: false })).toEqual([
      "f1",
      "other",
    ]);
  });
});
