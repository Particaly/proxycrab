<script setup lang="ts">
import { computed, markRaw } from "vue";
import { VueFlow, useVueFlow } from "@vue-flow/core";
import type { NodeTypesObject, EdgeTypesObject } from "@vue-flow/core";
import { MiniMap } from "@vue-flow/minimap";
import type { WorkflowEdge, WorkflowNode } from "../../api/types";
import { toFlowEdges, toFlowNodes } from "./graph-model";
import NodeShell from "./NodeShell.vue";
import FlowEdge from "./FlowEdge.vue";
import { getWorkflowNodeMeta } from "./node-meta";
import { withEdgeRunClasses } from "./run-view";
import type { RunNodeStateMap } from "./run-view";

/**
 * 只读运行画布（ReqFlow 复刻 Task 22 薄片 A）：运行详情窗口的运行图视图。
 *
 * 与编辑器画布（Canvas.vue）的关系：**复用渲染栈、不复用编辑栈**——同一套
 * 领域图投影（toFlowNodes / toFlowEdges）、节点自绘壳（NodeShell，经
 * data.runState 旁路注入运行态：状态描边 / ✓✗ 角标 / running 脉冲 / 循环
 * 迭代进度）、分支边标签、小地图配色。编辑器画布零改动。
 *
 * 只读口径：节点不可拖动 / 不可连线 / 不可框选，删除键关闭；选中事实来源是
 * selectedNodeId prop（点选经 select 上抛，点空白清空）。挂载即 fitView
 * 全览（运行图无编辑期视口留存语义）；小地图概览；空图渲染居中提示。
 */
const props = defineProps<{
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** 节点运行态 map（nodeId → 视觉状态）；缺省 / null 关闭运行态渲染。 */
  runStates?: RunNodeStateMap | null;
  /** 受控选中节点 id（null = 未选中）。 */
  selectedNodeId?: string | null;
}>();

const emit = defineEmits<{
  select: [nodeId: string | null];
}>();

/** useVueFlow 必须与 <VueFlow> 共享实例：setup 里先创建，经 provide 注入子组件。 */
const { fitView, zoomIn, zoomOut } = useVueFlow();

/** 9 类节点统一走 NodeShell 自绘（模块级常量保持引用稳定）。 */
const FLOW_NODE_TYPES: NodeTypesObject = {
  start: markRaw(NodeShell),
  httpReplay: markRaw(NodeShell),
  condition: markRaw(NodeShell),
  loop: markRaw(NodeShell),
  delay: markRaw(NodeShell),
  setVariable: markRaw(NodeShell),
  assert: markRaw(NodeShell),
  transform: markRaw(NodeShell),
  stickyNote: markRaw(NodeShell),
};

/** 连线类型注册：floating 浮动边就近接线（与编辑器画布同一出口）。 */
const FLOW_EDGE_TYPES: EdgeTypesObject = { floating: markRaw(FlowEdge) };

/** 展示节点：领域图投影 + 运行态旁路注入 + 受控选中标记。 */
const flowNodes = computed(() =>
  toFlowNodes(props.nodes).map((node) => ({
    ...node,
    selected: props.selectedNodeId === node.id,
    data: {
      node: node.data.node,
      issues: [],
      runState: props.runStates?.[node.id],
    },
  })),
);

/** 展示连线：分支标签 + 运行中边流动动画类。 */
const flowEdges = computed(() =>
  withEdgeRunClasses(toFlowEdges(props.edges), props.runStates ?? null),
);

function minimapColor(node: { type?: string }): string {
  const meta = getWorkflowNodeMeta(String(node.type ?? ""));
  return meta.handles === "none" ? "#f6e2a8" : meta.color;
}
</script>

<template>
  <div class="run-graph-root">
    <VueFlow
      class="flow-canvas run-graph"
      :nodes="flowNodes"
      :edges="flowEdges"
      :node-types="FLOW_NODE_TYPES"
      :edge-types="FLOW_EDGE_TYPES"
      :auto-connect="false"
      :delete-key-code="null"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :edges-focusable="false"
      :selection-key-code="null"
      :pan-on-drag="[0, 1, 2]"
      :zoom-on-double-click="false"
      :min-zoom="0.2"
      :max-zoom="2"
      :fit-view-on-init="true"
      :fit-view-options="{ padding: 0.25, maxZoom: 1 }"
      @node-click="(event) => emit('select', String(event.node.id))"
      @pane-click="emit('select', null)"
    >
      <MiniMap
        position="bottom-left"
        pannable
        zoomable
        :node-color="minimapColor"
        :node-border-radius="4"
        :node-stroke-width="1"
      />
    </VueFlow>

    <!-- 只读画布的工具条：缩放 / 全览（无编辑动作） -->
    <div class="run-graph-toolbar">
      <button class="btn icon" title="放大" @click="zoomIn()">
        <span aria-hidden="true">＋</span>
      </button>
      <button class="btn icon" title="缩小" @click="zoomOut()">
        <span aria-hidden="true">－</span>
      </button>
      <button class="btn icon" title="适应画布" @click="fitView({ padding: 0.25, maxZoom: 1 })">
        <span aria-hidden="true">⤢</span>
      </button>
    </div>

    <!-- 空图提示：无节点可还原时居中展示（不遮挡画布交互） -->
    <div v-if="nodes.length === 0" class="run-graph-empty">
      <p class="run-graph-empty-title">没有可展示的节点</p>
      <p class="run-graph-empty-hint">本次运行的图数据为空</p>
    </div>
  </div>
</template>

<style scoped>
.run-graph-root {
  flex: 1;
  min-height: 0;
  min-width: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}

.run-graph :deep(.vue-flow__node) {
  cursor: pointer;
}

/* 只读工具条（右上角悬浮）：缩放 / 全览 */
.run-graph-toolbar {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  box-shadow: var(--shadow-popup);
}

/* 空图居中提示 */
.run-graph-empty {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  pointer-events: none;
}
.run-graph-empty-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}
.run-graph-empty-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}
</style>
