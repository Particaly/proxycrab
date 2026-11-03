/**
 * 依赖自动推断器单测（M10-T1）。
 *
 * 覆盖面（与 dependency-inference.ts 文件头的推断 / 应用模型一一对应）：
 *   - collectUpstreamCandidates：JSON body / 响应头候选枚举、值过滤（长度 /
 *     布尔 / null / 控制字符）、同值最短路径去重、结构性头排除、base64 与
 *     非 JSON body、后置脚本门控（自定义脚本不产出 body 候选）；
 *   - buildDownstreamSnapshot：HAR 基线 + override 合并（与重放同语义）；
 *   - matchDownstreamUpstreams：header 精确 / Bearer 包裹 / cookie 剥离、
 *     URL 参数 / 路径段、body 字段、已模板化槽位跳过、无命中、多上游取最近
 *     （连线距离优先，其次捕获时间）、输出排序；
 *   - inferDependencies：节点数不足空数组、捕获时序门槛、异步编排；
 *   - applySuggestions：header / url / body 改写、override.method 种子、
 *     连线补充与去重、上游后置脚本补写、失效建议跳过、多条组合；
 *   - 运行时一致性：生成的模板表达式在「上游 output = JSON.parse(body)」的
 *     模板上下文下确实可渲染出原值（与 renderTemplate 联动验证）。
 */

import { describe, expect, it } from "vitest";
import { renderTemplate } from "./template";
import {
  applySuggestions,
  buildDownstreamSnapshot,
  collectUpstreamCandidates,
  inferDependencies,
  JSON_EXTRACT_POST_SCRIPT,
  matchDownstreamUpstreams,
  type DependencySuggestion,
  type InferUpstreamInput,
} from "./dependency-inference";
import type { HarEntry, HarSnapshot, RequestRecord } from "./types";
import {
  asEdgeId,
  asNodeId,
  asRequestId,
  type NodeConfig,
  type WorkflowEdge,
  type WorkflowNode,
} from "./types";

/* ------------------------------------------------------------------ *
 * 夹具构造
 * ------------------------------------------------------------------ */

/** 请求 id 计数器（保证夹具 id 稳定唯一） */
let requestSeq = 0;

/**
 * 构造一条请求快照（单个 HAR entry）。
 *
 * @param options 响应体文本 / 响应头 / 请求描述 / 创建时间
 * @returns RequestRecord 夹具
 */
