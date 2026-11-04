<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Io5Add, Io5Close, Io5Refresh, Io5Save, Io5Trash } from "vue-icons-plus/io5";
import { useBackend } from "../api";
import type {
  FlowProject,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeConfig,
  WorkflowValidationIssue,
} from "../api/types";
import Canvas from "../components/flow/Canvas.vue";
import type { SuggestNodeOption } from "../components/expression-input/expression-suggest";
import type {
  NodeSampleEntry,
  TemplateSampleContext,
} from "../components/expression-input/use-expression-preview";
import {
  commitGraph,
  createGraphHistory,
  redoGraph,
  undoGraph,
  type GraphHistoryState,
} from "../components/flow/graph-history";
import { graphSignature, starterGraph } from "../components/flow/graph-model";
import {
  collectLocalIssues,
  mergeIssues,
  type NodeIssue,
} from "../components/flow/node-issue-badge";
import { notifyEditLocked } from "../components/flow/canvas-edit-lock";
import { getWorkflowNodeMeta, nodeSummary } from "../components/flow/node-meta";
import {
  mergeConfigShard,
  NODE_SHARD_KEYS,
  takenRefKeys,
} from "../components/flow/config/node-config";
import ReplayNodeConfig from "../components/flow/config/ReplayNodeConfig.vue";
import ConditionBuilder from "../components/flow/config/ConditionBuilder.vue";
import LoopConfig from "../components/flow/config/LoopConfig.vue";
import DelayConfig from "../components/flow/config/DelayConfig.vue";
import SetVariableConfig from "../components/flow/config/SetVariableConfig.vue";
import AssertConfig from "../components/flow/config/AssertConfig.vue";
import TransformConfig from "../components/flow/config/TransformConfig.vue";
import StickyNoteConfig from "../components/flow/config/StickyNoteConfig.vue";
import type { ConditionConfigShard } from "../components/flow/config/condition-tree";
import type { LoopConfigShard } from "../components/flow/config/loop-config";
import type { DelayConfigShard } from "../components/flow/config/delay-config";
import type { SetVariableConfigShard } from "../components/flow/config/set-variable-config";
import type { AssertConfigShard } from "../components/flow/config/assert-config";
import type { TransformConfigShard } from "../components/flow/config/transform-config";
import type { StickyNoteConfigShard } from "../components/flow/config/sticky-note-config";
import NodeIoDrawer from "../components/flow/NodeIoDrawer.vue";
import { collectJsonPaths } from "../components/expression-input/input-paths";
import { appStore, reportError } from "../stores/app";
import { confirmDialog } from "../stores/dialog";
import { flowRunStore } from "../stores/flow-run";
import { flowTrialStore } from "../stores/flow-trial";
import { windowsStore } from "../stores/windows";
import "../styles/flow.css";

/**
 * 工作流编辑器窗口（Task 12 骨架 + Task 13 交互接线）：左侧项目 / 流程两级
 * 列表、中间 Vue Flow 画布（结构编辑 / 撤销重做 / 校验徽标）、右侧节点配置
 * 抽屉（占位，Task 14–16 填充表单）。显式保存（图整体替换）+ 离开守卫，
 * 对齐仓库「无自动保存」惯例；入口依赖 Backend.workflows 能力位（launcher
 * 把关）。
 */
const WINDOW_ID = "workflow-editor";

const backend = useBackend();
// 能力位由 launcher 检查后才可能挂载本窗口。
const api = backend.workflows!;

const projects = ref<FlowProject[]>([]);
const workflows = ref<Workflow[]>([]);
const projectId = ref<string | null>(null);
/** 当前打开的流程定义（基线）；nodes/edges 为画布实时编辑态。 */
const workflow = ref<Workflow | null>(null);
const nodes = ref<WorkflowNode[]>([]);
const edges = ref<WorkflowEdge[]>([]);
const selectedNodeId = ref<string | null>(null);
/** 服务端校验结果（「校验」动作拉取；本地即时校验见 localIssues）。 */
const serverIssues = ref<WorkflowValidationIssue[]>([]);
/** 图快照历史（Task 13 Step 3）：结构化编辑提交帧，撤销 / 重做在帧间交换。 */
const history = ref<GraphHistoryState>(createGraphHistory([], []));

