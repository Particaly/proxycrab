import { describe, expect, it } from "vitest";
import type { HarEntry, HarRequest, WorkflowNode } from "./types";
import { buildPreviewRequest } from "./replay";
import { buildTemplateContext } from "./executor";

/**
 * httpReplay 节点请求面预览测试（buildPreviewRequest，模板渲染 dry-run）：
 * 基线解析与来源标注、override 模板渲染（env / var / fake）、fake 跨槽位一致性、
 * 渲染警告收集（缺上游数据 / 未知键按空串 + warning）、头保真 / Cookie 并入、
 * 二进制 body 走 bodyBase64、timeoutMs 兜底、无基线抛错。
 */

/** 构造最小合法 HAR 请求（字段可覆盖） */
function makeRequest(overrides: Partial<HarRequest> = {}): HarRequest {
  return {
    method: "POST",
    url: "https://api.example.com/v1/users",
    httpVersion: "HTTP/1.1",
    headers: [],
    queryString: [],
    headersSize: -1,
    bodySize: -1,
    ...overrides,
  };
}

/** 构造最小合法 HAR 条目（request 可覆盖） */
function makeEntry(requestOverrides: Partial<HarRequest> = {}): HarEntry {
  return {
    startedDateTime: "2026-01-01T00:00:00.000Z",
    time: 10,
    request: makeRequest(requestOverrides),
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      headers: [],
      content: { size: 2, mimeType: "application/json", text: "{}" },
      redirectURL: "",
      headersSize: -1,
      bodySize: 2,
    },
    timings: { send: 0, wait: 10, receive: 0 },
  };
}

/** 构造最小 httpReplay 节点（config 可覆盖） */
function makeNode(configOverrides: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: "n1",
    type: "httpReplay",
    position: { x: 0, y: 0 },
    config: configOverrides as WorkflowNode["config"],
  };
}

describe("buildPreviewRequest：基线解析与来源标注", () => {
  it("requestId 命中投影 → baseline=requestLibrary，以库条目为基线", () => {
    const entry = makeEntry({ method: "PUT", url: "https://lib.example.com/a" });
    const result = buildPreviewRequest({
      node: makeNode({ requestId: "req-1" }),
      harEntries: { "req-1": entry },
    });
    expect(result.baseline).toBe("requestLibrary");
    expect(result.request.method).toBe("PUT");
    expect(result.request.url).toBe("https://lib.example.com/a");
  });

  it("无 requestId、配置 manualRequest → baseline=manual，按手动请求合成基线", () => {
    const result = buildPreviewRequest({
      node: makeNode({
        manualRequest: {
          method: "GET",
          url: "https://manual.example.com/b",
          headers: { "x-manual": "1" },
        },
      }),
    });
    expect(result.baseline).toBe("manual");
    expect(result.request.method).toBe("GET");
    expect(result.request.url).toBe("https://manual.example.com/b");
    expect(result.request.headers["x-manual"]).toBe("1");
  });

  it("requestId 未命中投影且回退 manualRequest → baseline=manual（合法回退）", () => {
    const result = buildPreviewRequest({
      node: makeNode({
        requestId: "missing-id",
        manualRequest: { method: "GET", url: "https://manual.example.com/c" },
      }),
      harEntries: {},
    });
    expect(result.baseline).toBe("manual");
    expect(result.request.url).toBe("https://manual.example.com/c");
  });

  it("requestId 未命中且无 manualRequest → 抛错（missing-baseline 语义）", () => {
    expect(() =>
      buildPreviewRequest({
        node: makeNode({ requestId: "missing-id" }),
        harEntries: {},
      }),
    ).toThrow(/无可用请求基线/);
  });
});

