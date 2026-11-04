import { describe, expect, it } from "vitest";
import type { WorkflowEdge, WorkflowNode } from "../../api/types";
import {
  badgeIssues,
  collectLocalIssues,
  groupIssuesByNode,
  mergeIssues,
} from "./node-issue-badge";

/**
 * 常驻校验徽标数据口径测试：本地规则（对齐后端 validate.rs 的 error 级 +
 * 前端 warning / info）、服务端结果合并去重、节点归属投影、徽标过滤 info。
 */

function node(
  id: string,
  type: WorkflowNode["type"],
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, config: {}, ...extra };
}

function edge(id: string, source: string, target: string): WorkflowEdge {
  return { id, source, target };
}

function codes(issues: ReturnType<typeof collectLocalIssues>): string[] {
  return issues.map((issue) => issue.code);
}

describe("collectLocalIssues：结构规则（error，对齐后端口径）", () => {
  it("空流程 / 缺开始：missing-start，nodeIds 为空（流程级）", () => {
    expect(codes(collectLocalIssues([], []))).toEqual(["missing-start"]);
    const issues = collectLocalIssues([node("a", "httpReplay")], []);
    expect(codes(issues)).toEqual(["missing-start", "isolated-node"]);
    expect(issues[0]?.nodeIds).toEqual([]);
  });

  it("多个开始节点：multiple-start，nodeIds 列出全部开始节点", () => {
    const issues = collectLocalIssues(
      [node("s1", "start"), node("s2", "start"), node("a", "httpReplay")],
      [],
    );
    const issue = issues.find((item) => item.code === "multiple-start");
    expect(issue?.level).toBe("error");
    expect(issue?.nodeIds.sort()).toEqual(["s1", "s2"]);
  });

  it("连线端点不存在：dangling-edge，nodeIds 只保留仍存在的端点", () => {
    const issues = collectLocalIssues(
      [node("s", "start"), node("a", "httpReplay")],
      [edge("e1", "s", "gone")],
    );
    const issue = issues.find((item) => item.code === "dangling-edge");
    expect(issue?.level).toBe("error");
    expect(issue?.nodeIds).toEqual(["s"]);
  });

  it("便签连线：sticky-note-edge（入边出边均算），nodeIds 指向便签", () => {
    const issues = collectLocalIssues(
      [node("s", "start"), node("note", "stickyNote"), node("a", "httpReplay")],
      [edge("e1", "s", "a"), edge("e2", "note", "a"), edge("e3", "a", "note")],
    );
    const sticky = issues.filter((item) => item.code === "sticky-note-edge");
    expect(sticky).toHaveLength(2);
    expect(sticky[0]?.nodeIds).toEqual(["note"]);
    expect(sticky[1]?.nodeIds).toEqual(["note"]);
  });
});

describe("collectLocalIssues：前端视角（warning / info）", () => {
  it("孤立处理节点：isolated-node warning；开始与便签豁免", () => {
    const issues = collectLocalIssues(
      [node("s", "start"), node("a", "httpReplay"), node("note", "stickyNote")],
      [],
    );
    const isolated = issues.filter((item) => item.code === "isolated-node");
    expect(isolated).toHaveLength(1);
    expect(isolated[0]?.level).toBe("warning");
    expect(isolated[0]?.nodeIds).toEqual(["a"]);
  });

  it("多上游汇合：join-node info（≥2 个不同上游，同源多边算一个）", () => {
    const issues = collectLocalIssues(
      [node("s", "start"), node("a", "httpReplay"), node("b", "httpReplay"), node("j", "assert")],
      [edge("e1", "s", "j"), edge("e2", "a", "j"), edge("e3", "a", "j")],
    );
    const join = issues.filter((item) => item.code === "join-node");
    expect(join).toHaveLength(1);
    expect(join[0]?.level).toBe("info");
    expect(join[0]?.nodeIds).toEqual(["j"]);
  });

  it("正常单链图：无问题", () => {
    const issues = collectLocalIssues(
      [node("s", "start"), node("a", "httpReplay")],
      [edge("e1", "s", "a")],
    );
    expect(issues).toEqual([]);
  });
});

describe("mergeIssues：服务端结果合并", () => {
  it("后端已知 code 映射 error，未知 code 回退 warning", () => {
    const merged = mergeIssues(
      [],
      [
        { code: "refid-conflict", message: "短码冲突", nodeIds: ["a", "b"] },
        { code: "future-rule", message: "未知规则", nodeIds: [] },
      ],
    );
    expect(merged[0]?.level).toBe("error");
    expect(merged[1]?.level).toBe("warning");
  });

  it("与本地同 code 且同归属节点的问题去重（保留服务端文案）", () => {
    const local = collectLocalIssues(
      [
        node("s", "start"),
        node("note", "stickyNote"),
        node("a", "httpReplay"),
        node("b", "httpReplay"),
      ],
      [edge("e1", "note", "a")],
    );
    const merged = mergeIssues(local, [
      { code: "sticky-note-edge", message: "服务端文案", nodeIds: ["note"] },
    ]);
    const sticky = merged.filter((item) => item.code === "sticky-note-edge");
    expect(sticky).toHaveLength(1);
    expect(sticky[0]?.message).toBe("服务端文案");
    // 本地其余问题保留（b 孤立）
    expect(merged.some((item) => item.code === "isolated-node")).toBe(true);
  });

  it("同 code 但归属节点不同：不去重（两处都提示）", () => {
    const local = collectLocalIssues(
      [node("s", "start"), node("note", "stickyNote"), node("a", "httpReplay")],
      [edge("e1", "note", "a")],
    );
    const merged = mergeIssues(local, [
      { code: "sticky-note-edge", message: "另一处", nodeIds: ["note", "a"] },
    ]);
    expect(merged.filter((item) => item.code === "sticky-note-edge")).toHaveLength(2);
  });
});

describe("groupIssuesByNode / badgeIssues", () => {
  it("按 nodeIds 归属到每个节点；流程级问题不落表", () => {
    const issues = mergeIssues(collectLocalIssues([node("a", "httpReplay")], []), []);
    const table = groupIssuesByNode(issues);
    expect(table.has("a")).toBe(true);
    expect(table.get("a")?.every((issue) => issue.code !== "missing-start")).toBe(true);
  });

  it("badgeIssues 过滤 info 级（徽标不计数语义披露）", () => {
    const kept = badgeIssues([
      { level: "error", code: "x", message: "", nodeIds: ["a"] },
      { level: "warning", code: "y", message: "", nodeIds: ["a"] },
      { level: "info", code: "join-node", message: "", nodeIds: ["a"] },
    ]);
    expect(kept.map((issue) => issue.code)).toEqual(["x", "y"]);
  });
});
