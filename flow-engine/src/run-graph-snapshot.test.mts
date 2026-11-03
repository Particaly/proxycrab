import { describe, expect, it } from "vitest";
import type { WorkflowEdge, WorkflowNode } from "./types";
import { asEdgeId, asNodeId, asRequestId, asRunId } from "./types";
import { RUN_GRAPH_SNAPSHOT_MAX_BYTES, buildRunGraphSnapshot } from "./run-graph-snapshot";

/**
 * 运行时图快照构建测试（M17-T1，node 环境）：
 *   - 保真：JSON 安全深拷贝（与源流程零共享引用，源流程后续编辑不影响快照）；
 *   - 恒定剥离：config.pinnedOutput 一律不进快照，其余 config 字段原样保留；
 *   - 体积降级：超限转骨架形态（仅 id / type / position / label? / refId?，
 *     config 清空）并置 truncated，连线照常保留；降级结果自身合规；
 *   - 确定性与图数据幂等：重复构建 / 以快照为输入再构建，nodes / edges 深度相等。
 */

/** 构造节点（缺省 httpReplay + 可辨识的 config 内容） */
function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: asNodeId("n1"),
    type: "httpReplay",
    position: { x: 10, y: 20 },
    config: { requestId: asRequestId("req-1"), timeoutMs: 5000 },
    ...overrides,
  };
}

/** 构造连线 */
function makeEdge(overrides: Partial<WorkflowEdge> = {}): WorkflowEdge {
  return {
    id: asEdgeId("e1"),
    source: asNodeId("n1"),
    target: asNodeId("n2"),
    ...overrides,
  };
}

describe("buildRunGraphSnapshot：保真深拷贝", () => {
  it("节点 / 连线为纯数据副本：与源流程零共享引用，源后续编辑不影响快照", () => {
    const sourceNodes = [makeNode()];
    const sourceEdges = [makeEdge()];
    const snapshot = buildRunGraphSnapshot(sourceNodes, sourceEdges);

    // 不是同引用（深拷贝）
    expect(snapshot.nodes[0]).not.toBe(sourceNodes[0]);
    expect(snapshot.nodes[0]?.config).not.toBe(sourceNodes[0]?.config);
    expect(snapshot.edges[0]).not.toBe(sourceEdges[0]);

    // 源流程原地修改：快照不受影响
    sourceNodes[0]!.config.timeoutMs = 999;
    sourceNodes[0]!.position.x = 777;
    sourceEdges[0]!.target = asNodeId("n3");

    expect(snapshot.nodes[0]?.config.timeoutMs).toBe(5000);
    expect(snapshot.nodes[0]?.position).toEqual({ x: 10, y: 20 });
    expect(snapshot.edges[0]?.target).toBe("n2");
  });

  it("label / refId / sourceHandle 等字段原样保真", () => {
    const snapshot = buildRunGraphSnapshot(
      [makeNode({ label: "登录", refId: "abcde" })],
      [makeEdge({ sourceHandle: "false" })],
    );

    expect(snapshot.nodes[0]?.label).toBe("登录");
    expect(snapshot.nodes[0]?.refId).toBe("abcde");
    expect(snapshot.edges[0]?.sourceHandle).toBe("false");
  });

  it("空图：返回空数组快照（不降级）", () => {
    const snapshot = buildRunGraphSnapshot([], []);
    expect(snapshot).toEqual({ nodes: [], edges: [] });
    expect(snapshot.truncated).toBeUndefined();
  });
});

describe("buildRunGraphSnapshot：恒定剥离固定输出", () => {
  it("config.pinnedOutput 不进快照，其余 config 字段原样保留", () => {
    const node = makeNode({
      config: {
        requestId: asRequestId("req-1"),
        timeoutMs: 5000,
        pinnedOutput: {
          value: { huge: "x".repeat(100) },
          pinnedAt: 1,
          sourceRunId: asRunId("run-0"),
        },
      },
    });
    const snapshot = buildRunGraphSnapshot([node], []);

    expect(snapshot.nodes[0]?.config).toEqual({ requestId: "req-1", timeoutMs: 5000 });
    expect(snapshot.nodes[0]?.config.pinnedOutput).toBeUndefined();
    // 源节点不被改动（剥离只发生在副本上）
    expect(node.config.pinnedOutput).toBeDefined();
  });

  it("极端体积的 pinnedOutput（> 上限）被剔除后不触发降级", () => {
    const node = makeNode({
      config: {
        timeoutMs: 1,
        // 512KB 固定输出：若未剥离必然超 256KB 上限
        pinnedOutput: {
          value: "p".repeat(512 * 1024),
          pinnedAt: 1,
          sourceRunId: asRunId("run-0"),
        },
      },
    });
    const snapshot = buildRunGraphSnapshot([node], []);

    expect(snapshot.truncated).toBeUndefined();
    expect(snapshot.nodes[0]?.config).toEqual({ timeoutMs: 1 });
  });
});

