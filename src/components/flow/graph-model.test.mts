import { describe, expect, test } from "vitest";
import type { WorkflowEdge, WorkflowNode } from "../../api/types";
import {
  applyNodePositions,
  graphSignature,
  starterGraph,
  toFlowEdges,
  toFlowNodes,
} from "./graph-model";

function node(id: string, x: number, y: number, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type: "httpReplay", position: { x, y }, config: {}, ...extra };
}

function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: "true" | "false",
): WorkflowEdge {
  return { id, source, target, ...(sourceHandle ? { sourceHandle } : {}) };
}

describe("starter graph", () => {
  test("seeds exactly one start node without edges", () => {
    const graph = starterGraph();
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]!.type).toBe("start");
    expect(graph.edges).toEqual([]);
  });
});

describe("model to Vue Flow projection", () => {
  test("nodes carry the domain node on data and keep type and position", () => {
    const model = [node("a", 10, 20, { label: "自定义" })];
    const flowNodes = toFlowNodes(model);
    expect(flowNodes).toEqual([
      { id: "a", type: "httpReplay", position: { x: 10, y: 20 }, data: { node: model[0] } },
    ]);
  });

  test("edges pass the branch handle through and omit undefined handles", () => {
    expect(toFlowEdges([edge("e1", "a", "b", "true"), edge("e2", "b", "c")])).toEqual([
      { id: "e1", source: "a", target: "b", sourceHandle: "true" },
      { id: "e2", source: "b", target: "c" },
    ]);
  });
});

describe("applyNodePositions", () => {
  test("moves only touched nodes and returns a new array", () => {
    const model = [node("a", 0, 0), node("b", 5, 5)];
    const next = applyNodePositions(model, [{ id: "a", x: 12, y: -3 }]);
    expect(next).toEqual([node("a", 12, -3), node("b", 5, 5)]);
    expect(next).not.toBe(model);
    expect(model[0]!.position).toEqual({ x: 0, y: 0 });
  });

  test("returns null when nothing changes", () => {
    const model = [node("a", 0, 0)];
    expect(applyNodePositions(model, [])).toBeNull();
    expect(applyNodePositions(model, [{ id: "missing", x: 1, y: 1 }])).toBeNull();
    expect(applyNodePositions(model, [{ id: "a", x: 0, y: 0 }])).toBeNull();
    expect(applyNodePositions(model, [{ id: "a", x: Number.NaN, y: 1 }])).toBeNull();
  });
});

describe("graphSignature", () => {
  test("ignores node order but reflects positions, labels, config and edges", () => {
    const base = [node("a", 0, 0), node("b", 4, 4)];
    const edges = [edge("e1", "a", "b")];
    const signature = graphSignature(base, edges);
    expect(graphSignature([base[1]!, base[0]!], edges)).toBe(signature);
    expect(graphSignature([node("a", 1, 0), base[1]!], edges)).not.toBe(signature);
    expect(graphSignature(base, [edge("e1", "a", "b", "true")])).not.toBe(signature);
    expect(graphSignature([node("a", 0, 0, { label: "x" }), base[1]!], edges)).not.toBe(signature);
    expect(
      graphSignature([node("a", 0, 0, { config: { timeoutMs: 3 } }), base[1]!], edges),
    ).not.toBe(signature);
  });
});
