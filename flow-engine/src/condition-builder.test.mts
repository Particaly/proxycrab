/**
 * 条件可视化构建器编译器测试（M13-T3 引入，M16-T2 树结构重写，node 环境）：
 * 嵌套条件树（分组 且/或/非 + 叶子）→ 等价表达式的编译产物形状、逐操作符语义
 * （经 runConditionExpression 在引擎既有沙箱语义下真实执行编译产物做等价性
 * 断言，而非复刻实现）、分组嵌套与取反、模板取值口径（单一引用 = 原始值 /
 * 混合模板 = 渲染字符串）、数值收敛边界、右值标量收敛、保存前校验、落库形状
 * 容错解析、旧规则行迁移与摘要生成。
 */

import { describe, expect, it } from "vitest";
import {
  compileConditionTree,
  describeConditionTree,
  emptyConditionGroup,
  migrateConditionRules,
  parseConditionRules,
  parseConditionTree,
  parseRightValue,
  validateConditionTree,
} from "./condition-builder";
import { runConditionExpression } from "./logic-nodes";
import type { ConditionGroup, ConditionLeaf, ConditionNode, ConditionRuleRow } from "./types";

/**
 * 在引擎既有语义下执行编译产物（等价性验证工具）：条件表达式经
 * runConditionExpression（"use strict" + new Function、入参净化、truthy 判定）
 * 真实运行——编译产物若引用了未定义辅助 / 语法错误，在此处按节点失败暴露。
 *
 * @returns 表达式返回值的 truthy 判定结果
 */
function evalCompiled(source: string, input: unknown, vars: Record<string, unknown> = {}): boolean {
  const result = runConditionExpression(source, { input, vars });
  if (!result.ok) {
    throw new Error(`编译产物执行失败（应为合法表达式）：${result.error.message}`);
  }
  return Boolean(result.value);
}

/** 叶子便捷构造（right 缺省省略；一元操作符不传） */
function leaf(left: string, operator: ConditionLeaf["operator"], right?: unknown): ConditionLeaf {
  return { type: "cond", left, operator, ...(right !== undefined ? { right } : {}) };
}

/** 分组便捷构造（缺省 and） */
function group(op: ConditionGroup["op"], children: ConditionNode[], not?: boolean): ConditionGroup {
  return { type: "group", op, ...(not === true ? { not: true } : {}), children };
}

/** 单叶子根组（把单条判定包成整树，编译入口恒收根组） */
function single(
  left: string,
  operator: ConditionLeaf["operator"],
  right?: unknown,
): ConditionGroup {
  return group("and", [leaf(left, operator, right)]);
}

/** 旧规则行便捷构造（迁移 fixtures 用；join 缺省 and） */
function row(
  left: string,
  op: ConditionRuleRow["op"],
  right?: string,
  join: ConditionRuleRow["join"] = "and",
): ConditionRuleRow {
  return { join, left, op, ...(right !== undefined ? { right } : {}) };
}

/** 旧规则行 → 树（迁移入口；null 按空组兜底，保持 fixtures 简洁） */
function treeOfRows(rows: ConditionRuleRow[]): ConditionGroup {
  return migrateConditionRules(rows) ?? emptyConditionGroup();
}

