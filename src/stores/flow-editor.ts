import { computed, ref, watch, type WatchStopHandle } from "vue";
import { getBackend } from "../api/runtime-backend";
import type {
  FlowProject,
  HttpApiChange,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeConfig,
  WorkflowValidationIssue,
} from "../api/types";
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
import { getWorkflowNodeMeta } from "../components/flow/node-meta";
import { collectJsonPaths } from "../components/expression-input/input-paths";
import {
  mergeConfigShard,
  NODE_SHARD_KEYS,
  takenRefKeys,
} from "../components/flow/config/node-config";
import {
  ensureFlowRunListening,
  isWorkflowRunning,
  latestRunningRunId,
  refreshFlowRuns,
} from "./flow-run";
import { HTTP_API_CHANGE_EVENT } from "./http-api-sync";
import { consumeEditorFocus, editorFocusStore } from "./editor-focus";
import { flowTrialStore, recordRunSamples } from "./flow-trial";
import { appStore, reportError } from "./app";
import { confirmDialog } from "./dialog";
import { downloadWorkflowExport } from "../api/workflow-transfer";
import { nodeRunsToRunStates, type RunNodeStateMap } from "../components/flow/run-view";

/**
 * 工作流编辑器共享状态（原浮窗 WorkflowEditorWindow 的 script 提升）：
 * 手风琴导航下「侧栏项目/流程列表」与「主区画布 + 配置抽屉」是两个组件，
 * 全部编辑态在此共享；主区视图 KeepAlive 保活，切换区块不丢画布状态。
 * 画布任何操作自动保存（图变更防抖静默落盘）+ 显式保存（Ctrl+S / 工具条）
 * + 切换流程前静默落盘兜底（仍脏才回退确认）；入口依赖 Backend.workflows
 * 能力位（workspace-view / 手风琴区块把关）。
 */
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
/** 图快照历史：结构化编辑提交帧，撤销 / 重做在帧间交换。 */
const history = ref<GraphHistoryState>(createGraphHistory([], []));

const loading = ref(false);
const loadingWorkflows = ref(false);
const saving = ref(false);
const validating = ref(false);
/** 运行触发 / 取消的在途标记（按钮防抖）。 */
const triggering = ref(false);
const cancelling = ref(false);
const newProjectName = ref("");
const newWorkflowName = ref("");
/** 画布重挂载计数：切换流程后重新 fit-view。 */
const canvasKey = ref(0);
/**
 * 编辑器画布的节点运行态（运行进行中按 checkpoint 着色；运行结束后保留
 * 终态宽限期供看清结果，对齐归档 run-progress 的 clearDelayMs，到期恢复
 * 常态）。
 */
const editorRunStates = ref<RunNodeStateMap | null>(null);
/**
 * 最后观测到在途的 run id：运行结束（running 对账消失）时据此补拉终态——
 * 最终节点着色保留宽限期，同时把终态 checkpoint 样本并入试跑桶（入参 /
 * 出参抽屉的数据源）。
 */
let lastActiveRunId: string | null = null;
/** 运行完成宽限定时器（终态着色保留期；新一轮运行开始时取消）。 */
let runGraceTimer: ReturnType<typeof setTimeout> | undefined;
/** 运行态详情轮询的在途标记（防重入）。 */
let runStatesPolling = false;
let runStatesTimer: ReturnType<typeof setInterval> | undefined;
/**
 * 节点定位令牌：locateNode 每次自增，主区视图 watch 后让画布平滑居中到
 * 选中节点（编辑器聚焦请求 / 校验问题定位共用同一通道）。
 */
const revealToken = ref(0);
/** 环境变量集清单（快捷切换下拉；能力位缺失为空）。 */
const envSetOptions = ref<{ id: string; name: string }[]>([]);
/** 当前激活环境集合 id（null = 未激活）。 */
const activeEnvSetId = ref<string | null>(null);
/**
 * 激活环境集合 + 全局变量的普通键值表（env.<key> 求值样本；secret 值不入表
 * 防明文回显）。服务端运行时的合并序以宿主供给为准，此处按「激活集合覆盖
 * 全局」近似；能力位缺失或加载失败置 null（env 引用按无激活环境告警）。
 */
const activeEnvTable = ref<Record<string, string> | null>(null);

/** 逻辑节点配置表单的保存门控面（各表单 defineExpose validate()）。 */
interface ConfigFormInstance {
  validate: () => string | null;
}

/** 当前挂载的选中节点配置表单（按类型分派互斥，任意时刻至多挂一个）。 */
const activeFormRef = ref<ConfigFormInstance | null>(null);

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

