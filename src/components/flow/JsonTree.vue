<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { copyText } from "../../utils/clipboard";
import { buildJsonTree, defaultExpanded, filterTree, stringifyNodeValue } from "./json-tree";
import type { JsonTreeNode, JsonValueKind } from "./json-tree";

/**
 * JSON 树查看器（移植上游 JsonTree.tsx，ReqFlow 复刻 Task 22 薄片 A）：
 * 递归渲染运行节点快照（入参 / 返回值 / 逐迭代明细）等任意 JSON 值。
 *
 * 能力：
 *   - 递归树渲染：可展开 / 折叠，容器默认展开前 2 层；直接子节点 > 200 或
 *     深度 > 6 的容器默认折叠（懒展开防大子树一次性渲染）；
 *   - 键 / 值类型分色（base.css token）；容器节点计数徽章；
 *   - 搜索：过滤匹配路径 / 键 / 值（filterTree 纯函数），命中高亮 + 计数，
 *     命中祖先链自动展开；
 *   - 复制：整树 JSON 复制（工具条按钮）+ 单节点复制（行内按钮，字符串取
 *     原文、容器取 pretty JSON、截断包装取 preview）；
 *   - 截断披露：`__truncated` 包装展示「已截断 · 原 N 字节」徽标，展开可见
 *     preview 文本（不尝试解析 preview）。
 */
const props = withDefaults(
  defineProps<{
    /** 待渲染的任意 JSON 安全值（节点快照 input / output 等）。 */
    value: unknown;
    /** 根节点 testId（搜索框等派生 id 的前缀）。 */
    testId?: string;
    /** 搜索框 aria-label（入参 / 返回值双 tab 区分用）。 */
    searchLabel?: string;
    /** 撑满模式：树主体占满父级余量并内部滚动（缺省随内容封顶 288px）。 */
    fillHeight?: boolean;
  }>(),
  { testId: "json-tree", searchLabel: "搜索键、值或路径", fillHeight: false },
);

/** 长文本行内展示上限：超出截断显示并以 title 提示完整内容（复制仍取全文）。 */
const MAX_INLINE_TEXT_LENGTH = 2000;

/** 复制成功提示的持续时间（毫秒）。 */
const COPIED_RESET_MS = 1500;

/** 值分类 → 文字颜色（base.css token；键名与数字同为 accent 蓝，对齐上游双蓝）。 */
const VALUE_COLOR: Record<JsonValueKind, string> = {
  object: "var(--text-secondary)",
  array: "var(--text-secondary)",
  string: "var(--success)",
  number: "var(--accent)",
  boolean: "var(--warning)",
  null: "var(--text-faint)",
  truncated: "var(--warning)",
};

/** 树模型随值构建；数据源变更时重置搜索与展开覆盖态（回到默认视图）。 */
const root = computed(() => buildJsonTree(props.value));
const query = ref("");
const opened = ref(new Set<string>());
const closed = ref(new Set<string>());
watch(root, () => {
  query.value = "";
  opened.value = new Set();
  closed.value = new Set();
});

const filterResult = computed(() => filterTree(root.value, query.value));
const searchActive = computed(() => query.value.trim() !== "");

/** 展开态解析：用户折叠最优先，其次手动展开，搜索态自动展开祖先链，最后默认规则。 */
function isExpanded(node: JsonTreeNode): boolean {
  const expandable = node.kind === "object" || node.kind === "array" || node.kind === "truncated";
  if (!expandable) return false;
  if (closed.value.has(node.path)) return false;
  if (opened.value.has(node.path)) return true;
  if (searchActive.value && filterResult.value.autoExpandPaths.has(node.path)) return true;
  // 截断节点无子节点，默认折叠（preview 懒展示）
  if (node.kind === "truncated") return false;
  return defaultExpanded(node.depth, node.childCount);
}

function toggle(node: JsonTreeNode): void {
  if (isExpanded(node)) {
    closed.value = new Set([...closed.value, node.path]);
    const next = new Set(opened.value);
    next.delete(node.path);
    opened.value = next;
  } else {
    opened.value = new Set([...opened.value, node.path]);
    const next = new Set(closed.value);
    next.delete(node.path);
    closed.value = next;
  }
}

/** 可见行：节点行或展开容器的闭括号行（按深度缩进）。 */
interface VisibleRow {
  node: JsonTreeNode;
  /** 非空时本行是容器闭括号（值为括号字符）。 */
  close?: string;
}

/**
 * 按展开态把树收敛为可见行序列（纯函数）：容器展开时递归子树并补闭括号行，
 * 折叠时只渲染本行（折叠态的 `…}` 在行内呈现）。截断节点总是单行，展开时
 * 模板在其后追加 preview 块。
 */
