import type {
  FlowLoopIterationsSummary,
  FlowNodeRunRecord,
  FlowRunListQuery,
  FlowRunRecord,
  FlowRunStatus,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "../../api/types";
import { getWorkflowNodeMeta } from "./node-meta";

/**
 * 运行记录视图层的纯函数与常量（ReqFlow 复刻 Task 22 薄片 A）。
 *
 * 形态移植上游 runs-page-utils / run-detail-utils / node-run-state：
 *   - 状态与触发方式中文文案、耗时 / 时间格式化、id 截断；
 *   - 运行图还原三态（快照 / 当前流程回落 / 无）与披露文案；
 *   - 节点运行态着色投影（interrupted 运行里停留在 running 的节点按中性档）；
 *   - 列表筛选参数组装与分页换算。
 *
 * 全部无副作用，供窗口组件与 vitest（node 环境）直接使用。
 */

/* ------------------------------------------------------------------ *
 * 文案与徽标
 * ------------------------------------------------------------------ */

/** 运行状态 → 展示文案（列表 / 详情徽标与筛选下拉共用）。 */
export const RUN_STATUS_LABELS: Record<FlowRunStatus, string> = {
  running: "进行中",
  success: "成功",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

/** 筛选下拉的状态取值顺序（'all' 为「全部状态」哨兵）。 */
export const RUN_STATUS_FILTER_VALUES: FlowRunStatus[] = [
  "running",
  "success",
  "failed",
  "cancelled",
  "interrupted",
];

/** 读取运行状态的展示文案；未知取值原样返回（防御后端新增状态）。 */
export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABELS[status as FlowRunStatus] ?? status;
}

/** 触发方式 → 展示文案（当前后端仅 manual；debug 为上游预留）。 */
export function runTriggerLabel(trigger: string): string {
  if (trigger === "manual") return "手动";
  if (trigger === "debug") return "调试";
  return trigger;
}

/** 节点状态 → 展示文案。 */
const NODE_RUN_STATUS_LABELS: Record<string, string> = {
  running: "执行中",
  success: "成功",
  failed: "失败",
  cancelled: "已取消",
  skipped: "跳过",
};

/**
 * 节点状态展示文案：中断运行里停留在 running 的节点永远等不到终态，
 * 按「未完成」中性口径展示（不着色为进行中）。
 */
export function nodeRunStatusLabel(status: string, runInterrupted: boolean): string {
  if (status === "running" && runInterrupted) return "未完成";
  return NODE_RUN_STATUS_LABELS[status] ?? status;
}

/* ------------------------------------------------------------------ *
 * 时间与 id
 * ------------------------------------------------------------------ */

/**
 * 耗时格式化（纯函数）：不足 1 秒 → 毫秒整数；不足 1 分钟 → 秒（一位小数）；
 * 更长 → 「N 分 M 秒」。负数按 0 处理。
 */
export function formatDurationMs(durationMs: number): string {
  const ms = Math.max(0, durationMs);
  // 59.95s 起即进位到「1 分 0 秒」，避免秒档出现「60.0s」
  if (ms < 59_950) return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  const carry = seconds === 60 ? 1 : 0;
  return `${minutes + carry} 分 ${carry ? 0 : seconds} 秒`;
}

/**
 * 由运行记录计算耗时（finishedAt - startedAt 毫秒）。
 * running（尚未结算）或 finishedAt 缺省返回 undefined；异常数据按 0 计。
 */
export function computeRunDuration(
  run: Pick<FlowRunRecord, "startedAt" | "finishedAt">,
): number | undefined {
  if (run.finishedAt === undefined) return undefined;
  return Math.max(0, run.finishedAt - run.startedAt);
}

/** 运行耗时展示文案：running 显示「进行中…」，缺省显示 '—'。 */
export function formatRunDuration(
  run: Pick<FlowRunRecord, "status" | "startedAt" | "finishedAt">,
): string {
  if (run.status === "running") return "进行中…";
  const duration = computeRunDuration(run);
  return duration === undefined ? "—" : formatDurationMs(duration);
}

/** id 截断展示：超过 8 字符取前 8 位追加「…」。 */
export function shortId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

/** 节点类型展示名：行内改名优先，否则取 node-meta 注册表的类型标签。 */
export function nodeTypeLabel(type: string, label: string | undefined): string {
  if (label !== undefined && label.trim() !== "") return label.trim();
  return getWorkflowNodeMeta(type).label;
}

/* ------------------------------------------------------------------ *
 * 列表筛选参数组装与分页
 * ------------------------------------------------------------------ */

/** 运行列表筛选条状态（'all' 哨兵 = 不过滤）。 */
export interface RunListFilters {
  workflowId: string;
  status: string;
}

/** 列表每页条数。 */
export const RUN_LIST_PAGE_SIZE = 20;

/** 当前筛选是否生效（决定空态用「无数据」还是「筛选无命中」）。 */
export function hasActiveFilters(filters: RunListFilters): boolean {
  return filters.workflowId !== "all" || filters.status !== "all";
}

/**
 * 组装列表请求参数（纯函数）：'all' 哨兵与空流程 id 不下发；页码换算为
 * offset。limit / offset 恒下发，保证分页口径确定。
 */
export function buildRunListQuery(filters: RunListFilters, page: number): FlowRunListQuery {
  const query: FlowRunListQuery = {
    limit: RUN_LIST_PAGE_SIZE,
    offset: Math.max(0, page) * RUN_LIST_PAGE_SIZE,
  };
  if (filters.workflowId !== "all" && filters.workflowId !== "") {
    query.workflowId = filters.workflowId;
  }
  if (filters.status !== "all" && filters.status !== "") {
    query.status = filters.status as FlowRunStatus;
  }
  return query;
}

/** 由总条数计算页数（至少 1 页，供「第 x / y 页」展示与越界回退）。 */
export function runPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / RUN_LIST_PAGE_SIZE));
}