const loading = ref(false);
const loadingWorkflows = ref(false);
const saving = ref(false);
const validating = ref(false);
const newProjectName = ref("");
const newWorkflowName = ref("");
/** 画布重挂载计数：切换流程后重新 fit-view。 */
const canvasKey = ref(0);
const root = ref<HTMLElement | null>(null);

const dirty = computed(() => {
  if (!workflow.value) return false;
  return (
    graphSignature(nodes.value, edges.value) !==
    graphSignature(workflow.value.nodes, workflow.value.edges)
  );
});

/** 本地即时校验（对齐后端 error 口径 + 前端 warning / info），图一变即重算。 */
const localIssues = computed<NodeIssue[]>(() => collectLocalIssues(nodes.value, edges.value));

/** 合并后的问题清单（服务端权威在前）：画布徽标与校验面板共用。 */
const mergedIssues = computed<NodeIssue[]>(() =>
  mergeIssues(localIssues.value, serverIssues.value),
);

const canUndo = computed(() => history.value.past.length > 0);
const canRedo = computed(() => history.value.future.length > 0);

/** 运行期画布编辑锁定（运行态来源见 stores/flow-run.ts 接缝；Task 19 接真实 API）。 */
const runLocked = computed(
  () => workflow.value !== null && flowRunStore.runningWorkflowId === workflow.value.id,
);

const selectedNode = computed<WorkflowNode | null>(() => {
  if (selectedNodeId.value === null) return null;
  return nodes.value.find((node) => node.id === selectedNodeId.value) ?? null;
});

const selectedMeta = computed(() =>
  selectedNode.value ? getWorkflowNodeMeta(selectedNode.value.type) : null,
);

/** 流程内已占用短码键集合（节点 id + 既有短码），供引用短码编辑查重。 */
const selectedTakenKeys = computed(() => takenRefKeys(nodes.value));

/** 就地替换画布节点（配置 / 引用短码编辑上抛时）。 */
function replaceNode(next: WorkflowNode): void {
  const index = nodes.value.findIndex((node) => node.id === next.id);
  if (index >= 0) {
    nodes.value = nodes.value.map((node, current) => (current === index ? next : node));
  }
}

function updateSelectedConfig(config: WorkflowNodeConfig): void {
  if (selectedNode.value) replaceNode({ ...selectedNode.value, config });
}

function updateSelectedRefId(refId: string | null): void {
  const node = selectedNode.value;
  if (!node) return;
  const next = { ...node };
  if (refId === null) delete next.refId;
  else next.refId = refId;
  replaceNode(next);
}

// ---------- 逻辑节点配置表单接线（Task 16 薄片 B） ----------

/** 逻辑节点配置表单的保存门控面（各 16A 表单 defineExpose validate()）。 */
interface ConfigFormInstance {
  validate: () => string | null;
}

/** 当前挂载的选中节点配置表单（按类型分派互斥，任意时刻至多挂一个）。 */
const activeFormRef = ref<ConfigFormInstance | null>(null);

/** 选中节点 config 的分片视图（表单按各自键域防御读取，多余键忽略）。 */
function shardView<T extends object>(): T {
  const config: WorkflowNodeConfig | undefined = selectedNode.value?.config;
  return (config ?? {}) as T;
}

/** 分片表单上抛：按节点类型的分片键域合并回 config（缺席键删除），再走既有整体替换。 */
function updateSelectedShard(shard: object): void {
  const node = selectedNode.value;
  const domainKeys = node ? NODE_SHARD_KEYS[node.type] : undefined;
  if (!node || !domainKeys) return;
  updateSelectedConfig(mergeConfigShard(node.config, shard, domainKeys));
}

function nodeLabel(node: WorkflowNode): string {
  const custom = node.label?.trim();
  return custom ? custom : getWorkflowNodeMeta(node.type).label;
}

/** 沿连线反向收集节点的上游闭包（含间接上游；不含自身，按发现顺序）。 */
function upstreamClosure(nodeId: string): string[] {
  const incoming = new Map<string, string[]>();
  for (const edge of edges.value) {
    const list = incoming.get(edge.target);
    if (list) list.push(edge.source);
    else incoming.set(edge.target, [edge.source]);
  }
  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const source of incoming.get(current) ?? []) {
      if (seen.has(source)) continue;
      seen.add(source);
      order.push(source);
      queue.push(source);
    }
  }
  return order;
}