function flattenVisible(rootNode: JsonTreeNode): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (node: JsonTreeNode): void => {
    rows.push({ node });
    if (node.kind !== "object" && node.kind !== "array") return;
    if (!isExpanded(node)) return;
    for (const child of node.children) walk(child);
    rows.push({ node, close: node.kind === "object" ? "}" : "]" });
  };
  walk(rootNode);
  return rows;
}

const visibleRows = computed(() => {
  const tree = filterResult.value.tree;
  return tree === null ? [] : flattenVisible(tree);
});

/** 复制（成功后短暂显示「已复制」，失败静默）。 */
const copiedKey = ref<string | null>(null);
let copiedTimer: number | undefined;
async function copy(key: string, node: JsonTreeNode): Promise<void> {
  try {
    await copyText(stringifyNodeValue(node));
  } catch {
    return;
  }
  copiedKey.value = key;
  window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => {
    copiedKey.value = null;
  }, COPIED_RESET_MS);
}

/** 复制按钮文案。 */
function copyLabel(key: string): string {
  return copiedKey.value === key ? "已复制" : "复制";
}

/** 行内展示文本：超长截断。 */
function inlineText(text: string): string {
  return text.length <= MAX_INLINE_TEXT_LENGTH ? text : `${text.slice(0, MAX_INLINE_TEXT_LENGTH)}…`;
}
</script>

<template>
  <div class="json-tree" :class="{ 'fill-height': fillHeight }" :data-testid="testId">
    <!-- 工具条：搜索 + 命中计数 + 整树复制 -->
    <div class="json-tree-toolbar">
      <input
        v-model="query"
        type="search"
        class="input json-tree-search"
        :aria-label="searchLabel"
        :data-testid="`${testId}-search`"
        placeholder="搜索键 / 值 / 路径"
      />
      <span v-if="searchActive" class="json-tree-match" :data-testid="`${testId}-match-count`">
        {{ filterResult.matchCount > 0 ? `${filterResult.matchCount} 处命中` : "无命中" }}
      </span>
      <button
        type="button"
        class="json-tree-copy"
        :class="{ ok: copiedKey === '__root__' }"
        :data-testid="`${testId}-copy`"
        aria-label="复制整棵 JSON 树"
        @click="copy('__root__', root)"
      >
        {{ copyLabel("__root__") }} JSON
      </button>
    </div>

    <!-- 树主体：非搜索态渲染整棵树；搜索无命中展示空态 -->
    <div class="json-tree-body" :class="{ 'fill-height': fillHeight }">
      <p
        v-if="filterResult.tree === null"
        class="json-tree-no-match"
        :data-testid="`${testId}-no-match`"
      >
        没有匹配「{{ query.trim() }}」的键或值
      </p>
      <template v-else>
        <template
          v-for="row in visibleRows"
          :key="row.close ? `close-${row.node.path}` : row.node.path"
        >
          <div
            class="json-tree-row"
            :class="{ matched: row.node.matched }"
            :style="{ paddingLeft: `${row.node.depth * 14 + 4}px` }"
            :data-testid="`${testId}-row`"
            :data-path="row.node.path"
            :data-kind="row.node.kind"
          >
            <!-- 展开 / 折叠箭头：容器与截断节点可展开，其余占位对齐 -->
            <button
              v-if="
                row.node.kind === 'object' ||
                row.node.kind === 'array' ||
                row.node.kind === 'truncated'
              "
              type="button"
              class="json-tree-toggle"
              :aria-expanded="isExpanded(row.node)"
              :aria-label="`${isExpanded(row.node) ? '折叠' : '展开'} ${row.node.path || '根'}`"
              :data-testid="`${testId}-toggle`"
              @click="toggle(row.node)"
            >
              {{ isExpanded(row.node) ? "▾" : "▸" }}
            </button>
            <span v-else class="json-tree-toggle-placeholder" aria-hidden="true" />

            <span v-if="row.node.key !== null && row.node.key !== ''" class="json-tree-key">
              {{ row.node.key }}:
            </span>

            <!-- 闭括号行 / 值渲染：容器括号 + 计数徽章 / 标量分色 / 截断披露 -->
            <template v-if="row.close !== undefined">
              <span class="json-tree-bracket">{{ row.close }}</span>
            </template>
            <template v-else-if="row.node.kind === 'object' || row.node.kind === 'array'">
              <span class="json-tree-bracket">{{ row.node.kind === "object" ? "{" : "[" }}</span>
              <template v-if="!isExpanded(row.node)">
                <span v-if="row.node.childCount > 0" class="json-tree-bracket">…</span>
                <span class="json-tree-bracket">{{ row.node.kind === "object" ? "}" : "]" }}</span>
              </template>
              <span
                class="json-tree-count"
                :title="`子树共 ${row.node.totalCount} 个节点`"
                :data-testid="`${testId}-count`"
              >
                {{ row.node.childCount }} 项
              </span>
            </template>
            <template v-else-if="row.node.kind === 'truncated' && row.node.truncated !== null">
              <span
                class="json-tree-truncated"
                :data-testid="`${testId}-truncated-badge`"
                title="原值超过落库上限，仅保留前段预览文本"
              >
                已截断 · 原 {{ row.node.truncated.originalBytes }} 字节
              </span>
              <span class="json-tree-preview" :title="row.node.truncated.preview">
                {{ inlineText(row.node.truncated.preview) }}
              </span>
            </template>
            <span
              v-else
              class="json-tree-value"
              :style="{ color: VALUE_COLOR[row.node.kind] }"
              :title="
                row.node.kind === 'string' &&
                typeof row.node.raw === 'string' &&
                row.node.raw.length > MAX_INLINE_TEXT_LENGTH
                  ? row.node.raw
                  : undefined
              "
            >
              {{
                row.node.kind === "string"
                  ? `"${inlineText(String(row.node.value ?? ""))}"`
                  : String(row.node.value)
              }}
            </span>

            <span class="json-tree-row-copy">
              <button
                type="button"
                class="json-tree-copy"
                :class="{ ok: copiedKey === row.node.path }"
                :aria-label="`复制 ${row.node.path || '根'} 的值`"
                :data-testid="`${testId}-node-copy`"
                @click="copy(row.node.path, row.node)"
              >
                {{ copyLabel(row.node.path) }}
              </button>
            </span>
          </div>

          <!-- 截断节点的 preview 展开块（不尝试解析 preview，原样文本展示） -->
          <pre
            v-if="
              row.close === undefined &&
              row.node.kind === 'truncated' &&
              row.node.truncated !== null &&
              isExpanded(row.node)
            "
            class="json-tree-truncated-preview"
            :style="{ marginLeft: `${row.node.depth * 14 + 4}px` }"
            :data-testid="`${testId}-truncated-preview`"
            >{{ row.node.truncated.preview }}</pre>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.json-tree {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  min-width: 0;
}
.json-tree.fill-height {
  flex: 1;
  min-height: 120px;
}

