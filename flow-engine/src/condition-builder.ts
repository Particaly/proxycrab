/**
 * 条件节点可视化构建器（M13-T3 引入，M16-T2 重构为嵌套分组树）：
 * 结构化条件树（分组 且/或/非 + 叶子「左值 操作符 右值」，任意层级嵌套）
 * → 等价 JS 条件表达式的纯函数编译器、保存前校验、旧数据迁移与摘要。
 *
 * 落库形态：编译产物直接写入 condition 节点既有的 config.expression（脚本函数体，
 * 形参 input / vars，返回值经 JS truthy 判定——语义见 engine/logic-nodes.ts），
 * 执行引擎零改动；条件树另存于 config.condition（可视化构建器的唯一事实来源，
 * 运行时不读）。**不提供代码编辑**：抽屉只暴露分组树编辑，表达式恒为编译产物。
 *
 * ─── 结构语义 ──────────────────────────────────────────────────────────
 *
 * 树节点（types/model.ts 的 ConditionNode）：
 *
 *   { type: 'group', op: 'and' | 'or', not?: boolean, children: [...] }
 *   { type: 'cond', left: '{{status}}', operator: 'eq', right: 'paid' }
 *
 *   - 组内按 op 连接（'and' → &&，'or' → ||），可任意层级嵌套——M13-T3 的
 *     扁平「组内 AND、组间 OR」DNF 由本结构自然覆盖（旧规则行经
 *     migrateConditionRules 迁为「根 OR 组 + 各组 AND」即逐字等价）；
 *   - not: true → 整组取反（!）；叶子不提供 not（负向语义由 ne /
 *     notContains / isEmpty / isFalse 等操作符表达，避免两套等价写法）；
 *   - 空白叶子（左 / 右值均留白且操作符仍是缺省的 eq）不参与编译与校验
 *     （与行编辑器的「空行跳过」口径一致）；空组为中性直接跳过；
 *     整树无有效叶子 → 编译为空串（与既有「空表达式恒为 false」语义一致）。
 *
 * ─── 取值口径（与引擎既有 condition 语义一致）──────────────────────────
 *
 * 引擎的 condition runner（logic-nodes.ts 的 createConditionRunner）不渲染模板：
 * 表达式以原始 input / vars 形参直接求值（「求值内取值」）。据此：
 *   - 左值整串恰为一个合法引用（`{{ input.a.b }}` / `{{ var.x }}` / 裸路径
 *     `{{ status }}` / `{{ $json.a }}`）→ 编译为表达式内的**原始值**取数
 *     （等价于手写 `input.a.b` / `vars.x`），数值比较因此能拿到原始数字；
 *   - 其余形态（纯文本 / 混合模板）→ 编译为**渲染字符串**：文本原样、引用按
 *     renderTemplate 的字符串化口径拼接（string→原样、number/boolean→String、
 *     对象/数组→JSON 文本、null/undefined→空串），与「左值模板先渲染再比较」
 *     的渲染口径一致；整串留空 → 空串。
 *   - 右值可为标量：字符串按上述模板口径；number / boolean / null 按字面量
 *     内插（`100` → `__eq(x, 100)`）；右值留空 → 空串（`''`）。
 *     文本形态的右值经 parseRightValue 在保存 / 编译时收敛（纯数字 → number、
 *     true/false/null → 字面量、含 {{ }} 或其余 → string），保证往返稳定。
 *   - 首尾空白忽略：整串 trim 后判定是否单一引用（纯输入便利性；混合模板的
 *     内部空白仍按原文保留）。
 *   - `{{ node.* }}` / `{{ env.* }}` 引用在条件沙箱不可用（函数形参只有
 *     input / vars，见 logic-nodes.ts）→ 保存校验阻断（compileValueTemplate
 *     防御性地编译为 undefined，不做静默假数据）。
 *
 * ─── 比较语义（逐操作符，含边界决策）───────────────────────────────────
 *
 * 「数值收敛」的准入（__nl）：值是有限数字，或非空且 Number() 有限的字符串
 * （如 '200'、' 42 '；布尔 / null / undefined / 空串不算——Number(null)=0、
 * Number('')=0 会制造反直觉等价）。字符串按 JS Number 口径解析（'0x10' 亦可
 * 数值化——与手写表达式的隐式转换一致，不额外设白名单）。
 *   - eq / ne    ：两侧均可数值化 → 按数字比较（`status(200)` 与右值 '200'
 *                  命中、`body.code('0')` 与 '0' 命中）；否则按**原始值严格
 *                  相等**（===）。推论（有意决策）：'0' 与 '00' 数值语义下
 *                  相等；路径缺失（undefined）与空串不相等（判空请用「为空」
 *                  操作符）。**右值标量收敛（M16-T2）**：右值文本经
 *                  parseRightValue 收敛为字面量——`100` → number、`true` →
 *                  boolean、`null` → null，故布尔字段用「等于 true」即可命中
 *                  （旧版文本右值恒为字符串，布尔与文本 'true' 不相等只能手写
 *                  表达式；本工具已无代码编辑，收敛是判布尔的必要表达）。
 *                  字符串字段与文本 'true' / 'false' / 'null' 的相等比较收敛后
 *                  不再命中（这类字面量文本请改用「匹配正则」或改用为真 / 为假）。
 *   - gt/gte/lt/lte：两侧均可数值化 → 数字比较；任一侧不可数值化（含 NaN）→
 *                  该行不命中（false）。NaN 决策：不可比较即不命中——大小
 *                  比较没有「反向命中」的操作符，false 是最不意外的失败方向。
 *   - contains / notContains：左值为数组 → 成员命中（原始值相等或字符串化后
 *                  相等，即元素级 contains）；否则两侧字符串化后做子串包含。
 *                  notContains = contains 取反。
 *   - startsWith / endsWith：两侧字符串化后做前缀 / 后缀比较。
 *   - isTrue / isFalse：左值按 JS 真值判定（Boolean(left)）——非空串 / 非零 /
 *                  非 null / 非 false / 非空容器即为真；判布尔字段的常用写法，
 *                  两者互为取反。
 *   - matches    ：右值（字符串化后）作为正则源 new RegExp(src)，对左值字符串
 *                  化结果 test。不带标志位；运行期模板渲染出非法正则 → 表达式
 *                  抛错 → 节点 failed（与手写 `new RegExp(...)` 抛错语义一致），
 *                  保存期对纯文本右值做编译预检拦截。
 *   - isEmpty / isNotEmpty：为空 = null / undefined / 空串 / 空数组 / 空对象
 *                  （「空容器也算空」是低代码工具的直觉口径；非空容器与空白
 *                  字符串不算空）。左值允许留空 = 判断整个入参根 input
 *                  （上游无输出 / 聚合为空的常用检查）；isTrue / isFalse 同样
 *                  允许留空。
 *
 * ─── 本模块的职责边界 ─────────────────────────────────────────────────
 *
 * 纯函数、零环境依赖（不依赖 React / 存储 / 网络 / chrome.*），node 环境可直接
 * 单测（等价性测试经 runConditionExpression 在真实引擎语义下执行编译产物）。
 * 抽屉交互（分组编辑 / 只读分支摘要）见 LogicNodeConfigDrawer。与
 * logic-nodes.ts / template.ts 同策略：不通过 src/engine/index.ts 桶文件再导出，
 * 调用方按路径 `@/engine/condition-builder` 引入。
 */

