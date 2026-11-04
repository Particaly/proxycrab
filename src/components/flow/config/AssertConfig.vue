<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { JsonPathOperator, StatusCodeOperator } from "../../../../flow-engine/src/types";
import {
  ASSERT_KINDS,
  JSON_PATH_OPS,
  STATUS_OPS,
  assertionsToRows,
  buildAssertShard,
  createAssertionRow,
  validateAssertDraft,
  type AssertionRow,
  type AssertConfigShard,
} from "./assert-config";

/**
 * 断言节点（assert）配置表单（计划 Task 16 薄片 A）：断言规则行编辑（状态码
 * / JSONPath / JSON Schema 三类，增删行）。形态对齐归档
 * `LogicNodeConfigDrawer.tsx @ 485fa00` 的断言编辑器（字段与文案逐字沿用）。
 *
 * 交互：编辑即改即生效（上抛 { assertions } 分片，挂载侧合并进节点 config；
 * 空数组合法 = 纯透传）；保存前语法预检（JSONPath 解析、正则编译、Schema
 * JSON 解析）就地报错，门控经 defineExpose 的 validate()。
 */

const props = defineProps<{
  /** 断言节点 config 分片（消费 assertions 一键）。 */
  modelValue: AssertConfigShard;
  /** 置灰全部编辑（运行期锁定等场景）。 */
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [shard: AssertConfigShard] }>();

/* ------------------------------ 行草稿状态 ------------------------------ */

const rows = ref<AssertionRow[]>(assertionsToRows(props.modelValue.assertions));

/** 最近一次上抛的 assertions 引用（emit 引发的 props 回流不重建行草稿）。 */
let lastEmitted: unknown = props.modelValue.assertions;

watch(
  () => props.modelValue,
  (config) => {
    if (config.assertions === lastEmitted) return;
    lastEmitted = config.assertions;
    rows.value = assertionsToRows(config.assertions);
  },
);

/* ------------------------------ 行编辑与变更出口 ------------------------------ */

const validationError = computed(() => validateAssertDraft(rows.value));

function updateRow(index: number, patch: Partial<AssertionRow>): void {
  if (props.disabled) return;
  rows.value = rows.value.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row));
  emitShard();
}

function addRow(): void {
  if (props.disabled) return;
  rows.value = [...rows.value, createAssertionRow()];
  emitShard();
}

function removeRow(index: number): void {
  if (props.disabled) return;
  rows.value = rows.value.filter((_, rowIndex) => rowIndex !== index);
  emitShard();
}

function emitShard(): void {
  const shard = buildAssertShard(rows.value);
  lastEmitted = shard.assertions;
  emit("update:modelValue", shard);
}

function onKindChange(index: number, event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  updateRow(index, { kind: value as AssertionRow["kind"] });
}

function onStatusOpChange(index: number, event: Event): void {
  updateRow(index, { statusOp: (event.target as HTMLSelectElement).value as StatusCodeOperator });
}

function onJsonOpChange(index: number, event: Event): void {
  updateRow(index, { jsonOp: (event.target as HTMLSelectElement).value as JsonPathOperator });
}

defineExpose({
  /** 保存门控：断言行校验（合法返回 null，非法返回首条错误文案）。 */
  validate: (): string | null => validateAssertDraft(rows.value),
});
</script>

