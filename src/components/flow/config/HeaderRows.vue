<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Io5EllipsisHorizontal, Io5ReorderTwo, Io5Trash } from "vue-icons-plus/io5";
import { FAKE_GENERATORS, FAKE_GENERATOR_NAMES } from "../../../../flow-engine/src/fake";
import { useBackend } from "../../../api";
import type { EnvSetsPayload } from "../../../api/types";
import { reportError } from "../../../stores/app";
import { openDropdownMenu, type MenuItem } from "../../../stores/dialog";
import ExpressionInput from "../../expression-input/ExpressionInput.vue";
import type { SuggestNodeOption } from "../../expression-input/expression-suggest";
import type { TemplateSampleContext } from "../../expression-input/use-expression-preview";
import { hasIoPathPayload, readIoPathPayload } from "../template-dnd";
import type { HeaderRowDraft } from "./node-config";

/** 表达式输入组件实例（defineExpose 的插入出口） */
type ExpressionInputInstance = InstanceType<typeof ExpressionInput>;

/**
 * 请求头编辑行（计划 Task 14 Step 2，值列升级为表达式输入：Task 15 薄片 C
 * Step 2）：复用行表格形态（拖拽排序 + 名/值行内编辑 + 末尾空行），值列为
 * `ExpressionInput`（`{{` 建议 + 求值预览 + 缺失引用告警，样式经全局
 * `.kv-edit-table` 口径融入行编辑密度；fake. 根候选恒展示——假数据为引擎
 * 内置能力，清单取 FAKE_GENERATOR_NAMES 常量），「…」行内菜单——删除 /
 * 插入模板引用（经组件 ref 调 insertTemplate，与建议浮层同一插入出口）/
 * 插入假数据（列内置生成器，插入 `{{ fake.<名称> }}`）/ 插入环境变量
 * （Backend.envSets 能力位存在时展示，列激活集合与全局变量名，经
 * insertSnippet 插入 `{{ env.<名> }}`）/ 添加到环境变量（把该行名值写入所选
 * 环境变量集，弹窗由父级承载）。行数据 { name, value, original? } 见
 * node-config.ts（original = 捕获行基线，供覆盖项计算）。
 *
 * 模板根为 `<tbody>` 行片段：与常见头固定行（ReplayNodeConfig）共处请求头
 * 区同一张 `.kv-edit-table`，视觉上是一个整体列表（表格外壳与共享单元格
 * 样式见 styles/flow.css）。
 */
const rows = defineModel<HeaderRowDraft[]>({ required: true });

const emit = defineEmits<{
  /** 行菜单「添加到环境变量」：携带该行当前名 / 值，由父级开弹窗确认。 */
  "save-to-env": [payload: { name: string; value: string }];
}>();

const props = defineProps<{
  /** 置灰全部编辑（运行期锁定等场景）。 */
  disabled?: boolean;
  /** 值列输入占位（默认 value）。 */
  placeholder?: string;
  /** 名字命中的行在表中隐藏（大小写不敏感；数据透传不丢，commit 原样带回
   * v-model）——常见头由外部固定行接管展示时避免同一头双行。 */
  hideNames?: ReadonlyArray<string>;
  /** 上游可引用节点清单（`node.` 第二级候选；透传表达式输入）。 */
  availableNodeIds?: ReadonlyArray<SuggestNodeOption>;
  /** 可引用变量名清单（提供时出现 var. 根候选）。 */
  variableNames?: ReadonlyArray<string>;
  /** 入参字段路径清单（提供时出现裸路径简写候选）。 */
  inputPaths?: ReadonlyArray<string>;
  /** 激活环境集合 + 全局的键名清单（提供时出现 env. 根候选）。 */
  envKeys?: ReadonlyArray<string>;
  /** 模板样本上下文（深路径候选 + 求值预览；缺省不渲染预览行）。 */
  sample?: TemplateSampleContext | null;
}>();

const backend = useBackend();
/** 能力位：环境变量 API 未实现时不展示「插入环境变量」/「添加到环境变量」。 */
const canInsertEnv = computed(() => backend.envSets !== undefined);

const nonEmpty = (list: HeaderRowDraft[]) =>
  list.filter((row) => row.name.trim() !== "" || row.value !== "");

/** 行名是否命中隐藏名单（大小写不敏感；空名行永不隐藏）。 */
function isHiddenRow(row: HeaderRowDraft): boolean {
  const name = row.name.trim().toLowerCase();
  if (name === "") return false;
  return (props.hideNames ?? []).some((item) => item.trim().toLowerCase() === name);
}

/** 被隐藏的行（数据透传；commit 时原样追加回 v-model，不触发覆盖 / 删除）。 */
const hiddenRows = ref<HeaderRowDraft[]>([]);

/** 按隐藏名单拆出可见行，并同步隐藏行缓存。 */
function splitVisible(list: HeaderRowDraft[]): HeaderRowDraft[] {
  const visible = list.filter((row) => !isHiddenRow(row));
  hiddenRows.value = list.filter(isHiddenRow);
  return visible;
}

