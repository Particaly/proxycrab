<script setup lang="ts">
import {
  Io5AddCircleOutline,
  Io5ArrowRedo,
  Io5ArrowUndo,
  Io5CopyOutline,
  Io5DocumentsOutline,
  Io5GitNetworkOutline,
  Io5RemoveCircleOutline,
  Io5ScanOutline,
} from "vue-icons-plus/io5";

/**
 * 画布悬浮工具条（Task 13 Step 2/3，移植归档 CanvasToolbar 的画布子集）：
 * 撤销 / 重做、自动布局、复制 / 粘贴节点、缩放 / 适配视口。图数据与历史
 * 归窗口持有，本组件只上抛动作。锁定语义（Step 4）：结构性编辑入口
 * （撤销 / 重做 / 布局 / 粘贴）disabled + title 提示；视口与复制不受限。
 */

const props = defineProps<{
  canUndo: boolean;
  canRedo: boolean;
  canCopy: boolean;
  canPaste: boolean;
  locked: boolean;
}>();

const emit = defineEmits<{
  undo: [];
  redo: [];
  layout: [];
  copy: [];
  paste: [];
  zoomIn: [];
  zoomOut: [];
  fit: [];
}>();

/** 结构性编辑动作的 title 文案：锁定时说明原因，否则描述动作。 */
function editTitle(action: string, enabled: boolean): string | undefined {
  if (!enabled) return undefined;
  return props.locked ? `运行中不可编辑：${action}请等运行结束` : action;
}
</script>

<template>
  <div class="flow-toolbar" data-testid="canvas-toolbar">
    <button
      class="btn icon"
      :disabled="!canUndo || locked"
      :title="editTitle('撤销', canUndo)"
      @click="emit('undo')"
    >
      <Io5ArrowUndo :size="15" />
    </button>
    <button
      class="btn icon"
      :disabled="!canRedo || locked"
      :title="editTitle('重做', canRedo)"
      @click="emit('redo')"
    >
      <Io5ArrowRedo :size="15" />
    </button>
    <span class="flow-toolbar-divider" />
    <button
      class="btn icon"
      :disabled="locked"
      title="自动布局：按依赖关系分层重排"
      @click="emit('layout')"
    >
      <Io5GitNetworkOutline :size="15" />
    </button>
    <button
      class="btn icon"
      :disabled="!canCopy"
      :title="canCopy ? '复制选中节点（含内部连线）' : '先选中节点'"
      @click="emit('copy')"
    >
      <Io5CopyOutline :size="15" />
    </button>
    <button
      class="btn icon"
      :disabled="!canPaste || locked"
      :title="editTitle('粘贴', canPaste)"
      @click="emit('paste')"
    >
      <Io5DocumentsOutline :size="15" />
    </button>
    <span class="flow-toolbar-divider" />
    <button class="btn icon" title="放大" @click="emit('zoomIn')">
      <Io5AddCircleOutline :size="15" />
    </button>
    <button class="btn icon" title="缩小" @click="emit('zoomOut')">
      <Io5RemoveCircleOutline :size="15" />
    </button>
    <button class="btn icon" title="适配视口（全部节点）" @click="emit('fit')">
      <Io5ScanOutline :size="15" />
    </button>
  </div>
</template>
