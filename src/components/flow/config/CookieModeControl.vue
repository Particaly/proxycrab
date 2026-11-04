<script setup lang="ts">
import { computed, ref, watch } from "vue";

/**
 * Cookie 携带方式控件（计划 Task 14 Step 3）：「快照 / 自定义」二态——快照 =
 * 回放引用快照捕获的 Cookie（配置键缺省，不落字段），自定义 = 注入
 * cookieValue 指定值（支持模板，经网络层注入）。落库只在显式选「自定义」且
 * 值非空时落 cookieMode:'custom' + cookieValue；选自定义但值为空给出行内提示
 * 且不落库。历史 'browser' 等未知档位由读取侧按快照归一（model.rs 语义）。
 */
const props = defineProps<{
  /** 当前携带方式：snapshot = 快照缺省；custom = 自定义值。 */
  mode: "snapshot" | "custom";
  /** 自定义值草稿（mode = custom 时生效）。 */
  value: string;
  /** 引用快照捕获的 Cookie 值（null = 无引用或快照未捕获）。 */
  capturedValue: string | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:mode": [mode: "snapshot" | "custom"];
  "update:value": [value: string];
}>();

// 自定义值的本地草稿：切档保留最近编辑值（与请求头自定义档同语义）；
// 值变化原样上抛（空值由落库侧丢弃，提示「留空不落库」）。
const draft = ref(props.value);
watch(
  () => [props.value, props.mode] as const,
  ([value, mode]) => {
    draft.value = mode === "custom" ? value : "";
  },
);

watch(draft, (value) => {
  if (props.disabled) return;
  if (value !== props.value) emit("update:value", value);
});

const emptyCustom = computed(() => props.mode === "custom" && draft.value.trim() === "");

function choose(mode: "snapshot" | "custom"): void {
  if (props.disabled || mode === props.mode) return;
  emit("update:mode", mode);
}
</script>

<template>
  <div class="cm-row">
    <span class="cm-label mono">Cookie</span>
    <span class="cm-modes" role="radiogroup" aria-label="Cookie 携带方式">
      <button
        class="cm-mode"
        :class="{ active: mode === 'snapshot' }"
        role="radio"
        :aria-checked="mode === 'snapshot'"
        :disabled="disabled"
        title="回放引用快照捕获的 Cookie（缺省）"
        @click="choose('snapshot')"
      >
        快照
      </button>
      <button
        class="cm-mode"
        :class="{ active: mode === 'custom' }"
        role="radio"
        :aria-checked="mode === 'custom'"
        :disabled="disabled"
        title="注入自定义 Cookie 值（支持模板）"
        @click="choose('custom')"
      >
        自定义
      </button>
    </span>
    <span
      v-if="mode === 'snapshot' && capturedValue !== null"
      class="cm-captured mono text-faint"
      :title="capturedValue"
      >{{ capturedValue }}</span
    >
    <span v-else-if="mode === 'snapshot'" class="cm-captured text-faint">快照未捕获</span>
  </div>
  <textarea
    v-if="mode === 'custom'"
    v-model="draft"
    class="input mono cm-value"
    rows="2"
    placeholder="Cookie 自定义值，如 token=abc; sid=xyz（支持模板）"
    :disabled="disabled"
    spellcheck="false"
    aria-label="Cookie 自定义值"
  />
  <div v-if="emptyCustom" class="cm-hint">自定义值不能为空（留空不落库）</div>
</template>

<style scoped>
.cm-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.cm-label {
  flex: none;
  width: 76px;
  font-size: 11px;
}

.cm-modes {
  flex: none;
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.cm-mode {
  padding: 1px 7px;
  border: none;
  background: var(--bg-panel);
  color: var(--text-secondary);
  font: inherit;
  font-size: 11px;
  line-height: 17px;
  cursor: pointer;
}
.cm-mode + .cm-mode {
  border-left: 1px solid var(--border);
}
.cm-mode.active {
  background: var(--bg-selected);
  color: var(--accent);
}
.cm-mode:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cm-captured {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

.cm-value {
  width: 100%;
  padding: 4px 6px;
  font-size: 11px;
  resize: vertical;
  min-height: 0;
}

.cm-hint {
  font-size: 11px;
  color: var(--warning);
}
</style>
