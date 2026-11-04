<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { SuggestNodeOption } from "../../expression-input/expression-suggest";
import ExpressionInput from "../../expression-input/ExpressionInput.vue";
import {
  CONDITION_OPERATORS,
  describeConditionTree,
  migrateConditionRules,
  operatorNeedsRight,
  validateConditionTree,
} from "../../../../flow-engine/src/condition-builder";
import type {
  ConditionGroup,
  ConditionOperator,
} from "../../../../flow-engine/src/types";
import type { ConditionPath } from "./condition-tree";
import {
  appendGroup,
  appendLeaf,
  buildConditionShard,
  conditionRightText,
  describeConditionRightType,
  flattenConditionTree,
  removeChildAt,
  resolveConditionDraft,
  updateGroupAt,
  updateLeafAt,
  type ConditionConfigShard,
  type ConditionGroupPatch,
  type ConditionLeafPatch as TreeLeafPatch,
  type ConditionTreeRow,
} from "./condition-tree";

/**
 * 条件分支节点配置表单（计划 Task 16 薄片 A）：可视化条件树编辑器——递归
 * 分组树（且 / 或连接 + 整组取反 + 增删组 / 规则）+ 15 操作符叶子行，形态
 * 对齐归档 `LogicNodeConfigDrawer.tsx @ 485fa00` 的 ConditionGroupEditor
 * （React 递归组件 → Vue 扁平行渲染：condition-tree.ts 的 flattenConditionTree
 * 把树摊成带缩进深度的行序列，v-for 平铺、免模板递归）。
 *
 * 编辑语义（与引擎单一事实源对齐，flow-engine/src/condition-builder.ts）：
 *   - 组件内只编辑树（config.condition 落库形态，根恒为分组）；每次改动即
 *     上抛「落库树 + 编译产物 expression」分片——「编译为 expression」出口
 *     内建在变更里，挂载侧合并进节点 config 即完成保存链路；
 *   - 右值统一按文本编辑、就地类型收敛标注（数字 / 布尔 / null / 模板 /
 *     文本），落库与编译经引擎 parseRightValue 收敛（往返稳定）；
 *   - 一元操作符（为空 / 不为空 / 为真 / 为假）隐藏右值输入；其左值留空 =
 *     判断整个入参根；
 *   - 留白叶子（左右值均空且操作符仍为缺省 eq）不参与编译与校验；
 *   - 旧版手写表达式（既无 condition 也无规则行、expression 非空）顶部提示
 *     「改动后将被条件组覆盖」；未改动时组件不上抛（原表达式不被覆盖）。
 *
 * 校验：validateConditionTree 就地展示首条错误（左值必填、模板引用仅
 * input / var、纯文本正则可编译），保存门控由挂载侧经 defineExpose 的
 * validate() 或直接对 config 调用引擎校验承接。
 */

const props = defineProps<{
  /** 条件节点 config 分片（消费 condition / conditionRules / expression 三键）。 */
  modelValue: ConditionConfigShard;
  /** 可引用变量名（模板提示候选；透传 ExpressionInput）。 */
  variableNames?: ReadonlyArray<string>;
  /** 入参字段路径清单（模板提示候选；透传 ExpressionInput）。 */
  inputPaths?: ReadonlyArray<string>;
  /** 可引用节点清单（提示候选；条件沙箱仅支持 input / var，缺省空）。 */
  availableNodeIds?: ReadonlyArray<SuggestNodeOption>;
  /** 置灰全部编辑（运行期锁定等场景）。 */
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [shard: ConditionConfigShard] }>();

/* ------------------------------ 草稿树状态 ------------------------------ */

/** 草稿树（打开时解析一次：condition → conditionRules 迁移 → 空根组）。 */
const tree = ref<ConditionGroup>(resolveConditionDraft(props.modelValue));
/** 最近一次上抛的 condition 引用：emit 引发的 props 回流不重置草稿。 */
let lastEmittedCondition: unknown = props.modelValue.condition;
/** 条件树是否被用户改动过（旧版手写表达式的「未改动不覆盖」依据）。 */
const edited = ref(false);

watch(
  () => props.modelValue.condition,
  (condition) => {
    if (condition === lastEmittedCondition) return;
    lastEmittedCondition = condition;
    edited.value = false;
    tree.value = resolveConditionDraft(props.modelValue);
  },
);