/** 选中节点的上游闭包集合（候选清单与样本上下文共用）。 */
const selectedUpstreamIds = computed<ReadonlySet<string>>(() => {
  const node = selectedNode.value;
  return node ? new Set(upstreamClosure(node.id)) : new Set<string>();
});

/** 上游可引用节点候选（表达式提示第二级；id 为模板引用键 refId ?? id）。 */
const selectedAvailableNodes = computed<SuggestNodeOption[]>(() => {
  const node = selectedNode.value;
  if (!node) return [];
  return [...selectedUpstreamIds.value]
    .map((id) => nodes.value.find((item) => item.id === id))
    .filter((item): item is WorkflowNode => item !== undefined)
    .map((item) => ({ id: item.refId ?? item.id, label: nodeLabel(item) }));
});

/** 可引用变量名（流程级普通变量；secret 变量不入候选防明文回显）。 */
const selectedVariableNames = computed<readonly string[]>(() =>
  Object.keys(workflow.value?.variables ?? {}),
);

// ---------- 试跑样本会话态 → 表达式样本上下文（Task 15 薄片 C Step 4） ----------

/**
 * 激活环境集合 + 全局变量的普通键值表（env.<key> 求值样本；secret 值不入表
 * 防明文回显）。服务端运行时的合并序以宿主供给为准，此处按「激活集合覆盖
 * 全局」近似；能力位缺失或加载失败置 null（env 引用按无激活环境告警）。
 */
const activeEnvTable = ref<Record<string, string> | null>(null);

async function loadActiveEnv(): Promise<void> {
  const envSets = backend.envSets;
  if (!envSets) {
    activeEnvTable.value = null;
    return;
  }
  try {
    const payload = await envSets.get();
    const active = payload.sets.find((set) => set.id === payload.activeSetId);
    activeEnvTable.value = { ...payload.globals.values, ...(active ? active.values : {}) };
  } catch {
    activeEnvTable.value = null;
  }
}

/** env. 键名候选（激活集合 + 全局；表未加载时不出现 env. 根）。 */
const selectedEnvKeys = computed<readonly string[] | undefined>(() =>
  activeEnvTable.value ? Object.keys(activeEnvTable.value) : undefined,
);

/** 入参字段路径候选（试跑样本派生；无样本为空清单）。 */
const selectedInputPaths = computed<readonly string[]>(() =>
  collectJsonPaths(selectedTrial.value?.input ?? null),
);

/**
 * 选中节点的表达式样本上下文（配置面表达式输入的深路径候选 + 求值预览）。
 * 样本当前仅来自编辑器内脚本试跑（节点级试跑 API 缺口见 stores/flow-trial.ts）：
 * 入参 = pre 试跑样例 input；上游 / 全图节点输出 = 各节点 post 试跑返回值
 * （键为模板引用键 refId ?? id，与执行器运行时上下文同口径；upstreamSamples
 * 只含上游闭包，对齐运行时「渲染该节点时上下文里只有已完成节点」）。
 */
const selectedSample = computed<TemplateSampleContext | null>(() => {
  const wf = workflow.value;
  const node = selectedNode.value;
  if (!wf || !node) return null;
  const upstreamSamples: Record<string, NodeSampleEntry> = {};
  const nodeSamples: Record<string, NodeSampleEntry> = {};
  for (const item of nodes.value) {
    const trial = flowTrialStore.get(wf.id, item.id);
    if (trial?.output === undefined) continue;
    const entry: NodeSampleEntry = { sample: trial.output, source: "run" };
    nodeSamples[item.refId ?? item.id] = entry;
    if (selectedUpstreamIds.value.has(item.id)) upstreamSamples[item.refId ?? item.id] = entry;
  }
  const trial = flowTrialStore.get(wf.id, node.id);
  return {
    input: trial?.input ?? null,
    inputSource: trial?.input !== undefined ? "run" : "none",
    upstreamSamples,
    nodeSamples,
    variables: { ...wf.variables },
    ...(activeEnvTable.value !== null ? { env: activeEnvTable.value } : {}),
  };
});

