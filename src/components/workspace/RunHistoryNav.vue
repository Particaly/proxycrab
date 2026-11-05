<script setup lang="ts">
import { Io5ChevronBack, Io5ChevronForward, Io5Refresh } from "vue-icons-plus/io5";
import { useRunHistoryStore } from "../../stores/run-history";
import {
  RUN_STATUS_FILTER_VALUES,
  hasActiveFilters,
  runStatusLabel,
} from "../../components/flow/run-view";
import { formatDateTime } from "../../utils/format";

/**
 * 运行记录手风琴侧栏：流程 / 状态筛选 + 分页运行列表（原浮窗 rh-toolbar /
 * rh-body 区块收敛）。行点击经 store.select 切主区运行详情；列表数据与
 * 2s 自动刷新轮询见 stores/run-history.ts（随主区视图挂载启停）。
 */
const {
  runs,
  total,
  page,
  loading,
  loadError,
  filters,
  workflowOptions,
  selectedRunId,
  pageCount,
  pageLabel,
  loadRuns,
  switchFilter,
  switchPage,
  select,
} = useRunHistoryStore();
</script>

<template>
  <div class="rh-nav">
    <!-- 筛选条：流程 / 状态 + 刷新 -->
    <div class="rh-nav-filters">
      <select
        v-if="workflowOptions.length > 0 || filters.workflowId !== 'all'"
        v-model="filters.workflowId"
        class="select"
        title="按流程筛选"
        aria-label="按流程筛选"
        @change="switchFilter"
      >
        <option value="all">全部流程</option>
        <option v-for="option in workflowOptions" :key="option.id" :value="option.id">
          {{ option.name }}
        </option>
      </select>
      <div class="rh-nav-filter-row">
        <select
          v-model="filters.status"
          class="select"
          title="按状态筛选"
          aria-label="按状态筛选"
          @change="switchFilter"
        >
          <option value="all">全部状态</option>
          <option v-for="status in RUN_STATUS_FILTER_VALUES" :key="status" :value="status">
            {{ runStatusLabel(status) }}
          </option>
        </select>
        <button class="btn icon" title="刷新" @click="loadRuns">
          <Io5Refresh :size="14" />
        </button>
      </div>
    </div>

    <!-- 行（空态按「无数据 / 筛选无命中 / 加载失败」区分） -->
    <div class="rh-nav-list">
      <div v-if="loading && runs.length === 0" class="empty-hint">正在加载…</div>
      <div
        v-for="run in runs"
        :key="run.id"
        class="rh-nav-row"
        :class="{ selected: selectedRunId === run.id }"
        role="button"
        tabindex="0"
        :title="`查看运行详情 ${run.id}`"
        @click="select(run.id)"
        @keydown.enter="select(run.id)"
      >
        <span class="rh-nav-time mono">{{ formatDateTime(run.startedAt) }}</span>
        <span class="rh-nav-name" :title="run.workflowName || run.workflowId">{{
          run.workflowName || run.workflowId
        }}</span>
        <span class="badge rh-nav-status" :class="`is-${run.status}`">{{
          runStatusLabel(run.status)
        }}</span>
      </div>
      <div v-if="!loading && runs.length === 0" class="empty-hint rh-nav-empty">
        {{
          loadError !== null
            ? "加载失败"
            : hasActiveFilters(filters)
              ? "没有符合筛选条件的运行记录"
              : "暂无运行记录"
        }}
      </div>
    </div>

    <!-- 分页脚 -->
    <div class="rh-nav-footer">
      <span class="text-faint">共 {{ total }} 条</span>
      <span class="rh-nav-page mono text-secondary">{{ pageLabel }}</span>
      <button class="btn icon" :disabled="page === 0" title="上一页" @click="switchPage(-1)">
        <Io5ChevronBack :size="13" />
      </button>
      <button
        class="btn icon"
        :disabled="page >= pageCount - 1"
        title="下一页"
        @click="switchPage(1)"
      >
        <Io5ChevronForward :size="13" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.rh-nav {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.rh-nav-filters {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border-bottom: 1px solid var(--border);
}
.rh-nav-filter-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.rh-nav-filter-row .select {
  flex: 1;
  min-width: 0;
}

.rh-nav-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-1);
}

.rh-nav-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-md);
  cursor: pointer;
}
.rh-nav-row:hover {
  background: var(--bg-hover);
}
.rh-nav-row.selected {
  background: var(--bg-selected);
}

.rh-nav-time {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
}
.rh-nav-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

/* 状态徽标（语义色底，同运行详情头部口径） */
.rh-nav-status {
  flex: none;
  min-width: 44px;
  text-align: center;
}
.rh-nav-status.is-running {
  background: var(--accent);
  color: var(--accent-text);
}
.rh-nav-status.is-success {
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: var(--success);
}
.rh-nav-status.is-failed {
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  color: var(--danger);
}
.rh-nav-status.is-cancelled,
.rh-nav-status.is-interrupted {
  background: var(--bg-active);
  color: var(--text-faint);
}

.rh-nav-empty {
  text-align: left;
  padding: var(--space-2);
}

.rh-nav-footer {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-top: 1px solid var(--border);
}
.rh-nav-page {
  flex: 1;
  min-width: 0;
  text-align: center;
  font-size: 11px;
}
</style>
