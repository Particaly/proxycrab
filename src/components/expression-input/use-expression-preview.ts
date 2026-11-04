import { onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";
import { renderTemplate, type RenderContext } from "../../../flow-engine/src/template";

/**
 * 模板实时求值预览（ReqFlow 复刻计划 Task 15 薄片 A）。
 *
 * 形态自归档 `_archive/reqflow` 的 `template-sample.ts` + `use-expression-preview.ts
 * @ 485fa00` 合并移植（React 钩子 → Vue 组合式函数），求值直接复用本仓
 * `flow-engine/src/template.ts` 的 renderTemplate——模板语义单一事实源在
 * flow-engine，本模块只装配样本上下文与防抖调度，不复制渲染逻辑。
 *
 * 以样本上下文（TemplateSampleContext——最近运行入参 / 上游输出 / 捕获响应体 /
 * 流程变量 / 激活环境）边写边渲染 `{{ }}` 结果：输入防抖（PREVIEW_DEBOUNCE_MS，
 * 与仓库既有 200ms 输入防抖惯例同节奏）后求值一次。
 *
 * 展示时机由组件门控（获得焦点时渲染预览行），本组合式函数只负责求值；样本
 * 缺省（undefined / null，未接线的旧用法）时恒返回 null——组件行为零变化。
 */

/** 单个节点的样本数据（`node.<id>` 引用求值与深路径候选共用） */
export interface NodeSampleEntry {
  /** 样本数据（最近运行 output 原样，或捕获响应体投影） */
  sample: unknown;
  /** 样本来源：run = 最近一次运行 output；capture = 引用快照的响应体（无运行记录的回退） */
  source: "run" | "capture";
}

/** 入参样本来源（预览标注用，冷启动回退链的各档位） */
export type SampleInputSource = "run" | "upstream-run" | "upstream-capture" | "none";

/** 模板实时求值 / 深路径补全共用的样本上下文（页面装配，输入组件消费） */
export interface TemplateSampleContext {
  /** 当前节点入参样本（`{{ input.* }}` / 裸路径求值用；null = 回退链走完仍无样本） */
  input: unknown;
  /** 入参样本来源（预览标注「暂无样本数据」等） */
  inputSource: SampleInputSource;
  /**
   * 上游闭包内有样本的节点（求值 RenderContext.node 的数据源；键为模板引用键
   * refId ?? id，与 flow-engine 执行器运行时上下文的 node 键同口径）。只含上游：
   * 与运行时「渲染该节点时上下文里只有已完成节点」的口径一致。
   */
  upstreamSamples: Record<string, NodeSampleEntry>;
  /**
   * 全图有样本的节点（深路径候选数据源；含上游）。不做上游过滤——与提示层
   * 节点引用键候选同口径（引用谁由用户决定，运行时才按图取值）。
   */
  nodeSamples: Record<string, NodeSampleEntry>;
  /** 流程级普通变量值表（var.<name> 求值用；不含 secret 值，防明文回显） */
  variables: Record<string, string>;
  /**
   * 当前激活环境集合的普通键值表（env.<key> 求值用）；undefined = 无激活环境
   * / 环境数据未加载（env 引用渲染为空串 + 警告，与运行时缺省约定一致）。
   */
  env?: Record<string, string>;
}

/**
 * 把样本上下文装配为 flow-engine 的渲染上下文（RenderContext）。
 *
 * node 表来自上游闭包样本（求值口径见模块头）；var / env 浅拷贝防调用方改动
 * 波及原表（与执行器装配运行时上下文的约定一致）。
 *
 * @param sample 样本上下文（页面装配产物）
 */
export function buildSampleRenderContext(sample: TemplateSampleContext): RenderContext {
  const node: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(sample.upstreamSamples)) {
    node[id] = entry.sample;
  }
  const context: RenderContext = {
    node,
    input: sample.input,
    var: { ...sample.variables },
  };
  if (sample.env !== undefined) {
    context.env = { ...sample.env };
  }
  return context;
}

