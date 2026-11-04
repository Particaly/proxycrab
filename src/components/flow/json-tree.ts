/**
 * JSON 树数据模型与纯函数（移植上游 json-tree-model.ts + run-record.ts 的
 * 截断包装识别，ReqFlow 复刻 Task 22 薄片 A）。
 *
 * 职责：把任意 JSON 安全值（运行记录节点快照 input / output / 逐迭代明细等）
 * 构建为可渲染的树模型（buildJsonTree），并提供搜索过滤（filterTree）、默认
 * 展开判定（defaultExpanded）、复制文本序列化（stringifyNodeValue）等纯函数。
 * 全部无副作用、不依赖 Vue / DOM，可在 vitest node 环境直接单测；JsonTree.vue
 * 只做渲染与交互编排。
 *
 * 截断快照识别：落库侧可能把超大快照包成 TruncatedSnapshot
 * （`{ __truncated: true, preview: string, originalBytes: number }`，上游定死
 * 的结构），本模块经 isTruncatedSnapshot 识别并把该值建成 kind 'truncated'
 * 的节点（组件侧展示琥珀色徽标 + preview 文本，不尝试解析 preview）。
 *
 * 搜索语义（filterTree，文档化约定）：
 *   - 匹配范围：键名、路径、标量值文本、截断 preview（大小写不敏感的包含匹配）；
 *   - 保留规则：自身命中的节点保留；未命中的容器仅当其子树中存在命中时
 *     作为「祖先链」保留（子节点递归收敛为命中子集）；
 *   - 自身命中的容器保留其完整子树；
 *   - matchCount = 自身命中的节点总数（含容器）；
 *   - autoExpandPaths = 「自身未命中但子树有命中」的容器路径集合。
 */

/** 截断快照包装：对象 / 数组超限时的落库形态（读侧识别契约）。 */
export interface TruncatedSnapshot {
  /** 截断标记，恒为 true。 */
  __truncated: true;
  /** 原值 JSON 序列化文本的前段 + 截断尾部标记。 */
  preview: string;
  /** 最初原值序列化后的 UTF-8 字节数。 */
  originalBytes: number;
}

/**
 * 判断值是否为截断快照包装（字段齐全才认定，避免误伤恰好同形的普通对象）。
 */
export function isTruncatedSnapshot(value: unknown): value is TruncatedSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["__truncated"] === true &&
    typeof record["preview"] === "string" &&
    typeof record["originalBytes"] === "number"
  );
}

/** JSON 值的展示分类（决定分色与渲染形态）。 */
export type JsonValueKind =
  "object" | "array" | "string" | "number" | "boolean" | "null" | "truncated";

/** JSON 树节点（buildJsonTree 产物；filterTree 产物为其浅拷贝收敛版）。 */
export interface JsonTreeNode {
  /** 容器内的键名（对象键 / 数组索引字符串）；根节点为 null。 */
  key: string | null;
  /** 根到该节点的路径：对象用 `.key`、数组用 `[i]` 连接；根为空串。 */
  path: string;
  /** 树深度（根 = 0）。 */
  depth: number;
  kind: JsonValueKind;
  /** 标量值（kind 为 string / number / boolean / null 时有意义）。 */
  value: string | number | boolean | null | undefined;
  /** 子节点（容器）；标量与截断节点为空数组。 */
  children: JsonTreeNode[];
  /** 直接子节点数（容器）；标量为 0。 */
  childCount: number;
  /** 子树节点总数（含自身）。 */
  totalCount: number;
  /** kind === 'truncated' 时的截断包装信息，其余为 null。 */
  truncated: TruncatedSnapshot | null;
  /** 原始值引用（复制用）。 */
  raw: unknown;
  /** 搜索时该节点是否自身命中（非搜索态恒为 false）。 */
  matched: boolean;
}

/** 标量分类集合（判定「有值可展示」的节点）。 */
const SCALAR_KINDS: ReadonlySet<JsonValueKind> = new Set(["string", "number", "boolean", "null"]);