function makeRecord(options: {
  responseText?: string;
  responseHeaders?: Array<{ name: string; value: string }>;
  encoding?: string;
  requestUrl?: string;
  requestHeaders?: Array<{ name: string; value: string }>;
  requestPostData?: string;
  createdAt?: number;
  id?: string;
}): RequestRecord {
  requestSeq += 1;
  const entry: HarEntry = {
    startedDateTime: new Date(options.createdAt ?? 0).toISOString(),
    time: 10,
    request: {
      method: "GET",
      url: options.requestUrl ?? "https://api.example.com/me",
      httpVersion: "HTTP/1.1",
      headers: options.requestHeaders ?? [],
      queryString: [],
      headersSize: -1,
      bodySize: -1,
      ...(options.requestPostData !== undefined
        ? { postData: { mimeType: "application/json", text: options.requestPostData } }
        : {}),
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      headers: options.responseHeaders ?? [],
      content: {
        size: -1,
        mimeType: "application/json",
        ...(options.responseText !== undefined ? { text: options.responseText } : {}),
        ...(options.encoding !== undefined ? { encoding: options.encoding } : {}),
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
    },
    timings: { send: 1, wait: 5, receive: 4 },
  };
  const har: HarSnapshot = { log: { version: "1.2", creator: { name: "test" }, entries: [entry] } };
  return {
    id: asRequestId(options.id ?? `req-${requestSeq}`),
    name: `请求 ${requestSeq}`,
    tags: [],
    source: "devtools",
    origin: "https://api.example.com",
    har,
    createdAt: options.createdAt ?? 1000,
  };
}

/** 节点 id 计数器 */
let nodeSeq = 0;

/**
 * 构造一个 httpReplay 画布节点。
 *
 * @param config 节点配置
 * @param id 节点 id（缺省自增）
 */
function makeNode(config: NodeConfig = {}, id?: string): WorkflowNode {
  nodeSeq += 1;
  return {
    id: asNodeId(id ?? `n${nodeSeq}`),
    type: "httpReplay",
    position: { x: 0, y: 0 },
    config,
  };
}

/**
 * 构造一条连线。
 *
 * @param id 连线 id
 * @param source 源节点 id
 * @param target 目标节点 id
 */
function makeEdge(id: string, source: string, target: string): WorkflowEdge {
  return { id: asEdgeId(id), source: asNodeId(source), target: asNodeId(target) };
}

/* ------------------------------------------------------------------ *
 * collectUpstreamCandidates
 * ------------------------------------------------------------------ */

describe("collectUpstreamCandidates（上游候选值枚举）", () => {
  it("枚举 JSON body 叶子值并带点分路径（嵌套对象与数组下标）", () => {
    const record = makeRecord({
      responseText: JSON.stringify({
        data: { token: "tok-abc123", user: { id: "u-0001" } },
        items: [{ sku: "SKU-9" }],
      }),
    });
    const paths = collectUpstreamCandidates(record).map((c) => c.responsePath);
    expect(paths).toContain("data.token");
    expect(paths).toContain("data.user.id");
    expect(paths).toContain("items.0.sku");
    const token = collectUpstreamCandidates(record).find((c) => c.responsePath === "data.token");
    expect(token).toMatchObject({ value: "tok-abc123", fromJsonBody: true });
  });

  it("数字叶子按字符串形式参与（长度达标），布尔与 null 不参与", () => {
    const record = makeRecord({
      responseText: JSON.stringify({ orderId: 123456, small: 7, flag: true, nothing: null }),
    });
    const values = collectUpstreamCandidates(record).map((c) => c.value);
    expect(values).toContain("123456");
    expect(values).not.toContain("7");
    expect(values).not.toContain("true");
  });

  it("过短 / 过长 / 带首尾空白的值不参与", () => {
    const record = makeRecord({
      responseText: JSON.stringify({
        a: "abc",
        b: `x${"y".repeat(600)}`,
        c: "  padded  ",
        d: "ok-12",
      }),
    });
    const values = collectUpstreamCandidates(record).map((c) => c.value);
    expect(values).not.toContain("abc");
    expect(values).not.toContain("  padded  ");
    expect(values).toContain("ok-12");
    // 过长值（600 字符）也不在候选内
    expect(values.every((v) => v.length <= 512)).toBe(true);
  });

  it("同值多路径去重，保留最短路径", () => {
    const record = makeRecord({
      responseText: JSON.stringify({ token: "tok-abc123", nested: { deep: { t: "tok-abc123" } } }),
    });
    const tokenCandidates = collectUpstreamCandidates(record).filter(
      (c) => c.value === "tok-abc123",
    );
    expect(tokenCandidates).toHaveLength(1);
    expect(tokenCandidates[0]?.responsePath).toBe("token");
  });

  it("响应头值成为候选（路径为小写头名），结构性头被排除", () => {
    const record = makeRecord({
      responseHeaders: [
        { name: "X-Request-Id", value: "rid-424242" },
        { name: "Content-Type", value: "application/json" },
      ],
    });
    const candidates = collectUpstreamCandidates(record);
    expect(candidates).toContainEqual({
      value: "rid-424242",
      responsePath: "headers.x-request-id",
      fromJsonBody: false,
    });
    expect(candidates.find((c) => c.responsePath === "headers.content-type")).toBeUndefined();
  });

  it("响应头候选优先于 body 候选；非 JSON body 只剩响应头候选", () => {
    const record = makeRecord({
      responseText: "not-json-at-all",
      responseHeaders: [{ name: "X-Token", value: "tok-abc123" }],
    });
    const candidates = collectUpstreamCandidates(record);
    expect(candidates).toEqual([
      { value: "tok-abc123", responsePath: "headers.x-token", fromJsonBody: false },
    ]);
  });

  it("base64 编码的 body 不做 JSON 解析", () => {
    const record = makeRecord({
      responseText: JSON.stringify({ token: "tok-abc123" }),
      encoding: "base64",
    });
    expect(collectUpstreamCandidates(record)).toEqual([]);
  });

  it("上游已有自定义后置脚本时不产出 body 候选；规范解析脚本时照常产出", () => {
    const body = JSON.stringify({ token: "tok-abc123" });
    const custom = makeRecord({ responseText: body });
    expect(
      collectUpstreamCandidates(custom, "return response.body.data").map((c) => c.value),
    ).toEqual([]);

    const canonical = makeRecord({ responseText: body });
    expect(
      collectUpstreamCandidates(canonical, JSON_EXTRACT_POST_SCRIPT).map((c) => c.responsePath),
    ).toContain("token");
  });

  it("空快照（无 HAR entry）返回空候选", () => {
    const record = makeRecord({});
    record.har = { log: { version: "1.2", creator: { name: "t" }, entries: [] } };
    expect(collectUpstreamCandidates(record)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * buildDownstreamSnapshot
 * ------------------------------------------------------------------ */

describe("buildDownstreamSnapshot（下游有效请求快照）", () => {
  it("无 override 时取 HAR 基线", () => {
    const record = makeRecord({
      requestUrl: "https://api.example.com/orders?page=2",
      requestHeaders: [{ name: "Authorization", value: "Bearer old-token" }],
      requestPostData: '{"a":1}',
    });
    const node = makeNode({ requestId: record.id });
    const snapshot = buildDownstreamSnapshot(node, record);
    expect(snapshot).toEqual({
      method: "GET",
      url: "https://api.example.com/orders?page=2",
      headers: { Authorization: "Bearer old-token" },
      body: '{"a":1}',
    });
  });

  it("override 按 M5-T2 语义合并（method/url 整体替换、headers 逐键、body 整体）", () => {
    const record = makeRecord({
      requestUrl: "https://api.example.com/orders?page=2",
      requestHeaders: [
        { name: "Authorization", value: "Bearer old" },
        { name: "Accept", value: "application/json" },
      ],
      requestPostData: '{"a":1}',
    });
    const node = makeNode({
      requestId: record.id,
      override: {
        method: "POST",
        headers: { Authorization: "Bearer new" },
        body: '{"b":2}',
      },
    });
    const snapshot = buildDownstreamSnapshot(node, record);
    expect(snapshot?.method).toBe("POST");
    expect(snapshot?.url).toBe("https://api.example.com/orders?page=2");
    expect(snapshot?.headers).toEqual({ Authorization: "Bearer new", Accept: "application/json" });
    expect(snapshot?.body).toBe('{"b":2}');
  });

  it("支持手动请求基线和 Header 删除覆盖", () => {
    const record = makeRecord({
      requestUrl: "https://api.example.com/base",
      requestHeaders: [{ name: "X-Old", value: "1" }],
    });
    const node = makeNode({
      manualRequest: {
        method: "POST",
        url: "https://manual.example.com/x",
        headers: { "X-Manual": "yes" },
        body: "manual",
      },
      override: { removedHeaders: ["x-old"] },
    });
    expect(buildDownstreamSnapshot(node, record)).toEqual({
      method: "POST",
      url: "https://manual.example.com/x",
      headers: { "X-Manual": "yes" },
      body: "manual",
    });
  });

  it("空快照返回 null", () => {
    const record = makeRecord({});
    record.har = { log: { version: "1.2", creator: { name: "t" }, entries: [] } };
    expect(buildDownstreamSnapshot(makeNode(), record)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * matchDownstreamUpstreams
 * ------------------------------------------------------------------ */

/** 构造候选上游输入（节点 + 记录 + 候选值） */
function makeUpstream(
  node: WorkflowNode,
  record: RequestRecord,
  values: Array<{ value: string; path: string; fromJsonBody?: boolean }>,
): InferUpstreamInput {
  return {
    node,
    record,
    candidates: values.map((v) => ({
      value: v.value,
      responsePath: v.path,
      fromJsonBody: v.fromJsonBody ?? false,
    })),
  };
}

describe("matchDownstreamUpstreams（匹配与建议产出）", () => {
  it("请求头精确命中：产出 node 引用模板", () => {
    const upstreamRecord = makeRecord({ responseText: "{}" });
    const downstreamRecord = makeRecord({
      requestHeaders: [{ name: "X-Api-Key", value: "key-8888" }],
    });
    const result = matchDownstreamUpstreams({
      downstreamNode: makeNode({ requestId: downstreamRecord.id }, "down"),
      downstream: buildDownstreamSnapshot(
        makeNode({ requestId: downstreamRecord.id }, "down"),
        downstreamRecord,
      )!,
      downstreamOrder: 1,
      upstreams: [
        makeUpstream(makeNode({}, "up"), upstreamRecord, [
          { value: "key-8888", path: "headers.x-api-key" },
        ]),
      ],
      edges: [makeEdge("e1", "up", "down")],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      upstreamNodeId: "up",
      downstreamNodeId: "down",
      responsePath: "headers.x-api-key",
      target: { kind: "header", name: "X-Api-Key" },
      matchedText: "key-8888",
      suggestedValue: "{{ node.up.headers.x-api-key }}",
      upstreamValueFromJsonBody: false,
    });
  });

  it("Bearer 包裹命中：表达式保留前缀", () => {
    const upstreamRecord = makeRecord({ responseText: JSON.stringify({ token: "tok-abc123" }) });
    const downstreamRecord = makeRecord({
      requestHeaders: [{ name: "Authorization", value: "Bearer tok-abc123" }],
    });
    const result = matchDownstreamUpstreams({
      downstreamNode: makeNode({ requestId: downstreamRecord.id }, "down"),
      downstream: buildDownstreamSnapshot(
        makeNode({ requestId: downstreamRecord.id }, "down"),
        downstreamRecord,
      )!,
      downstreamOrder: 1,
      upstreams: [
        makeUpstream(makeNode({}, "up"), upstreamRecord, [
          { value: "tok-abc123", path: "token", fromJsonBody: true },
        ]),
      ],
      edges: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.suggestedValue).toBe("Bearer {{ node.up.token }}");
    expect(result[0]?.matchedText).toBe("Bearer tok-abc123");
    expect(result[0]?.upstreamValueFromJsonBody).toBe(true);
  });

  it("cookie 头（重放剥离）不产出建议", () => {
    const upstreamRecord = makeRecord({ responseText: "{}" });
    const downstreamRecord = makeRecord({
      requestHeaders: [{ name: "Cookie", value: "sid=cookie-value-1" }],
    });
    const result = matchDownstreamUpstreams({
      downstreamNode: makeNode({ requestId: downstreamRecord.id }, "down"),
      downstream: buildDownstreamSnapshot(
        makeNode({ requestId: downstreamRecord.id }, "down"),
        downstreamRecord,
      )!,
      downstreamOrder: 1,
      upstreams: [
        makeUpstream(makeNode({}, "up"), upstreamRecord, [
          { value: "cookie-value-1", path: "headers.set-cookie" },
        ]),
      ],
      edges: [],
    });
    expect(result).toEqual([]);
  });

  it("URL 查询参数与路径段命中", () => {
    const upstreamRecord = makeRecord({
      responseText: JSON.stringify({ userId: "u-0001", org: "org-42" }),
    });
    const downstreamRecord = makeRecord({
      requestUrl: "https://api.example.com/org-42/orders?userId=u-0001",
    });
    const result = matchDownstreamUpstreams({
      downstreamNode: makeNode({ requestId: downstreamRecord.id }, "down"),
      downstream: buildDownstreamSnapshot(
        makeNode({ requestId: downstreamRecord.id }, "down"),
        downstreamRecord,
      )!,
      downstreamOrder: 1,
      upstreams: [
        makeUpstream(makeNode({}, "up"), upstreamRecord, [
          { value: "u-0001", path: "userId", fromJsonBody: true },
          { value: "org-42", path: "org", fromJsonBody: true },
        ]),
      ],
      edges: [],
    });
    expect(result.map((s) => s.target)).toEqual([
      { kind: "url-query", name: "userId" },
      { kind: "url-path", segment: "org-42" },
    ]);
    expect(result[0]?.suggestedValue).toBe("{{ node.up.userId }}");
    expect(result[1]?.suggestedValue).toBe("{{ node.up.org }}");
  });

  it("JSON body 字段命中", () => {
    const upstreamRecord = makeRecord({ responseText: JSON.stringify({ orderId: "ord-777" }) });
    const downstreamRecord = makeRecord({
      requestPostData: '{"orderId":"ord-777","qty":1}',
    });
    const result = matchDownstreamUpstreams({
      downstreamNode: makeNode({ requestId: downstreamRecord.id }, "down"),
      downstream: buildDownstreamSnapshot(
        makeNode({ requestId: downstreamRecord.id }, "down"),
        downstreamRecord,
      )!,
      downstreamOrder: 1,
      upstreams: [
        makeUpstream(makeNode({}, "up"), upstreamRecord, [
          { value: "ord-777", path: "orderId", fromJsonBody: true },
        ]),
      ],
      edges: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.target).toEqual({ kind: "body-field", path: "orderId" });
    expect(result[0]?.suggestedValue).toBe("{{ node.up.orderId }}");
  });

  it("已含模板的槽位整槽跳过（url / body / header）", () => {
    const upstreamRecord = makeRecord({ responseText: JSON.stringify({ v: "val-0001" }) });
    const downstreamRecord = makeRecord({
      requestUrl: "https://api.example.com/x?q={{ node.other.v }}",
      requestHeaders: [{ name: "X-K", value: "prefix {{ node.other.v }}" }],
      requestPostData: '{"k":"{{ node.other.v }}"}',
    });
    const result = matchDownstreamUpstreams({
      downstreamNode: makeNode({ requestId: downstreamRecord.id }, "down"),
      downstream: buildDownstreamSnapshot(
        makeNode({ requestId: downstreamRecord.id }, "down"),
        downstreamRecord,
      )!,
      downstreamOrder: 1,
      upstreams: [
        makeUpstream(makeNode({}, "up"), upstreamRecord, [{ value: "val-0001", path: "v" }]),
      ],
      edges: [],
    });
    // val-0001 并不匹配任何槽位值；这里主要验证模板化 URL 不抛错且无建议产出
    expect(result).toEqual([]);
  });

  it("无命中返回空数组", () => {
    const upstreamRecord = makeRecord({ responseText: JSON.stringify({ a: "aaaa" }) });
    const downstreamRecord = makeRecord({
      requestHeaders: [{ name: "X-K", value: "bbbb" }],
    });
    const result = matchDownstreamUpstreams({
      downstreamNode: makeNode({ requestId: downstreamRecord.id }, "down"),
      downstream: buildDownstreamSnapshot(
        makeNode({ requestId: downstreamRecord.id }, "down"),
        downstreamRecord,
      )!,
      downstreamOrder: 1,
      upstreams: [makeUpstream(makeNode({}, "up"), upstreamRecord, [{ value: "aaaa", path: "a" }])],
      edges: [],
    });
    expect(result).toEqual([]);
  });

  it("多上游取最近：直接上游（距离 1）优先于间接上游（距离 2）", () => {
    const nearRecord = makeRecord({ responseText: "{}", createdAt: 100 });
    const farRecord = makeRecord({ responseText: "{}", createdAt: 200 });
    const downstreamRecord = makeRecord({
      requestHeaders: [{ name: "X-K", value: "val-9999" }],
    });
    // near 距离 1（直连），far 距离 2（经 near 中转）
    const edges = [makeEdge("e1", "far", "near"), makeEdge("e2", "near", "down")];
    const result = matchDownstreamUpstreams({
      downstreamNode: makeNode({ requestId: downstreamRecord.id }, "down"),
      downstream: buildDownstreamSnapshot(
        makeNode({ requestId: downstreamRecord.id }, "down"),
        downstreamRecord,
      )!,
      downstreamOrder: 2,
      upstreams: [
        makeUpstream(makeNode({}, "far"), farRecord, [{ value: "val-9999", path: "v" }]),
        makeUpstream(makeNode({}, "near"), nearRecord, [{ value: "val-9999", path: "v" }]),
      ],
      edges,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.upstreamNodeId).toBe("near");
  });

  it("多上游均不可达时取捕获时间更新者", () => {
    const oldRecord = makeRecord({ responseText: "{}", createdAt: 100 });
    const newRecord = makeRecord({ responseText: "{}", createdAt: 900 });
    const downstreamRecord = makeRecord({
      requestHeaders: [{ name: "X-K", value: "val-9999" }],
    });
    const result = matchDownstreamUpstreams({
      downstreamNode: makeNode({ requestId: downstreamRecord.id }, "down"),
      downstream: buildDownstreamSnapshot(
        makeNode({ requestId: downstreamRecord.id }, "down"),
        downstreamRecord,
      )!,
      downstreamOrder: 2,
      upstreams: [
        makeUpstream(makeNode({}, "oldNode"), oldRecord, [{ value: "val-9999", path: "v" }]),
        makeUpstream(makeNode({}, "newNode"), newRecord, [{ value: "val-9999", path: "v" }]),
      ],
      edges: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.upstreamNodeId).toBe("newNode");
  });
});

/* ------------------------------------------------------------------ *
 * inferDependencies（异步编排）
 * ------------------------------------------------------------------ */

describe("inferDependencies（异步编排）", () => {
  it("引用快照的节点不足 2 个时返回空数组", async () => {
    const record = makeRecord({ responseText: '{"a":"aaaa"}' });
    const nodes = [makeNode({ requestId: record.id }, "a")];
    const result = await inferDependencies({
      nodes,
      edges: [],
      getRequestRecord: async () => record,
    });
    expect(result).toEqual([]);
  });

  it("捕获时间晚于下游的上游不参与（时序门槛）", async () => {
    const upstreamRecord = makeRecord({ responseText: '{"t":"tok-abc123"}', createdAt: 5000 });
    const downstreamRecord = makeRecord({
      requestHeaders: [{ name: "X-T", value: "tok-abc123" }],
      createdAt: 1000,
    });
    const result = await inferDependencies({
      nodes: [
        makeNode({ requestId: upstreamRecord.id }, "up"),
        makeNode({ requestId: downstreamRecord.id }, "down"),
      ],
      edges: [],
      getRequestRecord: async (id) =>
        id === upstreamRecord.id ? upstreamRecord : downstreamRecord,
    });
    expect(result).toEqual([]);
  });

  it("端到端：上游响应 token 命中下游请求头，产出建议", async () => {
    const upstreamRecord = makeRecord({
      responseText: JSON.stringify({ data: { token: "tok-abc123" } }),
      createdAt: 100,
    });
    const downstreamRecord = makeRecord({
      requestHeaders: [{ name: "Authorization", value: "Bearer tok-abc123" }],
      createdAt: 200,
    });
    const result = await inferDependencies({
      nodes: [
        makeNode({ requestId: upstreamRecord.id }, "up"),
        makeNode({ requestId: downstreamRecord.id }, "down"),
      ],
      edges: [],
      getRequestRecord: async (id) =>
        id === upstreamRecord.id ? upstreamRecord : downstreamRecord,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      upstreamNodeId: "up",
      downstreamNodeId: "down",
      responsePath: "data.token",
      suggestedValue: "Bearer {{ node.up.data.token }}",
    });
  });

  it("快照读取抛错按缺失处理，不向上抛", async () => {
    const record = makeRecord({ responseText: '{"a":"aaaa"}' });
    const result = await inferDependencies({
      nodes: [makeNode({ requestId: record.id }, "a"), makeNode({ requestId: record.id }, "b")],
      edges: [],
      getRequestRecord: async () => {
        throw new Error("db gone");
      },
    });
    expect(result).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * applySuggestions（应用逻辑）
 * ------------------------------------------------------------------ */

describe("applySuggestions（应用逻辑）", () => {
  it("header 建议：新建 override 时以基线 method 种子，并写入 headers", () => {
    const downstream = makeNode({ requestId: asRequestId("r") }, "down");
    const suggestion: DependencySuggestion = {
      id: "s1",
      upstreamNodeId: asNodeId("up"),
      responsePath: "data.token",
      upstreamValue: "tok-abc123",
      upstreamValueFromJsonBody: true,
      downstreamNodeId: downstream.id,
      target: { kind: "header", name: "Authorization" },
      matchedText: "Bearer tok-abc123",
      suggestedValue: "Bearer {{ node.up.data.token }}",
      baseline: {
        method: "POST",
        url: "https://api.example.com/orders",
        headerValue: "Bearer tok-abc123",
      },
    };
    const result = applySuggestions([downstream], [], [suggestion], () => "edge-1");
    const config = result.nodes.find((n) => n.id === downstream.id)?.config;
    expect(config?.override).toEqual({
      method: "POST",
      headers: { Authorization: "Bearer {{ node.up.data.token }}" },
    });
    expect(result.addedEdges).toEqual([makeEdge("edge-1", "up", "down")]);
    expect(result.changedNodeIds).toEqual([asNodeId("down")]);
  });

  it("header 建议：既有 override 的 method / body 不被破坏", () => {
    const downstream = makeNode(
      {
        requestId: asRequestId("r"),
        override: { method: "PUT", body: '{"keep":1}' },
      },
      "down",
    );
    const suggestion: DependencySuggestion = {
      id: "s1",
      upstreamNodeId: asNodeId("up"),
      responsePath: "headers.x-token",
      upstreamValue: "tok-abc123",
      upstreamValueFromJsonBody: false,
      downstreamNodeId: downstream.id,
      target: { kind: "header", name: "X-Token" },
      matchedText: "tok-abc123",
      suggestedValue: "{{ node.up.headers.x-token }}",
      baseline: { method: "GET", url: "https://api.example.com/x", headerValue: "tok-abc123" },
    };
    const result = applySuggestions([downstream], [], [suggestion], () => "edge-1");
    const config = result.nodes.find((n) => n.id === downstream.id)?.config;
    expect(config?.override).toEqual({
      method: "PUT",
      body: '{"keep":1}',
      headers: { "X-Token": "{{ node.up.headers.x-token }}" },
    });
  });

  it("url-query 建议：改写 override.url", () => {
    const downstream = makeNode({ requestId: asRequestId("r") }, "down");
    const suggestion: DependencySuggestion = {
      id: "s1",
      upstreamNodeId: asNodeId("up"),
      responsePath: "userId",
      upstreamValue: "u-0001",
      upstreamValueFromJsonBody: true,
      downstreamNodeId: downstream.id,
      target: { kind: "url-query", name: "userId" },
      matchedText: "u-0001",
      suggestedValue: "{{ node.up.userId }}",
      baseline: { method: "GET", url: "https://api.example.com/orders?userId=u-0001&page=2" },
    };
    const result = applySuggestions([downstream], [], [suggestion], () => "e");
    const config = result.nodes.find((n) => n.id === downstream.id)?.config;
    expect(config?.override?.url).toBe(
      "https://api.example.com/orders?userId={{ node.up.userId }}&page=2",
    );
    expect(config?.override?.method).toBe("GET");
  });

  it("url-path 建议：仅目标路径段被替换", () => {
    const downstream = makeNode({ requestId: asRequestId("r") }, "down");
    const suggestion: DependencySuggestion = {
      id: "s1",
      upstreamNodeId: asNodeId("up"),
      responsePath: "org",
      upstreamValue: "org-42",
      upstreamValueFromJsonBody: true,
      downstreamNodeId: downstream.id,
      target: { kind: "url-path", segment: "org-42" },
      matchedText: "org-42",
      suggestedValue: "{{ node.up.org }}",
      baseline: { method: "GET", url: "https://api.example.com/org-42/orders" },
    };
    const result = applySuggestions([downstream], [], [suggestion], () => "e");
    const config = result.nodes.find((n) => n.id === downstream.id)?.config;
    expect(config?.override?.url).toBe("https://api.example.com/{{ node.up.org }}/orders");
  });

  it("body-field 建议：JSON 按路径改写并紧凑序列化", () => {
    const downstream = makeNode({ requestId: asRequestId("r") }, "down");
    const suggestion: DependencySuggestion = {
      id: "s1",
      upstreamNodeId: asNodeId("up"),
      responsePath: "orderId",
      upstreamValue: "ord-777",
      upstreamValueFromJsonBody: true,
      downstreamNodeId: downstream.id,
      target: { kind: "body-field", path: "order.id" },
      matchedText: "ord-777",
      suggestedValue: "{{ node.up.orderId }}",
      baseline: {
        method: "POST",
        url: "https://api.example.com/orders",
        body: JSON.stringify({ order: { id: "ord-777" }, qty: 1 }, null, 2),
      },
    };
    const result = applySuggestions([downstream], [], [suggestion], () => "e");
    const config = result.nodes.find((n) => n.id === downstream.id)?.config;
    expect(config?.override?.body).toBe('{"order":{"id":"{{ node.up.orderId }}"},"qty":1}');
  });

  it("已有连线时不重复加线", () => {
    const downstream = makeNode({ requestId: asRequestId("r") }, "down");
    const suggestion: DependencySuggestion = {
      id: "s1",
      upstreamNodeId: asNodeId("up"),
      responsePath: "v",
      upstreamValue: "val-9999",
      upstreamValueFromJsonBody: false,
      downstreamNodeId: downstream.id,
      target: { kind: "header", name: "X-K" },
      matchedText: "val-9999",
      suggestedValue: "{{ node.up.v }}",
      baseline: { method: "GET", url: "https://api.example.com/x", headerValue: "val-9999" },
    };
    const existing = [makeEdge("e1", "up", "down")];
    const result = applySuggestions([downstream], existing, [suggestion], () => "should-not-exist");
    expect(result.edges).toEqual(existing);
    expect(result.addedEdges).toEqual([]);
  });

  it("JSON body 类建议为无后置脚本的上游补规范解析脚本；header 类不补", () => {
    const upstream = makeNode({ requestId: asRequestId("r") }, "up");
    const downstream = makeNode({ requestId: asRequestId("r") }, "down");
    const jsonSuggestion: DependencySuggestion = {
      id: "s1",
      upstreamNodeId: upstream.id,
      responsePath: "token",
      upstreamValue: "tok-abc123",
      upstreamValueFromJsonBody: true,
      downstreamNodeId: downstream.id,
      target: { kind: "header", name: "X-T" },
      matchedText: "tok-abc123",
      suggestedValue: "{{ node.up.token }}",
      baseline: { method: "GET", url: "https://api.example.com/x", headerValue: "tok-abc123" },
    };
    const result = applySuggestions([upstream, downstream], [], [jsonSuggestion], () => "e");
    const upstreamConfig = result.nodes.find((n) => n.id === upstream.id)?.config;
    expect(upstreamConfig?.postProcess).toBe(JSON_EXTRACT_POST_SCRIPT);
    // 上游与下游都被计入变更
    expect(result.changedNodeIds).toEqual([asNodeId("down"), asNodeId("up")]);
  });

  it("失效建议（下游字段已不含匹配值）整体跳过：不改写、不加线、不补脚本", () => {
    const upstream = makeNode({ requestId: asRequestId("r") }, "up");
    const downstream = makeNode(
      {
        requestId: asRequestId("r"),
        override: { headers: { Authorization: "Bearer user-edited" } },
      },
      "down",
    );
    const suggestion: DependencySuggestion = {
      id: "s1",
      upstreamNodeId: upstream.id,
      responsePath: "token",
      upstreamValue: "tok-abc123",
      upstreamValueFromJsonBody: true,
      downstreamNodeId: downstream.id,
      target: { kind: "header", name: "Authorization" },
      matchedText: "Bearer tok-abc123",
      suggestedValue: "Bearer {{ node.up.token }}",
      baseline: {
        method: "GET",
        url: "https://api.example.com/x",
        headerValue: "Bearer tok-abc123",
      },
    };
    const result = applySuggestions([upstream, downstream], [], [suggestion], () => "e");
    expect(result.changedNodeIds).toEqual([]);
    expect(result.addedEdges).toEqual([]);
    expect(result.nodes.find((n) => n.id === upstream.id)?.config.postProcess).toBeUndefined();
  });

  it("多条 body 建议顺序应用可组合（两次改写互不覆盖）", () => {
    const downstream = makeNode({ requestId: asRequestId("r") }, "down");
    const makeBodySuggestion = (
      path: string,
      value: string,
      responsePath: string,
    ): DependencySuggestion => ({
      id: `s-${path}`,
      upstreamNodeId: asNodeId("up"),
      responsePath,
      upstreamValue: value,
      upstreamValueFromJsonBody: true,
      downstreamNodeId: downstream.id,
      target: { kind: "body-field", path },
      matchedText: value,
      suggestedValue: `{{ node.up.${responsePath} }}`,
      baseline: {
        method: "POST",
        url: "https://api.example.com/orders",
        body: JSON.stringify({ a: "val-0001", b: "val-0002" }),
      },
    });
    const result = applySuggestions(
      [downstream],
      [],
      [makeBodySuggestion("a", "val-0001", "a"), makeBodySuggestion("b", "val-0002", "b")],
      () => "e",
    );
    const body = result.nodes.find((n) => n.id === downstream.id)?.config.override?.body;
    expect(body).toBe('{"a":"{{ node.up.a }}","b":"{{ node.up.b }}"}');
  });

  it("下游节点不存在时该条建议静默跳过", () => {
    const suggestion: DependencySuggestion = {
      id: "s1",
      upstreamNodeId: asNodeId("up"),
      responsePath: "v",
      upstreamValue: "val-9999",
      upstreamValueFromJsonBody: false,
      downstreamNodeId: asNodeId("ghost"),
      target: { kind: "header", name: "X-K" },
      matchedText: "val-9999",
      suggestedValue: "{{ node.up.v }}",
      baseline: { method: "GET", url: "https://api.example.com/x" },
    };
    const result = applySuggestions([], [], [suggestion], () => "e");
    expect(result.changedNodeIds).toEqual([]);
    expect(result.addedEdges).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 运行时一致性（模板联动）
 * ------------------------------------------------------------------ */

describe("与模板引擎的运行时一致性（M10-T1 核心约定）", () => {
  it("生成的模板在「上游 output = JSON.parse(body)」上下文下可渲染出原值", async () => {
    // 1) 端到端推断出 Bearer 建议
    const upstreamRecord = makeRecord({
      responseText: JSON.stringify({ data: { token: "tok-abc123" } }),
      createdAt: 100,
    });
    const downstreamRecord = makeRecord({
      requestHeaders: [{ name: "Authorization", value: "Bearer tok-abc123" }],
      createdAt: 200,
    });
    const suggestions = await inferDependencies({
      nodes: [
        makeNode({ requestId: upstreamRecord.id }, "up"),
        makeNode({ requestId: downstreamRecord.id }, "down"),
      ],
      edges: [],
      getRequestRecord: async (id) =>
        id === upstreamRecord.id ? upstreamRecord : downstreamRecord,
    });
    const applied = applySuggestions(
      [
        makeNode({ requestId: upstreamRecord.id }, "up"),
        makeNode({ requestId: downstreamRecord.id }, "down"),
      ],
      [],
      suggestions,
      () => "edge-1",
    );
    const downstreamConfig = applied.nodes.find((n) => n.id === asNodeId("down"))?.config;
    const template = downstreamConfig?.override?.headers?.Authorization;
    expect(template).toBe("Bearer {{ node.up.data.token }}");
    // 应用侧同时补了上游解析脚本
    expect(applied.nodes.find((n) => n.id === asNodeId("up"))?.config.postProcess).toBe(
      JSON_EXTRACT_POST_SCRIPT,
    );

    // 2) 以「上游规范后置脚本执行后」的 output 为模板上下文渲染：值可还原
    const upstreamOutput = JSON.parse(
      upstreamRecord.har.log.entries[0]?.response.content.text ?? "{}",
    );
    const rendered = renderTemplate(template ?? "", {
      node: { up: upstreamOutput },
      input: null,
    });
    expect(rendered.value).toBe("Bearer tok-abc123");
  });
});
