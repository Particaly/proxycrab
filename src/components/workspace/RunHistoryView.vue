<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { useRunHistoryStore } from "../../stores/run-history";
import RunDetailView from "./RunDetailView.vue";

/**
 * 运行记录主区视图（原浮窗 RunHistoryWindow 的详情入口改内嵌）：选中运行
 * → 只读运行画布详情（RunDetailView 按 runId 重挂载），未选中时空态提示。
 * 列表拉取与 2s 自动刷新轮询随本视图挂载启停（切走区块即停，回到区块重新
 * 拉取；选中运行保留在 store，切回不丢）。
 */
const { selectedRunId, startPolling, stopPolling } = useRunHistoryStore();

onMounted(startPolling);

onBeforeUnmount(stopPolling);
</script>

<template>
  <RunDetailView v-if="selectedRunId !== null" :key="selectedRunId" :run-id="selectedRunId" />
  <div v-else class="empty-hint rh-view-empty">从左侧选择运行记录查看详情</div>
</template>

<style scoped>
.rh-view-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
