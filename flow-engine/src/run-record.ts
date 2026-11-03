/**
 * 运行记录构建与快照体积控制（M5-T5）。
 *
 * 背景（ROADMAP R2）：节点 output 可能携带超大响应体，原样落库会撑爆 IndexedDB。
 * 本模块提供纯函数能力（零环境依赖，不依赖 React / 存储 / chrome.*，node 可直接
 * 单测），是 run 落库前的唯一体积防线：
 *
 *  1. capSnapshot：把任意快照值（节点 input / output）按 UTF-8 序列化字节数收敛到
 *     上限内。截断策略分两类——
 *       - 字符串：直接截断文本，尾部追加 TRUNCATION_MARKER（含原始字节数与字段
 *         label），自识别、自说明；
 *       - 对象 / 数组：整体序列化后截断为 preview 文本，包一层 TruncatedSnapshot
 *         结构 `{ __truncated: true, preview: string, originalBytes: number }`
 *         （结构文档化契约：读侧用 isTruncatedSnapshot 识别截断快照，preview 为
 *         原值序列化文本的前段）。
 *
 *  2. buildRunRecord：汇总 M5-T1 的 RunSummary 生成完整 RunRecord（落库形态）：
 *       - nodeRuns 各节点的 input / output 分别过 capSnapshot；
 *       - M13-T9：循环节点的逐迭代明细（NodeRun.iterations.records）同步收敛
 *         ——每轮的 item / output 与节点快照同一档位过 capSnapshot（整体降级
 *         时同步收紧，见 capIterationsSummary）；
 *       - 「最后一次执行」语义：同一节点重跑以最后一次为准。executor 语义上节点
 *         在一次运行内至多执行一次，覆盖式合并由 updateNodeRunSnapshot 提供
 *         （run-store.recordNodeRun 落库路径使用，防 M7 循环节点重跑丢记录）；
 *       - 整条 RunRecord 序列化超过 RUN_RECORD_MAX_BYTES（2MB）时，逐节点把快照
 *         上限降到 DEGRADED_SNAPSHOT_BYTES（64KB）并继续对半收紧，直至合规
 *         （或达到 MIN_DEGRADED_SNAPSHOT_BYTES 下限——极端节点规模下如实放行，
 *         不无限循环）。
 *
 * 体积口径：一律按 UTF-8 字节数（TextEncoder），中文等多字节字符不会按字符数
 * 低估。截断幂等：对已截断的值再次 capSnapshot（同上限）原样返回；上限收紧时
 * preview / 文本继续收缩，originalBytes 始终保留最原始值的字节数。
 *
 * 边界声明：本模块只做体积控制，不做数据清洗。进入 run 的数据约定为 JSON 安全
 * （脚本边界已过 sanitizeJson，见 script.ts；httpReplay runner 产出 JSON 形态）。
 * 不可序列化值（循环引用 / BigInt 等，JSON.stringify 抛错）按占位文本计量：
 * 未超限时原样透传（IndexedDB 结构化克隆本身支持循环引用），超限时按截断处理，
 * 不会因序列化失败而抛错。上限小于截断标记自身字节数的病理配置下，以「有界 +
 * 结构完整」优先，允许结果略超上限。
 */

import type {
  LoopIterationRecord,
  LoopIterationsSummary,
  NodeId,
  NodeRun,
  RunId,
  RunRecord,
  RunTrigger,
  Timestamp,
  WorkflowId,
} from "./types";
import type { RunSummary } from "./executor";
import { cutToUtf8Bytes, utf8ByteLength, utf8Encode } from "./utf8";

// 【宿主注入点替换】归档此处用 TextEncoder / TextDecoder 计量与截断 UTF-8 字节；
// QuickJS 无该全局，改用 utf8.ts 的纯 JS 等价实现（utf8ByteLength / utf8Encode /
// utf8Decode / cutToUtf8Bytes，语义对齐 WHATWG Encoding），体积口径不变。

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 单快照（每节点 input / output）默认字节上限：256KB（capSnapshot / buildRunRecord 均可配覆盖） */
export const SNAPSHOT_MAX_BYTES = 256 * 1024;

/** 整条 RunRecord 序列化后的默认字节上限：2MB */
export const RUN_RECORD_MAX_BYTES = 2 * 1024 * 1024;

