/**
 * 条件构建器（ConditionBuilder.vue）的纯函数层：编辑草稿树的构造 / 定位 /
 * 不可变变换、右值编辑文本的双向收敛、config 分片的草稿解析与落库序列化。
 *
 * 树类型与编译语义全部复用载荷侧单一事实源 flow-engine/src/condition-builder
 * （与 expression-input 的先例一致：前端不复制引擎逻辑，只编辑树）：
 *   - 树 → 表达式：compileConditionTree（保存出口，产物写入 config.expression）；
 *   - 落库解析：parseConditionTree（脏数据容错）+ migrateConditionRules
 *     （旧扁平规则行迁移）；
 *   - 保存校验 / 摘要：validateConditionTree / describeConditionTree（组件
 *     直接从引擎引入，本模块不重复包装）。
 *
 * 落库形状（对齐 Rust serde 契约，crates/proxy-crab-mitm/src/flow/model.rs 的
 * ConditionGroup / ConditionNode / ConditionLeaf）：根组**不带 type 判别键**
 * （{ op, not?, children }，Rust 根 ConditionGroup 无该字段）；嵌套子项按
 * type 分派（'cond' / 'group'，serde internally tagged）；叶子 right 仅保留
 * 标量（一元操作符保留编辑草稿值，切换操作符往返稳定，编译期忽略）。
 */

import type {
  ConditionGroup,
  ConditionLeaf,
  ConditionNode,
  ConditionOperator,
} from "../../../../flow-engine/src/types";
import {
  compileConditionTree,
  emptyConditionGroup,
  migrateConditionRules,
  parseConditionTree,
  parseRightValue,
} from "../../../../flow-engine/src/condition-builder";

/* ------------------------------------------------------------------ *
 * config 分片（组件 props/emits 的契约形状）
 * ------------------------------------------------------------------ */

/**
 * 条件节点 config 中条件构建器消费的分片（NodeConfig 相关字段的宽容子集）：
 * condition / conditionRules 按 unknown 接收（读取侧经引擎容错解析，脏数据
 * 不抛错），expression 为编译产物的回显原文。
 */
export interface ConditionConfigShard {
  expression?: string;
  conditionRules?: unknown;
  condition?: unknown;
}

/* ------------------------------------------------------------------ *
 * 落库形状（serializeConditionTree 的产物，写入 config.condition）
 * ------------------------------------------------------------------ */

/**
 * 叶子落库形状：right 仅保留标量。一元操作符保留草稿 right（编译与校验对
 * 一元忽略 right；保留可让「一元 ⇄ 二元」切换往返不丢输入）。
 */
export interface StoredConditionLeaf {
  type: "cond";
  left: string;
  operator: ConditionOperator;
  right?: string | number | boolean | null;
}

/** 嵌套分组落库形状（type 判别键保留） */
export interface StoredConditionBranch {
  type: "group";
  op: "and" | "or";
  not?: boolean;
  children: StoredConditionNode[];
}

/** 嵌套子项落库形状（按 type 分派） */
export type StoredConditionNode = StoredConditionLeaf | StoredConditionBranch;

/** 根组落库形状：不带 type 判别键（对齐 Rust 根 ConditionGroup serde 形状） */
export interface StoredConditionTree {
  op: "and" | "or";
  not?: boolean;
  children: StoredConditionNode[];
}

/* ------------------------------------------------------------------ *
 * 编辑草稿树的构造
 * ------------------------------------------------------------------ */

/** 树内定位路径：从根起逐层 children 下标（空数组 = 根组） */
export type ConditionPath = readonly number[];

/** 编辑草稿的新叶子（eq + 空左值 = 留白叶子，编译与校验跳过） */
export function createConditionLeaf(operator: ConditionOperator = "eq"): ConditionLeaf {
  return { type: "cond", left: "", operator };
}

/** 编辑草稿的新嵌套分组（op 可选，缺省 'and'，无子项） */
export function createConditionGroup(op: "and" | "or" = "and"): ConditionGroup {
  return { type: "group", op, children: [] };
}

/** 空根组（新节点缺省草稿） */
export function createConditionTree(): ConditionGroup {
  return emptyConditionGroup();
}

/* ------------------------------------------------------------------ *
 * 不可变树变换（全部返回新树，原树不改动；path / index 越界时原样返回）
 * ------------------------------------------------------------------ */

/** 深拷贝草稿树（节点均为纯对象，逐层展开即可） */
function cloneGroup(group: ConditionGroup): ConditionGroup {
  return {
    ...group,
    children: group.children.map((child) =>
      child.type === "group" ? cloneGroup(child) : { ...child },
    ),
  };
}

/** 按 path 定位分组；任一层缺失或命中的不是分组 → null */
export function getGroupAt(tree: ConditionGroup, path: ConditionPath): ConditionGroup | null {
  let current = tree;
  for (const index of path) {
    const next = current.children[index];
    if (next === undefined || next.type !== "group") return null;
    current = next;
  }
  return current;
}