// 展示态始终以恰好一个末尾空行结尾；与外部 v-model 同步时去空行与隐藏行
// （隐藏名单变化——如固定常见头行显隐切换——同样触发重拆）。
const display = ref<HeaderRowDraft[]>(normalizeRows(splitVisible(rows.value)));
watch([rows, () => props.hideNames], ([value]) => {
  const visible = splitVisible(value);
  if (JSON.stringify(nonEmpty(visible)) !== JSON.stringify(nonEmpty(display.value))) {
    display.value = normalizeRows(visible);
  }
});

function normalizeRows(list: HeaderRowDraft[]): HeaderRowDraft[] {
  return [...nonEmpty(list), { name: "", value: "" }];
}

function commit(): void {
  display.value = normalizeRows(display.value);
  rows.value = [...nonEmpty(display.value), ...hiddenRows.value];
}

function addRow(): void {
  if (props.disabled) return;
  if (display.value.some((row) => row.name === "" && row.value === "")) return;
  display.value = [...display.value, { name: "", value: "" }];
}

function removeRow(index: number): void {
  if (props.disabled) return;
  display.value = display.value.filter((_, current) => current !== index);
  commit();
}

// ---------- 值列表达式输入实例与插入出口 ----------
/** 值列表达式输入实例（模板 ref 回调收集；菜单插入 / 拖放插入的统一出口）。 */
const valueInputs = ref(new Map<number, ExpressionInputInstance>());

/** 收集值列表达式输入实例（模板 ref 回调；卸载传 null 时移除）。 */
function setValueRef(index: number, el: unknown): void {
  const instance = el as ExpressionInputInstance | null;
  if (instance && typeof instance.insertSnippet === "function") {
    valueInputs.value.set(index, instance);
  } else {
    valueInputs.value.delete(index);
  }
}

/** 在指定行的值输入框插入 `{{ }}` 骨架（「插入模板引用」菜单项；经组件 ref
 * 走单一插入出口，建议浮层随插入立即可见）。 */
async function insertTemplateAt(index: number): Promise<void> {
  const input = valueInputs.value.get(index);
  if (!input) return;
  await input.insertTemplate();
  commit();
}

/** 在指定行的值输入框插入完整模板片段（环境变量菜单 / 拖放共用出口）。 */
async function insertSnippetAt(index: number, snippet: string): Promise<void> {
  const input = valueInputs.value.get(index);
  if (!input) return;
  await input.insertSnippet(snippet);
  commit();
}

// ---------- IO 字段 chip 拖放承接（协议见 template-dnd.ts） ----------

