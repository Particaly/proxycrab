<script setup lang="ts">
import { computed, nextTick, ref, shallowRef } from "vue";
import {
  applySuggestInsert,
  buildDropInsertPlan,
  buildInsertTemplatePlan,
  buildSuggestOptions,
  detectSuggestState,
  type InsertPlan,
  type RefSuggestOption,
  type SuggestNodeOption,
  type SuggestNodePathSample,
  type SuggestState,
} from "./expression-suggest";
import { collectJsonPaths } from "./input-paths";
import SuggestPopup from "./SuggestPopup.vue";
import {
  useExpressionPreview,
  type SampleInputSource,
  type TemplatePreviewResult,
  type TemplateSampleContext,
} from "./use-expression-preview";

/**
 * 表达式输入框（单行；ReqFlow 复刻计划 Task 15 薄片 A）。
 *
 * 形态自归档 `_archive/reqflow/.../ExpressionInput.tsx @ 485fa00` 移植
 * （React → Vue 3 `<script setup>`：受控 value/onChange → defineModel，提示
 * 状态钩子 use-expression-suggest 内联为本组件状态，Tailwind 类 → base.css
 * token 的 scoped 样式）。在普通文本输入之上提供 `{{ }}` 模板引用提示：输入
 * `{{` 弹出候选浮层（根候选 → 节点 / 变量 / 环境键 → 深路径），支持输入过滤、
 * 回车 / 点击插入、Esc / 失焦关闭，另有「插入引用」小按钮在光标处插入 `{{ }}`
 * 兜底。组件只做输入辅助与配置期预览，运行时渲染在 flow-engine 模板引擎。
 *
 * 增量能力（均向后兼容——不传 sample 时无深路径候选、不渲染预览行）：
 *   - 深路径补全：提供 sample 时，`node.<id>.` 之后按该节点样本数据派生路径
 *     候选（collectJsonPaths 缺省深度 6 / 总数 60），节点 id 候选可下钻；
 *   - 求值预览：控件获得焦点时在下方就地展示模板的实时渲染结果（防抖求值，
 *     警告 / 空结果标红）。
 *
 * 插入能力上交：insertTemplate / insertSnippet 经 defineExpose 暴露——后续
 * 请求头行操作收敛进「…」菜单时，菜单项经模板 ref 调用同一插入出口
 * （hideInsertButton 可隐藏内联按钮）。
 */

const props = defineProps<{
  /** 空态占位文案 */
  placeholder?: string;
  /** 上游可引用节点清单（提示浮层第二级候选；缺省空 = node. 之下无候选） */
  availableNodeIds?: ReadonlyArray<SuggestNodeOption>;
  /** 可引用变量名清单（提供时根候选追加 var. 与变量名建议） */
  variableNames?: ReadonlyArray<string>;
  /** 入参字段路径清单（提供时 input. / $json. 之后列出字段候选与裸路径简写） */
  inputPaths?: ReadonlyArray<string>;
  /** 当前激活环境集合的键名清单（提供时根候选追加 env. 与环境键建议） */
  envKeys?: ReadonlyArray<string>;
  /**
   * 模板样本上下文（可选）：深路径候选与实时求值预览共用的样本数据（最近
   * 运行入参 / 上游输出 / 捕获响应体 / 变量 / 激活环境）。须引用稳定（调用方
   * 用 computed / 常量）；缺省时无深路径候选、不渲染预览行。
   */
  sample?: TemplateSampleContext | null;
  /** 隐藏内联「插入引用」按钮（行操作收敛进菜单时由调用方传入） */
  hideInsertButton?: boolean;
}>();

const model = defineModel<string>({ required: true });

/** 入参样本来源的标注文案（预览行次要说明；none 单独走「暂无样本数据」分支） */
const SAMPLE_SOURCE_LABELS: Record<Exclude<SampleInputSource, "none">, string> = {
  run: "样本：最近一次运行入参",
  "upstream-run": "样本：上游节点最近运行输出",
  "upstream-capture": "样本：上游引用的捕获响应体",
};
/** 冷启动（回退链走空）时预览行的补救提示 */
const NONE_SOURCE_HINT =
  "暂无样本数据：运行一次流程或为上游节点引用请求快照后，可按真实数据预览求值结果。";

