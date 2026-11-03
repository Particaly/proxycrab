import { describe, expect, it } from "vitest";
import { createLocalScriptPort } from "./script-port";
import { runPostScript, runPreScript } from "./script";
import type { PostProcessResponse } from "./script";

/**
 * M9-T2 本地脚本端口测试：createLocalScriptPort 的三个方法与直接调用引擎
 * 函数结果逐字段一致（同一批函数的 Promise 包装），作为缺省端口保持既有
 * 测试与降级路径行为不变。
 */

describe("createLocalScriptPort（缺省本地端口）", () => {
  const port = createLocalScriptPort();

  it("runPre 与 runPreScript 同步结果一致（value + warnings）", async () => {
    const source = 'return { url: "https://x", unknown: 1 }';
    const input = { node: {} };
    const viaPort = await port.runPre(source, input);
    expect(viaPort).toEqual(runPreScript(source, input));
    expect(viaPort.ok).toBe(true);
    if (viaPort.ok) {
      expect(viaPort.value).toEqual({ url: "https://x" });
      expect(viaPort.warnings).toHaveLength(1);
    }
  });

  it("runPost 与 runPostScript 一致：缺省 output = response.body", async () => {
    const response: PostProcessResponse = {
      status: 200,
      headers: {},
      body: { token: "t" },
      durationMs: 5,
    };
    const viaPort = await port.runPost("", response);
    expect(viaPort).toEqual(runPostScript("", response));
    expect(viaPort.ok).toBe(true);
    if (viaPort.ok) expect(viaPort.value).toEqual({ token: "t" });
  });

  it("脚本失败以结果对象呈现（不抛错），kind 原样保留", async () => {
    const viaPort = await port.runPre('throw new Error("boom")', {});
    expect(viaPort.ok).toBe(false);
    if (!viaPort.ok) expect(viaPort.error.kind).toBe("runtime");
  });

  it("runCondition 与 runConditionExpression 一致：truthy 判定前的原始值", async () => {
    const viaPort = await port.runCondition("return input.n > 1", { input: { n: 2 }, vars: {} });
    expect(viaPort).toEqual({ ok: true, value: true });
  });
});
