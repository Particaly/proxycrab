import { describe, expect, it } from "vitest";
import {
  extractReferences,
  parseTemplate,
  renderTemplate,
  renderValueDeep,
  type RenderContext,
} from "./template";

/**
 * M7-T2 模板引擎变量引用测试（纯增量：既有 template.test.ts 锁定的 node /
 * input 行为不在此重复，本文件只覆盖新增的 var 根）：
 *   - parseTemplate：`{{ var.name }}` / `{{ var.name.path }}` 解析，裸 `{{ var }}`
 *     与 `{{ var..path }}` 视为未知引用；
 *   - renderTemplate：变量存在 / 路径缺失 / 值为 null / 变量不存在 / ctx.var
 *     缺省五种分支（空串 + 警告策略与 node / input 一致）；
 *   - renderValueDeep：深层结构内的 var 渲染与警告聚合；
 *   - extractReferences：var 引用提取。
 */

/** 带变量表的渲染上下文：token / env（对象）/ flag / nil（null）四个变量 */
const CTX: RenderContext = {
  node: {},
  input: null,
  var: {
    token: "abc123",
    env: { region: "cn-north", nested: { list: [1, { k: "v" }] } },
    flag: false,
    nil: null,
  },
};

describe("parseTemplate：var 引用解析（M7-T2）", () => {
  it("var.name → { kind: var, name, path: 空串 }", () => {
    expect(parseTemplate("{{ var.token }}")[0]).toEqual({
      kind: "expression",
      raw: "var.token",
      ref: { kind: "var", name: "token", path: "" },
    });
  });

  it("var.name.path → 变量名之后的点分路径", () => {
    expect(parseTemplate("{{ var.env.nested.list.0 }}")[0]).toEqual({
      kind: "expression",
      raw: "var.env.nested.list.0",
      ref: { kind: "var", name: "env", path: "nested.list.0" },
    });
  });

  it("裸 {{ var }} / {{ var. }} / {{ var..path }} → ref 为 null（未知引用）", () => {
    for (const raw of ["{{ var }}", "{{ var. }}", "{{ var..path }}"]) {
      const token = parseTemplate(raw)[0];
      expect(token, raw).toMatchObject({ kind: "expression", ref: null });
    }
  });
});

describe("renderTemplate：var 引用求值（M7-T2）", () => {
  it("变量存在：字符串 / falsy 值照常字符串化", () => {
    expect(renderTemplate("{{ var.token }}", CTX)).toEqual({ value: "abc123", warnings: [] });
    expect(renderTemplate("{{ var.flag }}", CTX)).toEqual({ value: "false", warnings: [] });
  });

  it("变量根值本身为对象 / 数组 → JSON 序列化", () => {
    expect(renderTemplate("{{ var.env }}", CTX).value).toBe(
      '{"region":"cn-north","nested":{"list":[1,{"k":"v"}]}}',
    );
  });

  it("变量内路径求值（对象键 / 数组下标混排）", () => {
    expect(renderTemplate("{{ var.env.region }}", CTX)).toEqual({
      value: "cn-north",
      warnings: [],
    });
    expect(renderTemplate("{{ var.env.nested.list.1.k }}", CTX)).toEqual({
      value: "v",
      warnings: [],
    });
  });

  it("与静态文本 / node、input 引用混排", () => {
    const ctx: RenderContext = {
      node: { n1: { output: { token: "N1" } } },
      input: { userId: 7 },
      var: { token: "V1" },
    };
    const raw = "Bearer {{ var.token }} 用户 {{ input.userId }} 上游 {{ node.n1.output.token }}";
    expect(renderTemplate(raw, ctx).value).toBe("Bearer V1 用户 7 上游 N1");
  });

  it("变量内路径缺失 → 空串 + 「路径不存在」警告", () => {
    const rendered = renderTemplate("{{ var.env.missing.deep }}", CTX);
    expect(rendered.value).toBe("");
    expect(rendered.warnings).toHaveLength(1);
    expect(rendered.warnings[0]).toContain("模板引用路径不存在");
    expect(rendered.warnings[0]).toContain("var.env.missing.deep");
  });

  it("变量值为 null → 空串 + 「值为空」警告", () => {
    const rendered = renderTemplate("{{ var.nil }}", CTX);
    expect(rendered.value).toBe("");
    expect(rendered.warnings[0]).toContain("null/undefined");
  });

  it("变量不存在 → 空串 + 「变量不存在」警告", () => {
    const rendered = renderTemplate("{{ var.nope }}", CTX);
    expect(rendered.value).toBe("");
    expect(rendered.warnings[0]).toContain("模板引用的变量不存在");
    expect(rendered.warnings[0]).toContain("var.nope");
  });

  it("ctx.var 缺省 / 非对象 → var 引用按「变量不存在」处理，不抛错", () => {
    const withoutVar: RenderContext = { node: {}, input: null };
    expect(renderTemplate("{{ var.token }}", withoutVar)).toEqual({
      value: "",
      warnings: [expect.stringContaining("模板引用的变量不存在")],
    });
    const brokenVar = { node: {}, input: null, var: null as unknown as Record<string, unknown> };
    expect(renderTemplate("{{ var.token }}", brokenVar).warnings[0]).toContain(
      "模板引用的变量不存在",
    );
  });

  it("同值变量名与路径段同名不串位（hasOwnProperty 精确匹配）", () => {
    const ctx: RenderContext = { node: {}, input: null, var: { map: { id: 1 } } };
    expect(renderTemplate("{{ var.map.id }}", ctx)).toEqual({ value: "1", warnings: [] });
    expect(renderTemplate("{{ var.map.nope }}", ctx).warnings[0]).toContain("模板引用路径不存在");
  });
});

describe("renderValueDeep：var 渲染（M7-T2）", () => {
  it("headers / body 深层结构中的 var 引用照常渲染", () => {
    const rendered = renderValueDeep(
      { Authorization: "Bearer {{ var.token }}", items: ["{{ var.env.region }}", "static"] },
      CTX,
    );
    expect(rendered.value).toEqual({
      Authorization: "Bearer abc123",
      items: ["cn-north", "static"],
    });
    expect(rendered.warnings).toEqual([]);
  });

  it("深层结构的 var 警告聚合并保序", () => {
    const rendered = renderValueDeep({ a: "{{ var.nope }}", b: ["{{ var.env.nope }}"] }, CTX);
    expect(rendered.warnings).toHaveLength(2);
    expect(rendered.warnings[0]).toContain("var.nope");
    expect(rendered.warnings[1]).toContain("var.env.nope");
  });
});

describe("extractReferences：var 引用提取（M7-T2）", () => {
  it("var 引用与其他根混排提取（保序）", () => {
    expect(
      extractReferences("{{ var.token }} + {{ node.n1.t }} + {{ input.a }} + {{ var.env.region }}"),
    ).toEqual([
      { kind: "var", name: "token", path: "" },
      { kind: "node", nodeId: "n1", path: "t" },
      { kind: "input", path: "a" },
      { kind: "var", name: "env", path: "region" },
    ]);
  });

  it("裸 var 引用（未知引用）不收录", () => {
    expect(extractReferences("{{ var }}")).toEqual([]);
  });
});
