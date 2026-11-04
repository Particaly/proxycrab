import { describe, expect, it } from "vitest";
import {
  compileConditionTree,
  parseConditionTree,
  validateConditionTree,
} from "../../../../flow-engine/src/condition-builder";
import type { ConditionGroup, ConditionLeaf } from "../../../../flow-engine/src/types";
import {
  appendGroup,
  appendLeaf,
  buildConditionShard,
  conditionRightText,
  createConditionGroup,
  createConditionLeaf,
  createConditionTree,
  describeConditionRightType,
  flattenConditionTree,
  getGroupAt,
  isBlankConditionLeaf,
  parseConditionRightText,
  removeChildAt,
  resolveConditionDraft,
  serializeConditionTree,
  updateGroupAt,
  updateLeafAt,
  type ConditionConfigShard,
} from "./condition-tree";

/** 快捷构造叶子（右值可选）。 */
function leaf(
  left: string,
  operator: ConditionLeaf["operator"] = "eq",
  right?: unknown,
): ConditionLeaf {
  return { type: "cond", left, operator, ...(right !== undefined ? { right } : {}) };
}

describe("树 → 表达式（编译出口）", () => {
  it("根组 AND：叶子编译为 input 取数与字符串比较", () => {
    const tree: ConditionGroup = {
      type: "group",
      op: "and",
      children: [leaf("{{ status }}", "eq", "paid"), leaf("{{ var.count }}", "gte", "3")],
    };
    const { expression } = buildConditionShard(tree);
    // 产物 = 头部注释 + 辅助函数 + return 判定（完整函数体，直接落 config.expression）
    expect(expression.startsWith("/* ReqFlow 条件构建器编译产物")).toBe(true);
    expect(expression).toContain('return __eq(__p(input, "status"), "paid")');
    expect(expression).toContain('__p(vars, "count")');
    expect(expression).toContain("&&");
  });

  it("嵌套分组：组内 or 加括号、整组取反 !(...)；留白叶子与空组跳过", () => {
    const tree: ConditionGroup = {
      type: "group",
      op: "and",
      children: [
        leaf("{{ a }}", "eq", "1"),
        {
          type: "group",
          op: "or",
          not: true,
          children: [leaf("{{ b }}", "eq", "2"), leaf("", "eq")],
        },
        { type: "group", op: "and", children: [] },
      ],
    };
    const { expression } = buildConditionShard(tree);
    expect(expression).toContain('return __eq(__p(input, "a"), 1) && !(');
    expect(expression).toContain(" || ");
  });

  it("整树无有效叶子 → 编译为空串（引擎语义 = 恒 false）", () => {
    expect(buildConditionShard(createConditionTree()).expression).toBe("");
  });

  it("右值标量收敛：数字 / 布尔 / null 文本按字面量内插，模板保留渲染口径", () => {
    const tree: ConditionGroup = {
      type: "group",
      op: "and",
      children: [
        leaf("{{ a }}", "eq", "100"),
        leaf("{{ b }}", "isTrue"),
        leaf("{{ c }}", "matches", "^ok$"),
        leaf("{{ d }}", "eq", "{{ var.x }}"),
      ],
    };
    const { expression } = buildConditionShard(tree);
    expect(expression).toContain('__eq(__p(input, "a"), 100)');
    expect(expression).toContain('__truthy(__p(input, "b"))');
    expect(expression).toContain('__re(__p(input, "c"), "^ok$")');
    // 整串恰为一个合法引用的右值 → 原始值取数（无 __s 渲染串包装）
    expect(expression).toContain('__eq(__p(input, "d"), __p(vars, "x"))');
  });
});