import type {
  ConditionGroup,
  ConditionLeaf,
  ConditionNode,
  ConditionOperator,
  ConditionRuleRow,
} from "./types";
import { parseTemplate } from "./template";
import type { TemplateRef } from "./template";

/* ------------------------------------------------------------------ *
 * 操作符清单（UI 下拉与「是否需要右值」判定的唯一数据源）
 * ------------------------------------------------------------------ */

/** 条件操作符元数据：value 落库、label 展示、needsRight 决定右值输入框渲染 */
export interface ConditionOperatorMeta {
  value: ConditionOperator;
  label: string;
  /** 该操作符是否使用右值（isEmpty / isNotEmpty / isTrue / isFalse 不渲染右值输入） */
  needsRight: boolean;
}

/** 全部支持的操作符（展示顺序即下拉顺序；语义见文件头「比较语义」） */
export const CONDITION_OPERATORS: ReadonlyArray<ConditionOperatorMeta> = [
  { value: "eq", label: "等于", needsRight: true },
  { value: "ne", label: "不等于", needsRight: true },
  { value: "gt", label: "大于", needsRight: true },
  { value: "gte", label: "大于等于", needsRight: true },
  { value: "lt", label: "小于", needsRight: true },
  { value: "lte", label: "小于等于", needsRight: true },
  { value: "contains", label: "包含", needsRight: true },
  { value: "notContains", label: "不包含", needsRight: true },
  { value: "startsWith", label: "开头是", needsRight: true },
  { value: "endsWith", label: "结尾是", needsRight: true },
  { value: "isEmpty", label: "为空", needsRight: false },
  { value: "isNotEmpty", label: "不为空", needsRight: false },
  { value: "isTrue", label: "为真", needsRight: false },
  { value: "isFalse", label: "为假", needsRight: false },
  { value: "matches", label: "匹配正则", needsRight: true },
];

