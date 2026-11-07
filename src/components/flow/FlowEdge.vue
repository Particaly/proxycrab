<script setup lang="ts">
import { computed } from "vue";
import { BaseEdge, getBezierPath, Position, type EdgeProps } from "@vue-flow/core";
import { edgeNodeRect, edgeSidePoint, pickEdgeSides, type EdgeSide } from "./edge-routing";

/**
 * 浮动连线（自定义边类型 floating）：忽略手柄锚点，按源 / 目标节点当前
 * 位置就近接线——横向相对左右相接、纵向相对上下相接（几何决策见
 * edge-routing.ts），贝塞尔走线。蛇形布局的反向带里连线左出右进、折行
 * 处下出上进，起终点贴合节点边界一目了然；节点拖动 / 布局时 GraphNode
 * 位置响应式更新，连线实时跟随。条件分支连线（真 / 假手柄）不走本组件，
 * 仍用内置默认边锚在手柄上。
 */
const props = defineProps<EdgeProps>();

/** 接入侧 → Vue Flow 位置枚举（getBezierPath 据此算控制点方向）。 */
const SIDE_POSITIONS: Record<EdgeSide, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
};

/** 两端接入锚点与贝塞尔路径（随节点位置 / 尺寸变化重算）。 */
const path = computed(() => {
  const sourceRect = edgeNodeRect(props.sourceNode);
  const targetRect = edgeNodeRect(props.targetNode);
  const sides = pickEdgeSides(sourceRect, targetRect);
  const from = edgeSidePoint(sourceRect, sides.source);
  const to = edgeSidePoint(targetRect, sides.target);
  const [bezierPath] = getBezierPath({
    sourceX: from.x,
    sourceY: from.y,
    targetX: to.x,
    targetY: to.y,
    sourcePosition: SIDE_POSITIONS[sides.source],
    targetPosition: SIDE_POSITIONS[sides.target],
  });
  return bezierPath;
});
</script>

<template>
  <BaseEdge :path="path" :style="props.style" :marker-end="props.markerEnd" />
</template>
