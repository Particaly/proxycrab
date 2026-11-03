/**
 * 运行时图快照构建（M17-T1）。
 *
 * 背景：运行详情页（/runs/:runId）自 M17 起以「运行画布」呈现——按运行开始
 * 时刻的流程形态还原节点 / 连线，叠加 RunRecord.nodeRuns 的逐节点执行状态。
 * 既有运行记录只存逐节点执行快照、不含图本身，流程一旦被改 / 删就无法还原，
 * 故建 run 时随记录存一份图快照（RunRecord.graph，见 types/model.ts）。
 *
 * buildRunGraphSnapshot（纯函数，零环境依赖，node 可直接单测）三步：
 *   1. **JSON 安全深拷贝**：节点 / 连线与源流程彻底解耦——快照落库后流程继续
 *      编辑（含对象引用复用）不会反向影响已存的运行记录；
 *   2. **恒剥离 config.pinnedOutput**：固定输出是唯一体积大户（单值可达 256KB，
 *      见 NodePinnedOutput 注释），且与「执行情况」展示无关——存在与否都不进快照；
 *   3. **体积上限降级**：整份快照序列化超过 RUN_GRAPH_SNAPSHOT_MAX_BYTES（256KB）
 *      时降级为「骨架」形态——节点仅保留 id / type / position / label? / refId?
 *      （config 清空为 {}），连线照常保留（单条体积小、图形态必需），并置
 *      truncated: true 供读取侧披露「配置未保存」。
 *
 * 确定性：同一份输入重复构建返回深度相等的快照（纯函数，无时钟 / 随机 / 环境依赖）。
 * 图数据幂等：对快照自身的 nodes / edges 再构建，节点与连线深度相等（已无
 * pinnedOutput 可剥；骨架节点的 config 为 {}，重入仍是 {}）；truncated 标志是
 * 本次构建按体积判定的一次性结论，不是快照自身的持久属性。
 *
 * 边界：降级后的骨架形态在同一上限下必然合规（体积回到图形态量级）；极端节点
 * 规模（骨架本身仍超限）如实放行——以「有界 + 可读」优先，不做二次降级循环。
 * 不可序列化值（循环引用等，理论上不应出现）按超限处理，同样走骨架降级。
 */

import type { NodeConfig, Position, RunGraphSnapshot, WorkflowEdge, WorkflowNode } from "./types";
import { utf8ByteLength } from "./utf8";

/** 图快照序列化后的默认字节上限：256KB（与单节点快照 capSnapshot 上限同档） */
export const RUN_GRAPH_SNAPSHOT_MAX_BYTES = 256 * 1024;

/** buildRunGraphSnapshot 选项 */
export interface BuildRunGraphSnapshotOptions {
  /** 序列化字节上限；缺省 RUN_GRAPH_SNAPSHOT_MAX_BYTES（负数按 0 处理） */
  maxBytes?: number;
}

// 【宿主注入点替换】归档此处用 TextEncoder 计量 UTF-8 字节；QuickJS 无该全局，
// 改用 utf8.ts 的纯 JS 等价实现（宿主桥不注入编码器，算法确定性）。

/** JSON 序列化的安全包装：失败（循环引用 / BigInt 等）返回 null 由调用方走降级 */
function safeSerialize(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/** 判断值是否为普通对象（config 防御读取用） */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 防御读取合法坐标（非有限数回退原点，快照仍可渲染） */
function readPosition(value: unknown): Position {
  if (isPlainRecord(value) && Number.isFinite(value["x"]) && Number.isFinite(value["y"])) {
    return { x: value["x"] as number, y: value["y"] as number };
  }
  return { x: 0, y: 0 };
}

/**
 * 节点副本（剥离 config.pinnedOutput；其余 config 字段原样保留，深拷贝交给
 * 外层 JSON 序列化 / 解析完成）。config 非对象（脏数据）时按空配置处理。
 */
function cloneNodeWithoutPinned(node: WorkflowNode): WorkflowNode {
  if (!isPlainRecord(node.config)) return { ...node, config: {} };
  const config: NodeConfig = { ...node.config };
  delete config.pinnedOutput;
  return { ...node, config };
}

/** 连线副本（保留 id / source / target / sourceHandle，剥离运行时多余字段） */
function cloneEdge(edge: WorkflowEdge): WorkflowEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle !== undefined ? { sourceHandle: edge.sourceHandle } : {}),
  };
}

/** 骨架节点（体积降级形态：仅图形态必需字段，config 清空） */
function toSkeletonNode(node: WorkflowNode): WorkflowNode {
  return {
    id: node.id,
    type: node.type,
    position: readPosition(node.position),
    config: {},
    ...(typeof node.label === "string" ? { label: node.label } : {}),
    ...(typeof node.refId === "string" ? { refId: node.refId } : {}),
  };
}

/**
 * 构建运行时图快照（纯函数；语义见文件头）。
 *
 * @param nodes 运行开始时刻的流程节点（领域模型，容忍运行时脏数据）
 * @param edges 运行开始时刻的流程连线
 * @param options 体积控制参数（maxBytes 缺省 256KB）
 * @returns 可随 RunRecord 落库的图快照（超限时 truncated: true + 骨架节点）
 */
export function buildRunGraphSnapshot(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  options: BuildRunGraphSnapshotOptions = {},
): RunGraphSnapshot {
  const maxBytes = Math.max(0, options.maxBytes ?? RUN_GRAPH_SNAPSHOT_MAX_BYTES);
  const staged = { nodes: nodes.map(cloneNodeWithoutPinned), edges: edges.map(cloneEdge) };
  const serialized = safeSerialize(staged);
  if (serialized !== null && utf8ByteLength(serialized) <= maxBytes) {
    // JSON 往返完成深拷贝：产出与源流程零共享引用的纯数据副本
    const cloned = JSON.parse(serialized) as { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
    return { nodes: cloned.nodes, edges: cloned.edges };
  }
  return {
    nodes: nodes.map(toSkeletonNode),
    edges: edges.map(cloneEdge),
    truncated: true,
  };
}