/** 按取值查操作符元数据（脏数据回退判定用） */
function findOperatorMeta(value: unknown): ConditionOperatorMeta | undefined {
  return CONDITION_OPERATORS.find((meta) => meta.value === value);
}

/** 该操作符是否需要右值（脏数据取值按「需要」兜底——多渲染一个输入框无副作用） */
export function operatorNeedsRight(op: ConditionOperator): boolean {
  return findOperatorMeta(op)?.needsRight ?? true;
}

/* ------------------------------------------------------------------ *
 * 表达式内辅助函数（编译产物的运行时前置，逐条与引擎口径对齐）
 * ------------------------------------------------------------------ */

/**
 * 编译产物的辅助函数库：name 即表达式内的标识符；code 为注入产物的源码；
 * deps 为依赖的其它辅助（发射时按依赖闭包裁剪，产物只含实际用到的辅助）。
 * 注意 code 内的正则等含 `\` 的内容需在 TS 模板串中双写转义。
 */
interface RuntimeHelper {
  name: string;
  code: string;
  deps: ReadonlyArray<string>;
}

/**
 * 辅助函数源码库（发射顺序 = 定义顺序，保证 const 先声明后使用）：
 *   - __p    ：点分路径取数（与 engine/template.ts 的 resolvePath 同口径：
 *              数组段须为规范十进制下标且不越界、对象段 hasOwnProperty 精确
 *              匹配、原型链键不可引用、任一段缺失返回 undefined）；
 *   - __s    ：字符串化（renderTemplate 的 stringifyValue 口径 + null/undefined→
 *              空串——渲染层对空值同样输出空串）；
 *   - __nl   ：数值收敛准入（见文件头「数值收敛的准入」）；
 *   - __eq 等：逐操作符实现（语义见文件头「比较语义」）。
 */
const RUNTIME_HELPERS: ReadonlyArray<RuntimeHelper> = [
  {
    name: "__p",
    deps: [],
    code: `const __p = (root, path) => {
  if (path === '') return root;
  let c = root;
  for (const seg of path.split('.')) {
    if (c === null || typeof c !== 'object') return undefined;
    if (Array.isArray(c)) {
      if (!/^(0|[1-9]\\d*)$/.test(seg) || Number(seg) >= c.length) return undefined;
      c = c[Number(seg)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(c, seg)) return undefined;
      c = c[seg];
    }
  }
  return c;
};`,
  },
  {
    name: "__s",
    deps: [],
    code: `const __s = (v) => v === undefined || v === null ? '' : typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : (JSON.stringify(v) ?? '');`,
  },
  {
    name: "__nl",
    deps: [],
    code: `const __nl = (v) => typeof v === 'number' ? Number.isFinite(v) : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));`,
  },
  {
    name: "__eq",
    deps: ["__nl"],
    code: `const __eq = (l, r) => __nl(l) && __nl(r) ? Number(l) === Number(r) : l === r;`,
  },
  { name: "__ne", deps: ["__eq"], code: `const __ne = (l, r) => !__eq(l, r);` },
  {
    name: "__gt",
    deps: ["__nl"],
    code: `const __gt = (l, r) => __nl(l) && __nl(r) && Number(l) > Number(r);`,
  },
  {
    name: "__gte",
    deps: ["__nl"],
    code: `const __gte = (l, r) => __nl(l) && __nl(r) && Number(l) >= Number(r);`,
  },
  {
    name: "__lt",
    deps: ["__nl"],
    code: `const __lt = (l, r) => __nl(l) && __nl(r) && Number(l) < Number(r);`,
  },
  {
    name: "__lte",
    deps: ["__nl"],
    code: `const __lte = (l, r) => __nl(l) && __nl(r) && Number(l) <= Number(r);`,
  },
  {
    name: "__has",
    deps: ["__s"],
    code: `const __has = (l, r) => Array.isArray(l) ? l.some((item) => item === r || __s(item) === __s(r)) : __s(l).includes(__s(r));`,
  },
  {
    name: "__starts",
    deps: ["__s"],
    code: `const __starts = (l, r) => __s(l).startsWith(__s(r));`,
  },
  { name: "__ends", deps: ["__s"], code: `const __ends = (l, r) => __s(l).endsWith(__s(r));` },
  { name: "__re", deps: ["__s"], code: `const __re = (l, src) => new RegExp(src).test(__s(l));` },
  { name: "__truthy", deps: [], code: `const __truthy = (v) => Boolean(v);` },
  {
    name: "__empty",
    deps: [],
    code: `const __empty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);`,
  },
];

