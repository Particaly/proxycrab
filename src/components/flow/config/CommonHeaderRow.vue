<script setup lang="ts">
import { ref, watch } from "vue";
import { Io5EllipsisHorizontal } from "vue-icons-plus/io5";
import { FAKE_GENERATOR_NAMES } from "../../../../flow-engine/src/fake";
import { openDropdownMenu } from "../../../stores/dialog";
import ExpressionInput from "../../expression-input/ExpressionInput.vue";
import type { SuggestNodeOption } from "../../expression-input/expression-suggest";
import type { TemplateSampleContext } from "../../expression-input/use-expression-preview";
import { hasIoPathPayload, readIoPathPayload } from "../template-dnd";

/**
 * 请求头区常见头固定行（User-Agent / Origin / Referer / Cookie）：与其他
 * 请求头行统一的行式展示——占位拖拽列 + 固定头名 + 值列表达式输入 +
 * 行内菜单，无「捕获值 / 自定义」二态切换。
 *
 * 取值语义（落库口径不变，见 node-config.ts）：值留空 = 回放快照捕获值
 * （headerFidelity 键缺省，不落字段），捕获值经 placeholder 就地展示；
 * 填写即自定义注入值（支持模板），清空回退捕获档。来源档位由父级按
 * 「值是否非空」派生，本组件只透传值草稿。
 *
 * 模板根为 `<tr>`：与 HeaderRows 行共处请求头区同一张 `.kv-edit-table`，
 * 视觉上是一个整体列表（表格外壳与共享单元格样式见 styles/flow.css）；
 * 「…」菜单提供「添加到环境变量」（Backend.envSets 能力位存在时展示，
 * 弹窗由父级承载）。值列承接 IO 字段 chip 拖放（协议见 template-dnd.ts）。
 */
const props = withDefaults(
  defineProps<{
    /** 头名展示（Origin / Referer / User-Agent / Cookie）。 */
    name: string;
    /** 自定义值草稿（空 = 回放快照捕获值）。 */
    value: string;
    /** 引用快照的捕获值（null = 无引用或快照未捕获该头；作 placeholder 展示）。 */
    capturedValue: string | null;
    /** 空值占位（捕获值缺省时的提示文案）。 */
    emptyPlaceholder?: string;
    disabled?: boolean;
    /** 环境变量能力位（缺失时「…」菜单不展示「添加到环境变量」）。 */
    canSaveEnv?: boolean;
    /** 上游可引用节点清单（透传表达式输入）。 */
    availableNodeIds?: ReadonlyArray<SuggestNodeOption>;
    /** 可引用变量名清单（透传表达式输入）。 */
    variableNames?: ReadonlyArray<string>;
    /** 入参字段路径清单（透传表达式输入）。 */
    inputPaths?: ReadonlyArray<string>;
    /** 激活环境集合 + 全局的键名清单（透传表达式输入）。 */
    envKeys?: ReadonlyArray<string>;
    /** 模板样本上下文（透传表达式输入，缺省无预览）。 */
    sample?: TemplateSampleContext | null;
  }>(),
  { canSaveEnv: false, disabled: false, emptyPlaceholder: "" },
);

const emit = defineEmits<{
  "update:value": [value: string];
  /** 行菜单「添加到环境变量」：携带当前生效名 / 值，由父级开弹窗确认。 */
  "save-to-env": [payload: { name: string; value: string }];
}>();

// 自定义值输入的本地草稿：值变化原样上抛（空值 = 捕获档，由父级归档）。
const draft = ref(props.value);
watch(
  () => props.value,
  (value) => {
    draft.value = value;
  },
);

watch(draft, (value) => {
  if (props.disabled) return;
  if (value !== props.value) emit("update:value", value);
});

/** 空值占位：捕获值优先就地展示（留空即发送该值），否则用调用方提示文案。 */
const placeholder = () =>
  props.capturedValue !== null && props.capturedValue !== ""
    ? props.capturedValue
    : props.emptyPlaceholder;

/** 空值行 title 提示：说明「留空 = 捕获值」语义与当前捕获值。 */
const emptyHint = () =>
  props.capturedValue !== null
    ? `留空回放快照捕获值${props.capturedValue === "" ? "（快照未捕获该头）" : `：${props.capturedValue}`}`
    : props.emptyPlaceholder || `填写 ${props.name} 的注入值`;

/** 当前行生效值（菜单「添加到环境变量」预填）：自定义档取草稿，捕获档取捕获值。 */
function effectiveValue(): string {
  return draft.value.trim() !== "" ? draft.value : (props.capturedValue ?? "");
}

/** 行菜单：添加到环境变量（父级弹窗确认目标集合与名值）。 */
function openRowMenu(event: MouseEvent): void {
  if (props.disabled) return;
  openDropdownMenu(event.currentTarget as HTMLElement, [
    {
      label: "添加到环境变量",
      title: "把该请求头的名 / 值写入所选环境变量集（弹窗内可修改）",
      action: () => emit("save-to-env", { name: props.name, value: effectiveValue() }),
    },
  ]);
}

/** 值列表达式输入实例（拖放插入出口） */
type ExpressionInputInstance = InstanceType<typeof ExpressionInput>;
const valueInput = ref<ExpressionInputInstance | null>(null);

/** 值列 dragover：仅接管携带 IO 字段载荷的拖拽（其余保持浏览器默认）。 */
function onValueDragOver(event: DragEvent): void {
  if (props.disabled || !event.dataTransfer) return;
  if (!hasIoPathPayload(event.dataTransfer.types)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
}

/** 值列 drop：读 IO 字段载荷，经组件 ref 插入完整模板引用。 */
async function onValueDrop(event: DragEvent): Promise<void> {
  if (props.disabled || !event.dataTransfer) return;
  const snippet = readIoPathPayload(event.dataTransfer);
  if (snippet === null) return;
  event.preventDefault();
  await valueInput.value?.insertSnippet(snippet);
  if (draft.value !== props.value) emit("update:value", draft.value);
}
</script>

<template>
  <tr class="chr-row">
    <td class="kv-drag-col" />
    <td class="mono kv-name">
      <span class="chr-name" :title="`请求头 ${name}`">{{ name }}</span>
    </td>
    <td class="mono kv-value">
      <!-- inert 包裹层：置灰时阻断整子树交互；承接 IO 字段 chip 拖放 -->
      <div
        class="kv-value-host"
        :inert="disabled || undefined"
        :title="draft.trim() === '' ? emptyHint() : undefined"
        @dragover="onValueDragOver"
        @drop="onValueDrop"
      >
        <ExpressionInput
          ref="valueInput"
          v-model="draft"
          :placeholder="placeholder()"
          :available-node-ids="availableNodeIds"
          :variable-names="variableNames"
          :input-paths="inputPaths"
          :env-keys="envKeys"
          :fake-names="FAKE_GENERATOR_NAMES"
          :sample="sample"
          hide-insert-button
        />
      </div>
    </td>
    <td class="kv-menu-col">
      <button
        v-if="canSaveEnv"
        class="btn icon chr-menu"
        title="行操作"
        :aria-label="`请求头 ${name} 操作菜单`"
        :disabled="disabled"
        @click="openRowMenu($event)"
      >
        <Io5EllipsisHorizontal :size="13" />
      </button>
    </td>
  </tr>
</template>

<style scoped>
.chr-name {
  display: inline-block;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.chr-menu {
  opacity: 0;
  padding: 2px;
}
.kv-edit-table tr:hover .chr-menu,
.chr-menu:focus-visible {
  opacity: 1;
}
</style>
