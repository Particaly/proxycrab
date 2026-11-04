<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, provide, ref } from "vue";
import { VueFlow, useVueFlow } from "@vue-flow/core";
import type {
  Connection,
  EdgeChange,
  GraphNode,
  NodeChange,
  NodePositionChange,
  NodeTypesObject,
  ViewportTransform,
} from "@vue-flow/core";
import { MiniMap } from "@vue-flow/minimap";
import type { WorkflowEdge, WorkflowNode, WorkflowNodeType } from "../../api/types";
import {
  applyNodePositions,
  createWorkflowEdge,
  createWorkflowNode,
  FLOW_NODE_SIZE,
  takenRefKeys,
  toFlowEdges,
  toFlowNodes,
  type GraphPositionChange,
} from "./graph-model";
import { WORKFLOW_NODE_META, WORKFLOW_NODE_TYPE_ORDER, getWorkflowNodeMeta } from "./node-meta";
import NodeShell, { NODE_RENAME_KEY } from "./NodeShell.vue";
import NodePanel, { NODE_TYPE_MIME } from "./NodePanel.vue";
import CanvasToolbar from "./CanvasToolbar.vue";
import { snapPosition, type AlignmentGuide } from "./alignment";
import { autoLayout } from "./auto-layout";
import {
  copySelectedNodes,
  hasNodeClipboard,
  pasteNodeClipboard,
  peekNodeClipboard,
} from "./node-clipboard";
import type { NodeIssue } from "./node-issue-badge";
import { groupIssuesByNode } from "./node-issue-badge";
import { readCanvasViewport, writeCanvasViewport } from "./canvas-viewport-store";
import { notifyEditLocked } from "./canvas-edit-lock";

/**
 * 画布：Vue Flow 实例 + 自绘节点（Task 13 交互层）。
 *
 * 领域图（nodes/edges）由父窗口持有，本组件负责投影渲染与全部画布交互，
 * 回传四类语义事件——定位变化（拖动 / 自动布局，纯位置不改结构）、结构变化
 * （增删节点 / 连线 / 重命名 / 粘贴，携带完整新图）、历史提交请求（拖动收尾 /
 * 布局后，窗口据此 commitGraph）、撤销 / 重做请求（窗口持有图快照历史）。
 *
 * 交互面（对齐归档 ReqFlow 画布）：面板拖入建节点、手柄连线（条件节点
 * 真 / 假双出口、同向同出口去重、禁止自环）、拖线到空白弹添加菜单并自动
 * 连线、左键框选 + Ctrl/Meta 多选、Delete / Backspace 删除选中（节点连同
 * 相邻连线，微任务合帧避免半删中间态）、双击节点名行内重命名、复制 / 粘贴
 * （Ctrl+C / V 与工具栏）、自动布局、单节点拖动对齐吸附辅助线、小地图、
 * 滚轮缩放与视口持久化（按流程 id 存 localStorage）。
 *
 * 运行期编辑锁定（locked，来源见窗口的 flow-run store 接缝）：拦截结构性
 * 编辑（删除 / 连线 / 拖入 / 粘贴 / 布局 / 重命名 / 撤销重做）并弹单例提示；
 * 节点拖动、视口、选中与复制保持可用。
 */
const props = defineProps<{
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** 视口持久化键（流程 id）。 */
  workflowId: string;
  /** 运行期结构性编辑锁定（窗口按运行态接缝计算）。 */
  locked: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** 合并后的校验问题清单（窗口计算；画布按节点归属注入徽标）。 */
  issues: NodeIssue[];
}>();

const emit = defineEmits<{
  positionChange: [nodes: WorkflowNode[]];
  structureChange: [nodes: WorkflowNode[], edges: WorkflowEdge[]];
  commitHistory: [];
  select: [nodeId: string | null];
  undo: [];
  redo: [];
}>();

/** useVueFlow 必须与 <VueFlow> 共享实例：setup 里先创建，经 provide 注入子组件。 */
const {
  zoomIn,
  zoomOut,
  fitView,
  screenToFlowCoordinate,
  connectionStartHandle,
  connectionEndHandle,
  setNodes,
  setEdges,
  applyNodeChanges,
  viewport,
} = useVueFlow();

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

const root = ref<HTMLElement | null>(null);

/** 挂载时读取的已存视口（有留存则恢复并关闭 fit-view-on-init）。 */
const savedViewport = readCanvasViewport(props.workflowId);