// ---------- IO 抽屉（Task 15 薄片 C Step 3/4） ----------

/** 节点数据抽屉（入参 / 出参）开关：随选中节点挂载，选中切换保持开启。 */
const ioDrawerOpen = ref(false);

/** 选中节点的试跑样本（编辑器内脚本试跑产出；会话态见 stores/flow-trial.ts） */
const selectedTrial = computed(() =>
  workflow.value && selectedNode.value
    ? flowTrialStore.get(workflow.value.id, selectedNode.value.id)
    : null,
);

/** 试跑徽标路径集：试跑样本经 collectJsonPaths 派生（入参 / 出参合并——同
 * path 在两组命中都标注，语义为「该字段来自试跑结果」）。 */
const selectedTrialPaths = computed<readonly string[]>(() => {
  const trial = selectedTrial.value;
  if (!trial) return [];
  return [...collectJsonPaths(trial.input ?? null), ...collectJsonPaths(trial.output ?? null)];
});

/** 列表行时间展示（Unix 毫秒 → 月-日 时:分）。 */
function fmtTime(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    projects.value = (await api.listProjects()).projects;
    if (projectId.value && !projects.value.some((project) => project.id === projectId.value)) {
      await selectProject(null);
    }
  } catch (error) {
    reportError(error, "加载项目失败");
  } finally {
    loading.value = false;
  }
}

/** 关闭当前流程（有脏数据先确认）；返回是否已关闭。 */
async function confirmDiscard(): Promise<boolean> {
  if (!dirty.value) return true;
  return confirmDialog({
    title: "未保存的修改",
    message: "当前流程有未保存的修改，关闭后将丢失。确定放弃修改吗？",
    confirmText: "放弃修改",
    danger: true,
  });
}

async function selectProject(id: string | null): Promise<void> {
  projectId.value = id;
  workflows.value = [];
  if (id === null) return;
  loadingWorkflows.value = true;
  try {
    workflows.value = (await api.listWorkflows(id)).workflows;
  } catch (error) {
    reportError(error, "加载流程列表失败");
  } finally {
    loadingWorkflows.value = false;
  }
}

async function selectWorkflow(target: Workflow): Promise<void> {
  if (workflow.value?.id === target.id) return;
  if (!(await confirmDiscard())) return;
  try {
    const loaded = await api.getWorkflow(target.id);
    workflow.value = loaded;
    nodes.value = loaded.nodes.map((node) => ({ ...node, position: { ...node.position } }));
    edges.value = loaded.edges.map((edge) => ({ ...edge }));
    selectedNodeId.value = null;
    serverIssues.value = [];
    history.value = createGraphHistory(nodes.value, edges.value);
    canvasKey.value += 1;
    void loadActiveEnv();
  } catch (error) {
    reportError(error, "加载流程失败");
  }
}

/** 关闭当前流程时清空画布编辑态（含历史与校验）与试跑样本会话态。 */
function closeWorkflowEditor(): void {
  if (workflow.value) flowTrialStore.clearWorkflow(workflow.value.id);
  workflow.value = null;
  nodes.value = [];
  edges.value = [];
  selectedNodeId.value = null;
  serverIssues.value = [];
  ioDrawerOpen.value = false;
  history.value = createGraphHistory([], []);
}

async function createProject(): Promise<void> {
  const name = newProjectName.value.trim();
  if (name === "") return;
  try {
    const created = await api.createProject({ name });
    newProjectName.value = "";
    await refresh();
    await selectProject(created.id);
  } catch (error) {
    reportError(error, "新建项目失败");
  }
}

async function createWorkflow(): Promise<void> {
  const name = newWorkflowName.value.trim();
  if (name === "" || projectId.value === null) return;
  try {
    const created = await api.createWorkflow({
      projectId: projectId.value,
      name,
      ...starterGraph(),
    });
    newWorkflowName.value = "";
    await selectProject(projectId.value);
    await selectWorkflow(created);
  } catch (error) {
    reportError(error, "新建流程失败");
  }
}

