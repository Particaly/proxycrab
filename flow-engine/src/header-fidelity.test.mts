import { describe, expect, it } from "vitest";
import type { HarEntry, HarRequest, NodeHeaderFidelity } from "./types";
import {
  HEADER_FIDELITY_TARGETS,
  HEADER_RULE_ID_MAX,
  HEADER_RULE_ID_MIN,
  buildHeaderFidelityRule,
  buildOriginRegexFilter,
  createHeaderRuleIdAllocator,
  isReservedHeaderRuleId,
  resolveHeaderFidelityPlan,
} from "./header-fidelity";

/**
 * M9-T3 header 保真纯逻辑测试：
 * 取值解析（fromCapture 大小写不敏感 / static 模板渲染 / 空值跳过 / 默认回放捕获值）、
 * origin 匹配正则（转义 + 锚定 + 非法 URL）、DNR 规则构造（tabIds:[-1] /
 * modifyHeaders set / 空决策与非法 URL 不产规则）、保留 ID 区间判定与分配器回绕。
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

/* ---------------- 取值解析 ---------------- */

describe("resolveHeaderFidelityPlan：默认回放捕获值", () => {
  it("基线未携带三头（undefined / 空对象配置）时不产生任何决策", () => {
    const entry = makeEntry();
    expect(resolveHeaderFidelityPlan({ fidelity: undefined, harEntry: entry })).toEqual([]);
    expect(resolveHeaderFidelityPlan({ fidelity: {}, harEntry: entry })).toEqual([]);
  });

  it("未配置 headerFidelity：捕获到 Origin / User-Agent 时默认按捕获值注入", () => {
    const entry = makeEntry({
      headers: [
        { name: "Origin", value: "https://app.example.com" },
        { name: "User-Agent", value: "UA/1.0" },
      ],
    });
    // 键缺省 = fromCapture：默认携带，无需勾选
    const plan = resolveHeaderFidelityPlan({ fidelity: undefined, harEntry: entry });
    expect(plan).toEqual([
      { key: "origin", header: "Origin", value: "https://app.example.com", source: "fromCapture" },
      { key: "userAgent", header: "User-Agent", value: "UA/1.0", source: "fromCapture" },
    ]);
  });

  it("static 覆盖项生效，未覆盖键仍按捕获值", () => {
    const entry = makeEntry({
      headers: [
        { name: "origin", value: "https://captured.example.com" },
        { name: "user-agent", value: "CapturedUA/1.0" },
      ],
    });
    const plan = resolveHeaderFidelityPlan({
      fidelity: { origin: { source: "static", value: "https://override.example.com" } },
      harEntry: entry,
    });
    expect(plan).toEqual([
      { key: "origin", header: "Origin", value: "https://override.example.com", source: "static" },
      { key: "userAgent", header: "User-Agent", value: "CapturedUA/1.0", source: "fromCapture" },
    ]);
  });
});

describe("resolveHeaderFidelityPlan：fromCapture（从原始请求恢复）", () => {
  it("基线携带 Origin / Referer 时按捕获值产生决策", () => {
    const entry = makeEntry({
      headers: [
        { name: "Origin", value: "https://app.example.com" },
        { name: "Referer", value: "https://app.example.com/checkout" },
      ],
    });
    const plan = resolveHeaderFidelityPlan({
      fidelity: {
        origin: { source: "fromCapture" },
        referer: { source: "fromCapture" },
      },
      harEntry: entry,
    });
    expect(plan).toEqual([
      { key: "origin", header: "Origin", value: "https://app.example.com", source: "fromCapture" },
      {
        key: "referer",
        header: "Referer",
        value: "https://app.example.com/checkout",
        source: "fromCapture",
      },
    ]);
  });

  it("头名匹配大小写不敏感（基线小写 origin / user-agent 也能命中）", () => {
    const entry = makeEntry({
      headers: [
        { name: "origin", value: "https://low.example.com" },
        { name: "user-agent", value: "CapturedUA/1.0" },
      ],
    });
    const plan = resolveHeaderFidelityPlan({
      fidelity: {
        origin: { source: "fromCapture" },
        userAgent: { source: "fromCapture" },
      },
      harEntry: entry,
    });
    expect(plan).toEqual([
      { key: "origin", header: "Origin", value: "https://low.example.com", source: "fromCapture" },
      { key: "userAgent", header: "User-Agent", value: "CapturedUA/1.0", source: "fromCapture" },
    ]);
  });

  it("基线未携带该头时跳过该项（不报错、不产空决策）", () => {
    const plan = resolveHeaderFidelityPlan({
      fidelity: { referer: { source: "fromCapture" } },
      harEntry: makeEntry({ headers: [{ name: "accept", value: "application/json" }] }),
    });
    expect(plan).toEqual([]);
  });
});