describe("buildRunGraphSnapshot：体积超限降级", () => {
  it("超限转骨架形态：仅 id / type / position / label? / refId?（config 清空）+ truncated 披露", () => {
    const node = makeNode({
      label: "登录",
      refId: "abcde",
      config: { preProcess: "x".repeat(2048), postProcess: "y".repeat(2048) },
    });
    const snapshot = buildRunGraphSnapshot([node], [makeEdge()], { maxBytes: 512 });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.nodes[0]).toEqual({
      id: "n1",
      type: "httpReplay",
      position: { x: 10, y: 20 },
      config: {},
      label: "登录",
      refId: "abcde",
    });
    // 连线照常保留（单条体积小、图形态必需）
    expect(snapshot.edges).toEqual([makeEdge()]);
    // 降级结果自身合规（骨架 + 连线在极小上限下即已收敛）
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).length).toBeLessThanOrEqual(512);
  });

  it("降级同样剥离 pinnedOutput，且未提供 label / refId 时不凭空补字段", () => {
    const node = makeNode({
      config: {
        timeoutMs: 1,
        pinnedOutput: { value: "x", pinnedAt: 1, sourceRunId: asRunId("run-0") },
      },
    });
    const snapshot = buildRunGraphSnapshot([node], [], { maxBytes: 0 });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.nodes[0]?.config).toEqual({});
    expect(snapshot.nodes[0] !== undefined && "label" in snapshot.nodes[0]).toBe(false);
    expect(snapshot.nodes[0] !== undefined && "refId" in snapshot.nodes[0]).toBe(false);
  });

  it("默认上限为 256KB：明显超过即降级", () => {
    expect(RUN_GRAPH_SNAPSHOT_MAX_BYTES).toBe(256 * 1024);
    const node = makeNode({
      config: { postProcess: "z".repeat(RUN_GRAPH_SNAPSHOT_MAX_BYTES + 1024) },
    });
    const snapshot = buildRunGraphSnapshot([node], []);
    expect(snapshot.truncated).toBe(true);
  });
});

describe("buildRunGraphSnapshot：确定性与图数据幂等", () => {
  it("相同输入重复构建返回深度相等的快照", () => {
    const nodes = [makeNode(), makeNode({ id: asNodeId("n2"), type: "start", config: {} })];
    const edges = [makeEdge()];
    expect(buildRunGraphSnapshot(nodes, edges)).toEqual(buildRunGraphSnapshot(nodes, edges));
  });

  it("以快照的 nodes / edges 再构建：节点与连线深度相等（图数据幂等）", () => {
    const nodes = [
      makeNode(),
      makeNode({ id: asNodeId("n2"), type: "delay", config: { durationMs: 5 } }),
    ];
    const edges = [makeEdge({ sourceHandle: "true" })];
    const first = buildRunGraphSnapshot(nodes, edges);
    const second = buildRunGraphSnapshot(first.nodes, first.edges);

    expect(second.nodes).toEqual(first.nodes);
    expect(second.edges).toEqual(first.edges);
  });

  it("降级快照再构建：图形态不变（骨架 + config 空对象重入仍相等）", () => {
    const node = makeNode({ config: { postProcess: "x".repeat(2048) } });
    const first = buildRunGraphSnapshot([node], [makeEdge()], { maxBytes: 256 });
    const second = buildRunGraphSnapshot(first.nodes, first.edges);

    expect(first.truncated).toBe(true);
    expect(second.nodes).toEqual(first.nodes);
    expect(second.edges).toEqual(first.edges);
  });
});