const issuesByNode = computed(() => groupIssuesByNode(props.issues));
const flowNodes = computed(() => toFlowNodes(props.nodes, issuesByNode.value));
const flowEdges = computed(() => toFlowEdges(props.edges));

/* ------------------------------ 选中与复制 ------------------------------ */

/** 选中节点 id 集合（select 变更即时维护，复制 / 工具栏状态用）。 */
const selectedIds = ref(new Set<string>());

/** 剪贴板版本号：hasNodeClipboard 是模块单例（非响应式），用它驱动重算。 */
const clipboardVersion = ref(0);
const canCopy = computed(() => selectedIds.value.size > 0);
const canPaste = computed(() => clipboardVersion.value >= 0 && hasNodeClipboard());

let pasteIndex = 0;

function onCopy(): void {
  if (selectedIds.value.size === 0) return;
  copySelectedNodes(props.nodes, props.edges, selectedIds.value);
  pasteIndex = 0;
  clipboardVersion.value += 1;
}

function onPaste(): void {
  if (props.locked) {
    notifyEditLocked();
    return;
  }
  const content = peekNodeClipboard();
  if (content === null) return;
  pasteIndex += 1;
  const pasted = pasteNodeClipboard(content, () => crypto.randomUUID(), pasteIndex, {
    excludeRefKeys: takenRefKeys(props.nodes),
  });
  emit("structureChange", [...props.nodes, ...pasted.nodes], [...props.edges, ...pasted.edges]);
}

/* ------------------------------ 删除（合帧） ------------------------------ */

/**
 * 删除缓冲：Vue Flow 删除节点时先发连线 remove、再发节点 remove（两批
 * change），按微任务合帧后一次性上抛结构变化，避免「先删边后删点」的
 * 半删中间态进历史；锁定时整体拒绝并恢复内部状态（内部变更先于本组件
 * 已被 Vue Flow 应用，需手动回写投影以复原视觉）。
 */
let pendingRemoval: { nodes: Set<string>; edges: Set<string> } | null = null;
let flushScheduled = false;

function bufferRemovals(nodeIds: string[], edgeIds: string[]): void {
  if (pendingRemoval === null) pendingRemoval = { nodes: new Set(), edges: new Set() };
  for (const id of nodeIds) pendingRemoval.nodes.add(id);
  for (const id of edgeIds) pendingRemoval.edges.add(id);
  if (!flushScheduled) {
    flushScheduled = true;
    queueMicrotask(flushRemovals);
  }
}

function flushRemovals(): void {
  const pending = pendingRemoval;
  pendingRemoval = null;
  flushScheduled = false;
  if (pending === null || (pending.nodes.size === 0 && pending.edges.size === 0)) return;
  if (props.locked) {
    // 拒绝删除：内部状态已被应用，回写投影复原视觉，并提示原因
    setNodes(flowNodes.value);
    setEdges(flowEdges.value);
    notifyEditLocked();
    return;
  }
  const nextNodes = props.nodes.filter((node) => !pending.nodes.has(node.id));
  const nextEdges = props.edges.filter(
    (edge) =>
      !pending.edges.has(edge.id) &&
      !pending.nodes.has(edge.source) &&
      !pending.nodes.has(edge.target),
  );
  for (const id of pending.nodes) selectedIds.value.delete(id);
  if (nextNodes.length !== props.nodes.length || nextEdges.length !== props.edges.length) {
    emit("structureChange", nextNodes, nextEdges);
  }
}

/* ------------------------------ 定位与吸附 ------------------------------ */

/** 对齐辅助线（画布坐标系；单节点拖动吸附时展示，拖动收尾清除）。 */
const guides = ref<AlignmentGuide[]>([]);

/**
 * 辅助线的屏幕坐标：snapPosition 产出画布坐标，渲染在视口容器（根元素）
 * 上需按当前视口变换换算（screen = flow × zoom + translate）。
 */
const screenGuides = computed(() => {
  const { x, y, zoom } = viewport.value;
  return guides.value.map((guide) => ({
    axis: guide.axis,
    value: guide.value * zoom + (guide.axis === "x" ? x : y),
    from: guide.from * zoom + (guide.axis === "x" ? y : x),
    to: guide.to * zoom + (guide.axis === "x" ? y : x),
  }));
});