/** 运行期画布编辑锁定：运行态来自 stores/flow-run.ts 的事件对账。 */
const runLocked = computed(() => workflow.value !== null && isWorkflowRunning(workflow.value.id));

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

/** 节点显示名（自定义 label 优先，缺省回退类型默认名）。 */
export function nodeLabel(node: WorkflowNode): string {
  const custom = node.label?.trim();
  return custom ? custom : getWorkflowNodeMeta(node.type).label;
}

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

// ---------- 试跑样本会话态 → 表达式样本上下文 ----------

async function loadActiveEnv(): Promise<void> {
  const envSets = getBackend().envSets;
  if (!envSets) {
    activeEnvTable.value = null;
    envSetOptions.value = [];
    activeEnvSetId.value = null;
    return;
  }
  try {
    const payload = await envSets.get();
    const active = payload.sets.find((set) => set.id === payload.activeSetId);
    activeEnvTable.value = { ...payload.globals.values, ...(active ? active.values : {}) };
    envSetOptions.value = payload.sets.map((set) => ({ id: set.id, name: set.name }));
    activeEnvSetId.value = payload.activeSetId ?? null;
  } catch {
    activeEnvTable.value = null;
    envSetOptions.value = [];
    activeEnvSetId.value = null;
  }
}

/**
 * 切换激活环境集合（工具栏下拉；null = 不使用环境）：选择即持久化全局偏好。
 * 生效时机对齐归档口径——运行开始时定格环境快照，切换对进行中的运行不生效。
 */
