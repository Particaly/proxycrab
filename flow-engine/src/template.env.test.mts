import { describe, expect, it } from "vitest";
import { extractReferences, parseTemplate, renderTemplate, renderValueDeep } from "./template";

/**
 * M10-T4 模板 env 命名空间测试（既有 template.test.ts / template.var.test.ts
 * 锁定的 node / input / var 行为不在此重复）：`{{ env.<key> }}` /
 * `{{ env.<key>.<path> }}` 的解析、渲染与缺省约定——独立命名空间与 var 并存
 * 不冲突；无激活环境（ctx.env 缺失）或键不存在 → 空串 + 专属告警（与 var 的
 * 缺省值约定一致，渲染永不因缺数据失败）。
 */

describe("parseTemplate / extractReferences：env 引用语法（M10-T4）", () => {
  it("env.<key> 解析为 kind=env 引用（path 为空串 = 取根值）", () => {
    expect(extractReferences("{{ env.baseUrl }}")).toEqual([
      { kind: "env", name: "baseUrl", path: "" },
    ]);
  });

  it("env.<key>.<path> 解析出路径；裸 {{ env }} / {{ env..x }} 为未知引用", () => {
    expect(extractReferences("{{ env.cfg.host }}")).toEqual([
      { kind: "env", name: "cfg", path: "host" },
    ]);
    expect(parseTemplate("{{ env }}")[0]).toEqual({
      kind: "expression",
      raw: "env",
      ref: null,
    });
    expect(parseTemplate("{{ env..x }}")[0]?.kind === "expression").toBe(true);
    expect(
      parseTemplate("{{ env..x }}").map((token) =>
        token.kind === "expression" ? token.ref : null,
      ),
    ).toEqual([null]);
  });

  it("env 与 node / input / var 并存解析互不干扰", () => {
    expect(extractReferences("{{ node.n1.a }}{{ input }}{{ var.token }}{{ env.host }}")).toEqual([
      { kind: "node", nodeId: "n1", path: "a" },
      { kind: "input", path: "" },
      { kind: "var", name: "token", path: "" },
      { kind: "env", name: "host", path: "" },
    ]);
  });
});

describe("renderTemplate：env 引用渲染（M10-T4）", () => {
  it("ctx.env 命中 → 渲染为环境值（字符串原样 / 对象 JSON 序列化）", () => {
    const ctx = {
      node: {},
      input: null,
      env: { baseUrl: "https://api.prod", cfg: { host: "h1" } },
    };
    expect(renderTemplate("{{ env.baseUrl }}/v1", ctx).value).toBe("https://api.prod/v1");
    expect(renderTemplate("{{ env.cfg }}", ctx).value).toBe('{"host":"h1"}');
  });

  it("键不存在 → 空串 + 「环境变量不存在」告警", () => {
    const result = renderTemplate("x={{ env.missing }}", { node: {}, input: null, env: {} });
    expect(result.value).toBe("x=");
    expect(result.warnings).toEqual(["模板引用的环境变量不存在：{{ env.missing }}"]);
  });

  it("无激活环境（ctx.env 缺省）→ 同样空串 + 告警（缺省值约定与 var 一致）", () => {
    const result = renderTemplate("{{ env.baseUrl }}", { node: {}, input: null });
    expect(result.value).toBe("");
    expect(result.warnings).toEqual(["模板引用的环境变量不存在：{{ env.baseUrl }}"]);
  });

  it("env 值下钻路径缺失 / 值为 null → 复用既有「路径不存在 / 值为空」告警", () => {
    const ctx = { node: {}, input: null, env: { cfg: { host: "h" }, nothing: null } };
    const missingPath = renderTemplate("{{ env.cfg.port }}", ctx);
    expect(missingPath.value).toBe("");
    expect(missingPath.warnings).toEqual(["模板引用路径不存在：{{ env.cfg.port }}"]);
    const nullValue = renderTemplate("{{ env.nothing }}", ctx);
    expect(nullValue.value).toBe("");
    expect(nullValue.warnings).toEqual(["模板引用的值为 null/undefined：{{ env.nothing }}"]);
  });

  it("env 与 var 同名键互不串扰（独立命名空间）", () => {
    const ctx = {
      node: {},
      input: null,
      var: { baseUrl: "from-var" },
      env: { baseUrl: "from-env" },
    };
    expect(renderTemplate("{{ var.baseUrl }}|{{ env.baseUrl }}", ctx).value).toBe(
      "from-var|from-env",
    );
  });
});

describe("renderValueDeep：env 引用深渲染（M10-T4）", () => {
  it("headers / body 结构中的 env 表达式一并渲染", () => {
    const ctx = { node: {}, input: null, env: { token: "tok-1234" } };
    const result = renderValueDeep(
      { headers: { Authorization: "Bearer {{ env.token }}" }, body: '{"env":"{{ env.token }}"}' },
      ctx,
    );
    expect(result.value).toEqual({
      headers: { Authorization: "Bearer tok-1234" },
      body: '{"env":"tok-1234"}',
    });
    expect(result.warnings).toEqual([]);
  });
});
