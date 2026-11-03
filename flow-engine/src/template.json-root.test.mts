import { describe, expect, it } from "vitest";
import { extractReferences, parseTemplate, renderTemplate } from "./template";

/**
 * `$json` 模板根别名测试（M12-T3）：`$json.<path>` 与 `input.<path>` 等价
 * （n8n 习惯写法），解析 / 渲染 / 引用清单对两种写法一视同仁。
 */

const ctx = {
  node: {},
  input: { body: { data: { token: "tk-1" } }, count: 2 },
};

describe("template：$json 根别名", () => {
  it("渲染与 input. 等价（点分路径下钻）", () => {
    expect(renderTemplate("{{ $json.body.data.token }}", ctx).value).toBe("tk-1");
    expect(renderTemplate("{{ input.body.data.token }}", ctx).value).toBe("tk-1");
  });

  it("裸 {{ $json }} 取入参根值（对象 JSON 序列化）", () => {
    const rendered = renderTemplate("{{ $json }}", ctx);
    expect(rendered.value).toBe(JSON.stringify(ctx.input));
    expect(rendered.warnings).toEqual([]);
  });

  it("路径缺失 → 空串 + 路径警告（与 input. 同一策略）", () => {
    expect(renderTemplate("{{ $json.body.nope }}", ctx).value).toBe("");
    expect(renderTemplate("{{ $json.body.nope }}", ctx).warnings).toEqual([
      "模板引用路径不存在：{{ $json.body.nope }}",
    ]);
  });

  it("解析结果统一为 input 引用（引用清单不含根别名差异）", () => {
    const tokens = parseTemplate("{{ $json.a }}");
    expect(tokens[0]).toMatchObject({ kind: "expression", ref: { kind: "input", path: "a" } });
    expect(extractReferences("{{ $json.a }} {{ input.b }}")).toEqual([
      { kind: "input", path: "a" },
      { kind: "input", path: "b" },
    ]);
  });

  it("数字 / 布尔值按字符串拼接（与既有 stringify 语义一致）", () => {
    expect(renderTemplate("n={{ $json.count }}", ctx).value).toBe("n=2");
  });
});