/** 整体超限后的首个降级档位（单快照字节上限）：64KB，其后逐级对半收紧 */
export const DEGRADED_SNAPSHOT_BYTES = 64 * 1024;

/** 降级档位下限：再收紧失去可读价值，达到后如实放行（极端节点规模） */
export const MIN_DEGRADED_SNAPSHOT_BYTES = 128;

/** 截断标记：被截断的字符串尾部与截断包装 preview 尾部都携带，读侧识别依据 */
export const TRUNCATION_MARKER = "…[ReqFlow 快照已截断]";

/* ------------------------------------------------------------------ *
 * 截断包装结构（读侧识别契约）
 * ------------------------------------------------------------------ */

/**
 * 截断快照包装：对象 / 数组超限时的落库形态（结构文档化，读侧能识别）。
 * preview 为原值 JSON 序列化文本的前段（可能因整体降级被再次截断）；
 * originalBytes 为最初未截断原值序列化后的 UTF-8 字节数。
 */
export interface TruncatedSnapshot {
  /** 截断标记，恒为 true */
  __truncated: true;
  /** 原值序列化文本的前段 + 截断尾部标记 */
  preview: string;
  /** 最初原值序列化后的 UTF-8 字节数（降级重截断时保持不变） */
  originalBytes: number;
}

/**
 * 判断值是否为截断快照包装（读侧识别入口；字段齐全才认定，避免误伤普通对象）。
 *
 * @param value 任意值
 * @returns 是包装时收窄为 TruncatedSnapshot
 */
export function isTruncatedSnapshot(value: unknown): value is TruncatedSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["__truncated"] === true &&
    typeof record["preview"] === "string" &&
    typeof record["originalBytes"] === "number"
  );
}

/** capSnapshot 结果：value 为处理后（可能截断）的值 */
export interface SnapshotCapResult {
  /** 未超限时为原值（同引用）；超限时为截断字符串或 TruncatedSnapshot 包装 */
  value: unknown;
  /** 本次调用是否发生了截断 */
  capped: boolean;
  /** 截断发生时：原值序列化后的 UTF-8 字节数 */
  originalBytes?: number;
}

/* ------------------------------------------------------------------ *
 * 字节计量与截断工具
 * ------------------------------------------------------------------ */

const UTF8_ENCODER = { encode: utf8Encode };

/** JSON 序列化的安全包装：失败（循环引用 / BigInt 等）退化为占位文本，undefined 记 'null' */
function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return '"<unserializable>"';
  }
}

/** 转义正则元字符（TRUNCATION_MARKER 含 [ ]，拼模式前需转义） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从已截断字符串尾部反解「原始字节数」的模式：marker（label，原 N 字节）$ */
const TRUNCATED_TAIL_PATTERN = new RegExp(
  `${escapeRegExp(TRUNCATION_MARKER)}（(?:([^）]*)，)?原 (\\d+) 字节）$`,
);

/**
 * 从可能已截断的字符串中反解出去掉尾部后的前段与最初原始字节数。
 *
 * @param value 待检查字符串
 * @returns 匹配截断尾部时返回前段与原始字节数；非截断串返回 undefined
 */
function parseTruncatedString(value: string): { head: string; originalBytes: number } | undefined {
  const match = TRUNCATED_TAIL_PATTERN.exec(value);
  if (!match) return undefined;
  return { head: value.slice(0, match.index), originalBytes: Number(match[2]) };
}

/** 截断字符串的尾部文案（携带原始字节数与字段 label，自说明） */
function stringTruncationTail(originalBytes: number, label: string): string {
  return label.length > 0
    ? `${TRUNCATION_MARKER}（${label}，原 ${originalBytes} 字节）`
    : `${TRUNCATION_MARKER}（原 ${originalBytes} 字节）`;
}

/** 截断包装 preview 的尾部文案 */
function previewTruncationTail(label: string): string {
  return label.length > 0 ? `${TRUNCATION_MARKER}（${label}）` : TRUNCATION_MARKER;
}

