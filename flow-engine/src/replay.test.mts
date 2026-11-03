import { describe, expect, it } from "vitest";
import type { HarEntry, HarRequest } from "./types";
import {
  HEADERS_POLICY,
  KEEP_REFERER,
  KEEP_UA,
  buildReplayRequest,
  stripBrowserOnlyHeaders,
} from "./replay";

/**
 * M5-T2 请求重放纯函数测试：
 * HAR 基线重建、override / extraOverride 覆盖合并（后到优先、headers 逐键）、
 * 模板渲染（有上下文渲染 / 无上下文透传）、浏览器专属头剥离策略、
 * UA 透传开关、referer 保留开关、无 postData、覆盖值合法性守卫。
 */

/* ---------------- 夹具构造 ---------------- */

/** 构造最小合法 HAR 请求（字段可覆盖） */
function makeRequest(overrides: Partial<HarRequest> = {}): HarRequest {
  return {
    method: "GET",
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

/** 模板渲染上下文（node.n1.output.token / input.token 可被引用） */
const TEMPLATE_CONTEXT = {
  node: { n1: { output: { token: "tk-123" } } },
  input: { token: "in-456" },
};

/* ---------------- HAR 基线 ---------------- */

describe("buildReplayRequest：HAR 基线", () => {
  it("method / url / headers 取自 HAR 请求", () => {
    const entry = makeEntry({
      method: "POST",
      url: "https://api.example.com/v1/orders",
      headers: [
        { name: "accept", value: "application/json" },
        { name: "authorization", value: "Bearer abc" },
      ],
    });
    const request = buildReplayRequest({ harEntry: entry });
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.example.com/v1/orders");
    expect(request.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer abc",
    });
  });

  it("body 基线 = postData.text", () => {
    const entry = makeEntry({
      method: "POST",
      postData: { mimeType: "application/json", text: '{"a":1}' },
    });
    expect(buildReplayRequest({ harEntry: entry }).body).toBe('{"a":1}');
  });

  it("无 postData 时不产生 body 字段", () => {
    const request = buildReplayRequest({ harEntry: makeEntry() });
    expect("body" in request).toBe(false);
  });

  it("HAR 重名头后者覆盖前者（与浏览器最终发送语义一致）", () => {
    const entry = makeEntry({
      headers: [
        { name: "x-tag", value: "first" },
        { name: "x-tag", value: "second" },
      ],
    });
    expect(buildReplayRequest({ harEntry: entry }).headers["x-tag"]).toBe("second");
  });
});

/* ---------------- 覆盖合并 ---------------- */

describe("buildReplayRequest：override 覆盖", () => {
  it("method / url / body 整体替换", () => {
    const entry = makeEntry({
      method: "GET",
      postData: { mimeType: "text/plain", text: "old" },
    });
    const request = buildReplayRequest({
      harEntry: entry,
      override: { method: "PUT", url: "https://api.example.com/v2/users", body: '{"new":true}' },
    });
    expect(request.method).toBe("PUT");
    expect(request.url).toBe("https://api.example.com/v2/users");
    expect(request.body).toBe('{"new":true}');
  });

  it("headers 逐键覆盖合并：命中的键整体替换，未提及的键保留，新键追加", () => {
    const entry = makeEntry({
      headers: [
        { name: "accept", value: "text/html" },
        { name: "authorization", value: "Bearer old" },
      ],
    });
    const request = buildReplayRequest({
      harEntry: entry,
      override: { headers: { authorization: "Bearer new", "x-custom": "yes" } },
    });
    expect(request.headers).toEqual({
      accept: "text/html",
      authorization: "Bearer new",
      "x-custom": "yes",
    });
  });

  it("removedHeaders 按大小写不敏感规则删除快照 Header", () => {
    const entry = makeEntry({
      headers: [
        { name: "X-Token", value: "secret" },
        { name: "accept", value: "*/*" },
      ],
    });
    const request = buildReplayRequest({
      harEntry: entry,
      override: { removedHeaders: ["x-token"] },
    });
    expect(request.headers).toEqual({ accept: "*/*" });
  });

  it("headers 覆盖值允许空串（键存在即整体取覆盖值，无删除语义）", () => {
    const entry = makeEntry({ headers: [{ name: "x-flag", value: "on" }] });
    const request = buildReplayRequest({
      harEntry: entry,
      override: { headers: { "x-flag": "", "x-empty": "" } },
    });
    expect(request.headers["x-flag"]).toBe("");
    expect(request.headers["x-empty"]).toBe("");
  });
});

describe("buildReplayRequest：extraOverride 后到优先", () => {
  const entry = makeEntry({
    method: "GET",
    url: "https://api.example.com/base",
    headers: [{ name: "authorization", value: "Bearer har" }],
  });

  it("method / url 与 override 冲突时 extraOverride 胜出", () => {
    const request = buildReplayRequest({
      harEntry: entry,
      override: { method: "PUT", url: "https://override.example.com/a" },
      extraOverride: { method: "PATCH", url: "https://extra.example.com/b" },
    });
    expect(request.method).toBe("PATCH");
    expect(request.url).toBe("https://extra.example.com/b");
  });

  it("headers 三层逐键合并：extra 覆盖 override 覆盖 HAR，其余键保留", () => {
    const request = buildReplayRequest({
      harEntry: entry,
      override: { headers: { authorization: "Bearer override", "x-from-override": "1" } },
      extraOverride: { headers: { authorization: "Bearer extra", "x-from-extra": "2" } },
    });
    expect(request.headers).toEqual({
      authorization: "Bearer extra",
      "x-from-override": "1",
      "x-from-extra": "2",
    });
  });

  it("body：extraOverride 胜出；对象形态 JSON 序列化；null 视为不修改", () => {
    const withPost = makeEntry({
      method: "POST",
      postData: { mimeType: "text/plain", text: "base" },
    });
    expect(
      buildReplayRequest({
        harEntry: withPost,
        override: { body: "from-override" },
        extraOverride: { body: "from-extra" },
      }).body,
    ).toBe("from-extra");
    expect(
      buildReplayRequest({ harEntry: withPost, extraOverride: { body: { k: [1, 2] } } }).body,
    ).toBe('{"k":[1,2]}');
    expect(
      buildReplayRequest({
        harEntry: withPost,
        override: { body: "from-override" },
        extraOverride: { body: null },
      }).body,
    ).toBe("from-override");
  });

  it("timeoutMs 仅来自 extraOverride，进入产物", () => {
    const request = buildReplayRequest({
      harEntry: entry,
      extraOverride: { timeoutMs: 1234 },
    });
    expect(request.timeoutMs).toBe(1234);
    expect("timeoutMs" in buildReplayRequest({ harEntry: entry })).toBe(false);
  });

  it("extraOverride 为空对象 / 缺省时产物等于仅 override 的结果", () => {
    const base = buildReplayRequest({
      harEntry: entry,
      override: { url: "https://x.example.com" },
    });
    const withEmpty = buildReplayRequest({
      harEntry: entry,
      override: { url: "https://x.example.com" },
      extraOverride: {},
    });
    expect(withEmpty).toEqual(base);
  });
});

describe("buildReplayRequest：覆盖值合法性守卫（非法值保持基线）", () => {
  it("method / url 空串不生效", () => {
    const entry = makeEntry({ method: "GET", url: "https://api.example.com/base" });
    const request = buildReplayRequest({
      harEntry: entry,
      override: { method: "", url: "" },
    });
    expect(request.method).toBe("GET");
    expect(request.url).toBe("https://api.example.com/base");
  });

  it("headers 非字符串值跳过（PreScriptOverrides 值合法性由本层校验）", () => {
    const entry = makeEntry({ headers: [{ name: "keep", value: "me" }] });
    const request = buildReplayRequest({
      harEntry: entry,
      extraOverride: {
        headers: { keep: 42, bad: null, good: "v" } as unknown as Record<string, string>,
      },
    });
    expect(request.headers).toEqual({ keep: "me", good: "v" });
  });

  it("timeoutMs 非有限数 / 非正数不生效", () => {
    const entry = makeEntry();
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const request = buildReplayRequest({ harEntry: entry, extraOverride: { timeoutMs: bad } });
      expect("timeoutMs" in request).toBe(false);
    }
  });
});

