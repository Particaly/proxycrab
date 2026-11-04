/**
 * 循环节点（loop）配置表单（LoopConfig.vue）的纯函数层：数据源 / CSV / 迭代
 * 上限 / 并发数 / 迭代间隔的输入解析、校验与落库分片组装。
 *
 * 语义全部对齐引擎（flow-engine/src/logic-nodes.ts，M7-T1 + M10-T6）：
 *   - items：JSON 数组字面量或含 {{ }} 的模板字符串（渲染后 JSON.parse，结果
 *     非数组 → 节点 failed）；无 {{ }} 的纯字面量保存前即时 JSON 校验；
 *   - csvText：CSV 数据源文本，配置时**优先于 items**（引擎口径，items 被忽略）；
 *   - csvDelimiter：仅 ',' / ';' / '\t' 合法（非法值读入回退逗号，Rust 侧
 *     CsvDelimiter::deserialize_lenient 同语义）；
 *   - maxIterations：缺省 DEFAULT_LOOP_MAX_ITERATIONS（100），硬上限
 *     LOOP_HARD_MAX_ITERATIONS（1000）——数据源超上限只执行前 N 项，不报错；
 *   - concurrency：1 ~ LOOP_MAX_CONCURRENCY（16），缺省 1 = 串行；> 1 时
 *     迭代变量按迭代隔离、结束后按完成顺序合并（引擎 overlay 行为，表单侧
 *     以就地说明披露）；
 *   - intervalMs：0 ~ 60000，缺省 0 = 不等待。
 *
 * 落库惯例（与归档 LogicNodeDrawer 保存形状一致）：maxIterations 恒落键；
 * concurrency 仅 > 1 落键、intervalMs 仅 > 0 落键（缺省值不落键，与执行层
 * 对缺省的解释一致）；csvText 非空落键、csvDelimiter 非逗号才落键（逗号是
 * 缺省，Rust serde default）。
 */

import {
  DEFAULT_LOOP_MAX_ITERATIONS,
  LOOP_HARD_MAX_ITERATIONS,
  LOOP_MAX_CONCURRENCY,
} from "../../../../flow-engine/src/logic-nodes";

/** 循环节点 config 中循环表单消费的分片（NodeConfig 相关字段的宽容子集） */
export interface LoopConfigShard {
  items?: unknown;
  maxIterations?: number;
  csvText?: string;
  csvDelimiter?: string;
  concurrency?: number;
  intervalMs?: number;
}

/** 输入解析结果：value 为落库值（缺省不落键时为 undefined）；error 为错误文案 */
export interface ParsedInput<T> {
  value?: T;
  error?: string;
}

/** 迭代上限的落库值（输入留空时取引擎缺省 100） */
export const LOOP_DEFAULT_MAX_ITERATIONS = DEFAULT_LOOP_MAX_ITERATIONS;

/**
 * 迭代上限输入 → 落库值：留空 = 缺省 100（恒落键）；非正整数 / 超硬上限
 * （1000）报错。0 合法（= 不执行任何迭代，与引擎「只执行前 N 项」口径一致）。
 */
export function parseLoopMaxIterations(text: string): ParsedInput<number> {
  const trimmed = text.trim();
  if (trimmed === "") return { value: DEFAULT_LOOP_MAX_ITERATIONS };
  if (!/^\d+$/.test(trimmed)) return { error: "迭代上限需为非负整数" };
  const value = Number.parseInt(trimmed, 10);
  if (value > LOOP_HARD_MAX_ITERATIONS) {
    return { error: `迭代上限需为 0~${LOOP_HARD_MAX_ITERATIONS} 的整数（硬上限 ${LOOP_HARD_MAX_ITERATIONS} 轮）` };
  }
  return { value };
}

/** 并发数输入 → 落库值：留空 = 1（不落键）；越界 / 非法报错 */
export function parseLoopConcurrency(text: string): ParsedInput<number> {
  const trimmed = text.trim();
  if (trimmed === "") return { value: 1 };
  if (!/^\d+$/.test(trimmed)) return { error: `并发数需为 1~${LOOP_MAX_CONCURRENCY} 的整数` };
  const value = Number.parseInt(trimmed, 10);
  if (value < 1 || value > LOOP_MAX_CONCURRENCY) {
    return { error: `并发数需为 1~${LOOP_MAX_CONCURRENCY} 的整数` };
  }
  return { value };
}

