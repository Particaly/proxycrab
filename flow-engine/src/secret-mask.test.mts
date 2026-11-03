import { describe, expect, it } from "vitest";
import type { NodeRun } from "./types";
import {
  SECRET_MASK_MIN_LENGTH,
  SECRET_MASK_PLACEHOLDER,
  maskNodeRunForRecord,
  maskRunSummaryForRecord,
  maskSecretsDeep,
  maskSecretsInText,
} from "./secret-mask";

/**
 * secret 变量脱敏纯函数测试（M9-T5）：文本子串替换、深度结构遍历、
 * 节点快照（input / output / error）与运行摘要（run 级 error + 全部节点）
 * 的脱敏行为，及最短长度护栏 / 占位符不参与匹配等边界。
 */

/** 构造最小节点快照（字段可覆盖） */
function makeNodeRun(overrides: Partial<NodeRun> = {}): NodeRun {
  return {
    status: "success",
    input: null,
    output: null,
    startedAt: 1,
    durationMs: 2,
    ...overrides,
  };
}

describe("maskSecretsInText：文本子串替换", () => {
  it("命中 secret 的文本整体替换为占位符（含嵌入形态）", () => {
    expect(maskSecretsInText("sk-abc123", ["sk-abc123"])).toBe(SECRET_MASK_PLACEHOLDER);
    // 嵌入在 header 值 / URL / 拼接文本中的形态同样生效（选择子串替换的核心动机）
    expect(maskSecretsInText("Bearer sk-abc123", ["sk-abc123"])).toBe(
      `Bearer ${SECRET_MASK_PLACEHOLDER}`,
    );
    expect(maskSecretsInText("https://a.dev?token=sk-abc123&x=1", ["sk-abc123"])).toBe(
      `https://a.dev?token=${SECRET_MASK_PLACEHOLDER}&x=1`,
    );
  });

  it("同一文本命中多个 secret 时全部替换；无命中原样返回", () => {
    expect(maskSecretsInText("a-1111 b-2222", ["1111x", "b-2222", "a-1111"])).toBe(
      `${SECRET_MASK_PLACEHOLDER} ${SECRET_MASK_PLACEHOLDER}`,
    );
    expect(maskSecretsInText("plain text", ["sk-abc123"])).toBe("plain text");
    expect(maskSecretsInText("", ["sk-abc123"])).toBe("");
  });

  it("最短长度护栏：短于 SECRET_MASK_MIN_LENGTH 的值不参与替换（防误伤）", () => {
    const short = "ab";
    expect(short.length).toBeLessThan(SECRET_MASK_MIN_LENGTH);
    expect(maskSecretsInText("ab cd", [short])).toBe("ab cd");
    expect(SECRET_MASK_MIN_LENGTH).toBeGreaterThanOrEqual(4);
  });

  it("空清单与非字符串项跳过；占位符自身不作为 secret 匹配", () => {
    expect(maskSecretsInText("abc", [])).toBe("abc");
    // 非字符串值（运行期被 setVariable 覆写的同名变量）不参与脱敏
    expect(maskSecretsInText("abc", [123, null, undefined])).toBe("abc");
    expect(maskSecretsInText(`x ${SECRET_MASK_PLACEHOLDER} y`, [SECRET_MASK_PLACEHOLDER])).toBe(
      `x ${SECRET_MASK_PLACEHOLDER} y`,
    );
  });
});

