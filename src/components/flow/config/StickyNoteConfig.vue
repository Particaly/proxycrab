<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  STICKY_NOTE_COLORS,
  STICKY_NOTE_DEFAULT_SIZE,
  STICKY_NOTE_MAX_SIZE,
  STICKY_NOTE_MIN_SIZE,
  buildStickyNoteShard,
  parseStickySizeInput,
  resolveStickyNoteColorToken,
  resolveStickyNoteSize,
  validateStickyNoteDraft,
  type StickyNoteConfigShard,
} from "./sticky-note-config";

/**
 * 便签节点（stickyNote）配置表单（计划 Task 16 薄片 A）：正文 / 预设配色
 * （6 色板）/ 卡片尺寸。形态对齐归档 `sticky-note-palette.ts @ 485fa00` 的
 * 色板与尺寸边界（token 名、默认 200×120、区间 140×80 ~ 480×400 逐字沿用）。
 * 便签不入执行拓扑，配置仅影响画布展示。
 *
 * 交互：编辑即改即生效（上抛 { text, color, size } 分片，挂载侧合并进节点
 * config）；正文空白不落 text；尺寸留空维度取缺省值、越界就地报错，门控经
 * defineExpose 的 validate()。
 */

const props = defineProps<{
  /** 便签节点 config 分片（消费 text / color / size 三键）。 */
  modelValue: StickyNoteConfigShard;
  /** 置灰全部编辑（运行期锁定等场景）。 */
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [shard: StickyNoteConfigShard] }>();

/* ------------------------------ 输入草稿状态 ------------------------------ */

const text = ref(typeof props.modelValue.text === "string" ? props.modelValue.text : "");
const color = ref(resolveStickyNoteColorToken(props.modelValue.color));
const resolvedSize = resolveStickyNoteSize(props.modelValue.size);
const widthText = ref(String(resolvedSize.width));
const heightText = ref(String(resolvedSize.height));

/** 最近一次上抛分片：emit 引发的 props 回流（值等价）不重置输入草稿。 */
let lastEmitted: StickyNoteConfigShard | null = null;

/** 分片值等价比较（三键逐一对齐；size 按收敛后的宽高比较）。 */
function sameShard(a: StickyNoteConfigShard, b: StickyNoteConfigShard): boolean {
  const sizeA = resolveStickyNoteSize(a.size);
  const sizeB = resolveStickyNoteSize(b.size);
  return (
    a.text === b.text &&
    resolveStickyNoteColorToken(a.color) === resolveStickyNoteColorToken(b.color) &&
    sizeA.width === sizeB.width &&
    sizeA.height === sizeB.height
  );
}

watch(
  () => props.modelValue,
  (config) => {
    if (lastEmitted !== null && sameShard(config, lastEmitted)) return;
    text.value = typeof config.text === "string" ? config.text : "";
    color.value = resolveStickyNoteColorToken(config.color);
    const size = resolveStickyNoteSize(config.size);
    widthText.value = String(size.width);
    heightText.value = String(size.height);
  },
);

/* ------------------------------ 派生视图与变更出口 ------------------------------ */

const widthError = computed(
  () =>
    parseStickySizeInput(
      widthText.value,
      STICKY_NOTE_MIN_SIZE.width,
      STICKY_NOTE_MAX_SIZE.width,
      STICKY_NOTE_DEFAULT_SIZE.width,
    ).error ?? null,
);
const heightError = computed(
  () =>
    parseStickySizeInput(
      heightText.value,
      STICKY_NOTE_MIN_SIZE.height,
      STICKY_NOTE_MAX_SIZE.height,
      STICKY_NOTE_DEFAULT_SIZE.height,
    ).error ?? null,
);
const validationError = computed(() => widthError.value ?? heightError.value);

function emitShard(): void {
  const shard = buildStickyNoteShard({
    text: text.value,
    color: color.value,
    widthText: widthText.value,
    heightText: heightText.value,
  });
  lastEmitted = shard;
  emit("update:modelValue", shard);
}

watch([text, color, widthText, heightText], () => {
  if (props.disabled) return;
  emitShard();
});

defineExpose({
  /** 保存门控：尺寸校验（合法返回 null，非法返回首条错误文案）。 */
  validate: (): string | null =>
    validateStickyNoteDraft({ widthText: widthText.value, heightText: heightText.value }),
});
</script>

<template>
  <div class="sn-root">
    <label class="sn-field">
      <span>正文</span>
      <textarea
        v-model="text"
        class="input sn-text"
        rows="4"
        placeholder="画布注释卡，支持换行（不参与执行）"
        spellcheck="false"
        :disabled="disabled"
      />
    </label>

    <div class="sn-field">
      <span>配色</span>
      <div class="sn-colors" role="radiogroup" aria-label="便签配色">
        <button
          v-for="option in STICKY_NOTE_COLORS"
          :key="option.token"
          class="btn icon sn-swatch"
          role="radio"
          :aria-checked="color === option.token"
          :title="option.label"
          :aria-label="`配色：${option.label}`"
          :disabled="disabled"
          @click="color = option.token"
        >
          <span class="sn-dot" :style="{ background: option.hex }" />
        </button>
      </div>
    </div>

    <div class="sn-sizes">
      <label class="sn-field">
        <span>宽度（像素）</span>
        <input
          v-model="widthText"
          class="input mono"
          inputmode="numeric"
          :placeholder="String(STICKY_NOTE_DEFAULT_SIZE.width)"
          spellcheck="false"
          :disabled="disabled"
        />
      </label>
      <label class="sn-field">
        <span>高度（像素）</span>
        <input
          v-model="heightText"
          class="input mono"
          inputmode="numeric"
          :placeholder="String(STICKY_NOTE_DEFAULT_SIZE.height)"
          spellcheck="false"
          :disabled="disabled"
        />
      </label>
    </div>
    <div v-if="validationError" class="sn-error" role="alert">{{ validationError }}</div>
    <div v-else class="sn-hint text-faint">
      尺寸区间：宽 {{ STICKY_NOTE_MIN_SIZE.width }}~{{ STICKY_NOTE_MAX_SIZE.width }}、高
      {{ STICKY_NOTE_MIN_SIZE.height }}~{{ STICKY_NOTE_MAX_SIZE.height }} 像素；留空取缺省。
    </div>
  </div>
</template>

<style scoped>
.sn-root {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.sn-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.sn-field > span {
  font-size: 10px;
  color: var(--text-faint);
}

.sn-field .input {
  width: 100%;
  padding: 3px 6px;
  font-size: 11px;
}

.sn-text {
  resize: vertical;
}

.sn-colors {
  display: flex;
  gap: 2px;
}

.sn-swatch {
  padding: 3px 5px;
}

.sn-swatch[aria-checked="true"] {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.sn-dot {
  display: block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.sn-sizes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}

.sn-hint {
  font-size: 11px;
  line-height: 1.6;
}

.sn-error {
  font-size: 11px;
  color: var(--danger);
}
</style>
