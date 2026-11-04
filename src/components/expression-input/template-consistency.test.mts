import { describe, expect, it } from "vitest";
import {
  UNCLOSED_BRACE_WARNING,
  extractReferences,
  renderTemplate,
  type RenderContext,
  type TemplateRef,
} from "../../../flow-engine/src/template";
import { buildRootOptions } from "./expression-suggest";
import { collectJsonPaths } from "./input-paths";
import {
  buildSampleRenderContext,
  evaluateTemplatePreview,
  type TemplateSampleContext,
} from "./use-expression-preview";

/**
 * 模板语义一致性断言（Task 15 薄片 A Step 1 口径）。
 *
 * 模板语义单一事实源是本仓 flow-engine/src/template.ts（Task 2 自上游 engine
 * 移植）；组件层（建议 / 预览）只是其消费方。本文件用「相同输入在两侧跑出
 * 相同结果」的断言逐条锁定：
 *   - 样本上下文装配（buildSampleRenderContext）与手工装配的 RenderContext 同构；
 *   - 同一批模板串在 flow-engine renderTemplate 与组件预览 evaluateTemplatePreview
 *     两侧的值与警告逐条相等（缺数据 → 空串 + 分类警告，渲染永不失败）；
 *   - 四命名空间 + 裸路径 / $json 别名在 flow-engine 侧解析为同一引用（kind 逐条）；
 *   - collectJsonPaths 派生出的每条候选路径都能被 flow-engine 无警告渲染
 *     （建议层的路径段语义与 resolvePath 一致）。
 */

/** 手工装配的引擎渲染上下文（语义基准侧） */
const ENGINE_CTX: RenderContext = {
  node: { n1: { status: 200, json: { data: { token: "t1" } } } },
  input: {
    headers: { "x-token": "abc" },
    body: { token: "abc", empty: "" },
    user: { roles: ["admin", "dev"] },
    nullVal: null,
  },
  var: { apiKey: "k1" },
  env: { BASE_URL: "https://api.example.com" },
};

/** 组件层样本上下文（装配后应与 ENGINE_CTX 同构） */
const SAMPLE: TemplateSampleContext = {
  input: ENGINE_CTX.input,
  inputSource: "run",
  upstreamSamples: { n1: { sample: ENGINE_CTX.node.n1, source: "run" } },
  nodeSamples: { n1: { sample: ENGINE_CTX.node.n1, source: "run" } },
  variables: { apiKey: "k1" },
  env: { BASE_URL: "https://api.example.com" },
};

describe("样本上下文装配 ↔ 引擎上下文", () => {
  it("buildSampleRenderContext 产物与手工装配的 RenderContext 同构", () => {
    expect(buildSampleRenderContext(SAMPLE)).toEqual(ENGINE_CTX);
  });

  it("var / env 浅拷贝：装配产物与原样本表互不波及", () => {
    const ctx = buildSampleRenderContext(SAMPLE);
    ctx.var!["mutated"] = "x";
    ctx.env!["mutated"] = "x";
    expect(SAMPLE.variables).not.toHaveProperty("mutated");
    expect(SAMPLE.env).not.toHaveProperty("mutated");
  });
});

