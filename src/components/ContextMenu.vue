<script setup lang="ts">
import { closeContextMenu, contextMenuState } from "../stores/dialog";

function run(item: (typeof contextMenuState.items)[number]): void {
  if (item.disabled) return;
  closeContextMenu();
  item.action();
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="contextMenuState.visible"
        class="ctx-mask"
        @click="closeContextMenu"
        @contextmenu.prevent="closeContextMenu"
      >
        <Transition name="pop" appear>
          <div
            class="ctx-menu"
            :style="{
              left: contextMenuState.x + 'px',
              top: contextMenuState.y + 'px',
              transformOrigin: 'top left',
            }"
          >
            <template v-for="(item, i) in contextMenuState.items" :key="i">
              <div v-if="item.dividerBefore" class="ctx-divider" />
              <button
                class="ctx-item"
                :class="{ danger: item.danger }"
                :disabled="item.disabled"
                @click="run(item)"
              >
                <component :is="item.icon" v-if="item.icon" :size="14" class="ctx-icon" />
                <span :title="item.title">{{ item.label }}</span>
              </button>
            </template>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ctx-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-menu);
}
.ctx-menu {
  position: fixed;
  min-width: 160px;
  padding: var(--space-1);
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-popup);
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
}
.ctx-divider {
  height: 1px;
  margin: var(--space-1) var(--space-1);
  background: var(--border);
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  min-height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) ease;
}
.ctx-item:hover:not(:disabled) {
  background: var(--bg-hover);
}
.ctx-item.danger {
  color: var(--danger);
}
.ctx-item.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
}
.ctx-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ctx-icon {
  flex: none;
}
</style>