/** 产物头部注释（识别编译产物的标记；本工具不提供代码编辑，仅供读侧定位） */
const COMPILED_HEADER = `/* ReqFlow 条件构建器编译产物（分组树 → 等价 JS）；请在条件配置中修改，勿手改 */`;

/* ------------------------------------------------------------------ *
 * 模板值 → 表达式代码
 * ------------------------------------------------------------------ */

/** 单个模板引用 → 表达式内的原始值取数代码（node / env 沙箱不可用，防御性 undefined） */
function compileRefAccess(ref: TemplateRef): string {
  if (ref.kind === "input") return `__p(input, ${JSON.stringify(ref.path)})`;
  if (ref.kind === "var") {
    // 变量引用：vars 根 + 变量名 + 子路径合成一条点分路径（与手写 vars.a.b 同口径）
    const path = ref.path !== "" ? `${ref.name ?? ""}.${ref.path}` : (ref.name ?? "");
    return `__p(vars, ${JSON.stringify(path)})`;
  }
  return "undefined";
}

/**
 * 值模板 → 表达式代码：整串恰为一个合法引用 → 原始值取数（见文件头「取值
 * 口径」）；其余 → 渲染字符串拼接（未知引用段按 renderTemplate 口径输出空串）。
 * 返回值为可直接内插的表达式源码（恒为字符串结果或原始值）。
 */
function compileValueTemplate(raw: string): string {
  const tokens = parseTemplate(raw.trim());
  if (tokens.length === 1 && tokens[0].kind === "expression" && tokens[0].ref !== null) {
    return compileRefAccess(tokens[0].ref);
  }
  const parts: string[] = [];
  for (const token of tokens) {
    if (token.kind === "text") {
      parts.push(JSON.stringify(token.value));
      continue;
    }
    parts.push(token.ref !== null ? `__s(${compileRefAccess(token.ref)})` : `''`);
  }
  return parts.length > 0 ? parts.join(" + ") : `''`;
}

/* ------------------------------------------------------------------ *
 * 右值标量收敛
 * ------------------------------------------------------------------ */

/**
 * 右值文本 → 落库标量（保存与编译共用，保证往返稳定）：
 *   - 含 `{{` → trim 后原样字符串（模板，运行期按模板口径渲染）；
 *   - 纯 JSON 数字字面量（整数 / 小数 / 科学计数）→ number（用户的 `100`
 *     落库即数字）；
 *   - `true` / `false` / `null` → 对应字面量；
 *   - 其余（非数字文本等）→ trim 后字符串。
 */
export function parseRightValue(text: string): string | number | boolean | null {
  const trimmed = text.trim();
  if (trimmed.includes("{{")) return trimmed;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  return trimmed;
}

/** 标量右值 → 表达式代码（字符串走模板口径，其余按字面量内插） */
function compileRightValue(right: unknown): string {
  if (typeof right === "string") return compileValueTemplate(right);
  if (right === null) return "null";
  if (typeof right === "number" || typeof right === "boolean") return JSON.stringify(right);
  // 脏数据（对象 / 数组 / undefined 等）：按空串处理（与留空右值同口径）
  return `''`;
}