/** 旧版手写表达式原文（仅提示与「未改动不覆盖」语义用，组件不编辑它）。 */
const legacyExpression =
  typeof props.modelValue.expression === "string" ? props.modelValue.expression : "";
const isLegacyHandwritten =
  (props.modelValue.condition === undefined || props.modelValue.condition === null) &&
  migrateConditionRules(props.modelValue.conditionRules) === null &&
  legacyExpression.trim() !== "";
const showLegacyNotice = computed(() => isLegacyHandwritten && !edited.value);

/** 变更出口：上抛「落库树 + 编译产物」分片（挂载侧合并进节点 config）。 */
function emitShard(): void {
  edited.value = true;
  const shard = buildConditionShard(tree.value);
  lastEmittedCondition = shard.condition;
  emit("update:modelValue", shard);
}

/* ------------------------------ 树编辑操作 ------------------------------ */

function addLeaf(path: ConditionPath): void {
  if (props.disabled) return;
  tree.value = appendLeaf(tree.value, path);
  emitShard();
}

function addGroup(path: ConditionPath): void {
  if (props.disabled) return;
  tree.value = appendGroup(tree.value, path);
  emitShard();
}

/** 删除分组（含其子项）：path 为该组定位路径，移除其在父组中的条目。 */
function removeGroup(path: ConditionPath): void {
  if (props.disabled || path.length === 0) return;
  const parent = path.slice(0, -1);
  tree.value = removeChildAt(tree.value, parent, path[path.length - 1]!);
  emitShard();
}

function removeLeaf(groupPath: ConditionPath, leafIndex: number): void {
  if (props.disabled) return;
  tree.value = removeChildAt(tree.value, groupPath, leafIndex);
  emitShard();
}

function patchLeaf(row: ConditionTreeRow & { kind: "leaf" }, patch: TreeLeafPatch): void {
  if (props.disabled) return;
  tree.value = updateLeafAt(tree.value, row.groupPath, row.leafIndex, patch);
  emitShard();
}

function patchGroup(path: ConditionPath, patch: ConditionGroupPatch): void {
  if (props.disabled) return;
  tree.value = updateGroupAt(tree.value, path, patch);
  emitShard();
}

/* ------------------------------ 派生视图 ------------------------------ */

/** 扁平行视图（组头 / 叶子行，带缩进深度与有效序号）。 */
const rows = computed(() => flattenConditionTree(tree.value));

/** 保存前校验首条错误（null = 合法）。 */
const validationError = computed(() => validateConditionTree(tree.value));

/** 只读摘要（组内 且 / 或 连接、嵌套加括号、非组前缀「非」）。 */
const summary = computed(() => describeConditionTree(tree.value));

function indentStyle(depth: number): { paddingLeft: string } {
  return { paddingLeft: `${depth * 16}px` };
}

function rightPlaceholder(operator: ConditionOperator): string {
  return operator === "matches"
    ? "正则源文本，如 ^ok$（支持 {{ }} 模板）"
    : "期望值（支持 {{ }} 模板与数字 / true / null 字面量）";
}

function onOpChange(row: ConditionTreeRow & { kind: "leaf" }, event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  patchLeaf(row, { operator: value as ConditionOperator });
}

function onGroupOpChange(row: ConditionTreeRow & { kind: "group" }, event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  patchGroup(row.path, { op: value === "or" ? "or" : "and" });
}

function onGroupNotChange(row: ConditionTreeRow & { kind: "group" }, event: Event): void {
  patchGroup(row.path, { not: (event.target as HTMLInputElement).checked ? true : undefined });
}

defineExpose({
  /** 保存门控：条件树保存前校验（合法返回 null，非法返回错误文案）。 */
  validate: (): string | null => validateConditionTree(tree.value),
  /** 只读摘要（节点卡回显复用）。 */
  describe: (): string => describeConditionTree(tree.value),
});
</script>

