import { computed, ref } from "vue";
import { getBackend } from "../api/runtime-backend";
import type { EnvSetsPayload, EnvVariableSet, HttpApiChange } from "../api/types";
import { reportError } from "./app";
import { confirmDialog } from "./dialog";

/**
 * 环境变量集与全局变量共享状态（原浮窗 EnvSetsWindow 的 script 提升）：
 * 手风琴导航下「侧栏集合列表」与「主区 kv 编辑」是两个组件，编辑态在此
 * 共享。集合增删改/复制、kv 编辑（secret 值按掩码 "******" 显示，未改动的
 * 掩码值由后端自动还原为原明文，显式输入即覆盖）、一键激活（删除激活集由
 * 后端自动清偏好）。入口依赖 Backend.envSets 能力位（workspace-view /
 * 手风琴区块把关）。
 */

/** kv 编辑行（空键行保存时忽略）。 */
export interface EnvKvRow {
  key: string;
  value: string;
}

export type EnvSetsSelection = { kind: "set"; id: string } | { kind: "globals" };

/** 全局变量模板引用提示（字面大括号无法直接写在模板插值里）。 */
export const VAR_REFERENCE_HINT = "{{ var.名称 }}";

export const ENV_SECRET_MASK = "******";

const payload = ref<EnvSetsPayload | null>(null);
const selection = ref<EnvSetsSelection>({ kind: "globals" });
const newSetName = ref("");
const loading = ref(false);
const saving = ref(false);
const externalChanged = ref(false);

// 当前编辑草稿：集合名 + 两张 kv 行表；globals 时 setName 不展示。
const draftName = ref("");
const draftValues = ref<EnvKvRow[]>([]);
const draftSecretValues = ref<EnvKvRow[]>([]);

const currentSet = computed<EnvVariableSet | null>(() => {
  const current = selection.value;
  if (current.kind !== "set" || !payload.value) return null;
  return payload.value.sets.find((set) => set.id === current.id) ?? null;
});

export const isActive = computed(
  () => currentSet.value !== null && payload.value?.activeSetId === currentSet.value.id,
);

export const dirty = computed<boolean>(() => {
  if (selection.value.kind === "globals") {
    const globals = payload.value?.globals;
    if (!globals) return false;
    return (
      mapToKeyText(rowsToMap(draftValues.value)) !== mapToKeyText(globals.values) ||
      mapToKeyText(rowsToMap(draftSecretValues.value)) !== mapToKeyText(globals.secretValues)
    );
  }
  const set = currentSet.value;
  if (!set) return false;
  return (
    draftName.value !== set.name ||
    mapToKeyText(rowsToMap(draftValues.value)) !== mapToKeyText(set.values) ||
    mapToKeyText(rowsToMap(draftSecretValues.value)) !== mapToKeyText(set.secretValues)
  );
});