describe("落库序列化往返（树 ⇄ config.condition）", () => {
  it("树 → 落库形状 → 引擎容错解析 = 原树（深比较保形）", () => {
    const tree: ConditionGroup = {
      type: "group",
      op: "or",
      not: true,
      children: [
        leaf("{{ status }}", "eq", "200"),
        leaf("{{ flag }}", "isFalse"),
        {
          type: "group",
          op: "and",
          children: [leaf("{{ a }}", "contains", "x"), createConditionLeaf("isEmpty")],
        },
      ],
    };
    const stored = serializeConditionTree(tree);
    expect("type" in stored).toBe(false); // 根组不带 type 判别键（Rust 契约）
    expect(stored.children[1]).toEqual({ type: "cond", left: "{{ flag }}", operator: "isFalse" });
    expect(parseConditionTree(JSON.parse(JSON.stringify(stored)))).toEqual(tree);
  });

  it("not = false 不落键；右值标量原样保留（一元保留草稿值，往返稳定）", () => {
    const tree: ConditionGroup = {
      type: "group",
      op: "and",
      children: [leaf("", "isEmpty"), leaf("{{ a }}", "eq", "true")],
    };
    const stored = serializeConditionTree(tree);
    expect("not" in stored).toBe(false);
    expect(stored.children[0]).toEqual({ type: "cond", left: "", operator: "isEmpty" });
    expect(stored.children[1]).toEqual({
      type: "cond",
      left: "{{ a }}",
      operator: "eq",
      right: "true",
    });
    expect(parseConditionTree(JSON.parse(JSON.stringify(stored)))).toEqual(tree);
  });

  it("脏类型 right（对象）剥离；非标量不落库", () => {
    const tree: ConditionGroup = {
      type: "group",
      op: "and",
      children: [{ type: "cond", left: "{{ a }}", operator: "eq", right: { x: 1 } }],
    };
    expect(serializeConditionTree(tree).children[0]).toEqual({
      type: "cond",
      left: "{{ a }}",
      operator: "eq",
    });
  });

  it("编译产物落库可逆：buildConditionShard 的 condition 经解析后可再次编译出同一表达式", () => {
    const tree: ConditionGroup = {
      type: "group",
      op: "and",
      children: [leaf("{{ status }}", "eq", "paid")],
    };
    const first = buildConditionShard(tree);
    const reparsed = parseConditionTree(JSON.parse(JSON.stringify(first.condition)));
    expect(compileConditionTree(reparsed)).toBe(first.expression);
  });
});

describe("草稿解析（resolveConditionDraft 回填优先级）", () => {
  it("condition 优先；缺树时 conditionRules 旧扁平行迁移为分组树", () => {
    const tree: ConditionGroup = {
      type: "group",
      op: "and",
      children: [leaf("{{ a }}", "eq", "1")],
    };
    expect(
      resolveConditionDraft({
        condition: JSON.parse(JSON.stringify(serializeConditionTree(tree))),
      }),
    ).toEqual(tree);
    const migrated = resolveConditionDraft({
      conditionRules: [
        { join: "and", left: "{{ a }}", op: "eq", right: "1" },
        { join: "or", left: "{{ b }}", op: "isEmpty" },
      ],
    });
    expect(migrated).toEqual({
      type: "group",
      op: "or",
      children: [
        { type: "group", op: "and", children: [leaf("{{ a }}", "eq", 1)] },
        { type: "group", op: "and", children: [leaf("{{ b }}", "isEmpty")] },
      ],
    });
  });

  it("脏数据与全空回填：空根组兜底，不抛错", () => {
    expect(resolveConditionDraft({})).toEqual({ type: "group", op: "and", children: [] });
    expect(resolveConditionDraft({ condition: "garbage" }).children).toEqual([]);
    expect(resolveConditionDraft({ conditionRules: 42 })).toEqual({
      type: "group",
      op: "and",
      children: [],
    });
  });
});

describe("不可变树变换", () => {
  const base: ConditionGroup = {
    type: "group",
    op: "and",
    children: [leaf("{{ a }}", "eq", "1")],
  };

  it("appendLeaf / appendGroup 定位嵌套组，原树不被改动", () => {
    const withGroup = appendGroup(base, []);
    const nestedPath = [1];
    expect(getGroupAt(withGroup, nestedPath)?.children).toEqual([]);
    const withLeaf = appendLeaf(withGroup, nestedPath);
    expect(getGroupAt(withLeaf, nestedPath)?.children).toHaveLength(1);
    // 原树不变
    expect(base.children).toHaveLength(1);
  });

  it("updateLeafAt / updateGroupAt 打补丁；removeChildAt 移除子项", () => {
    const next = updateLeafAt(base, [], 0, { left: "{{ b }}", operator: "ne" });
    expect(next.children[0]).toMatchObject({ left: "{{ b }}", operator: "ne" });
    const opNext = updateGroupAt(next, [], { op: "or", not: true });
    expect(opNext.op).toBe("or");
    expect(opNext.not).toBe(true);
    const removed = removeChildAt(opNext, [], 0);
    expect(removed.children).toEqual([]);
    expect(opNext.children).toHaveLength(1); // 原树不变
  });

  it("越界路径与非法下标原样返回（不抛错）", () => {
    expect(appendLeaf(base, [3, 0])).toBe(base);
    expect(updateLeafAt(base, [], 5, { left: "x" })).toBe(base);
    expect(removeChildAt(base, [], 9)).toBe(base);
    expect(getGroupAt(base, [0])).toBeNull(); // 命中叶子非分组
  });
});

