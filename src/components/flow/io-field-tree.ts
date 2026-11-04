/**
 * IO 字段树构造 / 搜索过滤 / 展开行扁平化（ReqFlow 复刻计划 Task 15 薄片 B Step 3）。
 *
 * NodeIoDrawer 的字段树数据层：承接 `input-paths.collectJsonPaths` 的点分路径
 * 清单（入参 / 出参 JSON 样本收集，路径语义与 flow-engine resolvePath 一致），
 * 做层级树构造（本任务口径——上游 @ 485fa00 是扁平 chip 流 + JSON 树查看器
 * 双轨，本仓合并为单棵可展开字段树），并给出树内搜索过滤与展开行扁平化
 * （组件直接渲染扁平行清单，避免递归组件）。
 *
 * 搜索口径：复用 `expression-suggest.matchesPathSegments` 的路径段前缀语义
 * （`json.d` → `json.data.*`，与提示浮层深路径候选同源，保证「提示里能补全的」
 * 与「这里能搜到的」一致），并放宽整路径子串兜底——搜索框是自由输入，需要
 * 命中路径中段的片段（`token` → `json.data.token`）。
 *
 * 纯函数、零运行时依赖（仅编译期引用上述两个纯函数模块），node 可直接单测。
 */

import { matchesPathSegments } from "../expression-input/expression-suggest";
import { collectJsonPaths } from "../expression-input/input-paths";

/** 字段树节点（点分路径的一段对应一个节点） */
export interface IoFieldTreeNode {
  /** 末段名（展示文案；数组下标段为十进制字符串，如 "0"） */
  name: string;
  /** 自根到本节点的完整点分路径（与 collectJsonPaths 产出口径一致） */
  path: string;
  /** 层级深度（顶层为 0） */
  depth: number;
  /** 子字段（样本键序；空数组 = 叶子字段） */
  children: IoFieldTreeNode[];
}

/**
 * 由 JSON 样本构造层级字段树。
 *
 * 路径来自 collectJsonPaths（深度 6 / 总数 60、数组采样前 3 个元素的既有
 * 上限兜底，防大响应体撑爆树）；其先父后子的产出顺序保证按序逐段插入即可
 * 成树（缺失中间段时防御性补容器节点，不改原清单语义）。
 *
 * @param sample 入参 / 出参 JSON 样本（任意 JSON 值；原始值产出空树）
 */
export function buildFieldTree(sample: unknown): IoFieldTreeNode[] {
  const root: IoFieldTreeNode = { name: "", path: "", depth: -1, children: [] };
  for (const path of collectJsonPaths(sample)) {
    let current = root;
    let prefix = "";
    for (const segment of path.split(".")) {
      prefix = prefix === "" ? segment : `${prefix}.${segment}`;
      let next = current.children.find((child) => child.path === prefix);
      if (next === undefined) {
        next = { name: segment, path: prefix, depth: current.depth + 1, children: [] };
        current.children.push(next);
      }
      current = next;
    }
  }
  return root.children;
}

/**
 * 单路径搜索匹配（详见模块头「搜索口径」）。
 *
 * @param path 完整点分路径
 * @param query 搜索框输入（首尾空白忽略；空查询恒匹配）
 */
export function matchFieldPath(path: string, query: string): boolean {
  const keyword = query.trim().toLowerCase();
  if (keyword === "") return true;
  if (matchesPathSegments(path, keyword.split("."))) return true;
  return path.toLowerCase().includes(keyword);
}

/**
 * 树内搜索过滤：保留自身命中的节点及其子树、保留命中节点的祖先链（维持
 * 层级上下文）。祖先自身命中即意味着整子树命中（子路径包含祖先路径），
 * 与「保留命中后代」在实现上自然合并。空查询返回浅拷贝（不改原树）。
 *
 * @param nodes 待过滤的字段树
 * @param query 搜索框输入
 */
export function filterFieldTree(
  nodes: ReadonlyArray<IoFieldTreeNode>,
  query: string,
): IoFieldTreeNode[] {
  const keyword = query.trim().toLowerCase();
  if (keyword === "") return [...nodes];
  const walk = (list: ReadonlyArray<IoFieldTreeNode>): IoFieldTreeNode[] => {
    const result: IoFieldTreeNode[] = [];
    for (const node of list) {
      const children = walk(node.children);
      if (matchFieldPath(node.path, keyword) || children.length > 0) {
        result.push({ ...node, children });
      }
    }
    return result;
  };
  return walk(nodes);
}

/** 展开与否的判定回调（组件注入：顶层默认展开 / 搜索时全展开 / 用户手动展开集） */
export type IoFieldExpanded = (node: IoFieldTreeNode) => boolean;

/** 扁平化后的可见行（组件按行渲染，行内自带缩进深度与展开态） */
export interface IoFieldRow {
  /** 完整点分路径（复制 / 拖拽载荷与展开态键） */
  path: string;
  /** 末段名（展示文案） */
  name: string;
  /** 层级深度（顶层为 0，驱动缩进） */
  depth: number;
  /** 是否有子字段（决定渲染展开箭头还是叶子圆点） */
  hasChildren: boolean;
  /** 当前是否展开（仅 hasChildren 为 true 时有意义） */
  expanded: boolean;
}

/**
 * 把（过滤后的）字段树扁平化为可见行清单：节点展开时其子行紧随其后
 * （先序遍历）。容器节点即使收起也输出自身行——容器路径本身可引用
 * （与 collectJsonPaths 对容器同样产出路径一致）。
 *
 * @param nodes 字段树（通常为 filterFieldTree 的结果）
 * @param isExpanded 展开判定回调
 */
export function flattenFieldTree(
  nodes: ReadonlyArray<IoFieldTreeNode>,
  isExpanded: IoFieldExpanded,
): IoFieldRow[] {
  const rows: IoFieldRow[] = [];
  const walk = (list: ReadonlyArray<IoFieldTreeNode>): void => {
    for (const node of list) {
      const hasChildren = node.children.length > 0;
      const expanded = hasChildren && isExpanded(node);
      rows.push({
        path: node.path,
        name: node.name,
        depth: node.depth,
        hasChildren,
        expanded,
      });
      if (expanded) walk(node.children);
    }
  };
  walk(nodes);
  return rows;
}

/**
 * 统计字段总数（含容器节点——容器路径同样可引用，与 collectJsonPaths
 * 产出数量一致）。用于分组头部「N 字段」计数与过滤态「匹配数 / 总数」。
 */
export function countFieldNodes(nodes: ReadonlyArray<IoFieldTreeNode>): number {
  return nodes.reduce((sum, node) => sum + 1 + countFieldNodes(node.children), 0);
}