async function switchEnvSet(id: string | null): Promise<void> {
  const envSets = getBackend().envSets;
  if (!envSets) return;
  try {
    await envSets.setActive(id);
    await loadActiveEnv();
    appStore.toast(
      id === null ? "已停用环境：下次运行生效" : "已切换激活环境：下次运行生效",
      "success",
    );
  } catch (error) {
    reportError(error, "切换环境失败");
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

async function refresh(): Promise<void> {
  const api = getBackend().workflows;
  if (!api) return;
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

/** 放弃修改确认（自动保存兜底：静默落盘失败 / 校验不过仍脏时回退）。 */
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
  const api = getBackend().workflows;
  if (!api) return;
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
  const api = getBackend().workflows;
  if (!api) return;
  if (workflow.value?.id === target.id) return;
  // 自动保存兜底：切换前静默落盘在途修改；保存失败 / 表单校验不过仍脏时
  // 回退「放弃修改」确认。
  if (dirty.value) {
    await save({ silent: true });
    if (dirty.value && !(await confirmDiscard())) return;
  }
  try {
    const loaded = await api.getWorkflow(target.id);
    workflow.value = loaded;
    nodes.value = loaded.nodes.map((node) => ({ ...node, position: { ...node.position } }));
    edges.value = loaded.edges.map((edge) => ({ ...edge }));
    selectedNodeId.value = null;
    serverIssues.value = [];
    history.value = createGraphHistory(nodes.value, edges.value);
    canvasKey.value += 1;
    resetEditorRunStates();
    void refreshLatestRunSamples();
    void loadActiveEnv();
  } catch (error) {
    reportError(error, "加载流程失败");
  }
}

/** 关闭当前流程时清空画布编辑态（含历史与校验）、运行态与试跑样本会话态。 */
function closeWorkflowEditor(): void {
  if (workflow.value) flowTrialStore.clearWorkflow(workflow.value.id);
  workflow.value = null;
  nodes.value = [];
  edges.value = [];
  selectedNodeId.value = null;
  serverIssues.value = [];
  resetEditorRunStates();
  history.value = createGraphHistory([], []);
}

async function createProject(): Promise<void> {
  const api = getBackend().workflows;
  if (!api) return;
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
  const api = getBackend().workflows;
  if (!api) return;
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
  const api = getBackend().workflows;
  if (!api) return;
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
  const api = getBackend().workflows;
  if (!api) return;
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

/**
 * 保存当前图（显式入口与自动保存共用）：silent = 自动保存——成功不弹
 * toast（工具条圆点已表达干净态），表单校验不过静默跳过（保持 dirty，
 * 圆点持续提示；用户修复后由下一次编辑重触发）。
 */
async function save(options: { silent?: boolean } = {}): Promise<void> {
  const silent = options.silent === true;
  const api = getBackend().workflows;
  if (!api || !workflow.value || saving.value || !dirty.value) return;
  // 保存门控：选中节点的逻辑配置表单校验不过则阻止（错误已在表单内就地标出）。
  const formError = activeFormRef.value?.validate() ?? null;
  if (formError !== null) {
    if (silent) return;
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
    if (!silent) appStore.toast("流程已保存", "success");
  } catch (error) {
    reportError(error, "保存流程失败");
  } finally {
    saving.value = false;
  }
}

/**
 * 触发一次运行（按最近保存的流程定义；后端做前置校验并回错误码）。
 * 启动成功立即对账一次，让画布锁定与取消按钮马上生效。
 */
async function triggerRun(): Promise<void> {
  const flowRunApi = getBackend().flowRuns;
  if (!workflow.value || runLocked.value || !flowRunApi || triggering.value) return;
  triggering.value = true;
  try {
    const run = await flowRunApi.trigger({ workflowId: workflow.value.id });
    await refreshFlowRuns();
    appStore.toast(`运行已启动（${run.id}）`, "success");
  } catch (error) {
    reportError(error, "触发运行失败");
  } finally {
    triggering.value = false;
  }
}

/** 取消该流程最新的在途运行（同一流程多个在途 run 时逐次点按逐个取消）。 */
async function cancelRun(): Promise<void> {
  const flowRunApi = getBackend().flowRuns;
  const workflowId = workflow.value?.id;
  const runId = workflowId ? latestRunningRunId(workflowId) : null;
  if (!runId || !flowRunApi || cancelling.value) return;
  cancelling.value = true;
  try {
    await flowRunApi.cancel(runId);
    await refreshFlowRuns();
    appStore.toast(`已请求取消运行（${runId}）`, "success");
  } catch (error) {
    reportError(error, "取消运行失败");
  } finally {
    cancelling.value = false;
  }
}

// ---------- 编辑器画布的运行态着色与运行样本 ----------

/**
 * 拉一次在途运行的节点 checkpoint 投影为画布运行态，并把 checkpoint 的
 * input / output 并入试跑样本桶（入参 / 出参抽屉与表达式建议的数据源）。
 *
 * 无在途运行时走终态收尾：刚结束的运行（lastActiveRunId 非空）补拉终态
 * 快照——最终着色保留宽限期（对齐归档 run-progress clearDelayMs 的「看清
 * 结果再恢复常态」），样本并入后到期一次性恢复常态；拉取失败静默跳过
 * （下一轮轮询或变更事件会再试）。
 */
async function pollRunStates(): Promise<void> {
  const flowRuns = getBackend().flowRuns;
  const wf = workflow.value;
  const runId = wf ? latestRunningRunId(wf.id) : null;
  if (!flowRuns || !wf || runStatesPolling) return;
  if (runId === null) {
    const finishedRunId = lastActiveRunId;
    lastActiveRunId = null;
    if (finishedRunId === null) {
      editorRunStates.value = null;
    } else {
      await settleFinishedRun(flowRuns, wf.id, finishedRunId);
    }
    return;
  }
  lastActiveRunId = runId;
  cancelRunGrace();
  runStatesPolling = true;
  try {
    const detail = await flowRuns.get(runId);
    if (workflow.value?.id !== wf.id) return;
    recordRunSamples(wf.id, detail.nodeRuns);
    editorRunStates.value =
      detail.status === "running" ? nodeRunsToRunStates(detail.nodeRuns, detail.status) : null;
  } catch {
    // 详情拉取失败不打扰用户：下一轮轮询或运行态对账会再试。
  } finally {
    runStatesPolling = false;
  }
}

/**
 * 运行结束的终态收尾：拉终态详情，最终节点着色保留宽限期后恢复常态；
 * 终态节点样本（入参 / 出参）并入试跑桶。宽限期内同流程新运行的
 * checkpoint 到达会取消本次清除（pollRunStates 的 cancelRunGrace）。
 */
async function settleFinishedRun(
  flowRuns: NonNullable<ReturnType<typeof getBackend>["flowRuns"]>,
  workflowId: string,
  runId: string,
): Promise<void> {
  runStatesPolling = true;
  try {
    const detail = await flowRuns.get(runId);
    if (workflow.value?.id !== workflowId) return;
    recordRunSamples(workflowId, detail.nodeRuns);
    if (detail.status === "running") return; // 已被新运行对账接管
    editorRunStates.value = nodeRunsToRunStates(detail.nodeRuns, detail.status);
    clearTimeout(runGraceTimer);
    runGraceTimer = setTimeout(() => {
      runGraceTimer = undefined;
      const current = workflow.value;
      if (current === null || latestRunningRunId(current.id) === null) {
        editorRunStates.value = null;
      }
    }, RUN_FINISH_GRACE_MS);
  } catch {
    editorRunStates.value = null;
  } finally {
    runStatesPolling = false;
  }
}

/** 取消完成宽限清除（新一轮运行开始 / 收尾重入时）。 */
function cancelRunGrace(): void {
  if (runGraceTimer !== undefined) {
    clearTimeout(runGraceTimer);
    runGraceTimer = undefined;
  }
}

/** 编辑器画布运行态的详情轮询间隔（毫秒）：兜底变更事件丢失。 */
const RUN_STATES_POLL_MS = 1_500;
/** 运行完成宽限期（毫秒）：终态着色保留窗口，对齐归档 clearDelayMs。 */
const RUN_FINISH_GRACE_MS = 1_500;
/** 运行变更事件触发刷新的防抖（毫秒）：节点级 checkpoint 事件突发合帧。 */
const RUN_CHANGE_REFRESH_MS = 120;

let runChangeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 运行变更事件触发的即时刷新（防抖合帧）：后端把每个节点 checkpoint 桥接
 * 成 `flow_runs` 资源变更，到达即拉详情——节点着色与边流动动画在事件后
 * ~百毫秒级出现（对齐归档 run-progress 的事件驱动口径；1.5s 轮询只是
 * 兜底，短延迟节点的 running 窗口靠本通道还原）。
 */
function onFlowRunChange(event: Event): void {
  const change = (event as CustomEvent<HttpApiChange>).detail;
  if (!change.resources.includes("all") && !change.resources.includes("flow_runs")) return;
  const wf = workflow.value;
  if (wf === null || !isWorkflowRunning(wf.id)) return;
  if (runChangeTimer !== undefined) return;
  runChangeTimer = setTimeout(() => {
    runChangeTimer = undefined;
    void pollRunStates();
  }, RUN_CHANGE_REFRESH_MS);
}

/**
 * 按当前流程的在途运行启停运行态轮询（watch 回调）：
 * 有在途 run → 立即拉一次 + 定时轮询；无 → 停表并走终态收尾
 * （补拉终态 + 宽限清除；不经此路径的常态清空见 pollRunStates 的空分支）。
 */
function syncRunStatesPolling(): void {
  const wf = workflow.value;
  const active = wf !== null && isWorkflowRunning(wf.id);
  if (active) {
    if (runStatesTimer === undefined) {
      void pollRunStates();
      runStatesTimer = setInterval(() => void pollRunStates(), RUN_STATES_POLL_MS);
    }
  } else if (runStatesTimer !== undefined) {
    clearInterval(runStatesTimer);
    runStatesTimer = undefined;
    void pollRunStates();
  }
}

/**
 * 打开 / 切换流程时回填该流程最近一次运行的节点样本（尽力而为）：运行
 * 记录的 input / output 并入试跑桶，运行后选中节点即可在入参 / 出参抽屉
 * 看到真实数据（运行中的流程交由轮询 / 事件通道持续更新）。
 */
async function refreshLatestRunSamples(): Promise<void> {
  const flowRuns = getBackend().flowRuns;
  const wf = workflow.value;
  if (!flowRuns || !wf) return;
  try {
    const page = await flowRuns.list({ workflowId: wf.id, limit: 1 });
    const latest = page.runs[0];
    if (latest === undefined) return;
    const detail = await flowRuns.get(latest.id);
    if (workflow.value?.id !== wf.id) return;
    recordRunSamples(wf.id, detail.nodeRuns);
  } catch {
    // 历史运行回填失败不打扰用户（触发新运行后由事件通道回填）。
  }
}

/** 选中 / 关闭流程时清运行态（新流程无在途语义）与宽限定时器。 */
function resetEditorRunStates(): void {
  if (runStatesTimer !== undefined) {
    clearInterval(runStatesTimer);
    runStatesTimer = undefined;
  }
  cancelRunGrace();
  if (runChangeTimer !== undefined) {
    clearTimeout(runChangeTimer);
    runChangeTimer = undefined;
  }
  lastActiveRunId = null;
  editorRunStates.value = null;
}

// ---------- 节点定位与导出 ----------

/** 定位节点：选中并自增定位令牌（画布平滑居中；问题面板 / 聚焦请求共用）。 */
function locateNode(nodeId: string): void {
  selectedNodeId.value = nodeId;
  revealToken.value += 1;
}

/** 当前流程导出在途标记（按钮防抖）。 */
const exporting = ref(false);

/** 导出当前流程为 JSON 文件（复用既有 saveFile 通道；用户取消不提示）。 */
async function exportCurrentWorkflow(): Promise<void> {
  const api = getBackend().workflows;
  const wf = workflow.value;
  if (!api || !wf || exporting.value) return;
  exporting.value = true;
  try {
    const envelope = await api.exportWorkflows([wf.id]);
    const saved = await downloadWorkflowExport(getBackend(), envelope);
    if (saved) appStore.toast("流程已导出", "success");
  } catch (error) {
    reportError(error, "导出流程失败");
  } finally {
    exporting.value = false;
  }
}

async function validate(): Promise<void> {
  const api = getBackend().workflows;
  if (!api || !workflow.value || validating.value) return;
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

/** 消费「在编辑器打开」聚焦请求：切流程（如需）并选中节点（尽力而为）。 */
async function consumeEditorFocusRequest(): Promise<void> {
  const api = getBackend().workflows;
  const request = consumeEditorFocus();
  if (!request || !api) return;
  try {
    if (workflow.value?.id !== request.workflowId) {
      const target =
        workflows.value.find((item) => item.id === request.workflowId) ??
        (await api.getWorkflow(request.workflowId));
      if (workflow.value?.id !== target.id) await selectWorkflow(target);
    }
    if (nodes.value.some((node) => node.id === request.nodeId)) {
      locateNode(request.nodeId);
    } else {
      appStore.toast("该节点已不在当前流程中", "error");
    }
  } catch (error) {
    reportError(error, "在编辑器打开失败");
  }
}

/**
 * 配置表单函数 ref（模板 `:ref="setActiveFormRef"` 共用）：互斥挂载的选中
 * 节点配置表单实例写入 activeFormRef，卸载时以 null 调用完成清空。
 */
function setActiveFormRef(instance: unknown): void {
  activeFormRef.value = (instance as ConfigFormInstance | null) ?? null;
}

/** 编辑器聚焦请求 watch：版本一变即消费一次（返回停止句柄）。 */
function watchEditorFocus(): WatchStopHandle {
  return watch(
    () => editorFocusStore.version,
    () => void consumeEditorFocusRequest(),
  );
}

// ---------- 画布自动保存 ----------

/** 自动保存防抖（毫秒）：末次图变更后静默落盘，连续编辑不逐笔请求。 */
const AUTO_SAVE_DEBOUNCE_MS = 1_000;

let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;

/** 安排一次自动保存：清掉在途计时，防抖到期后静默保存（保存进行中顺延一轮）。 */
function scheduleAutoSave(): void {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    if (saving.value) {
      scheduleAutoSave();
      return;
    }
    void save({ silent: true });
  }, AUTO_SAVE_DEBOUNCE_MS);
}

/**
 * 主区视图挂载接线（原窗口 onMounted 逻辑，由组件调用）：
 * 运行监听懒启动 + 聚焦请求 watch + 运行态轮询启停 watch + 运行变更事件
 * 刷新 + 画布自动保存 watch + 最近运行样本回填（KeepAlive 下常驻）。
 * 返回卸载清理函数（KeepAlive 缓存期间不会触发）。
 */
function mountEditorListeners(): () => void {
  ensureFlowRunListening();
  void refreshLatestRunSamples();
  window.addEventListener(HTTP_API_CHANGE_EVENT, onFlowRunChange);
  const stop = watchEditorFocus();
  const stopAutoSave = watch([nodes, edges], () => {
    if (!dirty.value) return;
    scheduleAutoSave();
  });
  const stopRunStates = watch(
    () => (workflow.value ? isWorkflowRunning(workflow.value.id) : false),
    () => syncRunStatesPolling(),
    { immediate: true },
  );
  return () => {
    stop();
    stopAutoSave();
    clearTimeout(autoSaveTimer);
    stopRunStates();
    window.removeEventListener(HTTP_API_CHANGE_EVENT, onFlowRunChange);
    if (runChangeTimer !== undefined) {
      clearTimeout(runChangeTimer);
      runChangeTimer = undefined;
    }
  };
}

export function useFlowEditorStore() {
  return {
    projects,
    workflows,
    projectId,
    workflow,
    nodes,
    edges,
    selectedNodeId,
    serverIssues,
    history,
    loading,
    loadingWorkflows,
    saving,
    validating,
    triggering,
    cancelling,
    newProjectName,
    newWorkflowName,
    canvasKey,
    setActiveFormRef,
    dirty,
    localIssues,
    mergedIssues,
    canUndo,
    canRedo,
    runLocked,
    editorRunStates,
    revealToken,
    envSetOptions,
    activeEnvSetId,
    exporting,
    selectedNode,
    selectedMeta,
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
    selectProject,
    selectWorkflow,
    createProject,
    createWorkflow,
    removeProject,
    removeWorkflow,
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
    shardView,
    updateSelectedShard,
    loadActiveEnv,
    consumeEditorFocusRequest,
    mountEditorListeners,
  };
}