const controlRef = ref<HTMLInputElement | null>(null);
/** `{{` 之后到光标的提示状态（null = 当前不处于未闭合表达式内） */
const suggest = shallowRef<SuggestState | null>(null);
const highlightIndex = ref(0);
const focused = ref(false);

/** 深路径候选：按各节点样本派生点分路径（与 inputPaths 同机制同上限） */
const nodePathSamples = computed<SuggestNodePathSample[] | undefined>(() => {
  if (props.sample === undefined || props.sample === null) return undefined;
  return Object.entries(props.sample.nodeSamples).map(([id, entry]) => ({
    id,
    paths: collectJsonPaths(entry.sample),
    source: entry.source,
  }));
});

const options = computed<RefSuggestOption[]>(() =>
  suggest.value
    ? buildSuggestOptions(
        suggest.value.query,
        props.availableNodeIds ?? [],
        props.variableNames,
        props.inputPaths,
        nodePathSamples.value,
        props.envKeys,
      )
    : [],
);
/** 候选为空时不弹浮层（query 已进入路径输入阶段等情况） */
const active = computed(() => suggest.value !== null && options.value.length > 0);
const safeHighlightIndex = computed(() => (active.value ? Math.min(highlightIndex.value, options.value.length - 1) : 0));

/** 应用写入计划：提交受控文本，等 value 回流后把光标落到计划位置 */
async function applyPlan(plan: InsertPlan, nextSuggest: SuggestState | null): Promise<void> {
  suggest.value = nextSuggest;
  highlightIndex.value = 0;
  model.value = plan.text;
  await nextTick();
  controlRef.value?.setSelectionRange(plan.caret, plan.caret);
}

/** 控件输入：依据新文本与光标位置重算提示状态 */
function onChange(event: Event): void {
  const element = event.target as HTMLInputElement;
  const nextValue = element.value;
  const caret = element.selectionStart ?? nextValue.length;
  suggest.value = detectSuggestState(nextValue.slice(0, caret));
  highlightIndex.value = 0;
  model.value = nextValue;
}