describe("编译产物形状（compileConditionTree）", () => {
  it("零有效叶子（空树 / 全留白叶子 / 空组）→ 空串（引擎语义 = 恒 false）", () => {
    expect(compileConditionTree(emptyConditionGroup())).toBe("");
    expect(compileConditionTree(single("", "eq", ""))).toBe("");
    expect(compileConditionTree(group("and", [leaf(" ", "eq", " ")]))).toBe("");
    // 空组作中性跳过：非空组内的空子组不影响其余判定
    expect(
      compileConditionTree(group("and", [group("or", []), leaf("{{ input.a }}", "eq", "1")])),
    ).toContain('return __eq(__p(input, "a"), 1);');
  });

  it("单叶子等值：产物 = 头部标记 + 按需裁剪的辅助 + return 语句，可直接内插执行", () => {
    const source = compileConditionTree(single("{{ input.status }}", "eq", "200"));
    expect(source.startsWith("/* ReqFlow 条件构建器编译产物")).toBe(true);
    expect(source).toContain('return __eq(__p(input, "status"), 200);');
    // 辅助按需裁剪：eq 只需 __p / __nl / __eq，字符串化辅助不应出现
    expect(source).toContain("const __p =");
    expect(source).toContain("const __nl =");
    expect(source).toContain("const __eq =");
    expect(source).not.toContain("const __s =");
    expect(source).not.toContain("const __has =");
  });

  it("编译产物在引擎沙箱语义下原样可执行（多语句函数体 + return）", () => {
    const source = compileConditionTree(single("{{ input.status }}", "eq", "200"));
    expect(evalCompiled(source, { status: 200 })).toBe(true);
    expect(evalCompiled(source, { status: 301 })).toBe(false);
  });

  it("右值数字 / 布尔 / null 标量按字面量内插（编译期文本右值先经 parseRightValue 收敛）", () => {
    expect(compileConditionTree(single("{{ input.amount }}", "gt", 100))).toContain(
      '__gt(__p(input, "amount"), 100)',
    );
    expect(compileConditionTree(single("{{ input.vip }}", "eq", true))).toContain(
      '__eq(__p(input, "vip"), true)',
    );
    expect(compileConditionTree(single("{{ input.note }}", "eq", null))).toContain(
      '__eq(__p(input, "note"), null)',
    );
    // 字符串右值 '100'（草稿文本形态）编译期收敛为数字字面量
    expect(compileConditionTree(single("{{ input.amount }}", "gt", "100"))).toContain(
      '__gt(__p(input, "amount"), 100)',
    );
  });
});

