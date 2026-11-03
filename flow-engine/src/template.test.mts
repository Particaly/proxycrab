import { describe, expect, it } from "vitest";
import {
  UNCLOSED_BRACE_WARNING,
  extractReferences,
  parseTemplate,
  renderTemplate,
  renderValueDeep,
  resolvePath,
  type RenderContext,
} from "./template";

/**
 * M4-T4 参数模板引擎测试：
 * parseTemplate 切分（嵌套 / 未闭合 / 特殊字符 / 中文 / 空串）、resolvePath
 * 路径求值（数组 / 原型链 / 深层缺失）、renderTemplate（多表达式混排、缺数据
 * 不抛错、整串即表达式时的字符串语义保持）、renderValueDeep 深层结构、
 * extractReferences 引用提取。
 */

/** 空上下文（node / input 均无数据），用于验证渲染对缺数据的容错 */
const EMPTY_CTX: RenderContext = { node: {}, input: undefined };

describe("parseTemplate", () => {
  it("纯文本无表达式 → 单个 text token", () => {
    expect(parseTemplate("https://api.example.com/list")).toEqual([
      { kind: "text", value: "https://api.example.com/list" },
    ]);
  });

  it("空串 → 空 token 序列", () => {
    expect(parseTemplate("")).toEqual([]);
  });

  it("整串即表达式 → 单个 expression token，内容已 trim 并解析出引用", () => {
    expect(parseTemplate("{{ node.n2.output.token }}")).toEqual([
      {
        kind: "expression",
        raw: "node.n2.output.token",
        ref: { kind: "node", nodeId: "n2", path: "output.token" },
      },
    ]);
  });

  it("文本与表达式混排 → 按出现顺序切分", () => {
    expect(parseTemplate("Bearer {{ node.n1.output.t }}!")).toEqual([
      { kind: "text", value: "Bearer " },
      {
        kind: "expression",
        raw: "node.n1.output.t",
        ref: { kind: "node", nodeId: "n1", path: "output.t" },
      },
      { kind: "text", value: "!" },
    ]);
  });

  it("多表达式相邻排布各自成 token", () => {
    const tokens = parseTemplate("{{input.a}}{{ input.b }}");
    expect(tokens).toHaveLength(2);
    expect(tokens.every((token) => token.kind === "expression")).toBe(true);
  });

  it("input 引用（无 nodeId）与 node 引用（path 可空）解析", () => {
    expect(parseTemplate("{{ input }}")[0]).toEqual({
      kind: "expression",
      raw: "input",
      ref: { kind: "input", path: "" },
    });
    expect(parseTemplate("{{ node.n2 }}")[0]).toMatchObject({
      ref: { kind: "node", nodeId: "n2", path: "" },
    });
  });

  it("不符合引用语法的内容 → ref 为 null（未知引用）", () => {
    for (const raw of [
      "{{ foo bar }}",
      "{{ (a) }}",
      "{{}}",
      "{{   }}",
      "{{ node }}",
      "{{ node..path }}",
      "{{ node. }}",
    ]) {
      const token = parseTemplate(raw)[0];
      expect(token, raw).toMatchObject({ kind: "expression", ref: null });
    }
  });

  it("裸路径是入参简写 → 解析为 kind input（与 input.<path> 等价）", () => {
    expect(parseTemplate("{{ headers.x-token }}")[0]).toEqual({
      kind: "expression",
      raw: "headers.x-token",
      ref: { kind: "input", path: "headers.x-token" },
    });
    expect(parseTemplate("{{ body.user.id }}")[0]).toMatchObject({
      ref: { kind: "input", path: "body.user.id" },
    });
    // 保留根优先：这些前缀不会被当成裸路径
    expect(parseTemplate("{{ var.token }}")[0]).toMatchObject({
      ref: { kind: "var", name: "token", path: "" },
    });
  });

  it("未闭合的 {{ 按字面量处理并携带解析警告", () => {
    const tokens = parseTemplate("a{{b");
    expect(tokens).toEqual([{ kind: "text", value: "a{{b", warning: UNCLOSED_BRACE_WARNING }]);
  });

  it("未闭合紧随表达式之后 → 字面量文本与已有文本合并为一枚 token", () => {
    const tokens = parseTemplate("{{input.a}} tail {{");
    expect(tokens).toEqual([
      { kind: "expression", raw: "input.a", ref: { kind: "input", path: "a" } },
      { kind: "text", value: " tail {{", warning: UNCLOSED_BRACE_WARNING },
    ]);
  });

  it("独立的 }} / 单个 { 只是普通文本，不产生警告", () => {
    expect(parseTemplate("a}}b{c")).toEqual([{ kind: "text", value: "a}}b{c" }]);
  });

  it("中文文本与中文路径段原样保留", () => {
    const tokens = parseTemplate("令牌：{{ node.节点A.output.令牌 }}");
    expect(tokens).toEqual([
      { kind: "text", value: "令牌：" },
      {
        kind: "expression",
        raw: "node.节点A.output.令牌",
        ref: { kind: "node", nodeId: "节点A", path: "output.令牌" },
      },
    ]);
  });

  it("表达式内容只截到最近的 }}，其后文本继续扫描", () => {
    const tokens = parseTemplate("{{ input.a }} }} {{ input.b }}");
    expect(tokens).toEqual([
      { kind: "expression", raw: "input.a", ref: { kind: "input", path: "a" } },
      { kind: "text", value: " }} " },
      { kind: "expression", raw: "input.b", ref: { kind: "input", path: "b" } },
    ]);
  });
});

