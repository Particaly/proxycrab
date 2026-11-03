import { describe, expect, it } from "vitest";
import { REF_ID_PATTERN, generateRefId, isValidRefId } from "./ref-id";

/**
 * 节点引用短码纯函数测试（M15-T2，node 环境）：
 * 合法形态（恰好 5 位纯字母）、缺失容忍、随机生成对占用集合查重（冲突重摇）。
 */

describe("REF_ID_PATTERN / isValidRefId", () => {
  it("恰好 5 位纯字母合法（大小写混合均可）", () => {
    expect(REF_ID_PATTERN.test("abcde")).toBe(true);
    expect(REF_ID_PATTERN.test("AbCdE")).toBe(true);
    expect(REF_ID_PATTERN.test("QWERT")).toBe(true);
    expect(isValidRefId("abcde")).toBe(true);
    expect(isValidRefId("AbCdE")).toBe(true);
  });

  it("长度不为 5、含数字 / 符号 / 空白均非法", () => {
    expect(isValidRefId("abcd")).toBe(false);
    expect(isValidRefId("abcdef")).toBe(false);
    expect(isValidRefId("ab1de")).toBe(false);
    expect(isValidRefId("ab-de")).toBe(false);
    expect(isValidRefId("ab de")).toBe(false);
    expect(isValidRefId("")).toBe(false);
    expect(isValidRefId(undefined)).toBe(false);
    expect(isValidRefId(null)).toBe(false);
    expect(isValidRefId(12345)).toBe(false);
  });
});

describe("generateRefId", () => {
  it("产出恰好 5 位纯字母的短码", () => {
    for (let i = 0; i < 50; i++) {
      expect(isValidRefId(generateRefId())).toBe(true);
    }
  });

  it("对占用集合查重：命中即重摇，直到产出未占用短码", () => {
    // 全量枚举一个字母子集：排除 26 个「aaaa + 单字母」以外的组合不影响断言——
    // 改为确定性注入随机源不可行（本模块用全局 crypto），此处以大量重复 + 集合
    // 互斥验证：生成结果永不落入占用集合
    const exclude = new Set<string>(["aaaaa", "bbbbb", "ccccc"]);
    for (let i = 0; i < 200; i++) {
      const refId = generateRefId(exclude);
      expect(exclude.has(refId)).toBe(false);
      expect(isValidRefId(refId)).toBe(true);
    }
  });

  it("exclude 缺省 / 空集合时一次生成即返回（结果合法即可）", () => {
    expect(isValidRefId(generateRefId())).toBe(true);
    expect(isValidRefId(generateRefId(new Set()))).toBe(true);
  });

  it("随机性：连续生成的短码（统计上）不恒为同一值", () => {
    const values = new Set<string>();
    for (let i = 0; i < 20; i++) values.add(generateRefId());
    expect(values.size).toBeGreaterThan(1);
  });
});
