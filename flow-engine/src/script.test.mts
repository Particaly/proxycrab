import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCRIPT_TIMEOUT_MS,
  PRE_OVERRIDE_KEYS,
  compileScript,
  runPostScript,
  runPreScript,
  sanitizeJson,
  type PostProcessResponse,
} from "./script";

/**
 * M5-T3 脚本处理执行引擎测试：
 * compileScript 编译（语法错误归一化 / 正常编译与沙箱形参注入）、runPreScript
 * （覆盖对象提取 / 非对象降级策略 / 未知键警告 / 运行时错误归类）、runPostScript
 * （缺省 output=response.body / 任意 JSON 返回 / __proto__ 污染净化）、软超时
 * （耗时脚本 + timeoutMs=0/极小）、__checkDeadline() 配合中断、sanitizeJson
 * （污染键剔除 / 循环引用 / 共享引用 / 幂等）与错误 message 可读性。
 */

/** 构造标准 post 入参响应（各用例按需覆写字段） */
function makeResponse(overrides?: Partial<PostProcessResponse>): PostProcessResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { token: "abc", userId: 7 },
    durationMs: 123,
    ...overrides,
  };
}

describe("compileScript", () => {
  it("正常脚本编译成功，fn 按数据形参（pre 为 input）执行", () => {
    const compiled = compileScript('return input + "!"');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.fn("hi", { deadline: Date.now() + 1000, checkDeadline: () => {} })).toBe("hi!");
  });

  it("post 模式编译的脚本形参名为 response", () => {
    const compiled = compileScript("return response.status", "post");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(
      compiled.fn(makeResponse(), { deadline: Date.now() + 1000, checkDeadline: () => {} }),
    ).toBe(200);
  });

  it("语法错误 → ok:false 且归类 syntax，message 带类别标签", () => {
    const result = compileScript("return {{{");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("syntax");
    expect(result.error.message).toContain("前置处理脚本语法错误");
  });

  it("沙箱形参不可被脚本重声明（严格模式）→ 编译期报 syntax", () => {
    for (const source of [
      "let __checkDeadline; return 1",
      "let __deadline; return 1",
      "let input; return 1",
    ]) {
      const result = compileScript(source);
      expect(result.ok, source).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("syntax");
    }
  });
});

describe("runPreScript", () => {
  it("返回覆盖对象 → 只保留已知键，未知键剔除并记 warning", () => {
    const result = runPreScript(
      'return { url: "https://x", headers: { a: "b" }, body: "c", timeoutMs: 9, foo: 1, bar: 2 }',
      { node: {} },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      url: "https://x",
      headers: { a: "b" },
      body: "c",
      timeoutMs: 9,
    });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join("\n")).toContain("foo");
    expect(result.warnings.join("\n")).toContain("bar");
  });

  it("未 return（undefined）与 null → 合法的「不修改请求」，无警告", () => {
    for (const source of ["", "const x = 1", "return undefined", "return null"]) {
      const result = runPreScript(source, {});
      expect(result.ok, source).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({});
        expect(result.warnings).toEqual([]);
      }
    }
  });

  it("返回其他非对象（数字 / 字符串 / 数组）→ 丢弃 + warning（文档化降级策略）", () => {
    for (const source of ["return 42", 'return "nope"', "return [1, 2]"]) {
      const result = runPreScript(source, {});
      expect(result.ok, source).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({});
        expect(result.warnings.join("\n")).toContain("不是对象");
      }
    }
  });

  it("未定义变量 ReferenceError → 归类 runtime，message 含可读上下文", () => {
    const result = runPreScript("return { url: someUndefinedVar }", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("runtime");
    expect(result.error.message).toContain("前置处理脚本运行时错误");
    expect(result.error.message).toContain("someUndefinedVar is not defined");
  });

  it("null/undefined 属性访问 TypeError → 归类 runtime", () => {
    const result = runPreScript("return { url: input.missing.deep }", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("runtime");
    expect(result.error.message).toContain("Cannot read properties of undefined");
  });

  it("入参先经 sanitize：input 中的 __proto__ own property 被剔除", () => {
    const pollutedInput = JSON.parse('{"__proto__": {"polluted": true}, "keep": "yes"}') as Record<
      string,
      unknown
    >;
    const result = runPreScript("return { url: input.keep }", pollutedInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ url: "yes" });
    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain("polluted");
  });

  it("返回值含原型污染键 → sanitize 剔除后再做形状校验", () => {
    const result = runPreScript(
      'return JSON.parse(\'{"__proto__": {"p": 1}, "url": "https://x"}\')',
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ url: "https://x" });
  });

  it("返回循环引用 → 归类 invalid-return", () => {
    const result = runPreScript("const a = {}; a.self = a; return a", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid-return");
    expect(result.error.message).toContain("循环引用");
  });

  it("脚本可读取沙箱常量 __deadline 与 __checkDeadline（形参注入，非全局）", () => {
    const result = runPreScript(
      'return { headers: { isFn: String(typeof __checkDeadline === "function"), isNum: String(typeof __deadline === "number") } }',
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.headers).toEqual({ isFn: "true", isNum: "true" });
  });
});

