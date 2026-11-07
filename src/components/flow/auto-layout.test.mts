import { describe, expect, it } from "vitest";
import type { WorkflowEdge, WorkflowNode } from "../../api/types";
import {
  AUTO_LAYOUT_BAND_COLUMNS,
  AUTO_LAYOUT_BAND_GAP,
  AUTO_LAYOUT_COLUMN_GAP,
  AUTO_LAYOUT_ROW_GAP,
  autoLayout,
} from "./auto-layout";
import { FLOW_NODE_SIZE } from "./graph-model";

/**
 * 自动布局纯函数测试（断言基线参照归档 auto-layout.test.ts）：
 * 最长路径分层正确性（链 / 多根 / 菱形）、同层垂直均布、层间距恒定、
 * 环不死循环且结果确定、孤立节点归首层、悬空边 / 自环容错、坐标确定性、
 * 蛇形折行（长串行链不拉成一条超宽直线，带尾折行边竖直）。
 */

/** 列 x 坐标：列号 * (节点宽 + 层间距) */
const columnX = (column: number): number =>
  column * (FLOW_NODE_SIZE.width + AUTO_LAYOUT_COLUMN_GAP);
/** 行 y 坐标：行号 * (节点高 + 行距) */
const rowY = (row: number): number => row * (FLOW_NODE_SIZE.height + AUTO_LAYOUT_ROW_GAP);
/**
 * 蛇形带 y 坐标（单行带口径）：带号 * (节点高 + 带间距)；多行带的带顶
 * 由实现按最高列实占高度累加，测试里直接写显式期望值。
 */
const bandY = (band: number): number => band * (FLOW_NODE_SIZE.height + AUTO_LAYOUT_BAND_GAP);

/** 串行链用例构造：ids 顺序连线（相邻两两相连）。 */
function makeChain(ids: string[]): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: ids.map(makeNode),
    edges: ids.slice(0, -1).map((id, index) => makeEdge(`e${index}`, id, ids[index + 1])),
  };
}

function makeNode(id: string): WorkflowNode {
  return { id, type: "httpReplay", position: { x: 999, y: 999 }, config: {} };
}

function makeEdge(id: string, source: string, target: string): WorkflowEdge {
  return { id, source, target };
}

describe("autoLayout: 分层", () => {
  it("线性链 a→b→c：逐层排列（列 x 恒定步进，行 y 为 0）", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const edges = [makeEdge("e1", "a", "b"), makeEdge("e2", "b", "c")];
    const result = autoLayout(nodes, edges);

    expect(result.a).toEqual({ x: columnX(0), y: rowY(0) });
    expect(result.b).toEqual({ x: columnX(1), y: rowY(0) });
    expect(result.c).toEqual({ x: columnX(2), y: rowY(0) });
  });

  it("无依赖节点归首层：两个根并排在第 0 列垂直均布", () => {
    const nodes = [makeNode("root1"), makeNode("root2"), makeNode("child")];
    const edges = [makeEdge("e1", "root1", "child"), makeEdge("e2", "root2", "child")];
    const result = autoLayout(nodes, edges);

    expect(result.root1).toEqual({ x: columnX(0), y: rowY(0) });
    expect(result.root2).toEqual({ x: columnX(0), y: rowY(1) });
    expect(result.child).toEqual({ x: columnX(1), y: rowY(0) });
  });

  it("菱形取最长路径：d 分层为 2（a→b→d 与 a→c→d 取较大）", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c"), makeNode("d")];
    const edges = [
      makeEdge("e1", "a", "b"),
      makeEdge("e2", "a", "c"),
      makeEdge("e3", "b", "d"),
      makeEdge("e4", "c", "d"),
    ];
    const result = autoLayout(nodes, edges);

    expect(result.a?.x).toBe(columnX(0));
    expect(result.b?.x).toBe(columnX(1));
    expect(result.c?.x).toBe(columnX(1));
    expect(result.d?.x).toBe(columnX(2));
  });

  it("孤立节点（无任何连线）归首层", () => {
    const result = autoLayout([makeNode("alone")], []);
    expect(result.alone).toEqual({ x: columnX(0), y: rowY(0) });
  });
});

describe("autoLayout: 环与容错", () => {
  it("双节点环不死循环：必然返回且全部节点得到有限坐标", () => {
    const nodes = [makeNode("a"), makeNode("b")];
    const edges = [makeEdge("e1", "a", "b"), makeEdge("e2", "b", "a")];
    const result = autoLayout(nodes, edges);

    for (const id of ["a", "b"]) {
      const position = result[id];
      expect(position).toBeDefined();
      expect(Number.isFinite(position?.x)).toBe(true);
      expect(Number.isFinite(position?.y)).toBe(true);
    }
  });

  it("环 + 下游节点：下游也得到坐标（环兜底后继续分层）", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const edges = [makeEdge("e1", "a", "b"), makeEdge("e2", "b", "a"), makeEdge("e3", "b", "c")];
    const result = autoLayout(nodes, edges);

    expect(result.c).toBeDefined();
    // 环兜底把 a 强制入首层后 b 顺延，c 在 b 之后
    expect(result.a?.x).toBe(columnX(0));
    expect(result.b?.x).toBe(columnX(1));
    expect(result.c?.x).toBe(columnX(2));
  });

  it("三节点环不挂起（BFS 排空后按数组顺序强制分层）", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const edges = [makeEdge("e1", "a", "b"), makeEdge("e2", "b", "c"), makeEdge("e3", "c", "a")];
    const result = autoLayout(nodes, edges);
    expect(Object.keys(result)).toHaveLength(3);
  });

  it("悬空边（端点不存在）与自环不参与分层、不引发挂起", () => {
    const nodes = [makeNode("a"), makeNode("b")];
    const edges = [
      makeEdge("e1", "a", "gone"),
      makeEdge("e2", "gone", "b"),
      makeEdge("e3", "a", "a"),
    ];
    const result = autoLayout(nodes, edges);
    // 自环节点按无依赖处理归首层；a、b 无有效依赖关系同层并排
    expect(result.a).toEqual({ x: columnX(0), y: rowY(0) });
    expect(result.b).toEqual({ x: columnX(0), y: rowY(1) });
  });
});