/** 值是否为标量（非容器、非截断包装）。 */
export function isScalarKind(kind: JsonValueKind): boolean {
  return SCALAR_KINDS.has(kind);
}

/** 构建标量节点（容器字段全部取空值）。 */
function scalarNode(
  key: string | null,
  path: string,
  depth: number,
  kind: JsonValueKind,
  value: string | number | boolean | null,
  raw: unknown,
): JsonTreeNode {
  return {
    key,
    path,
    depth,
    kind,
    value,
    children: [],
    childCount: 0,
    totalCount: 1,
    truncated: null,
    raw,
    matched: false,
  };
}

/** 由子节点列表构建容器节点（计数含自身）。 */
function containerNode(
  key: string | null,
  path: string,
  depth: number,
  kind: "object" | "array",
  children: JsonTreeNode[],
  raw: unknown,
): JsonTreeNode {
  let totalCount = 1;
  for (const child of children) totalCount += child.totalCount;
  return {
    key,
    path,
    depth,
    kind,
    value: undefined,
    children,
    childCount: children.length,
    totalCount,
    truncated: null,
    raw,
    matched: false,
  };
}

/**
 * 把任意 JSON 安全值构建为树模型（纯函数）。
 *
 * - 截断快照包装 → kind 'truncated' 节点（preview / 原始字节数挂 truncated
 *   字段，不再展开包装内部字段）；
 * - undefined 按 null 处理（JSON 域不存在 undefined，防御运行中节点的空快照）；
 * - 对象只取自身可枚举键，数组取全部索引，键序保持原样。
 */
export function buildJsonTree(
  value: unknown,
  key: string | null = null,
  path = "",
  depth = 0,
): JsonTreeNode {
  if (isTruncatedSnapshot(value)) {
    return {
      key,
      path,
      depth,
      kind: "truncated",
      value: undefined,
      children: [],
      childCount: 0,
      totalCount: 1,
      truncated: value,
      raw: value,
      matched: false,
    };
  }
  if (value === null || value === undefined) {
    return scalarNode(key, path, depth, "null", null, value);
  }
  const type = typeof value;
  if (type === "string") {
    return scalarNode(key, path, depth, "string", value as string, value);
  }
  if (type === "number") {
    return scalarNode(key, path, depth, "number", value as number, value);
  }
  if (type === "boolean") {
    return scalarNode(key, path, depth, "boolean", value as boolean, value);
  }
  if (Array.isArray(value)) {
    const children = value.map((item, index) =>
      buildJsonTree(item, String(index), `${path}[${index}]`, depth + 1),
    );
    return containerNode(key, path, depth, "array", children, value);
  }
  const record = value as Record<string, unknown>;
  const children = Object.keys(record).map((childKey) =>
    buildJsonTree(
      record[childKey],
      childKey,
      path === "" ? childKey : `${path}.${childKey}`,
      depth + 1,
    ),
  );
  return containerNode(key, path, depth, "object", children, value);
}

/** 默认展开层数：前 2 层（depth 0 / 1）的容器默认展开。 */
export const JSON_TREE_DEFAULT_EXPAND_DEPTH = 2;

/** 单容器默认展开的直接子节点数上限：超过即默认折叠（懒展开防大 DOM）。 */
export const JSON_TREE_COLLAPSE_CHILD_LIMIT = 200;

/** 默认展开的深度上限：超过该深度的容器一律默认折叠。 */
export const JSON_TREE_MAX_AUTO_DEPTH = 6;

/**
 * 容器是否默认展开（纯函数）：前 2 层默认展开；直接子节点超过 200 或深度
 * 超过 6 的容器一律默认折叠（用户手动展开不受限）。
 */
export function defaultExpanded(depth: number, childCount: number): boolean {
  return (
    depth < JSON_TREE_DEFAULT_EXPAND_DEPTH &&
    depth <= JSON_TREE_MAX_AUTO_DEPTH &&
    childCount <= JSON_TREE_COLLAPSE_CHILD_LIMIT
  );
}