describe("maskSecretsDeep：深度结构遍历", () => {
  it("对象 / 数组 / 嵌套结构中的字符串逐一脱敏；键不参与", () => {
    const value = {
      headers: { Authorization: "Bearer sk-abc123", "X-Trace": "t-1" },
      body: JSON.stringify({ token: "sk-abc123" }),
      list: ["safe", "sk-abc123"],
      count: 3,
      flag: true,
      nil: null,
    };
    const masked = maskSecretsDeep(value, ["sk-abc123"]) as typeof value;
    expect(masked.headers.Authorization).toBe(`Bearer ${SECRET_MASK_PLACEHOLDER}`);
    expect(masked.headers["X-Trace"]).toBe("t-1");
    expect(masked.body).toBe(`{"token":"${SECRET_MASK_PLACEHOLDER}"}`);
    expect(masked.list).toEqual(["safe", SECRET_MASK_PLACEHOLDER]);
    expect(masked.count).toBe(3);
    expect(masked.flag).toBe(true);
    expect(masked.nil).toBeNull();
    // 键名即使等于 secret 值也不改写（键是结构不是数据）
    expect(Object.keys(masked.headers)).toEqual(["Authorization", "X-Trace"]);
  });

  it("字符串以外的原始值原样保留；空清单直接返回原值", () => {
    const value = { n: 1, s: "sk-abc123" };
    expect(maskSecretsDeep(value, [])).toBe(value);
    const masked = maskSecretsDeep(value, ["sk-abc123"]) as typeof value;
    expect(masked.n).toBe(1);
    expect(masked.s).toBe(SECRET_MASK_PLACEHOLDER);
  });
});

describe("maskNodeRunForRecord：节点快照脱敏", () => {
  it("input / output 深度脱敏，error 文本脱敏，其余字段保留", () => {
    const nodeRun = makeNodeRun({
      input: { q: "secret-value-123" },
      output: { headers: { "Set-Cookie": "sid=secret-value-123" } },
      error: "脚本失败：secret-value-123",
    });
    const masked = maskNodeRunForRecord(nodeRun, ["secret-value-123"]);
    expect(masked.input).toEqual({ q: SECRET_MASK_PLACEHOLDER });
    expect(masked.output).toEqual({
      headers: { "Set-Cookie": `sid=${SECRET_MASK_PLACEHOLDER}` },
    });
    expect(masked.error).toBe(`脚本失败：${SECRET_MASK_PLACEHOLDER}`);
    expect(masked.status).toBe("success");
    expect(masked.startedAt).toBe(1);
    expect(masked.durationMs).toBe(2);
    // 不改动入参
    expect(nodeRun.input).toEqual({ q: "secret-value-123" });
    expect(nodeRun.error).toBe("脚本失败：secret-value-123");
  });

  it("error 缺省时不新增 error 字段；无 secret 值时字段保持原引用", () => {
    const nodeRun = makeNodeRun({ input: "plain", output: "plain" });
    const masked = maskNodeRunForRecord(nodeRun, ["secret-value-123"]);
    expect("error" in masked).toBe(false);
    expect(masked.input).toBe("plain");
    expect(masked.output).toBe("plain");
  });
});

describe("maskRunSummaryForRecord：运行摘要脱敏", () => {
  it("全部节点快照逐一脱敏 + run 级 error 脱敏；不改动入参", () => {
    const summary = {
      status: "failed" as const,
      error: "节点 a 失败：Bearer pk-live-9999",
      nodeRuns: {
        a: makeNodeRun({ output: { token: "pk-live-9999" } }),
        b: makeNodeRun({ input: { auth: "pk-live-9999" }, status: "skipped" }),
      },
    };
    const masked = maskRunSummaryForRecord(summary, ["pk-live-9999"]);
    expect(masked.error).toBe(`节点 a 失败：Bearer ${SECRET_MASK_PLACEHOLDER}`);
    expect(masked.nodeRuns.a.output).toEqual({ token: SECRET_MASK_PLACEHOLDER });
    expect(masked.nodeRuns.b.input).toEqual({ auth: SECRET_MASK_PLACEHOLDER });
    expect(masked.status).toBe("failed");
    // 入参保持原样（executor 的 summary 不被打改）
    expect(summary.nodeRuns.a.output).toEqual({ token: "pk-live-9999" });
    expect(summary.error).toBe("节点 a 失败：Bearer pk-live-9999");
  });

  it("无 error 的摘要不新增 error 字段", () => {
    const summary = { status: "success" as const, nodeRuns: {} };
    const masked = maskRunSummaryForRecord(summary, ["pk-live-9999"]);
    expect("error" in masked).toBe(false);
  });
});
