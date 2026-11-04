import type { WorkflowEdge, WorkflowNode } from "../../api/types";
import { graphSignature } from "./graph-model";

/**
 * 画布撤销 / 重做的图快照历史（Task 13 Step 3，移植归档 graph-history 的
 * 快照语义并补齐状态机）。
 *
 * 状态机：past（可撤销帧，最新在尾部）+ current（当前图）+ future（已撤销
 * 帧，最新在尾部）。结构化编辑完成后调用 commitGraph 把当前图压入 past
 * （上限裁剪最旧帧）；undo / redo 在 past / future 与 current 间交换快照。
 *
 * 快照深拷贝（含 config 嵌套），画布后续编辑不会改写历史帧；提交前按
 * graphSignature 去重（内容未变不产生新帧，如无位移的拖动收尾）。
 * 纯函数 + 不可变更新，无 Vue 依赖，vitest node 环境可直接单测。
 */

/** 不可变图快照（nodes / edges 均为深拷贝）。 */
export interface GraphSnapshot {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** 图历史状态（past / future 尾部为最新帧）。 */
export interface GraphHistoryState {
  past: GraphSnapshot[];
  current: GraphSnapshot;
  future: GraphSnapshot[];
}

/** 历史上限（可撤销帧数；超出时裁掉最旧帧）。 */
export const GRAPH_HISTORY_LIMIT = 50;

/** 深拷贝图快照（config 为纯 JSON 数据，structuredClone 即可独立成副本）。 */
export function cloneGraphSnapshot(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): GraphSnapshot {
  return {
    nodes: nodes.map((node) => ({
      ...node,
      position: { ...node.position },
      config: structuredClone(node.config),
    })),
    edges: edges.map((edge) => ({ ...edge })),
  };
}

/** 以给定图作为初始 current 建立历史（初始状态不入 past，无可撤销帧）。 */
export function createGraphHistory(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): GraphHistoryState {
  return { past: [], current: cloneGraphSnapshot(nodes, edges), future: [] };
}

/**
 * 提交一次结构化编辑后的新图：与当前帧内容相同则原样返回（无新帧），
 * 否则 current 压入 past（超限裁最旧）并清空 future。
 */
export function commitGraph(
  state: GraphHistoryState,
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): GraphHistoryState {
  if (graphSignature(state.current.nodes, state.current.edges) === graphSignature(nodes, edges)) {
    return state;
  }
  const past = [...state.past, state.current];
  if (past.length > GRAPH_HISTORY_LIMIT) past.splice(0, past.length - GRAPH_HISTORY_LIMIT);
  return { past, current: cloneGraphSnapshot(nodes, edges), future: [] };
}

/** 撤销：返回交换后的新状态与应展示的快照（克隆件，与历史帧隔离）；无可撤销帧返回 null。 */
export function undoGraph(
  state: GraphHistoryState,
): { state: GraphHistoryState; snapshot: GraphSnapshot } | null {
  const previous = state.past[state.past.length - 1];
  if (!previous) return null;
  return {
    state: {
      past: state.past.slice(0, -1),
      current: previous,
      future: [...state.future, state.current],
    },
    snapshot: cloneGraphSnapshot(previous.nodes, previous.edges),
  };
}

/** 重做：返回交换后的新状态与应展示的快照（克隆件，与历史帧隔离）；无可重做帧返回 null。 */
export function redoGraph(
  state: GraphHistoryState,
): { state: GraphHistoryState; snapshot: GraphSnapshot } | null {
  const next = state.future[state.future.length - 1];
  if (!next) return null;
  return {
    state: {
      past: [...state.past, state.current],
      current: next,
      future: state.future.slice(0, -1),
    },
    snapshot: cloneGraphSnapshot(next.nodes, next.edges),
  };
}
