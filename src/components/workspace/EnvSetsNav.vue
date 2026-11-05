<script setup lang="ts">
import { Io5Add, Io5CheckmarkCircle, Io5Trash } from "vue-icons-plus/io5";
import { useEnvSetsStore } from "../../stores/env-sets";

/**
 * 环境变量手风琴侧栏：新建集合输入 + 集合列表（含激活标记 / 删除）+
 * 全局变量行（原浮窗 ev-side 区块）。编辑态见 stores/env-sets.ts。
 */
const { payload, selection, newSetName, loading, createSet, select, removeSet } =
  useEnvSetsStore();
</script>

<template>
  <div class="ev-nav">
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
  </div>
</template>

<style scoped>
.ev-nav {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
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
</style>