/* ------------------------------------------------------------------ *
 * 运行图还原（快照 / 回落 / 无 三态）
 * ------------------------------------------------------------------ */

/** 运行图还原来源：快照 / 当前流程回落 / 无（流程已删除且无快照）。 */
export type RunGraphSource = "snapshot" | "workflow" | "none";

/** resolveRunGraph 的解析结果。 */
export interface ResolvedRunGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** 还原来源（'workflow' 时页面披露「按当前流程定义显示」）。 */
  source: RunGraphSource;
  /** 快照是否体积降级（仅骨架；source='snapshot' 时可能为 true）。 */
  truncated: boolean;
}

/**
 * 防御解析图快照 JSON：形状不符（旧数据 / 骨架降级）时按可用字段收敛，
 * 不抛错。truncated 透传顶层标记；缺 config / 非法 position 的节点补默认值，
 * 保证画布可渲染。
 */
export function parseGraphSnapshot(snapshot: unknown): {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  truncated: boolean;
} {
  if (typeof snapshot !== "object" || snapshot === null) {
    return { nodes: [], edges: [], truncated: false };
  }
  const record = snapshot as Record<string, unknown>;
  const rawNodes = Array.isArray(record["nodes"]) ? (record["nodes"] as unknown[]) : [];
  const rawEdges = Array.isArray(record["edges"]) ? (record["edges"] as unknown[]) : [];
  const nodes: WorkflowNode[] = [];
  for (const raw of rawNodes) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const position =
      typeof item["position"] === "object" && item["position"] !== null
        ? (item["position"] as Record<string, unknown>)
        : {};
    nodes.push({
      id: String(item["id"] ?? ""),
      type: (typeof item["type"] === "string" ? item["type"] : "httpReplay") as WorkflowNodeType,
      position: {
        x: typeof position["x"] === "number" ? position["x"] : 0,
        y: typeof position["y"] === "number" ? position["y"] : 0,
      },
      config: (typeof item["config"] === "object" && item["config"] !== null
        ? item["config"]
        : {}) as WorkflowNode["config"],
      ...(typeof item["label"] === "string" ? { label: item["label"] } : {}),
      ...(typeof item["refId"] === "string" ? { refId: item["refId"] } : {}),
    });
  }
  const edges: WorkflowEdge[] = [];
  for (const raw of rawEdges) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const sourceHandle =
      item["sourceHandle"] === "true" || item["sourceHandle"] === "false"
        ? item["sourceHandle"]
        : undefined;
    edges.push({
      id: String(item["id"] ?? `${item["source"] ?? "?"}->${item["target"] ?? "?"}`),
      source: String(item["source"] ?? ""),
      target: String(item["target"] ?? ""),
      ...(sourceHandle !== undefined ? { sourceHandle } : {}),
    });
  }
  return { nodes, edges, truncated: record["truncated"] === true };
}