<template>
  <div class="cb-root">
    <div v-if="showLegacyNotice" class="cb-notice" role="note">
      检测到旧版手写条件表达式（本工具不再提供代码编辑）。新增或修改条件并保存后，将以条件组覆盖原表达式；未改动条件时保存不会覆盖。
    </div>

    <template v-for="row in rows" :key="row.key">
      <div v-if="row.kind === 'group'" class="cb-group" :style="indentStyle(row.depth)">
        <div class="cb-group-head">
          <select
            class="select cb-op"
            :value="row.op"
            :aria-label="row.isRoot ? '条件组的连接方式' : '分组的连接方式'"
            :disabled="disabled"
            @change="onGroupOpChange(row, $event)"
          >
            <option value="and">全部满足（且）</option>
            <option value="or">任一满足（或）</option>
          </select>
          <label class="cb-not">
            <input
              type="checkbox"
              :checked="row.not"
              aria-label="该分组整体取反"
              :disabled="disabled"
              @change="onGroupNotChange(row, $event)"
            />
            取反（非）
          </label>
          <span class="cb-group-actions">
            <button class="btn icon cb-mini" :disabled="disabled" @click="addLeaf(row.path)">
              + 条件
            </button>
            <button
              class="btn icon cb-mini"
              :disabled="disabled"
              title="嵌套分组：用于「A 且（B 或 C）」这类复合条件"
              @click="addGroup(row.path)"
            >
              + 分组
            </button>
            <button
              v-if="!row.isRoot"
              class="btn icon cb-remove"
              :disabled="disabled"
              aria-label="删除该分组"
              title="删除该分组（含其子项）"
              @click="removeGroup(row.path)"
            >
              ✕
            </button>
          </span>
        </div>
        <p v-if="row.childCount === 0" class="cb-hint">
          {{ row.isRoot ? "暂无子项：不配置条件时恒走假分支。" : "空分组不参与判定。" }}
        </p>
      </div>
      <div v-else class="cb-leaf" :style="indentStyle(row.depth)">
        <ExpressionInput
          class="cb-left"
          :model-value="row.leaf.left"
          :placeholder="'{{ status }} 或 {{ var.token }}'"
          :available-node-ids="availableNodeIds ?? []"
          :variable-names="variableNames"
          :input-paths="inputPaths"
          :aria-label="`条件 ${row.position} 左值`"
          @update:model-value="patchLeaf(row, { left: $event })"
        />
        <select
          class="select cb-op"
          :value="row.leaf.operator"
          :aria-label="`条件 ${row.position} 操作符`"
          :disabled="disabled"
          @change="onOpChange(row, $event)"
        >
          <option v-for="meta in CONDITION_OPERATORS" :key="meta.value" :value="meta.value">
            {{ meta.label }}
          </option>
        </select>
        <template v-if="operatorNeedsRight(row.leaf.operator)">
          <ExpressionInput
            class="cb-right"
            :model-value="conditionRightText(row.leaf)"
            :placeholder="rightPlaceholder(row.leaf.operator)"
            :available-node-ids="availableNodeIds ?? []"
            :variable-names="variableNames"
            :input-paths="inputPaths"
            :aria-label="`条件 ${row.position} 右值`"
            @update:model-value="patchLeaf(row, { right: $event })"
          />
          <span
            v-if="describeConditionRightType(conditionRightText(row.leaf))"
            class="badge cb-type"
          >
            {{ describeConditionRightType(conditionRightText(row.leaf)) }}
          </span>
        </template>
        <button
          class="btn icon cb-remove"
          :disabled="disabled"
          :aria-label="`删除条件 ${row.position}`"
          title="删除该条件"
          @click="removeLeaf(row.groupPath, row.leafIndex)"
        >
          ✕
        </button>
      </div>
    </template>

    <div class="cb-summary">
      <span class="text-faint">摘要：</span>
      <span :class="summary === '' ? 'text-faint' : 'text-secondary'">
        {{ summary === "" ? "未配置条件（恒走假分支）" : summary }}
      </span>
    </div>
    <div v-if="validationError" class="cb-error" role="alert">{{ validationError }}</div>
  </div>
</template>

<style scoped>
.cb-root {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.cb-notice {
  border: 1px solid var(--warning);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  padding: 6px 8px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.cb-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-left: 2px solid var(--border-strong);
  padding-left: 8px;
  min-width: 0;
}

.cb-group-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.cb-group-actions {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.cb-mini {
  padding: 2px 6px;
  font-size: 11px;
}

.cb-not {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
}

.cb-leaf {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.cb-left,
.cb-right {
  flex: 1 1 140px;
  min-width: 0;
}

.cb-right {
  flex-basis: 120px;
}

.cb-op {
  flex: none;
  font-size: 11px;
  padding: 3px 4px;
}

.cb-type {
  flex: none;
}

.cb-remove {
  flex: none;
  font-size: 11px;
}

.cb-hint,
.cb-summary {
  font-size: 11px;
  line-height: 1.6;
}

.cb-error {
  font-size: 11px;
  color: var(--danger);
}
</style>
