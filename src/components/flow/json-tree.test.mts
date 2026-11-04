import { describe, expect, test } from "vitest";
import {
  buildJsonTree,
  defaultExpanded,
  filterTree,
  isScalarKind,
  isTruncatedSnapshot,
  stringifyNodeValue,
} from "./json-tree";

/** 造一个截断快照包装。 */
function truncatedWrapper(preview: string, originalBytes: number): unknown {
  return { __truncated: true, preview, originalBytes };
}

describe("截断快照识别（披露判定契约）", () => {
  test("字段齐全才认定；preview / originalBytes 类型不符或标记缺失不误伤", () => {
    expect(isTruncatedSnapshot(truncatedWrapper("{...", 4096))).toBe(true);
    expect(isTruncatedSnapshot({ __truncated: true, preview: "x", originalBytes: "12" })).toBe(
      false,
    );
    expect(isTruncatedSnapshot({ __truncated: true, preview: 1, originalBytes: 12 })).toBe(false);
    expect(isTruncatedSnapshot({ preview: "x", originalBytes: 12 })).toBe(false);
    expect(isTruncatedSnapshot({ __truncated: false, preview: "x", originalBytes: 12 })).toBe(
      false,
    );
    expect(isTruncatedSnapshot(null)).toBe(false);
    expect(isTruncatedSnapshot("{ __truncated... }")).toBe(false);
    // 恰好同形的普通对象（字段名相同但语义不同）不会被误伤——契约由三个字段同时成立构成
    expect(isTruncatedSnapshot({ __truncated: true, preview: "x", originalBytes: 0 })).toBe(true);
  });

  test("截断包装建成 kind 'truncated' 节点：携带 originalBytes / preview，不再展开内部字段", () => {
    const node = buildJsonTree(truncatedWrapper('{"a":1,', 4096));
    expect(node.kind).toBe("truncated");
    expect(node.truncated).toEqual({ __truncated: true, preview: '{"a":1,', originalBytes: 4096 });
    expect(node.children).toEqual([]);
    expect(node.totalCount).toBe(1);
  });
});

describe("buildJsonTree", () => {
  test("标量与容器分类、undefined 按 null 处理", () => {
    expect(buildJsonTree("text")).toMatchObject({ kind: "string", value: "text" });
    expect(buildJsonTree(42)).toMatchObject({ kind: "number", value: 42 });
    expect(buildJsonTree(true)).toMatchObject({ kind: "boolean", value: true });
    expect(buildJsonTree(null)).toMatchObject({ kind: "null", value: null });
    expect(buildJsonTree(undefined)).toMatchObject({ kind: "null" });
    const objectNode = buildJsonTree({ a: 1 });
    expect(objectNode.kind).toBe("object");
    expect(objectNode.childCount).toBe(1);
    const arrayNode = buildJsonTree([1, 2]);
    expect(arrayNode.kind).toBe("array");
    expect(arrayNode.childCount).toBe(2);
    expect(arrayNode.children[0]).toMatchObject({ key: "0", path: "[0]" });
  });

  test("路径拼接：对象点号、数组下标；计数含自身", () => {
    const root = buildJsonTree({ list: [{ v: 1 }] });
    const list = root.children[0]!;
    expect(list.path).toBe("list");
    const item = list.children[0]!;
    expect(item.path).toBe("list[0]");
    expect(item.children[0]!.path).toBe("list[0].v");
    expect(root.totalCount).toBe(4);
  });
});

describe("默认展开判定", () => {
  test("前 2 层展开；子节点 > 200 或深度 > 6 一律折叠", () => {
    expect(defaultExpanded(0, 50)).toBe(true);
    expect(defaultExpanded(1, 200)).toBe(true);
    expect(defaultExpanded(1, 201)).toBe(false);
    expect(defaultExpanded(2, 1)).toBe(false);
    expect(defaultExpanded(7, 1)).toBe(false);
  });
});

describe("filterTree 搜索语义", () => {
  const root = buildJsonTree({
    host: "example.com",
    port: 8080,
    nested: { secret: "token-xyz", keep: 1 },
  });

  test("空查询原样返回整棵树（非搜索态）", () => {
    const result = filterTree(root, "  ");
    expect(result.tree).toBe(root);
    expect(result.matchCount).toBe(0);
    expect(result.autoExpandPaths.size).toBe(0);
  });

  test("键名命中保留完整子树；祖先链收敛并产出自动展开集合", () => {
    const result = filterTree(root, "secret");
    expect(result.matchCount).toBe(1);
    const nested = result.tree?.children.find((child) => child.key === "nested");
    expect(nested).toBeDefined();
    expect(nested?.children.map((child) => child.key)).toEqual(["secret"]);
    expect(result.autoExpandPaths.has("nested")).toBe(true);
  });

  test("标量值 / 截断 preview 大小写不敏感命中；无命中返回 null 树", () => {
    expect(filterTree(root, "EXAMPLE").matchCount).toBe(1);
    const wrapperNode = buildJsonTree({ payload: truncatedWrapper("binary-data", 9) });
    expect(filterTree(wrapperNode, "BINARY").matchCount).toBe(1);
    expect(filterTree(root, "no-such-key")).toMatchObject({ tree: null, matchCount: 0 });
  });
});

describe("stringifyNodeValue", () => {
  test("字符串取原文、标量 String、容器 pretty JSON、截断包装取 preview", () => {
    expect(stringifyNodeValue(buildJsonTree("raw-text"))).toBe("raw-text");
    expect(stringifyNodeValue(buildJsonTree(7))).toBe("7");
    expect(stringifyNodeValue(buildJsonTree(null))).toBe("null");
    expect(stringifyNodeValue(buildJsonTree({ b: 1, a: [1] }))).toBe(
      JSON.stringify({ b: 1, a: [1] }, null, 2),
    );
    expect(stringifyNodeValue(buildJsonTree(truncatedWrapper("preview-text", 99)))).toBe(
      "preview-text",
    );
  });

  test("isScalarKind 与分类一致", () => {
    expect(isScalarKind("string")).toBe(true);
    expect(isScalarKind("truncated")).toBe(false);
    expect(isScalarKind("object")).toBe(false);
  });
});