/**
 * 解析本次运行要渲染的图（纯函数，快照优先）：
 *   1. run.graphSnapshot 存在 → 按运行创建时刻的快照还原（流程改 / 删不影响）；
 *   2. 无快照（快照特性之前的旧记录）→ 回落当前流程定义并如实披露口径；
 *   3. 流程亦不可得 → source='none'（画布渲染空态）。
 */
export function resolveRunGraph(run: FlowRunRecord, workflow: Workflow | null): ResolvedRunGraph {
  if (run.graphSnapshot !== undefined && run.graphSnapshot !== null) {
    const parsed = parseGraphSnapshot(run.graphSnapshot);
    return { ...parsed, source: "snapshot" };
  }
  if (workflow !== null) {
    return { nodes: workflow.nodes, edges: workflow.edges, source: "workflow", truncated: false };
  }
  return { nodes: [], edges: [], source: "none", truncated: false };
}

/** 详情页顶部的图来源披露文案（空数组 = 无需披露）。 */
export function runGraphDisclosures(resolved: ResolvedRunGraph, hasWorkflowCapability: boolean): string[] {
  if (resolved.source === "snapshot") {
    return resolved.truncated
      ? ["图快照已降级：超过落库体积上限，仅保留节点与连线骨架，节点配置未随快照保存"]
      : [];
  }
  if (resolved.source === "workflow") {
    return ["图快照缺失，按当前流程定义显示（可能与运行时不一致）"];
  }
  return [
    hasWorkflowCapability
      ? "流程定义已删除且无图快照，画布不可还原"
      : "图快照缺失且后端未提供流程定义能力，画布不可还原",
  ];
}

/* ------------------------------------------------------------------ *
 * 节点运行态着色
 * ------------------------------------------------------------------ */

/** 节点运行态视觉数据（nodeId → 状态；NodeShell 的 runState 注入形状）。 */
export interface RunNodeVisualState {
  /** 中性化后的状态（interrupted 运行里停留的 running 已映射为 skipped 档）。 */
  status: string;
  /** 原始状态（running 且中断时与 status 不同，供面板展示「未完成」）。 */
  rawStatus: string;
  /** 所属运行是否为 interrupted。 */
  runInterrupted: boolean;
  /** failed 节点的错误摘要（角标 title）。 */
  error?: string;
  /** 循环节点迭代进度（已结算轮数 / 实际轮数 / 是否上限截断）。 */
  iterationsDone?: number;
  iterationsTotal?: number;
  iterationsCapped?: boolean;
}

/** 节点运行态 map（nodeId → 视觉状态）。 */
export type RunNodeStateMap = Record<string, RunNodeVisualState>;

/**
 * 节点 checkpoint 列表 → 画布运行态 map（纯函数）。
 *
 * 口径：
 *   - 状态直映射（success / failed / cancelled / skipped 原样；running 保持）；
 *   - **中断运行的例外**：run.status 为 'interrupted' 时停留在 'running' 的
 *     节点 checkpoint 永远等不到终态——视觉档映射为中性 'skipped'（不转圈、
 *     不着进行中色），rawStatus 保留 running 供面板按「未完成」展示；
 *   - error 随行携带；iterations 的进度字段防御提取（形状不符时忽略）。
 *
 * 未执行节点（nodeRuns 无条目）不落 map 项 → 画布按「无运行态」常态渲染。
 */
