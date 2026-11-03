<script setup lang="ts">
import { computed } from "vue";
import { VueFlow } from "@vue-flow/core";
import type { NodeChange, NodeTypesObject } from "@vue-flow/core";
import { markRaw } from "vue";
import type { WorkflowEdge, WorkflowNode } from "../../api/types";
import {
  applyNodePositions,
  toFlowEdges,
  toFlowNodes,
  type GraphPositionChange,
} from "./graph-model";
import NodeShell from "./NodeShell.vue";

/**
 * 画布：Vue Flow 实例 + 自绘节点。领域图（nodes/edges）由父窗口持有，
 * 本组件负责投影渲染并回传两类事件——节点定位变化（合成脏标记与保存）
 * 与节点选中（驱动右侧配置抽屉）。结构性编辑（连线 / 增删 / 框选批量
 * 操作）属于 Task 13：auto-connect 关闭、删除键禁用，保证内部状态与
 * 领域模型一致。
 */
const props = defineProps<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }>();

const emit = defineEmits<{
  positionChange: [nodes: WorkflowNode[]];
  select: [nodeId: string | null];
}>();

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

const flowNodes = computed(() => toFlowNodes(props.nodes));
const flowEdges = computed(() => toFlowEdges(props.edges));

function onNodesChange(changes: NodeChange[]): void {
  const positions: GraphPositionChange[] = [];
  for (const change of changes) {
    if (change.type === "position" && change.position) {
      positions.push({ id: change.id, x: change.position.x, y: change.position.y });
    }
  }
  if (positions.length === 0) return;
  const next = applyNodePositions(props.nodes, positions);
  if (next) emit("positionChange", next);
}
</script>

<template>
  <VueFlow
    class="flow-canvas"
    :nodes="flowNodes"
    :edges="flowEdges"
    :node-types="FLOW_NODE_TYPES"
    :auto-connect="false"
    :delete-key-code="null"
    :min-zoom="0.2"
    :max-zoom="2"
    fit-view-on-init
    @nodes-change="onNodesChange"
    @node-click="(event) => emit('select', String(event.node.id))"
    @pane-click="emit('select', null)"
  />
</template>
