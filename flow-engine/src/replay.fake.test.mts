import { describe, expect, it } from "vitest";
import type { HarEntry, HarRequest } from "./types";
import { buildReplayRequest } from "./replay";
import { buildTemplateContext } from "./executor";

/**
 * 重放重建 × 假数据模板测试：buildReplayRequest 对 url / headers 值 / body 依次
 * 渲染且共用同一 templateContext 实例——同一 `{{ fake.phone }}` 表达式经 WeakMap
 * 缓存在三处取值一致（同一节点执行 = 同一个假用户）；换 ctx（新节点执行）即
 * 重新随机。构建自 template.fake.test.mts，此处只锁「重建管线层面」的一致性。
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

describe("buildReplayRequest：fake 模板跨槽位一致性", () => {
  it("同一 templateContext 下 url / header / body 的 {{ fake.phone }} 取同一值", () => {
    const templateContext = buildTemplateContext({}, null);
    const entry = makeEntry();
    const request = buildReplayRequest(
      {
        harEntry: entry,
        override: {
          url: "https://api.example.com/v1/users?phone={{ fake.phone }}",
          headers: { "x-phone": "{{ fake.phone }}" },
          body: '{"phone":"{{ fake.phone }}"}',
        },
      },
      templateContext,
    );
    expect(request.url).toMatch(/^https:\/\/api\.example\.com\/v1\/users\?phone=\d{11}$/);
    const phone = request.url.slice("https://api.example.com/v1/users?phone=".length);
    expect(request.headers["x-phone"]).toBe(phone);
    expect(request.body).toBe(`{"phone":"${phone}"}`);
  });

  it("基线（无 override）url 中的 fake 表达式同样渲染", () => {
    const entry = makeEntry({ url: "https://api.example.com/v1?n={{ fake.number(1,100) }}" });
    const request = buildReplayRequest({ harEntry: entry }, buildTemplateContext({}, null));
    const n = Number(request.url.slice("https://api.example.com/v1?n=".length));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(100);
  });

  it("不传 templateContext 时 fake 表达式按原文透传（既有约定出口）", () => {
    const entry = makeEntry();
    const request = buildReplayRequest({
      harEntry: entry,
      override: { body: '{"phone":"{{ fake.phone }}"}' },
    });
    expect(request.body).toBe('{"phone":"{{ fake.phone }}"}');
  });
});