/** 规范化比较文本：按键排序，顺序无关。 */
function mapToKeyText(map: Record<string, string>): string {
  return Object.entries(map)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}\u0000${value}`)
    .join();
}

function rowsToMap(rows: EnvKvRow[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") continue;
    map[key] = row.value;
  }
  return map;
}

function mapToRows(map: Record<string, string>): EnvKvRow[] {
  return Object.entries(map).map(([key, value]) => ({ key, value }));
}

function loadDraft(): void {
  externalChanged.value = false;
  if (selection.value.kind === "globals") {
    draftName.value = "";
    draftValues.value = mapToRows(payload.value?.globals.values ?? {});
    draftSecretValues.value = mapToRows(payload.value?.globals.secretValues ?? {});
    return;
  }
  const set = currentSet.value;
  draftName.value = set?.name ?? "";
  draftValues.value = mapToRows(set?.values ?? {});
  draftSecretValues.value = mapToRows(set?.secretValues ?? {});
}

export async function refresh(prefer = selection.value): Promise<void> {
  const api = getBackend().envSets;
  if (!api) return;
  loading.value = true;
  try {
    payload.value = await api.get();
    if (prefer.kind === "set" && !payload.value.sets.some((set) => set.id === prefer.id)) {
      selection.value = { kind: "globals" };
    }
    loadDraft();
  } catch (error) {
    reportError(error, "加载环境变量失败");
  } finally {
    loading.value = false;
  }
}

export async function select(target: EnvSetsSelection): Promise<void> {
  if (
    dirty.value &&
    !(await confirmDialog({
      title: "未保存的修改",
      message: "当前有未保存的修改，切换后将被丢弃。确定切换吗？",
      confirmText: "切换",
      danger: true,
    }))
  ) {
    return;
  }
  selection.value = target;
  loadDraft();
}

export async function createSet(): Promise<void> {
  const api = getBackend().envSets;
  if (!api) return;
  const name = newSetName.value.trim();
  if (name === "") return;
  try {
    const created = await api.create({ name });
    newSetName.value = "";
    selection.value = { kind: "set", id: created.id };
    await refresh(selection.value);
  } catch (error) {
    reportError(error, "新建环境变量集失败");
  }
}

export async function copySet(): Promise<void> {
  const api = getBackend().envSets;
  const set = currentSet.value;
  if (!api || !set) return;
  try {
    const created = await api.create({
      name: `${set.name}-副本`,
      copyFrom: set.id,
    });
    selection.value = { kind: "set", id: created.id };
    await refresh(selection.value);
  } catch (error) {
    reportError(error, "复制环境变量集失败");
  }
}

export async function removeSet(set: EnvVariableSet): Promise<void> {
  const api = getBackend().envSets;
  if (!api) return;
  const ok = await confirmDialog({
    title: "删除环境变量集",
    message: `确定删除「${set.name}」吗？该集合中的变量与 secret 一并删除，不可恢复。`,
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.remove(set.id);
    // 后端在删除激活集时自动清偏好；这里统一重取（保持当前选择，删除的
    // 是当前选择时自动回落到全局变量）。
    await refresh();
  } catch (error) {
    reportError(error, "删除环境变量集失败");
  }
}

export async function toggleActive(): Promise<void> {
  const api = getBackend().envSets;
  const set = currentSet.value;
  if (!api || !set) return;
  try {
    await api.setActive(isActive.value ? null : set.id);
    await refresh();
  } catch (error) {
    reportError(error, "切换激活环境失败");
  }
}

export async function save(): Promise<void> {
  const api = getBackend().envSets;
  if (!api || !dirty.value || saving.value) return;
  saving.value = true;
  try {
    if (selection.value.kind === "globals") {
      await api.saveGlobals({
        values: rowsToMap(draftValues.value),
        secretValues: rowsToMap(draftSecretValues.value),
      });
    } else if (currentSet.value) {
      await api.save(currentSet.value.id, {
        name: draftName.value,
        values: rowsToMap(draftValues.value),
        secretValues: rowsToMap(draftSecretValues.value),
      });
    }
    await refresh();
  } catch (error) {
    reportError(error, "保存环境变量失败");
  } finally {
    saving.value = false;
  }
}

export function addRow(secret: boolean): void {
  (secret ? draftSecretValues : draftValues).value.push({ key: "", value: "" });
}

export function removeRow(secret: boolean, index: number): void {
  const rows = secret ? draftSecretValues : draftValues;
  rows.value = rows.value.filter((_, current) => current !== index);
}

/** `env_sets` 资源被其他操作（其他窗口 / CLI）改动时的对账入口。 */
export function onEnvSetsHttpApiChange(event: Event): void {
  const { resources } = (event as CustomEvent<HttpApiChange>).detail;
  if (!resources.includes("all") && !resources.includes("env_sets")) return;
  if (dirty.value) {
    externalChanged.value = true;
    return;
  }
  void refresh();
}

export function useEnvSetsStore() {
  return {
    payload,
    selection,
    newSetName,
    loading,
    saving,
    externalChanged,
    draftName,
    draftValues,
    draftSecretValues,
    currentSet,
    isActive,
    dirty,
    refresh,
    select,
    createSet,
    copySet,
    removeSet,
    toggleActive,
    save,
    addRow,
    removeRow,
  };
}