function onNodesChange(changes: NodeChange[]): void {
  for (const change of changes) {
    if (change.type === "select") {
      if (change.selected) selectedIds.value.add(change.id);
      else selectedIds.value.delete(change.id);
    } else if (change.type === "remove") {
      bufferRemovals([change.id], []);
    }
  }

  const positionChanges = changes.filter(
    (change): change is NodePositionChange =>
      change.type === "position" && change.position !== undefined,
  );
  if (positionChanges.length === 0) return;

  const corrections: NodePositionChange[] = [];
  const positions: GraphPositionChange[] = [];
  // 仅单节点拖动做吸附（多选批量拖动对齐无稳定语义）
  const single = positionChanges.length === 1 ? positionChanges[0] : null;
  if (single !== null && single.dragging === true) {
    const others = props.nodes
      .filter((node) => node.id !== single.id)
      .map((node) => ({ x: node.position.x, y: node.position.y }));
    const snap = snapPosition({ x: single.position.x, y: single.position.y }, others);
    guides.value = snap.guides;
    if (snap.x !== single.position.x || snap.y !== single.position.y) {
      corrections.push({ ...single, position: { x: snap.x, y: snap.y } });
    }
  } else if (single === null) {
    guides.value = [];
  }
  for (const change of positionChanges) {
    const correction = corrections.find((item) => item.id === change.id);
    positions.push({
      id: change.id,
      x: correction?.position.x ?? change.position.x,
      y: correction?.position.y ?? change.position.y,
    });
  }
  if (corrections.length > 0) {
    // 内部状态已按原坐标应用，补一次吸附修正（不触发 change 钩子）
    applyNodeChanges(corrections);
  }
  const next = applyNodePositions(props.nodes, positions);
  if (next) emit("positionChange", next);
}

/** 拖动 / 框选拖动收尾：清辅助线并请求历史提交（窗口按签名去重）。 */
function onDragStop(): void {
  guides.value = [];
  emit("commitHistory");
}

/* ------------------------------ 删除连线 ------------------------------ */

/**
 * 连线变更：remove（选中连线按删除键）进合帧缓冲与节点删除统一上抛；
 * select 等其余变更由 Vue Flow 内部应用，无需处理。删除节点时 Vue Flow
 * 会先发相连边 remove、再发节点 remove——两批都在微任务前到达，合并为
 * 一次结构变化（见 bufferRemovals）。
 */
function onEdgesChange(changes: EdgeChange[]): void {
  const removals = changes.filter((change) => change.type === "remove");
  if (removals.length > 0) {
    bufferRemovals(
      [],
      removals.map((change) => change.id),
    );
  }
}

/* ------------------------------ 连线 ------------------------------ */

/**
 * 解析连线来源的分支出口：仅 source 为条件节点且手柄为真 / 假时落值
 * （其余节点类型不引入无意义手柄，落库形状与存量数据一致）。
 */
function resolveBranchHandle(
  source: string,
  handleId: string | null | undefined,
): "true" | "false" | undefined {
  if (handleId !== "true" && handleId !== "false") return undefined;
  return props.nodes.find((node) => node.id === source)?.type === "condition"
    ? handleId
    : undefined;
}

function onConnect(connection: Connection): void {
  if (props.locked) {
    notifyEditLocked();
    return;
  }
  const { source, target } = connection;
  if (!source || !target || source === target) return;
  const sourceHandle = resolveBranchHandle(source, connection.sourceHandle);
  const exists = props.edges.some(
    (edge) =>
      edge.source === source &&
      edge.target === target &&
      (edge.sourceHandle ?? undefined) === sourceHandle,
  );
  if (exists) return;
  emit("structureChange", props.nodes, [
    ...props.edges,
    createWorkflowEdge(source, target, sourceHandle),
  ]);
}

/* ------------------------- 拖线空白的添加菜单 ------------------------- */

interface AddNodeMenu {
  /** 菜单锚点（相对画布根，像素）。 */
  left: number;
  top: number;
  /** 打开时指针的画布坐标（新节点落点，居中换算在 addNodeAt 完成）。 */
  flowPoint: { x: number; y: number };
  source: string;
  sourceHandle?: "true" | "false";
}

const addNodeMenu = ref<AddNodeMenu | null>(null);
/** connectStart 时的指针位置：区分「拖线」与「点一下手柄」（后者不弹菜单）。 */
let connectionDragStart = { x: 0, y: 0 };

function onConnectStart(params: { event?: MouseEvent }): void {
  if (params.event) connectionDragStart = { x: params.event.clientX, y: params.event.clientY };
}

