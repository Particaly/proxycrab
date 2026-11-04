<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { Io5EllipsisHorizontal, Io5ReorderTwo, Io5Trash } from "vue-icons-plus/io5";
import { useBackend } from "../../../api";
import type { EnvSetsPayload } from "../../../api/types";
import { reportError } from "../../../stores/app";
import { openDropdownMenu, type MenuItem } from "../../../stores/dialog";
import type { HeaderRowDraft } from "./node-config";

/**
 * 请求头编辑行（计划 Task 14 Step 2）：复用 `EditableKvTable.vue` 的表格形态
 * （拖拽排序 + 名/值行内编辑 + 末尾空行），并为每行提供「…」行内菜单——
 * 删除 / 插入模板引用（光标处插入 `{{ }}` 骨架，建议补全属 Task 15 表达式
 * 输入） / 插入环境变量（Backend.envSets 能力位存在时展示，列激活集合与
 * 全局变量名，插入 `{{ env.<名> }}`）。行数据 { name, value, original? } 见
 * node-config.ts（original = 捕获行基线，供覆盖项计算）。
 */
const rows = defineModel<HeaderRowDraft[]>({ required: true });

const props = defineProps<{
  /** 置灰全部编辑（运行期锁定等场景）。 */
  disabled?: boolean;
  /** 值列输入占位（默认 value）。 */
  placeholder?: string;
}>();

const backend = useBackend();
/** 能力位：环境变量 API 未实现时不展示「插入环境变量」入口。 */
const canInsertEnv = computed(() => backend.envSets !== undefined);

const nonEmpty = (list: HeaderRowDraft[]) =>
  list.filter((row) => row.name.trim() !== "" || row.value !== "");

// 展示态始终以恰好一个末尾空行结尾；与外部 v-model 同步时去空行。
const display = ref<HeaderRowDraft[]>(normalizeRows(rows.value));
watch(rows, (value) => {
  if (JSON.stringify(nonEmpty(value)) !== JSON.stringify(nonEmpty(display.value))) {
    display.value = normalizeRows(value);
  }
});

function normalizeRows(list: HeaderRowDraft[]): HeaderRowDraft[] {
  return [...nonEmpty(list), { name: "", value: "" }];
}

function commit(): void {
  display.value = normalizeRows(display.value);
  rows.value = nonEmpty(display.value);
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

/** 在指定行的值输入框光标处插入文本（未聚焦时插到文末并回焦）。 */
function insertIntoValue(index: number, snippet: string): void {
  const input = valueInputs.value.get(index);
  const row = display.value[index];
  if (!row) return;
  if (input && document.activeElement === input) {
    const start = input.selectionStart ?? row.value.length;
    const end = input.selectionEnd ?? row.value.length;
    row.value = row.value.slice(0, start) + snippet + row.value.slice(end);
    void nextTick(() => {
      input.focus();
      const caret = start + snippet.length;
      input.setSelectionRange(caret, caret);
    });
  } else {
    row.value += snippet;
    void nextTick(() => valueInputs.value.get(index)?.focus());
  }
  commit();
}

// ---------- 行内菜单 ----------

function openRowMenu(index: number, event: MouseEvent): void {
  if (props.disabled) return;
  const items: MenuItem[] = [
    {
      label: "插入模板引用",
      title: "在光标处插入 {{ }} 模板骨架",
      action: () => insertIntoValue(index, "{{ }}"),
    },
  ];
  if (canInsertEnv.value) {
    items.push({
      label: "插入环境变量",
      title: "选择环境变量并插入 {{ env.<名> }}",
      action: () => void openEnvPicker(index, event.currentTarget as HTMLElement),
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
    insertIntoValue(index, "{{ env. }}");
    return;
  }
  openDropdownMenu(
    anchor,
    sorted.map((name) => ({
      label: name,
      title: `插入 {{ env.${name} }}`,
      action: () => insertIntoValue(index, `{{ env.${name} }}`),
    })),
  );
}

// ---------- 值列换行 textarea 自动增高 ----------
const tableRef = ref<HTMLElement | null>(null);
const valueInputs = ref(new Map<number, HTMLTextAreaElement>());

function autosize(el: HTMLTextAreaElement): void {
  el.style.height = "0";
  el.style.height = `${el.scrollHeight}px`;
}

/** 收集值列 textarea 实例（模板 ref 回调；卸载传 null 时移除）。 */
function setValueRef(index: number, el: unknown): void {
  if (el instanceof HTMLTextAreaElement) valueInputs.value.set(index, el);
  else valueInputs.value.delete(index);
}

function autosizeAll(): void {
  void nextTick(() => {
    valueInputs.value.forEach((el) => autosize(el));
  });
}

onMounted(autosizeAll);
watch(display, autosizeAll, { deep: true });

function onValueInput(row: HeaderRowDraft, event: Event): void {
  // header value 不允许换行；粘贴带入的换行直接去除
  if (row.value.includes("\n")) row.value = row.value.replace(/\r?\n/g, "");
  autosize(event.target as HTMLTextAreaElement);
  commit();
}

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
</script>

<template>
  <div class="hr-root">
    <table ref="tableRef" class="kv-edit-table">
      <tbody>
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
            <textarea
              :ref="(el) => setValueRef(index, el)"
              v-model="row.value"
              class="kv-edit kv-value-input"
              :placeholder="placeholder ?? 'value'"
              rows="1"
              :disabled="disabled"
              spellcheck="false"
              @input="onValueInput(row, $event)"
              @keydown.enter.prevent
            />
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
    </table>
    <button v-if="!disabled" class="btn icon hr-add" title="添加请求头" @click="addRow">
      + 添加请求头
    </button>
  </div>
</template>

<style scoped>
.hr-root {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.kv-edit-table {
  width: 100%;
  border-collapse: collapse;
}

.kv-edit-table tr + tr {
  border-top: 1px solid var(--border);
}

.kv-edit-table tr:hover {
  background: var(--bg-hover);
}

.kv-edit-table td {
  padding: 4px 6px;
  vertical-align: top;
  font-size: 11px;
}

.kv-drag-col {
  width: 18px;
  text-align: center;
  padding-left: 0;
  padding-right: 0;
}

.drag-handle {
  display: inline-flex;
  align-items: center;
  height: 1.5em;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.kv-name {
  color: var(--text);
  white-space: nowrap;
  width: 1%;
  padding-right: 8px;
}

.kv-value {
  word-break: break-all;
  padding-right: 0;
}

.kv-edit {
  display: block;
  border: none;
  background: transparent;
  outline: none;
  font: inherit;
  color: inherit;
  padding: 0;
  resize: none;
  border-radius: 3px;
}

.kv-edit::placeholder {
  color: var(--text-faint);
}

.kv-edit:focus {
  background: var(--bg-active);
}

.kv-name-input {
  width: auto;
  max-width: 130px;
}

.kv-value-input {
  width: 100%;
  color: var(--success);
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-all;
}

.kv-menu-col {
  width: 22px;
  padding-left: 0;
  padding-right: 0;
}

.hr-menu {
  opacity: 0;
  padding: 2px;
}
.kv-edit-table tr:hover .hr-menu,
.hr-menu:focus-visible {
  opacity: 1;
}

.hr-add {
  align-self: flex-start;
  color: var(--text-secondary);
  padding: 3px 4px;
  font-size: 11px;
}

tr.dragging {
  background: var(--bg-selected);
}

tr.placeholder td {
  border-top: none;
}
</style>