async function removeProject(project: FlowProject): Promise<void> {
  const ok = await confirmDialog({
    title: "删除项目",
    message: `确定删除项目「${project.name}」吗？项目下的流程不会被级联删除。`,
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteProject(project.id);
    if (workflow.value && workflow.value.projectId === project.id) {
      closeWorkflowEditor();
    }
    await refresh();
  } catch (error) {
    reportError(error, "删除项目失败");
  }
}

async function removeWorkflow(target: Workflow): Promise<void> {
  const ok = await confirmDialog({
    title: "删除流程",
    message: `确定删除流程「${target.name}」吗？删除后不可恢复。`,
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteWorkflow(target.id);
    if (workflow.value?.id === target.id) {
      closeWorkflowEditor();
    }
    if (projectId.value) await selectProject(projectId.value);
  } catch (error) {
    reportError(error, "删除流程失败");
  }
}

function onPositionChange(next: WorkflowNode[]): void {
  nodes.value = next;
}

/**
 * 结构化编辑（画布增删节点 / 连线、重命名、粘贴）：整体替换画布图并提交
 * 一帧历史（commitGraph 按签名去重，内容未变不产生新帧）。
 */
function onStructureChange(nextNodes: WorkflowNode[], nextEdges: WorkflowEdge[]): void {
  nodes.value = nextNodes;
  edges.value = nextEdges;
  history.value = commitGraph(history.value, nextNodes, nextEdges);
}

/** 拖动收尾 / 自动布局后的历史提交请求（仅定位变化；签名去重兜底空帧）。 */
function onCommitHistory(): void {
  history.value = commitGraph(history.value, nodes.value, edges.value);
}

/** 撤销：恢复上一帧；若当前选中节点已不存在则清空选中。 */
function undoWorkflow(): void {
  if (runLocked.value) {
    notifyEditLocked();
    return;
  }
  const result = undoGraph(history.value);
  if (result === null) return;
  history.value = result.state;
  nodes.value = result.snapshot.nodes;
  edges.value = result.snapshot.edges;
  if (
    selectedNodeId.value !== null &&
    !nodes.value.some((node) => node.id === selectedNodeId.value)
  ) {
    selectedNodeId.value = null;
  }
}

/** 重做：对称返回下一帧。 */
function redoWorkflow(): void {
  if (runLocked.value) {
    notifyEditLocked();
    return;
  }
  const result = redoGraph(history.value);
  if (result === null) return;
  history.value = result.state;
  nodes.value = result.snapshot.nodes;
  edges.value = result.snapshot.edges;
  if (
    selectedNodeId.value !== null &&
    !nodes.value.some((node) => node.id === selectedNodeId.value)
  ) {
    selectedNodeId.value = null;
  }
}

async function save(): Promise<void> {
  if (!workflow.value || saving.value || !dirty.value) return;
  // 保存门控：选中节点的逻辑配置表单校验不过则阻止（错误已在表单内就地标出）。
  const formError = activeFormRef.value?.validate() ?? null;
  if (formError !== null) {
    appStore.toast(`保存被阻止：${formError}`, "error");
    return;
  }
  saving.value = true;
  try {
    const updated = await api.saveWorkflowGraph(workflow.value.id, {
      nodes: nodes.value,
      edges: edges.value,
    });
    // 图已是最新；仅同步服务端时间戳作为新的脏比较基线。
    workflow.value = {
      ...workflow.value,
      nodes: nodes.value,
      edges: edges.value,
      updatedAt: updated.updatedAt,
    };
    const row = workflows.value.find((item) => item.id === workflow.value?.id);
    if (row) {
      row.nodes = nodes.value;
      row.updatedAt = updated.updatedAt;
    }
    appStore.toast("流程已保存", "success");
  } catch (error) {
    reportError(error, "保存流程失败");
  } finally {
    saving.value = false;
  }
}

async function validate(): Promise<void> {
  if (!workflow.value || validating.value) return;
  validating.value = true;
  try {
    serverIssues.value = (await api.validateWorkflow(workflow.value.id)).issues;
    // 服务端无问题且本地规则也无问题时才算通过（本地覆盖结构缺失的即时提示）
    if (serverIssues.value.length === 0 && localIssues.value.length === 0) {
      appStore.toast("校验通过", "success");
    }
  } catch (error) {
    reportError(error, "校验流程失败");
  } finally {
    validating.value = false;
  }
}

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

onMounted(() => {
  windowsStore.registerCloseGuard(WINDOW_ID, confirmDiscard);
  window.addEventListener("keydown", onKeydown);
  void refresh();
  void loadActiveEnv();
});

onBeforeUnmount(() => {
  windowsStore.unregisterCloseGuard(WINDOW_ID);
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div ref="root" class="wf-root">
    <aside class="wf-side">
      <div class="wf-create">
        <input
          v-model="newProjectName"
          class="input"
          placeholder="新项目名称"
          @keyup.enter="createProject"
        />
        <button class="btn icon primary" title="新建项目" @click="createProject">
          <Io5Add :size="15" />
        </button>
      </div>
      <div class="wf-list">
        <div v-if="loading && projects.length === 0" class="empty-hint">正在加载…</div>
        <template v-for="project in projects" :key="project.id">
          <div
            class="wf-row wf-project"
            :class="{ selected: projectId === project.id }"
            role="button"
            tabindex="0"
            @click="selectProject(project.id)"
            @keydown.enter="selectProject(project.id)"
          >
            <span
              class="wf-project-dot"
              :style="{ background: project.color || 'var(--accent)' }"
            />
            <span class="wf-row-name" :title="project.name">{{ project.name }}</span>
            <span class="badge">{{ project.id === projectId ? workflows.length : "" }}</span>
            <button
              class="btn icon danger wf-delete"
              title="删除项目"
              @click.stop="removeProject(project)"
            >
              <Io5Trash :size="13" />
            </button>
          </div>
          <template v-if="projectId === project.id">
            <div v-if="loadingWorkflows" class="empty-hint wf-empty">正在加载…</div>
            <div
              v-for="wf in workflows"
              :key="wf.id"
              class="wf-row wf-workflow"
              :class="{ selected: workflow?.id === wf.id }"
              role="button"
              tabindex="0"
              @click="selectWorkflow(wf)"
              @keydown.enter="selectWorkflow(wf)"
            >
              <span class="wf-row-name" :title="wf.name">{{ wf.name }}</span>
              <span class="wf-meta">{{ wf.nodes.length }}节点 · {{ fmtTime(wf.updatedAt) }}</span>
              <button
                class="btn icon danger wf-delete"
                title="删除流程"
                @click.stop="removeWorkflow(wf)"
              >
                <Io5Trash :size="13" />
              </button>
            </div>
            <div v-if="!loadingWorkflows && workflows.length === 0" class="empty-hint wf-empty">
              暂无流程
            </div>
          </template>
        </template>
        <div v-if="!loading && projects.length === 0" class="empty-hint">暂无项目，先新建一个</div>
      </div>
      <div class="wf-side-footer">
        <div class="wf-create">
          <input
            v-model="newWorkflowName"
            class="input"
            placeholder="新流程名称"
            :disabled="projectId === null"
            :title="projectId === null ? '先选择一个项目' : ''"
            @keyup.enter="createWorkflow"
          />
          <button
            class="btn icon primary"
            :disabled="projectId === null"
            title="新建流程"
            @click="createWorkflow"
          >
            <Io5Add :size="15" />
          </button>
        </div>
      </div>
    </aside>

    <section class="wf-main">
      <div class="wf-toolbar">
        <template v-if="workflow">
          <span class="wf-title" :title="workflow.name">{{ workflow.name }}</span>
          <span v-if="dirty" class="wf-dirty">未保存</span>
          <span class="text-faint">{{ nodes.length }} 节点 · {{ edges.length }} 连线</span>
          <span class="wf-spacer" />
          <button class="btn icon" title="刷新项目与流程列表" @click="refresh">
            <Io5Refresh :size="14" />
          </button>
          <button class="btn" :disabled="validating" @click="validate">校验</button>
          <button class="btn primary" :disabled="saving || !dirty" @click="save">
            <Io5Save :size="14" /> 保存
          </button>
        </template>
        <template v-else>
          <span class="wf-title text-faint">未选择流程</span>
          <span class="wf-spacer" />
        </template>
      </div>
      <div v-if="mergedIssues.length > 0" class="wf-issues">
        <div v-if="dirty" class="wf-issues-hint">
          本地提示随画布实时更新；「校验」按钮的服务端结果对应最近保存的版本。
        </div>
        <div
          v-for="issue in mergedIssues"
          :key="`${issue.level}:${issue.code}:${issue.nodeIds.join()}`"
          class="wf-issue"
        >
          <span class="wf-issue-code mono" :class="`is-${issue.level}`">{{ issue.code }}</span>
          <span :title="issue.nodeIds.join(', ')">{{ issue.message }}</span>
        </div>
      </div>
      <div class="wf-canvas-wrap">
        <Canvas
          v-if="workflow"
          :key="canvasKey"
          :nodes="nodes"
          :edges="edges"
          :workflow-id="workflow.id"
          :locked="runLocked"
          :can-undo="canUndo"
          :can-redo="canRedo"
          :issues="mergedIssues"
          @position-change="onPositionChange"
          @structure-change="onStructureChange"
          @commit-history="onCommitHistory"
          @undo="undoWorkflow"
          @redo="redoWorkflow"
          @select="selectedNodeId = $event"
        />
        <div v-else class="empty-hint wf-canvas-empty">从左侧选择或新建流程</div>
      </div>
    </section>

    <aside v-if="selectedNode && selectedMeta" class="wf-drawer">
      <div class="wf-drawer-head">
        <span class="wf-drawer-dot" :style="{ background: selectedMeta.color }" />
        <span class="wf-drawer-title" :title="nodeLabel(selectedNode)">{{
          nodeLabel(selectedNode)
        }}</span>
        <button
          class="btn compact"
          :aria-pressed="ioDrawerOpen"
          title="打开节点入参 / 出参字段面板（点击复制或拖入表达式输入框生成模板引用）"
          @click="ioDrawerOpen = !ioDrawerOpen"
        >
          入参/出参
        </button>
        <button class="btn icon" title="关闭" @click="selectedNodeId = null">
          <Io5Close :size="14" />
        </button>
      </div>
      <div class="wf-drawer-body">
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
        <ReplayNodeConfig
          v-if="selectedNode.type === 'httpReplay'"
          :key="selectedNode.id"
          :node="selectedNode"
          :taken-keys="selectedTakenKeys"
          :workflow-id="workflow?.id"
          :available-node-ids="selectedAvailableNodes"
          :variable-names="selectedVariableNames"
          :env-keys="selectedEnvKeys"
          :input-paths="selectedInputPaths"
          :sample="selectedSample"
          @update:config="updateSelectedConfig"
          @update:ref-id="updateSelectedRefId"
        />
        <template v-else>
          <div class="wf-field">
            <span class="wf-field-label">引用短码</span>
            <span class="mono">{{ selectedNode.refId ?? "—" }}</span>
          </div>
          <div class="wf-field">
            <span class="wf-field-label">配置摘要</span>
            <span class="text-secondary">{{ nodeSummary(selectedNode) }}</span>
          </div>
          <ConditionBuilder
            v-if="selectedNode.type === 'condition'"
            :key="selectedNode.id"
            ref="activeFormRef"
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
            ref="activeFormRef"
            :model-value="shardView<LoopConfigShard>()"
            :disabled="runLocked"
            @update:model-value="updateSelectedShard"
          />
          <DelayConfig
            v-else-if="selectedNode.type === 'delay'"
            :key="selectedNode.id"
            ref="activeFormRef"
            :model-value="shardView<DelayConfigShard>()"
            :disabled="runLocked"
            @update:model-value="updateSelectedShard"
          />
          <SetVariableConfig
            v-else-if="selectedNode.type === 'setVariable'"
            :key="selectedNode.id"
            ref="activeFormRef"
            :model-value="shardView<SetVariableConfigShard>()"
            :node-options="selectedAvailableNodes"
            :disabled="runLocked"
            @update:model-value="updateSelectedShard"
          />
          <AssertConfig
            v-else-if="selectedNode.type === 'assert'"
            :key="selectedNode.id"
            ref="activeFormRef"
            :model-value="shardView<AssertConfigShard>()"
            :disabled="runLocked"
            @update:model-value="updateSelectedShard"
          />
          <TransformConfig
            v-else-if="selectedNode.type === 'transform'"
            :key="selectedNode.id"
            ref="activeFormRef"
            :model-value="shardView<TransformConfigShard>()"
            :disabled="runLocked"
            @update:model-value="updateSelectedShard"
          />
          <StickyNoteConfig
            v-else-if="selectedNode.type === 'stickyNote'"
            :key="selectedNode.id"
            ref="activeFormRef"
            :model-value="shardView<StickyNoteConfigShard>()"
            :disabled="runLocked"
            @update:model-value="updateSelectedShard"
          />
          <div v-else class="wf-drawer-hint text-faint">节点配置编辑将在后续任务提供</div>
        </template>
      </div>
    </aside>

    <!-- 节点数据抽屉（入参 / 出参；样本来自编辑器内试跑会话态，无样本时
         组件内空态明示）。定位层借 transform 把组件的 fixed 收敛到本窗口。 -->
    <div v-if="selectedNode && ioDrawerOpen" class="wf-io-layer">
      <NodeIoDrawer
        :node-ref-id="selectedNode.refId ?? selectedNode.id"
        :node-label="nodeLabel(selectedNode)"
        :input-sample="selectedTrial?.input ?? null"
        :output-sample="selectedTrial?.output ?? null"
        :trial-paths="selectedTrialPaths"
        @close="ioDrawerOpen = false"
      />
    </div>
  </div>
</template>

<style scoped>
.wf-root {
  flex: 1;
  min-height: 0;
  display: flex;
  /* 请求选择弹窗等抽屉内浮层的定位基准。 */
  position: relative;
}

/* ---------- 左侧：项目 / 流程两级列表 ---------- */

.wf-side {
  width: 232px;
  flex: none;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  min-height: 0;
}

.wf-create {
  display: flex;
  gap: var(--space-1);
  padding: var(--space-2);
  border-bottom: 1px solid var(--border);
}
.wf-create .input {
  flex: 1;
  min-width: 0;
}

.wf-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-1);
}

.wf-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-md);
  cursor: pointer;
}
.wf-row:hover {
  background: var(--bg-hover);
}
.wf-row.selected {
  background: var(--bg-selected);
}