describe("resolveHeaderFidelityPlan：static（自定义值）", () => {
  it("非空字符串直接作为注入值", () => {
    const plan = resolveHeaderFidelityPlan({
      fidelity: { origin: { source: "static", value: "https://override.example.com" } },
      harEntry: makeEntry(),
    });
    expect(plan).toEqual([
      { key: "origin", header: "Origin", value: "https://override.example.com", source: "static" },
    ]);
  });

  it("传入 templateContext 时先渲染 {{ }} 模板", () => {
    const plan = resolveHeaderFidelityPlan({
      fidelity: {
        referer: { source: "static", value: "https://app.example.com/{{ input.page }}" },
      },
      harEntry: makeEntry(),
      templateContext: { node: {}, input: { page: "checkout" } },
    });
    expect(plan).toEqual([
      {
        key: "referer",
        header: "Referer",
        value: "https://app.example.com/checkout",
        source: "static",
      },
    ]);
  });

  it("原始值 / 渲染结果为空（含缺数据替换为空串）时跳过该项", () => {
    const entry = makeEntry();
    // 原始空白
    expect(
      resolveHeaderFidelityPlan({
        fidelity: { origin: { source: "static", value: "   " } },
        harEntry: entry,
      }),
    ).toEqual([]);
    // 模板引用缺数据 → 渲染为空串 → 跳过（DNR set 不允许空值）
    expect(
      resolveHeaderFidelityPlan({
        fidelity: { origin: { source: "static", value: "{{ input.missing }}" } },
        harEntry: entry,
        templateContext: { node: {}, input: {} },
      }),
    ).toEqual([]);
  });
});

describe("resolveHeaderFidelityPlan：顺序与混合", () => {
  it("决策顺序固定为 origin → referer → userAgent", () => {
    const entry = makeEntry({
      headers: [{ name: "user-agent", value: "CapturedUA/2.0" }],
    });
    const fidelity: NodeHeaderFidelity = {
      userAgent: { source: "fromCapture" },
      origin: { source: "static", value: "https://o.example.com" },
    };
    const plan = resolveHeaderFidelityPlan({ fidelity, harEntry: entry });
    expect(plan.map((decision) => decision.key)).toEqual(["origin", "userAgent"]);
  });

  it("HEADER_FIDELITY_TARGETS 键序即遍历序（三键齐全时依次产出）", () => {
    const entry = makeEntry({
      headers: [
        { name: "origin", value: "https://o.example.com" },
        { name: "referer", value: "https://o.example.com/r" },
        { name: "user-agent", value: "UA/3.0" },
      ],
    });
    const plan = resolveHeaderFidelityPlan({
      fidelity: {
        origin: { source: "fromCapture" },
        referer: { source: "fromCapture" },
        userAgent: { source: "fromCapture" },
      },
      harEntry: entry,
    });
    expect(plan.map((decision) => decision.header)).toEqual([
      HEADER_FIDELITY_TARGETS.origin,
      HEADER_FIDELITY_TARGETS.referer,
      HEADER_FIDELITY_TARGETS.userAgent,
    ]);
  });
});

describe("resolveHeaderFidelityPlan：removedHeaders（已删除头不再注入）", () => {
  const entry = makeEntry({
    headers: [
      { name: "Origin", value: "https://app.example.com" },
      { name: "Referer", value: "https://app.example.com/r" },
      { name: "User-Agent", value: "UA/1.0" },
    ],
  });

  it("命中的头整体跳过（大小写不敏感），其余照常产出", () => {
    const plan = resolveHeaderFidelityPlan({
      fidelity: undefined,
      harEntry: entry,
      removedHeaders: ["user-agent"],
    });
    expect(plan.map((decision) => decision.header)).toEqual(["Origin", "Referer"]);
  });

  it("即使配置了 static 自定义值，已删除头也不再注入", () => {
    const plan = resolveHeaderFidelityPlan({
      fidelity: { origin: { source: "static", value: "https://o.example.com" } },
      harEntry: entry,
      removedHeaders: ["Origin"],
    });
    expect(plan.map((decision) => decision.header)).toEqual(["Referer", "User-Agent"]);
  });

  it("removedHeaders 缺省 / 空清单：行为与既有完全一致", () => {
    const withRemoved = resolveHeaderFidelityPlan({
      fidelity: undefined,
      harEntry: entry,
      removedHeaders: [],
    });
    const without = resolveHeaderFidelityPlan({ fidelity: undefined, harEntry: entry });
    expect(withRemoved).toEqual(without);
    expect(without).toHaveLength(3);
  });
});

