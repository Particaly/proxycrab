import { FLOW_NODE_SIZE } from "./graph-model";

/**
 * 连线动态选边纯函数（浮动边浮动接线的几何决策）。
 *
 * 内置默认边固定「右手出、左手进」：蛇形布局的反向带里连线要从源节点
 * 右侧出发绕大半圈再进目标左侧，起终点完全不可读。这里按源 / 目标节点
 * 的相对位置决定两端各从哪一侧就近接入——横向相对（左右相邻）从左右侧
 * 相接，纵向相对（上下折行）从下 / 上侧相接，连线短且贴合节点边界。
 *
 * 无 Vue / store 依赖，vitest node 环境可直接单测。
 */

/** 节点外接矩形（画布坐标）。 */
export interface EdgeNodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 连线在节点上的接入侧。 */
export type EdgeSide = "top" | "bottom" | "left" | "right";

/**
 * 从 Vue Flow 图节点读出外接矩形（供浮动边组件使用）。
 *
 * @param node 含画布 position 与量得尺寸的图节点（GraphNode 结构子集）
 * @returns 外接矩形；尺寸未量得 / 为 0 时回落统一卡尺寸
 */
export function edgeNodeRect(node: {
  position: { x: number; y: number };
  dimensions?: { width?: number | null; height?: number | null };
}): EdgeNodeRect {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.dimensions?.width || FLOW_NODE_SIZE.width,
    height: node.dimensions?.height || FLOW_NODE_SIZE.height,
  };
}

/**
 * 矩形某侧边的中点（连线的接入锚点，落在节点边界上）。
 *
 * @param rect 外接矩形
 * @param side 接入侧
 * @returns 锚点画布坐标
 */
export function edgeSidePoint(rect: EdgeNodeRect, side: EdgeSide): { x: number; y: number } {
  switch (side) {
    case "left":
      return { x: rect.x, y: rect.y + rect.height / 2 };
    case "right":
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
    case "top":
      return { x: rect.x + rect.width / 2, y: rect.y };
    case "bottom":
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
  }
}

/**
 * 按源 / 目标矩形中心的相对位移选两端接入侧：横向为主（|dx| > |dy|）时
 * 左右相接（目标在右则右出左进，反之左出右进），否则上下相接（目标在
 * 下则下出上进，在上则上出下进）。同输入结果确定。
 *
 * @param source 源节点外接矩形
 * @param target 目标节点外接矩形
 * @returns 两端的接入侧
 */
export function pickEdgeSides(
  source: EdgeNodeRect,
  target: EdgeNodeRect,
): { source: EdgeSide; target: EdgeSide } {
  const dx = target.x + target.width / 2 - (source.x + source.width / 2);
  const dy = target.y + target.height / 2 - (source.y + source.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? { source: "right", target: "left" } : { source: "left", target: "right" };
  }
  return dy > 0 ? { source: "bottom", target: "top" } : { source: "top", target: "bottom" };
}
