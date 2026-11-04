<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { TransformEngine } from "../../../../flow-engine/src/types";
import {
  TRANSFORM_ENGINES,
  buildTransformShard,
  createExtractionRow,
  extractionsToRows,
  validateTransformDraft,
  type TransformConfigShard,
  type TransformRow,
} from "./transform-config";

/**
 * 数据处理节点（transform）配置表单（计划 Task 16 薄片 A）：提取规则行编辑
 * （规则名 / 引擎 / 查询表达式，增删行）。形态对齐归档
 * `LogicNodeConfigDrawer.tsx @ 485fa00` 的提取规则编辑器。
 *
 * 交互：编辑即改即生效（上抛 { extractions } 分片，挂载侧合并进节点 config；
 * 空数组合法 = 原样透传 input）；保存前语法预检（JSONPath 解析、JMESPath
 * 试查）就地报错，门控经 defineExpose 的 validate()。
 */

const props = defineProps<{
  /** 数据处理节点 config 分片（消费 extractions 一键）。 */
  modelValue: TransformConfigShard;
  /** 置灰全部编辑（运行期锁定等场景）。 */
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [shard: TransformConfigShard] }>();

/* ------------------------------ 行草稿状态 ------------------------------ */

const rows = ref<TransformRow[]>(extractionsToRows(props.modelValue.extractions));

/** 最近一次上抛的 extractions 引用（emit 引发的 props 回流不重建行草稿）。 */
let lastEmitted: unknown = props.modelValue.extractions;

watch(
  () => props.modelValue,
  (config) => {
    if (config.extractions === lastEmitted) return;
    lastEmitted = config.extractions;
    rows.value = extractionsToRows(config.extractions);
  },
);

/* ------------------------------ 行编辑与变更出口 ------------------------------ */

const validationError = computed(() => validateTransformDraft(rows.value));

function updateRow(index: number, patch: Partial<TransformRow>): void {
  if (props.disabled) return;
  rows.value = rows.value.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row));
  emitShard();
}

function addRow(): void {
  if (props.disabled) return;
  rows.value = [...rows.value, createExtractionRow()];
  emitShard();
}

function removeRow(index: number): void {
  if (props.disabled) return;
  rows.value = rows.value.filter((_, rowIndex) => rowIndex !== index);
  emitShard();
}

function emitShard(): void {
  const shard = buildTransformShard(rows.value);
  lastEmitted = shard.extractions;
  emit("update:modelValue", shard);
}

function onEngineChange(index: number, event: Event): void {
  updateRow(index, { engine: (event.target as HTMLSelectElement).value as TransformEngine });
}

defineExpose({
  /** 保存门控：提取规则校验（合法返回 null，非法返回首条错误文案）。 */
  validate: (): string | null => validateTransformDraft(rows.value),
});
</script>

<template>
  <div class="tf-root">
    <div class="tf-head">
      <span class="tf-title">提取规则（多规则输出对象，单规则直出）</span>
      <button class="btn icon tf-add" :disabled="disabled" @click="addRow">+ 添加</button>
    </div>

    <div v-for="(row, index) in rows" :key="row.id" class="tf-row">
      <input
        class="input tf-name"
        :value="row.name"
        placeholder="名称"
        :aria-label="`提取规则 ${index + 1} 名称`"
        spellcheck="false"
        :disabled="disabled"
        @input="updateRow(index, { name: ($event.target as HTMLInputElement).value })"
      />
      <select
        class="select tf-engine"
        :value="row.engine"
        :aria-label="`提取规则 ${index + 1} 引擎`"
        :disabled="disabled"
        @change="onEngineChange(index, $event)"
      >
        <option v-for="engine in TRANSFORM_ENGINES" :key="engine.value" :value="engine.value">
          {{ engine.label }}
        </option>
      </select>
      <input
        class="input mono tf-path"
        :value="row.path"
        placeholder="$.data.token 或 items[*].id"
        :aria-label="`提取规则 ${index + 1} 表达式`"
        spellcheck="false"
        :disabled="disabled"
        @input="updateRow(index, { path: ($event.target as HTMLInputElement).value })"
      />
      <button
        class="btn icon tf-remove"
        :disabled="disabled"
        :aria-label="`删除提取规则 ${index + 1}`"
        title="删除该提取规则"
        @click="removeRow(index)"
      >
        ✕
      </button>
    </div>

    <p v-if="rows.length === 0" class="tf-hint text-faint">
      暂无规则：节点将原样透传入参。点击「+ 添加」提取上游数据。
    </p>
    <div v-if="validationError" class="tf-error" role="alert">{{ validationError }}</div>
  </div>
</template>

<style scoped>
.tf-root {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.tf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.tf-title {
  font-size: 11px;
  color: var(--text-faint);
}

.tf-add {
  font-size: 11px;
}

.tf-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.tf-row .input,
.tf-row .select {
  padding: 3px 6px;
  font-size: 11px;
  min-width: 0;
}

.tf-name {
  flex: 1 1 80px;
}

.tf-engine {
  flex: none;
}

.tf-path {
  flex: 1.6 1 150px;
}

.tf-remove {
  flex: none;
  font-size: 11px;
}

.tf-hint {
  font-size: 11px;
  line-height: 1.6;
}

.tf-error {
  font-size: 11px;
  color: var(--danger);
}
</style>
