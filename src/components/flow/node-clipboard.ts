import type { WorkflowEdge, WorkflowNode, WorkflowNodeConfig } from "../../api/types";
import { generateRefId } from "./graph-model";

/**
 * 节点复制 / 粘贴的纯逻辑与剪贴板单例（Task 13 Step 3，移植归档
 * node-clipboard.ts，模板改写对齐后端 flow/model.rs 的
 * rewrite_template_node_refs 语义）。
 *
 * 语义约定：
 *   - 复制：截取当前画布上全部选中的节点（config 深拷贝，与原图不共享嵌套
 *     引用）+ 仅两端都选中的「内部连线」；剪贴板内容保留原始 id / refId
 *     （粘贴时才重生成），供内部连线与模板引用重映射。
 *   - 粘贴：节点 / 连线 id 全部重生成；引用短码全部重生成（对目标画布查重），
 *     config 内 `{{ node.<旧id|旧短码>` 模板引用改写到新短码（指向未复制
 *     节点的引用不在映射表，原样保留）；位置按粘贴序次叠加偏移（第 1 次
 *     +24/+24，第 2 次 +48/+48…）；config 为独立深拷贝。
 *   - 剪贴板为模块级单例：跨流程切换（画布重挂载）与跨流程复制粘贴均可用。
 *
 * 纯函数 + 一个无逻辑的存取单例，无 Vue / Vue Flow 依赖，vitest node
 * 环境可直接单测。
 */

/** 每次粘贴叠加的位置偏移（画布像素，肉眼可辨不遮挡原图）。 */
export const PASTE_OFFSET_PX = 24;

/** 节点剪贴板内容：选中的节点（含 config）与它们之间的内部连线。 */
export interface NodeClipboardContent {
  nodes: WorkflowNode[];
  /** 仅 source / target 都在 nodes 中的连线（外部连线不复制）。 */
  edges: WorkflowEdge[];
}

/** pasteNodeClipboard 的可选入参。 */
export interface PasteNodeOptions {
  /** 粘贴目标画布已占用的短码键集合（节点 id + refId），新短码对其查重。 */
  excludeRefKeys?: ReadonlySet<string>;
}

/** 模块级剪贴板单例（跨流程复制粘贴可用）。 */
let clipboard: NodeClipboardContent | null = null;

/** 剪贴板当前是否有可粘贴内容。 */
export function hasNodeClipboard(): boolean {
  return clipboard !== null && clipboard.nodes.length > 0;
}

/** 读取剪贴板内容（无内容返回 null；返回同一引用，调用方不得改写）。 */
export function peekNodeClipboard(): NodeClipboardContent | null {
  return clipboard;
}

/** 覆写剪贴板内容（测试 / 定制注入用；画布复制链路走 copySelectedNodes）。 */
export function setNodeClipboard(content: NodeClipboardContent | null): void {
  clipboard = content;
}

/** config 深拷贝（纯 JSON 数据；undefined 可选字段在副本中自然消失）。 */
function cloneConfig(config: WorkflowNodeConfig): WorkflowNodeConfig {
  return JSON.parse(JSON.stringify(config)) as WorkflowNodeConfig;
}

/**
 * 复制画布上选中的节点到剪贴板（纯函数 + 写入单例）。
 *
 * @param nodes 当前画布节点（领域模型）
 * @param edges 当前画布连线（领域模型）
 * @param selectedIds 选中节点 id 集合
 * @returns 剪贴板内容；无选中节点时剪贴板清空并返回 null
 */
export function copySelectedNodes(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  selectedIds: ReadonlySet<string>,
): NodeClipboardContent | null {
  const selected = nodes.filter((node) => selectedIds.has(node.id));
  if (selected.length === 0) {
    clipboard = null;
    return null;
  }
  clipboard = {
    // 深拷贝：复制后的节点与原图不共享嵌套引用（改副本 config 不影响原节点）
    nodes: selected.map((node) => ({
      ...node,
      position: { x: node.position.x, y: node.position.y },
      config: cloneConfig(node.config),
    })),
    edges: edges.filter(
      (edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target),
    ),
  };
  return clipboard;
}

/**
 * 改写模板字符串中的节点引用 token（对齐后端 rewrite_template_node_refs）：
 * 扫描 `{{ … }}` 表达式，内容 trim 后以 `node.<token>` 开头且 token 命中
 * 映射表时替换为映射值（token 是到下一个「.」或表达式结束为止的完整片段，
 * 不误替换仅前缀相同的 id）；根不是 node / 未命中 / 语法不符的表达式与
 * 未闭合的 `{{` 尾部文本原样保留。
 */