/** 控件按键：Esc 关闭（不冒泡到外层对话框）；上下键移动高亮；回车插入高亮候选 */
function onKeyDown(event: KeyboardEvent): void {
  if (!active.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    suggest.value = null;
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    highlightIndex.value = Math.min(safeHighlightIndex.value + 1, options.value.length - 1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    highlightIndex.value = Math.max(safeHighlightIndex.value - 1, 0);
    return;
  }
  if (event.key === "Enter") {
    // 浮层打开期间回车语义让位给「插入候选」
    event.preventDefault();
    void insertOption(options.value[safeHighlightIndex.value]);
  }
}

/** 控件失焦：关闭浮层（候选点击经 mousedown preventDefault 保留焦点绕开本分支） */
function onBlur(): void {
  focused.value = false;
  suggest.value = null;
}

/** 插入选中候选：叶子候选关闭浮层；非叶子候选推进到下一级提示 */
async function insertOption(option: RefSuggestOption | undefined): Promise<void> {
  if (!option || suggest.value === null) return;
  const element = controlRef.value;
  const caret = element?.selectionStart ?? model.value.length;
  const plan = applySuggestInsert(model.value, caret, suggest.value.replaceStart, option.insert);
  const nextSuggest = option.leaf ? null : detectSuggestState(plan.text.slice(0, plan.caret));
  await applyPlan(plan, nextSuggest);
}

/**
 * 插入位置的光标口径：控件聚焦时取当前光标处；未聚焦时 selectionStart 残留
 * 的是上次编辑位置而非用户意图，一律追加到文末（菜单 / 拖放插入共用）。
 */
function caretForInsert(): number {
  const element = controlRef.value;
  const isFocused = element !== null && element.ownerDocument.activeElement === element;
  return isFocused && element !== null ? (element.selectionStart ?? model.value.length) : model.value.length;
}

/**
 * 「插入引用」兜底（defineExpose 供外层菜单 / 按钮调用）：光标处（未聚焦文末）
 * 插入 `{{ }}` 并回焦控件，根候选浮层随插入立即可见。
 */
async function insertTemplate(): Promise<void> {
  const plan = buildInsertTemplatePlan(model.value, caretForInsert());
  controlRef.value?.focus();
  await applyPlan(plan, detectSuggestState(plan.text.slice(0, plan.caret)));
}

/** 插入完整模板片段（如拖放字段 chip 携带的 `{{ ... }}` 引用），光标落在片段末尾 */
async function insertSnippet(snippet: string): Promise<void> {
  if (snippet === "") return;
  const plan = buildDropInsertPlan(model.value, caretForInsert(), snippet);
  controlRef.value?.focus();
  await applyPlan(plan, detectSuggestState(plan.text.slice(0, plan.caret)));
}

defineExpose({ insertTemplate, insertSnippet });

/** 实时求值（防抖；样本缺省时恒为 null） */
const preview = useExpressionPreview({ value: model, sample: () => props.sample });
/** 预览行只在控件聚焦且有模板表达式时渲染 */
const activePreview = computed<TemplatePreviewResult | null>(() =>
  focused.value && preview.value !== null && preview.value.hasExpressions ? preview.value : null,
);

/** 样本来源标注（预览行次要说明） */
const sampleSourceText = computed(() => {
  const sample = props.sample;
  if (sample === undefined || sample === null) return "";
  return sample.inputSource === "none" ? NONE_SOURCE_HINT : SAMPLE_SOURCE_LABELS[sample.inputSource];
});
</script>

<template>
  <div class="expression-input">
    <div class="expression-row">
      <input
        ref="controlRef"
        type="text"
        class="expression-control"
        :value="model"
        :placeholder="placeholder"
        spellcheck="false"
        aria-haspopup="listbox"
        :aria-expanded="active"
        @input="onChange"
        @keydown="onKeyDown"
        @focus="focused = true"
        @blur="onBlur"
      />
      <button
        v-if="!hideInsertButton"
        type="button"
        class="insert-button"
        title="插入引用：在光标处插入 {{ }}"
        aria-label="插入引用"
        @mousedown.prevent
        @click="insertTemplate"
      >
        {+}
      </button>
      <SuggestPopup
        v-if="active"
        :options="options"
        :highlight-index="safeHighlightIndex"
        @pick="insertOption"
        @highlight="highlightIndex = $event"
      />
    </div>
    <div
      v-if="activePreview"
      data-testid="expression-preview"
      :data-issue="activePreview.hasIssue ? 'true' : 'false'"
      role="status"
      aria-label="模板求值预览"
      class="preview"
    >
      <div class="preview-value-row">
        <span class="preview-label">求值预览</span>
        <span class="preview-value" :class="{ issue: activePreview.hasIssue }">
          {{ activePreview.value === "" ? "（空）" : activePreview.value }}
        </span>
      </div>
      <p v-for="warning in activePreview.warnings" :key="warning" class="preview-warning">{{ warning }}</p>
      <p v-if="sampleSourceText !== ''" class="preview-source">{{ sampleSourceText }}</p>
    </div>
  </div>
</template>

<style scoped>
.expression-input {
  width: 100%;
}

.expression-row {
  position: relative;
  display: flex;
  width: 100%;
  align-items: center;
  gap: 4px;
}

/* 控件：等宽字体（模板内容多为代码感文本），描边与底色同仓库其他输入控件 */
.expression-control {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  outline: none;
  transition: border-color 0.12s;
}

.expression-control::placeholder {
  color: var(--text-faint);
}

.expression-control:focus {
  border-color: var(--accent);
}

/* 「插入引用」兜底按钮：小尺寸、次要观感，与控件同高对齐 */
.insert-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;
}

.insert-button:hover {
  background: var(--bg-hover);
  color: var(--text);
}

/* 求值预览行：输入框下方就地展示，10-11px 次要文字，高信息密度 */
.preview {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
}

.preview-value-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.preview-label {
  flex: none;
  font-size: 10px;
  color: var(--text-secondary);
}

.preview-value {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 16px;
  color: var(--text);
  word-break: break-all;
}

.preview-value.issue {
  color: var(--danger);
}

.preview-warning {
  margin: 0;
  font-size: 10px;
  line-height: 16px;
  color: var(--danger);
  word-break: break-all;
}

.preview-source {
  margin: 0;
  font-size: 10px;
  line-height: 16px;
  color: var(--text-secondary);
}
</style>
