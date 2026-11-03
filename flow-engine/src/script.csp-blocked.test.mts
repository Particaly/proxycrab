import { afterEach, describe, expect, it, vi } from "vitest";
import { compileScript, resolveScriptTimeoutMs, DEFAULT_SCRIPT_TIMEOUT_MS } from "./script";
import { classifyNodeError, ScriptExecutionError } from "./error-class";
import type { ScriptError } from "./script";

/**
 * M9-T2 新增错误类别 'blocked'（CSP 拦截 eval 系求值）测试：
 * compileScript 在 `new Function` 抛 EvalError 时归类 'blocked' 而非 'syntax'
 * （M9-T1 真机结论：MV3 扩展上下文默认 CSP 拦 eval，此前被误报为「语法错误」）；
 * 真实 SyntaxError 不受误伤；classifyNodeError 对 'blocked' 归独立类别；
 * resolveScriptTimeoutMs 的解析规则（沙箱通道两侧看门狗的单一出处）。
 *
 * jsdom / node 不拦 eval，无法自然产生 CSP EvalError——以「替换全局 Function
 * 构造器抛 EvalError」模拟被 CSP 拦截的编译现场（与真机抛出值同形状）。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("compileScript：CSP 拦截归类 blocked（M9-T2）", () => {
  /** 让全局 new Function 抛出与真机 CSP 拦截一致的 EvalError（M9-T1 摘录文案形状） */
  function stubCspBlockedFunction(): void {
    const BlockedFunction = function (): never {
      throw new EvalError(
        "Evaluating a string as JavaScript violates the following Content Security Policy directive: " +
          "script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' http://localhost:* http://127.0.0.1:*",
      );
    };
    vi.stubGlobal("Function", BlockedFunction);
  }

  it("编译被 CSP 拦截（EvalError）→ 归类 blocked，message 携带 CSP 报错与通道提示", () => {
    stubCspBlockedFunction();
    const result = compileScript("return 1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("blocked");
    expect(result.error.message).toContain("前置处理脚本");
    expect(result.error.message).toContain("内容安全策略");
    expect(result.error.message).toContain("Content Security Policy");
    expect(result.error.message).not.toContain("语法错误");
  });

  it("post 模式同样按 blocked 归类，message 类别标签为后置", () => {
    stubCspBlockedFunction();
    const result = compileScript("return response.status", "post");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("blocked");
    expect(result.error.message).toContain("后置处理脚本");
  });

  it("真实语法错误仍归 syntax（不受 blocked 误伤）", () => {
    const result = compileScript("return {{{");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("syntax");
    expect(result.error.message).toContain("前置处理脚本语法错误");
  });
});

describe("classifyNodeError：blocked 类别（M9-T2）", () => {
  it("ScriptError{kind:'blocked'} → 'blocked'（环境问题单列，不与 script 混同）", () => {
    const blocked: ScriptError = {
      kind: "blocked",
      message: "前置处理脚本被内容安全策略（CSP）拦截",
    };
    expect(classifyNodeError(blocked)).toBe("blocked");
  });

  it("ScriptExecutionError 包装的 blocked 同样归 blocked", () => {
    expect(classifyNodeError(new ScriptExecutionError({ kind: "blocked", message: "x" }))).toBe(
      "blocked",
    );
  });

  it("既有分类不受影响：syntax / runtime / invalid-return → script，timeout → timeout", () => {
    expect(classifyNodeError({ kind: "syntax", message: "x" })).toBe("script");
    expect(classifyNodeError({ kind: "runtime", message: "x" })).toBe("script");
    expect(classifyNodeError({ kind: "invalid-return", message: "x" })).toBe("script");
    expect(classifyNodeError({ kind: "timeout", message: "x" })).toBe("timeout");
  });
});

describe("resolveScriptTimeoutMs（M9-T2 导出：沙箱通道两侧看门狗的单一出处）", () => {
  it("缺省 / 非有限 / 负数 → DEFAULT_SCRIPT_TIMEOUT_MS；合法值原样", () => {
    expect(resolveScriptTimeoutMs(undefined)).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
    expect(resolveScriptTimeoutMs({})).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
    expect(resolveScriptTimeoutMs({ timeoutMs: Number.NaN })).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
    expect(resolveScriptTimeoutMs({ timeoutMs: -1 })).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
    expect(resolveScriptTimeoutMs({ timeoutMs: 0 })).toBe(0);
    expect(resolveScriptTimeoutMs({ timeoutMs: 1234 })).toBe(1234);
  });
});
