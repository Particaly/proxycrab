import { describe, expect, it } from "vitest";
import { collectJsonPaths } from "./input-paths";

/**
 * 入参 / 出参字段路径收集测试（Task 15 薄片 A；自归档同名测试 @ 485fa00 移植）：
 * 点分路径（与 flow-engine resolvePath 语义一致）、数组采样上限、深度 / 数量
 * 截断、含点键跳过。
 */

describe("collectJsonPaths", () => {
  it("对象逐层展开（容器与叶子都产出路径）", () => {
    expect(collectJsonPaths({ body: { token: "x", items: [] }, status: 200 })).toEqual([
      "body",
      "body.token",
      "body.items",
      "status",
    ]);
  });

  it("数组按下标展开且只采样前几个元素", () => {
    const value = { items: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] };
    const paths = collectJsonPaths(value);
    expect(paths).toContain("items.0");
    expect(paths).toContain("items.0.id");
    expect(paths).toContain("items.2.id");
    expect(paths).not.toContain("items.3");
  });

  it("根为数组：路径从下标 0 开始", () => {
    expect(collectJsonPaths([{ a: 1 }])).toEqual(["0", "0.a"]);
  });

  it("含点键与空键跳过（点分路径无法表达）", () => {
    expect(collectJsonPaths({ "a.b": 1, "": 2, ok: 3 })).toEqual(["ok"]);
  });

  it("深度与数量上限截断", () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    expect(collectJsonPaths(deep, { maxDepth: 2 })).toEqual(["a", "a.b"]);
    const wide = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    expect(collectJsonPaths(wide, { maxPaths: 3 })).toEqual(["k0", "k1", "k2"]);
  });

  it("原始值 / null 根：无可下钻字段", () => {
    expect(collectJsonPaths("text")).toEqual([]);
    expect(collectJsonPaths(null)).toEqual([]);
    expect(collectJsonPaths(undefined)).toEqual([]);
  });
});
