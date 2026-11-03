import { describe, expect, it } from "vitest";
import { jsonDeepEqual } from "./json-equal";

/**
 * JSON 深度相等单测（原 M10-T3 的 json-diff 单测收窄，M18-T1）：断言节点
 * （eq / ne / contains）与 Schema enum 共用的相等语义——标量严格、NaN 不等、
 * 对象按键集合与值、数组按位。
 */

describe("jsonDeepEqual（统一相等语义）", () => {
  it("标量：严格相等；NaN 不相等；类型不同不等", () => {
    expect(jsonDeepEqual(1, 1)).toBe(true);
    expect(jsonDeepEqual("a", "a")).toBe(true);
    expect(jsonDeepEqual(null, null)).toBe(true);
    expect(jsonDeepEqual(1, "1")).toBe(false);
    expect(jsonDeepEqual(0, false)).toBe(false);
    expect(jsonDeepEqual(NaN, NaN)).toBe(false);
    expect(jsonDeepEqual(null, undefined)).toBe(false);
  });

  it("对象：按键集合与各键值；键序无关；缺键不等", () => {
    expect(jsonDeepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonDeepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(jsonDeepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonDeepEqual({ a: { b: [1, { c: "x" }] } }, { a: { b: [1, { c: "x" }] } })).toBe(true);
  });

  it("数组：按位与长度；嵌套结构递归", () => {
    expect(jsonDeepEqual([1, [2, { x: 3 }]], [1, [2, { x: 3 }]])).toBe(true);
    expect(jsonDeepEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonDeepEqual([1], [1, 2])).toBe(false);
  });
});
