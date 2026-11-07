import { describe, expect, it } from "vitest";
import { edgeNodeRect, edgeSidePoint, pickEdgeSides } from "./edge-routing";
import { FLOW_NODE_SIZE } from "./graph-model";

/**
 * 连线动态选边纯函数测试：横向相对左右相接（含反向带的左出右进）、
 * 纵向相对上下相接（蛇形折行竖直短距）、主导轴判定、锚点落边界中点、
 * 尺寸缺省回落统一卡尺寸。
 */

/** 固定尺寸矩形（缺省统一卡尺寸）。 */
function rect(x: number, y: number, width = FLOW_NODE_SIZE.width, height = FLOW_NODE_SIZE.height) {
  return { x, y, width, height };
}

describe("pickEdgeSides: 横向相对", () => {
  it("目标在右侧：右出左进（蛇形正向带内相邻连线水平短距）", () => {
    const sides = pickEdgeSides(rect(0, 0), rect(276, 0));
    expect(sides).toEqual({ source: "right", target: "left" });
  });

  it("目标在左侧：左出右进（蛇形反向带内连线不再绕行大半圈）", () => {
    const sides = pickEdgeSides(rect(276, 0), rect(0, 0));
    expect(sides).toEqual({ source: "left", target: "right" });
  });

  it("横向位移占主导时纵向偏差不影响左右相接判定", () => {
    const sides = pickEdgeSides(rect(0, 0), rect(276, 60));
    expect(sides).toEqual({ source: "right", target: "left" });
  });
});

describe("pickEdgeSides: 纵向相对", () => {
  it("目标在正下方：下出上进（蛇形折行处连线竖直不绕行）", () => {
    const sides = pickEdgeSides(rect(0, 0), rect(0, 136));
    expect(sides).toEqual({ source: "bottom", target: "top" });
  });

  it("目标在正上方：上出下进", () => {
    const sides = pickEdgeSides(rect(0, 136), rect(0, 0));
    expect(sides).toEqual({ source: "top", target: "bottom" });
  });

  it("纵向位移占主导时横向偏差不影响上下相接判定", () => {
    const sides = pickEdgeSides(rect(0, 0), rect(40, 136));
    expect(sides).toEqual({ source: "bottom", target: "top" });
  });

  it("中心完全重合：确定性落上下相接（dy 不大于 0 分支）", () => {
    const sides = pickEdgeSides(rect(0, 0), rect(0, 0));
    expect(sides).toEqual({ source: "top", target: "bottom" });
  });
});

describe("edgeSidePoint", () => {
  it("四侧锚点落在对应边界中点", () => {
    const r = rect(100, 200, 40, 20);
    expect(edgeSidePoint(r, "left")).toEqual({ x: 100, y: 210 });
    expect(edgeSidePoint(r, "right")).toEqual({ x: 140, y: 210 });
    expect(edgeSidePoint(r, "top")).toEqual({ x: 120, y: 200 });
    expect(edgeSidePoint(r, "bottom")).toEqual({ x: 120, y: 220 });
  });
});

describe("edgeNodeRect", () => {
  it("读出位置与量得尺寸", () => {
    expect(
      edgeNodeRect({ position: { x: 1, y: 2 }, dimensions: { width: 10, height: 5 } }),
    ).toEqual({ x: 1, y: 2, width: 10, height: 5 });
  });

  it("尺寸未量得 / 为 0 时回落统一卡尺寸", () => {
    expect(
      edgeNodeRect({ position: { x: 0, y: 0 }, dimensions: { width: 0, height: null } }),
    ).toEqual({ x: 0, y: 0, width: FLOW_NODE_SIZE.width, height: FLOW_NODE_SIZE.height });
    expect(edgeNodeRect({ position: { x: 3, y: 4 } })).toEqual({
      x: 3,
      y: 4,
      width: FLOW_NODE_SIZE.width,
      height: FLOW_NODE_SIZE.height,
    });
  });
});
