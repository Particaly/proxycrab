<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  LOOP_HARD_MAX_ITERATIONS,
  LOOP_MAX_CONCURRENCY,
} from "../../../../flow-engine/src/logic-nodes";
import {
  LOOP_CSV_DELIMITERS,
  buildLoopShard,
  loopItemsText,
  parseLoopConcurrency,
  parseLoopCsvDelimiter,
  parseLoopIntervalMs,
  parseLoopItemsText,
  parseLoopMaxIterations,
  validateLoopDraft,
  type LoopConfigShard,
  type LoopCsvDelimiter,
} from "./loop-config";

/**
 * 循环节点（loop）配置表单（计划 Task 16 薄片 A）：迭代数据源（JSON 数组 /
 * 模板）+ CSV 数据源与分隔符（配置时优先于 items）+ 迭代上限 + 并发数与迭代
 * 间隔。形态对齐归档 `LogicNodeConfigDrawer.tsx @ 485fa00` 的 loop 分节
 * （React 草稿 state → Vue ref，文案与上限提示逐字沿用），CSV 两字段为引擎
 * M10-T6 能力的表单入口（归档抽屉未暴露）。
 *
 * 交互：全部编辑即改即生效（上抛完整分片，挂载侧合并进节点 config），输入
 * 非法时对应键不落、错误就地提示；并发数 > 1 时就地说明「迭代变量按迭代
 * 隔离，结束后按完成顺序合并」（对齐引擎 overlay 行为）。
 *
 * 落库惯例（见 loop-config.ts 文件头）：maxIterations 恒落键（留空 = 缺省
 * 100）；concurrency 仅 > 1、intervalMs 仅 > 0 落键；csvText 非空落键、
 * csvDelimiter 仅非逗号落键。
 */

const props = defineProps<{
  /** 循环节点 config 分片（消费 items / maxIterations / csvText / csvDelimiter / concurrency / intervalMs 六键）。 */
  modelValue: LoopConfigShard;
  /** 置灰全部编辑（运行期锁定等场景）。 */
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [shard: LoopConfigShard] }>();

/* ------------------------------ 输入草稿状态 ------------------------------ */

const itemsText = ref(loopItemsText(props.modelValue));
const maxIterationsText = ref(
  props.modelValue.maxIterations === undefined ? "" : String(props.modelValue.maxIterations),
);
const csvText = ref(typeof props.modelValue.csvText === "string" ? props.modelValue.csvText : "");
const csvDelimiter = ref<LoopCsvDelimiter>(
  parseLoopCsvDelimiter(props.modelValue.csvDelimiter),
);
const concurrencyText = ref(
  props.modelValue.concurrency === undefined ? "" : String(props.modelValue.concurrency),
);
const intervalText = ref(
  props.modelValue.intervalMs === undefined ? "" : String(props.modelValue.intervalMs),
);

/** 最近一次上抛分片（emit 引发的 props 回流不重置输入草稿，外部改动才重置）。 */
let lastEmitted: LoopConfigShard | null = null;

watch(
  () => props.modelValue,
  (config) => {
    if (config === lastEmitted) return;
    lastEmitted = null;
    itemsText.value = loopItemsText(config);
    maxIterationsText.value =
      config.maxIterations === undefined ? "" : String(config.maxIterations);
    csvText.value = typeof config.csvText === "string" ? config.csvText : "";
    csvDelimiter.value = parseLoopCsvDelimiter(config.csvDelimiter);
    concurrencyText.value =
      config.concurrency === undefined ? "" : String(config.concurrency);
    intervalText.value = config.intervalMs === undefined ? "" : String(config.intervalMs);
  },
);

/* ------------------------------ 派生视图与变更出口 ------------------------------ */

/** 各字段的就地错误（null = 合法）。 */
const itemsError = computed(() => parseLoopItemsText(itemsText.value).error ?? null);
const maxIterationsError = computed(() => parseLoopMaxIterations(maxIterationsText.value).error ?? null);
const concurrencyError = computed(() => parseLoopConcurrency(concurrencyText.value).error ?? null);
const intervalError = computed(() => parseLoopIntervalMs(intervalText.value).error ?? null);

/** 并发度草稿（> 1 时渲染隔离说明；非法 / 留空按 1 = 串行）。 */
const concurrencyValue = computed(() => parseLoopConcurrency(concurrencyText.value).value ?? 1);

/** CSV 数据源非空 = 生效（优先于 items，items 被引擎忽略）。 */
const csvActive = computed(() => csvText.value.trim() !== "");