describe("buildPreviewRequest：模板渲染", () => {
  it("override url / headers / body 渲染 env 与 var，fake 跨槽位取同一采样值", () => {
    const templateContext = buildTemplateContext(
      {},
      null,
      { runTag: "rt-1" },
      { baseUrl: "https://env.example.com" },
    );
    const result = buildPreviewRequest(
      {
        node: makeNode({
          manualRequest: { method: "POST", url: "https://api.example.com/base" },
          override: {
            url: "{{ env.baseUrl }}/v1/orders?tag={{ var.runTag }}&phone={{ fake.phone }}",
            headers: { "x-phone": "{{ fake.phone }}" },
            body: '{"tag":"{{ var.runTag }}","phone":"{{ fake.phone }}"}',
          },
        }),
      },
      templateContext,
    );
    const url = new URL(result.request.url);
    expect(`${url.protocol}//${url.host}`).toBe("https://env.example.com");
    expect(url.searchParams.get("tag")).toBe("rt-1");
    const phone = url.searchParams.get("phone") ?? "";
    expect(phone).not.toBe("");
    // 同一 templateContext：fake.phone 在 url / headers / body 三处一致（= 单次节点执行语义）
    expect(result.request.headers["x-phone"]).toBe(phone);
    expect(JSON.parse(result.request.body ?? "{}")).toEqual({ tag: "rt-1", phone });
  });

  it("node / input 引用无上游数据：渲染为空串并进 warnings（单节点预览语义）", () => {
    const result = buildPreviewRequest(
      {
        node: makeNode({
          manualRequest: { method: "GET", url: "https://api.example.com/base" },
          override: {
            url: "https://api.example.com/{{ node.upstream.id }}?q={{ keywords }}",
          },
        }),
      },
      buildTemplateContext({}, null),
    );
    expect(result.request.url).toBe("https://api.example.com/?q=");
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("渲染警告聚合 url / headers / body 三处（未知 env 键等）", () => {
    const result = buildPreviewRequest(
      {
        node: makeNode({
          manualRequest: { method: "GET", url: "https://api.example.com/base" },
          override: {
            url: "https://api.example.com/{{ env.unknownKey }}",
            headers: { "x-t": "{{ var.unknownVar }}" },
            body: "k={{ input.missing }}",
          },
        }),
      },
      buildTemplateContext({}, null, {}, {}),
    );
    const joined = result.warnings.join("\n");
    expect(joined).toContain("unknownKey");
    expect(joined).toContain("unknownVar");
    expect(joined).toContain("input.missing");
  });

  it("不传 templateContext 时按原文透传（静态重建出口）", () => {
    const result = buildPreviewRequest({
      node: makeNode({
        manualRequest: { method: "GET", url: "https://api.example.com/base" },
        override: { url: "https://api.example.com/{{ env.baseUrl }}" },
      }),
    });
    expect(result.request.url).toBe("https://api.example.com/{{ env.baseUrl }}");
    expect(result.warnings).toEqual([]);
  });
});

describe("buildPreviewRequest：头保真 / Cookie / 超时 / 二进制", () => {
  it("headerFidelity static 值渲染并入出站头，浏览器专属头仍被剥离", () => {
    const entry = makeEntry({
      url: "https://api.example.com/origin-path",
      headers: [
        { name: "origin", value: "https://captured.example.com" },
        { name: "sec-fetch-site", value: "same-origin" },
        { name: "x-keep", value: "yes" },
      ],
    });
    const result = buildPreviewRequest(
      {
        node: makeNode({
          requestId: "req-1",
          headerFidelity: { origin: { source: "static", value: "{{ env.realOrigin }}" } },
        }),
        harEntries: { "req-1": entry },
      },
      buildTemplateContext({}, null, {}, { realOrigin: "https://real.example.com" }),
    );
    expect(result.request.headers["Origin"]).toBe("https://real.example.com");
    expect(result.request.headers["sec-fetch-site"]).toBeUndefined();
    expect(result.request.headers["x-keep"]).toBe("yes");
  });

  it("cookieMode=custom：cookieValue 模板渲染后作为 Cookie 头并入", () => {
    const result = buildPreviewRequest(
      {
        node: makeNode({
          manualRequest: { method: "GET", url: "https://api.example.com/d" },
          cookieMode: "custom",
          cookieValue: "sid={{ var.sid }}",
        }),
      },
      buildTemplateContext({}, null, { sid: "s-123" }),
    );
    expect(result.request.headers["Cookie"]).toBe("sid=s-123");
  });

  it("二进制基线 body（base64 postData）→ bodyBase64，跳过模板渲染", () => {
    // bytes of "raw-bytes" base64 = cmF3LWJ5dGVz
    const entry = makeEntry({
      postData: { mimeType: "application/octet-stream", text: "cmF3LWJ5dGVz", encoding: "base64" },
    });
    const result = buildPreviewRequest(
      {
        node: makeNode({ requestId: "req-1" }),
        harEntries: { "req-1": entry },
      },
      buildTemplateContext({}, null),
    );
    expect(result.request.body).toBeUndefined();
    expect(result.request.bodyBase64).toBe("cmF3LWJ5dGVz");
  });

  it("timeoutMs：override 覆盖优先，缺省回退 config.timeoutMs", () => {
    const base = { manualRequest: { method: "GET", url: "https://api.example.com/e" } };
    const overridden = buildPreviewRequest({
      node: makeNode({ ...base, override: { timeoutMs: 1500 }, timeoutMs: 9000 }),
    });
    expect(overridden.request.timeoutMs).toBe(1500);
    const fallback = buildPreviewRequest({
      node: makeNode({ ...base, timeoutMs: 9000 }),
    });
    expect(fallback.request.timeoutMs).toBe(9000);
  });
});