describe("resolvePath", () => {
  const root = {
    user: { id: 7, name: "张三", tags: ["a", "b"] },
    list: [{ c: 3 }, { c: 4 }],
    zero: 0,
    empty: "",
    off: false,
    nil: null,
  };

  it("对象键嵌套求值", () => {
    expect(resolvePath(root, "user.id")).toEqual({ found: true, value: 7 });
    expect(resolvePath(root, "user.name")).toEqual({ found: true, value: "张三" });
  });

  it("数组下标与「数组内对象」混合路径", () => {
    expect(resolvePath(root, "user.tags.0")).toEqual({ found: true, value: "a" });
    expect(resolvePath(root, "list.1.c")).toEqual({ found: true, value: 4 });
  });

  it("数组根直接按下标求值", () => {
    expect(resolvePath([10, 20], "1")).toEqual({ found: true, value: 20 });
  });

  it("空路径 → 根值本身", () => {
    expect(resolvePath(root, "")).toEqual({ found: true, value: root });
    expect(resolvePath(undefined, "")).toEqual({ found: true, value: undefined });
  });

  it("falsy 但存在的值 → found:true 原样带出（是否告警由渲染层决定）", () => {
    expect(resolvePath(root, "zero")).toEqual({ found: true, value: 0 });
    expect(resolvePath(root, "empty")).toEqual({ found: true, value: "" });
    expect(resolvePath(root, "off")).toEqual({ found: true, value: false });
    expect(resolvePath(root, "nil")).toEqual({ found: true, value: null });
  });

  it("深层缺失 / 中途为原始值 → found:false", () => {
    expect(resolvePath(root, "user.depth.x")).toEqual({ found: false, value: undefined });
    expect(resolvePath(root, "zero.b")).toEqual({ found: false, value: undefined });
    expect(resolvePath(null, "a")).toEqual({ found: false, value: undefined });
  });

  it("数组段非法 / 越界 → found:false", () => {
    expect(resolvePath(root, "user.tags.01")).toEqual({ found: false, value: undefined });
    expect(resolvePath(root, "user.tags.-1")).toEqual({ found: false, value: undefined });
    expect(resolvePath(root, "user.tags.2")).toEqual({ found: false, value: undefined });
    expect(resolvePath(root, "user.tags.x")).toEqual({ found: false, value: undefined });
  });

  it("原型链键不可引用（hasOwnProperty 精确匹配）", () => {
    expect(resolvePath({}, "constructor")).toEqual({ found: false, value: undefined });
    expect(resolvePath({}, "__proto__")).toEqual({ found: false, value: undefined });
    expect(resolvePath({}, "toString")).toEqual({ found: false, value: undefined });
  });
});

