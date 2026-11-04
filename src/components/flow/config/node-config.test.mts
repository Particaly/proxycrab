import { describe, expect, it } from "vitest";
import type { RequestLibraryEntry, WorkflowNode } from "../../../api/types";
import {
  baselineFromEntry,
  buildReplayNodeConfig,
  capturedSpecialHeader,
  generateRefId,
  headerRowsFromBaseline,
  isSpecialHeader,
  manualHeadersFromRows,
  overrideFromHeaderRows,
  parseRetryInput,
  parseTimeoutMs,
  readReplayConfig,
  staticFidelityOnly,
  takenRefKeys,
  urlHint,
  validateHeaderRows,
  validateRefIdDraft,
  type HeaderRowDraft,
  type ReplayConfigDraft,
} from "./node-config";

/** 构造请求库条目（仅本文件测试所需的最小 HAR 形状）。 */
function makeEntry(har: RequestLibraryEntry["har"]): RequestLibraryEntry {
  return {
    id: "req-1",
    name: "示例",
    tags: [],
    source: "capture",
    origin: "https://a.example.com",
    har,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("readReplayConfig / buildReplayNodeConfig 往返", () => {
  it("非法形状按缺省归一，不抛错", () => {
    const draft = readReplayConfig({
      failPolicy: "sometimes",
      cookieMode: "browser",
      timeoutMs: "x",
      retry: { maxAttempts: "a" },
      headerFidelity: { origin: { source: "weird" }, referer: "no" },
      manualRequest: { headers: { a: 1, b: "2" } },
    });
    expect(draft.failPolicy).toBe("stop");
    expect(draft.cookieCustom).toBeUndefined();
    expect(draft.timeoutMs).toBeUndefined();
    expect(draft.retry).toBeUndefined();
    expect(draft.headerFidelity?.origin).toEqual({ source: "fromCapture" });
    expect(draft.headerFidelity?.referer).toBeUndefined();
    expect(draft.manualRequest?.headers).toEqual({ b: "2" });
  });

  it("完整配置往返保形", () => {
    const config = {
      requestId: "req-1",
      override: {
        method: "POST",
        url: "/api",
        headers: { authorization: "Bearer {{ env.token }}" },
        removedHeaders: ["x-old"],
        body: "",
      },
      preProcess: "return input;",
      timeoutMs: 3000,
      failPolicy: "continue",
      headerFidelity: {
        origin: { source: "static", value: "https://a.example.com" },
        userAgent: { source: "static", value: "UA" },
      },
      cookieMode: "custom",
      cookieValue: "a=b",
      retry: { maxAttempts: 3, backoffMs: 500, multiplier: 2 },
      pinnedOutput: { value: { ok: 1 }, pinnedAt: 7, sourceRunId: "run-1" },
    };
    const draft = readReplayConfig(config);
    expect(draft).toEqual({
      requestId: "req-1",
      override: {
        method: "POST",
        url: "/api",
        headers: { authorization: "Bearer {{ env.token }}" },
        removedHeaders: ["x-old"],
        body: "",
      },
      preProcess: "return input;",
      postProcess: undefined,
      timeoutMs: 3000,
      failPolicy: "continue",
      headerFidelity: {
        origin: { source: "static", value: "https://a.example.com" },
        referer: undefined,
        userAgent: { source: "static", value: "UA" },
      },
      cookieCustom: "a=b",
      retry: { maxAttempts: 3, backoffMs: 500, multiplier: 2 },
      pinnedOutput: { value: { ok: 1 }, pinnedAt: 7, sourceRunId: "run-1" },
    });
    expect(buildReplayNodeConfig(draft)).toEqual(config);
  });

  it("空草稿只落 failPolicy", () => {
    expect(buildReplayNodeConfig(readReplayConfig({}))).toEqual({ failPolicy: "stop" });
  });

  it("空白值省略；自定义 Cookie 空值不落；manualRequest 空方法补 GET", () => {
    const config = buildReplayNodeConfig({
      failPolicy: "stop",
      manualRequest: { method: "", url: "  ", headers: { "  ": "x", a: "1" } },
      cookieCustom: "   ",
      preProcess: "  ",
    });
    expect(config).toEqual({
      failPolicy: "stop",
      manualRequest: { method: "GET", url: "  ", headers: { a: "1" } },
    });
  });

  it("引用态不落 manualRequest；未引用不落 override", () => {
    const referenced = buildReplayNodeConfig({
      failPolicy: "stop",
      requestId: "req-1",
      override: { headers: { a: "1" } },
      manualRequest: { method: "GET", url: "http://x" },
    });
    expect(referenced).toEqual({
      failPolicy: "stop",
      requestId: "req-1",
      override: { headers: { a: "1" } },
    });
    const manual = buildReplayNodeConfig({
      failPolicy: "stop",
      manualRequest: { method: "POST", url: "/x", body: "hi" },
      override: { url: "/y" },
    });
    expect(manual).toEqual({
      failPolicy: "stop",
      manualRequest: { method: "POST", url: "/x", body: "hi" },
    });
  });

  it("保真只落 static 非空项", () => {
    expect(
      staticFidelityOnly({
        origin: { source: "fromCapture" },
        referer: { source: "static", value: "  " },
        userAgent: { source: "static", value: " UA " },
      }),
    ).toEqual({ userAgent: { source: "static", value: "UA" } });
    expect(staticFidelityOnly(undefined)).toBeUndefined();
    expect(staticFidelityOnly({ origin: { source: "static", value: "" } })).toBeUndefined();
  });
});

describe("baselineFromEntry", () => {
  it("取首个 entry 的请求基线并过滤特殊头", () => {
    const entry = makeEntry({
      log: {
        version: "1.2",
        entries: [
          {
            request: {
              method: "POST",
              url: "https://a.example.com/x",
              headers: [
                { name: "content-type", value: "application/json" },
                { name: "Origin", value: "https://a.example.com" },
                { name: "Cookie", value: "k=v" },
                { name: "  ", value: "skip" },
              ],
              queryString: [],
              postData: { mimeType: "application/json", text: '{"a":1}' },
            },
          },
        ],
      },
    });
    expect(baselineFromEntry(entry)).toEqual({
      method: "POST",
      url: "https://a.example.com/x",
      headers: [{ name: "content-type", value: "application/json" }],
      bodyText: '{"a":1}',
      bodyBinaryBytes: null,
    });
  });

  it("base64 二进制 body 不作文本基线并给出字节数", () => {
    const entry = makeEntry({
      log: {
        version: "1.2",
        entries: [
          {
            request: {
              method: "GET",
              url: "https://a.example.com/",
              headers: [],
              queryString: [],
              postData: { mimeType: "application/octet-stream", text: "AAEC", encoding: "base64" },
            },
          },
        ],
      },
    });
    const baseline = baselineFromEntry(entry);
    expect(baseline.bodyText).toBeNull();
    expect(baseline.bodyBinaryBytes).toBe(3);
  });

  it("空快照安全兜底", () => {
    expect(baselineFromEntry(makeEntry({ log: { version: "1.2", entries: [] } }))).toEqual({
      method: "GET",
      url: "",
      headers: [],
      bodyText: null,
      bodyBinaryBytes: null,
    });
  });

  it("特殊头判定大小写不敏感", () => {
    expect(isSpecialHeader("User-Agent")).toBe(true);
    expect(isSpecialHeader("cookie")).toBe(true);
    expect(isSpecialHeader("x-cookie-jar")).toBe(false);
  });
});

describe("overrideFromHeaderRows", () => {
  const captured = [
    { name: "accept", value: "*/*" },
    { name: "authorization", value: "old" },
  ];

  it("未改动的捕获行不落 override；删除的捕获行落 removedHeaders", () => {
    const rows: HeaderRowDraft[] = [
      { name: "accept", value: "*/*", original: { name: "accept", value: "*/*" } },
    ];
    expect(overrideFromHeaderRows(rows, captured)).toEqual({
      removedHeaders: ["authorization"],
    });
  });

  it("改值的捕获行落 headers；改名 = 删旧名 + 加新名", () => {
    const rows: HeaderRowDraft[] = [
      { name: "authorization", value: "new", original: { name: "authorization", value: "old" } },
      { name: "x-forwarded-for", value: "1.2.3.4", original: { name: "x-origin-ip", value: "" } },
    ];
    expect(overrideFromHeaderRows(rows, captured)).toEqual({
      headers: { authorization: "new", "x-forwarded-for": "1.2.3.4" },
      removedHeaders: ["x-origin-ip", "accept"],
    });
  });

  it("新增行与空名行；值回到基线则不落", () => {
    const rows: HeaderRowDraft[] = [
      { name: "accept", value: "*/*", original: { name: "accept", value: "*/*" } },
      { name: "authorization", value: "old", original: { name: "authorization", value: "old" } },
      { name: "x-new", value: "1" },
      { name: "  ", value: "  " },
    ];
    expect(overrideFromHeaderRows(rows, captured)).toEqual({ headers: { "x-new": "1" } });
  });

  it("仅大小写差异的头名视为同名（值变落 headers，不落删除）", () => {
    const rows: HeaderRowDraft[] = [
      { name: "authorization", value: "x", original: { name: "Authorization", value: "old" } },
    ];
    expect(overrideFromHeaderRows(rows, captured)).toEqual({
      headers: { authorization: "x" },
      removedHeaders: ["accept"],
    });
  });
});

describe("manualHeadersFromRows / validateHeaderRows", () => {
  it("全空行丢弃，全空返回 undefined", () => {
    expect(manualHeadersFromRows([{ name: "  ", value: "" }])).toBeUndefined();
    expect(manualHeadersFromRows([{ name: " a ", value: "1" }])).toEqual({ a: "1" });
  });

  it("有值无名 / 重复头名报错", () => {
    expect(validateHeaderRows([{ name: "", value: "x" }])).toBe("请求头名称不能为空");
    expect(
      validateHeaderRows([
        { name: "A", value: "1" },
        { name: "a", value: "2" },
      ]),
    ).toBe("请求头名称重复：a");
    expect(
      validateHeaderRows([
        { name: "", value: "" },
        { name: "A", value: "1" },
      ]),
    ).toBeNull();
  });
});

describe("headerRowsFromBaseline / capturedSpecialHeader", () => {
  const baseline = {
    method: "GET",
    url: "https://a.example.com/",
    headers: [
      { name: "accept", value: "*/*" },
      { name: "authorization", value: "old" },
    ],
    bodyText: null,
    bodyBinaryBytes: null,
  };

  it("无 override 时按基线回填", () => {
    expect(headerRowsFromBaseline(baseline, undefined)).toEqual([
      { name: "accept", value: "*/*", original: { name: "accept", value: "*/*" } },
      {
        name: "authorization",
        value: "old",
        original: { name: "authorization", value: "old" },
      },
    ]);
  });

  it("删除 / 覆盖 / 新增合并回填", () => {
    const rows = headerRowsFromBaseline(baseline, {
      headers: { Accept: "application/json", "x-new": "1" },
      removedHeaders: ["AUTHORIZATION"],
    });
    expect(rows).toEqual([
      {
        name: "Accept",
        value: "application/json",
        original: { name: "accept", value: "*/*" },
      },
      { name: "x-new", value: "1" },
    ]);
  });

  it("快照特殊头捕获值大小写不敏感", () => {
    const entry = makeEntry({
      log: {
        version: "1.2",
        entries: [
          {
            request: {
              method: "GET",
              url: "https://a.example.com/",
              headers: [{ name: "User-Agent", value: "UA/1" }],
              queryString: [],
            },
          },
        ],
      },
    });
    expect(capturedSpecialHeader(entry, "user-agent")).toBe("UA/1");
    expect(capturedSpecialHeader(entry, "origin")).toBeNull();
  });
});

describe("输入解析", () => {
  it("timeoutMs", () => {
    expect(parseTimeoutMs("")).toEqual({});
    expect(parseTimeoutMs(" 3000 ")).toEqual({ value: 3000 });
    expect(parseTimeoutMs("0").error).toBeTruthy();
    expect(parseTimeoutMs("1.5").error).toBeTruthy();
    expect(parseTimeoutMs("abc").error).toBeTruthy();
  });

  it("retry", () => {
    expect(parseRetryInput("", "", "")).toEqual({});
    expect(parseRetryInput("3", "500", "")).toEqual({
      retry: { maxAttempts: 3, backoffMs: 500 },
    });
    expect(parseRetryInput("3", "500", "1.5")).toEqual({
      retry: { maxAttempts: 3, backoffMs: 500, multiplier: 1.5 },
    });
    expect(parseRetryInput("3", "", "").error).toBeTruthy();
    expect(parseRetryInput("0", "500", "").error).toBeTruthy();
    expect(parseRetryInput("3", "-1", "").error).toBeTruthy();
    expect(parseRetryInput("3", "500", "0").error).toBeTruthy();
  });

  it("urlHint", () => {
    expect(urlHint("")).toBeNull();
    expect(urlHint("https://a.com/x")).toBeNull();
    expect(urlHint("/api")).toBeNull();
    expect(urlHint("a.com")).toBeTruthy();
  });
});

describe("refId 短码", () => {
  it("takenRefKeys 含节点 id 与既有短码", () => {
    const nodes: WorkflowNode[] = [
      { id: "n1", type: "start", position: { x: 0, y: 0 }, config: {} },
      { id: "n2", type: "httpReplay", position: { x: 0, y: 0 }, config: {}, refId: "abcde" },
    ];
    expect(takenRefKeys(nodes)).toEqual(new Set(["n1", "n2", "abcde"]));
  });

  it("validateRefIdDraft：空串合法、形状非法报错、占用报错、原值放行", () => {
    const taken = new Set(["n1", "abcde"]);
    expect(validateRefIdDraft("", "abcde", taken)).toBeNull();
    expect(validateRefIdDraft("  ", undefined, taken)).toBeNull();
    expect(validateRefIdDraft("abc1", undefined, taken)).toBeTruthy();
    expect(validateRefIdDraft("abcdef", undefined, taken)).toBeTruthy();
    expect(validateRefIdDraft("abcde", "abcde", taken)).toBeNull();
    expect(validateRefIdDraft("abcde", undefined, taken)).toContain("已被流程内其它节点占用");
  });

  it("generateRefId 不命中占用集合且形状合法", () => {
    const generated = generateRefId(new Set(["aaaaa"]));
    expect(generated).toMatch(/^[A-Za-z]{5}$/);
    expect(generated).not.toBe("aaaaa");
  });
});
