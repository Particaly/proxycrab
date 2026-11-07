<script setup lang="ts">
import { Io5Add, Io5Trash } from "vue-icons-plus/io5";
import { useFlowEditorStore } from "../../stores/flow-editor";

/**
 * 工作流手风琴侧栏：项目 / 流程两级列表 + 新建入口（原浮窗 wf-side 区块）。
 * 编辑态见 stores/flow-editor.ts；选中流程 / 脏确认等操作全部走 store。
 */
const {
  projects,
  projectId,
  workflows,
  workflow,
  loading,
  loadingWorkflows,
  newProjectName,
  newWorkflowName,
  selectProject,
  selectWorkflow,
  createProject,
  createWorkflow,
  removeProject,
  removeWorkflow,
} = useFlowEditorStore();

/** 列表行时间展示（Unix 毫秒 → 月-日 时:分）。 */
function fmtTime(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
</script>

<template>
  <div class="wf-nav">
    <div class="wf-create">
      <input
        v-model="newProjectName"
        class="input"
        placeholder="新项目名称"
        @keyup.enter="createProject"
      />
      <button class="btn icon primary" title="新建项目" @click="createProject">
        <Io5Add :size="15" />
      </button>
    </div>
    <div class="wf-list">
      <div v-if="loading && projects.length === 0" class="empty-hint">正在加载…</div>
      <template v-for="project in projects" :key="project.id">
        <div
          class="wf-row wf-project"
          :class="{ selected: projectId === project.id }"
          role="button"
          tabindex="0"
          @click="selectProject(project.id)"
          @keydown.enter="selectProject(project.id)"
        >
          <span class="wf-project-dot" :style="{ background: project.color || 'var(--accent)' }" />
          <span class="wf-row-name" :title="project.name">{{ project.name }}</span>
          <span class="badge">{{ project.id === projectId ? workflows.length : "" }}</span>
          <button class="btn icon danger wf-delete" title="删除项目" @click.stop="removeProject(project)">
            <Io5Trash :size="13" />
          </button>
        </div>
        <template v-if="projectId === project.id">
          <div v-if="loadingWorkflows" class="empty-hint wf-empty">正在加载…</div>
          <div
            v-for="wf in workflows"
            :key="wf.id"
            class="wf-row wf-workflow"
            :class="{ selected: workflow?.id === wf.id }"
            role="button"
            tabindex="0"
            @click="selectWorkflow(wf)"
            @keydown.enter="selectWorkflow(wf)"
          >
            <span class="wf-row-name" :title="wf.name">{{ wf.name }}</span>
            <span class="wf-meta">{{ wf.nodes.length }}节点 · {{ fmtTime(wf.updatedAt) }}</span>
            <button class="btn icon danger wf-delete" title="删除流程" @click.stop="removeWorkflow(wf)">
              <Io5Trash :size="13" />
            </button>
          </div>
          <div v-if="!loadingWorkflows && workflows.length === 0" class="empty-hint wf-empty">
            暂无流程
          </div>
        </template>
      </template>
      <div v-if="!loading && projects.length === 0" class="empty-hint">暂无项目，请在上方新建</div>
    </div>
    <div class="wf-side-footer">
      <div class="wf-create">
        <input
          v-model="newWorkflowName"
          class="input"
          placeholder="新流程名称"
          :disabled="projectId === null"
          :title="projectId === null ? '先选择一个项目' : ''"
          @keyup.enter="createWorkflow"
        />
        <button
          class="btn icon primary"
          :disabled="projectId === null"
          title="新建流程"
          @click="createWorkflow"
        >
          <Io5Add :size="15" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wf-nav {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.wf-create {
  display: flex;
  gap: var(--space-1);
  padding: var(--space-2);
  border-bottom: 1px solid var(--border);
}
.wf-create .input {
  flex: 1;
  min-width: 0;
}

.wf-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-1);
}

.wf-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-md);
  cursor: pointer;
}
.wf-row:hover {
  background: var(--bg-hover);
}
.wf-row.selected {
  background: var(--bg-selected);
}

.wf-project-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
}

.wf-project {
  font-weight: 600;
}

.wf-workflow {
  padding-left: 24px;
}

.wf-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wf-meta {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
}

.wf-delete {
  opacity: 0;
}
.wf-row:hover .wf-delete {
  opacity: 1;
}

.wf-empty {
  padding: var(--space-2) var(--space-2) var(--space-2) 24px;
  text-align: left;
}

.wf-side-footer {
  flex: none;
  border-top: 1px solid var(--border);
}
</style>
