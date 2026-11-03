import { describe, expect, it } from "vitest";
import type {
  HarEntry,
  HarSnapshot,
  NodeConfig,
  RequestRecord,
  WorkflowEdge,
  WorkflowNode,
} from "./types";
import { asEdgeId, asNodeId, asRequestId } from "./types";
import { inferDependencies, applySuggestions } from "./dependency-inference";

/**
 * 依赖推断的引用短码键位测试（M15-T2）：
 * 建议产物（suggestedValue 模板表达式）中的上游引用键 = 上游节点 refId
 * （缺省回退内部 id）——落库后直接被引擎模板上下文（node 键 = refId ?? id）
 * 解析。建议的定位字段（upstreamNodeId）仍为内部 id（面板按节点名展示）。
 */

let seq = 0;

/** 构造捕获快照（JSON 响应体 + 可选请求头槽位） */
function makeRecord(options: {
  responseText: string;
  requestHeaders?: Array<{ name: string; value: string }>;
  createdAt?: number;
}): RequestRecord {
  seq += 1;
  const entry: HarEntry = {
    startedDateTime: new Date(options.createdAt ?? 0).toISOString(),
    time: 10,
    request: {
      method: "GET",
      url: "https://api.example.com/me",
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
      content: { size: -1, mimeType: "application/json", text: options.responseText },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
    },
    timings: { send: 1, wait: 5, receive: 4 },
  };
  const har: HarSnapshot = { log: { version: "1.2", creator: { name: "test" }, entries: [entry] } };
  return {
    id: asRequestId(`req-${seq}`),
    name: `请求 ${seq}`,
    tags: [],
    source: "devtools",
    origin: "https://api.example.com",
    har,
    createdAt: options.createdAt ?? 1000,
  };
}

/** 构造 httpReplay 节点（refId 可选） */
function makeNode(
  id: string,
  requestId: string,
  refId?: string,
  config: NodeConfig = {},
): WorkflowNode {
  return {
    id: asNodeId(id),
    type: "httpReplay",
    position: { x: 0, y: 0 },
    config: { requestId: asRequestId(requestId), ...config },
    ...(refId !== undefined ? { refId } : {}),
  };
}

function makeEdge(source: string, target: string): WorkflowEdge {
  return {
    id: asEdgeId(`${source}->${target}`),
    source: asNodeId(source),
    target: asNodeId(target),
  };
}

describe("inferDependencies 的 refId 建议表达式（M15-T2）", () => {
  it("命中建议的 suggestedValue 用上游 refId（Bearer 包裹形态）", async () => {
    const upstreamRecord = makeRecord({
      responseText: JSON.stringify({ token: "tok-abc123" }),
      createdAt: 1000,
    });
    const downstreamRecord = makeRecord({
      responseText: "{}",
      requestHeaders: [{ name: "Authorization", value: "Bearer tok-abc123" }],
      createdAt: 2000,
    });
    const loginNode = makeNode("uuid-login", upstreamRecord.id, "logiN");
    const downstream = makeNode("uuid-api", downstreamRecord.id, "apiXX");
    const suggestions = await inferDependencies({
      nodes: [loginNode, downstream],
      edges: [makeEdge("uuid-login", "uuid-api")],
      getRequestRecord: async (requestId) =>
        requestId === upstreamRecord.id
          ? upstreamRecord
          : requestId === downstreamRecord.id
            ? downstreamRecord
            : undefined,
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.suggestedValue).toBe("Bearer {{ node.logiN.token }}");
    // 定位字段保持内部 id（面板按节点名展示用）
    expect(suggestions[0]!.upstreamNodeId).toBe(asNodeId("uuid-login"));
  });

  it("上游无 refId 时建议表达式回退内部 id（既有行为不变）", async () => {
    const upstreamRecord = makeRecord({
      responseText: JSON.stringify({ token: "tok-abc123" }),
      createdAt: 1000,
    });
    const downstreamRecord = makeRecord({
      responseText: "{}",
      requestHeaders: [{ name: "Authorization", value: "Bearer tok-abc123" }],
      createdAt: 2000,
    });
    const loginNode = makeNode("uuid-login", upstreamRecord.id);
    const downstream = makeNode("uuid-api", downstreamRecord.id);
    const suggestions = await inferDependencies({
      nodes: [loginNode, downstream],
      edges: [],
      getRequestRecord: async (requestId) =>
        requestId === upstreamRecord.id
          ? upstreamRecord
          : requestId === downstreamRecord.id
            ? downstreamRecord
            : undefined,
    });
    expect(suggestions[0]!.suggestedValue).toBe("Bearer {{ node.uuid-login.token }}");
  });

  it("applySuggestions 落库的 override 引用短码（键位与执行器 node 键一致）", async () => {
    const upstreamRecord = makeRecord({
      responseText: JSON.stringify({ token: "tok-abc123" }),
      createdAt: 1000,
    });
    const downstreamRecord = makeRecord({
      responseText: "{}",
      requestHeaders: [{ name: "Authorization", value: "Bearer tok-abc123" }],
      createdAt: 2000,
    });
    const loginNode = makeNode("uuid-login", upstreamRecord.id, "logiN");
    const downstream = makeNode("uuid-api", downstreamRecord.id, "apiXX");
    const suggestions = await inferDependencies({
      nodes: [loginNode, downstream],
      edges: [makeEdge("uuid-login", "uuid-api")],
      getRequestRecord: async (requestId) =>
        requestId === upstreamRecord.id
          ? upstreamRecord
          : requestId === downstreamRecord.id
            ? downstreamRecord
            : undefined,
    });
    const applied = applySuggestions(
      [loginNode, downstream],
      [makeEdge("uuid-login", "uuid-api")],
      suggestions,
    );
    const apiNode = applied.nodes.find((node) => node.id === asNodeId("uuid-api"))!;
    // 建议改写直接落 `{{ node.<refId>.token }}`——与执行器 node 键（refId）一致
    expect(apiNode.config.override?.headers?.Authorization).toBe("Bearer {{ node.logiN.token }}");
  });
});