describe("renderTemplate", () => {
  const ctx: RenderContext = {
    node: {
      n1: {
        output: {
          token: "abc123",
          count: 3,
          ok: true,
          nested: { deep: { list: [1, { k: "v" }] } },
        },
      },
      n2: { output: { token: "xyz" } },
      n3: { output: null },
    },
    input: { user: { id: 7, name: "张三" }, version: "v2", count: 0 },
  };

  it("node 引用与 input 引用求值并字符串化", () => {
    expect(renderTemplate("{{ node.n2.output.token }}", ctx)).toEqual({
      value: "xyz",
      warnings: [],
    });
    expect(renderTemplate("{{ input.user.id }}", ctx)).toEqual({ value: "7", warnings: [] });
  });

  it("嵌套对象 / 数组路径", () => {
    expect(renderTemplate("{{ node.n1.output.nested.deep.list.0 }}", ctx).value).toBe("1");
    expect(renderTemplate("{{ node.n1.output.nested.deep.list.1.k }}", ctx).value).toBe("v");
  });

  it("多表达式混排拼接（含中文与静态文本）", () => {
    const raw = "{{ input.user.name }}（{{ input.version }}）→ 令牌 {{ node.n2.output.token }}";
    expect(renderTemplate(raw, ctx).value).toBe("张三（v2）→ 令牌 xyz");
  });

  it("空串模板渲染为空串且无警告", () => {
    expect(renderTemplate("", ctx)).toEqual({ value: "", warnings: [] });
  });

  it("整串即表达式时保持字符串语义：数字 / 布尔字符串化，不还原类型", () => {
    const rendered = renderTemplate("{{ input.count }}", ctx);
    expect(rendered.value).toBe("0");
    expect(typeof rendered.value).toBe("string");
    expect(renderTemplate("{{ node.n1.output.ok }}", ctx)).toEqual({ value: "true", warnings: [] });
  });

  it("对象 / 数组求值结果 JSON 序列化", () => {
    expect(renderTemplate("{{ input.user }}", ctx).value).toBe('{"id":7,"name":"张三"}');
    expect(renderTemplate("{{ node.n1.output.nested.deep.list }}", ctx).value).toBe(
      '[1,{"k":"v"}]',
    );
  });

  it("字符串值原样（不做 JSON 再包装）", () => {
    expect(renderTemplate("{{ input.user.name }}", ctx).value).toBe("张三");
  });

  it("深层缺失路径 → 空串 + 警告，不抛错", () => {
    const rendered = renderTemplate("{{ node.n1.output.nested.missing.x }}", ctx);
    expect(rendered.value).toBe("");
    expect(rendered.warnings).toHaveLength(1);
    expect(rendered.warnings[0]).toContain("模板引用路径不存在");
    expect(rendered.warnings[0]).toContain("node.n1.output.nested.missing.x");
  });

  it("引用的节点不在上下文 → 空串 + 警告", () => {
    const rendered = renderTemplate("{{ node.nX.output.token }}", ctx);
    expect(rendered.value).toBe("");
    expect(rendered.warnings[0]).toContain("模板引用的节点不在上下文中");
  });

  it("求值结果为 null / undefined → 空串 + 警告", () => {
    const nullRender = renderTemplate("{{ node.n3.output }}", ctx);
    expect(nullRender.value).toBe("");
    expect(nullRender.warnings[0]).toContain("null/undefined");

    const missingKeyRender = renderTemplate("{{ input.nope }}", ctx);
    expect(missingKeyRender.value).toBe("");
    expect(missingKeyRender.warnings[0]).toContain("模板引用路径不存在");
  });

  it("未知引用 / 空表达式 → 空串 + 警告", () => {
    const rendered = renderTemplate("A={{ oops() }} B={{}}", ctx);
    expect(rendered.value).toBe("A= B=");
    expect(rendered.warnings).toHaveLength(2);
    expect(rendered.warnings[0]).toContain("未知的模板引用");
  });

  it("裸路径按入参取值：与 input.<path> 渲染结果一致", () => {
    const bare = renderTemplate("token={{ headers.x-token }}", {
      node: {},
      input: { headers: { "x-token": "abc" } },
    });
    expect(bare).toEqual({ value: "token=abc", warnings: [] });
  });

  it("未闭合 {{ → 字面量保留 + 解析警告透出", () => {
    const rendered = renderTemplate("token={{ node.n2.output.token", ctx);
    expect(rendered.value).toBe("token={{ node.n2.output.token");
    expect(rendered.warnings).toEqual([UNCLOSED_BRACE_WARNING]);
  });

  it("特殊字符原样保留（不引入转义 / 正则替换副作用）", () => {
    const raw = "a$b&c(d)e[f]g\nh\ti\"j'k\\l";
    expect(renderTemplate(raw, ctx)).toEqual({ value: raw, warnings: [] });
  });

  it("ctx.node / ctx.input 缺失时按缺数据处理，渲染不抛错", () => {
    expect(
      renderTemplate("{{ node.n1.output.token }}", { node: undefined as never, input: undefined }),
    ).toEqual({
      value: "",
      warnings: [expect.stringContaining("模板引用的节点不在上下文中")],
    });
    expect(renderTemplate("{{ input.user.id }}", EMPTY_CTX).warnings[0]).toContain(
      "模板引用路径不存在",
    );
  });

  it("空串值正常渲染为空串且不告警（与 null/undefined 区分）", () => {
    const ctxEmpty: RenderContext = { node: { n1: { output: { note: "" } } }, input: {} };
    expect(renderTemplate("[{{ node.n1.output.note }}]", ctxEmpty)).toEqual({
      value: "[]",
      warnings: [],
    });
  });
});