/* ------------------------------------------------------------------ *
 * 叶子 / 分组 → 判定代码
 * ------------------------------------------------------------------ */

/** 右值的文本形态（标量 → 文本；undefined / 脏类型 → 空串） */
function rightTextOf(leaf: ConditionLeaf): string {
  const right = leaf.right;
  if (right === undefined || right === null) return "";
  if (typeof right === "string") return right;
  if (typeof right === "number" || typeof right === "boolean") return String(right);
  return "";
}

/**
 * 判断叶子是否为「整行留白」：左值与右值均空白、且操作符仍是缺省的 eq。
 * 留白叶子不参与编译与校验（与赋值 / 断言行编辑器的「空行跳过」口径一致）；
 * 改过操作符的叶子视为有效意图（如「为空」+ 空左值 = 判断入参根），不跳过。
 */
function isBlankLeaf(leaf: ConditionLeaf): boolean {
  return leaf.left.trim() === "" && rightTextOf(leaf).trim() === "" && leaf.operator === "eq";
}

/** 单条叶子 → 判定表达式代码（左值留空仅一元操作符合法 = 入参根） */
function compileLeaf(leaf: ConditionLeaf): string {
  const left = leaf.left.trim() === "" ? "input" : compileValueTemplate(leaf.left);
  const right = compileRightValue(
    typeof leaf.right === "string" ? parseRightValue(leaf.right) : leaf.right,
  );
  switch (leaf.operator) {
    case "eq":
      return `__eq(${left}, ${right})`;
    case "ne":
      return `!__eq(${left}, ${right})`;
    case "gt":
      return `__gt(${left}, ${right})`;
    case "gte":
      return `__gte(${left}, ${right})`;
    case "lt":
      return `__lt(${left}, ${right})`;
    case "lte":
      return `__lte(${left}, ${right})`;
    case "contains":
      return `__has(${left}, ${right})`;
    case "notContains":
      return `!__has(${left}, ${right})`;
    case "startsWith":
      return `__starts(${left}, ${right})`;
    case "endsWith":
      return `__ends(${left}, ${right})`;
    case "isEmpty":
      return `__empty(${left})`;
    case "isNotEmpty":
      return `!__empty(${left})`;
    case "isTrue":
      return `__truthy(${left})`;
    case "isFalse":
      return `!__truthy(${left})`;
    case "matches":
      return `__re(${left}, ${right})`;
  }
}

/**
 * 分组 → 判定代码；返回 null = 空组（无有效子项，编译时作中性跳过）：
 *   - 子项编译结果中的 null（空子组）与留白叶子一并跳过；
 *   - 单子项不裹括号；多子项包裹一层括号（保证嵌套时的连接优先级无歧义；
 *     根组不裹——顶层没有可歧义的父连接）；
 *   - not 为真 → 整组取反（`!(...)`）。
 *
 * @param isRoot 是否根组（根层不裹外层括号）
 */
function compileGroup(group: ConditionGroup, isRoot: boolean): string | null {
  const parts: string[] = [];
  for (const child of group.children) {
    if (child.type === "group") {
      const compiled = compileGroup(child, false);
      if (compiled !== null) parts.push(compiled);
      continue;
    }
    if (isBlankLeaf(child)) continue;
    parts.push(compileLeaf(child));
  }
  if (parts.length === 0) return null;
  const inner = parts.join(group.op === "or" ? " || " : " && ");
  if (group.not === true) return `!(${inner})`;
  if (parts.length === 1) return parts[0]!;
  return isRoot ? inner : `(${inner})`;
}

/**
 * 组装辅助函数闭包：needed 为产物代码直接用到的辅助名（按「代码中出现
 * `name(`」判定——本编译器是唯一发射方，只可能误多（文本恰含同名子串）、
 * 不会误少），deps 闭包补齐传递依赖；按 RUNTIME_HELPERS 的定义序发射。
 */
