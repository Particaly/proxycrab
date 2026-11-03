import { describe, expect, it } from "vitest";
import { inferDependencies } from "./dependency-inference";
import type { HarEntry, HarSnapshot, RequestId, RequestRecord } from "./types";
import {
  asEdgeId,
  asNodeId,
  asRequestId,
  type NodeConfig,
  type WorkflowEdge,
  type WorkflowNode,
} from "./types";

/**
 * 便签（stickyNote）依赖推断零影响测试（M13-T5，node 环境）：
 * 画布上存在便签（含注释文本的 config 载荷）时，依赖推断的建议产出与
 * 不存在便签时完全一致——候选上游 / 改写下游均只取 httpReplay 节点，
 * 便签不可连线（无入边出边），最近上游 BFS 不会触及便签。
 */

/** 请求 id 计数器（保证夹具 id 稳定唯一） */
let requestSeq = 0;

/** 构造一条请求快照（单个 HAR entry；响应体 / 请求头可定制） */
function makeRecord(options: {
  responseText?: string;
  requestHeaders?: Array<{ name: string; value: string }>;
  createdAt?: number;
}): RequestRecord {
  requestSeq += 1;
  const entry: HarEntry = {
    startedDateTime: new Date(options.createdAt ?? 0).toISOString(),
    time: 10,
    request: {
      method: "POST",
      url: "https://api.example.com/orders",
      httpVersion: "HTTP/1.1",
      headers: options.requestHeaders ?? [],
      queryString: [],
      headersSize: -1,
      bodySize: -1,
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      headers: [],
      content: {
        size: -1,
        mimeType: "application/json",
        ...(options.responseText !== undefined ? { text: options.responseText } : {}),
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
    },
    timings: { send: 1, wait: 5, receive: 4 },
  };
  const har: HarSnapshot = { log: { version: "1.2", creator: { name: "test" }, entries: [entry] } };
  return {
    id: asRequestId(
      options.createdAt !== undefined
        ? `req-${requestSeq}-t${options.createdAt}`
        : `req-${requestSeq}`,
    ),
    name: `请求 ${requestSeq}`,
    tags: [],
    source: "devtools",
    origin: "https://api.example.com",
    har,
    createdAt: options.createdAt ?? 1000,
  };
}

/** 节点夹具（httpReplay 或 stickyNote） */
function makeNode(id: string, type: WorkflowNode["type"], config: NodeConfig): WorkflowNode {
  return { id: asNodeId(id), type, position: { x: 0, y: 0 }, config };
}

/** 连线夹具 */
function makeEdge(id: string, source: string, target: string): WorkflowEdge {
  return { id: asEdgeId(id), source: asNodeId(source), target: asNodeId(target) };
}

describe("inferDependencies：便签零影响（M13-T5）", () => {
  it("有 / 无便签的画布产出完全一致的建议（便签 config 文本不参与匹配）", async () => {
    // 上游响应 token，下游请求头携带同一 token —— 命中 1 条 header 建议
    const upstream = makeRecord({
      responseText: JSON.stringify({ data: { token: "tok-abc123" } }),
      createdAt: 1000,
    });
    const downstream = makeRecord({
      requestHeaders: [{ name: "Authorization", value: "Bearer tok-abc123" }],
      createdAt: 2000,
    });
    const baseNodes: WorkflowNode[] = [
      makeNode("up", "httpReplay", { requestId: upstream.id }),
      makeNode("down", "httpReplay", { requestId: downstream.id }),
    ];
    const withStickyNodes: WorkflowNode[] = [
      ...baseNodes,
      makeNode("note", "stickyNote", { text: "tok-abc123 是 staging 的 token", color: "amber" }),
    ];
    const recordById = new Map([
      [upstream.id, upstream],
      [downstream.id, downstream],
    ]);
    const getRequestRecord = async (id: unknown) => recordById.get(id as RequestId);

    const without = await inferDependencies({ nodes: baseNodes, edges: [], getRequestRecord });
    const withSticky = await inferDependencies({
      nodes: withStickyNodes,
      edges: [],
      getRequestRecord,
    });

    expect(without).toHaveLength(1);
    expect(withSticky).toEqual(without);
  });

  it("便签与既有连线共存时：最近上游 BFS 沿真实连线遍历，建议不变", async () => {
    const upstream = makeRecord({
      responseText: JSON.stringify({ token: "tok-abc123" }),
      createdAt: 1000,
    });
    const downstream = makeRecord({
      requestHeaders: [{ name: "X-T", value: "tok-abc123" }],
      createdAt: 2000,
    });
    const edges = [makeEdge("e1", "up", "down")];
    const nodes: WorkflowNode[] = [
      makeNode("up", "httpReplay", { requestId: upstream.id }),
      makeNode("down", "httpReplay", { requestId: downstream.id }),
      makeNode("note", "stickyNote", { text: "注释", color: "sky" }),
    ];
    const recordById = new Map([
      [upstream.id, upstream],
      [downstream.id, downstream],
    ]);
    const result = await inferDependencies({
      nodes,
      edges,
      getRequestRecord: async (id) => recordById.get(id as RequestId),
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.upstreamNodeId).toBe(asNodeId("up"));
    expect(result[0]?.downstreamNodeId).toBe(asNodeId("down"));
  });
});