/**
 * 构建截断包装：把 serialized 文本截到预算内并包进 TruncatedSnapshot。
 *
 * preview 字段落库序列化时其内部引号会被 JSON 转义而膨胀，因此预算按实际
 * 序列化结果迭代收敛（通常 1~2 轮），保证包装整体序列化 ≤ maxBytes；
 * maxBytes 小于包装结构自身开销的病理配置下以结构完整优先（允许略超）。
 *
 * @param serialized 原值的 JSON 序列化文本（或需继续收缩的旧 preview）
 * @param originalBytes 最初原值的序列化字节数（跨降级保持不变）
 * @param label 字段标识（进 preview 尾部，便于读侧定位）
 * @param maxBytes 包装整体序列化字节数上限
 * @returns 截断包装
 */
function buildTruncatedWrapper(
  serialized: string,
  originalBytes: number,
  label: string,
  maxBytes: number,
): TruncatedSnapshot {
  const tail = previewTruncationTail(label);
  const skeleton = JSON.stringify({ __truncated: true, preview: "", originalBytes }) ?? "null";
  let budget = Math.max(0, maxBytes - utf8ByteLength(skeleton) - utf8ByteLength(tail) - 8);
  for (;;) {
    const wrapper: TruncatedSnapshot = {
      __truncated: true,
      preview: cutToUtf8Bytes(serialized, budget) + tail,
      originalBytes,
    };
    const actual = utf8ByteLength(JSON.stringify(wrapper));
    if (actual <= maxBytes || budget === 0) return wrapper;
    budget = Math.max(0, budget - Math.max(1, Math.ceil((actual - maxBytes) / 2)));
  }
}

/* ------------------------------------------------------------------ *
 * capSnapshot：单快照体积控制
 * ------------------------------------------------------------------ */

/**
 * 把单个快照值按 UTF-8 序列化字节数收敛到 maxBytes 内（纯函数）。
 *
 * - 未超限：原样透传（同引用，capped = false）；
 * - 字符串超限：直接截断文本，尾部追加 TRUNCATION_MARKER + label + 原始字节数；
 * - 对象 / 数组超限：序列化后截断为 preview，包 TruncatedSnapshot 包装；
 * - 幂等：对已截断的值以同上限重入原样返回；上限收紧时继续收缩
 *   （字符串保留最初原始字节数，包装保留最初 originalBytes）。
 *
 * @param value 快照值（节点 input / output 等任意 JSON 安全值）
 * @param maxBytes 序列化字节上限（负数按 0 处理）
 * @param label 字段标识（如 'n1.output'），进截断尾部文案便于读侧定位
 * @returns 处理结果（value / capped / originalBytes）
 */
export function capSnapshot(value: unknown, maxBytes: number, label: string): SnapshotCapResult {
  const limit = Math.max(0, maxBytes);

  // 已是截断包装（如整体降级重入）：保留真实 originalBytes，仅收缩 preview
  if (isTruncatedSnapshot(value)) {
    const current = utf8ByteLength(safeSerialize(value));
    if (current <= limit) return { value, capped: false };
    const wrapper = buildTruncatedWrapper(value.preview, value.originalBytes, label, limit);
    return { value: wrapper, capped: true, originalBytes: value.originalBytes };
  }

  if (typeof value === "string") return capString(value, limit, label);

  const serialized = safeSerialize(value);
  const bytes = utf8ByteLength(serialized);
  if (bytes <= limit) return { value, capped: false };

  // 对象 / 数组 → 包装；其余标量（number / boolean / null / 不可序列化占位等）
  // 超限理论上极少发生（病理上限配置），统一按包装兜底，保证结果有界。
  return {
    value: buildTruncatedWrapper(serialized, bytes, label, limit),
    capped: true,
    originalBytes: bytes,
  };
}

/**
 * 字符串快照的截断（capSnapshot 的字符串分支）。
 * 结果整体字节数（含尾部标记）≤ maxBytes；尾部放不下时退化为裸标记 / 空串。
 */
function capString(value: string, maxBytes: number, label: string): SnapshotCapResult {
  const bytes = utf8ByteLength(value);
  if (bytes <= maxBytes) return { value, capped: false };

  // 已截断串重入（如整体降级）：保留最初的原始字节数，只继续收缩前段
  const previous = parseTruncatedString(value);
  const originalBytes = previous ? previous.originalBytes : bytes;
  let tail = stringTruncationTail(originalBytes, label);
  if (utf8ByteLength(tail) > maxBytes) {
    tail = utf8ByteLength(TRUNCATION_MARKER) <= maxBytes ? TRUNCATION_MARKER : "";
  }
  const head = cutToUtf8Bytes(previous ? previous.head : value, maxBytes - utf8ByteLength(tail));
  return { value: head + tail, capped: true, originalBytes };
}