function emitHelpers(needed: ReadonlySet<string>): string {
  const used = new Set<string>();
  const visit = (name: string): void => {
    if (used.has(name)) return;
    used.add(name);
    const helper = RUNTIME_HELPERS.find((candidate) => candidate.name === name);
    if (helper) for (const dep of helper.deps) visit(dep);
  };
  for (const name of needed) visit(name);
  return RUNTIME_HELPERS.filter((helper) => used.has(helper.name))
    .map((helper) => helper.code)
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * 编译主入口
 * ------------------------------------------------------------------ */

/**
 * 条件树 → 等价条件表达式（纯函数，编译器主入口）。
 *
 * 行为约定：
 *   - 留白叶子 / 空组跳过（isBlankLeaf / compileGroup 的 null）；整树无有效
 *     判定 → 空串（引擎语义 = 恒 false，与既有「空表达式」一致）；
 *   - 组装语义见文件头「结构语义」（组内 op 连接、not 取反、嵌套加括号）；
 *   - 产物为「头部注释 + 实际用到的辅助函数 + return 语句」的完整函数体，
 *     可直接写入 config.expression 在既有沙箱语义（"use strict" + new Function，
 *     形参 input / vars）下原样执行；
 *   - 本函数假定入参已过 validateConditionTree（node / env 引用等防御性编译
 *     为 undefined 而不抛错，保证任意输入都有确定产物）。
 *
 * @param tree 条件树根（恒为分组；children 可含嵌套分组）
 */
export function compileConditionTree(tree: ConditionGroup): string {
  const body = compileGroup(tree, true);
  if (body === null) return "";

  const needed = new Set<string>();
  for (const helper of RUNTIME_HELPERS) {
    if (body.includes(`${helper.name}(`)) needed.add(helper.name);
  }
  const helpers = emitHelpers(needed);
  const helperBlock = helpers !== "" ? `${helpers}\n` : "";
  return `${COMPILED_HEADER}\n${helperBlock}return ${body};`;
}

/* ------------------------------------------------------------------ *
 * 保存前校验
 * ------------------------------------------------------------------ */

/**
 * 校验单个值模板的引用可用性（条件沙箱仅 input / var）：
 *   - 存在语法不合法的表达式（parseTemplate 得 ref = null）→ 错误文案；
 *   - 存在 node / env 引用 → 错误文案（形参缺失，无法在条件表达式内取值）；
 *   - 纯文本 / 合法引用 → null。
 *
 * @param raw 模板原文（trim 前后均可——parseTemplate 自行处理）
 * @param position 展示用条件序号（从 1 起，按有效叶子的文档顺序）
 * @param slotName 展示用槽位名（'左值' / '右值'）
 */
function validateValueTemplate(raw: string, position: number, slotName: string): string | null {
  for (const token of parseTemplate(raw.trim())) {
    if (token.kind !== "expression") continue;
    if (token.ref === null) {
      return `第 ${position} 条条件：${slotName}存在无法识别的模板引用（{{ ${token.raw} }}）`;
    }
    if (token.ref.kind === "node" || token.ref.kind === "env") {
      return `第 ${position} 条条件：${slotName}的 {{ ${token.raw} }} 引用在条件表达式中不可用（条件沙箱仅支持 input / var 引用）`;
    }
  }
  return null;
}

/**
 * 条件树的保存前校验（纯函数，抽屉保存链路调用）：
 *   - 留白叶子跳过（与编译口径一致）；空组自然无校验项；
 *   - 一元操作符（isEmpty / isNotEmpty / isTrue / isFalse）左值可留空
 *     （= 判断整个入参根），右值不使用、不校验；
 *   - 二元操作符左值必填；左 / 右值的模板引用须合法且仅 input / var
 *     （node / env 沙箱不可用）；
 *   - 匹配正则：右值为纯文本时预编译（模板右值留待运行期渲染，无法静态
 *     判定，渲染出非法正则按节点 failed——与手写正则抛错语义一致）。
 *
 * @returns 合法返回 null；非法返回可直接展示的错误文案（按文档顺序首条即止，
 *          与抽屉既有单错误位展示模式一致）
 */
export function validateConditionTree(tree: ConditionGroup): string | null {
  let position = 0;

  /** 深度优先遍历叶子（与编译顺序一致：children 数组顺序） */
  const visit = (group: ConditionGroup): string | null => {
    for (const child of group.children) {
      if (child.type === "group") {
        const error = visit(child);
        if (error !== null) return error;
        continue;
      }
      if (isBlankLeaf(child)) continue;
      position += 1;

      const meta = findOperatorMeta(child.operator);
      if (meta === undefined) {
        return `第 ${position} 条条件：操作符非法（${String(child.operator)}）`;
      }

      const left = child.left.trim();
      if (meta.needsRight === false) {
        // 一元操作符：左值可留空（= 入参根），右值不使用、不校验
        if (left !== "") {
          const error = validateValueTemplate(child.left, position, "左值");
          if (error !== null) return error;
        }
        continue;
      }

      if (left === "") return `第 ${position} 条条件：左值不能为空`;
      const leftError = validateValueTemplate(child.left, position, "左值");
      if (leftError !== null) return leftError;

      const rightRaw = typeof child.right === "string" ? child.right : rightTextOf(child);
      const rightError = validateValueTemplate(rightRaw, position, "右值");
      if (rightError !== null) return rightError;

      if (child.operator === "matches" && rightRaw.trim() !== "") {
        const tokens = parseTemplate(rightRaw);
        const hasExpression = tokens.some((token) => token.kind === "expression");
        if (!hasExpression) {
          try {
            new RegExp(rightRaw.trim());
          } catch (error) {
            return `第 ${position} 条条件：正则表达式非法（${error instanceof Error ? error.message : String(error)}）`;
          }
        }
      }
    }
    return null;
  };

  return visit(tree);
}

/* ------------------------------------------------------------------ *
 * 摘要（节点卡 / 抽屉只读回显）
 * ------------------------------------------------------------------ */

/** 叶子摘要：`{{status}} 等于 paid`（左值留空显示「入参」；一元操作符无右值段） */
function describeLeaf(leaf: ConditionLeaf): string {
  const left = leaf.left.trim() === "" ? "入参" : leaf.left.trim();
  const meta = findOperatorMeta(leaf.operator);
  const label = meta?.label ?? String(leaf.operator);
  if (meta?.needsRight === false) return `${left} ${label}`;
  const right = rightTextOf(leaf).trim();
  return right === "" ? `${left} ${label}` : `${left} ${label} ${right}`;
}

/**
 * 条件树 → 人类可读摘要（节点卡摘要行与抽屉只读回显共用；纯函数）。
 * 格式：组内 `且` / `或` 连接、嵌套分组加括号、not 组前缀「非」；
 * 留白叶子 / 空组跳过；整树无有效判定 → 空串（调用方回退「未配置条件」文案）。
 */
export function describeConditionTree(tree: ConditionGroup): string {
  const describeGroup = (group: ConditionGroup, isRoot: boolean): string => {
    const parts: string[] = [];
    for (const child of group.children) {
      if (child.type === "group") {
        const inner = describeGroup(child, false);
        if (inner !== "") parts.push(inner);
        continue;
      }
      if (isBlankLeaf(child)) continue;
      parts.push(describeLeaf(child));
    }
    if (parts.length === 0) return "";
    const inner = parts.join(group.op === "or" ? " 或 " : " 且 ");
    if (group.not === true) return `非（${inner}）`;
    return !isRoot && parts.length > 1 ? `（${inner}）` : inner;
  };
  return describeGroup(tree, true);
}

/* ------------------------------------------------------------------ *
 * 落库形状的容错解析（脏数据不抛错，逐字段回退缺省）
 * ------------------------------------------------------------------ */

/** 叶子容错解析：形状非法 → 缺省叶子（eq + 空左右值 = 留白，编译时跳过） */
function parseConditionLeaf(raw: unknown): ConditionLeaf {
  const record = raw !== null && typeof raw === "object" ? (raw as Partial<ConditionLeaf>) : {};
  const operator =
    findOperatorMeta(record.operator) !== undefined ? (record.operator as ConditionOperator) : "eq";
  const leaf: ConditionLeaf = {
    type: "cond",
    left: typeof record.left === "string" ? record.left : "",
    operator,
  };
  const meta = findOperatorMeta(operator);
  if (meta?.needsRight !== false && record.right !== undefined) {
    const right = record.right;
    if (
      typeof right === "string" ||
      typeof right === "number" ||
      typeof right === "boolean" ||
      right === null
    ) {
      leaf.right = right;
    }
  }
  return leaf;
}

/** 分组容错解析（递归；children 非数组 → 空数组，脏子项按叶子缺省兜底） */
function parseConditionGroup(raw: unknown): ConditionGroup {
  const record = raw !== null && typeof raw === "object" ? (raw as Partial<ConditionGroup>) : {};
  const children = Array.isArray(record.children) ? record.children : [];
  return {
    type: "group",
    op: record.op === "or" ? "or" : "and",
    ...(record.not === true ? { not: true } : {}),
    children: children.map((child) => {
      const kind =
        child !== null && typeof child === "object"
          ? (child as { type?: unknown }).type
          : undefined;
      return kind === "group" ? parseConditionGroup(child) : parseConditionLeaf(child);
    }),
  };
}

/**
 * 容错解析 config.condition（存储脏数据不抛错）：非对象 / 类别非法 → 空根组
 * （'and'、无子项）；子项按 type 判别递归解析，逐字段回退缺省。
 * 返回的树即编辑器草稿 / 编译输入的安全形状。
 *
 * @param raw 存储读出的 condition 原值（unknown，容忍任意脏数据）
 */
export function parseConditionTree(raw: unknown): ConditionGroup {
  return parseConditionGroup(raw);
}

/** 空根组（新节点缺省草稿 / 脏数据兜底） */
export function emptyConditionGroup(): ConditionGroup {
  return { type: "group", op: "and", children: [] };
}

/* ------------------------------------------------------------------ *
 * 旧数据迁移（M13-T3 扁平规则行）
 * ------------------------------------------------------------------ */

/**
 * 容错解析 config.conditionRules（存储脏数据不抛错，逐字段回退缺省）：
 * 非数组 → 空数组；行形状非法 → op 回退 'eq'、join 回退 'and'、
 * left / right 回退空串。返回的行不再携带渲染 id（抽屉回填时自行附加）。
 *
 * @param raw 存储读出的 conditionRules 原值（unknown，容忍任意脏数据）
 */
export function parseConditionRules(raw: unknown): ConditionRuleRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const record =
      item !== null && typeof item === "object" ? (item as Partial<ConditionRuleRow>) : {};
    return {
      join: record.join === "or" ? "or" : "and",
      left: typeof record.left === "string" ? record.left : "",
      op: findOperatorMeta(record.op) !== undefined ? (record.op as ConditionOperator) : "eq",
      ...(typeof record.right === "string" ? { right: record.right } : {}),
    };
  });
}