/**
 * 通用变换：clone 后按 path 定位目标组，交由 mutator 原地修改；mutator 返回
 * 是否发生了修改（目标组缺失 / 下标越界等无操作时返回 false）——未修改时返回
 * 原树引用（编辑操作幂等，调用方可用引用相等判断「无变化」）。
 */
function mutateGroupAt(
  tree: ConditionGroup,
  path: ConditionPath,
  mutator: (group: ConditionGroup) => boolean,
): ConditionGroup {
  const next = cloneGroup(tree);
  const target = getGroupAt(next, path);
  if (target === null || !mutator(target)) return tree;
  return next;
}

/** 在 path 组末尾追加一条留白叶子 */
export function appendLeaf(tree: ConditionGroup, path: ConditionPath): ConditionGroup {
  return mutateGroupAt(tree, path, (group) => {
    group.children.push(createConditionLeaf());
    return true;
  });
}

/** 在 path 组末尾追加一个空嵌套分组 */
export function appendGroup(tree: ConditionGroup, path: ConditionPath): ConditionGroup {
  return mutateGroupAt(tree, path, (group) => {
    group.children.push(createConditionGroup());
    return true;
  });
}

/** 移除 path 组内第 index 个子项（越界原样返回；根组恒保留，可为空） */
export function removeChildAt(
  tree: ConditionGroup,
  path: ConditionPath,
  index: number,
): ConditionGroup {
  return mutateGroupAt(tree, path, (group) => {
    if (index < 0 || index >= group.children.length) return false;
    group.children.splice(index, 1);
    return true;
  });
}

/** 叶子可编辑字段（left / operator / right）的补丁 */
export type ConditionLeafPatch = Partial<Pick<ConditionLeaf, "left" | "operator" | "right">>;

/** 更新 path 组内第 index 个叶子的字段（命中非叶子或越界原样返回） */
export function updateLeafAt(
  tree: ConditionGroup,
  path: ConditionPath,
  index: number,
  patch: ConditionLeafPatch,
): ConditionGroup {
  return mutateGroupAt(tree, path, (group) => {
    const child = group.children[index];
    if (child === undefined || child.type !== "cond") return false;
    group.children[index] = { ...child, ...patch };
    return true;
  });
}

/** 分组可编辑字段（op / not）的补丁 */
export type ConditionGroupPatch = Partial<Pick<ConditionGroup, "op" | "not">>;

