<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { HeaderFidelitySource } from "./node-config";

/**
 * header 保真单项控件（计划 Task 14 Step 3）：Origin / Referer / User-Agent
 * 每项「捕获值 / 自定义」二态——捕获值 = 回放快照捕获值（配置键缺省，不落
 * 字段），自定义 = 手动指定值（支持模板）。落库只含自定义项；选了自定义但
 * 值为空时给出行内提示且不落库（值非空才上抛）。
 */
const props = defineProps<{
  /** 头名展示（Origin / Referer / User-Agent）。 */
  label: string;
  /** 当前取值来源。 */
  source: HeaderFidelitySource;
  /** 自定义值草稿（source = static 时生效）。 */
  value: string;
  /** 引用快照的捕获值（null = 无引用或快照未捕获该头）。 */
  capturedValue: string | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:source": [source: HeaderFidelitySource];
  "update:value": [value: string];
}>();

// 自定义值输入的本地草稿：值变化原样上抛（空值由 staticFidelityOnly 落库侧
// 丢弃，提示「留空不落库」）。
const draft = ref(props.value);
watch(
  () => [props.value, props.source] as const,
  ([value, source]) => {
    draft.value = source === "static" ? value : "";
  },
);

watch(draft, (value) => {
  if (props.disabled) return;
  if (value !== props.value) emit("update:value", value);
});

const emptyCustom = computed(() => props.source === "static" && draft.value.trim() === "");

function choose(source: HeaderFidelitySource): void {
  if (props.disabled || source === props.source) return;
  emit("update:source", source);
}
</script>

<template>
  <div class="fm-row">
    <span class="fm-label mono" :title="`请求头 ${label}`">{{ label }}</span>
    <span class="fm-modes" role="radiogroup" :aria-label="`${label} 取值方式`">
      <button
        class="fm-mode"
        :class="{ active: source === 'fromCapture' }"
        role="radio"
        :aria-checked="source === 'fromCapture'"
        :disabled="disabled"
        title="回放引用快照捕获的值（缺省）"
        @click="choose('fromCapture')"
      >
        捕获值
      </button>
      <button
        class="fm-mode"
        :class="{ active: source === 'static' }"
        role="radio"
        :aria-checked="source === 'static'"
        :disabled="disabled"
        title="手动指定注入值（支持模板）"
        @click="choose('static')"
      >
        自定义
      </button>
    </span>
    <input
      v-if="source === 'static'"
      v-model="draft"
      class="input mono fm-value"
      :placeholder="`${label} 的自定义值`"
      :disabled="disabled"
      spellcheck="false"
      aria-label="自定义值"
    />
    <span
      v-else-if="capturedValue !== null"
      class="fm-captured mono text-faint"
      :title="capturedValue"
      >{{ capturedValue }}</span
    >
    <span v-else class="fm-captured text-faint">快照未捕获</span>
  </div>
  <div v-if="emptyCustom" class="fm-hint">自定义值不能为空（留空不落库）</div>
</template>

<style scoped>
.fm-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.fm-label {
  flex: none;
  width: 76px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

.fm-modes {
  flex: none;
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.fm-mode {
  padding: 1px 7px;
  border: none;
  background: var(--bg-panel);
  color: var(--text-secondary);
  font: inherit;
  font-size: 11px;
  line-height: 17px;
  cursor: pointer;
}
.fm-mode + .fm-mode {
  border-left: 1px solid var(--border);
}
.fm-mode.active {
  background: var(--bg-selected);
  color: var(--accent);
}
.fm-mode:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.fm-value {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  font-size: 11px;
}

.fm-captured {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

.fm-hint {
  font-size: 11px;
  color: var(--warning);
}
</style>
