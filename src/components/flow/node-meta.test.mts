import { describe, expect, test } from "vitest";
import type { WorkflowNode, WorkflowNodeType } from "../../api/types";
import {
  WORKFLOW_NODE_META,
  WORKFLOW_NODE_TYPE_ORDER,
  getWorkflowNodeMeta,
  nodeBadge,
  nodeSummary,
} from "./node-meta";

function node(type: WorkflowNodeType, config: Record<string, unknown> = {}): WorkflowNode {
  return { id: `n-${type}`, type, position: { x: 0, y: 0 }, config };
}

describe("node registry", () => {
  test("registers all nine workflow node types and the panel order matches", () => {
    expect(Object.keys(WORKFLOW_NODE_META).sort()).toEqual(
      [
        "assert",
        "condition",
        "delay",
        "httpReplay",
        "loop",
        "setVariable",
        "start",
        "stickyNote",
        "transform",
      ].sort(),
    );
    expect([...WORKFLOW_NODE_TYPE_ORDER].sort()).toEqual(Object.keys(WORKFLOW_NODE_META).sort());
  });

  test("handle layout follows the domain model", () => {
    expect(WORKFLOW_NODE_META.start.handles).toBe("source-only");
    expect(WORKFLOW_NODE_META.httpReplay.handles).toBe("target-source");
    expect(WORKFLOW_NODE_META.condition.handles).toBe("target-source");
    expect(WORKFLOW_NODE_META.stickyNote.handles).toBe("none");
  });

  test("unknown types fall back to the httpReplay handling semantics", () => {
    const fallback = getWorkflowNodeMeta("something-new");
    expect(fallback).toBe(WORKFLOW_NODE_META.httpReplay);
  });
});

describe("node summaries", () => {
  test("start keeps its description", () => {
    expect(nodeSummary(node("start"))).toBe("流程起点，无需配置");
  });

  test("httpReplay prefers library reference then manual request", () => {
    expect(nodeSummary(node("httpReplay", { requestId: "req-9" }))).toBe("请求库 req-9");
    expect(
      nodeSummary(
        node("httpReplay", { manualRequest: { method: "POST", url: "https://a.dev/x" } }),
      ),
    ).toBe("POST https://a.dev/x");
    expect(nodeSummary(node("httpReplay"))).toBe("未引用请求");
  });

  test("condition falls back to the always-false hint without an expression", () => {
    expect(nodeSummary(node("condition", { expression: " a == b " }))).toBe("a == b");
    expect(nodeSummary(node("condition"))).toBe("未配置条件（恒走假分支）");
  });

  test("delay renders seconds and stays defensive on bad shapes", () => {
    expect(nodeSummary(node("delay", { durationMs: 1000 }))).toBe("等待 1 秒");
    expect(nodeSummary(node("delay", { durationMs: 1500 }))).toBe("等待 1.5 秒");
    expect(nodeSummary(node("delay", { durationMs: "soon" }))).toBe("未配置时长");
  });

  test("count based summaries tolerate missing or malformed arrays", () => {
    expect(nodeSummary(node("setVariable", { assignments: [1, 2] }))).toBe("2 项赋值");
    expect(nodeSummary(node("assert", { assertions: "bad" }))).toBe("未配置断言（纯透传）");
    expect(nodeSummary(node("transform", { extractions: [{}] }))).toBe("1 条提取");
  });

  test("sticky note trims whitespace and reports empty notes", () => {
    expect(nodeSummary(node("stickyNote", { text: "  token 10 分钟过期\n" }))).toContain(
      "token 10 分钟过期",
    );
    expect(nodeSummary(node("stickyNote"))).toBe("空便签");
  });
});

describe("node badges", () => {
  test("loop renders the iteration cap; counts render as n项 / n条", () => {
    expect(nodeBadge(node("loop", { maxIterations: 100 }))).toBe("≤100");
    expect(nodeBadge(node("loop", { maxIterations: -1 }))).toBeUndefined();
    expect(nodeBadge(node("setVariable", { assignments: [1] }))).toBe("1项");
    expect(nodeBadge(node("assert", { assertions: [1, 2] }))).toBe("2条");
  });

  test("types without badges render nothing", () => {
    expect(nodeBadge(node("httpReplay", { requestId: "req-9" }))).toBeUndefined();
    expect(nodeBadge(node("start"))).toBeUndefined();
  });
});