describe("逐操作符语义（经 runConditionExpression 真实执行）", () => {
  it("eq / ne：两侧可数值化按数字比较（status 200 与文本 200 命中），否则原始值严格相等", () => {
    const eq = compileConditionTree(single("{{ input.status }}", "eq", "200"));
    expect(evalCompiled(eq, { status: 200 })).toBe(true); // 数字 vs 文本 → 数值收敛
    expect(evalCompiled(eq, { status: "200" })).toBe(true); // 数字字符串 vs 文本
    expect(evalCompiled(eq, { status: 301 })).toBe(false);
    expect(evalCompiled(eq, { status: "ok" })).toBe(false);

    const ne = compileConditionTree(single("{{ input.code }}", "ne", "ok"));
    expect(evalCompiled(ne, { code: "err" })).toBe(true);
    expect(evalCompiled(ne, { code: "ok" })).toBe(false);
    expect(evalCompiled(ne, { code: 200 })).toBe(true); // 数字 vs 'ok' 非数值化 → 严格不等
  });

  it('eq 旗舰场景：body.code === "0"（字符串与字符串文本）与布尔标量收敛', () => {
    const code = compileConditionTree(single("{{ input.body.code }}", "eq", "0"));
    expect(evalCompiled(code, { body: { code: "0" } })).toBe(true);
    expect(evalCompiled(code, { body: { code: "1" } })).toBe(false);

    // 标量右值收敛（M16-T2 有意决策）：文本 'true' 在保存 / 编译时收敛为布尔
    // 字面量——布尔字段用「等于 true」即可命中（旧版文本右值恒为字符串，
    // 布尔与文本 'true' 不相等，只能靠高级模式手写表达式）
    const flag = compileConditionTree(single("{{ var.flag }}", "eq", "true"));
    expect(evalCompiled(flag, {}, { flag: true })).toBe(true);
    expect(evalCompiled(flag, {}, { flag: "true" })).toBe(false); // 字符串 'true' 与布尔不相等
    // 原始布尔 vs 原始布尔（右值同为引用时）严格相等
    const both = compileConditionTree(single("{{ var.flag }}", "eq", "{{ var.other }}"));
    expect(evalCompiled(both, {}, { flag: true, other: true })).toBe(true);
    expect(evalCompiled(both, {}, { flag: true, other: false })).toBe(false);
  });

  it("eq 数值语义推论：'0' 与 '00' 相等（数值优先）；缺失路径与空串不相等", () => {
    const zeros = compileConditionTree(single("{{ input.code }}", "eq", "00"));
    expect(evalCompiled(zeros, { code: "0" })).toBe(true);

    const missing = compileConditionTree(single("{{ input.nope }}", "eq", ""));
    expect(evalCompiled(missing, {})).toBe(false);
  });

  it("gt / gte / lt / lte：数字比较；任一侧不可数值化（NaN 决策）→ 该行不命中", () => {
    const gt = compileConditionTree(single("{{ input.score }}", "gt", "60"));
    expect(evalCompiled(gt, { score: 61 })).toBe(true);
    expect(evalCompiled(gt, { score: 60 })).toBe(false);
    expect(evalCompiled(gt, { score: "59.5" })).toBe(false);
    expect(evalCompiled(gt, { score: "abc" })).toBe(false); // NaN → 不命中
    expect(evalCompiled(gt, {})).toBe(false); // 缺失 → undefined → 不命中

    const gte = compileConditionTree(single("{{ input.score }}", "gte", "60"));
    expect(evalCompiled(gte, { score: 60 })).toBe(true);
    const lt = compileConditionTree(single("{{ input.score }}", "lt", "60"));
    expect(evalCompiled(lt, { score: 59 })).toBe(true);
    expect(evalCompiled(lt, { score: 60 })).toBe(false);
    const lte = compileConditionTree(single("{{ input.score }}", "lte", "60"));
    expect(evalCompiled(lte, { score: 60 })).toBe(true);
  });

  it("contains：字符串子串；数组按成员命中（原始值或字符串化相等）", () => {
    const text = compileConditionTree(single("{{ input.body.message }}", "contains", "失败"));
    expect(evalCompiled(text, { body: { message: "登录失败：密码错误" } })).toBe(true);
    expect(evalCompiled(text, { body: { message: "登录成功" } })).toBe(false);

    const list = compileConditionTree(single("{{ input.tags }}", "contains", "vip"));
    expect(evalCompiled(list, { tags: ["new", "vip"] })).toBe(true);
    expect(evalCompiled(list, { tags: ["new", "svip"] })).toBe(false); // 成员级而非子串级
    expect(evalCompiled(list, { tags: "svip-user" })).toBe(true); // 非数组退化为子串
  });

  it("notContains / startsWith / endsWith：字符串化后比较", () => {
    const notContains = compileConditionTree(
      single("{{ input.body.message }}", "notContains", "失败"),
    );
    expect(evalCompiled(notContains, { body: { message: "登录成功" } })).toBe(true);
    expect(evalCompiled(notContains, { body: { message: "登录失败" } })).toBe(false);

    const starts = compileConditionTree(single("{{ input.token }}", "startsWith", "Bearer "));
    expect(evalCompiled(starts, { token: "Bearer abc" })).toBe(true);
    expect(evalCompiled(starts, { token: "x-Bearer abc" })).toBe(false);

    const ends = compileConditionTree(single("{{ input.url }}", "endsWith", ".json"));
    expect(evalCompiled(ends, { url: "https://x/api/a.json" })).toBe(true);
    expect(evalCompiled(ends, { url: "https://x/api/a.html" })).toBe(false);
  });

  it("isEmpty / isNotEmpty：空串 / null / 缺失 / 空数组 / 空对象为空；左值留空 = 判断入参根", () => {
    const empty = compileConditionTree(single("{{ input.note }}", "isEmpty"));
    expect(evalCompiled(empty, { note: "" })).toBe(true);
    expect(evalCompiled(empty, { note: null })).toBe(true);
    expect(evalCompiled(empty, {})).toBe(true); // 路径缺失 → undefined
    expect(evalCompiled(empty, { note: [] })).toBe(true); // 空容器算空（文件头决策）
    expect(evalCompiled(empty, { note: {} })).toBe(true);
    expect(evalCompiled(empty, { note: " " })).toBe(false); // 空白字符串不算空
    expect(evalCompiled(empty, { note: [0] })).toBe(false);
    expect(evalCompiled(empty, { note: { a: 1 } })).toBe(false);

    const notEmpty = compileConditionTree(single("{{ input.note }}", "isNotEmpty"));
    expect(evalCompiled(notEmpty, { note: "x" })).toBe(true);
    expect(evalCompiled(notEmpty, { note: "" })).toBe(false);

    // 左值留空 = 判断整个入参根（上游无输出 / 聚合为空的常用检查）
    const rootEmpty = compileConditionTree(
      group("and", [{ type: "cond", left: "", operator: "isEmpty" }]),
    );
    expect(evalCompiled(rootEmpty, null)).toBe(true);
    expect(evalCompiled(rootEmpty, {})).toBe(true);
    expect(evalCompiled(rootEmpty, { a: 1 })).toBe(false);
  });

  it("isTrue / isFalse（M16-T2 新增）：按 JS 真值判定，互为取反；左值留空 = 判断入参根", () => {
    const isTrue = compileConditionTree(single("{{ input.vip }}", "isTrue"));
    expect(evalCompiled(isTrue, { vip: true })).toBe(true);
    expect(evalCompiled(isTrue, { vip: 1 })).toBe(true);
    expect(evalCompiled(isTrue, { vip: "yes" })).toBe(true); // 真值（非空串）即为真
    expect(evalCompiled(isTrue, { vip: false })).toBe(false);
    expect(evalCompiled(isTrue, { vip: 0 })).toBe(false);
    expect(evalCompiled(isTrue, { vip: "" })).toBe(false);
    expect(evalCompiled(isTrue, {})).toBe(false); // 缺失 → undefined 假值

    const isFalse = compileConditionTree(single("{{ input.vip }}", "isFalse"));
    expect(evalCompiled(isFalse, { vip: false })).toBe(true);
    expect(evalCompiled(isFalse, { vip: true })).toBe(false);

    const rootTruthy = compileConditionTree(
      group("and", [{ type: "cond", left: "", operator: "isTrue" }]),
    );
    expect(evalCompiled(rootTruthy, { a: 1 })).toBe(true);
    expect(evalCompiled(rootTruthy, null)).toBe(false);
  });

  it("matches：右值作正则源对左值字符串化结果 test（不带标志位）", () => {
    const re = compileConditionTree(single("{{ input.body.phone }}", "matches", "^1\\d{10}$"));
    expect(evalCompiled(re, { body: { phone: "13800138000" } })).toBe(true);
    expect(evalCompiled(re, { body: { phone: "23800138000" } })).toBe(false);
    expect(evalCompiled(re, { body: { phone: 13800138000 } })).toBe(true); // 数字字符串化后匹配
  });
});

