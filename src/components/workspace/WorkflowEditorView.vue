<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import { Io5Close } from "vue-icons-plus/io5";
import { getBackend } from "../../api/runtime-backend";
import Canvas from "../flow/Canvas.vue";
import FlowTopBar from "../flow/FlowTopBar.vue";
import ReplayNodeConfig from "../flow/config/ReplayNodeConfig.vue";
import ConditionBuilder from "../flow/config/ConditionBuilder.vue";
import LoopConfig from "../flow/config/LoopConfig.vue";
import DelayConfig from "../flow/config/DelayConfig.vue";
import SetVariableConfig from "../flow/config/SetVariableConfig.vue";
import AssertConfig from "../flow/config/AssertConfig.vue";
import TransformConfig from "../flow/config/TransformConfig.vue";
import StickyNoteConfig from "../flow/config/StickyNoteConfig.vue";
import ScriptEditor from "../flow/config/ScriptEditor.vue";
import RefIdField from "../flow/config/RefIdField.vue";
import type { ConditionConfigShard } from "../flow/config/condition-tree";
import type { LoopConfigShard } from "../flow/config/loop-config";
import type { DelayConfigShard } from "../flow/config/delay-config";
import type { SetVariableConfigShard } from "../flow/config/set-variable-config";
import type { AssertConfigShard } from "../flow/config/assert-config";
import type { TransformConfigShard } from "../flow/config/transform-config";
import type { StickyNoteConfigShard } from "../flow/config/sticky-note-config";
import NodeIoDrawer from "../flow/NodeIoDrawer.vue";
import { nodeSummary } from "../flow/node-meta";
import { useFlowEditorStore } from "../../stores/flow-editor";
import "../../styles/flow.css";

/**
 * 工作流主区视图（对齐归档编辑器形态）：画布 + 顶部居中悬浮工具条
 * （FlowTopBar：流程名 / 未保存点 / 环境切换 / 校验徽标与问题定位 / 全部
 * 编辑动作，画布动作经 Canvas 的 expose 出口转发）+ 选中节点常驻的入参 /
 * 出参抽屉 + 节点配置抽屉（tab 化：配置 / 前置脚本 / 后置脚本 / 其他信息）。
 * 两个抽屉均绝对定位悬浮于画布右侧（不挤压画布宽度，左缘可拖宽并记忆），
 * z-index 高于悬浮工具条。手风琴导航下由 AppMain 以 KeepAlive 挂载：切换区块不销毁，
 * 画布编辑态保留；生命周期接线（保存快捷键 / 运行监听 / 聚焦请求）见 store
 * 的 mountEditorListeners。
 */
const {
  workflow,
  nodes,
  edges,
  selectedNodeId,
  selectedNode,
  selectedMeta,
  saving,
  validating,
  triggering,
  cancelling,
  exporting,
  canvasKey,
  dirty,
  mergedIssues,
  canUndo,
  canRedo,
  runLocked,
  editorRunStates,
  revealToken,
  envSetOptions,
  activeEnvSetId,
  nodeLabel,
  selectedTakenKeys,
  selectedAvailableNodes,
  selectedVariableNames,
  selectedEnvKeys,
  selectedInputPaths,
  selectedSample,
  selectedTrial,
  selectedTrialPaths,
  refresh,
  save,
  validate,
  triggerRun,
  cancelRun,
  exportCurrentWorkflow,
  switchEnvSet,
  locateNode,
  undoWorkflow,
  redoWorkflow,
  onPositionChange,
  onStructureChange,
  onCommitHistory,
  updateSelectedConfig,
  updateSelectedRefId,
  setActiveFormRef,
  shardView,
  updateSelectedShard,
  loadActiveEnv,
  consumeEditorFocusRequest,
  mountEditorListeners,
} = useFlowEditorStore();

const backend = getBackend();
/** 运行域能力位：缺失时（老后端）不展示运行 / 取消入口。 */
const flowRunApi = backend.flowRuns;
/** 环境集能力位：缺失时工具条不展示切换下拉。 */
const hasEnvApi = backend.envSets !== undefined;

