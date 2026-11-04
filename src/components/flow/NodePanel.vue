<script lang="ts">
/** 拖入节点类型的 dataTransfer MIME 标记（面板 dragStart 与画布 drop 共用）。 */
export const NODE_TYPE_MIME = "application/x-proxy-crab-flow-node";
</script>

<script setup lang="ts">
import { WORKFLOW_NODE_META, WORKFLOW_NODE_TYPE_ORDER } from "./node-meta";

/**
 * 节点面板（Task 13 Step 1，移植归档 NodePanel 形态）：画布左上角悬浮窄条，
 * 按 WORKFLOW_NODE_TYPE_ORDER 渲染可拖入的节点卡片——dragStart 把节点类型
 * 写入 dataTransfer（NODE_TYPE_MIME），画布 onDrop 读取后建节点（见 Canvas.vue）。
 *
 * 运行期编辑锁定（Step 4）：locked 时拖入节点属结构性编辑——卡片
 * draggable=false 并以 title 提示，视觉降透明度；画布 drop 守卫兜底
 * （拖拽在锁定瞬间落下等绕过面板的路径）。
 */

defineProps<{ locked?: boolean }>();

function onDragStart(event: DragEvent, type: string): void {
  event.dataTransfer?.setData(NODE_TYPE_MIME, type);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}
</script>

<template>
  <div class="flow-node-panel" data-testid="node-panel">
    <div class="flow-node-panel-title">节点</div>
    <div
      v-for="type in WORKFLOW_NODE_TYPE_ORDER"
      :key="type"
      class="flow-node-panel-item"
      :class="{ locked }"
      :draggable="!locked"
      :aria-disabled="locked || undefined"
      :title="
        locked
          ? '运行中不可编辑：运行结束后再拖入节点'
          : `拖入画布新增「${WORKFLOW_NODE_META[type].label}」节点`
      "
      @dragstart="onDragStart($event, type)"
    >
      <span
        class="flow-node-panel-dot"
        :style="{ background: WORKFLOW_NODE_META[type].color }"
        aria-hidden="true"
      />
      <span class="flow-node-panel-name">{{ WORKFLOW_NODE_META[type].label }}</span>
    </div>
  </div>
</template>