describe("右值文本双向收敛与类型标注", () => {
  it("conditionRightText：标量字符串化，null / undefined / 脏类型 → 空串", () => {
    expect(conditionRightText(leaf("{{ a }}", "eq", "paid"))).toBe("paid");
    expect(conditionRightText(leaf("{{ a }}", "eq", 100))).toBe("100");
    expect(conditionRightText(leaf("{{ a }}", "eq", true))).toBe("true");
    expect(conditionRightText(leaf("{{ a }}", "eq", null))).toBe("");
    expect(conditionRightText(leaf("{{ a }}", "eq"))).toBe("");
  });

  it("parseConditionRightText：数字 / 布尔 / null 收敛为字面量，模板与文本保留", () => {
    expect(parseConditionRightText("100")).toBe(100);
    expect(parseConditionRightText(" -1.5 ")).toBe(-1.5);
    expect(parseConditionRightText("true")).toBe(true);
    expect(parseConditionRightText("false")).toBe(false);
    expect(parseConditionRightText("null")).toBeNull();
    expect(parseConditionRightText("{{ var.x }}")).toBe("{{ var.x }}");
    expect(parseConditionRightText("paid")).toBe("paid");
  });

  it("describeConditionRightType：类型标注文案", () => {
    expect(describeConditionRightType("")).toBeNull();
    expect(describeConditionRightType("   ")).toBeNull();
    expect(describeConditionRightType("200")).toBe("数字");
    expect(describeConditionRightType("true")).toBe("布尔");
    expect(describeConditionRightType("null")).toBe("null");
    expect(describeConditionRightType("{{ var.x }}")).toBe("模板");
    expect(describeConditionRightType("paid")).toBe("文本");
  });
});

describe("扁平行视图（flattenConditionTree）", () => {
  it("组头在前、子项随后深度优先；缩进深度与有效序号（留白不递增）正确", () => {
    const tree: ConditionGroup = {
      type: "group",
      op: "or",
      children: [
        leaf("", "eq"), // 留白：不占序号
        leaf("{{ a }}", "eq", "1"),
        { type: "group", op: "and", children: [leaf("{{ b }}", "isEmpty")] },
      ],
    };
    const rows = flattenConditionTree(tree);
    expect(rows.map((row) => row.kind)).toEqual(["group", "leaf", "leaf", "group", "leaf"]);
    const [root, blank, first, nested, inner] = rows;
    expect(root).toMatchObject({ kind: "group", isRoot: true, depth: 0, op: "or", childCount: 3 });
    expect(blank).toMatchObject({ kind: "leaf", depth: 1, position: 1 });
    expect(first).toMatchObject({ kind: "leaf", depth: 1, position: 1 });
    expect(nested).toMatchObject({ kind: "group", isRoot: false, depth: 1 });
    expect(inner).toMatchObject({ kind: "leaf", depth: 2, position: 2 });
  });
});

describe("保存前校验口径（组件错误位的数据源）", () => {
  it("二元操作符左值必填；node / env 引用阻断；留白叶子放行", () => {
    expect(
      validateConditionTree({ type: "group", op: "and", children: [leaf("", "eq", "x")] }),
    ).toContain("左值不能为空");
    expect(
      validateConditionTree({
        type: "group",
        op: "and",
        children: [leaf("{{ node.n1.a }}", "eq", "1")],
      }),
    ).toContain("不可用");
    expect(
      validateConditionTree({ type: "group", op: "and", children: [leaf("", "eq")] }),
    ).toBeNull();
  });

  it("一元操作符左值留空 = 判断入参根，合法", () => {
    expect(
      validateConditionTree({ type: "group", op: "and", children: [leaf("", "isEmpty")] }),
    ).toBeNull();
  });
});

describe("构造器缺省形状", () => {
  it("createConditionGroup / createConditionTree", () => {
    expect(createConditionTree()).toEqual({ type: "group", op: "and", children: [] });
    expect(createConditionGroup("or")).toEqual({ type: "group", op: "or", children: [] });
    expect(createConditionLeaf("contains")).toEqual({
      type: "cond",
      left: "",
      operator: "contains",
    });
    expect(isBlankConditionLeaf(createConditionLeaf())).toBe(true);
    expect(isBlankConditionLeaf(leaf("{{ a }}"))).toBe(false);
  });

  it("shard 分片类型兼容 config 形状（条件构建器只消费三键）", () => {
    const shard: ConditionConfigShard = buildConditionShard(createConditionTree());
    expect(Object.keys(shard).sort()).toEqual(["condition", "expression"]);
  });
});