<template>
  <div class="as-root">
    <div class="as-head">
      <span class="as-title">断言规则（全部通过才放行）</span>
      <button class="btn icon as-add" :disabled="disabled" @click="addRow">+ 添加</button>
    </div>

    <div v-for="(row, index) in rows" :key="row.id" class="as-row">
      <select
        class="select as-kind"
        :value="row.kind"
        :aria-label="`断言 ${index + 1} 类别`"
        :disabled="disabled"
        @change="onKindChange(index, $event)"
      >
        <option v-for="item in ASSERT_KINDS" :key="item.value" :value="item.value">
          {{ item.label }}
        </option>
      </select>

      <template v-if="row.kind === 'status'">
        <select
          class="select as-op"
          :value="row.statusOp"
          :aria-label="`断言 ${index + 1} 比较方式`"
          :disabled="disabled"
          @change="onStatusOpChange(index, $event)"
        >
          <option v-for="op in STATUS_OPS" :key="op.value" :value="op.value">{{ op.label }}</option>
        </select>
        <input
          v-if="row.statusOp === 'eq'"
          class="input mono as-value"
          :value="row.statusValue"
          placeholder="200"
          inputmode="numeric"
          :aria-label="`断言 ${index + 1} 期望状态码`"
          spellcheck="false"
          :disabled="disabled"
          @input="updateRow(index, { statusValue: ($event.target as HTMLInputElement).value })"
        />
      </template>

      <template v-else-if="row.kind === 'jsonPath'">
        <input
          class="input mono as-path"
          :value="row.path"
          placeholder="$.body.token"
          :aria-label="`断言 ${index + 1} JSONPath`"
          spellcheck="false"
          :disabled="disabled"
          @input="updateRow(index, { path: ($event.target as HTMLInputElement).value })"
        />
        <select
          class="select as-op"
          :value="row.jsonOp"
          :aria-label="`断言 ${index + 1} 比较方式`"
          :disabled="disabled"
          @change="onJsonOpChange(index, $event)"
        >
          <option v-for="op in JSON_PATH_OPS" :key="op.value" :value="op.value">{{ op.label }}</option>
        </select>
        <input
          v-if="row.jsonOp !== 'exists'"
          class="input mono as-value"
          :value="row.jsonValue"
          :placeholder="row.jsonOp === 'regex' ? '正则源，如 ^ok$' : '期望值（JSON 或文本）'"
          :aria-label="`断言 ${index + 1} 期望值`"
          spellcheck="false"
          :disabled="disabled"
          @input="updateRow(index, { jsonValue: ($event.target as HTMLInputElement).value })"
        />
      </template>

      <template v-else>
        <input
          class="input mono as-path"
          :value="row.schemaPath"
          placeholder="目标路径（空 = 入参根）"
          :aria-label="`断言 ${index + 1} 目标路径`"
          spellcheck="false"
          :disabled="disabled"
          @input="updateRow(index, { schemaPath: ($event.target as HTMLInputElement).value })"
        />
        <textarea
          class="input mono as-schema"
          rows="2"
          :value="row.schemaText"
          :placeholder="'{"type":"object"}'"
          :aria-label="`断言 ${index + 1} Schema 定义`"
          spellcheck="false"
          :disabled="disabled"
          @input="updateRow(index, { schemaText: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <button
        class="btn icon as-remove"
        :disabled="disabled"
        :aria-label="`删除断言 ${index + 1}`"
        title="删除该断言"
        @click="removeRow(index)"
      >
        ✕
      </button>
    </div>

    <p v-if="rows.length === 0" class="as-hint text-faint">
      暂无断言：节点将原样透传入参（空规则列表合法）。
    </p>
    <div v-if="validationError" class="as-error" role="alert">{{ validationError }}</div>
  </div>
</template>

<style scoped>
.as-root {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.as-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.as-title {
  font-size: 11px;
  color: var(--text-faint);
}

.as-add {
  font-size: 11px;
}

.as-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex-wrap: wrap;
}

.as-row .input,
.as-row .select {
  padding: 3px 6px;
  font-size: 11px;
  min-width: 0;
}

.as-kind {
  flex: none;
}

.as-op {
  flex: none;
}

.as-path {
  flex: 1.2 1 120px;
}

.as-value {
  flex: 1 1 110px;
}

.as-schema {
  flex: 1 1 100%;
  resize: vertical;
}

.as-remove {
  flex: none;
  font-size: 11px;
}

.as-hint {
  font-size: 11px;
  line-height: 1.6;
}

.as-error {
  font-size: 11px;
  color: var(--danger);
}
</style>