describe("同一输入两侧同结果（renderTemplate ↔ evaluateTemplatePreview）", () => {
  /** 覆盖四命名空间命中、裸路径与 $json 别名、拼接、各类缺数据与语法残缺 */
  const CASES = [
    // 四命名空间命中
    "{{ node.n1.json.data.token }}",
    "{{ input.body.token }}",
    "{{ var.apiKey }}",
    "{{ env.BASE_URL }}",
    // 裸路径简写与 $json 别名（与 input. 写法同解析）
    "{{ body.token }}",
    "{{ headers.x-token }}",
    "{{ $json.body.token }}",
    // 数组下标与多段路径
    "{{ user.roles.0 }}",
    // 文本拼接
    "Bearer {{ var.apiKey }} @ {{ env.BASE_URL }}",
    // 缺数据分类（各专属告警）
    "{{ node.missing.status }}",
    "{{ input.user.missing }}",
    "{{ var.missing }}",
    "{{ env.missing }}",
    "{{ input.nullVal }}",
    // 语法残缺
    "{{ }}",
    "{{ not a path }}",
    "open {{ unclosed",
    // 混合：命中与缺数据并存
    "{{ var.apiKey }}/{{ input.missing }}",
  ];

  it("值与警告逐条相等（缺数据 → 空串 + 分类警告，永不抛错）", () => {
    const ctx = buildSampleRenderContext(SAMPLE);
    for (const raw of CASES) {
      const engine = renderTemplate(raw, ENGINE_CTX);
      const preview = evaluateTemplatePreview(raw, ctx);
      expect(preview.value, raw).toBe(engine.value);
      expect(preview.warnings, raw).toEqual(engine.warnings);
      expect(typeof preview.value, raw).toBe("string");
    }
  });

  it("缺数据的警告分类逐条锁定（flow-engine 侧行为契约）", () => {
    expect(renderTemplate("{{ node.missing.status }}", ENGINE_CTX).warnings).toEqual([
      "模板引用的节点不在上下文中：{{ node.missing.status }}",
    ]);
    expect(renderTemplate("{{ var.missing }}", ENGINE_CTX).warnings).toEqual([
      "模板引用的变量不存在：{{ var.missing }}",
    ]);
    expect(renderTemplate("{{ env.missing }}", ENGINE_CTX).warnings).toEqual([
      "模板引用的环境变量不存在：{{ env.missing }}",
    ]);
    expect(renderTemplate("{{ input.user.missing }}", ENGINE_CTX).warnings).toEqual([
      "模板引用路径不存在：{{ input.user.missing }}",
    ]);
    expect(renderTemplate("{{ input.nullVal }}", ENGINE_CTX)).toEqual({
      value: "",
      warnings: ["模板引用的值为 null/undefined：{{ input.nullVal }}"],
    });
    expect(renderTemplate("{{ }}", ENGINE_CTX).warnings).toEqual(["未知的模板引用：{{  }}"]);
    expect(renderTemplate("open {{ unclosed", ENGINE_CTX)).toEqual({
      value: "open {{ unclosed",
      warnings: [UNCLOSED_BRACE_WARNING],
    });
  });

  it("渲染永不因缺数据失败：病态输入全部产出字符串", () => {
    const pathological = [
      "{{",
      "}}",
      "{{ {{ }}",
      "{{ var }}",
      "{{ env }}",
      "{{ input..x }}",
      "{{ env..x }}",
      "",
    ];
    for (const raw of pathological) {
      expect(typeof renderTemplate(raw, ENGINE_CTX).value, raw).toBe("string");
      expect(typeof evaluateTemplatePreview(raw, buildSampleRenderContext(SAMPLE)).value, raw).toBe(
        "string",
      );
    }
  });
});

describe("四命名空间 + 裸路径 / $json 别名（flow-engine 解析口径逐条锁定）", () => {
  /** 引用内容 → 期望解析出的引用（TemplateRef） */
  const NAMESPACE_CASES: ReadonlyArray<[string, TemplateRef]> = [
    ["node.n1.json.data.token", { kind: "node", nodeId: "n1", path: "json.data.token" }],
    ["input.body.token", { kind: "input", path: "body.token" }],
    ["$json.body.token", { kind: "input", path: "body.token" }],
    ["body.token", { kind: "input", path: "body.token" }],
    ["headers.x-token", { kind: "input", path: "headers.x-token" }],
    ["var.apiKey", { kind: "var", name: "apiKey", path: "" }],
    ["env.BASE_URL", { kind: "env", name: "BASE_URL", path: "" }],
  ];

  it("每种写法在 flow-engine 侧解析为同一引用（别名同 kind 同 path）", () => {
    for (const [content, ref] of NAMESPACE_CASES) {
      expect(extractReferences(`{{ ${content} }}`), content).toEqual([ref]);
    }
  });

  it("裸路径 / $json / input. 三种写法渲染同值", () => {
    for (const content of ["body.token", "$json.body.token", "input.body.token"]) {
      expect(renderTemplate(`{{ ${content} }}`, ENGINE_CTX).value, content).toBe("abc");
    }
  });

  it("建议层根候选与引擎命名空间一一对应（input / node / var / env）", () => {
    const roots = buildRootOptions(["apiKey"], ["body.token"], ["BASE_URL"]).map(
      (option) => option.insert,
    );
    expect(roots).toEqual(["body.", "node.", "var.", "env."]);
    const kinds = extractReferences("{{ input.a }} {{ node.n.a }} {{ var.a }} {{ env.a }}").map(
      (ref) => ref.kind,
    );
    expect(kinds).toEqual(["input", "node", "var", "env"]);
  });
});

describe("建议候选全部可在 flow-engine 侧渲染（路径段语义一致）", () => {
  it("node 深路径候选：collectJsonPaths 逐条无警告渲染", () => {
    for (const path of collectJsonPaths(ENGINE_CTX.node.n1)) {
      const rendered = renderTemplate(`{{ node.n1.${path} }}`, ENGINE_CTX);
      expect(rendered.warnings, `node.n1.${path}`).toEqual([]);
      expect(rendered.value, `node.n1.${path}`).not.toBe("");
    }
  });

  it("input 候选：裸路径与 input. 写法逐条无警告渲染（值为 null 的叶子按引擎约定告警，不算路径缺失）", () => {
    for (const path of collectJsonPaths(ENGINE_CTX.input)) {
      for (const raw of [`{{ ${path} }}`, `{{ input.${path} }}`]) {
        const { warnings } = renderTemplate(raw, ENGINE_CTX);
        expect(
          warnings.filter((warning) => !warning.includes("值为 null")),
          raw,
        ).toEqual([]);
      }
    }
  });
});