/**
 * 旧规则行 → 条件树（M16-T2 迁移）：扁平 DNF 逐字等价映射——
 * 按 join 切组（'or' 关闭当前组开启新组，首行 join 忽略），每组为一个
 * op='and' 的分组、行转叶子；多组时根为 op='or' 的分组（旧编译产物即
 * `(组1行 AND) || (组2行 AND)`），单组时根直接承载该组。
 *
 * @param raw 存储读出的 conditionRules 原值（经 parseConditionRules 容错）
 * @returns 无有效行（留白行也算无效）时返回 null（调用方保持「无结构化
 *          条件」判定，走旧表达式分支）
 */
export function migrateConditionRules(raw: unknown): ConditionGroup | null {
  const rows = parseConditionRules(raw).filter(
    (row) => !(row.left.trim() === "" && (row.right ?? "").trim() === "" && row.op === "eq"),
  );
  if (rows.length === 0) return null;

  const toLeaf = (row: ConditionRuleRow): ConditionLeaf => ({
    type: "cond",
    left: row.left,
    operator: row.op,
    ...(operatorNeedsRight(row.op) && row.right !== undefined && row.right !== ""
      ? { right: parseRightValue(row.right) }
      : {}),
  });

  const groups: ConditionGroup[] = [];
  let current: ConditionNode[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (index > 0 && row.join === "or") {
      groups.push({ type: "group", op: "and", children: current });
      current = [];
    }
    current.push(toLeaf(row));
  }
  groups.push({ type: "group", op: "and", children: current });
  if (groups.length === 1) return groups[0]!;
  return { type: "group", op: "or", children: groups };
}
