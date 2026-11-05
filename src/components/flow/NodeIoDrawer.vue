<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { buildInputFieldSnippet, buildNodeFieldSnippet, writeIoPathPayload } from "./template-dnd";
import {
  buildFieldTree,
  countFieldNodes,
  filterFieldTree,
  flattenFieldTree,
  type IoFieldRow,
  type IoFieldTreeNode,
} from "./io-field-tree";

/**
 * 节点入参 / 出参抽屉（ReqFlow 复刻计划 Task 15 薄片 B Step 3，形态随后续
 * 薄片演进为入参 / 出参分 tab，与右侧配置抽屉的 tab 口径一致）。
 *
 * 形态自归档 `_archive/reqflow/src/app/pages/editor/NodeIoDrawer.tsx @ 485fa00`
 * 移植（React + Radix OverlayDrawer → 本仓 Vue 3 scoped 样式 + 固定定位抽屉
 * 壳；入参 / 出参 tab 切换替代上游平铺双分组，可展开字段树替代上游扁平
 * chip 流 + JSON 树查看器双轨）：入参 / 出参 JSON 样本经 collectJsonPaths
 * 展开为字段树，字段行 chip 点击复制模板引用，起拖经自定义 MIME（见
 * template-dnd.ts）落入表达式输入框生成引用——落点接线由表达式输入侧消费
 * `ExpressionInput.insertSnippet`（内部走 buildDropInsertPlan），插入路径
 * 单一出口。
 *
 * 复制规则两种形态（与上游一致、对齐运行时语义）：
 *   - 入参：裸路径简写 `{{ headers.x-token }}`（等价 `input.<path>`，当前
 *     节点配置内引用的主形态，见 buildInputFieldSnippet）；
 *   - 出参：带节点前缀 `{{ node.<refId>.<path> }}`（给下游节点用；多上游
 *     聚合时入参是 `{ 引用键: 输出 }` 对象，裸路径会有歧义）。
 *
 * 样本标注：trialPaths 命中的字段行加「样本」徽标（脚本试跑与运行记录的
 * checkpoint 都会并入样本桶，见 stores/flow-trial.ts）。搜索框按路径段前缀 +
 * 整路径子串过滤（同 io-field-tree 口径，与提示浮层「能补全的」一致）；长
 * 路径省略号截断、title 展示完整引用。
 *
 * tab 口径：切节点复位到「入参」；当前 tab 无样本而另一 tab 有数据时自动
 * 切换（开始节点只有出参等场景），两侧都有数据后以手动选择优先。
 *
 * 全部数据由 props 注入（nodeRefId / inputSample / outputSample /
 * trialPaths），不自带会话态；open 受控（缺省 true——调用方亦可直接 v-if
 * 控制挂载），Esc / 关闭按钮只 emit close，抽屉叠放与目标节点选择由接线
 * 薄片负责。
 */

const props = withDefaults(
  defineProps<{
    /** 节点引用 id（出参模板前缀 `node.<refId>` 段；同时是搜索 / 展开态的复位信号） */
    nodeRefId: string;
    /** 节点展示名（头部徽标；缺省回退 nodeRefId） */
    nodeLabel?: string;
    /** 是否打开（受控；false 不渲染。Esc / 关闭按钮 emit close，不改自身状态） */
    open?: boolean;
    /** 入参 JSON 样本（最近一次运行入参 / 上游输出聚合；缺省或 null = 暂无数据） */
    inputSample?: unknown | null;
    /** 出参 JSON 样本（最近一次运行输出 / 试跑输出；缺省或 null = 暂无数据） */
    outputSample?: unknown | null;
    /** 来自试跑结果的字段路径集合（与各组字段树节点 path 同一口径；命中加「试跑」徽标） */
    trialPaths?: ReadonlyArray<string>;
  }>(),
  // 缺省必须显式给 true：Vue 对 Boolean prop 的转换是「调用方完全省略 →
  // 填 false」（显式传 undefined 才保持 undefined），`open !== false` 的
  // 写法拦不住省略场景，曾致入参 / 出参抽屉挂载后整体不渲染。
  { open: true },
);

const emit = defineEmits<{ close: [] }>();

const isOpen = computed(() => props.open !== false);

/** 复制成功「已复制」提示的持续时间（毫秒；与上游 IO_COPIED_RESET_MS 同节奏） */
const COPIED_RESET_MS = 1500;

