/**
 * 数据处理节点（transform）配置表单（TransformConfig.vue）的纯函数层：提取
 * 规则行编辑（规则名 / 引擎 / 查询表达式）的行转换、语法预检与落库分片组装。
 *
 * 语义对齐引擎（flow-engine/src/transform-nodes.ts）与归档抽屉（
 * `LogicNodeConfigDrawer.tsx @ 485fa00` 的提取规则编辑器，校验逻辑逐字移植）：
 *   - 引擎二态：jsonPath（语法子集，与运行期共用 parseJsonPath 预检）/
 *     jmespath（jmespath.search 对语法错误抛错——预检用同一库对空对象试查）；
 *   - 规则名与表达式必填（多规则时规则名是输出对象的键，单条规则时忽略）；
 *   - 空规则列表合法（执行语义 = 原样透传 input）。
 */

import { search as jmespathSearch } from "jmespath";
import { parseJsonPath } from "../../../../flow-engine/src/json-path";
import type { TransformEngine, TransformExtractionRule } from "../../../../flow-engine/src/types";

/** 提取引擎的展示清单（下拉选项；value 为落库值） */
export const TRANSFORM_ENGINES: ReadonlyArray<{ value: TransformEngine; label: string }> = [
  { value: "jsonPath", label: "JSONPath" },
  { value: "jmespath", label: "JMESPath" },
];

/** 数据处理节点 config 分片（NodeConfig 相关字段的宽容子集） */
export interface TransformConfigShard {
  extractions?: unknown;
}

/** 提取规则编辑器的一行（id 仅供渲染 key，不入库） */
export interface TransformRow {
  id: string;
  name: string;
  engine: TransformEngine;
  path: string;
}

/** 行渲染 key 生成（与 set-variable-config 同口径） */
let rowIdSeq = 0;
function newRowId(): string {
  rowIdSeq += 1;
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `row-${rowIdSeq}-${Date.now()}`;
}

/** 已有提取规则 → 编辑行（容错脏数据：非法引擎回退 jsonPath，字段形状非法回退空串） */
export function extractionsToRows(extractions: unknown): TransformRow[] {
  if (!Array.isArray(extractions)) return [];
  return extractions.map((rule) => {
    const record = rule !== null && typeof rule === "object" ? rule : {};
    return {
      id: newRowId(),
      name: typeof record.name === "string" ? record.name : "",
      engine: record.engine === "jmespath" ? "jmespath" : "jsonPath",
      path: typeof record.path === "string" ? record.path : "",
    };
  });
}

/** 新增一条空白编辑行（缺省引擎 jsonPath、表达式占位根 $） */
export function createExtractionRow(): TransformRow {
  return { id: newRowId(), name: "", engine: "jsonPath", path: "$" };
}

/**
 * 校验提取规则行（保存链路用）：规则名 / 表达式必填；JSONPath 语法预检（与
 * 运行期共用 parseJsonPath）；JMESPath 用同一查询库对空对象试查（语法错误
 * 抛错即非法，与运行期判定同源）。
 *
 * @returns 合法返回 null；非法返回可直接展示的错误文案
 */
export function validateTransformRows(rows: readonly TransformRow[]): string | null {
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const position = index + 1;
    if (row.name.trim() === "") return `第 ${position} 条提取规则：名称不能为空`;
    if (row.path.trim() === "") return `第 ${position} 条提取规则：表达式不能为空`;
    if (row.engine === "jsonPath" && !parseJsonPath(row.path).ok) {
      return `第 ${position} 条提取规则：JSONPath 语法非法`;
    }
    if (row.engine === "jmespath") {
      try {
        jmespathSearch({}, row.path);
      } catch {
        return `第 ${position} 条提取规则：JMESPath 语法非法`;
      }
    }
  }
  return null;
}

/** 编辑行 → 落库提取规则（name / path trim 后落库） */
export function rowsToExtractions(rows: readonly TransformRow[]): TransformExtractionRule[] {
  return rows.map((row) => ({
    name: row.name.trim(),
    engine: row.engine,
    path: row.path.trim(),
  }));
}

/** 数据处理表单的整体校验（保存门控数据源） */
export function validateTransformDraft(rows: readonly TransformRow[]): string | null {
  return validateTransformRows(rows);
}

/** 编辑草稿 → 数据处理节点 config 落库分片（恒落 extractions 键，空数组合法 = 透传 input） */
export function buildTransformShard(rows: readonly TransformRow[]): TransformConfigShard {
  return { extractions: rowsToExtractions(rows) };
}