describe("分组语义（且 / 或 / 非 / 任意嵌套）", () => {
  it("组内 AND、组间 OR（等价旧扁平 DNF）：(A && B) || (C && D)", () => {
    const tree = treeOfRows([
      row("{{ input.a }}", "eq", "1"),
      row("{{ input.b }}", "eq", "2", "and"),
      row("{{ input.c }}", "eq", "3", "or"),
      row("{{ input.d }}", "eq", "4", "and"),
    ]);
    const source = compileConditionTree(tree);
    expect(source).toContain(
      'return (__eq(__p(input, "a"), 1) && __eq(__p(input, "b"), 2)) || (__eq(__p(input, "c"), 3) && __eq(__p(input, "d"), 4));',
    );
    expect(evalCompiled(source, { a: 1, b: 2, c: 9, d: 9 })).toBe(true); // 首组命中
    expect(evalCompiled(source, { a: 9, b: 2, c: 3, d: 4 })).toBe(true); // 次组命中
    expect(evalCompiled(source, { a: 1, b: 9, c: 3, d: 9 })).toBe(false); // 两组都缺一角
    expect(evalCompiled(source, { a: 9, b: 9, c: 9, d: 9 })).toBe(false);
  });

  it("嵌套分组：A 且（B 或 C）——外 AND 内 OR 的复合条件", () => {
    const tree = group("and", [
      leaf("{{ input.status }}", "eq", "paid"),
      group("or", [leaf("{{ input.city }}", "eq", "北京"), leaf("{{ input.city }}", "eq", "上海")]),
    ]);
    const source = compileConditionTree(tree);
    expect(source).toContain(
      'return __eq(__p(input, "status"), "paid") && (__eq(__p(input, "city"), "北京") || __eq(__p(input, "city"), "上海"));',
    );
    expect(evalCompiled(source, { status: "paid", city: "北京" })).toBe(true);
    expect(evalCompiled(source, { status: "paid", city: "广州" })).toBe(false);
    expect(evalCompiled(source, { status: "unpaid", city: "北京" })).toBe(false);
  });

  it("分组取反（not）：整组结果取反，可嵌套使用", () => {
    const tree = group("and", [
      group(
        "or",
        [leaf("{{ input.city }}", "eq", "北京"), leaf("{{ input.vip }}", "isTrue")],
        true,
      ),
      leaf("{{ input.status }}", "eq", "paid"),
    ]);
    const source = compileConditionTree(tree);
    expect(evalCompiled(source, { status: "paid", city: "北京", vip: false })).toBe(false);
    expect(evalCompiled(source, { status: "paid", city: "广州", vip: false })).toBe(true);
    expect(evalCompiled(source, { status: "paid", city: "广州", vip: true })).toBe(false);
    expect(evalCompiled(source, { status: "unpaid", city: "广州", vip: false })).toBe(false);
  });

  it("单子项分组不裹多余括号；多子项分组包裹一层（嵌套优先级无歧义）", () => {
    const singleChild = group("and", [group("or", [leaf("{{ input.a }}", "eq", "1")])]);
    expect(compileConditionTree(singleChild)).toContain('return __eq(__p(input, "a"), 1);');
    expect(evalCompiled(compileConditionTree(singleChild), { a: 1 })).toBe(true);
  });

  it("用户样例结构：and 组 [eq, gt, or 组 [eq, isTrue]] 逐条求值正确", () => {
    const tree: ConditionGroup = {
      type: "group",
      op: "and",
      not: false,
      children: [
        { type: "cond", left: "{{status}}", operator: "eq", right: "paid" },
        { type: "cond", left: "{{amount}}", operator: "gt", right: 100 },
        {
          type: "group",
          op: "or",
          not: false,
          children: [
            { type: "cond", left: "{{city}}", operator: "eq", right: "北京" },
            { type: "cond", left: "{{vip}}", operator: "isTrue" },
          ],
        },
      ],
    };
    const source = compileConditionTree(tree);
    expect(evalCompiled(source, { status: "paid", amount: 200, city: "北京", vip: false })).toBe(
      true,
    );
    expect(evalCompiled(source, { status: "paid", amount: 200, city: "广州", vip: true })).toBe(
      true,
    );
    expect(evalCompiled(source, { status: "paid", amount: 200, city: "广州", vip: false })).toBe(
      false,
    );
    expect(evalCompiled(source, { status: "paid", amount: 50, city: "北京" })).toBe(false);
    expect(evalCompiled(source, { status: "unpaid", amount: 200, city: "北京" })).toBe(false);
  });
});