/* ------------------------------------------------------------------ *
 * updateNodeRunSnapshot：最后一次执行的覆盖式合并
 * ------------------------------------------------------------------ */

/**
 * 覆盖式合并单节点执行快照（纯函数，最后写入优先）：
 * 同一节点重跑（M7 循环节点）时以最后一次为准，其余节点原样保留。
 * executor 语义上节点在一次运行内至多执行一次；本函数是 run-store.
 * recordNodeRun 读取-合并-写回路径的合并点。
 *
 * @param nodeRuns 现有节点快照表（不会被修改）
 * @param nodeId 目标节点 id
 * @param nodeRun 该节点最后一次执行的完整快照
 * @returns 合并后的新快照表
 */
export function updateNodeRunSnapshot(
  nodeRuns: Record<NodeId, NodeRun>,
  nodeId: NodeId,
  nodeRun: NodeRun,
): Record<NodeId, NodeRun> {
  const merged: Record<NodeId, NodeRun> = { ...nodeRuns };
  merged[nodeId] = nodeRun;
  return merged;
}

/* ------------------------------------------------------------------ *
 * buildRunRecord：完整 RunRecord 构建（含两级体积控制）
 * ------------------------------------------------------------------ */

/** buildRunRecord 入参：运行摘要 + 落库时确定的 id / 触发方式 / 时间戳 */
export interface BuildRunRecordInput {
  /** 运行结束摘要（executeWorkflow 返回值 / onRunFinish 载荷，同一对象） */
  summary: RunSummary;
  /** 运行记录 id（startRun 阶段生成的 runId） */
  runId: RunId;
  /** 所属工作流 id；缺省取 summary.workflowId */
  workflowId?: WorkflowId;
  /** 触发方式；缺省 'manual'（与 buildRunRecordShell 一致） */
  trigger?: RunTrigger;
  /** 开始时间（startRun 阶段记录） */
  startedAt: Timestamp;
  /** 结束时间；缺省不写（status 'running' 的中间态无此字段） */
  finishedAt?: Timestamp;
}

/** buildRunRecord 选项：体积控制参数（全部可选，缺省见常量） */
export interface BuildRunRecordOptions {
  /** 单快照（每节点 input / output）字节上限；缺省 SNAPSHOT_MAX_BYTES（256KB） */
  snapshotMaxBytes?: number;
  /** 整条 RunRecord 序列化字节上限；缺省 RUN_RECORD_MAX_BYTES（2MB） */
  recordMaxBytes?: number;
  /** 整体超限后的首个降级档位；缺省 DEGRADED_SNAPSHOT_BYTES（64KB），其后逐级对半 */
  degradedSnapshotBytes?: number;
}

/**
 * 把单快照上限应用到逐迭代明细（M13-T9）：每轮的 item / output 分别过
 * capSnapshot（label 带 `iteration[下标]` 便于读侧定位截断段）。进度字段
 * （total / done / capped / truncated）与轮次元数据原样保留——明细在产出侧
 * 已按 LOOP_ITERATION_SNAPSHOT_BYTES 收敛过，本函数在整体降级（单快照上限
 * 收紧）时对明细同步收紧，避免逐迭代数据独占 2MB 总闸的降级预算。
 *
 * @param summary 原始迭代摘要（不会被修改）
 * @param maxBytes 单快照字节上限（与节点 input / output 同一档位）
 * @param nodeId 所属节点 id（截断 label 前缀）
 */
function capIterationsSummary(
  summary: LoopIterationsSummary,
  maxBytes: number,
  nodeId: NodeId,
): LoopIterationsSummary {
  const records = summary.records.map((record): LoopIterationRecord => {
    const item = capSnapshot(record.item, maxBytes, `${nodeId}.iteration[${record.index}].item`);
    const output = capSnapshot(
      record.output,
      maxBytes,
      `${nodeId}.iteration[${record.index}].output`,
    );
    return { ...record, item: item.value, output: output.value };
  });
  return { ...summary, records };
}