export function rewriteTemplateNodeRefs(
  raw: string,
  refIdByToken: ReadonlyMap<string, string>,
): string {
  if (!raw.includes("{{") || refIdByToken.size === 0) return raw;
  let result = "";
  let cursor = 0;
  for (;;) {
    const open = raw.indexOf("{{", cursor);
    if (open === -1) {
      result += raw.slice(cursor);
      return result;
    }
    const close = raw.indexOf("}}", open + 2);
    if (close === -1) {
      // 未闭合：其余整体按字面量保留（与模板引擎的兜底语义一致）
      result += raw.slice(cursor);
      return result;
    }
    const content = raw.slice(open + 2, close);
    result += raw.slice(cursor, open + 2);
    const trimmed = content.trim();
    if (trimmed.startsWith("node.")) {
      const rest = trimmed.slice("node.".length);
      const dot = rest.indexOf(".");
      const token = dot === -1 ? rest : rest.slice(0, dot);
      const replacement = refIdByToken.get(token);
      if (replacement !== undefined) {
        result += `${content.slice(0, content.length - content.trimStart().length)}node.${replacement}${rest.slice(token.length)}${content.slice(content.trimEnd().length)}}}`;
        cursor = close + 2;
        continue;
      }
    }
    result += `${content}}}`;
    cursor = close + 2;
  }
}

/** 深度改写 config JSON 值中全部字符串的模板引用（对象键不改写）。 */
function remapConfigTemplateRefs(
  value: unknown,
  refIdByToken: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") return rewriteTemplateNodeRefs(value, refIdByToken);
  if (Array.isArray(value)) return value.map((item) => remapConfigTemplateRefs(item, refIdByToken));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, remapConfigTemplateRefs(item, refIdByToken)]),
    );
  }
  return value;
}

/**
 * 从剪贴板生成待粘贴的节点与连线（纯函数，不写入剪贴板）。
 *
 * 节点 / 连线 id 与引用短码全部重生成（短码对 excludeRefKeys 与本批次已生成
 * 键查重，冲突重摇）；节点位置按 pasteIndex 叠加 PASTE_OFFSET_PX 偏移
 * （pasteIndex 从 1 起算）；连线 source / target 重映射到新节点 id；config
 * 深拷贝并改写模板引用（旧节点 id / 旧 refId → 新 refId）。
 *
 * @param content 剪贴板内容（peekNodeClipboard 的产出）
 * @param generateId id 生成器（与画布新建节点同源，crypto.randomUUID）
 * @param pasteIndex 粘贴序次（1 起算；决定位置偏移量）
 * @throws content 为 null 或无节点时抛出（调用方应先用 hasNodeClipboard 判定）
 */
export function pasteNodeClipboard(
  content: NodeClipboardContent,
  generateId: () => string,
  pasteIndex: number,
  options?: PasteNodeOptions,
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  if (content.nodes.length === 0) {
    throw new Error("粘贴失败：剪贴板中没有节点");
  }
  const offset = PASTE_OFFSET_PX * Math.max(1, pasteIndex);
  const taken = new Set(options?.excludeRefKeys);
  const nodeIdMap = new Map<string, string>();
  /** 旧节点 id / 旧 refId → 新 refId（模板改写表，两 token 命名空间合并） */
  const templateMap = new Map<string, string>();
  const refIdByNewId = new Map<string, string>();
  // 先建全量映射再改写 config（下游节点可能前向引用同批次的后继节点）
  for (const node of content.nodes) {
    const newId = generateId();
    const newRefId = generateRefId(taken);
    taken.add(newRefId);
    nodeIdMap.set(node.id, newId);
    refIdByNewId.set(newId, newRefId);
    // 模板 token 可以是旧节点 id（存量口径）或旧 refId，均改写到新 refId
    templateMap.set(node.id, newRefId);
    if (node.refId) templateMap.set(node.refId, newRefId);
  }
  const nodes = content.nodes.map((node) => {
    const newId = nodeIdMap.get(node.id)!;
    return {
      ...node,
      id: newId,
      position: { x: node.position.x + offset, y: node.position.y + offset },
      refId: refIdByNewId.get(newId)!,
      config: remapConfigTemplateRefs(cloneConfig(node.config), templateMap) as WorkflowNodeConfig,
    };
  });
  const edges = content.edges.map((edge) => ({
    ...edge,
    id: generateId(),
    source: nodeIdMap.get(edge.source) ?? edge.source,
    target: nodeIdMap.get(edge.target) ?? edge.target,
  }));
  return { nodes, edges };
}
