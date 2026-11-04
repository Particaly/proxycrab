import type { WorkflowEdge, WorkflowNode } from "../../api/types";
import { FLOW_NODE_SIZE } from "./graph-model";

/**
 * 画布自动布局纯函数（移植归档 ReqFlow components/flow/auto-layout.ts）。
 *
 * autoLayout(nodes, edges) 按拓扑层级分层重排：
 *   - 分层：最长路径分层（Kahn 拓扑序 BFS）——无入边（无依赖）节点归首层，
 *     其余节点层号 = 已分层前驱的最大层号 + 1；
 *   - 环兜底：环上节点永远入度为 0 不可达，BFS 排空后按「注册顺序」（节点
 *     数组顺序）取第一个未分层节点强制入队，保证 O(V+E) 内必然终止、不死
 *     循环，且同输入结果确定；
 *   - 坐标：层 = 列（从左到右，层间距恒定），同层节点按数组顺序自上而下
 *     垂直均布（行距恒定）。
 *
 * 容错：连线端点不在节点集合（悬空边）与自环边不参与分层；全部输入节点
 * 都会得到坐标。无 Vue / store 依赖，vitest node 环境可直接单测。
 */

/** 相邻两层的水平间距（层间距，像素）。 */
export const AUTO_LAYOUT_COLUMN_GAP = 100;

/** 同层相邻两节点的垂直间距（像素）。 */
export const AUTO_LAYOUT_ROW_GAP = 40;

/**
 * 计算自动布局坐标：按拓扑层级分层，返回每个节点的左上角坐标。
 *
 * @param nodes 领域节点数组（数组顺序 = 注册顺序，参与环兜底与同层排序）
 * @param edges 领域连线数组
 * @returns 节点 id → 坐标（覆盖全部输入节点）
 */
export function autoLayout(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): Record<string, { x: number; y: number }> {
  /* ---------------------------- 邻接表与入度 ---------------------------- */
  const indegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.id, 0);
    successors.set(node.id, []);
  }
  for (const edge of edges) {
    // 悬空边（端点不在节点集合）与自环不参与分层
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    successors.get(edge.source)?.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  /* ------------------- 最长路径分层（Kahn + 环兜底） ------------------- */
  const layer = new Map<string, number>();
  const processed = new Set<string>();
  const queued = new Set<string>();
  const queue: string[] = [];

  const enqueue = (id: string): void => {
    if (processed.has(id) || queued.has(id)) return;
    queued.add(id);
    queue.push(id);
  };

  // 首层：无依赖（入度 0）节点，按数组顺序
  for (const node of nodes) {
    if ((indegree.get(node.id) ?? 0) === 0) enqueue(node.id);
  }

  while (processed.size < nodes.length) {
    if (queue.length === 0) {
      // 环兜底：按数组顺序强制分层第一个未处理节点（其层号已由已处理前驱
      // 预写为最大层 + 1，无已处理前驱则为 0）。每次强制至少处理一个节点，
      // 循环必然在有限步内终止。
      const forced = nodes.find((node) => !processed.has(node.id));
      if (forced === undefined) break;
      enqueue(forced.id);
    }
    const current = queue.shift();
    if (current === undefined) break;
    queued.delete(current);
    processed.add(current);
    const currentLayer = layer.get(current) ?? 0;
    // 记录本节点最终层号（根 / 强制入队节点此前未写入 layer，缺省首层 0）
    layer.set(current, currentLayer);
    for (const succ of successors.get(current) ?? []) {
      if (processed.has(succ)) continue;
      layer.set(succ, Math.max(layer.get(succ) ?? 0, currentLayer + 1));
      indegree.set(succ, (indegree.get(succ) ?? 0) - 1);
      if ((indegree.get(succ) ?? 0) === 0) enqueue(succ);
    }
  }

  /* -------------------------------- 坐标铺排 -------------------------------- */
  // 层号可能出现空洞（脏数据），压缩为连续列号保证层间距恒定
  const layerValues = [...new Set(layer.values())].sort((a, b) => a - b);
  const columnOfLayer = new Map(layerValues.map((value, index) => [value, index]));
  // 同层节点按数组（注册）顺序排列，保证坐标确定
  const columns: string[][] = layerValues.map(() => []);
  for (const node of nodes) {
    const column = columnOfLayer.get(layer.get(node.id) ?? 0) ?? 0;
    columns[column]?.push(node.id);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  columns.forEach((column, columnIndex) => {
    column.forEach((id, rowIndex) => {
      positions[id] = {
        x: columnIndex * (FLOW_NODE_SIZE.width + AUTO_LAYOUT_COLUMN_GAP),
        y: rowIndex * (FLOW_NODE_SIZE.height + AUTO_LAYOUT_ROW_GAP),
      };
    });
  });
  return positions;
}
