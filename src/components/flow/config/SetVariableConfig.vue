<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { VariableAssignmentSource } from "../../../../flow-engine/src/types";
import {
  ASSIGNMENT_SOURCES,
  assignmentsToRows,
  buildSetVariableShard,
  createAssignmentRow,
  validateSetVariableDraft,
  type AssignmentRow,
  type SetVariableConfigShard,
} from "./set-variable-config";

/**
 * 变量赋值节点（setVariable）配置表单（计划 Task 16 薄片 A）：赋值项行编辑
 * （变量名 / 来源四态 / 路径 / 源节点 / 字面量值，增删行、按顺序执行）。形态
 * 对齐归档 `LogicNodeConfigDrawer.tsx @ 485fa00` 的赋值项编辑器（文案与占位
 * 逐字沿用）。
 *
 * 交互：编辑即改即生效（上抛 { assignments } 分片，挂载侧合并进节点 config；
 * 空数组合法 = 纯透传）；全空行落库时丢弃；变量名重复 / 节点来源缺节点就地
 * 报错，保存由挂载侧经 defineExpose 的 validate() 门控。
 */

const props = defineProps<{
  /** 变量赋值节点 config 分片（消费 assignments 一键）。 */
  modelValue: SetVariableConfigShard;
  /** 流程内可选源节点清单（from='node' 时的下拉候选；缺省退化为节点 id 手输）。 */
  nodeOptions?: ReadonlyArray<{ id: string; label: string }>;
  /** 置灰全部编辑（运行期锁定等场景）。 */
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [shard: SetVariableConfigShard] }>();

/* ------------------------------ 行草稿状态 ------------------------------ */

const rows = ref<AssignmentRow[]>(assignmentsToRows(props.modelValue.assignments));

/** 最近一次上抛的 assignments 引用（emit 引发的 props 回流不重建行草稿）。 */
let lastEmitted: unknown = props.modelValue.assignments;

watch(
  () => props.modelValue,
  (config) => {
    if (config.assignments === lastEmitted) return;
    lastEmitted = config.assignments;
    rows.value = assignmentsToRows(config.assignments);
  },
);

/* ------------------------------ 行编辑与变更出口 ------------------------------ */

const validationError = computed(() => validateSetVariableDraft(rows.value));

function updateRow(index: number, patch: Partial<AssignmentRow>): void {
  if (props.disabled) return;
  rows.value = rows.value.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row));
  emitShard();
}

function addRow(): void {
  if (props.disabled) return;
  rows.value = [...rows.value, createAssignmentRow()];
  emitShard();
}

function removeRow(index: number): void {
  if (props.disabled) return;
  rows.value = rows.value.filter((_, rowIndex) => rowIndex !== index);
  emitShard();
}

function emitShard(): void {
  const shard = buildSetVariableShard(rows.value);
  lastEmitted = shard.assignments;
  emit("update:modelValue", shard);
}

/** 路径输入占位（来源相关口径，与上游一致）。 */
function pathPlaceholder(from: VariableAssignmentSource): string {
  return from === "var"
    ? "变量名.子路径（空 = 整个变量表）"
    : "取值路径，如 body.token（空 = 根值）";
}

const hasNodeOptions = computed(() => (props.nodeOptions?.length ?? 0) > 0);

defineExpose({
  /** 保存门控：赋值行校验（合法返回 null，非法返回首条错误文案）。 */
  validate: (): string | null => validateSetVariableDraft(rows.value),
});
</script>

<template>
  <div class="sv-root">
    <div class="sv-head">
      <span class="sv-title">赋值项（按顺序执行）</span>
      <button class="btn icon sv-add" :disabled="disabled" @click="addRow">+ 添加</button>
    </div>

    <div v-for="(row, index) in rows" :key="row.id" class="sv-row">
      <input
        class="input sv-name"
        :value="row.name"
        placeholder="变量名"
        :aria-label="`赋值项 ${index + 1} 变量名`"
        spellcheck="false"
        :disabled="disabled"
        @input="updateRow(index, { name: ($event.target as HTMLInputElement).value })"
      />
      <select
        class="select sv-from"
        :value="row.from"
        :aria-label="`赋值项 ${index + 1} 来源`"
        :disabled="disabled"
        @change="
          updateRow(index, {
            from: ($event.target as HTMLSelectElement).value as VariableAssignmentSource,
          })
        "
      >
        <option v-for="source in ASSIGNMENT_SOURCES" :key="source.value" :value="source.value">
          {{ source.label }}
        </option>
      </select>
      <select
        v-if="row.from === 'node' && hasNodeOptions"
        class="select sv-node"
        :value="row.node"
        :aria-label="`赋值项 ${index + 1} 源节点`"
        :disabled="disabled"
        @change="updateRow(index, { node: ($event.target as HTMLSelectElement).value })"
      >
        <option value="">选择节点</option>
        <option v-for="option in nodeOptions" :key="option.id" :value="option.id">
          {{ option.label }}
        </option>
      </select>
      <input
        v-else-if="row.from === 'node'"
        class="input mono sv-node"
        :value="row.node"
        placeholder="源节点 id"
        :aria-label="`赋值项 ${index + 1} 源节点`"
        spellcheck="false"
        :disabled="disabled"
        @input="updateRow(index, { node: ($event.target as HTMLInputElement).value })"
      />
      <input
        v-if="row.from !== 'literal'"
        class="input mono sv-path"
        :value="row.path"
        :placeholder="pathPlaceholder(row.from)"
        :aria-label="`赋值项 ${index + 1} 取值路径`"
        spellcheck="false"
        :disabled="disabled"
        @input="updateRow(index, { path: ($event.target as HTMLInputElement).value })"
      />
      <input
        v-else
        class="input mono sv-value"
        :value="row.value"
        :placeholder="'字面量值（支持 {{ }} 模板）'"
        :aria-label="`赋值项 ${index + 1} 字面量值`"
        spellcheck="false"
        :disabled="disabled"
        @input="updateRow(index, { value: ($event.target as HTMLInputElement).value })"
      />
      <button
        class="btn icon sv-remove"
        :disabled="disabled"
        :aria-label="`删除赋值项 ${index + 1}`"
        title="删除该赋值项"
        @click="removeRow(index)"
      >
        ✕
      </button>
    </div>

    <p v-if="rows.length === 0" class="sv-hint text-faint">
      暂无赋值项：节点将原样透传入参。点击「+ 添加」写入运行期变量。
    </p>
    <div v-if="validationError" class="sv-error" role="alert">{{ validationError }}</div>
  </div>
</template>

<style scoped>
.sv-root {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.sv-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.sv-title {
  font-size: 11px;
  color: var(--text-faint);
}

.sv-add {
  font-size: 11px;
}

.sv-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex-wrap: wrap;
}

.sv-row .input,
.sv-row .select {
  padding: 3px 6px;
  font-size: 11px;
  min-width: 0;
}

.sv-name {
  flex: 1 1 90px;
}

.sv-from {
  flex: none;
}

.sv-node {
  flex: 1 1 110px;
}

.sv-path,
.sv-value {
  flex: 1.4 1 130px;
}

.sv-remove {
  flex: none;
  font-size: 11px;
}

.sv-hint {
  font-size: 11px;
  line-height: 1.6;
}

.sv-error {
  font-size: 11px;
  color: var(--danger);
}
</style>
