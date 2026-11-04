/**
 * 延时节点（delay）配置表单（DelayConfig.vue）的纯函数层：等待时长输入解析、
 * 上限校验与落库分片组装。
 *
 * 语义对齐引擎（flow-engine/src/logic-nodes.ts）：durationMs 毫秒，上限
 * MAX_DELAY_DURATION_MS = 300000（5 分钟）——超出执行期判节点 failed，表单
 * 保存前即阻断；留空 = 0（不等待，与上游抽屉「留空按 0 落键」一致）。
 */

import { MAX_DELAY_DURATION_MS } from "../../../../flow-engine/src/logic-nodes";

/** 延时节点 config 分片（NodeConfig 相关字段的宽容子集） */
export interface DelayConfigShard {
  durationMs?: number;
}

/** 输入解析结果：value 为落库值；error 为错误文案 */
export interface ParsedDelayDuration {
  value?: number;
  error?: string;
}

/**
 * 等待时长输入 → 落库值：留空 = 0（不等待）；非负整数放行；超上限
 * （300000ms）报错（提示拆分多个延时节点，与引擎失败文案同源）。
 */
export function parseDelayDuration(text: string): ParsedDelayDuration {
  const trimmed = text.trim();
  if (trimmed === "") return { value: 0 };
  if (!/^\d+$/.test(trimmed)) return { error: "延时时长需为非负整数（毫秒）" };
  const value = Number.parseInt(trimmed, 10);
  if (value > MAX_DELAY_DURATION_MS) {
    return { error: `延时时长超过上限 ${MAX_DELAY_DURATION_MS}ms（5 分钟），请拆分多个延时节点` };
  }
  return { value };
}

/** 延时表单的整体校验（保存门控数据源） */
export function validateDelayDraft(durationText: string): string | null {
  return parseDelayDuration(durationText).error ?? null;
}

/**
 * 编辑草稿 → 延时节点 config 落库分片：durationMs 恒落键（留空 = 0，与上游
 * 抽屉保存形状一致）；输入非法时不落键（保存由 validateDelayDraft 门控）。
 */
export function buildDelayShard(durationText: string): DelayConfigShard {
  const parsed = parseDelayDuration(durationText);
  return parsed.value !== undefined ? { durationMs: parsed.value } : {};
}