/** 多入口运行：流程内的全部 start 节点（label 缺省回退「开始」）；单个时
 * 运行按钮保持单击直发，多个时「运行」变入口选择下拉。 */
const startEntries = computed(() =>
  (workflow.value?.nodes ?? [])
    .filter((node) => node.type === "start")
    .map((node) => ({ id: node.id, label: node.label?.trim() || "开始" })),
);

const root = ref<HTMLElement | null>(null);

/** 画布实例（悬浮工具条的画布动作转发出口；expose 见 Canvas.vue）。 */
const canvasRef = ref<InstanceType<typeof Canvas> | null>(null);
/** 复制 / 粘贴可用态转发（画布内部选中与剪贴板状态的只读出口）。 */
const canCopy = computed(() => canvasRef.value?.canCopy === true);
const canPaste = computed(() => canvasRef.value?.canPaste === true);

function onKeydown(event: KeyboardEvent): void {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "s" &&
    root.value?.contains(document.activeElement)
  ) {
    event.preventDefault();
    void save();
  }
}

/** 校验问题条目定位：取首个关联节点，选中并平滑居中。 */
function locateIssue(issue: { nodeIds: readonly string[] }): void {
  const nodeId = issue.nodeIds[0];
  if (nodeId !== undefined) locateNode(nodeId);
}

let disposeListeners: (() => void) | null = null;

/* -------------------- 悬浮抽屉宽度（左缘拖宽 + localStorage 记忆） -------------------- */

const DRAWER_MIN = 360;
const DRAWER_MAX = 760;
const IO_MIN = 220;
const IO_MAX = 480;
const DRAWER_STORAGE_KEY = "proxycrab.flowDrawerWidth";
const IO_STORAGE_KEY = "proxycrab.flowIoWidth";

/** 抽屉宽度上限按窗口尺寸夹紧：配置抽屉不超窗宽 70%，IO 抽屉不超 40%（留出画布）。 */
function drawerMaxWidth(): number {
  return Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, Math.floor(window.innerWidth * 0.7)));
}
function ioMaxWidth(): number {
  return Math.min(IO_MAX, Math.max(IO_MIN, Math.floor(window.innerWidth * 0.4)));
}

/** 闭区间夹取。 */
function clampWidth(w: number, min: number, max: number): number {
  return Math.min(Math.max(w, min), max);
}

/** 读取记忆宽度；无记忆时沿用原响应式默认（40vw / 24vw），恢复首次进入的形态。 */
function savedWidth(key: string, fallback: () => number, min: number, maxOf: () => number): number {
  const saved = Number(localStorage.getItem(key));
  return Number.isFinite(saved)
    ? clampWidth(saved, min, maxOf())
    : clampWidth(fallback(), min, maxOf());
}

const drawerW = ref(
  savedWidth(
    DRAWER_STORAGE_KEY,
    () => Math.floor(window.innerWidth * 0.4),
    DRAWER_MIN,
    drawerMaxWidth,
  ),
);
const ioW = ref(
  savedWidth(IO_STORAGE_KEY, () => Math.floor(window.innerWidth * 0.24), IO_MIN, ioMaxWidth),
);

/**
 * 抽屉拖宽（交互惯例同 SessionSidebar 的 sb-resize）：Pointer Capture 跟踪，
 * 松手落 localStorage。growDir 为拖宽方向：-1 左缘手柄（向左拖增宽，右缘
 * 固定的配置抽屉），+1 右缘手柄（向右拖增宽，左缘固定的入参出参抽屉）。
 * 返回 v-on 对象（键为事件名）。
 */
function widthDrag(
  width: Ref<number>,
  min: number,
  maxOf: () => number,
  key: string,
  growDir: -1 | 1,
) {
  let startX = 0;
  let startW = 0;
  let dragging = false;

  /** 结束拖拽：释放捕获、恢复文本选择、记忆当前宽度。 */
  function finish(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    document.body.style.userSelect = "";
    localStorage.setItem(key, String(width.value));
  }
  return {
    pointerdown(e: PointerEvent): void {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startW = width.value;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault();
      document.body.style.userSelect = "none";
    },
    pointermove(e: PointerEvent): void {
      if (!dragging) return;
      width.value = clampWidth(Math.round(startW + growDir * (e.clientX - startX)), min, maxOf());
    },
    pointerup: finish,
    pointercancel: finish,
  };
}

