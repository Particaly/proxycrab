import type { WorkflowEdge, WorkflowNode } from "../../api/types";

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
 * 后续小地图 / 运行态按类型处理。
 */
export function toFlowNodes(
  nodes: WorkflowNode[],
): Array<{
  id: string;
  type: string;
  position: { x: number; y: number };
  data: { node: WorkflowNode };
}> {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: { x: node.position.x, y: node.position.y },
    data: { node },
  }));
}

/** 把模型连线投影为 Vue Flow 连线（条件分支的 sourceHandle 直接透传）。 */
export function toFlowEdges(
  edges: WorkflowEdge[],
): Array<{ id: string; source: string; target: string; sourceHandle?: string }> {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
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
export function graphSignature(nodes: WorkflowNode[], edges: WorkflowEdge[]): string {
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
