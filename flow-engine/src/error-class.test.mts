import { describe, expect, it } from "vitest";
import {
  HttpFailureError,
  ScriptExecutionError,
  classifyNodeError,
  isHttpFailure,
} from "./error-class";
import type { ScriptError } from "./script";

/**
 * M5-T4 错误分类测试：
 * classifyNodeError 全路径（ScriptError kind → HTTP → [network]/[timeout]/[cancelled]
 * 前缀 → AbortError 防御 → unknown）与 isHttpFailure 判定边界。
 * 分类依据与顺序见 error-class.ts 文件头（M5-T3 ScriptError 与 M5-T2 前缀约定）。
 */

/** 构造 ScriptError 形状对象（与 script.ts 产出的结果对象一致） */
function scriptError(kind: ScriptError["kind"], message = `${kind}-msg`): ScriptError {
  return { kind, message };
}

describe("classifyNodeError：脚本错误（ScriptError.kind）", () => {
  it("syntax / runtime / invalid-return → script", () => {
    expect(classifyNodeError(scriptError("syntax"))).toBe("script");
    expect(classifyNodeError(scriptError("runtime"))).toBe("script");
    expect(classifyNodeError(scriptError("invalid-return"))).toBe("script");
  });

  it("timeout → timeout（脚本超时单列）", () => {
    expect(classifyNodeError(scriptError("timeout"))).toBe("timeout");
  });

  it("ScriptExecutionError（run-controller 的包装抛出形态）按 kind 归类", () => {
    expect(classifyNodeError(new ScriptExecutionError(scriptError("runtime")))).toBe("script");
    expect(classifyNodeError(new ScriptExecutionError(scriptError("timeout")))).toBe("timeout");
    // message 原样保留（面向用户的可读文案）
    const wrapped = new ScriptExecutionError(
      scriptError("runtime", "前置处理脚本运行时错误：boom"),
    );
    expect(wrapped.message).toBe("前置处理脚本运行时错误：boom");
    expect(classifyNodeError(wrapped).length).toBeGreaterThan(0);
  });

  it("kind 字段不合法的普通 Error 不误判为脚本错误", () => {
    const fake = new Error("has kind?");
    Object.assign(fake, { kind: "not-a-script-kind" });
    expect(classifyNodeError(fake)).toBe("unknown");
  });
});

describe("classifyNodeError：HTTP 失败", () => {
  it("HttpFailureError → http（message 为「HTTP <status>」形式）", () => {
    const error = new HttpFailureError(404);
    expect(error.message).toBe("HTTP 404");
    expect(error.status).toBe(404);
    expect(classifyNodeError(error)).toBe("http");
  });

  it("message 恰为「HTTP <三位数字>」形态也归 http（跨包装兜底）", () => {
    expect(classifyNodeError(new Error("HTTP 500"))).toBe("http");
    expect(classifyNodeError("HTTP 503")).toBe("http");
  });

  it("非「HTTP <三位数字>」形态的普通错误不误判", () => {
    expect(classifyNodeError(new Error("HTTP 4xx"))).toBe("unknown");
    expect(classifyNodeError(new Error("http错误 404"))).toBe("unknown");
  });
});

describe("classifyNodeError：runner message 前缀（M5-T2 约定）", () => {
  it("[network] / [timeout] / [cancelled] 前缀分别归类", () => {
    expect(classifyNodeError(new Error("[network] 重放请求网络错误：x"))).toBe("network");
    expect(classifyNodeError(new Error("[timeout] 重放请求超时（上限 30s）"))).toBe("timeout");
    expect(classifyNodeError(new Error("[cancelled] 重放已被取消"))).toBe("cancelled");
    // 非 Error 值同样按 String() 前缀判定
    expect(classifyNodeError("[network] plain")).toBe("network");
  });
});

describe("classifyNodeError：取消防御与 unknown", () => {
  it("AbortError（原始未归一取消）→ cancelled", () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    expect(classifyNodeError(abort)).toBe("cancelled");
  });

  it("其余一律 unknown（普通 Error / 字符串 / undefined / null）", () => {
    expect(classifyNodeError(new Error("boom"))).toBe("unknown");
    expect(classifyNodeError("boom")).toBe("unknown");
    expect(classifyNodeError(undefined)).toBe("unknown");
    expect(classifyNodeError(null)).toBe("unknown");
    expect(classifyNodeError({ random: true })).toBe("unknown");
  });
});

describe("isHttpFailure", () => {
  it("status >= 400 → true（4xx / 5xx 均判失败）", () => {
    expect(isHttpFailure({ status: 400 })).toBe(true);
    expect(isHttpFailure({ status: 404, body: "x" })).toBe(true);
    expect(isHttpFailure({ status: 500 })).toBe(true);
  });

  it("status < 400 / 缺 status / 非 → false", () => {
    expect(isHttpFailure({ status: 200 })).toBe(false);
    expect(isHttpFailure({ status: 302 })).toBe(false);
    expect(isHttpFailure({ status: 399 })).toBe(false);
    expect(isHttpFailure({})).toBe(false);
    expect(isHttpFailure({ status: "404" })).toBe(false); // 非数字 status 不判失败
    expect(isHttpFailure(null)).toBe(false);
    expect(isHttpFailure(undefined)).toBe(false);
    expect(isHttpFailure("HTTP 404")).toBe(false); // 字符串不是响应对象
  });

  it("类型守卫：true 时收窄出 status 数字", () => {
    const output: unknown = { status: 418 };
    if (isHttpFailure(output)) {
      expect(output.status + 1).toBe(419);
    } else {
      throw new Error("should narrow");
    }
  });
});
