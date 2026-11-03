<script setup lang="ts">
/**
 * 流程 pre/post 脚本编辑器（计划 Task 18）。
 *
 * 复用 MonacoEditor：前置/后置脚本的编辑、上下文提示（pre：input → 覆盖对象；
 * post：response → 返回出参；另有 env 形参说明）、骨架插入与样例试跑。
 * 试跑走 Backend 能力位 `flowScriptDryRun`（服务端一次性 flow VM + 引擎载荷，
 * 错误分类 syntax|blocked|runtime|timeout|invalid-return 完整透出为中文文案）；
 * 能力位未实现时试跑区域整体不展示（能力位显隐约定）。
 */
import { computed, ref, watch } from "vue";
import type { FlowScriptDryRunResult, FlowScriptSide } from "../../../api/types";
import { useBackend } from "../../../api";
import MonacoEditor from "../../MonacoEditor.vue";
import {
  DEFAULT_SAMPLE_JSON,
  ENV_PARAM_HINT,
  SCRIPT_DOC,
  SCRIPT_SKELETON,
  errorKindLabel,
  runScriptDryRun,
  stringifyDryRunValue,
  toErrorMessage,
} from "../dry-run";

const props = withDefaults(
  defineProps<{
    /** 脚本模式：pre = 前置处理（请求前），post = 后置处理（响应后） */
    side: FlowScriptSide;
    /** 脚本文本（函数体，用 return 返回结果） */
    modelValue: string;
    /** 置灰编辑器与全部操作（运行期锁定等场景） */
    disabled?: boolean;
    /** Monaco 编辑区高度（含骨架行内的弹性布局），默认 14em */
    editorHeight?: string;
  }>(),
  { disabled: false, editorHeight: "14em" },
);

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const backend = useBackend();
/** 能力位：后端未实现试跑 API 时，编辑器不展示试跑区域与入口 */
const canDryRun = computed(() => typeof backend.flowScriptDryRun === "function");

const doc = computed(() => SCRIPT_DOC[props.side]);
const paramHint = computed(
  () => `${doc.value.paramName}：${doc.value.paramDescription}；${doc.value.returnDescription}`,
);

const sampleText = ref(DEFAULT_SAMPLE_JSON[props.side]);
const running = ref(false);
const result = ref<FlowScriptDryRunResult | null>(null);
const runError = ref<string | null>(null);

// 切换侧别即切换文档口径与样例默认值（试跑结果一并清空，避免跨口径误读）。
watch(
  () => props.side,
  (side) => {
    sampleText.value = DEFAULT_SAMPLE_JSON[side];
    result.value = null;
    runError.value = null;
  },
);

function onInput(value: string): void {
  emit("update:modelValue", value);
}

/** 用骨架替换当前脚本内容（Monaco 撤销可恢复）。 */
function insertSkeleton(): void {
  if (props.disabled) return;
  emit("update:modelValue", SCRIPT_SKELETON[props.side]);
}

async function runDryRun(): Promise<void> {
  if (props.disabled || running.value || !canDryRun.value) return;
  running.value = true;
  result.value = null;
  runError.value = null;
  try {
    result.value = await runScriptDryRun(backend, {
      side: props.side,
      script: props.modelValue,
      sampleJson: sampleText.value,
    });
  } catch (error) {
    runError.value = toErrorMessage(error);
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <div class="fse-root">
    <div class="fse-toolbar">
      <span class="fse-badge" :class="side">{{ doc.badge }}</span>
      <span class="fse-param mono" :title="doc.paramDescription">{{ doc.paramName }}</span>
      <span class="fse-hint text-faint" :title="paramHint">{{ paramHint }}</span>
      <span class="fse-spacer" />
      <button
        class="btn compact"
        :disabled="disabled"
        title="替换为该侧别的骨架脚本（Monaco 撤销可恢复）"
        @click="insertSkeleton"
      >
        插入骨架
      </button>
    </div>
    <div class="fse-hint text-faint" :title="ENV_PARAM_HINT">{{ ENV_PARAM_HINT }}</div>
    <div class="fse-editor" :style="{ height: editorHeight }">
      <MonacoEditor
        :model-value="modelValue"
        language="javascript"
        :readonly="disabled"
        @update:model-value="onInput"
      />
    </div>
    <div v-if="canDryRun" class="fse-dryrun">
      <div class="fse-dryrun-bar">
        <span class="text-faint">{{ doc.paramName }} 样例 JSON</span>
        <input
          v-model="sampleText"
          class="input mono fse-sample"
          spellcheck="false"
          :disabled="disabled || running"
          :placeholder="doc.paramName + ' 的样例 JSON'"
          @keyup.enter="runDryRun"
        />
        <button
          class="btn primary compact"
          :disabled="disabled || running"
          title="以样例数据在服务端试跑脚本（不落库不广播）"
          @click="runDryRun"
        >
          {{ running ? "试跑中…" : "试跑" }}
        </button>
      </div>
      <div v-if="runError" class="fse-result error mono">{{ runError }}</div>
      <template v-else-if="result">
        <div v-if="!result.ok && result.error" class="fse-result error">
          <span class="fse-kind mono">{{ errorKindLabel(result.error.kind) }}</span>
          <span class="fse-message">{{ result.error.message }}</span>
        </div>
        <template v-else-if="result.ok">
          <div v-if="result.warnings.length" class="fse-warnings">
            <span v-for="warning in result.warnings" :key="warning" class="fse-warning mono">{{
              warning
            }}</span>
          </div>
          <pre class="fse-result mono">{{ stringifyDryRunValue(result.value) }}</pre>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.fse-root {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.fse-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.fse-badge {
  flex: none;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  background: var(--bg-soft, rgba(127, 127, 127, 0.16));
}

.fse-badge.pre {
  color: var(--accent, #2f6fed);
}

.fse-badge.post {
  color: var(--ok, #2e9e5b);
}

.fse-param {
  flex: none;
  font-weight: 600;
}

.fse-hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

.fse-spacer {
  flex: 1;
}

.fse-editor {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
  border-radius: 4px;
  overflow: hidden;
}

.fse-dryrun {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.fse-dryrun-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.fse-sample {
  flex: 1;
  min-width: 0;
}

.fse-result {
  margin: 0;
  padding: 4px 6px;
  border-radius: 4px;
  background: var(--bg-soft, rgba(127, 127, 127, 0.12));
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 9em;
  overflow: auto;
}

.fse-result.error {
  background: var(--danger-soft, rgba(220, 76, 76, 0.14));
  color: var(--danger, #c0392b);
}

.fse-kind {
  flex: none;
  margin-right: 6px;
  padding: 0 4px;
  border-radius: 3px;
  font-weight: 600;
}

.fse-result.error .fse-kind {
  background: var(--danger, #c0392b);
  color: #fff;
}

.fse-message {
  overflow-wrap: anywhere;
}

.fse-warnings {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  color: var(--warning, #a06a00);
}

.fse-warning {
  overflow-wrap: anywhere;
}
</style>
