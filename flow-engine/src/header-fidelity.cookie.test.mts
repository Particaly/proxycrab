import { describe, expect, it } from "vitest";
import type { HarEntry, HarRequest } from "./types";
import {
  COOKIE_HEADER_NAME,
  extractSnapshotCookie,
  resolveCookieDecision,
} from "./header-fidelity";

/**
 * Cookie 快照注入决策测试（M12-T3）：捕获值提取（结构化 cookies 优先、
 * 回退 Cookie 头）与按 cookieMode 的注入决策（缺省 / snapshot 回放捕获值，
 * browser 不注入，未捕获时无决策）。
 */

function makeEntry(requestOverrides: Partial<HarRequest> = {}): HarEntry {
  return {
    startedDateTime: "2026-01-01T00:00:00.000Z",
    time: 1,
    request: {
      method: "GET",
      url: "https://api.example.com/v1",
      httpVersion: "HTTP/1.1",
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: -1,
      ...requestOverrides,
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      headers: [],
      content: { size: 0, mimeType: "" },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
    },
    timings: { send: 0, wait: 1, receive: 0 },
  };
}

describe("extractSnapshotCookie：捕获值提取", () => {
  it("结构化 request.cookies 优先，按序拼成 Cookie 串（值与空值段保留）", () => {
    const entry = makeEntry({
      headers: [{ name: "cookie", value: "header=ignored" }],
      cookies: [
        { name: "sid", value: "abc" },
        { name: "empty", value: "" },
      ],
    });
    expect(extractSnapshotCookie(entry)).toBe("sid=abc; empty=");
  });

  it("无结构化 cookies 时回退 Cookie 头（取首个匹配、trim）", () => {
    const entry = makeEntry({ headers: [{ name: "Cookie", value: "  sid=1; t=2  " }] });
    expect(extractSnapshotCookie(entry)).toBe("sid=1; t=2");
  });

  it("都取不到时返回 undefined", () => {
    expect(extractSnapshotCookie(makeEntry())).toBeUndefined();
    expect(
      extractSnapshotCookie(makeEntry({ headers: [{ name: "cookie", value: "   " }] })),
    ).toBeUndefined();
    expect(
      extractSnapshotCookie(makeEntry({ cookies: [{ name: "", value: "x" }] })),
    ).toBeUndefined();
  });
});

describe("resolveCookieDecision：按 cookieMode 解析注入决策", () => {
  const withCookie = makeEntry({ cookies: [{ name: "sid", value: "abc" }] });

  it("mode 缺省 / snapshot：产出 Cookie set 决策（键为 cookie、来源 snapshot）", () => {
    expect(resolveCookieDecision({ harEntry: withCookie })).toEqual({
      key: "cookie",
      header: COOKIE_HEADER_NAME,
      value: "sid=abc",
      source: "snapshot",
    });
    expect(resolveCookieDecision({ mode: "snapshot", harEntry: withCookie })?.value).toBe(
      "sid=abc",
    );
  });

  it("快照未捕获 Cookie：无决策（退化为浏览器 jar）", () => {
    expect(resolveCookieDecision({ harEntry: makeEntry() })).toBeUndefined();
  });

  it("捕获值经模板渲染（{{ var.* }} 可拼进 Cookie）", () => {
    const entry = makeEntry({ cookies: [{ name: "session", value: "{{ var.sid }}" }] });
    const decision = resolveCookieDecision({
      harEntry: entry,
      templateContext: { node: {}, input: null, var: { sid: "live-token" } },
    });
    expect(decision?.value).toBe("session=live-token");
  });

  it("变量缺失时引用渲染为空串（保留名与等号），仍产出决策", () => {
    const entry = makeEntry({ cookies: [{ name: "session", value: "{{ var.missing }}" }] });
    const decision = resolveCookieDecision({
      harEntry: entry,
      templateContext: { node: {}, input: null, var: {} },
    });
    expect(decision?.value).toBe("session=");
  });
});

describe("resolveCookieDecision：custom 自定义值", () => {
  it("mode custom：注入 cookieValue 指定值（来源 static），不读快照", () => {
    const entry = makeEntry({ cookies: [{ name: "sid", value: "captured=1" }] });
    expect(
      resolveCookieDecision({ mode: "custom", cookieValue: "sid=custom", harEntry: entry }),
    ).toEqual({
      key: "cookie",
      header: COOKIE_HEADER_NAME,
      value: "sid=custom",
      source: "static",
    });
    // 快照未捕获 Cookie 也可用（不依赖引用）
    expect(
      resolveCookieDecision({ mode: "custom", cookieValue: "sid=custom", harEntry: makeEntry() })
        ?.value,
    ).toBe("sid=custom");
  });

  it("mode custom：值经模板渲染（{{ var.* }} 拼进 Cookie）", () => {
    const decision = resolveCookieDecision({
      mode: "custom",
      cookieValue: "session={{ var.sid }}; theme=dark",
      harEntry: makeEntry(),
      templateContext: { node: {}, input: null, var: { sid: "live-token" } },
    });
    expect(decision?.value).toBe("session=live-token; theme=dark");
  });

  it("mode custom：值缺失 / 渲染后为空串 → 无决策（退化为浏览器 jar）", () => {
    expect(resolveCookieDecision({ mode: "custom", harEntry: makeEntry() })).toBeUndefined();
    expect(
      resolveCookieDecision({ mode: "custom", cookieValue: "   ", harEntry: makeEntry() }),
    ).toBeUndefined();
    expect(
      resolveCookieDecision({
        mode: "custom",
        cookieValue: "{{ var.missing }}",
        harEntry: makeEntry(),
        templateContext: { node: {}, input: null, var: {} },
      }),
    ).toBeUndefined();
  });

  it("Cookie 头已删除（removedHeaders 命中）：捕获值与自定义值都不再注入", () => {
    const withCookie = makeEntry({ cookies: [{ name: "sid", value: "abc" }] });
    expect(
      resolveCookieDecision({ harEntry: withCookie, removedHeaders: ["cookie"] }),
    ).toBeUndefined();
    expect(
      resolveCookieDecision({ harEntry: withCookie, removedHeaders: ["Cookie"] }),
    ).toBeUndefined();
    expect(
      resolveCookieDecision({
        mode: "custom",
        cookieValue: "sid=x",
        harEntry: withCookie,
        removedHeaders: ["cookie"],
      }),
    ).toBeUndefined();
    // 未命中时行为不变
    expect(
      resolveCookieDecision({ harEntry: withCookie, removedHeaders: ["x-other"] })?.value,
    ).toBe("sid=abc");
  });
});
