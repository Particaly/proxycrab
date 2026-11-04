<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  Io5Add,
  Io5CheckmarkCircle,
  Io5Close,
  Io5Copy,
  Io5Save,
  Io5Trash,
} from "vue-icons-plus/io5";
import { useBackend } from "../api";
import type { EnvSetsPayload, EnvVariableSet } from "../api/types";
import { reportError } from "../stores/app";
import { confirmDialog } from "../stores/dialog";
import { HTTP_API_CHANGE_EVENT } from "../stores/http-api-sync";
import type { HttpApiChange } from "../api/types";

/**
 * 环境变量集与全局变量窗口：集合增删改/复制、kv 编辑（secret 值按掩码
 * "******" 显示，未改动的掩码值由后端自动还原为原明文，显式输入即覆盖）、
 * 一键激活（删除激活集由后端自动清偏好）。入口依赖 Backend.envSets 能力位。
 */
const backend = useBackend();

/** kv 编辑行（空键行保存时忽略）。 */
interface Row {
  key: string;
  value: string;
}

type Selection = { kind: "set"; id: string } | { kind: "globals" };

/** 全局变量模板引用提示（字面大括号无法直接写在模板插值里）。 */
const VAR_REFERENCE_HINT = "{{ var.名称 }}";

const MASK = "******";

const payload = ref<EnvSetsPayload | null>(null);
const selection = ref<Selection>({ kind: "globals" });
const newSetName = ref("");
const loading = ref(false);
const saving = ref(false);
const externalChanged = ref(false);

// 当前编辑草稿：集合名 + 两张 kv 行表；globals 时 setName 不展示。
const draftName = ref("");
const draftValues = ref<Row[]>([]);
const draftSecretValues = ref<Row[]>([]);

const currentSet = computed<EnvVariableSet | null>(() => {
  const current = selection.value;
  if (current.kind !== "set" || !payload.value) return null;
  return payload.value.sets.find((set) => set.id === current.id) ?? null;
});

const isActive = computed(
  () => currentSet.value !== null && payload.value?.activeSetId === currentSet.value.id,
);