/** 搜索关键词（两组共用；换节点复位） */
const query = ref("");
/** 手动展开的字段路径集（顶层默认展开、搜索时全展开，见 expandedFor） */
const expandedPaths = ref(new Set<string>());

watch(
  () => props.nodeRefId,
  () => {
    query.value = "";
    expandedPaths.value = new Set();
    activeTab.value = "input";
  },
);

/** 试跑路径集（Set 查找；prop 变化时重建） */
const trialSet = computed(() => new Set(props.trialPaths ?? []));

/** 当前激活的样本 tab（切节点复位入参；无样本时自动切到有数据的一侧） */
const activeTab = ref<"input" | "output">("input");

/** 单组展开判定：搜索时全展开（命中的深层字段直接可见）；顶层默认展开；
 * 其余按用户手动展开集 */
function expandedFor(
  searching: boolean,
  expanded: Set<string>,
): (node: IoFieldTreeNode) => boolean {
  return (node) => searching || node.depth === 0 || expanded.has(node.path);
}

/**
 * 单组视图：树构造 → 搜索过滤 → 展开行扁平化 + 计数。
 * 样本规模受 collectJsonPaths 上限（60 路径）约束，直接重算即可。
 */
function groupView(sample: unknown, keyword: string, expanded: Set<string>) {
  const tree = buildFieldTree(sample);
  const filtered = filterFieldTree(tree, keyword);
  const searching = keyword.trim() !== "";
  return {
    rows: flattenFieldTree(filtered, expandedFor(searching, expanded)),
    shown: countFieldNodes(filtered),
    total: countFieldNodes(tree),
    hasSample: sample !== null && sample !== undefined,
  };
}

/** 两组完整视图（tab 头计数与激活 tab 的主体渲染共用） */
const groupDefs = computed(() => {
  const inputSample = props.inputSample ?? null;
  const outputSample = props.outputSample ?? null;
  return [
    {
      key: "input" as const,
      title: "入参",
      view: groupView(inputSample, query.value, expandedPaths.value),
    },
    {
      key: "output" as const,
      title: "出参",
      view: groupView(outputSample, query.value, expandedPaths.value),
    },
  ];
});

/**
 * tab 自动回退：当前 tab 无样本、另一 tab 有数据时切过去（开始节点只有
 * 出参等场景；两侧都有数据后本规则不再触发，手动选择优先）。
 */
watch(
  [activeTab, () => [props.inputSample ?? null, props.outputSample ?? null]],
  ([tab, samples]) => {
    const activeHasSample = samples[tab === "input" ? 0 : 1] !== null;
    if (activeHasSample) return;
    const other: "input" | "output" = tab === "input" ? "output" : "input";
    if (samples[other === "input" ? 0 : 1] !== null) activeTab.value = other;
  },
);

/** 当前激活组的视图（主体只渲染激活 tab；组头计数并入 tab 标签）。 */
const activeGroup = computed(
  () => groupDefs.value.find((item) => item.key === activeTab.value) ?? groupDefs.value[0],
);

/** 组内模板片段形态：入参裸路径简写；出参带节点前缀（详见模块头复制规则） */
function snippetFor(group: "input" | "output", path: string): string {
  return group === "input"
    ? buildInputFieldSnippet(path)
    : buildNodeFieldSnippet(props.nodeRefId, path);
}

/** 手动展开 / 收起某字段（新 Set 触发响应；搜索清除后恢复手动展开态） */
function toggleNode(row: IoFieldRow): void {
  const next = new Set(expandedPaths.value);
  if (next.has(row.path)) next.delete(row.path);
  else next.add(row.path);
  expandedPaths.value = next;
}

const copiedPath = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

/** 写剪贴板：优先异步 Clipboard API；失败回退隐藏 textarea + execCommand
 * （非安全上下文 / 权限被拒场景），与上游 copyJsonTreeText 的兜底思路一致 */
async function writeClipboardText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  }
}

/** chip 点击：复制该组对应形态的模板引用，成功后短暂展示「已复制」 */
async function copyField(group: "input" | "output", path: string): Promise<void> {
  const ok = await writeClipboardText(snippetFor(group, path));
  if (!ok) return;
  copiedPath.value = path;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedPath.value = null;
  }, COPIED_RESET_MS);
}

