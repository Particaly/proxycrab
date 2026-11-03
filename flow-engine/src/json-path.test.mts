import { describe, expect, it } from "vitest";
import { evaluateJsonPath, parseJsonPath } from "./json-path";

/**
 * JSONPath 子集单测（M10-T3）：解析（含语法错误逐类）、求值（属性链 / 下标 /
 * 通配符 / 递归下降 / 类型不匹配 = 无匹配）、集合语义与边界。
 */

/** 测试样例数据（形状覆盖对象嵌套 / 数组 / null / 标量根 / 中文键） */
const sample = {
  status: 200,
  body: {
    token: "abc",
    items: [
      { id: 1, name: "a" },
      { id: 2, name: "b", extra: null },
    ],
    meta: { page: 1, tags: ["x", "y"] },
  },
  "带空格 键": "quoted",
  empty: null,
};

describe("parseJsonPath（解析与语法错误）", () => {
  it("常见合法路径解析通过（点分 / 引号 / 下标 / 通配符 / 递归下降）", () => {
    expect(parseJsonPath("$").ok).toBe(true);
    expect(parseJsonPath("$.a").ok).toBe(true);
    expect(parseJsonPath("$.a.b.c").ok).toBe(true);
    expect(parseJsonPath("$['a b']").ok).toBe(true);
    expect(parseJsonPath('$["a.b"]').ok).toBe(true);
    expect(parseJsonPath("$[0]").ok).toBe(true);
    expect(parseJsonPath("$[10]").ok).toBe(true);
    expect(parseJsonPath("$[*]").ok).toBe(true);
    expect(parseJsonPath("$.*").ok).toBe(true);
    expect(parseJsonPath("$..id").ok).toBe(true);
    expect(parseJsonPath("$.body.items[0].name").ok).toBe(true);
  });

  it("语法错误逐类：缺根标识 / 空属性 / 不支持字符 / 未闭合括号 / 负下标 / ..* ", () => {
    expect(parseJsonPath("").ok).toBe(false);
    expect(parseJsonPath("a.b").ok).toBe(false);
    expect(parseJsonPath("$.").ok).toBe(false);
    expect(parseJsonPath("$..").ok).toBe(false);
    expect(parseJsonPath("$.a b").ok).toBe(false);
    const spacedError = parseJsonPath("$.a b");
    expect(spacedError.ok).toBe(false);
    if (!spacedError.ok) expect(spacedError.error).toContain("语法错误");
    expect(parseJsonPath("$[a]").ok).toBe(false);
    expect(parseJsonPath("$[1:3]").ok).toBe(false);
    expect(parseJsonPath("$[0,1]").ok).toBe(false);
    expect(parseJsonPath("$[-1]").ok).toBe(false);
    expect(parseJsonPath("$..*").ok).toBe(false);
    expect(parseJsonPath("$.a[").ok).toBe(false);
    // 错误信息回显原路径，便于定位配置
    if (!spacedError.ok) expect(spacedError.error).toContain("$.a b");
  });

  it("错误信息为中文且可展示（断言失败信息直接复用）", () => {
    const result = parseJsonPath("$[?(@.x)]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/不支持/);
  });
});

describe("evaluateJsonPath（求值）", () => {
  it("点分属性链取嵌套值", () => {
    expect(evaluateJsonPath("$.status", sample)).toEqual({ ok: true, values: [200] });
    expect(evaluateJsonPath("$.body.token", sample)).toEqual({ ok: true, values: ["abc"] });
    expect(evaluateJsonPath("$.body.meta.page", sample)).toEqual({ ok: true, values: [1] });
  });

  it("$ 根返回根值本身；不存在的属性 = 空匹配集合", () => {
    expect(evaluateJsonPath("$", sample)).toEqual({ ok: true, values: [sample] });
    expect(evaluateJsonPath("$.missing", sample)).toEqual({ ok: true, values: [] });
    expect(evaluateJsonPath("$.body.missing.deep", sample)).toEqual({ ok: true, values: [] });
  });

  it("数组下标：命中 / 越界无匹配 / 非数组上取下标无匹配", () => {
    expect(evaluateJsonPath("$.body.items[0].id", sample)).toEqual({ ok: true, values: [1] });
    expect(evaluateJsonPath("$.body.items[1].name", sample)).toEqual({ ok: true, values: ["b"] });
    expect(evaluateJsonPath("$.body.items[5]", sample)).toEqual({ ok: true, values: [] });
    expect(evaluateJsonPath("$.status[0]", sample)).toEqual({ ok: true, values: [] });
  });

  it("值为 null 与「路径不存在」可区分：null 是匹配集合中的一个元素", () => {
    expect(evaluateJsonPath("$.empty", sample)).toEqual({ ok: true, values: [null] });
    expect(evaluateJsonPath("$.body.items[1].extra", sample)).toEqual({ ok: true, values: [null] });
  });

  it("通配符 [*] / .*：对象取全部子值、数组取全部元素、标量无匹配", () => {
    expect(evaluateJsonPath("$.body.items[*].id", sample)).toEqual({ ok: true, values: [1, 2] });
    expect(evaluateJsonPath("$.body.meta.tags[*]", sample)).toEqual({
      ok: true,
      values: ["x", "y"],
    });
    expect(evaluateJsonPath("$.body.meta.*", sample)).toEqual({
      ok: true,
      values: [1, ["x", "y"]],
    });
    expect(evaluateJsonPath("$.status.*", sample)).toEqual({ ok: true, values: [] });
  });

  it("递归下降 $..name：任意深度全部同名属性值（含数组内）", () => {
    expect(evaluateJsonPath("$..id", sample)).toEqual({ ok: true, values: [1, 2] });
    expect(evaluateJsonPath("$..token", sample)).toEqual({ ok: true, values: ["abc"] });
    // 深度优先：外层先于内层
    const nested = { a: { x: 1 }, b: [{ x: 2 }, { c: { x: 3 } }] };
    expect(evaluateJsonPath("$..x", nested)).toEqual({ ok: true, values: [1, 2, 3] });
    // 递归下降不存在的名字 = 空集合
    expect(evaluateJsonPath("$..nope", sample)).toEqual({ ok: true, values: [] });
  });

  it("引号属性：键名含空格 / 点号等特殊字符", () => {
    expect(evaluateJsonPath("$['带空格 键']", sample)).toEqual({ ok: true, values: ["quoted"] });
    expect(evaluateJsonPath('$["带空格 键"]', sample)).toEqual({ ok: true, values: ["quoted"] });
  });

  it("标量根与 null 根：继续下钻均无匹配，不报错", () => {
    expect(evaluateJsonPath("$.a", 42)).toEqual({ ok: true, values: [] });
    expect(evaluateJsonPath("$.a", null)).toEqual({ ok: true, values: [] });
    expect(evaluateJsonPath("$[0]", "text")).toEqual({ ok: true, values: [] });
  });

  it("语法错误原样透出（ok=false 与 error 文本）", () => {
    const result = evaluateJsonPath("body.token", sample);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("$");
  });

  it("数组根：下标与通配符照常工作（断言输入可能是数组）", () => {
    const arrayRoot = [{ id: 1 }, { id: 2 }];
    expect(evaluateJsonPath("$[1].id", arrayRoot)).toEqual({ ok: true, values: [2] });
    expect(evaluateJsonPath("$[*].id", arrayRoot)).toEqual({ ok: true, values: [1, 2] });
  });
});