const drawerDrag = widthDrag(drawerW, DRAWER_MIN, drawerMaxWidth, DRAWER_STORAGE_KEY, -1);
const ioDrag = widthDrag(ioW, IO_MIN, ioMaxWidth, IO_STORAGE_KEY, 1);

/** 窗口尺寸变化后夹紧两抽屉宽度（惯例同 SessionSidebar 的 onWindowResize）。 */
function onWindowResize(): void {
  drawerW.value = clampWidth(drawerW.value, DRAWER_MIN, drawerMaxWidth());
  ioW.value = clampWidth(ioW.value, IO_MIN, ioMaxWidth());
}

/** 下发两抽屉运行时宽度变量；配置抽屉缺位时不发 --wf-drawer-w（无引用方）。 */
const rootStyle = computed(() => {
  const style: Record<string, string> = { "--wf-io-w": `${ioW.value}px` };
  if (selectedNode.value && selectedMeta.value) style["--wf-drawer-w"] = `${drawerW.value}px`;
  return style;
});

/* ------------------------------ 配置抽屉 tab ------------------------------ */

/** 抽屉内容 tab：config 请求配置 / pre·post 前后置脚本 / info 其他信息。 */
type DrawerTab = "config" | "pre" | "post" | "info";
const drawerTab = ref<DrawerTab>("config");
/** 入参 / 出参抽屉的手动关闭标记（随选中节点切换复位）。 */
const ioDismissed = ref(false);

watch(
  () => selectedNode.value?.id ?? null,
  () => {
    drawerTab.value = "config";
    ioDismissed.value = false;
  },
);

/** 前置 / 后置脚本已配置标记（tab 上挂点提示）。 */
const preConfigured = computed(() => scriptText("preProcess").trim() !== "");
const postConfigured = computed(() => scriptText("postProcess").trim() !== "");

/** 形状防御读取选中节点 config 里的脚本字段。 */
function scriptText(key: "preProcess" | "postProcess"): string {
  const raw = selectedNode.value?.config?.[key];
  return typeof raw === "string" ? raw : "";
}

/** 脚本 tab 编辑上抛：空值删键，其余整体替换 config（与 store 落库口径一致）。 */
function updateScript(side: "pre" | "post", value: string): void {
  const node = selectedNode.value;
  if (!node) return;
  const key = side === "pre" ? "preProcess" : "postProcess";
  const config: Record<string, unknown> = { ...node.config };
  if (value.trim() === "") delete config[key];
  else config[key] = value;
  updateSelectedConfig(config);
}

/** 选中节点的脚本试跑样本归属（ScriptEditor 会话态；无流程不并入）。 */
const scriptTrialKey = computed(() =>
  workflow.value && selectedNode.value
    ? { workflowId: workflow.value.id, nodeId: selectedNode.value.id }
    : null,
);

// 定位令牌变化 → 画布平滑居中到选中节点（聚焦请求 / 问题定位共用）；
// nextTick 等 Canvas 挂载完成（聚焦请求可能在画布尚未挂载时到达）。
watch(revealToken, () => {
  const nodeId = selectedNode.value?.id;
  if (nodeId === undefined) return;
  void nextTick(() => canvasRef.value?.revealNode(nodeId));
});

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onWindowResize);
  disposeListeners = mountEditorListeners();
  void refresh();
  void loadActiveEnv();
  // 兜底消费挂载前到达的「在编辑器打开」聚焦请求（切区块才挂载的时序）。
  void consumeEditorFocusRequest();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onWindowResize);
  disposeListeners?.();
  disposeListeners = null;
});
</script>