/** chip 起拖：写入拖放载荷（自定义 MIME + text/plain 兜底，与点击复制完全
 * 同形，见 template-dnd.ts）；copy 效果提示（不限定 move 避免移动语义） */
function onChipDragStart(event: DragEvent, group: "input" | "output", path: string): void {
  if (!event.dataTransfer) return;
  writeIoPathPayload(event.dataTransfer, snippetFor(group, path));
  event.dataTransfer.effectAllowed = "copy";
}

/** Esc 关抽屉（冒泡阶段监听；表达式输入建议浮层打开时其 Esc 已 stopPropagation，
 * 不会误关抽屉） */
function onWindowKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

watch(
  isOpen,
  (open) => {
    if (open) window.addEventListener("keydown", onWindowKeyDown);
    else window.removeEventListener("keydown", onWindowKeyDown);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWindowKeyDown);
  clearTimeout(copiedTimer);
});
</script>

<template>
  <aside
    v-if="isOpen"
    class="io-drawer"
    role="dialog"
    aria-label="节点数据：入参 / 出参"
    data-testid="node-io-drawer"
  >
    <header class="io-drawer-head">
      <div class="io-drawer-heading">
        <span class="io-drawer-title">入参 / 出参</span>
        <span class="io-drawer-node mono" :title="props.nodeLabel ?? props.nodeRefId">
          {{ props.nodeLabel ?? props.nodeRefId }}
        </span>
      </div>
      <button
        type="button"
        class="btn icon io-drawer-close"
        aria-label="关闭节点数据面板"
        data-testid="node-io-drawer-close"
        @click="emit('close')"
      >
        ✕
      </button>
    </header>
    <div class="io-drawer-tabs" role="tablist" aria-label="节点样本分页">
      <button
        v-for="group in groupDefs"
        :key="group.key"
        type="button"
        class="io-drawer-tab"
        :class="{ active: activeTab === group.key }"
        role="tab"
        :aria-selected="activeTab === group.key"
        :data-testid="`node-io-tab-${group.key}`"
        @click="activeTab = group.key"
      >
        {{ group.title }}
        <span class="io-drawer-tab-count mono">{{
          group.view.total > 0 ? group.view.total : ""
        }}</span>
      </button>
    </div>
    <div class="io-drawer-toolbar">
      <input
        v-model="query"
        type="text"
        class="input io-drawer-search"
        placeholder="搜索字段路径…"
        aria-label="搜索字段路径"
        spellcheck="false"
        data-testid="node-io-path-search"
      />
      <span class="io-drawer-hint">点击复制 · 拖入表达式输入框生成引用</span>
    </div>
    <div class="io-drawer-body">
      <section class="io-group">
        <div
          v-if="activeGroup.view.rows.length > 0"
          class="io-tree"
          :data-testid="`node-io-${activeGroup.key}-tree`"
        >
          <div
            v-for="row in activeGroup.view.rows"
            :key="row.path"
            class="io-field"
            :style="{ paddingLeft: `${row.depth * 14}px` }"
          >
            <span
              v-if="row.hasChildren"
              class="io-field-caret"
              :class="{ open: row.expanded }"
              role="button"
              :aria-label="row.expanded ? `收起 ${row.name} 子字段` : `展开 ${row.name} 子字段`"
              :aria-expanded="row.expanded"
              @click="toggleNode(row)"
            >
              ▸
            </span>
            <span v-else class="io-field-leaf-dot" aria-hidden="true" />
            <button
              type="button"
              class="io-field-chip"
              :class="{ copied: copiedPath === row.path }"
              :draggable="true"
              :data-path="row.path"
              :data-testid="
                activeGroup.key === 'input' ? 'node-io-input-path' : 'node-io-output-path'
              "
              :title="snippetFor(activeGroup.key, row.path)"
              @click="copyField(activeGroup.key, row.path)"
              @dragstart="onChipDragStart($event, activeGroup.key, row.path)"
            >
              <span class="io-field-name mono">{{ row.name }}</span>
              <span
                v-if="trialSet.has(row.path)"
                class="io-field-trial"
                title="来自试跑 / 运行样本"
              >
                样本
              </span>
              <span v-if="copiedPath === row.path" class="io-field-copied">已复制</span>
            </button>
          </div>
        </div>
        <p v-else-if="activeGroup.view.hasSample" class="io-group-empty">
          该值没有可下钻的字段（原始值 / 空）。
        </p>
        <p v-else class="io-group-empty">
          暂无样本数据：该节点运行 / 试跑后在此展示，可一键复制模板引用。
        </p>
        <p
          v-if="activeGroup.view.shown !== activeGroup.view.total"
          class="io-group-match text-faint"
        >
          匹配 {{ activeGroup.view.shown }} / {{ activeGroup.view.total }} 字段
        </p>
      </section>
    </div>
  </aside>