/** 实时求值预览结果（输入组件渲染「求值预览」行的数据） */
export interface TemplatePreviewResult {
  /** 渲染结果字符串（renderTemplate 的 value 原样——缺数据按空串 + 警告） */
  value: string;
  /** 渲染警告（语法残缺 / 未知引用 / 路径不存在等，如实展示） */
  warnings: string[];
  /**
   * 是否视为「写错」（预览标红口径）：出现任何渲染警告，或模板含表达式但整段
   * 渲染为空串。renderTemplate 永不抛错，「写错」只能以渲染产物判定——
   * 警告必然对应真实问题（缺数据 / 语法残缺 / 未知引用）；纯空结果（无警告）
   * 涵盖「字段值本身是空串」的合法场景，一并标红提示用户核实（宁多报不漏报）。
   */
  hasIssue: boolean;
  /** 模板是否含至少一个 `{{`（无表达式的纯静态文本不展示预览） */
  hasExpressions: boolean;
}

/**
 * 求值单个模板输入框的实时预览（纯函数，复用 flow-engine renderTemplate）。
 *
 * 标红口径：渲染永不抛错，「写错」= 路径引用不存在的数据 / 语法残缺，以
 * 「警告 + 空结果」判定——
 *   - warnings 非空：缺数据（路径不存在 / 节点不在上下文 / 变量·环境键缺失 /
 *     值为 null）与语法残缺（未知引用 / 未闭合 `{{`）都会透出警告，一律视为
 *     写错并标红；
 *   - 模板含表达式但渲染结果为空串且无警告：表达式全部合法地渲染成了空
 *     （字段值本身是空串）——同样标红提示核实（无法与「写错」从产物上区分的
 *     场景取保守侧）。
 *
 * @param raw 模板输入框当前文本
 * @param ctx 渲染上下文（buildSampleRenderContext 产物）
 */
export function evaluateTemplatePreview(raw: string, ctx: RenderContext): TemplatePreviewResult {
  const hasExpressions = raw.includes("{{");
  if (!hasExpressions) {
    return { value: raw, warnings: [], hasIssue: false, hasExpressions: false };
  }
  const { value, warnings } = renderTemplate(raw, ctx);
  return {
    value,
    warnings,
    hasIssue: warnings.length > 0 || value === "",
    hasExpressions: true,
  };
}

/** 输入防抖等待毫秒数（连续击键只在停顿后求值一次；对齐仓库 200ms 惯例） */
export const PREVIEW_DEBOUNCE_MS = 200;

/** useExpressionPreview 的入参 */
export interface UseExpressionPreviewParams {
  /** 模板输入框当前文本（受控值；ref 或 getter） */
  value: MaybeRefOrGetter<string>;
  /**
   * 样本上下文（页面装配）；undefined / null = 未提供样本（预览关闭，返回
   * null）。须引用稳定（调用方用 computed / 常量），否则每次变化都会重排防抖。
   */
  sample: MaybeRefOrGetter<TemplateSampleContext | null | undefined>;
  /** 防抖等待毫秒数（缺省 PREVIEW_DEBOUNCE_MS；测试可注入 0 立即求值） */
  debounceMs?: number;
}

/**
 * 管理模板实时求值：value / sample 变化经防抖后求值一次。
 *
 * 防抖语义：依赖变化即取消挂起求值再重排（clearTimeout + 重新调度）；组件
 * 卸载（作用域销毁）时兜底取消，迟到写入不落地。样本缺省时直接置 null
 * （不调度求值）。
 *
 * @returns 最近一次求值结果（只读 ref；无表达式时 hasExpressions false，组件
 *          据此不渲染；样本缺省时为 null）
 */
export function useExpressionPreview({
  value,
  sample,
  debounceMs = PREVIEW_DEBOUNCE_MS,
}: UseExpressionPreviewParams): Readonly<Ref<TemplatePreviewResult | null>> {
  const result = shallowRef<TemplatePreviewResult | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  watch(
    () => [toValue(value), toValue(sample)] as const,
    ([text, context]) => {
      cancel();
      if (context === undefined || context === null) {
        result.value = null;
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        result.value = evaluateTemplatePreview(text, buildSampleRenderContext(context));
      }, debounceMs);
    },
    { immediate: true },
  );

  onScopeDispose(cancel);
  return result;
}