<template>
  <div ref="root" class="wf-root" :style="rootStyle">
    <section class="wf-main">
      <div class="wf-canvas-wrap">
        <Canvas
          v-if="workflow"
          :key="canvasKey"
          ref="canvasRef"
          :nodes="nodes"
          :edges="edges"
          :workflow-id="workflow.id"
          :locked="runLocked"
          :can-undo="canUndo"
          :can-redo="canRedo"
          :issues="mergedIssues"
          :run-states="editorRunStates"
          @position-change="onPositionChange"
          @structure-change="onStructureChange"
          @commit-history="onCommitHistory"
          @undo="undoWorkflow"
          @redo="redoWorkflow"
          @select="selectedNodeId = $event"
        />
        <div v-else class="empty-hint wf-canvas-empty">从左侧选择或新建流程</div>

        <!-- 顶部居中悬浮工具条（归档形态：单条聚合全部动作） -->
        <FlowTopBar
          v-if="workflow"
          :workflow-name="workflow.name"
          :dirty="dirty"
          :saving="saving"
          :validating="validating"
          :exporting="exporting"
          :triggering="triggering"
          :cancelling="cancelling"
          :locked="runLocked"
          :can-undo="canUndo"
          :can-redo="canRedo"
          :can-copy="canCopy"
          :can-paste="canPaste"
          :has-run-api="flowRunApi !== undefined"
          :has-env-api="hasEnvApi"
          :env-options="envSetOptions"
          :active-env-id="activeEnvSetId"
          :issues="mergedIssues"
          :start-entries="startEntries"
          @save="save"
          @validate="validate"
          @run="triggerRun"
          @cancel="cancelRun"
          @export="exportCurrentWorkflow"
          @env-change="switchEnvSet($event)"
          @locate="locateIssue"
          @refresh="refresh"
          @undo="canvasRef?.requestUndo()"
          @redo="canvasRef?.requestRedo()"
          @layout="canvasRef?.autoLayout()"
          @copy="canvasRef?.copySelected()"
          @paste="canvasRef?.pasteClipboard()"
          @zoom-in="canvasRef?.zoomIn()"
          @zoom-out="canvasRef?.zoomOut()"
          @fit="canvasRef?.fitAll()"
        />
      </div>
    </section>

    <!-- 节点数据抽屉（入参 / 出参）：选中节点时贴画布左缘（与右侧配置抽屉
         对称分居两侧），试跑样本会话态注入。组件本体是 fixed 定位，经定位层
         覆盖为 slot 内的绝对定位。 -->
    <div v-if="selectedNode && !ioDismissed" class="wf-io-slot">
      <div class="wf-resize wf-resize-right" title="拖动调整抽屉宽度" v-on="ioDrag" />
      <NodeIoDrawer
        :node-ref-id="selectedNode.refId ?? selectedNode.id"
        :node-label="nodeLabel(selectedNode)"
        :input-sample="selectedTrial?.input ?? null"
        :output-sample="selectedTrial?.output ?? null"
        :trial-paths="selectedTrialPaths"
        @close="ioDismissed = true"
      />
    </div>

    <aside v-if="selectedNode && selectedMeta" class="wf-drawer">
      <div class="wf-resize" title="拖动调整抽屉宽度" v-on="drawerDrag" />
      <div class="wf-drawer-head">
        <span class="wf-drawer-dot" :style="{ background: selectedMeta.color }" />
        <span class="wf-drawer-title" :title="nodeLabel(selectedNode)">{{
          nodeLabel(selectedNode)
        }}</span>
        <button class="btn icon" title="关闭" @click="selectedNodeId = null">
          <Io5Close :size="14" />
        </button>
      </div>

      <!-- 抽屉内容 tab：请求配置 / 前置脚本 / 后置脚本 / 其他信息 -->
      <div class="wf-drawer-tabs" role="tablist" aria-label="节点配置分页">
        <button
          class="wf-drawer-tab"
          :class="{ active: drawerTab === 'config' }"
          role="tab"
          :aria-selected="drawerTab === 'config'"
          @click="drawerTab = 'config'"
        >
          {{ selectedNode.type === "httpReplay" ? "请求" : "配置" }}
        </button>
        <template v-if="selectedNode.type === 'httpReplay'">
          <button
            class="wf-drawer-tab"
            :class="{ active: drawerTab === 'pre' }"
            role="tab"
            :aria-selected="drawerTab === 'pre'"
            @click="drawerTab = 'pre'"
          >
            前置脚本<span v-if="preConfigured" class="wf-drawer-tab-dot" title="已配置脚本" />
          </button>
          <button
            class="wf-drawer-tab"
            :class="{ active: drawerTab === 'post' }"
            role="tab"
            :aria-selected="drawerTab === 'post'"
            @click="drawerTab = 'post'"
          >
            后置脚本<span v-if="postConfigured" class="wf-drawer-tab-dot" title="已配置脚本" />
          </button>
        </template>
        <button
          class="wf-drawer-tab"
          :class="{ active: drawerTab === 'info' }"
          role="tab"
          :aria-selected="drawerTab === 'info'"
          @click="drawerTab = 'info'"
        >
          其他信息
        </button>
      </div>

      <div v-if="drawerTab === 'info'" class="wf-drawer-body">
        <div class="wf-field">
          <span class="wf-field-label">类型</span>
          <span>{{ selectedMeta.label }}</span>
        </div>
        <div class="wf-field">
          <span class="wf-field-label">说明</span>
          <span class="text-secondary">{{ selectedMeta.description }}</span>
        </div>
        <div class="wf-field">
          <span class="wf-field-label">节点 ID</span>
          <span class="mono">{{ selectedNode.id }}</span>
        </div>
        <div v-if="selectedNode.type === 'httpReplay'" class="wf-field">
          <span class="wf-field-label">引用短码</span>
          <RefIdField
            :ref-id="selectedNode.refId ?? null"
            :taken-keys="selectedTakenKeys"
            :disabled="runLocked"
            @update:ref-id="updateSelectedRefId"
          />
        </div>
        <div v-else class="wf-field">
          <span class="wf-field-label">引用短码</span>
          <span class="mono">{{ selectedNode.refId ?? "—" }}</span>
        </div>
        <div class="wf-field">
          <span class="wf-field-label">配置摘要</span>
          <span class="text-secondary">{{ nodeSummary(selectedNode) }}</span>
        </div>
      </div>

      <div v-else-if="drawerTab === 'pre' || drawerTab === 'post'" class="wf-drawer-body">
        <ScriptEditor
          :key="`${selectedNode.id}:${drawerTab}`"
          :side="drawerTab"
          :model-value="scriptText(drawerTab === 'pre' ? 'preProcess' : 'postProcess')"
          :disabled="runLocked"
          editor-height="18em"
          :trial-key="scriptTrialKey"
          @update:model-value="updateScript(drawerTab, $event)"
        />
      </div>

      <div v-else class="wf-drawer-body">
        <ReplayNodeConfig
          v-if="selectedNode.type === 'httpReplay'"
          :key="selectedNode.id"
          :node="selectedNode"
          :available-node-ids="selectedAvailableNodes"
          :variable-names="selectedVariableNames"
          :env-keys="selectedEnvKeys"
          :input-paths="selectedInputPaths"
          :sample="selectedSample"
          @update:config="updateSelectedConfig"
        />
        <template v-else>
          <ConditionBuilder
            v-if="selectedNode.type === 'condition'"
            :key="selectedNode.id"
            :ref="setActiveFormRef"
            :model-value="shardView<ConditionConfigShard>()"
            :variable-names="selectedVariableNames"
            :input-paths="selectedInputPaths"
            :available-node-ids="selectedAvailableNodes"
            :disabled="runLocked"
            @update:model-value="updateSelectedShard"
          />
          <LoopConfig
            v-else-if="selectedNode.type === 'loop'"
            :key="selectedNode.id"
            :ref="setActiveFormRef"
            :model-value="shardView<LoopConfigShard>()"
            :disabled="runLocked"
            @update:model-value="updateSelectedShard"
          />
          <DelayConfig
            v-else-if="selectedNode.type === 'delay'"
            :key="selectedNode.id"
            :ref="setActiveFormRef"
            :model-value="shardView<DelayConfigShard>()"
            :disabled="runLocked"
            @update:model-value="updateSelectedShard"
          />
          <SetVariableConfig
            v-else-if="selectedNode.type === 'setVariable'"
            :key="selectedNode.id"
            :ref="setActiveFormRef"
            :model-value="shardView<SetVariableConfigShard>()"
            :node-options="selectedAvailableNodes"
            :disabled="runLocked"
            @update:model-value="updateSelectedShard"
          />
          <AssertConfig
            v-else-if="selectedNode.type === 'assert'"
            :key="selectedNode.id"
            :ref="setActiveFormRef"
            :model-value="shardView<AssertConfigShard>()"
            :disabled="runLocked"
            @update:model-value="updateSelectedShard"
          />
          <TransformConfig
            v-else-if="selectedNode.type === 'transform'"
            :key="selectedNode.id"
            :ref="setActiveFormRef"
            :model-value="shardView<TransformConfigShard>()"
            :disabled="runLocked"
            @update:model-value="updateSelectedShard"
          />
          <StickyNoteConfig
            v-else-if="selectedNode.type === 'stickyNote'"
            :key="selectedNode.id"
            :ref="setActiveFormRef"
            :model-value="shardView<StickyNoteConfigShard>()"
            :disabled="runLocked"
            @update:model-value="updateSelectedShard"
          />
          <div v-else class="wf-drawer-hint text-faint">节点配置编辑将在后续任务提供</div>
        </template>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.wf-root {
  flex: 1;
  min-height: 0;
  display: flex;
  /* 画布区两侧悬浮抽屉的定位基准；抽屉宽度经 rootStyle 内联变量下发。 */
  position: relative;
}