</template>

<style scoped>
/* 抽屉壳：贴左侧滑出、非模态（无遮罩），与右侧配置抽屉并排的形态预留；
 * z-index 对齐 flow 窗面弹层级（RequestPicker 同层 30，接线薄片可按叠放
 * 需求调整） */
.io-drawer {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  width: min(480px, 100vw);
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  box-shadow: var(--shadow-window);
}

/* 头部：标题 + 节点徽标 + 关闭按钮 */
.io-drawer-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
}

.io-drawer-heading {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: var(--space-2);
}

.io-drawer-title {
  flex: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.io-drawer-node {
  min-width: 0;
  overflow: hidden;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg-active);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.io-drawer-close {
  flex: none;
  margin-left: auto;
}

/* tab 行：入参 / 出参分页（口径同右侧配置抽屉的 wf-drawer-tab） */
.io-drawer-tabs {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3) 0;
  border-bottom: 1px solid var(--border);
}

.io-drawer-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px 4px;
  border: none;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: none;
  color: var(--text-faint);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.io-drawer-tab:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.io-drawer-tab.active {
  background: var(--bg-active);
  color: var(--text);
  font-weight: 600;
}

.io-drawer-tab-count {
  color: var(--text-faint);
  font-size: 10px;
}

/* 工具行：搜索框（激活 tab 内过滤）+ 操作提示 */
.io-drawer-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
}

.io-drawer-search {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 2px 8px;
  font-family: var(--font-mono);
  font-size: 12px;
}

.io-drawer-hint {
  flex: none;
  color: var(--text-faint);
  font-size: 10px;
  white-space: nowrap;
}

/* 主体：激活 tab 的字段树（搜索命中计数贴底提示） */
.io-drawer-body {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: var(--space-1) 0 var(--space-2);
}

.io-group {
  min-width: 0;
}

.io-group-empty {
  margin: 0;
  padding: var(--space-2) var(--space-3) 0;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 18px;
}

.io-group-match {
  margin: 0;
  padding: var(--space-2) var(--space-3) 0;
  font-size: 10px;
}

/* 字段行：缩进表层级；箭头 / 叶子圆点 + chip 主体 */
.io-field {
  display: flex;
  min-width: 0;
  align-items: center;
  padding-right: var(--space-3);
}

.io-field-caret {
  display: inline-flex;
  flex: none;
  width: 14px;
  height: 18px;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  cursor: pointer;
  font-size: 9px;
  transition: transform 0.12s;
  user-select: none;
}

.io-field-caret:hover {
  color: var(--text);
}

.io-field-caret.open {
  transform: rotate(90deg);
}

.io-field-leaf-dot {
  display: inline-flex;
  flex: none;
  width: 14px;
  justify-content: center;
}

.io-field-leaf-dot::before {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--border-strong);
  content: "";
}

/* chip 主体：整行可点（复制）可拖（起拖），hover 描边提示可交互 */
.io-field-chip {
  display: inline-flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 4px;
  height: 22px;
  margin: 1px 0;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  transition:
    background 0.12s,
    border-color 0.12s,
    color 0.12s;
}

.io-field-chip:hover {
  background: var(--bg-hover);
  border-color: var(--border);
  color: var(--text);
}

.io-field-chip:active {
  background: var(--bg-active);
}

.io-field-chip.copied {
  border-color: var(--success);
  color: var(--success);
}

.io-field-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 试跑徽标：accent 着色的浅底徽标，title 展开完整语义 */
.io-field-trial {
  flex: none;
  padding: 0 4px;
  border-radius: 7px;
  background: var(--bg-selected);
  color: var(--accent);
  font-size: 10px;
  line-height: 14px;
}

.io-field-copied {
  flex: none;
  color: var(--success);
  font-size: 10px;
}
</style>