/* ---------------- 模板渲染 ---------------- */

describe("buildReplayRequest：模板渲染", () => {
  const entry = makeEntry({
    method: "POST",
    url: "https://api.example.com/{{ input.token }}/items",
    headers: [
      { name: "authorization", value: "Bearer {{ node.n1.output.token }}" },
      { name: "accept", value: "application/json" },
    ],
    postData: { mimeType: "application/json", text: '{"token":"{{ input.token }}"}' },
  });

  it("url / headers 值 / body 内 {{ }} 以 templateContext 渲染", () => {
    const request = buildReplayRequest({ harEntry: entry }, TEMPLATE_CONTEXT);
    expect(request.url).toBe("https://api.example.com/in-456/items");
    expect(request.headers.authorization).toBe("Bearer tk-123");
    expect(request.headers.accept).toBe("application/json");
    expect(request.body).toBe('{"token":"in-456"}');
  });

  it("headers 只渲染值、不改键名（renderValueDeep 语义）", () => {
    const weird = makeEntry({
      headers: [{ name: "x-{{ input.token }}", value: "{{ input.token }}" }],
    });
    const request = buildReplayRequest({ harEntry: weird }, TEMPLATE_CONTEXT);
    expect(Object.keys(request.headers)).toEqual(["x-{{ input.token }}"]);
    expect(Object.values(request.headers)).toEqual(["in-456"]);
  });

  it("缺数据按空串替换（渲染永不失败）", () => {
    const request = buildReplayRequest(
      { harEntry: makeEntry({ url: "https://api.example.com/{{ node.nope.output.x }}" }) },
      TEMPLATE_CONTEXT,
    );
    expect(request.url).toBe("https://api.example.com/");
  });

  it("无 templateContext 时跳过渲染、按原文透传", () => {
    const request = buildReplayRequest({ harEntry: entry });
    expect(request.url).toBe("https://api.example.com/{{ input.token }}/items");
    expect(request.headers.authorization).toBe("Bearer {{ node.n1.output.token }}");
    expect(request.body).toBe('{"token":"{{ input.token }}"}');
  });

  it("body 为 undefined 时渲染跳过不报错", () => {
    const request = buildReplayRequest({ harEntry: makeEntry() }, TEMPLATE_CONTEXT);
    expect("body" in request).toBe(false);
  });
});

