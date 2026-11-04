import { describe, expect, it } from "vitest";
import {
  buildFieldTree,
  countFieldNodes,
  filterFieldTree,
  flattenFieldTree,
  matchFieldPath,
  type IoFieldTreeNode,
} from "./io-field-tree";

/**
 * IO 字段树数据层测试（Task 15 薄片 B Step 3）：collectJsonPaths → 层级树
 * 构造、树内搜索过滤（段前缀 + 子串兜底、祖先链保留）、展开行扁平化、计数。
 */

/** 测试样本树形（collectJsonPaths 产出 6 条路径：body、body.token、
 * body.items、body.items.0、body.items.0.id、status） */
function createSampleTree(): IoFieldTreeNode[] {
  return buildFieldTree({
    body: { token: "x", items: [{ id: 1 }] },
    status: 200,
  });
}

describe("buildFieldTree", () => {
  it("点分路径构造层级树：段名 / 完整路径 / 深度 / 子序与样本键序一致", () => {
    const tree = createSampleTree();
    expect(tree.map((node) => node.name)).toEqual(["body", "status"]);
    const body = tree[0]!;
    expect(body.path).toBe("body");
    expect(body.depth).toBe(0);
    expect(body.children.map((child) => child.path)).toEqual(["body.token", "body.items"]);
    const items = body.children[1]!;
    expect(items.children[0]!.path).toBe("body.items.0");
    expect(items.children[0]!.depth).toBe(2);
    expect(items.children[0]!.children[0]!).toEqual({
      name: "id",
      path: "body.items.0.id",
      depth: 3,
      children: [],
    });
  });

  it("原始值根 / null：空树", () => {
    expect(buildFieldTree("text")).toEqual([]);
    expect(buildFieldTree(null)).toEqual([]);
  });

  it("沿用 collectJsonPaths 上限（深层样本按深度 6 截断）", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    const tree = buildFieldTree(deep);
    expect(countFieldNodes(tree)).toBe(6);
  });
});

describe("matchFieldPath", () => {
  it("空查询恒匹配；大小写不敏感", () => {
    expect(matchFieldPath("body.token", "")).toBe(true);
    expect(matchFieldPath("body.token", "  ")).toBe(true);
    expect(matchFieldPath("body.token", "TOKEN")).toBe(true);
  });

  it("段前缀口径（与提示浮层同源）：json.d 命中 json.data.token", () => {
    expect(matchFieldPath("json.data.token", "json.d")).toBe(true);
    expect(matchFieldPath("json.data.token", "json.x")).toBe(false);
  });

  it("子串兜底：中段片段（token）也能命中完整路径", () => {
    expect(matchFieldPath("json.data.token", "token")).toBe(true);
    expect(matchFieldPath("body.token", "ody")).toBe(true);
  });
});

describe("filterFieldTree", () => {
  it("空查询返回浅拷贝（内容一致、非同引用）", () => {
    const tree = createSampleTree();
    const filtered = filterFieldTree(tree, "");
    expect(filtered).toEqual(tree);
    expect(filtered).not.toBe(tree);
  });

  it("命中节点保留祖先链、剔除无兄弟分支", () => {
    const tree = createSampleTree();
    const filtered = filterFieldTree(tree, "token");
    expect(filtered.map((node) => node.path)).toEqual(["body"]);
    expect(filtered[0]!.children.map((node) => node.path)).toEqual(["body.token"]);
  });

  it("祖先自身命中保留整子树（子树外同层节点被剔除）", () => {
    const tree = createSampleTree();
    const filtered = filterFieldTree(tree, "body");
    expect(filtered.map((node) => node.path)).toEqual(["body"]);
    expect(countFieldNodes(filtered)).toBe(5);
    expect(countFieldNodes(tree)).toBe(6);
  });

  it("无命中返回空；原树不被修改", () => {
    const tree = createSampleTree();
    expect(filterFieldTree(tree, "zzz")).toEqual([]);
    expect(countFieldNodes(tree)).toBe(6);
  });
});

describe("flattenFieldTree", () => {
  it("收起时只输出顶层行（容器行仍输出、expanded 为 false）", () => {
    const rows = flattenFieldTree(createSampleTree(), () => false);
    expect(rows.map((row) => row.path)).toEqual(["body", "status"]);
    expect(rows[0]).toMatchObject({ hasChildren: true, expanded: false, depth: 0 });
    expect(rows[1]).toMatchObject({ hasChildren: false, expanded: false });
  });

  it("顶层默认展开的行清单：子行紧随父行（先序），深层容器保持收起", () => {
    const rows = flattenFieldTree(createSampleTree(), (node) => node.depth === 0);
    expect(rows.map((row) => row.path)).toEqual([
      "body",
      "body.token",
      "body.items",
      "status",
    ]);
    expect(rows[0]!.expanded).toBe(true);
    expect(rows[2]!.expanded).toBe(false);
  });

  it("全部展开输出全量行", () => {
    const rows = flattenFieldTree(createSampleTree(), () => true);
    expect(rows.map((row) => row.path)).toEqual([
      "body",
      "body.token",
      "body.items",
      "body.items.0",
      "body.items.0.id",
      "status",
    ]);
  });

  it("配合过滤树扁平化：命中的深层字段随祖先链直接可见", () => {
    const filtered = filterFieldTree(createSampleTree(), "token");
    const rows = flattenFieldTree(filtered, () => true);
    expect(rows.map((row) => row.path)).toEqual(["body", "body.token"]);
  });
});

describe("countFieldNodes", () => {
  it("统计含容器节点的全部字段数", () => {
    expect(countFieldNodes(createSampleTree())).toBe(6);
    expect(countFieldNodes([])).toBe(0);
  });
});