const dirty = computed<boolean>(() => {
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

function rowsToMap(rows: Row[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") continue;
    map[key] = row.value;
  }
  return map;
}

function mapToRows(map: Record<string, string>): Row[] {
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

async function refresh(prefer = selection.value): Promise<void> {
  loading.value = true;
  try {
    payload.value = await backend.envSets!.get();
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

async function select(target: Selection): Promise<void> {
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

async function createSet(): Promise<void> {
  const name = newSetName.value.trim();
  if (name === "") return;
  try {
    const created = await backend.envSets!.create({ name });
    newSetName.value = "";
    selection.value = { kind: "set", id: created.id };
    await refresh(selection.value);
  } catch (error) {
    reportError(error, "新建环境变量集失败");
  }
}

async function copySet(): Promise<void> {
  const set = currentSet.value;
  if (!set) return;
  try {
    const created = await backend.envSets!.create({
      name: `${set.name}-副本`,
      copyFrom: set.id,
    });
    selection.value = { kind: "set", id: created.id };
    await refresh(selection.value);
  } catch (error) {
    reportError(error, "复制环境变量集失败");
  }
}

async function removeSet(set: EnvVariableSet): Promise<void> {
  const ok = await confirmDialog({
    title: "删除环境变量集",
    message: `确定删除「${set.name}」吗？该集合中的变量与 secret 一并删除，不可恢复。`,
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await backend.envSets!.remove(set.id);
    // 后端在删除激活集时自动清偏好；这里统一重取（保持当前选择，删除的
    // 是当前选择时自动回落到全局变量）。
    await refresh();
  } catch (error) {
    reportError(error, "删除环境变量集失败");
  }
}

async function toggleActive(): Promise<void> {
  const set = currentSet.value;
  if (!set) return;
  try {
    await backend.envSets!.setActive(isActive.value ? null : set.id);
    await refresh();
  } catch (error) {
    reportError(error, "切换激活环境失败");
  }
}

async function save(): Promise<void> {
  if (!dirty.value || saving.value) return;
  saving.value = true;
  try {
    if (selection.value.kind === "globals") {
      await backend.envSets!.saveGlobals({
        values: rowsToMap(draftValues.value),
        secretValues: rowsToMap(draftSecretValues.value),
      });
    } else if (currentSet.value) {
      await backend.envSets!.save(currentSet.value.id, {
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

function addRow(secret: boolean): void {
  (secret ? draftSecretValues : draftValues).value.push({ key: "", value: "" });
}

function removeRow(secret: boolean, index: number): void {
  const rows = secret ? draftSecretValues : draftValues;
  rows.value = rows.value.filter((_, current) => current !== index);
}

function onHttpApiChange(event: Event): void {
  const { resources } = (event as CustomEvent<HttpApiChange>).detail;
  if (!resources.includes("all") && !resources.includes("env_sets")) return;
  if (dirty.value) {
    externalChanged.value = true;
    return;
  }
  void refresh();
}

onMounted(() => {
  void refresh();
  window.addEventListener(HTTP_API_CHANGE_EVENT, onHttpApiChange);
});

onBeforeUnmount(() => {
  window.removeEventListener(HTTP_API_CHANGE_EVENT, onHttpApiChange);
});
</script>

<template>
  <div class="ev-root">
    <aside class="ev-side">
      <div class="ev-create">
        <input
          v-model="newSetName"
          class="input"
          placeholder="新集合名称"
          @keyup.enter="createSet"
        />
        <button class="btn icon primary" title="新建集合" @click="createSet">
          <Io5Add :size="15" />
        </button>
      </div>
      <div class="ev-list">
        <div v-if="loading && !payload" class="empty-hint">正在加载…</div>
        <div
          v-for="set in payload?.sets ?? []"
          :key="set.id"
          class="ev-row"
          :class="{ selected: selection.kind === 'set' && selection.id === set.id }"
          role="button"
          tabindex="0"
          @click="select({ kind: 'set', id: set.id })"
          @keydown.enter="select({ kind: 'set', id: set.id })"
        >
          <span class="ev-row-state">
            <Io5CheckmarkCircle
              v-if="payload?.activeSetId === set.id"
              :size="14"
              class="text-success"
              title="当前激活"
            />
          </span>
          <span class="ev-row-name" :title="set.name">{{ set.name }}</span>
          <span class="badge">{{
            Object.keys(set.values).length + Object.keys(set.secretValues).length
          }}</span>
          <button class="btn icon danger ev-delete" title="删除集合" @click.stop="removeSet(set)">
            <Io5Trash :size="13" />
          </button>
        </div>
        <div v-if="payload && payload.sets.length === 0" class="empty-hint ev-empty">
          暂无环境变量集
        </div>
      </div>
      <div class="ev-side-footer">
        <div
          class="ev-row ev-globals"
          :class="{ selected: selection.kind === 'globals' }"
          role="button"
          tabindex="0"
          @click="select({ kind: 'globals' })"
          @keydown.enter="select({ kind: 'globals' })"
        >
          <span class="ev-row-state" />
          <span class="ev-row-name">全局变量</span>
          <span class="badge">{{
            Object.keys(payload?.globals.values ?? {}).length +
            Object.keys(payload?.globals.secretValues ?? {}).length
          }}</span>
        </div>
      </div>
    </aside>

    <section class="ev-main">
      <template v-if="selection.kind === 'set' && currentSet">
        <div class="ev-toolbar">
          <input v-model="draftName" class="input ev-name" aria-label="集合名称" maxlength="128" />
          <span v-if="isActive" class="ev-active-label">激活中</span>
          <span v-if="dirty" class="ev-dirty">未保存</span>
          <span class="ev-spacer" />
          <button class="btn" :disabled="saving" @click="toggleActive">
            {{ isActive ? "取消激活" : "设为激活" }}
          </button>
          <button class="btn icon" title="复制集合" @click="copySet">
            <Io5Copy :size="14" />
          </button>
          <button class="btn primary" :disabled="saving || !dirty" @click="save">
            <Io5Save :size="14" /> 保存
          </button>
        </div>
      </template>
      <template v-else>
        <div class="ev-toolbar">
          <span class="ev-title">全局变量</span>
          <span class="text-faint"
            >跨项目共享的最低优先级变量，模板以 <code>{{ VAR_REFERENCE_HINT }}</code> 引用</span
          >
          <span v-if="dirty" class="ev-dirty">未保存</span>
          <span class="ev-spacer" />
          <button class="btn primary" :disabled="saving || !dirty" @click="save">
            <Io5Save :size="14" /> 保存
          </button>
        </div>
      </template>

      <div v-if="externalChanged" class="ev-external">
        <span>环境变量已被其他操作修改，保存将覆盖当前内容。</span>
        <button class="btn" @click="refresh()">重新加载</button>
      </div>

      <div class="ev-tables">
        <div class="ev-group">
          <div class="ev-group-head">
            <span class="section-title">普通变量</span>
            <button class="btn icon" title="添加变量" @click="addRow(false)">
              <Io5Add :size="14" />
            </button>
          </div>
          <div v-if="draftValues.length === 0" class="empty-hint ev-group-empty">暂无变量</div>
          <div v-for="(row, index) in draftValues" :key="`v-${index}`" class="ev-kv">
            <input
              v-model="row.key"
              class="input ev-key mono"
              placeholder="变量名"
              spellcheck="false"
            />
            <input
              v-model="row.value"
              class="input ev-value mono"
              placeholder="值"
              spellcheck="false"
            />
            <button class="btn icon ev-remove" title="删除该变量" @click="removeRow(false, index)">
              <Io5Close :size="13" />
            </button>
          </div>
        </div>

        <div class="ev-group">
          <div class="ev-group-head">
            <span class="section-title">Secret 变量</span>
            <button class="btn icon" title="添加 secret 变量" @click="addRow(true)">
              <Io5Add :size="14" />
            </button>
          </div>
          <div class="ev-hint">
            以 {{ MASK }} 显示；保持不变保存即保留原值，输入新值则覆盖。记录与导出会脱敏/剔除。
          </div>
          <div v-if="draftSecretValues.length === 0" class="empty-hint ev-group-empty">
            暂无 secret 变量
          </div>
          <div v-for="(row, index) in draftSecretValues" :key="`s-${index}`" class="ev-kv">
            <input
              v-model="row.key"
              class="input ev-key mono"
              placeholder="变量名"
              spellcheck="false"
            />
            <input
              v-model="row.value"
              class="input ev-value mono ev-secret"
              placeholder="值"
              spellcheck="false"
            />
            <button class="btn icon ev-remove" title="删除该变量" @click="removeRow(true, index)">
              <Io5Close :size="13" />
            </button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ev-root {
  flex: 1;
  min-height: 0;
  display: flex;
}

.ev-side {
  width: 220px;
  flex: none;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  min-height: 0;
}

.ev-create {
  display: flex;
  gap: var(--space-1);
  padding: var(--space-2);
  border-bottom: 1px solid var(--border);
}
.ev-create .input {
  flex: 1;
  min-width: 0;
}

.ev-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-1);
}

.ev-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-md);
  cursor: pointer;
}
.ev-row:hover {
  background: var(--bg-hover);
}
.ev-row.selected {
  background: var(--bg-selected);
}

.ev-row-state {
  width: 14px;
  flex: none;
  display: inline-flex;
}

.ev-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ev-delete {
  opacity: 0;
}
.ev-row:hover .ev-delete {
  opacity: 1;
}

.ev-empty {
  padding: var(--space-3);
}

.ev-side-footer {
  flex: none;
  border-top: 1px solid var(--border);
  padding: var(--space-1);
}

.ev-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.ev-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  flex: none;
}

.ev-name {
  width: 220px;
}

.ev-title {
  font-weight: 600;
}

.ev-active-label {
  color: var(--success);
  font-weight: 600;
}

.ev-dirty {
  font-size: 12px;
  color: var(--warning);
  font-weight: 600;
}

.ev-spacer {
  flex: 1;
}

.ev-external {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  background: var(--bg-selected);
  font-size: 12px;
  flex: none;
}

.ev-tables {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.ev-group-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}
.ev-group-head .section-title {
  margin: 0;
  flex: 1;
}

.ev-group-empty {
  text-align: left;
  padding: var(--space-2);
}

.ev-hint {
  font-size: 12px;
  color: var(--text-faint);
  margin-bottom: var(--space-1);
}

.ev-kv {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-bottom: var(--space-1);
}

.ev-key {
  width: 200px;
  flex: none;
}

.ev-value {
  flex: 1;
  min-width: 0;
}

.ev-secret {
  color: var(--text-secondary);
}

.ev-remove {
  flex: none;
}
</style>