/** filterTree 结果。 */
export interface FilterTreeResult {
  /** 过滤后的树；无任何命中时为 null（渲染侧展示「无命中」空态）。 */
  tree: JsonTreeNode | null;
  /** 自身命中的节点总数（含容器）。 */
  matchCount: number;
  /** 搜索激活时建议自动展开的容器路径集合（祖先链）。 */
  autoExpandPaths: ReadonlySet<string>;
}

/** 标量节点的可搜索文本（字符串取原文，其余取 String 形态）。 */
function scalarSearchText(node: JsonTreeNode): string {
  if (node.kind === "string" && typeof node.raw === "string") return node.raw;
  return String(node.value);
}

/** 节点是否自身命中查询词（键名 / 路径 / 标量值 / 截断 preview，包含匹配）。 */
function nodeSelfMatches(node: JsonTreeNode, query: string): boolean {
  if (node.key !== null && node.key.toLowerCase().includes(query)) return true;
  if (node.path !== "" && node.path.toLowerCase().includes(query)) return true;
  if (node.kind === "truncated" && node.truncated !== null) {
    if (node.truncated.preview.toLowerCase().includes(query)) return true;
  }
  if (isScalarKind(node.kind)) {
    return scalarSearchText(node).toLowerCase().includes(query);
  }
  return false;
}

/** 过滤后重算容器计数（childCount / totalCount）。 */
function recountChildren(node: JsonTreeNode, children: JsonTreeNode[]): JsonTreeNode {
  let totalCount = 1;
  for (const child of children) totalCount += child.totalCount;
  return { ...node, children, childCount: children.length, totalCount };
}

/**
 * 按查询词过滤 JSON 树（纯函数）。空查询（含纯空白）原样返回整棵树
 * （matchCount = 0，表示非搜索态而非「无命中」）。
 */
export function filterTree(root: JsonTreeNode, query: string): FilterTreeResult {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") {
    return { tree: root, matchCount: 0, autoExpandPaths: new Set<string>() };
  }

  const matchCount = { value: 0 };
  const autoExpandPaths = new Set<string>();

  /** 递归过滤：返回该子树的过滤结果；容器未命中且子树无命中时收敛为 null。 */
  const filterNode = (node: JsonTreeNode): JsonTreeNode | null => {
    const selfMatch = nodeSelfMatches(node, normalized);
    if (selfMatch) matchCount.value += 1;

    if (node.children.length === 0) {
      return selfMatch ? { ...node, matched: true } : null;
    }
    if (selfMatch) {
      // 自身命中的容器：保留完整子树，便于直接查看命中键的值
      return { ...node, matched: true };
    }
    const kept: JsonTreeNode[] = [];
    for (const child of node.children) {
      const filteredChild = filterNode(child);
      if (filteredChild !== null) kept.push(filteredChild);
    }
    if (kept.length === 0) return null;
    autoExpandPaths.add(node.path);
    return recountChildren({ ...node, matched: false }, kept);
  };

  const filtered = filterNode(root);
  return { tree: filtered, matchCount: matchCount.value, autoExpandPaths };
}

/** JSON 序列化安全包装：失败（循环引用等）退化为占位文本，undefined 记 'null'。 */
function safePrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return '"<unserializable>"';
  }
}

/**
 * 节点复制文本（纯函数）：字符串取原文（不带引号）；标量取 String 形态；
 * 容器取子树 pretty JSON；截断包装取 preview 文本。整树复制即对根调用。
 */
export function stringifyNodeValue(node: JsonTreeNode): string {
  if (node.kind === "truncated") {
    return node.truncated !== null ? node.truncated.preview : "";
  }
  if (node.kind === "object" || node.kind === "array") {
    return safePrettyJson(node.raw);
  }
  if (node.kind === "string" && typeof node.raw === "string") {
    return node.raw;
  }
  return String(node.value);
}