/** 迭代间隔输入 → 落库值：留空 = 0（不落键）；越界 / 非法报错 */
export function parseLoopIntervalMs(text: string): ParsedInput<number> {
  const trimmed = text.trim();
  if (trimmed === "") return { value: 0 };
  if (!/^\d+$/.test(trimmed)) return { error: "迭代间隔需为 0~60000 的整数（毫秒）" };
  const value = Number.parseInt(trimmed, 10);
  if (value > 60000) return { error: "迭代间隔需为 0~60000 的整数（毫秒）" };
  return { value };
}

/**
 * 数据源文本 → 落库 items：留空 = 不落键（引擎缺省空数组）；含 {{ → 模板
 * 字符串原样（留待运行期渲染校验）；纯字面量即时 JSON 校验且必须是数组。
 */
export function parseLoopItemsText(text: string): ParsedInput<string> {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  if (trimmed.includes("{{")) return { value: trimmed };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return { error: 'items 需为 JSON 数组（如 ["a","b"] 或 [{},{},{}]）' };
    }
  } catch (error) {
    return { error: `items 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
  return { value: trimmed };
}

/** CSV 分隔符的合法取值 */
export type LoopCsvDelimiter = "," | ";" | "\t";

/** CSV 分隔符候选（下拉选项；value 为落库值） */
export const LOOP_CSV_DELIMITERS: ReadonlyArray<{ value: LoopCsvDelimiter; label: string }> = [
  { value: ",", label: "逗号（,）" },
  { value: ";", label: "分号（;）" },
  { value: "\t", label: "制表符（Tab）" },
];

/** 分隔符值容错解析（脏数据回退逗号，与 Rust CsvDelimiter 读入口径一致） */
export function parseLoopCsvDelimiter(value: unknown): LoopCsvDelimiter {
  return value === ";" || value === "\t" ? value : ",";
}

/**
 * 循环表单的整体校验（保存门控数据源；逐字段解析取首条错误）：
 * 数据源（items 字面量 JSON）→ 迭代上限 → 并发数 → 迭代间隔。
 *
 * @returns 合法返回 null；非法返回可直接展示的错误文案
 */
export function validateLoopDraft(draft: {
  itemsText: string;
  maxIterationsText: string;
  concurrencyText: string;
  intervalText: string;
}): string | null {
  return (
    parseLoopItemsText(draft.itemsText).error ??
    parseLoopMaxIterations(draft.maxIterationsText).error ??
    parseLoopConcurrency(draft.concurrencyText).error ??
    parseLoopIntervalMs(draft.intervalText).error ??
    null
  );
}

/**
 * 编辑草稿 → 循环节点 config 落库分片（保存出口）。惯例：
 *   - items 非空落键（trim 后原文；CSV 文本非空时仍落——引擎以 csvText 优先）；
 *   - maxIterations 恒落键（留空 = 缺省 100）；
 *   - csvText 非空落键；csvDelimiter 仅非逗号落键（逗号 = 缺省不落）；
 *   - concurrency 仅 > 1 落键；intervalMs 仅 > 0 落键。
 * 输入非法时对应键不落（保存由 validateLoopDraft 门控，此处兜底不抛错）。
 */
export function buildLoopShard(draft: {
  itemsText: string;
  maxIterationsText: string;
  csvText: string;
  csvDelimiter: LoopCsvDelimiter;
  concurrencyText: string;
  intervalText: string;
}): LoopConfigShard {
  const items = parseLoopItemsText(draft.itemsText);
  const maxIterations = parseLoopMaxIterations(draft.maxIterationsText);
  const concurrency = parseLoopConcurrency(draft.concurrencyText);
  const interval = parseLoopIntervalMs(draft.intervalText);
  const csvText = draft.csvText.trim();
  return {
    ...(items.value !== undefined ? { items: items.value } : {}),
    ...(maxIterations.value !== undefined ? { maxIterations: maxIterations.value } : {}),
    ...(csvText !== "" ? { csvText } : {}),
    ...(draft.csvDelimiter !== "," ? { csvDelimiter: draft.csvDelimiter } : {}),
    ...(concurrency.value !== undefined && concurrency.value > 1 ? { concurrency: concurrency.value } : {}),
    ...(interval.value !== undefined && interval.value > 0 ? { intervalMs: interval.value } : {}),
  };
}

/** 脏数据防御地读 config 分片的 items 文本（数组字面量按两空格缩进 JSON 还原为可编辑文本） */
export function loopItemsText(config: LoopConfigShard): string {
  const raw = config.items;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return JSON.stringify(raw, null, 2);
  return "";
}
