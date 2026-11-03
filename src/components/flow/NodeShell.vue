<script setup lang="ts">
import { computed } from "vue";
import { Handle, Position } from "@vue-flow/core";
import type { NodeProps } from "@vue-flow/core";
import type { WorkflowNode } from "../../api/types";
import { getWorkflowNodeMeta, nodeBadge, nodeSummary } from "./node-meta";

/**
 * 画布节点自绘壳（9 类节点共用）：文案 / 强调色 / 摘要 / 角标取自
 * node-meta 注册表，手柄布局按类型落位；条件分支渲染真 / 假双出口，
 * 便签无手柄且以 config.color 为底色。不引入 Vue Flow 默认主题。
 */
const props = defineProps<NodeProps<{ node: WorkflowNode }>>();

const node = computed(() => props.data.node);
const meta = computed(() => getWorkflowNodeMeta(node.value.type));
const label = computed(() => {
  const custom = node.value.label?.trim();
  return custom ? custom : meta.value.label;
});
const summary = computed(() => nodeSummary(node.value));
const badge = computed(() => nodeBadge(node.value));

/** 便签底色：config.color 为合法 HEX 时生效，否则用默认便签黄。 */
const stickyColor = computed(() => {
  const raw = node.value.config?.["color"];
  return typeof raw === "string" && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : "#f6e2a8";
});
</script>

<template>
  <div
    class="flow-node"
    :class="[
      `flow-node-${meta.type}`,
      { 'flow-node-selected': props.selected, 'flow-node-sticky': meta.handles === 'none' },
    ]"
    :style="meta.handles === 'none' ? { background: stickyColor } : { '--node-color': meta.color }"
  >
    <div class="flow-node-head">
      <span v-if="meta.handles !== 'none'" class="flow-node-dot" aria-hidden="true" />
      <span class="flow-node-name" :title="label">{{ label }}</span>
      <span v-if="badge !== undefined" class="flow-node-badge mono">{{ badge }}</span>
    </div>
    <div class="flow-node-summary mono" :title="summary">{{ summary }}</div>

    <!-- 入边手柄：仅处理节点（开始只有出边，便签不可连线） -->
    <Handle
      v-if="meta.handles === 'target-source'"
      type="target"
      :position="Position.Left"
      class="flow-handle"
    />
    <!-- 出边手柄：条件分支为真 / 假双出口（id 即分支标识），其余单出口 -->
    <template v-if="meta.handles !== 'none'">
      <template v-if="meta.type === 'condition'">
        <Handle
          type="source"
          id="true"
          :position="Position.Right"
          class="flow-handle flow-branch-handle"
          style="top: 32%"
        />
        <Handle
          type="source"
          id="false"
          :position="Position.Right"
          class="flow-handle flow-branch-handle"
          style="top: 72%"
        />
        <span class="flow-branch-label" style="top: 32%" aria-hidden="true">真</span>
        <span class="flow-branch-label" style="top: 72%" aria-hidden="true">假</span>
      </template>
      <Handle v-else type="source" :position="Position.Right" class="flow-handle" />
    </template>
  </div>
</template>