/* ---------------- 浏览器专属头策略 ---------------- */

describe("stripBrowserOnlyHeaders：剥离策略", () => {
  /** 覆盖全部策略类目的样例头 */
  const SAMPLE: Record<string, string> = {
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "sec-ch-ua": '"Chromium";v="120"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    referer: "https://example.com/page",
    "content-length": "123",
    host: "api.example.com",
    origin: "https://example.com",
    cookie: "session=old-captured-value",
    "user-agent": "Mozilla/5.0 (captured)",
    accept: "application/json",
    "accept-language": "zh-CN,zh;q=0.9",
    "accept-encoding": "gzip, deflate",
    authorization: "Bearer abc",
    "x-custom": "keep-me",
  };

  it("剥离 sec-fetch-* / sec-ch-ua* / referer / content-length / host / origin / cookie，其余保留", () => {
    const stripped = stripBrowserOnlyHeaders(SAMPLE);
    expect(Object.keys(stripped).sort()).toEqual(
      [
        "user-agent",
        "accept",
        "accept-language",
        "accept-encoding",
        "authorization",
        "x-custom",
      ].sort(),
    );
  });

  it("匹配大小写不敏感，保留头输出原名", () => {
    const stripped = stripBrowserOnlyHeaders({
      "Sec-Fetch-Site": "same-origin",
      "SEC-CH-UA": '"x"',
      "Content-Length": "5",
      Host: "h",
      Origin: "o",
      Cookie: "c",
      Referer: "r",
      "User-Agent": "UA",
      "X-Keep": "v",
    });
    expect(stripped).toEqual({ "User-Agent": "UA", "X-Keep": "v" });
  });

  it("user-agent 默认透传（KEEP_UA = true，R3），keepUserAgent=false 时剥离", () => {
    expect(KEEP_UA).toBe(true);
    expect(stripBrowserOnlyHeaders({ "user-agent": "UA" })["user-agent"]).toBe("UA");
    expect(stripBrowserOnlyHeaders({ "user-agent": "UA" }, { keepUserAgent: false })).toEqual({});
  });

  it("referer 默认剥离（KEEP_REFERER = false），keepReferer=true 可保留", () => {
    expect(KEEP_REFERER).toBe(false);
    expect(stripBrowserOnlyHeaders({ referer: "r" })).toEqual({});
    expect(stripBrowserOnlyHeaders({ referer: "r" }, { keepReferer: true })).toEqual({
      referer: "r",
    });
  });

  it("空头 / 未知头原样保留；不改动入参对象", () => {
    const input = { "x-a": "1" };
    const stripped = stripBrowserOnlyHeaders(input);
    expect(stripped).toEqual({ "x-a": "1" });
    expect(stripped).not.toBe(input);
  });

  it("HEADERS_POLICY 常量名单覆盖规格要求的全部类目", () => {
    expect(HEADERS_POLICY.STRIP_EXACT).toEqual(
      expect.arrayContaining(["content-length", "host", "origin", "cookie"]),
    );
    expect(HEADERS_POLICY.STRIP_PREFIXES).toEqual(
      expect.arrayContaining(["sec-fetch-", "sec-ch-ua"]),
    );
    expect(HEADERS_POLICY.REFERER).toBe("referer");
    expect(HEADERS_POLICY.USER_AGENT).toBe("user-agent");
  });
});

describe("buildReplayRequest：头策略为最终出口闸门", () => {
  it("override / extraOverride 写入的禁改头同样被剥离", () => {
    const entry = makeEntry({
      headers: [{ name: "sec-fetch-mode", value: "cors" }],
    });
    const request = buildReplayRequest({
      harEntry: entry,
      override: { headers: { host: "evil.example.com", "x-ok": "1" } },
      extraOverride: { headers: { origin: "https://evil.example.com" } },
    });
    expect(request.headers).toEqual({ "x-ok": "1" });
  });

  it("HAR 的 cookie 头被剥离（cookie 携带交由 fetch credentials include 处理）", () => {
    const entry = makeEntry({
      headers: [
        { name: "cookie", value: "session=captured" },
        { name: "authorization", value: "Bearer abc" },
      ],
    });
    const request = buildReplayRequest({ harEntry: entry });
    expect(request.headers).toEqual({ authorization: "Bearer abc" });
  });
});