describe("模板取值口径（与引擎 condition「求值内取值」一致）", () => {
  it("整串单一引用取原始值：input 路径 / 裸路径 / $json 别名 / var 变量与子路径", () => {
    const bare = compileConditionTree(single("{{ status }}", "eq", "200"));
    expect(evalCompiled(bare, { status: 200 })).toBe(true);

    const alias = compileConditionTree(single("{{ $json.status }}", "eq", "200"));
    expect(evalCompiled(alias, { status: 200 })).toBe(true);

    const varRef = compileConditionTree(single("{{ var.session.user.id }}", "eq", "u1"));
    expect(evalCompiled(varRef, {}, { session: { user: { id: "u1" } } })).toBe(true);
    expect(evalCompiled(varRef, {}, { session: { user: { id: "u2" } } })).toBe(false);
  });

  it("混合模板 / 纯文本按渲染字符串拼接（renderTemplate 字符串化口径）", () => {
    const mixed = compileConditionTree(single("Bearer {{ var.token }}", "eq", "Bearer abc"));
    expect(evalCompiled(mixed, {}, { token: "abc" })).toBe(true);
    expect(evalCompiled(mixed, {}, { token: "other" })).toBe(false);
    // 变量缺失 → 渲染为空串（与 renderTemplate「缺数据不失败」口径一致）
    expect(evalCompiled(mixed, {}, {})).toBe(false);

    // 引用值为对象 → JSON 文本（stringifyValue 口径）
    const obj = compileConditionTree(single("{{ input.cfg }}", "contains", '"mode":"fast"'));
    expect(evalCompiled(obj, { cfg: { mode: "fast" } })).toBe(true);

    // 纯文本左值（无引用）→ 字符串字面量
    const literal = compileConditionTree(single("hello", "eq", "hello"));
    expect(evalCompiled(literal, null)).toBe(true);
  });

  it("右值同为模板引用：取原始值参与比较（字段对字段）", () => {
    const source = compileConditionTree(single("{{ input.got }}", "eq", "{{ var.expect }}"));
    expect(evalCompiled(source, { got: 42 }, { expect: 42 })).toBe(true);
    expect(evalCompiled(source, { got: 42 }, { expect: 43 })).toBe(false);
  });

  it("首尾空白忽略：trim 后整串仍是单一引用则取原始值", () => {
    const padded = compileConditionTree(single("  {{ input.status }}  ", "eq", " 200 "));
    expect(evalCompiled(padded, { status: 200 })).toBe(true);
  });
});

