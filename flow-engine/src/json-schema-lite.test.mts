import { describe, expect, it } from "vitest";
import { validateJsonSchemaLite } from "./json-schema-lite";

/**
 * JSON Schema 子集单测（M10-T3）：type / required / properties / items / enum
 * 五关键字、形状非法的 schema 配置、嵌套递归、未知关键字静默忽略。
 */

describe("validateJsonSchemaLite（type）", () => {
  it("单类型：命中与不命中（错误含期望与实际类型）", () => {
    expect(validateJsonSchemaLite({ type: "object" }, { a: 1 }).ok).toBe(true);
    const failed = validateJsonSchemaLite({ type: "object" }, [1]);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.errors[0]).toContain("期望 object");
  });

  it("类型数组：满足其一即可", () => {
    expect(validateJsonSchemaLite({ type: ["string", "null"] }, null).ok).toBe(true);
    expect(validateJsonSchemaLite({ type: ["string", "null"] }, "x").ok).toBe(true);
    expect(validateJsonSchemaLite({ type: ["string", "null"] }, 1).ok).toBe(false);
  });

  it("integer 便利扩展：整数通过、小数不通过；number 接受两者", () => {
    expect(validateJsonSchemaLite({ type: "integer" }, 3).ok).toBe(true);
    expect(validateJsonSchemaLite({ type: "integer" }, 3.5).ok).toBe(false);
    expect(validateJsonSchemaLite({ type: "number" }, 3.5).ok).toBe(true);
  });

  it("boolean 与 number 不混（JS typeof 边界）", () => {
    expect(validateJsonSchemaLite({ type: "number" }, true).ok).toBe(false);
    expect(validateJsonSchemaLite({ type: "boolean" }, false).ok).toBe(true);
  });

  it("null 类型与 null 值", () => {
    expect(validateJsonSchemaLite({ type: "null" }, null).ok).toBe(true);
    expect(validateJsonSchemaLite({ type: "null" }, undefined === null ? null : 1).ok).toBe(false);
  });
});

describe("validateJsonSchemaLite（required / properties）", () => {
  it("required：缺失必填属性逐条报错；存在则通过", () => {
    const schema = { type: "object", required: ["id", "name"] };
    expect(validateJsonSchemaLite(schema, { id: 1, name: "a" }).ok).toBe(true);
    const failed = validateJsonSchemaLite(schema, { id: 1 });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.errors).toHaveLength(1);
      expect(failed.errors[0]).toContain('"name"');
    }
  });

  it("required 值为显式 null 时视为存在（JSON 语义）", () => {
    const schema = { required: ["token"] };
    expect(validateJsonSchemaLite(schema, { token: null }).ok).toBe(true);
  });

  it("properties：存在属性递归校验；缺失属性不校验（由 required 负责）", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "integer" },
        user: { type: "object", required: ["email"], properties: { email: { type: "string" } } },
      },
    };
    expect(validateJsonSchemaLite(schema, { id: 1 }).ok).toBe(true);
    const failed = validateJsonSchemaLite(schema, { id: "x", user: { email: 1 } });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.errors.some((message) => message.includes("$.id"))).toBe(true);
      expect(failed.errors.some((message) => message.includes("$.user.email"))).toBe(true);
      expect(failed.errors).toHaveLength(2);
    }
  });

  it("非对象目标跳过 required / properties（类型错误由 type 报）", () => {
    const schema = { type: "object", required: ["a"], properties: { a: { type: "string" } } };
    const result = validateJsonSchemaLite(schema, "text");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(1); // 只有 type 一条
  });
});

describe("validateJsonSchemaLite（items / enum）", () => {
  it("items：数组逐元素递归（错误带下标路径）", () => {
    const schema = { items: { type: "integer" } };
    expect(validateJsonSchemaLite(schema, [1, 2, 3]).ok).toBe(true);
    const failed = validateJsonSchemaLite(schema, [1, "x", 3]);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.errors[0]).toContain("$[1]");
  });

  it("items 嵌套对象 schema", () => {
    const schema = { items: { type: "object", required: ["id"] } };
    const failed = validateJsonSchemaLite(schema, [{ id: 1 }, {}]);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.errors[0]).toContain("$[1]");
  });

  it("非数组目标跳过 items", () => {
    expect(validateJsonSchemaLite({ items: { type: "integer" } }, 5).ok).toBe(true);
  });

  it("enum：deep equal 命中其一；对象 / 数组枚举同样适用", () => {
    expect(validateJsonSchemaLite({ enum: ["active", "inactive"] }, "active").ok).toBe(true);
    const failed = validateJsonSchemaLite({ enum: ["active", "inactive"] }, "archived");
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.errors[0]).toContain("枚举");
    expect(validateJsonSchemaLite({ enum: [{ v: 1 }, [1, 2]] }, [1, 2]).ok).toBe(true);
    // 类型敏感：1 与 '1' 不等
    expect(validateJsonSchemaLite({ enum: [1] }, "1").ok).toBe(false);
  });
});

describe("validateJsonSchemaLite（schema 配置非法与边界）", () => {
  it("schema 非对象 → 配置错误", () => {
    const failed = validateJsonSchemaLite("object", 1);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.errors[0]).toContain("schema 配置非法");
  });

  it("type 拼错 / required 非字符串数组 / properties 非对象 / items 非对象 / enum 非数组 → 配置错误", () => {
    expect(validateJsonSchemaLite({ type: "str" }, "x").ok).toBe(false);
    expect(validateJsonSchemaLite({ required: "a" }, {}).ok).toBe(false);
    expect(validateJsonSchemaLite({ properties: [] }, {}).ok).toBe(false);
    expect(validateJsonSchemaLite({ items: 1 }, [1]).ok).toBe(false);
    expect(validateJsonSchemaLite({ enum: "ab" }, "a").ok).toBe(false);
    expect(validateJsonSchemaLite({ type: [] }, 1).ok).toBe(false);
  });

  it("未知关键字静默忽略（向前兼容）", () => {
    expect(validateJsonSchemaLite({ type: "string", minLength: 3, format: "email" }, "ab").ok).toBe(
      true,
    );
  });

  it("一次收集全部错误（type + required + properties 混合）", () => {
    const schema = {
      type: "object",
      required: ["token"],
      properties: { count: { type: "integer" } },
    };
    const failed = validateJsonSchemaLite(schema, { count: "x" });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.errors).toHaveLength(2);
  });
});