.wf-project-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
}

.wf-project {
  font-weight: 600;
}

.wf-workflow {
  padding-left: 24px;
}

.wf-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wf-meta {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
}

.wf-delete {
  opacity: 0;
}
.wf-row:hover .wf-delete {
  opacity: 1;
}

.wf-empty {
  padding: var(--space-2) var(--space-2) var(--space-2) 24px;
  text-align: left;
}

.wf-side-footer {
  flex: none;
  border-top: 1px solid var(--border);
}

/* ---------- 中间：工具栏 + 画布 ---------- */

.wf-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.wf-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  flex: none;
  min-height: 41px;
}

.wf-title {
  font-weight: 600;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wf-dirty {
  font-size: 12px;
  color: var(--warning);
  font-weight: 600;
}

.wf-spacer {
  flex: 1;
}

.wf-issues {
  flex: none;
  max-height: 132px;
  overflow-y: auto;
  padding: var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--warning) 8%, transparent);
}

.wf-issues-hint {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 2px;
}

.wf-issue {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 12px;
  padding: 1px 0;
  min-width: 0;
}

.wf-issue-code {
  flex: none;
  color: var(--warning);
  font-weight: 600;
}
.wf-issue-code.is-error {
  color: var(--danger);
}
.wf-issue-code.is-info {
  color: var(--text-faint);
  font-weight: 400;
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
  pointer-events: none;
}

/* ---------- 右侧：节点配置抽屉（占位） ---------- */

.wf-drawer {
  width: 360px;
  flex: none;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  min-height: 0;
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

/* ---------- 节点数据抽屉定位层 ---------- */

/* NodeIoDrawer 用 fixed 定位（组件只读复用）；借 transform 建立包含块把
 * fixed 收敛到本窗口（左缘贴窗口、高度同窗口），不外溢到应用其他窗面。 */
.wf-io-layer {
  position: absolute;
  inset: 0;
  transform: translateX(0);
  pointer-events: none;
}

.wf-io-layer :deep(aside) {
  pointer-events: auto;
}
</style>