describe("保存前校验（validateConditionTree）", () => {
  it("左值必填（一元操作符除外）；留白叶子跳过不报错", () => {
    expect(validateConditionTree(single("", "gt", "1"))).toMatchInlineSnapshot(
      `"第 1 条条件：左值不能为空"`,
    );
    // 一元操作符允许左值留空（= 判断入参根）
    expect(validateConditionTree(single("", "isEmpty"))).toBeNull();
    expect(validateConditionTree(single("", "isNotEmpty"))).toBeNull();
    expect(validateConditionTree(single("", "isTrue"))).toBeNull();
    expect(validateConditionTree(single("", "isFalse"))).toBeNull();
    // 留白叶子（左右皆空且操作符仍为缺省 eq）跳过
    expect(
      validateConditionTree(group("and", [leaf("", "eq", ""), leaf(" ", "eq", " ")])),
    ).toBeNull();
  });

  it("node / env / fake 引用阻断（条件沙箱仅 input / var）；未知引用阻断", () => {
    expect(
      validateConditionTree(single("{{ node.n1.output.token }}", "eq", "a")),
    ).toMatchInlineSnapshot(
      `"第 1 条条件：左值的 {{ node.n1.output.token }} 引用在条件表达式中不可用（条件沙箱仅支持 input / var 引用）"`,
    );
    expect(
      validateConditionTree(single("{{ input.token }}", "eq", "{{ env.KEY }}")),
    ).toMatchInlineSnapshot(
      `"第 1 条条件：右值的 {{ env.KEY }} 引用在条件表达式中不可用（条件沙箱仅支持 input / var 引用）"`,
    );
    expect(validateConditionTree(single("{{ fake.phone }}", "eq", "a"))).toMatchInlineSnapshot(
      `"第 1 条条件：左值的 {{ fake.phone }} 引用在条件表达式中不可用（条件沙箱仅支持 input / var 引用）"`,
    );
    expect(validateConditionTree(single("{{ }}", "eq", "a"))).toBe(
      "第 1 条条件：左值存在无法识别的模板引用（{{  }}）",
    );
  });

  it("匹配正则：纯文本右值预编译（非法阻断），模板右值留待运行期", () => {
    expect(validateConditionTree(single("{{ input.phone }}", "matches", "^1\\d{10}$"))).toBeNull();
    // V8 的正则错误文案随运行时措辞可能微调，锁定前缀与规则定位即可
    expect(validateConditionTree(single("{{ input.phone }}", "matches", "^1(\\d{10}$"))).toMatch(
      /^第 1 条条件：正则表达式非法（Invalid regular expression:/,
    );
    expect(
      validateConditionTree(single("{{ input.phone }}", "matches", "{{ var.pattern }}")),
    ).toBeNull();
  });

  it("条件序号按有效叶子的文档顺序（含嵌套分组，留白叶子不计位）", () => {
    const tree = group("or", [
      group("and", [leaf("{{ input.a }}", "contains", "x"), leaf("", "eq", "")]),
      group("and", [leaf("", "gt", "1")]),
    ]);
    // 第 1 条 = a contains x（有效）；第 2 条 = 空左值 gt（第二组内）
    expect(validateConditionTree(tree)).toBe("第 2 条条件：左值不能为空");
    expect(
      validateConditionTree(group("and", [leaf("", "eq", ""), leaf("", "contains", "x")])),
    ).toBe("第 1 条条件：左值不能为空");
  });

  it("合法条件树整体通过", () => {
    const tree = group("and", [
      leaf("{{ input.a }}", "contains", "x"),
      group("or", [leaf("{{ input.b }}", "isEmpty"), leaf("{{ var.flag }}", "isTrue")]),
    ]);
    expect(validateConditionTree(tree)).toBeNull();
  });
});

