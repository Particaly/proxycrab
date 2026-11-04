import type { WorkflowEdge, WorkflowNode, WorkflowNodeType } from "../../api/types";
import type { NodeIssue } from "./node-issue-badge";

/**
 * 工作流图模型 ⇄ Vue Flow 视图模型的纯函数转换，以及脏比较口径。
 * 模块只依赖领域类型（Vue Flow 的类型以结构兼容的最小形状表达），
 * 保持可在 node 环境下直接单测。
 */

/** Vue Flow 定位变更的最小形状（只关心落到模型上的 id + 坐标）。 */
export interface GraphPositionChange {
  id: string;
  x: number;
  y: number;
}

/** 画布节点卡基准尺寸（与 flow.css 的 .flow-node / 便签卡一致）。 */
export const FLOW_NODE_SIZE = { width: 176, height: 56 } as const;

/** 引用短码长度与字母表（对齐后端 flow/model.rs 的 refId 原语）。 */
const REF_ID_LENGTH = 5;
const REF_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * 生成流程内唯一的 5 位字母引用短码（模板 `{{ node.<refId>… }}` 的解析键）。
 * exclude 为已占用键（节点 id + 既有 refId，对齐后端占用口径），冲突重摇。
 */
export function generateRefId(exclude: ReadonlySet<string>): string {
  for (;;) {
    let refId = "";
    for (let i = 0; i < REF_ID_LENGTH; i += 1) {
      refId += REF_ID_ALPHABET[Math.floor(Math.random() * REF_ID_ALPHABET.length)];
    }
    if (!exclude.has(refId)) return refId;
  }
}

/**
 * 当前图已占用的短码键集合：全部节点 id + 既有 refId（对齐后端
 * `ref_id_taken_keys` 语义）。新建 / 粘贴节点的短码对该集合查重。
 */
export function takenRefKeys(nodes: WorkflowNode[]): Set<string> {
  const taken = new Set<string>();
  for (const node of nodes) {
    taken.add(node.id);
    if (node.refId) taken.add(node.refId);
  }
  return taken;
}

/** 各类型新建节点的默认配置（httpReplay 预置失败策略，便签预置空文本）。 */
export function defaultNodeConfig(type: WorkflowNodeType): WorkflowNode["config"] {
  if (type === "httpReplay") return { failPolicy: "stop" };
  if (type === "stickyNote") return { text: "" };
  return {};
}

/**
 * 新建一个领域节点：id 用随机 UUID，引用短码对 exclude 查重生成，
 * config 取类型默认配置工厂。
 */
export function createWorkflowNode(
  type: WorkflowNodeType,
  position: { x: number; y: number },
  exclude: ReadonlySet<string>,
): WorkflowNode {
  return {
    id: crypto.randomUUID(),
    type,
    position: { x: position.x, y: position.y },
    config: defaultNodeConfig(type),
    refId: generateRefId(exclude),
  };
}

/** 新建一条连线；sourceHandle 仅条件节点真 / 假出口落值。 */
export function createWorkflowEdge(
  source: string,
  target: string,
  sourceHandle?: "true" | "false",
): WorkflowEdge {
  return {
    id: crypto.randomUUID(),
    source,
    target,
    ...(sourceHandle ? { sourceHandle } : {}),
  };
}

/** 新建流程的初始图：单个开始节点（结构校验要求恰好一个 start）。 */
export function starterGraph(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: [
      {
        id: "start",
        type: "start",
        position: { x: 80, y: 160 },
        config: {},
      },
    ],
    edges: [],
  };
}

/**
 * 把模型节点投影为 Vue Flow 节点。领域节点整体挂在 data.node 上，
 * 节点组件（NodeShell）据此渲染；视图 type 与领域 type 一致，便于
 * 后续小地图 / 运行态按类型处理。data.issues 携带该节点的校验问题
 * （视图层旁路信息，不进领域模型 / 不参与脏比较）；便签卡 zIndex 沉底。
 */
export function toFlowNodes(
  nodes: WorkflowNode[],
  issuesByNode?: ReadonlyMap<string, NodeIssue[]>,
): Array<{
  id: string;
  type: string;
  position: { x: number; y: number };
  zIndex?: number;
  data: { node: WorkflowNode; issues: NodeIssue[] };
}> {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: { x: node.position.x, y: node.position.y },
    ...(node.type === "stickyNote" ? { zIndex: -1 } : {}),
    data: { node, issues: issuesByNode?.get(node.id) ?? [] },
  }));
}

/** 把模型连线投影为 Vue Flow 连线（条件分支的 sourceHandle 直接透传并带真 / 假标签）。 */
export function toFlowEdges(
  edges: WorkflowEdge[],
): Array<{ id: string; source: string; target: string; sourceHandle?: string; label?: string }> {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.sourceHandle === "true" || edge.sourceHandle === "false"
      ? { label: edge.sourceHandle === "true" ? "真" : "假" }
      : {}),
  }));
}

/**
 * 把画布产生的定位变更合并进模型节点数组（不可变返回；未涉及任何节点时
 * 返回 null，调用方据此跳过无意义的重算与脏标记）。
 */
export function applyNodePositions(
  nodes: WorkflowNode[],
  changes: GraphPositionChange[],
): WorkflowNode[] | null {
  let touched = false;
  const byId = new Map<string, { x: number; y: number }>();
  for (const change of changes) {
    if (Number.isFinite(change.x) && Number.isFinite(change.y)) {
      byId.set(change.id, { x: change.x, y: change.y });
    }
  }
  const next = nodes.map((node) => {
    const position = byId.get(node.id);
    if (!position || (node.position.x === position.x && node.position.y === position.y)) {
      return node;
    }
    touched = true;
    return { ...node, position };
  });
  return touched ? next : null;
}

/**
 * 图签名：把节点（含配置）与连线的语义内容归一为确定字符串，供脏比较。
 * 节点顺序无关（排序后拼接）；坐标以数值原样进入签名。
 */
export function graphSignature(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): string {
  const nodePart = nodes
    .map(
      (node) =>
        `${node.id}|${node.type}|${node.position.x},${node.position.y}|${node.label ?? ""}|${node.refId ?? ""}|${JSON.stringify(node.config ?? {})}`,
    )
    .sort()
    .join(";");
  const edgePart = edges
    .map((edge) => `${edge.source}->${edge.target}|${edge.sourceHandle ?? ""}`)
    .sort()
    .join(";");
  return `${nodePart}#${edgePart}`;
}
