/**
 * 脚本试跑纯逻辑单测（计划 Task 18）：错误分类文案、样例 JSON 规整、返回值
 * 序列化、能力位缺省拒绝与请求装配（side → sampleInput/sampleResponse）。
 */
import { describe, expect, it } from "vitest";
import type { Backend } from "../../api/backend";
import type { FlowScriptDryRunRequest, FlowScriptDryRunResult } from "../../api/types";
import {
  DEFAULT_SAMPLE_JSON,
  SCRIPT_DOC,
  SCRIPT_SKELETON,
  errorKindLabel,
  parseSampleJson,
  runScriptDryRun,
  stringifyDryRunValue,
} from "./dry-run";

describe("errorKindLabel", () => {
  it("maps every engine kind to a distinct Chinese label", () => {
    expect(errorKindLabel("syntax")).toBe("语法错误");
    expect(errorKindLabel("blocked")).toBe("执行被拒绝");
    expect(errorKindLabel("runtime")).toBe("运行时错误");
    expect(errorKindLabel("timeout")).toBe("执行超时");
    expect(errorKindLabel("invalid-return")).toBe("返回值非法");
  });

  it("falls back to the runtime label for unknown kinds", () => {
    expect(errorKindLabel("something-else")).toBe("运行时错误");
  });
});

describe("parseSampleJson", () => {
  it("treats blank text as null", () => {
    expect(parseSampleJson("")).toEqual({ ok: true, value: null });
    expect(parseSampleJson("   \n")).toEqual({ ok: true, value: null });
  });

  it("parses valid JSON and reports failures with a readable message", () => {
    expect(parseSampleJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    const failed = parseSampleJson("{nope");
    expect(failed.ok).toBe(false);
    expect(failed.ok ? "" : failed.error).toContain("样例 JSON 解析失败");
  });
});

describe("stringifyDryRunValue", () => {
  it("renders null/undefined as undefined and pretty-prints objects", () => {
    expect(stringifyDryRunValue(null)).toBe("undefined");
    expect(stringifyDryRunValue(undefined)).toBe("undefined");
    expect(stringifyDryRunValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("falls back to String for non-serializable values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(stringifyDryRunValue(cyclic)).toBe("[object Object]");
  });
});

describe("SCRIPT_DOC and skeletons", () => {
  it("pins the engine data-param contract per side", () => {
    expect(SCRIPT_DOC.pre.paramName).toBe("input");
    expect(SCRIPT_DOC.pre.badge).toBe("前置处理");
    expect(SCRIPT_DOC.pre.returnFields.map((field) => field.name)).toEqual([
      "url",
      "headers",
      "body",
      "timeoutMs",
    ]);
    expect(SCRIPT_DOC.post.paramName).toBe("response");
    expect(SCRIPT_DOC.post.badge).toBe("后置处理");
    expect(SCRIPT_DOC.post.returnFields).toEqual([]);
  });

  it("ships a skeleton and a parseable default sample per side", () => {
    for (const side of ["pre", "post"] as const) {
      expect(SCRIPT_SKELETON[side]).toContain("return");
      expect(parseSampleJson(DEFAULT_SAMPLE_JSON[side]).ok).toBe(true);
    }
  });
});

describe("runScriptDryRun", () => {
  it("rejects when the capability is missing", async () => {
    const backend = {} as Backend;
    await expect(
      runScriptDryRun(backend, { side: "pre", script: "return 1", sampleJson: "{}" }),
    ).rejects.toThrow("当前环境不支持脚本试跑");
  });

  it("rejects sample parse failures before calling the backend", async () => {
    let calls = 0;
    const backend = {
      flowScriptDryRun: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    } as unknown as Backend;
    await expect(
      runScriptDryRun(backend, { side: "pre", script: "return 1", sampleJson: "{nope" }),
    ).rejects.toThrow("样例 JSON 解析失败");
    expect(calls).toBe(0);
  });

  it("routes the parsed sample to sampleInput for pre and sampleResponse for post", async () => {
    const requests: FlowScriptDryRunRequest[] = [];
    const backend = {
      flowScriptDryRun: async (request: FlowScriptDryRunRequest) => {
        requests.push(request);
        return { ok: true, value: 1, warnings: [] } as FlowScriptDryRunResult;
      },
    } as unknown as Backend;
    await runScriptDryRun(backend, { side: "pre", script: "s", sampleJson: '{"a":1}' });
    await runScriptDryRun(backend, { side: "post", script: "s", sampleJson: '{"b":2}' });
    expect(requests).toEqual([
      { side: "pre", script: "s", sampleInput: { a: 1 } },
      { side: "post", script: "s", sampleResponse: { b: 2 } },
    ]);
  });

  it("surfaces script failures as classified results instead of thrown errors", async () => {
    const backend = {
      flowScriptDryRun: async () =>
        ({
          ok: false,
          warnings: [],
          error: { kind: "syntax", message: "前置处理脚本语法错误" },
        }) as FlowScriptDryRunResult,
    } as unknown as Backend;
    const result = await runScriptDryRun(backend, {
      side: "pre",
      script: "return {{{",
      sampleJson: "",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("syntax");
  });
});