describe("落库形状容错解析（parseConditionTree）", () => {
  it("非对象 / 类别非法 → 空根组；子项逐字段回退缺省", () => {
    expect(parseConditionTree(undefined)).toEqual({ type: "group", op: "and", children: [] });
    expect(parseConditionTree("nope")).toEqual({ type: "group", op: "and", children: [] });
    expect(parseConditionTree({ type: "group", op: "xor", children: "nope" })).toEqual({
      type: "group",
      op: "and",
      children: [],
    });
  });

  it("递归解析叶子与嵌套分组：脏字段回退（op 非 or 归一 and、operator 非法归一 eq、right 非标量丢弃）", () => {
    const parsed = parseConditionTree({
      type: "group",
      op: "or",
      not: true,
      children: [
        { type: "cond", left: "{{ input.a }}", operator: "gt", right: "1" },
        { type: "cond", left: 42, operator: "nope", right: { bad: true } },
        {
          type: "group",
          op: "and",
          children: [{ type: "cond", left: "x", operator: "eq", right: null }],
        },
      ],
    });
    expect(parsed).toEqual({
      type: "group",
      op: "or",
      not: true,
      children: [
        { type: "cond", left: "{{ input.a }}", operator: "gt", right: "1" },
        { type: "cond", left: "", operator: "eq" },
        {
          type: "group",
          op: "and",
          children: [{ type: "cond", left: "x", operator: "eq", right: null }],
        },
      ],
    });
  });

  it("一元操作符不保留右值；解析结果可直接编译执行", () => {
    const parsed = parseConditionTree({
      type: "group",
      op: "and",
      children: [{ type: "cond", left: "{{ input.vip }}", operator: "isTrue", right: "ignored" }],
    });
    expect(parsed.children[0]).toEqual({
      type: "cond",
      left: "{{ input.vip }}",
      operator: "isTrue",
    });
    const rows = parseConditionRules([
      { join: "and", left: "{{ input.status }}", op: "eq", right: "200" },
    ]);
    expect(evalCompiled(compileConditionTree(treeOfRows(rows)), { status: 200 })).toBe(true);
  });
});

describe("右值标量收敛（parseRightValue）", () => {
  it("数字 / 布尔 / null 字面量 → 标量；含 {{ }} 或其余文本 → 字符串", () => {
    expect(parseRightValue("100")).toBe(100);
    expect(parseRightValue(" -2.5 ")).toBe(-2.5);
    expect(parseRightValue("1e3")).toBe(1000);
    expect(parseRightValue("true")).toBe(true);
    expect(parseRightValue("false")).toBe(false);
    expect(parseRightValue("null")).toBe(null);
    expect(parseRightValue("paid")).toBe("paid");
    expect(parseRightValue(" 北京 ")).toBe("北京");
    expect(parseRightValue("{{ var.expect }}")).toBe("{{ var.expect }}");
    expect(parseRightValue("{{input.a}}")).toBe("{{input.a}}");
    expect(parseRightValue("001")).toBe("001"); // 非规范 JSON 数字（前导零）按文本
    expect(parseRightValue("")).toBe("");
  });

  it("往返稳定：parseRightValue 产物再经编译不改变判定", () => {
    const source = compileConditionTree(single("{{ input.amount }}", "gt", parseRightValue("100")));
    expect(evalCompiled(source, { amount: 101 })).toBe(true);
    expect(evalCompiled(source, { amount: 99 })).toBe(false);
  });
});