/** 更新 path 组的连接方式 / 取反标记 */
export function updateGroupAt(
  tree: ConditionGroup,
  path: ConditionPath,
  patch: ConditionGroupPatch,
): ConditionGroup {
  return mutateGroupAt(tree, path, (group) => {
    Object.assign(group, patch);
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * 右值编辑文本 ⇄ 标量（编辑态统一用文本，落库前收敛为标量）
 * ------------------------------------------------------------------ */

/** 叶子右值 → 编辑文本（字符串 / 数字 / 布尔字符串化；null / undefined / 脏类型 → 空串） */
export function conditionRightText(leaf: ConditionLeaf): string {
  const right = leaf.right;
  if (right === undefined || right === null) return "";
  if (typeof right === "string") return right;
  if (typeof right === "number" || typeof right === "boolean") return String(right);
  return "";
}

/**
 * 编辑文本 → 落库右值标量（引擎 parseRightValue 口径，保证往返稳定）：
 * 含 {{ → 模板字符串原样；纯数字字面量 → number；true / false / null →
 * 对应字面量；其余 → trim 后字符串。
 */
export function parseConditionRightText(text: string): string | number | boolean | null {
  return parseRightValue(text);
}

/* ------------------------------------------------------------------ *
 * 草稿解析与落库序列化
 * ------------------------------------------------------------------ */

/**
 * 从 config 分片解析编辑草稿树（打开抽屉 / 回显的唯一入口）：
 *   - config.condition 存在 → 引擎容错解析（脏数据逐字段回退缺省）；
 *   - 缺树但有旧 conditionRules → migrateConditionRules 迁移（M13-T3 扁平
 *     DNF → 嵌套树，逐字等价）；迁移结果为 null（无有效行）→ 空根组；
 *   - 都无 → 空根组（'and'，无子项）。
 */
export function resolveConditionDraft(config: ConditionConfigShard): ConditionGroup {
  if (config.condition !== undefined && config.condition !== null) {
    return parseConditionTree(config.condition);
  }
  if (config.conditionRules !== undefined && config.conditionRules !== null) {
    const migrated = migrateConditionRules(config.conditionRules);
    if (migrated !== null) return migrated;
  }
  return emptyConditionGroup();
}

/** 叶子 → 落库形状：right 仅保留标量（脏类型按缺省剥离；一元操作符保留草稿值） */
function toStoredLeaf(leaf: ConditionLeaf): StoredConditionLeaf {
  const stored: StoredConditionLeaf = { type: "cond", left: leaf.left, operator: leaf.operator };
  const right = leaf.right;
  if (
    typeof right === "string" ||
    typeof right === "number" ||
    typeof right === "boolean" ||
    right === null
  ) {
    stored.right = right;
  }
  return stored;
}

/** 分组 → 落库形状（嵌套组保留 type 判别键；not = false 不落键） */
function toStoredGroup(group: ConditionGroup): StoredConditionBranch {
  return {
    type: "group",
    op: group.op,
    ...(group.not === true ? { not: true } : {}),
    children: group.children.map(toStoredNode),
  };
}

function toStoredNode(node: ConditionNode): StoredConditionNode {
  return node.type === "group" ? toStoredGroup(node) : toStoredLeaf(node);
}

/**
 * 草稿树 → config.condition 落库形状：根组剥离 type 判别键（对齐 Rust 根
 * ConditionGroup 的 serde 形状），嵌套子项按 type 分派；right 仅保留标量；
 * not = false 不落键。
 */
export function serializeConditionTree(tree: ConditionGroup): StoredConditionTree {
  return {
    op: tree.op,
    ...(tree.not === true ? { not: true } : {}),
    children: tree.children.map(toStoredNode),
  };
}

/**
 * 草稿树 → 保存分片（「编译为 expression」出口）：condition 为落库树、
 * expression 为引擎编译产物（完整函数体，直接写入 config.expression 在既有
 * 沙箱语义下执行）。调用方应先经 validateConditionTree 校验（引擎语义：
 * 整树无有效叶子时编译为空串 = 恒 false）。
 */
export function buildConditionShard(tree: ConditionGroup): {
  condition: StoredConditionTree;
  expression: string;
} {
  return { condition: serializeConditionTree(tree), expression: compileConditionTree(tree) };
}

/* ------------------------------------------------------------------ *
 * 展示辅助（扁平行视图 / 右值类型标注）
 * ------------------------------------------------------------------ */

/** 叶子是否「整行留白」（与引擎 isBlankLeaf 口径一致：左值与右值均空白且操作符仍是缺省 eq） */
export function isBlankConditionLeaf(leaf: ConditionLeaf): boolean {
  return (
    leaf.left.trim() === "" && conditionRightText(leaf).trim() === "" && leaf.operator === "eq"
  );
}

/** 扁平行视图的行：组头（连接方式 / 取反 / 增删操作）或叶子行（左值 / 操作符 / 右值） */
export type ConditionTreeRow =
  | {
      kind: "group";
      key: string;
      /** 组的定位路径（组头操作目标；根 = []） */
      path: ConditionPath;
      /** 嵌套深度（根 = 0，缩进用） */
      depth: number;
      isRoot: boolean;
      op: "and" | "or";
      not: boolean;
      childCount: number;
    }
  | {
      kind: "leaf";
      key: string;
      /** 所属组的定位路径（叶子操作目标） */
      groupPath: ConditionPath;
      /** 组内下标 */
      leafIndex: number;
      /** 嵌套深度（= 所属组深度 + 1，缩进用） */
      depth: number;
      /** 有效条件序号（从 1 起，留白叶子不递增；与校验 / 编译的编号口径一致） */
      position: number;
      leaf: ConditionLeaf;
    };

/**
 * 条件树 → 扁平行序列（深度优先，children 数组顺序）：组头行在前、子项随后，
 * 供组件以 v-for 平铺渲染（缩进表达嵌套），免去模板递归组件。位置编号在
 * 文档顺序上跳过留白叶子（与 validateConditionTree 的「第 N 条条件」一致）。
 */
export function flattenConditionTree(tree: ConditionGroup): ConditionTreeRow[] {
  const rows: ConditionTreeRow[] = [];
  let validCount = 0;

  const visit = (group: ConditionGroup, path: ConditionPath, depth: number): void => {
    rows.push({
      kind: "group",
      key: `g-${path.join("-")}`,
      path,
      depth,
      isRoot: path.length === 0,
      op: group.op,
      not: group.not === true,
      childCount: group.children.length,
    });
    group.children.forEach((child, index) => {
      if (child.type === "group") {
        visit(child, [...path, index], depth + 1);
        return;
      }
      const blank = isBlankConditionLeaf(child);
      const position = blank ? validCount + 1 : (validCount += 1);
      rows.push({
        kind: "leaf",
        key: `l-${path.join("-")}.${index}`,
        groupPath: path,
        leafIndex: index,
        depth: depth + 1,
        position,
        leaf: child,
      });
    });
  };

  visit(tree, [], 0);
  return rows;
}

/**
 * 右值编辑文本 → 类型标注文案（右值输入框旁的收敛提示）：空文本 → null
 * （不渲染）；含 {{ → 「模板」；按引擎 parseRightValue 收敛结果标注
 * 「数字」 / 「布尔」 / 「null」 / 「文本」。
 */
export function describeConditionRightType(text: string): string | null {
  if (text.trim() === "") return null;
  if (text.includes("{{")) return "模板";
  const parsed = parseConditionRightText(text);
  if (typeof parsed === "number") return "数字";
  if (typeof parsed === "boolean") return "布尔";
  if (parsed === null) return "null";
  return "文本";
}
