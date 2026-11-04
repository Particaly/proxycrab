import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref, type Ref } from "vue";
import {
  PREVIEW_DEBOUNCE_MS,
  buildSampleRenderContext,
  evaluateTemplatePreview,
  useExpressionPreview,
  type TemplatePreviewResult,
  type TemplateSampleContext,
} from "./use-expression-preview";

/**
 * 模板实时求值预览测试（vitest node 环境 + fake timers；Task 15 薄片 A）。
 *
 * 自归档 use-expression-preview.test.tsx @ 485fa00 移植（React 组件挂载 →
 * 组合式函数在 effectScope 内直调——仓库 vitest 为 node 环境无组件挂载设施，
 * 求值与防抖语义都收敛在组合式函数，覆盖等价）：防抖常量节奏、样本缺省恒
 * null、静态文本不求值、防抖去抖（窗口内重排只按最后一次求值）、缺数据
 * 空串 + 警告分类、标红口径、作用域销毁后挂起求值不落地。
 */

/** 测试样本：入参含可解析字段 / 空串字段；上游节点样本一枚；变量与环境各一枚 */
const SAMPLE: TemplateSampleContext = {
  input: { token: "abc", empty: "" },
  inputSource: "run",
  upstreamSamples: { n1: { sample: { status: 200, json: { token: "t1" } }, source: "run" } },
  nodeSamples: { n1: { sample: { status: 200, json: { token: "t1" } }, source: "run" } },
  variables: { apiKey: "k1" },
  env: { BASE_URL: "https://api.example.com" },
};

/** 空样本（回退链走空）：预览按「缺数据」渲染为空串 + 警告 */
const EMPTY_SAMPLE: TemplateSampleContext = {
  input: null,
  inputSource: "none",
  upstreamSamples: {},
  nodeSamples: {},
  variables: {},
};

/** 挂载组合式函数（effectScope 内），返回受控 value 与求值结果引用 */
function mountPreview(
  sample: TemplateSampleContext | null | undefined,
  initial = "",
  debounceMs = PREVIEW_DEBOUNCE_MS,
) {
  const value = ref(initial);
  const scope = effectScope();
  const preview = scope.run(() =>
    useExpressionPreview({ value, sample: () => sample, debounceMs }),
  ) as Readonly<Ref<TemplatePreviewResult | null>>;
  return { value, preview, stop: () => scope.stop() };
}

/** 写入受控值并等 Vue 调度器刷新（watch 回流后防抖计时才挂上，随后可推进 fake timers） */
async function type(value: Ref<string>, next: string): Promise<void> {
  value.value = next;
  await nextTick();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useExpressionPreview（防抖求值）", () => {
  it("防抖常量与仓库输入防抖惯例同节奏（200ms）", () => {
    expect(PREVIEW_DEBOUNCE_MS).toBe(200);
  });

  it("未传样本：输入模板表达式也不求值（结果恒 null）", async () => {
    const { value, preview } = mountPreview(undefined);
    await type(value, "{{ token }}");
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(preview.value).toBeNull();
  });

  it("纯静态文本（无 {{）：求值为原文、无警告、不标红（hasExpressions false）", async () => {
    const { value, preview } = mountPreview(SAMPLE);
    await type(value, "https://api.example.com");
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(preview.value).toEqual({
      value: "https://api.example.com",
      warnings: [],
      hasIssue: false,
      hasExpressions: false,
    });
  });

  it("输入模板：防抖后就地求值（正常态不标红）", async () => {
    const { value, preview } = mountPreview(SAMPLE);
    await type(value, "tok={{ token }}");
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(preview.value).toEqual({
      value: "tok=abc",
      warnings: [],
      hasIssue: false,
      hasExpressions: true,
    });
  });

  it("输入防抖：停顿不足时不求值，满窗口后求值一次", async () => {
    const { value, preview } = mountPreview(SAMPLE);
    await type(value, "{{ token }}");
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1);
    expect(preview.value).toBeNull();
    vi.advanceTimersByTime(1);
    expect(preview.value?.value).toBe("abc");
  });

  it("连续输入只在最后一次停顿后求值（防抖去抖语义）", async () => {
    const { value, preview } = mountPreview(SAMPLE);
    await type(value, "{{ to");
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1);
    await type(value, "{{ token }}");
    // 第一次的挂起求值被取消：再推进 1ms 不落地，满新窗口后反映最新文本
    vi.advanceTimersByTime(1);
    expect(preview.value).toBeNull();
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1);
    expect(preview.value?.value).toBe("abc");
  });

  it("作用域销毁：挂起求值不落地（迟到写入不发生）", async () => {
    const { value, preview, stop } = mountPreview(SAMPLE);
    await type(value, "{{ token }}");
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1);
    stop();
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(preview.value).toBeNull();
  });

  it("样本由缺省变为提供：重新开始求值", async () => {
    const sample = ref<TemplateSampleContext | null>(null);
    const value = ref("");
    const scope = effectScope();
    const preview = scope.run(() =>
      useExpressionPreview({ value, sample: () => sample.value, debounceMs: 0 }),
    ) as Readonly<Ref<TemplatePreviewResult | null>>;
    await type(value, "{{ var.apiKey }}");
    vi.advanceTimersByTime(0);
    expect(preview.value).toBeNull();
    sample.value = SAMPLE;
    await nextTick();
    vi.advanceTimersByTime(0);
    expect(preview.value?.value).toBe("k1");
    scope.stop();
  });
});

describe("evaluateTemplatePreview（求值与标红口径）", () => {
  it("路径引用不存在的数据：空串 + 「路径不存在」警告，标红", () => {
    const result = evaluateTemplatePreview("{{ input.missing }}", buildSampleRenderContext(SAMPLE));
    expect(result.value).toBe("");
    expect(result.warnings).toEqual(["模板引用路径不存在：{{ input.missing }}"]);
    expect(result.hasIssue).toBe(true);
  });

  it("字段值本身为空串（无警告）：渲染为空即标红提示核实（保守侧）", () => {
    const result = evaluateTemplatePreview("{{ input.empty }}", buildSampleRenderContext(SAMPLE));
    expect(result.warnings).toEqual([]);
    expect(result.hasIssue).toBe(true);
  });

  it("四命名空间照常求值：node / var / env 样本参与", () => {
    const ctx = buildSampleRenderContext(SAMPLE);
    expect(evaluateTemplatePreview("{{ node.n1.json.token }}", ctx).value).toBe("t1");
    expect(evaluateTemplatePreview("{{ var.apiKey }}", ctx).value).toBe("k1");
    expect(evaluateTemplatePreview("{{ env.BASE_URL }}", ctx).value).toBe(
      "https://api.example.com",
    );
  });

  it("冷启动（回退链走空）：渲染不失败，空串 + 警告（标红）", () => {
    const result = evaluateTemplatePreview("{{ token }}", buildSampleRenderContext(EMPTY_SAMPLE));
    expect(result.value).toBe("");
    expect(result.warnings).toEqual(["模板引用路径不存在：{{ token }}"]);
    expect(result.hasIssue).toBe(true);
  });
});
