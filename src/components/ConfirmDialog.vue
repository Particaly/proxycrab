<script setup lang="ts">
import { confirmState, settleConfirm } from "../stores/dialog";
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="confirmState.visible" class="confirm-mask" @click.self="settleConfirm('cancel')">
        <div class="confirm-box">
          <div class="confirm-title">{{ confirmState.title }}</div>
          <div class="confirm-message">{{ confirmState.message }}</div>
          <div class="confirm-actions">
            <button class="btn" @click="settleConfirm('cancel')">取消</button>
            <button
              v-if="confirmState.secondaryText"
              class="btn"
              @click="settleConfirm('secondary')"
            >
              {{ confirmState.secondaryText }}
            </button>
            <button
              class="btn"
              :class="confirmState.danger ? 'danger-solid' : 'primary'"
              @click="settleConfirm('confirm')"
            >
              {{ confirmState.confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.confirm-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-dialog);
}
/* 遮罩随 fade 过渡的同时，面板做缩放进场，形成 20ms 级层次感 */
.confirm-box {
  width: 360px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-window);
  padding: var(--space-4);
}
.fade-enter-active .confirm-box {
  animation: confirm-box-in var(--dur-base) var(--ease-out) 20ms backwards;
}
.fade-leave-active .confirm-box {
  animation: confirm-box-out var(--dur-fast) ease;
}
@keyframes confirm-box-in {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes confirm-box-out {
  to {
    opacity: 0;
    transform: scale(0.97);
  }
}
.confirm-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: var(--space-2);
}
.confirm-message {
  color: var(--text-secondary);
  font-size: 12px;
  margin-bottom: var(--space-4);
  word-break: break-all;
  user-select: text;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
.danger-solid {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}
.danger-solid:hover:not(:disabled) {
  background: var(--danger-hover);
  border-color: var(--danger-hover);
}
</style>