.json-tree-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: 5px var(--space-2);
  border-bottom: 1px solid var(--border);
  flex: none;
}
.json-tree-search {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 2px 8px;
  font-size: 12px;
}
.json-tree-match {
  flex: none;
  font-size: 12px;
  color: var(--text-secondary);
}

.json-tree-body {
  overflow-y: auto;
  padding: var(--space-1);
  max-height: 288px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
}
.json-tree-body.fill-height {
  flex: 1;
  min-height: 0;
  max-height: none;
}

.json-tree-no-match {
  margin: 0;
  padding: var(--space-4) var(--space-2);
  text-align: center;
  color: var(--text-faint);
  font-family: var(--font-ui);
  font-size: 12px;
}

.json-tree-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  border-radius: var(--radius-sm);
  padding: 1px 4px;
}
.json-tree-row:hover {
  background: var(--bg-hover);
}
.json-tree-row.matched {
  background: var(--bg-selected);
}

.json-tree-toggle {
  flex: none;
  margin-top: 2px;
  padding: 0;
  border: none;
  background: none;
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.json-tree-toggle:hover {
  color: var(--text);
}
.json-tree-toggle-placeholder {
  flex: none;
  width: 10px;
}

.json-tree-key {
  flex: none;
  color: var(--accent);
}
.json-tree-bracket {
  color: var(--text-secondary);
}
.json-tree-count {
  flex: none;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--bg-active);
  color: var(--text-faint);
  font-family: var(--font-ui);
  font-size: 10px;
  line-height: 15px;
}
.json-tree-value {
  min-width: 0;
  word-break: break-all;
  white-space: pre-wrap;
}

.json-tree-truncated {
  flex: none;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  color: var(--warning);
  font-family: var(--font-ui);
  font-size: 10px;
  line-height: 15px;
}
.json-tree-preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-faint);
}
.json-tree-truncated-preview {
  margin: 2px 4px 4px;
  padding: 4px 8px;
  overflow-x: auto;
  border: 1px solid color-mix(in srgb, var(--warning) 20%, transparent);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.json-tree-row-copy {
  margin-left: auto;
  flex: none;
  opacity: 0;
}
.json-tree-row:hover .json-tree-row-copy,
.json-tree-row-copy:focus-within {
  opacity: 1;
}
.json-tree-copy {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text-faint);
  font-family: var(--font-ui);
  font-size: 10px;
  line-height: 16px;
  cursor: pointer;
}
.json-tree-copy:hover {
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  color: var(--text);
}
.json-tree-copy.ok {
  border-color: color-mix(in srgb, var(--success) 60%, transparent);
  color: var(--success);
}
</style>
