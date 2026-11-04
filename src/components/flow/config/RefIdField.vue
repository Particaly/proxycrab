<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Io5Refresh } from "vue-icons-plus/io5";
import { generateRefId, validateRefIdDraft } from "./node-config";

/**
 * 节点引用短码编辑（计划 Task 14 Step 4）：`{{ node.<短码>.path }}` 模板引用
 * 的解析键——5 位纯字母、流程内唯一（takenKeys 为全部节点 id + 既有短码，
 * 与原值相等的草稿视作未修改）。空草稿 = 无短码（读取侧回退节点 id，合法）。
 * 校验错误就地展示；非法草稿不上抛（保持最近合法值）。
 */
const props = defineProps<{
  /** 当前短码（null = 无）。 */
  refId: string | null;
  /** 流程内已占用键集合（含自身原值）。 */
  takenKeys: ReadonlySet<string>;
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:refId": [refId: string | null] }>();

const draft = ref(props.refId ?? "");

watch(
  () => props.refId,
  (value) => {
    draft.value = value ?? "";
  },
);

const error = computed(() =>
  validateRefIdDraft(draft.value, props.refId ?? undefined, props.takenKeys),
);

watch(draft, (value) => {
  if (props.disabled) return;
  if (error.value !== null) return; // 非法草稿不上抛，就地提示
  const next = value.trim() === "" ? null : value;
  if (next !== props.refId) emit("update:refId", next);
});

/** 重摇一个流程内未占用的短码。 */
function regenerate(): void {
  if (props.disabled) return;
  const exclude = new Set(props.takenKeys);
  if (props.refId) exclude.delete(props.refId);
  draft.value = generateRefId(exclude);
}
</script>

<template>
  <span
    class="rf-root"
    :title="
      error ?? '引用短码：模板引用 {{ node.<短码>.path }} 的解析键（5 位字母，流程内唯一，可改）'
    "
  >
    <input
      v-model="draft"
      class="input mono rf-input"
      :class="{ invalid: error !== null }"
      aria-label="节点引用短码（5 位字母，流程内唯一）"
      :aria-invalid="error !== null"
      placeholder="—"
      maxlength="5"
      spellcheck="false"
      :disabled="disabled"
      @keydown.enter.prevent
    />
    <button
      class="btn icon"
      title="重摇短码（避开流程内已占用键）"
      aria-label="重摇引用短码"
      :disabled="disabled"
      @click="regenerate"
    >
      <Io5Refresh :size="12" />
    </button>
    <span v-if="error !== null" class="rf-error" role="alert">{{ error }}</span>
  </span>
</template>

<style scoped>
.rf-root {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.rf-input {
  width: 72px;
  padding: 2px 6px;
  font-size: 11px;
  text-align: center;
}

.rf-input.invalid {
  border-color: var(--danger);
}

.rf-error {
  font-size: 11px;
  color: var(--danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