function onConnectEnd(event?: MouseEvent): void {
  const start = connectionStartHandle.value;
  const end = connectionEndHandle.value;
  if (start === null || !event) return;
  // 落在其他手柄 / 节点上：交给 onConnect（或无效丢弃），不弹菜单
  if (end !== null && end.nodeId) return;
  const moved =
    Math.abs(event.clientX - connectionDragStart.x) +
    Math.abs(event.clientY - connectionDragStart.y);
  if (moved < 4) return;
  if (props.locked) {
    notifyEditLocked();
    return;
  }
  const rect = root.value?.getBoundingClientRect();
  addNodeMenu.value = {
    left: event.clientX - (rect?.left ?? 0),
    top: event.clientY - (rect?.top ?? 0),
    flowPoint: screenToFlowCoordinate({ x: event.clientX, y: event.clientY }),
    source: start.nodeId,
    sourceHandle: resolveBranchHandle(start.nodeId, start.id),
  };
}

/** 新建一个领域节点并居中落在画布坐标点上（id / 短码对当前图查重）。 */
function addNodeAt(type: WorkflowNodeType, flowPoint: { x: number; y: number }): void {
  const node = createWorkflowNode(
    type,
    {
      x: flowPoint.x - FLOW_NODE_SIZE.width / 2,
      y: flowPoint.y - FLOW_NODE_SIZE.height / 2,
    },
    takenRefKeys(props.nodes),
  );
  emit("structureChange", [...props.nodes, node], props.edges);
}

/** 添加菜单：在拖线落点新建节点并自动连回来源（沿用拖出的分支出口）。 */
function addNodeFromMenu(type: WorkflowNodeType): void {
  const menu = addNodeMenu.value;
  if (menu === null) return;
  if (props.locked) {
    notifyEditLocked();
    return;
  }
  addNodeMenu.value = null;
  const node = createWorkflowNode(
    type,
    {
      x: menu.flowPoint.x - FLOW_NODE_SIZE.width / 2,
      y: menu.flowPoint.y - FLOW_NODE_SIZE.height / 2,
    },
    takenRefKeys(props.nodes),
  );
  emit(
    "structureChange",
    [...props.nodes, node],
    [...props.edges, createWorkflowEdge(menu.source, node.id, menu.sourceHandle)],
  );
}

/* ------------------------------ 面板拖入 ------------------------------ */