describe("runPostScript", () => {
  it("脚本未返回 → 默认 output = response.body", () => {
    for (const source of ["", "const x = response.status", "return undefined"]) {
      const result = runPostScript(source, makeResponse());
      expect(result.ok, source).toBe(true);
      if (result.ok) expect(result.value).toEqual({ token: "abc", userId: 7 });
    }
  });

  it("显式 return null → output 为 null（不触发 body 默认值）", () => {
    const result = runPostScript("return null", makeResponse());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it("返回任意 JSON（提取 / 变换 response 字段）", () => {
    const result = runPostScript(
      "return { token: response.body.token, ok: response.status < 400, ms: response.durationMs }",
      makeResponse(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ token: "abc", ok: true, ms: 123 });
  });

  it("返回含 __proto__ 污染 own property 的对象 → sanitize 剔除且原型未被污染", () => {
    const result = runPostScript(
      'return JSON.parse(\'{"__proto__": {"polluted": true}, "token": "t"}\')',
      makeResponse(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.getOwnPropertyNames(result.value as object)).toEqual(["token"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain("polluted");
  });

  it("对象字面量的 constructor / prototype 污染键同样被剔除", () => {
    const result = runPostScript(
      'return { constructor: 1, prototype: 2, ["__proto__"]: 3, keep: true }',
      makeResponse(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ keep: true });
  });

  it("返回函数 / 循环引用 → 归类 invalid-return", () => {
    const fnResult = runPostScript("return function evil() {}", makeResponse());
    expect(fnResult.ok).toBe(false);
    if (!fnResult.ok) {
      expect(fnResult.error.kind).toBe("invalid-return");
      expect(fnResult.error.message).toContain("function");
    }

    const circularResult = runPostScript("const a = {}; a.self = a; return a", makeResponse());
    expect(circularResult.ok).toBe(false);
    if (!circularResult.ok) {
      expect(circularResult.error.kind).toBe("invalid-return");
      expect(circularResult.error.message).toContain("循环引用");
    }
  });

  it("response 中的深层坏数据（循环引用）→ 进入脚本前即报 runtime", () => {
    const circularBody: Record<string, unknown> = { hello: "world" };
    circularBody.self = circularBody;
    const result = runPostScript("return response.body", makeResponse({ body: circularBody }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("runtime");
    expect(result.error.message).toContain("循环引用");
  });

  it("未定义变量 ReferenceError → 归类 runtime，message 带后置脚本标签", () => {
    const result = runPostScript("return missingVar", makeResponse());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("runtime");
    expect(result.error.message).toContain("后置处理脚本运行时错误");
    expect(result.error.message).toContain("missingVar is not defined");
  });
});

describe("软超时与 __checkDeadline 配合中断", () => {
  /** 空转循环（可终止）：约 300 万次累加，任何机器上都 > 1ms */
  const BUSY_LOOP = "let s = 0; for (let i = 0; i < 3e6; i++) { s += i } return s";

  it("耗时脚本 + timeoutMs=0 → 跑完后改判 timeout（软超时）", () => {
    const result = runPreScript(BUSY_LOOP, {}, { timeoutMs: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("timeout");
    expect(result.error.message).toContain("软超时");
    expect(result.error.message).toContain("副作用无法回滚");
  });

  it("耗时脚本 + 极小 timeoutMs=1 → 同样判 timeout", () => {
    const result = runPostScript(BUSY_LOOP, makeResponse(), { timeoutMs: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("timeout");
  });

  it("宽松超时下同一脚本正常完成（不误判）", () => {
    const result = runPostScript("return 1 + 1", makeResponse(), {
      timeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(2);
  });

  it("死循环 + __checkDeadline() 主动配合 → 真正中断并归类 timeout", () => {
    const result = runPostScript(
      "let i = 0; while (true) { i++; if (i > 0) __checkDeadline(); }",
      makeResponse(),
      { timeoutMs: 0 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("timeout");
    expect(result.error.message).toContain("__checkDeadline");
  });

  it("未超截止时间时 __checkDeadline() 不抛出，脚本正常完成", () => {
    const result = runPreScript(
      "let i = 0; while (i < 1000) { i++; __checkDeadline() } return { timeoutMs: 9 }",
      {},
      { timeoutMs: 5000 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ timeoutMs: 9 });
  });

  it("脚本自行 throw 普通错误不冒充 timeout（仅哨兵按 timeout 归类）", () => {
    const result = runPreScript('if (true) { throw new Error("boom") }', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("runtime");
    expect(result.error.message).toContain("boom");
  });
});

describe("sanitizeJson（原型链防护）", () => {
  it("嵌套结构中的污染键递归剔除", () => {
    const input = JSON.parse(
      '{"ok": 1, "nested": {"__proto__": {}, "constructor": {}, "prototype": {}, "deep": {"__proto__": [1]}}}',
    );
    const result = sanitizeJson(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ ok: 1, nested: { deep: {} } });
  });

  it("undefined 处理对齐 JSON 语义：对象属性丢弃、数组槽位置 null", () => {
    const result = sanitizeJson({ a: undefined, b: [1, undefined, 2], c: null });
    expect(result).toEqual({ ok: true, value: { b: [1, null, 2], c: null } });
  });

  it("非 JSON 值（Date / Map / bigint / symbol / function）→ 失败并说明原因", () => {
    for (const [value, fragment] of [
      [new Date(), "Date"],
      [new Map(), "Map"],
      [10n, "bigint"],
      [Symbol("x"), "symbol"],
      [(): void => {}, "function"],
    ] as const) {
      const result = sanitizeJson(value);
      expect(result.ok, String(fragment)).toBe(false);
      if (!result.ok) expect(result.reason).toContain(fragment);
    }
  });

  it("共享引用（DAG，非循环）合法，不误报循环引用", () => {
    const shared = { v: 1 };
    const result = sanitizeJson({ a: shared, b: shared, list: [shared, shared] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ a: { v: 1 }, b: { v: 1 }, list: [{ v: 1 }, { v: 1 }] });
  });

  it("getter 抛错 → 归为净化失败而非向外抛异常", () => {
    const evil = {
      get bad(): never {
        throw new Error("boom");
      },
    };
    const result = sanitizeJson(evil);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("boom");
  });

  it("大返回值 sanitize 幂等：sanitize(sanitize(x)) 深等于 sanitize(x)", () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) {
      big[`k${i}`] = {
        index: i,
        tags: ["a", "b", i % 3 === 0 ? null : i],
        nested: { deep: { value: `v${i}`, flag: i % 2 === 0 } },
      };
    }
    const viaScript = runPostScript(`return ${JSON.stringify(big)}`, makeResponse());
    expect(viaScript.ok).toBe(true);
    if (!viaScript.ok) return;

    const once = sanitizeJson(viaScript.value);
    expect(once.ok).toBe(true);
    const twice = sanitizeJson(once.ok ? once.value : undefined);
    expect(twice).toEqual(once);
    expect(once.ok && once.value).toEqual(big);
  });

  it("PRE_OVERRIDE_KEYS 与 script-doc 约定的覆盖键一致", () => {
    expect([...PRE_OVERRIDE_KEYS]).toEqual(["url", "headers", "body", "timeoutMs"]);
  });
});