/** 值列 dragover：仅接管携带 IO 字段载荷的拖拽（其余保持浏览器默认）。 */
function onValueDragOver(event: DragEvent): void {
  if (props.disabled || !event.dataTransfer) return;
  if (!hasIoPathPayload(event.dataTransfer.types)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
}

/** 值列 drop：读 IO 字段载荷，经组件 ref 插入完整模板引用。 */
function onValueDrop(index: number, event: DragEvent): void {
  if (props.disabled || !event.dataTransfer) return;
  const snippet = readIoPathPayload(event.dataTransfer);
  if (snippet === null) return;
  event.preventDefault();
  void insertSnippetAt(index, snippet);
}

// ---------- 行内菜单 ----------

function openRowMenu(index: number, event: MouseEvent): void {
  if (props.disabled) return;
  const items: MenuItem[] = [
    {
      label: "插入模板引用",
      title: "在光标处插入 {{ }} 骨架（输入 {{ 弹出引用建议）",
      action: () => void insertTemplateAt(index),
    },
    {
      label: "插入假数据",
      title: "选择内置假数据生成器并插入 {{ fake.<名称> }}",
      action: () => openFakePicker(index, event.currentTarget as HTMLElement),
    },
  ];
  if (canInsertEnv.value) {
    items.push({
      label: "插入环境变量",
      title: "选择环境变量并插入 {{ env.<名> }}",
      action: () => void openEnvPicker(index, event.currentTarget as HTMLElement),
    });
    items.push({
      label: "添加到环境变量",
      title: "把该请求头的名 / 值写入所选环境变量集（弹窗内可修改）",
      action: () => {
        const row = display.value[index];
        emit("save-to-env", { name: row?.name ?? "", value: row?.value ?? "" });
      },
    });
  }
  items.push({
    label: "删除",
    icon: Io5Trash,
    danger: true,
    dividerBefore: true,
    action: () => removeRow(index),
  });
  openDropdownMenu(event.currentTarget as HTMLElement, items);
}

/** 环境变量名清单（激活集合 + 全局变量，键去重排序）。 */
async function openEnvPicker(index: number, anchor: HTMLElement): Promise<void> {
  const envSets = backend.envSets;
  if (!envSets) return;
  let payload: EnvSetsPayload;
  try {
    payload = await envSets.get();
  } catch (error) {
    reportError(error, "加载环境变量失败");
    return;
  }
  const names = new Set<string>();
  for (const set of payload.sets) {
    if (set.id === payload.activeSetId) {
      for (const name of Object.keys(set.values)) names.add(name);
      for (const name of Object.keys(set.secretValues)) names.add(name);
    }
  }
  for (const name of Object.keys(payload.globals.values)) names.add(name);
  for (const name of Object.keys(payload.globals.secretValues)) names.add(name);
  const sorted = [...names].sort((a, b) => (a < b ? -1 : 1));
  if (sorted.length === 0) {
    void insertSnippetAt(index, "{{ env. }}");
    return;
  }
  openDropdownMenu(
    anchor,
    sorted.map((name) => ({
      label: name,
      title: `插入 {{ env.${name} }}`,
      action: () => void insertSnippetAt(index, `{{ env.${name} }}`),
    })),
  );
}

/**
 * 假数据生成器选择菜单（「插入假数据」菜单项）：列出引擎内置生成器
 * （flow-engine/src/fake.ts 元数据表），选中后在该行值输入框插入
 * `{{ fake.<名称> }}`。假数据是引擎内置能力、无需运行期上下文，本菜单
 * 不设能力位（与「插入环境变量」的 backend.envSets 门控不同）。
 */
function openFakePicker(index: number, anchor: HTMLElement): void {
  openDropdownMenu(
    anchor,
    FAKE_GENERATORS.map((generator) => ({
      label: `${generator.name} — ${generator.description}`,
      title: `插入 {{ fake.${generator.name} }}（示例：${generator.example}）`,
      action: () => void insertSnippetAt(index, `{{ fake.${generator.name} }}`),
    })),
  );
}

// ---------- 行容器（tbody）引用：拖拽排序的落点判定边界 ----------
const tableRef = ref<HTMLElement | null>(null);

// ---------- 拖拽排序（pointer 事件实现，不依赖浏览器 DnD） ----------
const dragIndex = ref<number | null>(null);

function draggable(index: number): boolean {
  const row = display.value[index];
  return row.name.trim() !== "" || row.value !== "";
}

function onHandlePointerDown(index: number, event: PointerEvent): void {
  if (props.disabled) return;
  event.preventDefault();
  dragIndex.value = index;
  const onMove = (move: PointerEvent) => {
    const target = document
      .elementFromPoint(move.clientX, move.clientY)
      ?.closest("tr[data-kv-index]");
    if (!(target instanceof HTMLElement) || !tableRef.value?.contains(target)) return;
    const to = Number(target.dataset.kvIndex);
    const from = dragIndex.value;
    if (from === null || Number.isNaN(to) || to === from) return;
    const next = [...display.value];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    display.value = next;
    dragIndex.value = to;
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    dragIndex.value = null;
    commit();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

defineExpose({ addRow });
</script>

<template>
  <tbody ref="tableRef">
    <tr
      v-for="(row, index) in display"
      :key="index"
      :data-kv-index="index"
      :class="{
        dragging: dragIndex === index,
        placeholder:
          row.original === undefined &&
          row.name === '' &&
          row.value === '' &&
          index === display.length - 1,
      }"
    >
      <td class="kv-drag-col">
        <span
          v-if="draggable(index)"
          class="drag-handle text-faint"
          title="拖动排序"
          @pointerdown="onHandlePointerDown(index, $event)"
        >
          <Io5ReorderTwo :size="13" />
        </span>
      </td>
      <td class="mono kv-name">
        <input
          v-model="row.name"
          class="kv-edit kv-name-input"
          placeholder="header"
          :disabled="disabled"
          :size="Math.max(6, row.name.length)"
          spellcheck="false"
          @input="commit"
        />
      </td>
      <td class="mono kv-value">
        <!-- inert 包裹层：置灰时阻断整子树交互（组件无 disabled prop，不改其源）；
             拖放承接 IO 字段 chip（dragover 按 MIME 标记接管，drop 插入引用） -->
        <div
          class="kv-value-host"
          :inert="disabled || undefined"
          @dragover="onValueDragOver"
          @drop="onValueDrop(index, $event)"
        >
          <ExpressionInput
            :ref="(el) => setValueRef(index, el)"
            v-model="row.value"
            :placeholder="placeholder ?? 'value'"
            :available-node-ids="availableNodeIds"
            :variable-names="variableNames"
            :input-paths="inputPaths"
            :env-keys="envKeys"
            :fake-names="FAKE_GENERATOR_NAMES"
            :sample="sample"
            hide-insert-button
            @update:model-value="commit"
          />
        </div>
      </td>
      <td class="kv-menu-col">
        <button
          class="btn icon hr-menu"
          title="行操作"
          :aria-label="`请求头 ${row.name || '新行'} 操作菜单`"
          :disabled="disabled"
          @click="openRowMenu(index, $event)"
        >
          <Io5EllipsisHorizontal :size="13" />
        </button>
      </td>
    </tr>
  </tbody>
</template>

<style scoped>
.drag-handle {
  display: inline-flex;
  align-items: center;
  height: 1.5em;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.hr-menu {
  opacity: 0;
  padding: 2px;
}
.kv-edit-table tr:hover .hr-menu,
.hr-menu:focus-visible {
  opacity: 1;
}

tr.dragging {
  background: var(--bg-selected);
}

tr.placeholder td {
  border-top: none;
}
</style>