function emitShard(): void {
  const shard = buildLoopShard({
    itemsText: itemsText.value,
    maxIterationsText: maxIterationsText.value,
    csvText: csvText.value,
    csvDelimiter: csvDelimiter.value,
    concurrencyText: concurrencyText.value,
    intervalText: intervalText.value,
  });
  lastEmitted = shard;
  emit("update:modelValue", shard);
}

watch([itemsText, maxIterationsText, csvText, csvDelimiter, concurrencyText, intervalText], () => {
  if (props.disabled) return;
  emitShard();
});

defineExpose({
  /** 保存门控：全部字段校验（合法返回 null，非法返回首条错误文案）。 */
  validate: (): string | null =>
    validateLoopDraft({
      itemsText: itemsText.value,
      maxIterationsText: maxIterationsText.value,
      concurrencyText: concurrencyText.value,
      intervalText: intervalText.value,
    }),
});
</script>

<template>
  <div class="lp-root">
    <label class="lp-field">
      <span>迭代数据源</span>
      <textarea
        v-model="itemsText"
        class="input mono lp-items"
        rows="3"
        :placeholder="'// JSON 数组：["a","b"]
// 或模板：{{ node.n1.json.ids }}（渲染后需可解析为 JSON 数组）'"
        spellcheck="false"
        :disabled="disabled"
      />
    </label>
    <div v-if="itemsError" class="lp-error" role="alert">{{ itemsError }}</div>

    <label class="lp-field">
      <span>CSV 数据源（可选，优先于数据源 items）</span>
      <textarea
        v-model="csvText"
        class="input mono lp-items"
        rows="2"
        placeholder="id,name&#10;1,alice"
        spellcheck="false"
        :disabled="disabled"
      />
    </label>
    <label class="lp-field lp-inline">
      <span>CSV 分隔符</span>
      <select v-model="csvDelimiter" class="select" :disabled="disabled">
        <option v-for="option in LOOP_CSV_DELIMITERS" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
      <span v-if="csvActive" class="text-faint lp-note">已配置：执行时优先于 items</span>
    </label>

    <label class="lp-field">
      <span>迭代上限</span>
      <input
        v-model="maxIterationsText"
        class="input mono"
        inputmode="numeric"
        placeholder="100"
        spellcheck="false"
        :disabled="disabled"
      />
    </label>
    <div v-if="maxIterationsError" class="lp-error" role="alert">{{ maxIterationsError }}</div>
    <div v-else class="lp-hint text-faint">
      数据源超过上限时只执行前 N 项（不视为错误）；硬上限 {{ LOOP_HARD_MAX_ITERATIONS }} 轮。
    </div>

    <div class="lp-grid">
      <label class="lp-field">
        <span>并发数</span>
        <input
          v-model="concurrencyText"
          class="input mono"
          inputmode="numeric"
          placeholder="1"
          spellcheck="false"
          :disabled="disabled"
        />
      </label>
      <label class="lp-field">
        <span>迭代间隔（毫秒）</span>
        <input
          v-model="intervalText"
          class="input mono"
          inputmode="numeric"
          placeholder="0"
          spellcheck="false"
          :disabled="disabled"
        />
      </label>
    </div>
    <div v-if="concurrencyError || intervalError" class="lp-error" role="alert">
      {{ concurrencyError ?? intervalError }}
    </div>
    <div v-else class="lp-hint text-faint">
      并发数为每批同时执行的迭代轮数（1 = 逐轮串行，上限
      {{ LOOP_MAX_CONCURRENCY }}）；迭代间隔为相邻两批开始前的等待时间，等待期间可取消。
    </div>
    <div v-if="concurrencyValue > 1" class="lp-hint lp-isolation">
      迭代变量按迭代隔离，结束后按完成顺序合并。
    </div>
  </div>
</template>

<style scoped>
.lp-root {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.lp-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.lp-field > span {
  font-size: 10px;
  color: var(--text-faint);
}

.lp-field .input,
.lp-field .select {
  width: 100%;
  padding: 3px 6px;
  font-size: 11px;
}

.lp-inline {
  flex-direction: row;
  align-items: center;
  gap: var(--space-2);
}

.lp-inline > span {
  flex: none;
  font-size: 11px;
}

.lp-inline .select {
  width: auto;
}

.lp-note {
  font-size: 10px;
}

.lp-items {
  resize: vertical;
}

.lp-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}

.lp-hint {
  font-size: 11px;
  line-height: 1.6;
}

.lp-isolation {
  color: var(--warning);
}

.lp-error {
  font-size: 11px;
  color: var(--danger);
}
</style>