describe("autoLayout: 蛇形折行", () => {
  it("不超过 6 列的串行链保持一条直线（不折行）", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const { nodes, edges } = makeChain(ids);
    const result = autoLayout(nodes, edges);
    ids.forEach((id, index) => {
      expect(result[id]).toEqual({ x: columnX(index), y: rowY(0) });
    });
  });

  it("8 节点串行链：第 7 列起折入第 1 带并反向铺排（带从右到左）", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const { nodes, edges } = makeChain(ids);
    const result = autoLayout(nodes, edges);
    // 第 0 带：前 6 列从左到右，y = 0
    ids.slice(0, AUTO_LAYOUT_BAND_COLUMNS).forEach((id, index) => {
      expect(result[id]).toEqual({ x: columnX(index), y: rowY(0) });
    });
    // 第 1 带：反向——第 7 列（g）落最右槽位、第 8 列（h）在其左；带顶下移
    expect(result.g).toEqual({ x: columnX(AUTO_LAYOUT_BAND_COLUMNS - 1), y: bandY(1) });
    expect(result.h).toEqual({ x: columnX(AUTO_LAYOUT_BAND_COLUMNS - 2), y: bandY(1) });
    // 折行处连线竖直：f（带尾）与 g（下一带头）x 相同
    expect(result.g?.x).toBe(result.f?.x);
  });

  it("13 节点串行链：第 13 列回到第 2 带最左槽（方向再度翻转）", () => {
    const ids = Array.from({ length: 13 }, (_, index) => `n${index}`);
    const { nodes, edges } = makeChain(ids);
    const result = autoLayout(nodes, edges);
    const last = ids[12];
    expect(result[last]).toEqual({ x: columnX(0), y: bandY(2) });
    // 第 12 列（n11）在第 1 带最左槽，与 n13 列折行边竖直
    expect(result.n11).toEqual({ x: columnX(0), y: bandY(1) });
  });

  it("带内含多行列时，下一带顶让出最高列高度（不与上一带重叠）", () => {
    // a→b→c，c 分叉出 d / e 同层（第 3 列两行），d·e 汇合后 f→g→h 共 7 列
    const nodes = ["a", "b", "c", "d", "e", "f", "g", "h"].map(makeNode);
    const edges = [
      makeEdge("e1", "a", "b"),
      makeEdge("e2", "b", "c"),
      makeEdge("e3", "c", "d"),
      makeEdge("e4", "c", "e"),
      makeEdge("e5", "d", "f"),
      makeEdge("e6", "e", "f"),
      makeEdge("e7", "f", "g"),
      makeEdge("e8", "g", "h"),
    ];
    const result = autoLayout(nodes, edges);
    // 第 0 带 6 列，最高列（第 3 列 d/e）两行；带顶让出后 h 在第 1 带最右槽
    const bandTop = rowY(1) + FLOW_NODE_SIZE.height + AUTO_LAYOUT_BAND_GAP;
    expect(result.d?.y).toBe(rowY(0));
    expect(result.e?.y).toBe(rowY(1));
    expect(result.h).toEqual({ x: columnX(AUTO_LAYOUT_BAND_COLUMNS - 1), y: bandTop });
  });
});

describe("autoLayout: 确定性", () => {
  it("同输入两次调用结果完全一致", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c"), makeNode("d")];
    const edges = [makeEdge("e1", "a", "c"), makeEdge("e2", "b", "c"), makeEdge("e3", "c", "d")];
    expect(autoLayout(nodes, edges)).toEqual(autoLayout(nodes, edges));
  });

  it("同层内按数组（注册）顺序排列：调换数组顺序会调换同层行位", () => {
    const edges: WorkflowEdge[] = [];
    const first = autoLayout([makeNode("x"), makeNode("y")], edges);
    expect(first.x?.y).toBeLessThan(first.y?.y ?? 0);

    const second = autoLayout([makeNode("y"), makeNode("x")], edges);
    expect(second.x?.y).toBeGreaterThan(second.y?.y ?? 0);
  });

  it("覆盖全部输入节点（返回值含每个节点的坐标）", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const result = autoLayout(nodes, [makeEdge("e1", "a", "b")]);
    expect(Object.keys(result).sort()).toEqual(["a", "b", "c"]);
  });
});