describe("旧规则行迁移（migrateConditionRules）", () => {
  it("无有效行（非数组 / 全留白）→ null", () => {
    expect(migrateConditionRules(undefined)).toBeNull();
    expect(migrateConditionRules([])).toBeNull();
    expect(migrateConditionRules([row("", "eq", ""), row(" ", "eq")])).toBeNull();
  });

  it("单组 → 根即该 AND 组；多组 → 根为 OR 组套 AND 组（与旧 DNF 逐字等价）", () => {
    expect(migrateConditionRules([row("{{ input.a }}", "eq", "1")])).toEqual({
      type: "group",
      op: "and",
      children: [{ type: "cond", left: "{{ input.a }}", operator: "eq", right: 1 }],
    });
    const multi = migrateConditionRules([
      row("{{ input.a }}", "eq", "1"),
      row("{{ input.b }}", "gt", "2"),
      row("{{ input.c }}", "eq", "x", "or"),
    ]);
    expect(multi).toEqual({
      type: "group",
      op: "or",
      children: [
        {
          type: "group",
          op: "and",
          children: [
            { type: "cond", left: "{{ input.a }}", operator: "eq", right: 1 },
            { type: "cond", left: "{{ input.b }}", operator: "gt", right: 2 },
          ],
        },
        {
          type: "group",
          op: "and",
          children: [{ type: "cond", left: "{{ input.c }}", operator: "eq", right: "x" }],
        },
      ],
    });
  });

  it("迁移树的编译产物与旧口径判定一致（含留白行跳过、一元操作符无右值）", () => {
    const tree = treeOfRows([
      row("{{ input.note }}", "isEmpty"),
      row("{{ input.a }}", "eq", "1", "or"),
    ]);
    const source = compileConditionTree(tree);
    expect(evalCompiled(source, { note: "" })).toBe(true);
    expect(evalCompiled(source, { note: "x", a: 1 })).toBe(true);
    expect(evalCompiled(source, { note: "x", a: 2 })).toBe(false);
  });
});

describe("摘要（describeConditionTree）", () => {
  it("叶子 / 嵌套分组 / 取反 / 留白与空组跳过", () => {
    expect(describeConditionTree(emptyConditionGroup())).toBe("");
    expect(describeConditionTree(single("{{ status }}", "eq", "paid"))).toBe(
      "{{ status }} 等于 paid",
    );
    expect(describeConditionTree(single("{{ note }}", "isEmpty"))).toBe("{{ note }} 为空");
    expect(
      describeConditionTree(group("and", [{ type: "cond", left: "", operator: "isTrue" }])),
    ).toBe("入参 为真");

    const nested = group("and", [
      leaf("{{ status }}", "eq", "paid"),
      group("or", [leaf("{{ city }}", "eq", "北京"), leaf("{{ vip }}", "isTrue")]),
    ]);
    expect(describeConditionTree(nested)).toBe(
      "{{ status }} 等于 paid 且 （{{ city }} 等于 北京 或 {{ vip }} 为真）",
    );

    const negated = group("and", [group("or", [leaf("{{ a }}", "eq", "1")], true)]);
    expect(describeConditionTree(negated)).toBe("非（{{ a }} 等于 1）");
  });

  it("留白叶子不参与摘要；纯留白树 → 空串", () => {
    const tree = group("or", [leaf("", "eq", ""), leaf("{{ a }}", "eq", "1"), group("and", [])]);
    expect(describeConditionTree(tree)).toBe("{{ a }} 等于 1");
  });
});

describe("与手写表达式的等价性（旗舰场景）", () => {
  /** 手写表达式在引擎语义下的 truthy 判定（失败视为 false，与节点失败放行语义对齐） */
  function evalHandwritten(
    source: string,
    input: unknown,
    vars: Record<string, unknown> = {},
  ): boolean {
    const result = runConditionExpression(source, { input, vars });
    return result.ok ? Boolean(result.value) : false;
  }

  it("「status 等于 200」在原始数字输入下与手写 input.status === 200 判定一致", () => {
    const compiled = compileConditionTree(single("{{ input.status }}", "eq", "200"));
    const handwritten = "return input.status === 200;";
    for (const input of [{ status: 200 }, { status: 301 }, { status: null }, {}]) {
      expect(evalCompiled(compiled, input)).toBe(evalHandwritten(handwritten, input));
    }
  });

  it('「body.code 等于 0」与手写 input.body.code === "0" 在字符串值下判定一致', () => {
    const compiled = compileConditionTree(single("{{ input.body.code }}", "eq", "0"));
    const handwritten = 'return input.body.code === "0";';
    for (const input of [{ body: { code: "0" } }, { body: { code: "1" } }, { body: {} }, {}]) {
      expect(evalCompiled(compiled, input)).toBe(evalHandwritten(handwritten, input));
    }
  });
});
