import type { InjectionKey } from "vue";
import type { WorkflowEdge, WorkflowNode, WorkflowValidationIssue } from "../../api/types";

/**
 * 常驻校验徽标的数据口径（Task 13 Step 3）：本地规则即时提示 + 服务端
 * validate 结果合并为 error / warning / info 三级问题清单，画布节点卡按
 * 节点粒度渲染徽标，窗口校验面板展示完整清单。
 *
 *   - 本地规则（collectLocalIssues）：对齐后端 flow/validate.rs 的 error 级
 *     口径（唯一 start、边端点存在、便签不可连线），另补前端视角的
 *     warning（孤立节点）与 info（多上游汇合披露，移植归档 join-node），
 *     图一变即重算，无需请求服务端；
 *   - 服务端结果（mergeIssues）：POST /api/workflows/{id}/validate 的
 *     WorkflowValidationIssue 无级别字段，按 code 映射——后端六类规则均为
 *     阻断级（error），未知 code 回退 warning；与本地同 code 且同归属节点
 *     的问题去重（服务端为权威版本，保留其文案）；
 *   - 节点归属（groupIssuesByNode）：按 issue.nodeIds 归属到节点；流程级
 *     问题（nodeIds 为空，如 missing-start）不落节点表，仅面板展示。
 *
 * 纯函数（vue 仅类型引用，node 环境可直接单测）+ 一个 Context Key。
 */

/** 问题级别：error / warning 为问题（进徽标），info 为语义披露（仅面板）。 */
export type NodeIssueLevel = "error" | "warning" | "info";

/** 一条画布校验问题（本地 / 服务端合并后的统一形状）。 */
export interface NodeIssue {
  level: NodeIssueLevel;
  code: string;
  message: string;
  /** 关联节点 id；流程级问题为空数组。 */
  nodeIds: string[];
}

/** 后端 validate 的全部 issue code（均为阻断级，见 flow/validate.rs）。 */
const SERVER_ERROR_CODES = new Set([
  "missing-start",
  "multiple-start",
  "dangling-edge",
  "sticky-note-edge",
  "refid-invalid",
  "refid-conflict",
]);

/**
 * 本地即时校验（对齐后端 error 口径 + 前端视角 warning / info）。
 * 结果顺序固定：缺 / 多开始 → 坏连线 → 便签连线 → 孤立节点 → 汇合披露。
 */
export function collectLocalIssues(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): NodeIssue[] {
  const issues: NodeIssue[] = [];

  const startNodes = nodes.filter((node) => node.type === "start");
  if (startNodes.length === 0) {
    issues.push({
      level: "error",
      code: "missing-start",
      message:
        nodes.length === 0
          ? "流程为空：请先添加节点与「开始」节点"
          : "缺少开始节点：流程至少需要一个「开始」节点",
      nodeIds: [],
    });
  } else if (startNodes.length > 1) {
    issues.push({
      level: "error",
      code: "multiple-start",
      message: `存在 ${startNodes.length} 个开始节点，流程只能有一个开始节点`,
      nodeIds: startNodes.map((node) => node.id),
    });
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const stickyIds = new Set(
    nodes.filter((node) => node.type === "stickyNote").map((node) => node.id),
  );
  for (const edge of edges) {
    const missing = [edge.source, edge.target].filter((id) => !nodeIds.has(id));
    if (missing.length > 0) {
      issues.push({
        level: "error",
        code: "dangling-edge",
        message: `连线 ${edge.id} 指向不存在的节点（${missing.join("、")}）`,
        nodeIds: [edge.source, edge.target].filter((id) => nodeIds.has(id)),
      });
    }
    const stickyEnds = [edge.source, edge.target].filter((id) => stickyIds.has(id));
    if (stickyEnds.length > 0) {
      issues.push({
        level: "error",
        code: "sticky-note-edge",
        message: `便签节点不可连线：连线 ${edge.id} 涉及便签节点`,
        nodeIds: stickyEnds,
      });
    }
  }

  // 孤立节点（无任何连线且非开始 / 便签）：便签按设计不入执行拓扑，豁免
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.source);
    connected.add(edge.target);
  }
  for (const node of nodes) {
    if (node.type === "start" || node.type === "stickyNote" || connected.has(node.id)) continue;
    issues.push({
      level: "warning",
      code: "isolated-node",
      message: `节点（${node.id}）未与任何节点连线`,
      nodeIds: [node.id],
    });
  }

  // 多上游汇合披露（info）：等全部上游结算才执行是接线即生效的隐式行为
  const inboundSources = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const sources = inboundSources.get(edge.target);
    if (sources === undefined) inboundSources.set(edge.target, new Set([edge.source]));
    else sources.add(edge.source);
  }
  for (const node of nodes) {
    const sources = inboundSources.get(node.id);
    if (sources === undefined || sources.size < 2) continue;
    issues.push({
      level: "info",
      code: "join-node",
      message: `汇合节点（${node.id}）有 ${sources.size} 个上游：运行时等待全部上游结算后才执行`,
      nodeIds: [node.id],
    });
  }

  return issues;
}

/**
 * 合并本地与服务端问题：服务端结果在前（权威），本地与其同 code 且同归属
 * 节点集合的问题去重（避免同问题双报）；未知服务端 code 回退 warning。
 */
export function mergeIssues(
  local: readonly NodeIssue[],
  server: readonly WorkflowValidationIssue[],
): NodeIssue[] {
  const serverIssues: NodeIssue[] = server.map((issue) => ({
    level: SERVER_ERROR_CODES.has(issue.code) ? "error" : "warning",
    code: issue.code,
    message: issue.message,
    nodeIds: [...issue.nodeIds],
  }));
  const serverKeys = new Set(serverIssues.map((issue) => issueKey(issue)));
  const localIssues = local
    .filter((issue) => !serverKeys.has(issueKey(issue)))
    .map((issue) => ({ ...issue }));
  return [...serverIssues, ...localIssues];
}

/** 去重键：code + 归属节点集合（节点排序后拼接，与节点顺序无关）。 */
function issueKey(issue: NodeIssue): string {
  return `${issue.code}|${[...issue.nodeIds].sort().join(",")}`;
}

/**
 * 把问题清单按节点归属（nodeIds 里的每个节点都拿到同一问题引用）。
 * 流程级问题（nodeIds 为空）不落表；供画布节点徽标消费。
 */
export function groupIssuesByNode(issues: readonly NodeIssue[]): ReadonlyMap<string, NodeIssue[]> {
  const table = new Map<string, NodeIssue[]>();
  for (const issue of issues) {
    for (const id of issue.nodeIds) {
      const bucket = table.get(id);
      if (bucket === undefined) table.set(id, [issue]);
      else bucket.push(issue);
    }
  }
  return table;
}

/**
 * 节点徽标的展示问题：过滤 info 级（语义披露不是问题，不常驻挂徽标），
 * 返回该节点应计数 / 提示的问题清单。
 */
export function badgeIssues(issues: readonly NodeIssue[]): NodeIssue[] {
  return issues.filter((issue) => issue.level !== "info");
}

/**
 * 画布 → 节点组件的问题注入键（Vue provide / inject；NodeShell 渲染徽标用）。
 * 值为 nodeId → 该节点的合并后问题清单。
 */
export const NODE_ISSUES_KEY: InjectionKey<ReadonlyMap<string, NodeIssue[]>> =
  Symbol("flow-node-issues");
