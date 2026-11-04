<script setup lang="ts">
import { ref, watch } from "vue";
import { parseRetryInput, type ReplayRetry } from "./node-config";

/**
 * 重试退避编辑（计划 Task 14 Step 4）：`retry{maxAttempts,backoffMs,multiplier}`。
 * 开关关闭 / 输入非法时不落 retry 字段（全节点可选；数值上限由执行侧收敛）。
 * multiplier 缺省由执行侧取 2（留空 = 不落键）。
 */
const props = defineProps<{
  /** 当前重试配置（null = 未配置）。 */
  retry: ReplayRetry | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:retry": [retry: ReplayRetry | null] }>();

// 输入草稿（空串 = 未填）；开启开关时用缺省值预填（乘数留空 = 执行侧默认 2）。
const enabled = ref(props.retry !== null);
const maxAttempts = ref(props.retry ? String(props.retry.maxAttempts) : "");
const backoffMs = ref(props.retry ? String(props.retry.backoffMs) : "");
const multiplier = ref(props.retry?.multiplier !== undefined ? String(props.retry.multiplier) : "");
const parseError = ref<string | null>(null);
/** 最近一次上抛值：emit 引发的 props 回流不重置输入草稿（外部改动才重置）。 */
let lastEmitted: ReplayRetry | null = props.retry;

watch(
  () => props.retry,
  (retry) => {
    if (retry === lastEmitted) return;
    lastEmitted = retry;
    enabled.value = retry !== null;
    maxAttempts.value = retry ? String(retry.maxAttempts) : "";
    backoffMs.value = retry ? String(retry.backoffMs) : "";
    multiplier.value = retry?.multiplier !== undefined ? String(retry.multiplier) : "";
  },
);

watch([enabled, maxAttempts, backoffMs, multiplier], () => {
  if (props.disabled) return;
  if (!enabled.value) {
    if (props.retry !== null) {
      lastEmitted = null;
      emit("update:retry", null);
    }
    return;
  }
  const { retry, error } = parseRetryInput(maxAttempts.value, backoffMs.value, multiplier.value);
  parseError.value = error ?? null;
  // 输入非法时先摘除 retry（保存只落合法状态），错误就地提示。
  const next = retry ?? null;
  if (JSON.stringify(next) !== JSON.stringify(props.retry)) {
    lastEmitted = next;
    emit("update:retry", next);
  }
});

function toggle(on: boolean): void {
  if (props.disabled) return;
  enabled.value = on;
  if (on && maxAttempts.value === "" && backoffMs.value === "") {
    maxAttempts.value = "2";
    backoffMs.value = "500";
  }
}
</script>

<template>
  <div class="rt-root">
    <div class="rt-head">
      <span class="rt-title">重试退避</span>
      <button
        class="switch"
        :class="{ on: enabled }"
        role="switch"
        :aria-checked="enabled"
        aria-label="启用重试退避"
        :disabled="disabled"
        @click="toggle(!enabled)"
      />
    </div>
    <template v-if="enabled">
      <div class="rt-fields">
        <label class="rt-field">
          <span>尝试次数</span>
          <input
            v-model="maxAttempts"
            class="input mono"
            inputmode="numeric"
            placeholder="2"
            :disabled="disabled"
            spellcheck="false"
          />
        </label>
        <label class="rt-field">
          <span>退避（毫秒）</span>
          <input
            v-model="backoffMs"
            class="input mono"
            inputmode="numeric"
            placeholder="500"
            :disabled="disabled"
            spellcheck="false"
          />
        </label>
        <label class="rt-field">
          <span>乘数</span>
          <input
            v-model="multiplier"
            class="input mono"
            inputmode="decimal"
            placeholder="2（缺省）"
            :disabled="disabled"
            spellcheck="false"
          />
        </label>
      </div>
      <div v-if="parseError" class="rt-hint">{{ parseError }}</div>
      <div v-else class="rt-hint text-faint">失败后按 退避 × 乘数^(尝试序-1) 等待后重试</div>
    </template>
  </div>
</template>

<style scoped>
.rt-root {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.rt-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.rt-title {
  font-size: 11px;
  color: var(--text-faint);
  flex: 1;
}

.rt-fields {
  display: grid;
  grid-template-columns: 1fr 1.2fr 1fr;
  gap: var(--space-1);
}

.rt-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.rt-field span {
  font-size: 10px;
  color: var(--text-faint);
}

.rt-field .input {
  width: 100%;
  padding: 3px 6px;
  font-size: 11px;
}

.rt-hint {
  font-size: 11px;
  color: var(--warning);
}
</style>