export function nodeRunsToRunStates(
  nodeRuns: FlowNodeRunRecord[],
  runStatus: string,
): RunNodeStateMap {
  const interrupted = runStatus === "interrupted";
  const states: RunNodeStateMap = {};
  for (const nodeRun of nodeRuns) {
    const rawStatus = nodeRun.status;
    const state: RunNodeVisualState = {
      status: rawStatus === "running" && interrupted ? "skipped" : rawStatus,
      rawStatus,
      runInterrupted: interrupted,
    };
    if (nodeRun.error !== undefined && nodeRun.error !== "") state.error = nodeRun.error;
    const progress = iterationProgress(nodeRun.iterations);
    if (progress !== null) {
      state.iterationsDone = progress.done;
      state.iterationsTotal = progress.total;
      state.iterationsCapped = progress.capped;
    }
    states[nodeRun.nodeId] = state;
  }
  return states;
}

/** 防御提取迭代进度（字段缺失 / 非数值返回 null）。 */
export function iterationProgress(
  iterations: FlowLoopIterationsSummary | null | undefined,
): { done: number; total: number; capped: boolean } | null {
  if (typeof iterations !== "object" || iterations === null) return null;
  const total = typeof iterations.total === "number" ? iterations.total : undefined;
  const done = typeof iterations.done === "number" ? iterations.done : undefined;
  if (total === undefined || done === undefined) return null;
  return {
    total,
    done,
    capped: iterations.capped === true,
  };
}

/** 循环节点迭代进度的展示文案：「已迭代 x / y」（上限截断时追加标注）。 */
export function formatLoopIterationProgress(done: number, total: number, capped: boolean): string {
  return capped ? `已迭代 ${done} / ${total}（上限截断）` : `已迭代 ${done} / ${total}`;
}

/* ------------------------------------------------------------------ *
 * 执行顺序与陈旧节点
 * ------------------------------------------------------------------ */

/** 按执行顺序（startedAt 升序）排序的节点 checkpoint 条目。 */
export interface NodeRunEntry {
  nodeId: string;
  nodeRun: FlowNodeRunRecord;
}

/**
 * 把 nodeRuns 展开为按执行顺序（startedAt 升序）的条目列表（纯函数）。
 * startedAt 相同（同毫秒启动）时按 nodeId 字典序稳定排序。
 */
export function sortNodeRunsByExecution(nodeRuns: FlowNodeRunRecord[]): NodeRunEntry[] {
  return [...nodeRuns]
    .map((nodeRun) => ({ nodeId: nodeRun.nodeId, nodeRun }))
    .sort(
      (a, b) =>
        (a.nodeRun.startedAt ?? 0) - (b.nodeRun.startedAt ?? 0) ||
        a.nodeId.localeCompare(b.nodeId),
    );
}

/** 统计失败节点数（run 级「N 个节点失败」提示用）。 */
export function countFailedNodeRuns(nodeRuns: FlowNodeRunRecord[]): number {
  let count = 0;
  for (const nodeRun of nodeRuns) {
    if (nodeRun.status === "failed") count += 1;
  }
  return count;
}

/**
 * 「未在图中的执行节点」清单（纯函数）：nodeRuns 里存在、但不在本次运行图
 * （快照 / 回落流程）中的节点条目——流程改版后删除的节点等。按执行顺序返回，
 * 供默认面板清单展示与点选（选中后仍可查看其快照详情）。
 */
export function listStaleNodeRuns(
  nodeRuns: FlowNodeRunRecord[],
  nodes: readonly WorkflowNode[],
): NodeRunEntry[] {
  const known = new Set(nodes.map((node) => node.id));
  return sortNodeRunsByExecution(nodeRuns).filter((entry) => !known.has(entry.nodeId));
}

/* ------------------------------------------------------------------ *
 * 边运行态
 * ------------------------------------------------------------------ */

/** 运行中边的流动动画标记类（任一端点处于 running 即视为「执行中路径」）。 */
export const EDGE_RUNNING_CLASS = "flow-edge-running";

/** 给连线集合附加运行态类：端点 running 时加流动动画类，其余保持常态。 */
export function withEdgeRunClasses<E extends { id: string; source: string; target: string }>(
  edges: readonly E[],
  states: RunNodeStateMap | null,
): E[] {
  if (states === null) return [...edges];
  return edges.map((edge) => {
    const sourceStatus = states[edge.source]?.status;
    const targetStatus = states[edge.target]?.status;
    const running = sourceStatus === "running" || targetStatus === "running";
    return running ? { ...edge, class: EDGE_RUNNING_CLASS } : edge;
  });
}