function onDragOver(event: DragEvent): void {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

function onDrop(event: DragEvent): void {
  const rawType = event.dataTransfer?.getData(NODE_TYPE_MIME);
  if (!rawType) return;
  event.preventDefault();
  if (props.locked) {
    notifyEditLocked();
    return;
  }
  const meta = WORKFLOW_NODE_META[rawType as WorkflowNodeType];
  if (meta === undefined) return;
  addNodeAt(meta.type, screenToFlowCoordinate({ x: event.clientX, y: event.clientY }));
}

/* ------------------------------ 重命名 ------------------------------ */

/** 双击节点名行内重命名（NodeShell 提交回调；空名与锁定拒绝）。 */
function renameNode(nodeId: string, label: string): void {
  if (props.locked) {
    notifyEditLocked();
    return;
  }
  const trimmed = label.trim();
  if (
    trimmed === "" ||
    !props.nodes.some((node) => node.id === nodeId && (node.label ?? "") !== trimmed)
  ) {
    return;
  }
  emit(
    "structureChange",
    props.nodes.map((node) => (node.id === nodeId ? { ...node, label: trimmed } : node)),
    props.edges,
  );
}
provide(NODE_RENAME_KEY, renameNode);

/* ------------------------------ 布局与视图 ------------------------------ */

function onLayout(): void {
  if (props.locked) {
    notifyEditLocked();
    return;
  }
  const positions = autoLayout(props.nodes, props.edges);
  const changes: GraphPositionChange[] = props.nodes.map((node) => ({
    id: node.id,
    x: positions[node.id]?.x ?? node.position.x,
    y: positions[node.id]?.y ?? node.position.y,
  }));
  const next = applyNodePositions(props.nodes, changes);
  if (next) emit("positionChange", next);
  emit("commitHistory");
}

function onPaneClick(): void {
  addNodeMenu.value = null;
  guides.value = [];
  emit("select", null);
}

function onMoveEnd(moveEvent: { flowTransform: ViewportTransform }): void {
  writeCanvasViewport(props.workflowId, moveEvent.flowTransform);
}

function minimapColor(node: GraphNode): string {
  const meta = getWorkflowNodeMeta(String(node.type));
  return meta.handles === "none" ? "#f6e2a8" : meta.color;
}

/* ------------------------------ 快捷键 ------------------------------ */

/** 画布快捷键是否应被输入控件吞掉（重命名输入框 / 抽屉表单内不触发）。 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

function onKeydown(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || isEditableTarget(event.target)) return;
  const key = event.key.toLowerCase();
  if (key === "z") {
    event.preventDefault();
    if (event.shiftKey) requestRedo();
    else requestUndo();
  } else if (key === "y") {
    event.preventDefault();
    requestRedo();
  } else if (key === "c") {
    if (selectedIds.value.size > 0) {
      event.preventDefault();
      onCopy();
    }
  } else if (key === "v") {
    if (hasNodeClipboard()) {
      event.preventDefault();
      onPaste();
    }
  }
}

function requestUndo(): void {
  if (props.locked) {
    notifyEditLocked();
    return;
  }
  emit("undo");
}

function requestRedo(): void {
  if (props.locked) {
    notifyEditLocked();
    return;
  }
  emit("redo");
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div ref="root" class="flow-canvas-root" @drop="onDrop" @dragover="onDragOver">
    <VueFlow
      class="flow-canvas"
      :nodes="flowNodes"
      :edges="flowEdges"
      :node-types="FLOW_NODE_TYPES"
      :auto-connect="false"
      :delete-key-code="['Delete', 'Backspace']"
      :selection-key-code="true"
      :pan-on-drag="[1, 2]"
      :multi-selection-key-code="['Control', 'Meta']"
      :zoom-on-double-click="false"
      :min-zoom="0.2"
      :max-zoom="2"
      :fit-view-on-init="savedViewport === null"
      :default-viewport="savedViewport ?? undefined"
      @nodes-change="onNodesChange"
      @edges-change="onEdgesChange"
      @connect="onConnect"
      @connect-start="onConnectStart"
      @connect-end="onConnectEnd"
      @node-drag-stop="onDragStop"
      @selection-drag-stop="onDragStop"
      @move-end="onMoveEnd"
      @node-click="(event) => emit('select', String(event.node.id))"
      @pane-click="onPaneClick"
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

    <!-- 对齐辅助线（换算到屏幕坐标渲染在视口容器上） -->
    <div
      v-for="guide in screenGuides"
      :key="`${guide.axis}-${guide.value}`"
      class="flow-alignment-guide"
      :class="guide.axis === 'x' ? 'is-x' : 'is-y'"
      :style="
        guide.axis === 'x'
          ? {
              left: `${guide.value}px`,
              top: `${guide.from}px`,
              height: `${guide.to - guide.from}px`,
            }
          : {
              top: `${guide.value}px`,
              left: `${guide.from}px`,
              width: `${guide.to - guide.from}px`,
            }
      "
    />

    <!-- 拖线到空白的添加菜单（运行期锁定时菜单不打开，此处兜底禁用） -->
    <div
      v-if="addNodeMenu"
      class="flow-add-menu"
      role="menu"
      :style="{ left: `${addNodeMenu.left}px`, top: `${addNodeMenu.top}px` }"
    >
      <div class="flow-add-menu-title">添加节点</div>
      <button
        v-for="type in WORKFLOW_NODE_TYPE_ORDER"
        :key="type"
        type="button"
        role="menuitem"
        class="flow-add-menu-item"
        :disabled="locked"
        :title="locked ? '运行中不可编辑：新增节点请等运行结束' : undefined"
        @click="addNodeFromMenu(type)"
      >
        <span
          class="flow-add-menu-dot"
          :style="{ background: WORKFLOW_NODE_META[type].color }"
          aria-hidden="true"
        />
        {{ WORKFLOW_NODE_META[type].label }}
      </button>
    </div>

    <NodePanel :locked="locked" />
    <CanvasToolbar
      :can-undo="canUndo"
      :can-redo="canRedo"
      :can-copy="canCopy"
      :can-paste="canPaste"
      :locked="locked"
      @undo="requestUndo"
      @redo="requestRedo"
      @layout="onLayout"
      @copy="onCopy"
      @paste="onPaste"
      @zoom-in="zoomIn()"
      @zoom-out="zoomOut()"
      @fit="fitView({ padding: 0.25, maxZoom: 1 })"
    />
  </div>
</template>