describe("renderValueDeep", () => {
  const ctx: RenderContext = {
    node: { n1: { output: { token: "T1", total: 42 } } },
    input: { userId: 7 },
  };

  it("headers record：字符串值渲染，静态值不动", () => {
    const headers = { Authorization: "Bearer {{ node.n1.output.token }}", "X-Static": "keep" };
    expect(renderValueDeep(headers, ctx)).toEqual({
      value: { Authorization: "Bearer T1", "X-Static": "keep" },
      warnings: [],
    });
  });

  it("body JSON 深层结构：嵌套对象与数组内的字符串全部渲染", () => {
    const body = {
      user: "{{ input.userId }}",
      items: ["{{ node.n1.output.token }}", { qty: "{{ input.userId }}", note: "static" }],
    };
    const rendered = renderValueDeep(body, ctx);
    expect(rendered.value).toEqual({
      user: "7",
      items: ["T1", { qty: "7", note: "static" }],
    });
  });

  it("数字 / 布尔 / null 原样保留，对象键不参与渲染", () => {
    const body = {
      timeoutMs: 3000,
      retry: true,
      flag: null,
      "{{ notRendered }}": "{{ input.userId }}",
    };
    expect(renderValueDeep(body, ctx).value).toEqual({
      timeoutMs: 3000,
      retry: true,
      flag: null,
      "{{ notRendered }}": "7",
    });
  });

  it("字符串语义保持：整串是表达式且结果形如 JSON 数字 / 片段，仍是字符串", () => {
    const rendered = renderValueDeep(
      { count: "{{ node.n1.output.total }}", raw: '{"token":"{{ node.n1.output.token }}"}' },
      ctx,
    );
    expect(rendered.value).toEqual({ count: "42", raw: '{"token":"T1"}' });
    expect(typeof (rendered.value as Record<string, unknown>).count).toBe("string");
  });

  it("多叶子的警告聚合并保序", () => {
    const rendered = renderValueDeep(
      { a: "{{ input.nope }}", b: ["{{ node.nX.t }}"], c: "ok" },
      ctx,
    );
    expect(rendered.warnings).toHaveLength(2);
    expect(rendered.warnings[0]).toContain("input.nope");
    expect(rendered.warnings[1]).toContain("node.nX.t");
  });

  it("空对象 / 空数组 / 原始值原样返回", () => {
    expect(renderValueDeep({}, ctx)).toEqual({ value: {}, warnings: [] });
    expect(renderValueDeep([], ctx)).toEqual({ value: [], warnings: [] });
    expect(renderValueDeep(5, ctx)).toEqual({ value: 5, warnings: [] });
    expect(renderValueDeep(null, ctx)).toEqual({ value: null, warnings: [] });
  });
});

describe("extractReferences", () => {
  it("按出现顺序提取 node / input 引用", () => {
    expect(
      extractReferences("{{ node.n2.output.token }} + {{ input.user.id }} + {{ node.n1 }}"),
    ).toEqual([
      { kind: "node", nodeId: "n2", path: "output.token" },
      { kind: "input", path: "user.id" },
      { kind: "node", nodeId: "n1", path: "" },
    ]);
  });

  it("未知引用跳过；重复引用保留（不去重）；裸路径计为 input 引用", () => {
    expect(extractReferences("{{ oops() }} {{ input.a }} {{ input.a }} {{ body.id }}")).toEqual([
      { kind: "input", path: "a" },
      { kind: "input", path: "a" },
      { kind: "input", path: "body.id" },
    ]);
  });

  it("无表达式的文本 / 空串 → 空列表", () => {
    expect(extractReferences("no refs here")).toEqual([]);
    expect(extractReferences("")).toEqual([]);
  });
});
