<script setup lang="ts">
import type { RefSuggestOption } from "./expression-suggest";

/**
 * 表达式提示浮层（ReqFlow 复刻计划 Task 15 薄片 A）。
 *
 * 形态自归档 `_archive/reqflow/.../SuggestPopup.tsx @ 485fa00` 移植（React →
 * Vue 3，Tailwind 类 → base.css token 的 scoped 样式）。展示当前层级的引用
 * 候选（根 / 节点 id / 深路径），支持键盘高亮与点击插入；候选渲染与过滤逻辑
 * 在 expression-suggest.ts（纯函数）。
 *
 * 定位与裁剪约束：浮层用 absolute 定位挂在组件内置的 relative 包裹层之下
 * （随控件移动，不用 fixed + portal，避免跨容器层级管理）；z-index 取浮层级，
 * 覆盖同级面板内容。若外层容器设置了 overflow hidden/auto，浮层可能被裁剪
 * 或随容器滚动——把本组件放在不裁剪的容器中，或接受随容器滚动。
 */

defineProps<{
  /** 当前层级候选（buildSuggestOptions 的输出） */
  options: ReadonlyArray<RefSuggestOption>;
  /** 键盘 / 悬停同步的高亮候选下标 */
  highlightIndex: number;
}>();

const emit = defineEmits<{
  /** 选中候选回调（插入补全） */
  pick: [option: RefSuggestOption];
  /** 悬停同步高亮回调 */
  highlight: [index: number];
}>();
</script>

<template>
  <ul role="listbox" aria-label="模板引用建议" class="suggest-popup">
    <li
      v-for="(option, index) in options"
      :key="`${option.insert}-${index}`"
      role="option"
      :aria-selected="index === highlightIndex"
    >
      <button
        type="button"
        class="suggest-option"
        :class="{ active: index === highlightIndex }"
        @mousedown.prevent
        @click="emit('pick', option)"
        @mouseenter="emit('highlight', index)"
      >
        <span class="suggest-label">{{ option.label }}</span>
        <span class="suggest-description">{{ option.description }}</span>
      </button>
    </li>
  </ul>
</template>

<style scoped>
.suggest-popup {
  position: absolute;
  left: 0;
  top: 100%;
  z-index: 50;
  margin: 4px 0 0;
  max-height: 224px;
  width: 256px;
  padding: 4px 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-popup);
  list-style: none;
}

.suggest-option {
  display: flex;
  width: 100%;
  align-items: baseline;
  gap: 8px;
  padding: 4px 10px;
  border: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.suggest-option.active {
  background: var(--bg-hover);
}

.suggest-label {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
}

.suggest-description {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}
</style>
