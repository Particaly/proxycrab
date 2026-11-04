import { FLOW_NODE_SIZE } from "./graph-model";

/**
 * 拖动对齐辅助线纯函数（Task 13 Step 2）：单节点拖动时，对其他节点计算
 * 左 / 中 / 右（上 / 中 / 下）三条候选线，拖动节点任一边线落入阈值内即吸附
 * 到最近候选，并返回待渲染的辅助线（画布坐标系）。
 *
 * 无 Vue / Vue Flow 依赖，vitest node 环境可直接单测；渲染层的坐标换算
 * （flow → screen）由 Canvas.vue 完成。
 */

/** 吸附判定阈值（画布像素）：边线距离不超过该值即吸附。 */
export const ALIGNMENT_SNAP_THRESHOLD = 6;

/** 一条对齐辅助线：axis = x 表示垂直线（x 恒定），axis = y 表示水平线。 */
export interface AlignmentGuide {
  axis: "x" | "y";
  /** 辅助线在画布坐标系的位置（垂直线的 x / 水平线的 y）。 */
  value: number;
  /** 辅助线跨度的起点 / 终点（另一轴，画布坐标系）。 */
  from: number;
  to: number;
}

/** 拖动节点矩形（画布坐标系，宽高缺省用画布节点卡基准尺寸）。 */
export interface SnapRect {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/** snapPosition 的产出：吸附后的左上角坐标 + 待渲染辅助线。 */
export interface SnapResult {
  x: number;
  y: number;
  guides: AlignmentGuide[];
}

/** 候选命中：吸附后拖动节点左上角坐标 + 辅助线 + 命中差值（取最近用）。 */
interface AxisSnap {
  origin: number;
  guide: AlignmentGuide;
  delta: number;
}

/**
 * 单轴吸附：在候选线上找与拖动边线差值最小（≤ 阈值）的一条。
 *
 * @param edges 拖动节点本轴的三条边线（起点 / 中点 / 终点）
 * @param offsets 对应边线到节点左上角原点的偏移（吸附后 origin = 候选 − 偏移）
 * @param candidates 其他节点本轴的全部候选线
 * @param spans 候选线来源节点的另一轴区间（辅助线跨度，与拖动节点区间合并）
 * @param movingSpan 拖动节点另一轴区间（并入跨度）
 */
function snapAxis(
  axis: "x" | "y",
  edges: [number, number, number],
  offsets: [number, number, number],
  candidates: number[],
  spans: Array<[number, number]>,
  movingSpan: [number, number],
): AxisSnap | null {
  let best: AxisSnap | null = null;
  edges.forEach((edge, edgeIndex) => {
    candidates.forEach((candidate, candidateIndex) => {
      const delta = Math.abs(edge - candidate);
      if (delta > ALIGNMENT_SNAP_THRESHOLD) return;
      if (best && delta >= best.delta) return;
      const span = spans[candidateIndex] ?? [0, 0];
      best = {
        origin: candidate - offsets[edgeIndex]!,
        delta,
        guide: {
          axis,
          value: candidate,
          from: Math.min(span[0]!, movingSpan[0]),
          to: Math.max(span[1]!, movingSpan[1]),
        },
      };
    });
  });
  return best;
}

/**
 * 计算拖动节点的吸附坐标与辅助线。
 *
 * 候选线取自其他节点的左 / 中 / 右（垂直线）与上 / 中 / 下（水平线）；
 * 拖动节点的同组边线与候选差值 ≤ 阈值时，取差值最小者吸附（x / y 两轴
 * 独立判定）。无命中时返回原坐标与空辅助线。宽度 / 高度缺省取画布节点卡
 * 基准尺寸（FLOW_NODE_SIZE）。
 */
export function snapPosition(moving: SnapRect, others: readonly SnapRect[]): SnapResult {
  const width = moving.width ?? FLOW_NODE_SIZE.width;
  const height = moving.height ?? FLOW_NODE_SIZE.height;
  const result: SnapResult = { x: moving.x, y: moving.y, guides: [] };
  const verticalLines: number[] = [];
  const horizontalLines: number[] = [];
  const verticalSpans: Array<[number, number]> = [];
  const horizontalSpans: Array<[number, number]> = [];
  for (const other of others) {
    const otherWidth = other.width ?? FLOW_NODE_SIZE.width;
    const otherHeight = other.height ?? FLOW_NODE_SIZE.height;
    // 候选线与跨度按下标对齐（每节点 3 条候选线 → 3 份同一跨度）
    verticalLines.push(other.x, other.x + otherWidth / 2, other.x + otherWidth);
    horizontalLines.push(other.y, other.y + otherHeight / 2, other.y + otherHeight);
    for (let i = 0; i < 3; i += 1) {
      verticalSpans.push([other.y, other.y + otherHeight]);
      horizontalSpans.push([other.x, other.x + otherWidth]);
    }
  }

  const vertical = snapAxis(
    "x",
    [moving.x, moving.x + width / 2, moving.x + width],
    [0, width / 2, width],
    verticalLines,
    verticalSpans,
    [moving.y, moving.y + height],
  );
  if (vertical) {
    result.x = vertical.origin;
    result.guides.push(vertical.guide);
  }
  const horizontal = snapAxis(
    "y",
    [moving.y, moving.y + height / 2, moving.y + height],
    [0, height / 2, height],
    horizontalLines,
    horizontalSpans,
    [moving.x, moving.x + width],
  );
  if (horizontal) {
    result.y = horizontal.origin;
    result.guides.push(horizontal.guide);
  }
  return result;
}
