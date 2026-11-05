import { describe, expect, it } from "vitest";
import { parseTemplate, renderFakeOnly, renderTemplate, renderValueDeep } from "./template";

/**
 * 模板 fake 命名空间测试（既有 template.test / template.var / template.env 锁定
 * 的行为不在此重复）：`{{ fake.<名称>(<参数>) }}` 的解析、渲染与告警约定——
 * 假数据不经 RenderContext 取数；同一 RenderContext 实例内同表达式取值一致
 * （WeakMap 缓存），换 ctx 即重随机；未知生成器 / 参数不合法 → 空串 + 专属告警。
 * 另覆盖 renderFakeOnly（独立重放窗口专用：只替换 fake、其余表达式保留字面量）。
 */

describe("parseTemplate / extractReferences：fake 引用语法", () => {
  it("fake.<名称> 解析为 kind=fake 引用（无括号 → args 省略）", () => {
    expect(parseTemplate("{{ fake.phone }}")[0]).toEqual({
      kind: "expression",
      raw: "fake.phone",
      ref: { kind: "fake", name: "phone", path: "" },
    });
  });

  it("括号参数按逗号切分且 trim（fake.number(1,100) → ['1','100']）", () => {
    expect(parseTemplate("{{ fake.number(1,100) }}")[0]?.kind === "expression").toBe(true);
    const token = parseTemplate("{{ fake.number(1,100) }}")[0];
    expect(token && token.kind === "expression" ? token.ref : null).toEqual({
      kind: "fake",
      name: "number",
      args: ["1", "100"],
      path: "",
    });
    const spaced = parseTemplate("{{ fake.hex( 8 , 16 ) }}")[0];
    // 多参数非法由生成器层告警，解析层只负责忠实切分
    expect(spaced && spaced.kind === "expression" ? spaced.ref : null).toMatchObject({
      kind: "fake",
      name: "hex",
      args: ["8", "16"],
    });
  });

  it("裸 {{ fake }} / {{ fake. }} / 形态不符 → 未知引用（ref = null）", () => {
    for (const raw of ["{{ fake }}", "{{ fake. }}", "{{ fake.phone()x }}"]) {
      const token = parseTemplate(raw)[0];
      expect(token && token.kind === "expression" ? token.ref : null).toBeNull();
    }
  });

  it("fake 与 var / env 并存解析互不干扰", () => {
    const refs = parseTemplate("{{ var.token }}{{ env.host }}{{ fake.phone }}").map((token) =>
      token.kind === "expression" ? token.ref : null,
    );
    expect(refs).toEqual([
      { kind: "var", name: "token", path: "" },
      { kind: "env", name: "host", path: "" },
      { kind: "fake", name: "phone", path: "" },
    ]);
  });
});

describe("renderTemplate：fake 引用渲染", () => {
  it("生成值拼进模板（形态校验而非锁定随机值）", () => {
    const result = renderTemplate("phone={{ fake.phone }}", { node: {}, input: null });
    expect(result.value).toMatch(/^phone=\d{11}$/);
    expect(result.warnings).toEqual([]);
  });

  it("带参数表达式：number(1,100) 在闭区间内；hex(8) 定长", () => {
    const ctx = { node: {}, input: null };
    for (let i = 0; i < 20; i++) {
      const value = Number(renderTemplate("{{ fake.number(1,100) }}", ctx).value);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(renderTemplate("{{ fake.hex(8) }}", ctx).value).toMatch(/^[0-9a-f]{8}$/);
  });

  it("未知生成器 → 空串 + 「假数据模板生成失败」告警（含原因）", () => {
    const result = renderTemplate("x={{ fake.nope }}", { node: {}, input: null });
    expect(result.value).toBe("x=");
    expect(result.warnings).toEqual(["假数据模板生成失败：{{ fake.nope }}（未知的生成器：nope）"]);
  });

  it("参数不合法 → 空串 + 告警（原因透出）", () => {
    const result = renderTemplate("{{ fake.number(abc,1) }}", { node: {}, input: null });
    expect(result.value).toBe("");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("假数据模板生成失败：{{ fake.number(abc,1) }}");
    expect(result.warnings[0]).toContain("number");
  });

  it("同一 RenderContext 实例内同表达式取值一致（WeakMap 缓存跨多次渲染）", () => {
    const ctx = { node: {}, input: null };
    const first = renderTemplate("{{ fake.phone }}", ctx).value;
    const second = renderTemplate("{{ fake.phone }}", ctx).value;
    expect(second).toBe(first);
  });

  it("缓存键区分参数（同 ctx 下不同参数表达式互不串值）", () => {
    const ctx = { node: {}, input: null };
    renderTemplate("{{ fake.hex(8) }}", ctx).value;
    const hex16 = renderTemplate("{{ fake.hex(16) }}", ctx).value;
    expect(hex16).toMatch(/^[0-9a-f]{16}$/);
    // 同表达式再次渲染仍命中各自缓存
    expect(renderTemplate("{{ fake.hex(16) }}", ctx).value).toBe(hex16);
  });

  it("不同 RenderContext 实例 → 重新随机（节点执行 / 迭代口径）", () => {
    const values = new Set<string>();
    for (let i = 0; i < 8; i++) {
      values.add(renderTemplate("{{ fake.phone }}", { node: {}, input: null }).value);
    }
    expect(values.size).toBeGreaterThan(1);
  });

  it("renderValueDeep：headers / body 结构中的 fake 表达式一并渲染且同 ctx 一致", () => {
    const ctx = { node: {}, input: null };
    const url = renderTemplate("/api?phone={{ fake.phone }}", ctx).value;
    const rendered = renderValueDeep(
      { headers: { "x-phone": "{{ fake.phone }}" }, body: '{"phone":"{{ fake.phone }}"}' },
      ctx,
    );
    expect(rendered.warnings).toEqual([]);
    expect(rendered.value).toEqual({
      headers: { "x-phone": url.slice("/api?phone=".length) },
      body: `{"phone":"${url.slice("/api?phone=".length)}"}`,
    });
  });
});

describe("renderFakeOnly：独立重放窗口专用渲染", () => {
  it("仅替换 fake 引用，var / env / 未知引用保留字面量", () => {
    const result = renderFakeOnly(
      "u={{ var.token }}&p={{ fake.phone }}&h={{ env.host }}&{{ input.a }}",
    );
    expect(result).toMatch(
      /^u=\{\{ var\.token \}\}&p=\d{11}&h=\{\{ env\.host \}\}&\{\{ input\.a \}\}$/,
    );
  });

  it("fake 生成失败（未知生成器 / 参数不合法）保留表达式原文", () => {
    expect(renderFakeOnly("{{ fake.nope }}")).toBe("{{ fake.nope }}");
    expect(renderFakeOnly("{{ fake.number(x,1) }}")).toBe("{{ fake.number(x,1) }}");
  });

  it("未闭合的 {{ 按字面量原样保留", () => {
    expect(renderFakeOnly("body {{ fake.phone")).toBe("body {{ fake.phone");
  });

  it("传入同一 cache Map → 跨调用（URL / 头 / 体）同表达式取同一值", () => {
    const cache = new Map<string, string>();
    const url = renderFakeOnly("/api?phone={{ fake.phone }}", cache);
    const body = renderFakeOnly('{"phone":"{{ fake.phone }}"}', cache);
    const phone = url.slice("/api?phone=".length);
    expect(body).toBe(`{"phone":"${phone}"}`);
  });

  it("不传 cache → 纯文本原样透传", () => {
    expect(renderFakeOnly("no expression here")).toBe("no expression here");
  });
});
