import { beforeEach, describe, expect, it } from "vitest";
import type { HarEntry, HarHeader } from "./types";
import { parseCookieHeader, withNormalizedRequestCookies } from "./har-cookies";

/**
 * HAR 请求侧 Cookie 归一化测试（M12-T3）：Cookie 头解析为结构化数组、
 * 缺 cookies 的 entry 补齐（已带结构化数组 / 无 Cookie 头时原样返回）。
 */

function makeEntry(overrides: Partial<HarEntry["request"]> = {}): HarEntry {
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
      ...overrides,
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

const headers = (...pairs: Array<[string, string]>): HarHeader[] =>
  pairs.map(([name, value]) => ({ name, value }));

describe("parseCookieHeader：Cookie 头 → 结构化 cookies", () => {
  it("多段按序解析（值保留 = 之后原文，首尾空白去除）", () => {
    expect(parseCookieHeader("sid=abc123; theme=dark; a=b=c")).toEqual([
      { name: "sid", value: "abc123" },
      { name: "theme", value: "dark" },
      { name: "a", value: "b=c" },
    ]);
  });

  it("空段 / 无 = 段忽略；空串与无值段返回空数组", () => {
    expect(parseCookieHeader(" sid=1 ;; onlyname ; =; ")).toEqual([{ name: "sid", value: "1" }]);
    expect(parseCookieHeader("")).toEqual([]);
    expect(parseCookieHeader("novalue")).toEqual([]);
  });

  it("空值段保留（name= → value 为空串）", () => {
    expect(parseCookieHeader("a=; b=2")).toEqual([
      { name: "a", value: "" },
      { name: "b", value: "2" },
    ]);
  });
});

describe("withNormalizedRequestCookies：entry 补齐", () => {
  it("缺结构化 cookies 且有 Cookie 头 → 补齐为新 entry（原 entry 不变）", () => {
    const entry = makeEntry({ headers: headers(["Cookie", "sid=1; t=2"], ["accept", "*/*"]) });
    const normalized = withNormalizedRequestCookies(entry);
    expect(normalized).not.toBe(entry);
    expect(normalized.request.cookies).toEqual([
      { name: "sid", value: "1" },
      { name: "t", value: "2" },
    ]);
    expect(entry.request.cookies).toBeUndefined();
  });

  it("已带结构化 cookies：原样返回（不覆盖更完整的捕获信息）", () => {
    const entry = makeEntry({
      headers: headers(["cookie", "sid=old"]),
      cookies: [{ name: "sid", value: "fresh", path: "/", domain: "api.example.com" }],
    });
    expect(withNormalizedRequestCookies(entry)).toBe(entry);
  });

  it("无 Cookie 头 / 头值为空 / 头值无可解析段：原样返回", () => {
    const noCookie = makeEntry({ headers: headers(["accept", "*/*"]) });
    expect(withNormalizedRequestCookies(noCookie)).toBe(noCookie);
    const emptyCookie = makeEntry({ headers: headers(["cookie", "   "]) });
    expect(withNormalizedRequestCookies(emptyCookie)).toBe(emptyCookie);
    const junkCookie = makeEntry({ headers: headers(["cookie", "novalue"]) });
    expect(withNormalizedRequestCookies(junkCookie)).toBe(junkCookie);
  });
});

describe("har-cookies：storage 缺失容错", () => {
  beforeEach(() => {
    // 纯函数无状态，这里仅保证用例间无共享（占位断言）
  });

  it("与其他模块一致：纯函数不依赖环境", () => {
    expect(parseCookieHeader("a=1")).toHaveLength(1);
  });
});