/** 把单快照上限应用到整张节点快照表（input / output 分别过 capSnapshot；M13-T9 起逐迭代明细同步收敛） */
function capNodeRuns(nodeRuns: Record<NodeId, NodeRun>, maxBytes: number): Record<NodeId, NodeRun> {
  const capped: Record<NodeId, NodeRun> = {};
  for (const nodeId of Object.keys(nodeRuns) as NodeId[]) {
    const run = nodeRuns[nodeId];
    const input = capSnapshot(run.input, maxBytes, `${nodeId}.input`);
    const output = capSnapshot(run.output, maxBytes, `${nodeId}.output`);
    const record: NodeRun = { ...run, input: input.value, output: output.value };
    // M13-T9：循环节点的逐迭代明细与节点快照同一档位收敛（整体降级时同步收紧）
    if (run.iterations !== undefined) {
      record.iterations = capIterationsSummary(run.iterations, maxBytes, nodeId);
    }
    capped[nodeId] = record;
  }
  return capped;
}

/** 组装 RunRecord（status / error 来自 summary；时间与触发方式来自入参） */
function assembleRunRecord(
  input: BuildRunRecordInput,
  nodeRuns: Record<NodeId, NodeRun>,
): RunRecord {
  const { summary } = input;
  const record: RunRecord = {
    id: input.runId,
    workflowId: input.workflowId ?? summary.workflowId,
    status: summary.status,
    trigger: input.trigger ?? "manual",
    startedAt: input.startedAt,
    nodeRuns,
  };
  if (input.finishedAt !== undefined) record.finishedAt = input.finishedAt;
  if (summary.error !== undefined) record.error = summary.error;
  return record;
}

/** 整条记录序列化后的 UTF-8 字节数；不可序列化（含循环引用）返回 0（视为可放行） */
function serializedRecordBytes(record: RunRecord): number {
  try {
    return UTF8_ENCODER.encode(JSON.stringify(record)).length;
  } catch {
    return 0;
  }
}

/**
 * 构建完整 RunRecord（纯函数，落库定稿形态）。
 *
 * 流程：nodeRuns 各节点 input / output 先按 snapshotMaxBytes（默认 256KB）分别
 * 截断 → 整条记录序列化 ≤ recordMaxBytes（默认 2MB）即定稿；超限则从
 * degradedSnapshotBytes（默认 64KB）起逐节点收紧快照上限并逐级对半，直至合规
 * （或达到 MIN_DEGRADED_SNAPSHOT_BYTES 下限后如实放行，不无限循环）。
 * run 级 error = summary.error；finishedAt 未提供时不写字段。
 *
 * @param input 摘要与 id / 触发方式 / 时间戳
 * @param options 体积控制参数（可配）
 * @returns 可直接落库的 RunRecord
 */
export function buildRunRecord(
  input: BuildRunRecordInput,
  options: BuildRunRecordOptions = {},
): RunRecord {
  const snapshotMaxBytes = Math.max(0, options.snapshotMaxBytes ?? SNAPSHOT_MAX_BYTES);
  const recordMaxBytes = options.recordMaxBytes ?? RUN_RECORD_MAX_BYTES;
  const rawNodeRuns = input.summary.nodeRuns;

  let nodeRuns = capNodeRuns(rawNodeRuns, snapshotMaxBytes);
  let record = assembleRunRecord(input, nodeRuns);
  if (serializedRecordBytes(record) <= recordMaxBytes) return record;

  // 整体超限：从降级档位起逐级对半收紧单快照上限（每次都从原始值重算），直至合规
  let limit = Math.max(
    MIN_DEGRADED_SNAPSHOT_BYTES,
    options.degradedSnapshotBytes ?? DEGRADED_SNAPSHOT_BYTES,
  );
  for (;;) {
    nodeRuns = capNodeRuns(rawNodeRuns, limit);
    record = assembleRunRecord(input, nodeRuns);
    if (serializedRecordBytes(record) <= recordMaxBytes) return record;
    if (limit <= MIN_DEGRADED_SNAPSHOT_BYTES) return record;
    limit = Math.max(MIN_DEGRADED_SNAPSHOT_BYTES, Math.floor(limit / 2));
  }
}
