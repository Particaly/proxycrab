<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { MAX_DELAY_DURATION_MS } from "../../../../flow-engine/src/logic-nodes";
import { buildDelayShard, parseDelayDuration, type DelayConfigShard } from "./delay-config";

/**
 * 延时节点（delay）配置表单（计划 Task 16 薄片 A）：等待时长（毫秒）单字段。
 * 形态对齐归档 `LogicNodeConfigDrawer.tsx @ 485fa00` 的 delay 分节（文案与
 * 上限提示逐字沿用）。
 *
 * 交互：编辑即改即生效（上抛 { durationMs } 分片，挂载侧合并进节点 config）；
 * 留空 = 0（不等待）；超上限（300000ms = 5 分钟）就地报错且不落库，保存由
 * 挂载侧经 defineExpose 的 validate() 门控。
 */

const props = defineProps<{
  /** 延时节点 config 分片（消费 durationMs 一键）。 */
  modelValue: DelayConfigShard;
  /** 置灰全部编辑（运行期锁定等场景）。 */
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [shard: DelayConfigShard] }>();

/* ------------------------------ 输入草稿状态 ------------------------------ */

const durationText = ref(
  props.modelValue.durationMs === undefined ? "" : String(props.modelValue.durationMs),
);

/** 最近一次上抛分片：emit 引发的 props 回流（值等价）不重置输入草稿。 */
let lastEmitted: DelayConfigShard | null = null;

watch(
  () => props.modelValue,
  (config) => {
    if (
      lastEmitted !== null &&
      (config.durationMs ?? undefined) === (lastEmitted.durationMs ?? undefined)
    ) {
      return;
    }
    durationText.value = config.durationMs === undefined ? "" : String(config.durationMs);
  },
);

/* ------------------------------ 派生视图与变更出口 ------------------------------ */

const durationError = computed(() => parseDelayDuration(durationText.value).error ?? null);

watch(durationText, () => {
  if (props.disabled) return;
  const shard = buildDelayShard(durationText.value);
  lastEmitted = shard;
  emit("update:modelValue", shard);
});

defineExpose({
  /** 保存门控：等待时长校验（合法返回 null，非法返回错误文案）。 */
  validate: (): string | null => parseDelayDuration(durationText.value).error ?? null,
});
</script>

<template>
  <div class="dl-root">
    <label class="dl-field">
      <span>等待时长（毫秒）</span>
      <input
        v-model="durationText"
        class="input mono"
        inputmode="numeric"
        placeholder="0"
        spellcheck="false"
        :disabled="disabled"
      />
    </label>
    <div v-if="durationError" class="dl-error" role="alert">{{ durationError }}</div>
    <div v-else class="dl-hint text-faint">
      等待期间可取消；上限 {{ MAX_DELAY_DURATION_MS }}ms（5 分钟），超出保存时即提示。
    </div>
  </div>
</template>

<style scoped>
.dl-root {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.dl-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.dl-field > span {
  font-size: 10px;
  color: var(--text-faint);
}

.dl-field .input {
  width: 100%;
  padding: 3px 6px;
  font-size: 11px;
}

.dl-hint {
  font-size: 11px;
  line-height: 1.6;
}

.dl-error {
  font-size: 11px;
  color: var(--danger);
}
</style>