/* ---------- 中间：画布（工具条悬浮其上） ---------- */

.wf-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.wf-canvas-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.wf-canvas-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

/* ---------- 右侧：节点配置抽屉（加宽，归档密度；悬浮于画布之上） ---------- */

.wf-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  /* 高于画布浮层（悬浮工具条 z-10 / 问题面板与加节点菜单 z-20），
   * 与窗面弹层级（RequestPicker / 入参出参抽屉）同层。 */
  z-index: 30;
  width: var(--wf-drawer-w);
  display: flex;
  flex-direction: column;
  /* 悬浮层不透明：遮住下垫画布（bg-panel 随主题切换）。 */
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
}

.wf-drawer-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  flex: none;
}

.wf-drawer-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
}

.wf-drawer-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wf-drawer-tabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3) 0;
  border-bottom: 1px solid var(--border);
}

.wf-drawer-tab {
  position: relative;
  padding: 3px 10px 4px;
  border: none;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: none;
  color: var(--text-faint);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.wf-drawer-tab:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.wf-drawer-tab.active {
  background: var(--bg-active);
  color: var(--text);
  font-weight: 600;
}

.wf-drawer-tab-dot {
  position: absolute;
  top: 4px;
  right: 2px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}

.wf-drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.wf-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.wf-field-label {
  font-size: 11px;
  color: var(--text-faint);
}

.wf-field > span:last-child {
  overflow-wrap: anywhere;
}

.wf-drawer-hint {
  margin-top: var(--space-2);
  font-size: 12px;
}

/* ---------- 节点数据抽屉槽位（贴画布左缘，与右侧配置抽屉对称） ---------- */

/* NodeIoDrawer 本体 fixed 定位（组件只读复用）：槽位内覆盖为占满槽位的
 * 绝对定位，宽度收窄为侧栏（组件缺省 min(480px,100vw)）。 */
.wf-io-slot {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 30;
  width: var(--wf-io-w);
}

/* 抽屉拖宽手柄（视觉与交互惯例同 SessionSidebar 的 sb-resize）：缺省贴
 * 左缘（配置抽屉，向左拖增宽），wf-resize-right 贴右缘（入参出参抽屉）。 */
.wf-resize {
  position: absolute;
  top: 0;
  left: 0;
  width: 5px;
  height: 100%;
  z-index: 10;
  cursor: col-resize;
  touch-action: none;
}
.wf-resize-right {
  left: auto;
  right: 0;
}
.wf-resize::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 2px;
  height: 100%;
  background: transparent;
  transition: background 0.12s;
}
.wf-resize-right::after {
  left: auto;
  right: 0;
}
.wf-resize:hover::after,
.wf-resize:active::after {
  background: var(--accent);
}

.wf-io-slot :deep(.io-drawer) {
  position: absolute;
  inset: 0;
  z-index: auto;
  width: 100%;
  border-right: 1px solid var(--border);
  box-shadow: none;
}
</style>
