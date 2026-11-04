<script lang="ts">
import type { InjectionKey } from "vue";

/**
 * 节点重命名的注入键（Canvas provide，NodeShell inject）：双击节点名进入
 * 行内编辑，提交时回调 (nodeId, label)。锁定等守卫由 Canvas 侧回调负责。
 */
export const NODE_RENAME_KEY: InjectionKey<(nodeId: string, label: string) => void> =
  Symbol("flow-node-rename");
</script>

<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { Handle, Position } from "@vue-flow/core";
import type { NodeProps } from "@vue-flow/core";
import type { WorkflowNode } from "../../api/types";
import { getWorkflowNodeMeta, nodeBadge, nodeSummary } from "./node-meta";
import { badgeIssues, type NodeIssue } from "./node-issue-badge";

/**
 * 画布节点自绘壳（9 类节点共用）：文案 / 强调色 / 摘要 / 角标取自
 * node-meta 注册表，手柄布局按类型落位；条件分支渲染真 / 假双出口，
 * 便签无手柄且以 config.color 为底色。不引入 Vue Flow 默认主题。
 * data.issues 为窗口合并后的节点粒度校验问题（视图层旁路注入，见
 * graph-model.toFlowNodes），据此渲染常驻问题徽标（error 红 / warning 琥珀）。
 * 节点名双击进入行内编辑（Enter / 失焦提交、Esc 取消），经 NODE_RENAME_KEY
 * 上抛画布 → 窗口落 domain 节点 label。
 */
const props = defineProps<NodeProps<{ node: WorkflowNode; issues: NodeIssue[] }>>();

const renameNode = inject(NODE_RENAME_KEY, null);

const node = computed(() => props.data.node);
const meta = computed(() => getWorkflowNodeMeta(node.value.type));
const label = computed(() => {
  const custom = node.value.label?.trim();
  return custom ? custom : meta.value.label;
});
const summary = computed(() => nodeSummary(node.value));
const badge = computed(() => nodeBadge(node.value));

/** 徽标展示问题（info 级语义披露不进徽标，仅窗口校验面板展示）。 */
const issues = computed(() => badgeIssues(props.data.issues ?? []));
const hasError = computed(() => issues.value.some((issue) => issue.level === "error"));

/** 便签底色：config.color 为合法 HEX 时生效，否则用默认便签黄。 */
const stickyColor = computed(() => {
  const raw = node.value.config?.["color"];
  return typeof raw === "string" && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : "#f6e2a8";
});

/** 行内重命名编辑态：null 非编辑；编辑时持有草稿名。 */
const draftName = ref<string | null>(null);

/** 编辑框挂载即聚焦并全选（函数 ref）。 */
function focusDraft(el: unknown): void {
  if (el instanceof HTMLInputElement) el.select();
}

function startRename(): void {
  if (renameNode === null) return;
  draftName.value = label.value;
}

/** 提交重命名：空名 / 未变化不更新；Enter / 失焦提交，Esc 取消。 */
function commitRename(): void {
  if (draftName.value === null) return;
  const draft = draftName.value;
  draftName.value = null;
  if (draft.trim() !== "" && draft.trim() !== label.value && renameNode !== null) {
    renameNode(props.id, draft);
  }
}
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
    <span
      v-if="issues.length > 0"
      class="flow-node-issue nodrag nopan"
      :class="{ error: hasError }"
      :title="issues.map((issue) => issue.message).join('\n')"
    >
      {{ issues.length }}
    </span>
    <div class="flow-node-head">
      <span v-if="meta.handles !== 'none'" class="flow-node-dot" aria-hidden="true" />
      <input
        v-if="draftName !== null"
        v-model="draftName"
        class="flow-node-name-input nodrag nopan"
        aria-label="节点名称"
        :ref="focusDraft"
        @click.stop
        @dblclick.stop
        @mousedown.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="draftName = null"
        @blur="commitRename"
      />
      <span
        v-else
        class="flow-node-name"
        :title="`${label}（双击重命名）`"
        @dblclick.stop="startRename"
      >
        {{ label }}
      </span>
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