/* ---------------- origin 匹配正则 ---------------- */

describe("buildOriginRegexFilter", () => {
  it("锚定 origin 全串（含端口），点号等元字符转义", () => {
    expect(buildOriginRegexFilter("http://127.0.0.1:12345/echo?x=1")).toBe(
      "^http://127\\.0\\.0\\.1:12345/",
    );
    expect(buildOriginRegexFilter("https://api.example.com/v1/users")).toBe(
      "^https://api\\.example\\.com/",
    );
  });

  it("URL 不可解析或 origin 为 null（opaque）时返回 null", () => {
    expect(buildOriginRegexFilter("not-a-url")).toBeNull();
    expect(buildOriginRegexFilter("file:///tmp/x")).toBeNull();
  });
});

/* ---------------- 规则构造 ---------------- */

describe("buildHeaderFidelityRule", () => {
  it("一条规则承载全部决策头：modifyHeaders set + tabIds:[-1] + priority 1", () => {
    const rule = buildHeaderFidelityRule({
      targetUrl: "http://127.0.0.1:12345/strict",
      decisions: [
        {
          key: "origin",
          header: "Origin",
          value: "https://app.example.com",
          source: "fromCapture",
        },
        {
          key: "referer",
          header: "Referer",
          value: "https://app.example.com/checkout",
          source: "fromCapture",
        },
      ],
    });
    expect(rule).toEqual({
      priority: 1,
      condition: {
        regexFilter: "^http://127\\.0\\.0\\.1:12345/",
        tabIds: [-1],
      },
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin", operation: "set", value: "https://app.example.com" },
          { header: "Referer", operation: "set", value: "https://app.example.com/checkout" },
        ],
      },
    });
  });

  it("决策为空 / 目标 URL 非法时不产规则（null）", () => {
    expect(
      buildHeaderFidelityRule({ targetUrl: "https://api.example.com/", decisions: [] }),
    ).toBeNull();
    expect(
      buildHeaderFidelityRule({
        targetUrl: "not-a-url",
        decisions: [
          { key: "origin", header: "Origin", value: "https://o.example.com", source: "static" },
        ],
      }),
    ).toBeNull();
  });
});

/* ---------------- 保留 ID 区间与分配器 ---------------- */

describe("isReservedHeaderRuleId", () => {
  it("区间内（含端点）为 true，区间外 / 非整数为 false", () => {
    expect(isReservedHeaderRuleId(HEADER_RULE_ID_MIN)).toBe(true);
    expect(isReservedHeaderRuleId(HEADER_RULE_ID_MAX)).toBe(true);
    expect(isReservedHeaderRuleId(HEADER_RULE_ID_MIN + 1)).toBe(true);
    expect(isReservedHeaderRuleId(HEADER_RULE_ID_MIN - 1)).toBe(false);
    expect(isReservedHeaderRuleId(HEADER_RULE_ID_MAX + 1)).toBe(false);
    expect(isReservedHeaderRuleId(1)).toBe(false);
    expect(isReservedHeaderRuleId(Number.NaN)).toBe(false);
  });
});

describe("createHeaderRuleIdAllocator", () => {
  it("缺省区间从 HEADER_RULE_ID_MIN 起自增", () => {
    const allocator = createHeaderRuleIdAllocator();
    expect(allocator.next()).toBe(HEADER_RULE_ID_MIN);
    expect(allocator.next()).toBe(HEADER_RULE_ID_MIN + 1);
    expect(allocator.next()).toBe(HEADER_RULE_ID_MIN + 2);
  });

  it("区间回绕：越过上界后从下界重新开始（冷启动清扫保证区间为空）", () => {
    const allocator = createHeaderRuleIdAllocator({ min: 5, max: 7 });
    expect([allocator.next(), allocator.next(), allocator.next(), allocator.next()]).toEqual([
      5, 6, 7, 5,
    ]);
  });
});
