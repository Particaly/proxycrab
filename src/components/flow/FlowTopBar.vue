<script setup lang="ts">
import { computed, ref } from "vue";
import {
  Io5AddCircleOutline,
  Io5ArrowRedo,
  Io5ArrowUndo,
  Io5Close,
  Io5CopyOutline,
  Io5DocumentsOutline,
  Io5Download,
  Io5GitNetworkOutline,
  Io5Refresh,
  Io5RemoveCircleOutline,
  Io5Save,
  Io5ScanOutline,
  Io5ShieldCheckmark,
} from "vue-icons-plus/io5";
import type { NodeIssue } from "./node-issue-badge";

/**
 * 编辑器悬浮工具条（形态移植归档 CanvasToolbar）：画布顶部居中单条聚合全部
 * 编辑器动作——流程名 + 未保存点（左）、环境集快捷切换、保存 / 校验（问题数
 * 徽标 + 可点击定位的下拉问题面板）/ 自动布局 / 导出 / 撤销重做 / 复制粘贴 /
 * 缩放适配 / 刷新（右）、运行 / 取消（主行动，最右）。画布动作经父级转发到
 * Canvas 的 expose 出口（undo / redo / layout / copy / paste / zoom），流程级
 * 动作（保存 / 校验 / 运行 / 导出 / 环境）直连窗口 store。
 *
 * 问题徽标常驻：数据源为窗口合并后的实时问题清单（本地即时校验 + 服务端
 * 校验结果），按最高级别配色（error 红 / warning 琥珀 / 仅 info 蓝）；点条目
 * 定位对应节点（选中 + 平滑居中）。运行期锁定语义与画布一致：结构性编辑
 * （撤销 / 重做 / 布局 / 粘贴）disabled + title 提示。
 */
const props = defineProps<{
  /** 流程名；null = 未选择流程（隐藏全部动作）。 */
  workflowName: string | null;
  dirty: boolean;
  saving: boolean;
  validating: boolean;
  exporting: boolean;
  triggering: boolean;
  cancelling: boolean;
  /** 运行期锁定（该流程有在途运行）：运行按钮变「取消」。 */
  locked: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canCopy: boolean;
  canPaste: boolean;
  /** 后端流程运行能力位（缺失不展示运行 / 取消）。 */
  hasRunApi: boolean;
  /** 后端环境集能力位（缺失不展示切换下拉）。 */
  hasEnvApi: boolean;
  /** 环境集选项与当前激活 id（null = 不使用环境）。 */
  envOptions: ReadonlyArray<{ id: string; name: string }>;
  activeEnvId: string | null;
  /** 合并后的实时问题清单（徽标与下拉面板共用）。 */
  issues: ReadonlyArray<NodeIssue>;
}>();

const emit = defineEmits<{
  save: [];
  validate: [];
  run: [];
  cancel: [];
  undo: [];
  redo: [];
  layout: [];
  copy: [];
  paste: [];
  zoomIn: [];
  zoomOut: [];
  fit: [];
  refresh: [];
  export: [];
  envChange: [id: string | null];
  /** 点击问题条目定位节点（父级选中 + 画布居中）。 */
  locate: [issue: NodeIssue];
}>();

/** 校验问题下拉面板开关（点击校验按钮开合；定位条目 / 关闭按钮收起）。 */
const issuesOpen = ref(false);

/** 问题计数按最高级别配色：error 红 → warning 琥珀 → 仅 info 蓝（语义披露）。 */
const issueTone = computed<"error" | "warning" | "info" | null>(() => {
  if (props.issues.length === 0) return null;
  if (props.issues.some((issue) => issue.level === "error")) return "error";
  if (props.issues.some((issue) => issue.level === "warning")) return "warning";
  return "info";
});

/** 结构性编辑动作的 title 文案：锁定时说明原因，否则描述动作。 */
function editTitle(action: string, enabled: boolean): string | undefined {
  if (!enabled) return undefined;
  return props.locked ? `运行中不可编辑：${action}请等运行结束` : action;
}

/** 点击校验按钮：触发服务端校验并开合问题面板。 */
function onValidate(): void {
  issuesOpen.value = !issuesOpen.value;
  if (issuesOpen.value) emit("validate");
}

/** 点击问题条目：定位节点并收起面板。 */
function onLocate(issue: NodeIssue): void {
  issuesOpen.value = false;
  emit("locate", issue);
}
</script>

<template>
  <div class="flow-topbar" data-testid="canvas-toolbar">
    <template v-if="workflowName !== null">
      <span class="flow-topbar-name" :title="workflowName">{{ workflowName }}</span>
      <span
        class="flow-topbar-dot"
        :class="{ dirty, saving }"
        :title="saving ? '保存中…' : dirty ? '有未保存的修改，稍后自动保存' : '改动已自动保存'"
      />
      <select
        v-if="hasEnvApi"
        class="flow-topbar-env"
        aria-label="当前激活环境"
        title="环境变量集：节点参数以 {{ env.键名 }} 引用；运行开始时定格环境快照，切换对进行中的运行不生效（下次运行生效）"
        :value="activeEnvId ?? ''"
        @change="
          emit(
            'envChange',
            ($event.target as HTMLSelectElement).value === ''
              ? null
              : ($event.target as HTMLSelectElement).value,
          )
        "
      >
        <option value="">不使用环境</option>
        <option v-for="option in envOptions" :key="option.id" :value="option.id">
          {{ option.name }}
        </option>
      </select>

      <span class="flow-topbar-divider" />
      <button
        class="btn icon"
        :disabled="saving || !dirty"
        title="保存流程（Ctrl+S）"
        @click="emit('save')"
      >
        <Io5Save :size="15" />
      </button>
      <span class="flow-topbar-validate-host">
        <button
          class="btn icon"
          :disabled="validating"
          title="校验当前流程并展示问题清单"
          :aria-expanded="issuesOpen"
          @click="onValidate"
        >
          <Io5ShieldCheckmark :size="15" />
        </button>
        <span
          v-if="issueTone !== null"
          class="flow-topbar-issue-count"
          :class="issueTone"
          :title="`${issues.length} 个校验问题，点击「校验」查看`"
        >
          {{ issues.length }}
        </span>
        <!-- 问题下拉面板：条目点击定位对应节点 -->
        <div v-if="issuesOpen" class="flow-topbar-issues" data-testid="canvas-issues-panel">
          <div class="flow-topbar-issues-head">
            <span>校验结果</span>
            <button class="btn icon" title="关闭问题面板" @click="issuesOpen = false">
              <Io5Close :size="13" />
            </button>
          </div>
          <p v-if="issues.length === 0" class="flow-topbar-issues-empty">未发现问题</p>
          <button
            v-for="issue in issues"
            :key="`${issue.level}:${issue.code}:${issue.nodeIds.join()}`"
            type="button"
            class="flow-topbar-issue"
            :title="issue.nodeIds.length > 0 ? '点击定位对应节点' : issue.message"
            @click="onLocate(issue)"
          >
            <span class="flow-topbar-issue-dot" :class="issue.level" aria-hidden="true" />
            <span class="flow-topbar-issue-msg">{{ issue.message }}</span>
          </button>
        </div>
      </span>
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
        :disabled="exporting"
        title="导出当前流程为 JSON 文件"
        @click="emit('export')"
      >
        <Io5Download :size="15" />
      </button>
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
      <span class="flow-topbar-divider" />
      <button class="btn icon" title="放大" @click="emit('zoomIn')">
        <Io5AddCircleOutline :size="15" />
      </button>
      <button class="btn icon" title="缩小" @click="emit('zoomOut')">
        <Io5RemoveCircleOutline :size="15" />
      </button>
      <button class="btn icon" title="适配视口（全部节点）" @click="emit('fit')">
        <Io5ScanOutline :size="15" />
      </button>
      <button class="btn icon" title="刷新项目与流程列表" @click="emit('refresh')">
        <Io5Refresh :size="14" />
      </button>

      <template v-if="hasRunApi">
        <span class="flow-topbar-divider" />
        <button
          v-if="locked"
          class="btn"
          :disabled="cancelling"
          title="取消该流程当前进行中的运行"
          @click="emit('cancel')"
        >
          取消运行
        </button>
        <button
          v-else
          class="btn primary"
          :disabled="triggering"
          title="按最近保存的流程定义触发一次运行（未保存修改不参与）"
          @click="emit('run')"
        >
          运行
        </button>
      </template>
    </template>
    <template v-else>
      <span class="flow-topbar-name faint">未选择流程</span>
      <button class="btn icon" title="刷新项目与流程列表" @click="emit('refresh')">
        <Io5Refresh :size="14" />
      </button>
    </template>
  </div>
</template>

<style scoped>
.flow-topbar {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 3px;
  max-width: calc(100% - 120px);
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  box-shadow: var(--shadow-popup);
}

.flow-topbar-name {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.flow-topbar-name.faint {
  color: var(--text-faint);
  font-weight: 400;
}

/* 未保存点：琥珀=有改动、脉冲=保存中、灰=干净 */
.flow-topbar-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
  opacity: 0.5;
}
.flow-topbar-dot.dirty {
  background: var(--warning);
  opacity: 1;
}
.flow-topbar-dot.saving {
  background: var(--warning);
  opacity: 1;
  animation: topbar-dot-pulse 1s ease-in-out infinite;
}
@keyframes topbar-dot-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--warning) 45%, transparent);
  }
  50% {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning) 12%, transparent);
  }
}

.flow-topbar-env {
  max-width: 120px;
  min-height: 0;
  padding: 2px 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text-secondary);
  font-size: 11px;
}

.flow-topbar-divider {
  width: 1px;
  height: 16px;
  margin: 0 3px;
  background: var(--border);
}

/* 校验按钮的问题数徽标 + 下拉问题面板 */
.flow-topbar-validate-host {
  position: relative;
  display: inline-flex;
}
.flow-topbar-issue-count {
  position: absolute;
  top: -7px;
  right: -8px;
  z-index: 1;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 9px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
  color: #fff;
  pointer-events: none;
}
.flow-topbar-issue-count.error {
  background: var(--danger);
}
.flow-topbar-issue-count.warning {
  background: var(--warning);
  color: #1f2937;
}
.flow-topbar-issue-count.info {
  background: var(--accent);
}

.flow-topbar-issues {
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  width: min(420px, 72vw);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  box-shadow: var(--shadow-popup);
}
.flow-topbar-issues-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 6px 3px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}
.flow-topbar-issues-empty {
  margin: 0;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--text-secondary);
}
.flow-topbar-issue {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  padding: 4px 10px;
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.flow-topbar-issue:hover {
  background: var(--bg-hover);
}
.flow-topbar-issue-dot {
  flex: none;
  width: 7px;
  height: 7px;
  margin-top: 5px;
  border-radius: 50%;
}
.flow-topbar-issue-dot.error {
  background: var(--danger);
}
.flow-topbar-issue-dot.warning {
  background: var(--warning);
}
.flow-topbar-issue-dot.info {
  background: var(--accent);
}
.flow-topbar-issue-msg {
  flex: 1;
  min-width: 0;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-height: 1.4;
}
</style>
