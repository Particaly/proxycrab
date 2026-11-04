/**
 * 断言节点（assert）配置表单（AssertConfig.vue）的纯函数层：断言规则行编辑
 * （状态码 / JSONPath / JSON Schema 三类）的行转换、语法预检与落库分片组装。
 *
 * 语义对齐引擎（flow-engine/src/assert-nodes.ts + json-path.ts / json-schema-lite.ts）
 * 与归档抽屉（`LogicNodeConfigDrawer.tsx @ 485fa00` 的断言编辑器，行转换 /
 * 校验 / 组装逻辑逐字移植）：
 *   - status：op = eq（期望码 0~599）/ 2xx / 3xx / 4xx / 5xx 段比较（段比较
 *     不用值）；
 *   - jsonPath：路径语法预检与运行期共用引擎 parseJsonPath；eq / ne /
 *     contains / regex 需期望值（exists 不用）；regex 预编译正则源；期望值
 *     文本按 JSON 反序列化（首字符像 JSON 而整体不合法时按原样字符串）；
 *   - schema：目标路径（可空 = 入参根）语法预检；Schema 需为可解析的 JSON
 *     对象；
 *   - 全空行跳过；空规则列表合法（执行语义 = 纯透传）。
 */

import { parseJsonPath } from "../../../../flow-engine/src/json-path";
import type {
  AssertionRule,
  JsonPathAssertionRule,
  JsonPathOperator,
  SchemaAssertionRule,
  StatusCodeOperator,
  StatusAssertionRule,
} from "../../../../flow-engine/src/types";

/** 断言规则类别 / 状态码比较方式 / JSONPath 比较方式的展示清单（下拉选项） */
export const ASSERT_KINDS: ReadonlyArray<{ value: AssertionRow["kind"]; label: string }> = [
  { value: "status", label: "状态码" },
  { value: "jsonPath", label: "JSONPath" },
  { value: "schema", label: "JSON Schema" },
];

export const STATUS_OPS: ReadonlyArray<{ value: StatusCodeOperator; label: string }> = [
  { value: "eq", label: "等于" },
  { value: "2xx", label: "2xx" },
  { value: "3xx", label: "3xx" },
  { value: "4xx", label: "4xx" },
  { value: "5xx", label: "5xx" },
];

export const JSON_PATH_OPS: ReadonlyArray<{ value: JsonPathOperator; label: string }> = [
  { value: "eq", label: "等于" },
  { value: "ne", label: "不等于" },
  { value: "contains", label: "包含" },
  { value: "regex", label: "正则" },
  { value: "exists", label: "存在" },
];

/** 断言节点 config 分片（NodeConfig 相关字段的宽容子集） */
export interface AssertConfigShard {
  assertions?: unknown;
}

/** 断言规则编辑器的一行（id 仅供渲染 key，不入库；三类字段按 kind 取用） */
export interface AssertionRow {
  id: string;
  kind: "status" | "jsonPath" | "schema";
  /** kind='status'：比较方式与期望码（仅 eq 用值） */
  statusOp: StatusCodeOperator;
  statusValue: string;
  /** kind='jsonPath'：路径 / 比较方式 / 期望值（exists 无值） */
  path: string;
  jsonOp: JsonPathOperator;
  jsonValue: string;
  /** kind='schema'：目标路径（可空 = 根）与 Schema JSON 文本 */
  schemaPath: string;
  schemaText: string;
}

/** 行渲染 key 生成（与 set-variable-config 同口径） */
let rowIdSeq = 0;
function newRowId(): string {
  rowIdSeq += 1;
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `row-${rowIdSeq}-${Date.now()}`;
}

/** 一行是否「全空」（按 kind 判定，与上游口径一致） */
function isBlankRow(row: AssertionRow): boolean {
  if (row.kind === "status") return row.statusValue.trim() === "" && row.statusOp === "eq";
  if (row.kind === "jsonPath") {
    return row.path.trim() === "" && row.jsonValue.trim() === "" && row.jsonOp === "eq";
  }
  return row.schemaText.trim() === "" && row.schemaPath.trim() === "";
}

/** 已有断言规则 → 编辑行（容错脏数据：未知 kind / 字段形状非法回退为空行缺省值） */
export function assertionsToRows(assertions: unknown): AssertionRow[] {
  if (!Array.isArray(assertions)) return [];
  return assertions.map((rule) => {
    const base: AssertionRow = {
      id: newRowId(),
      kind: "status",
      statusOp: "eq",
      statusValue: "",
      path: "",
      jsonOp: "eq",
      jsonValue: "",
      schemaPath: "",
      schemaText: "",
    };
    if (rule === null || typeof rule !== "object") return base;
    const candidate = rule as Partial<AssertionRule>;
    if (candidate.kind === "status") {
      return {
        ...base,
        kind: "status",
        statusOp: STATUS_OPS.some((op) => op.value === candidate.op)
          ? (candidate.op as StatusCodeOperator)
          : "eq",
        statusValue: typeof candidate.value === "number" ? String(candidate.value) : "",
      };
    }
    if (candidate.kind === "jsonPath") {
      const value = candidate.value;
      return {
        ...base,
        kind: "jsonPath",
        path: typeof candidate.path === "string" ? candidate.path : "",
        jsonOp: JSON_PATH_OPS.some((op) => op.value === candidate.op)
          ? (candidate.op as JsonPathOperator)
          : "eq",
        jsonValue:
          value === undefined || value === null
            ? ""
            : typeof value === "string"
              ? value
              : JSON.stringify(value),
      };
    }
    if (candidate.kind === "schema") {
      return {
        ...base,
        kind: "schema",
        schemaPath: typeof candidate.path === "string" ? candidate.path : "",
        schemaText: candidate.schema !== undefined ? JSON.stringify(candidate.schema, null, 2) : "",
      };
    }
    return base;
  });
}

/** 新增一条空白编辑行（缺省类别 status） */
export function createAssertionRow(): AssertionRow {
  return {
    id: newRowId(),
    kind: "status",
    statusOp: "eq",
    statusValue: "",
    path: "",
    jsonOp: "eq",
    jsonValue: "",
    schemaPath: "",
    schemaText: "",
  };
}

/** 期望值文本 → JSON 值：可解析为 JSON（数字 / 布尔 / null / 对象 / 数组）则用解析值，否则按原样字符串 */
export function parseAssertionValueText(raw: string): unknown {
  const text = raw.trim();
  if (/^(true|false|null|-?\d+(\.\d+)?$|[[{])/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      // 首字符像 JSON 但整体不合法：按字符串落库（运行期断言以实际值比较）
    }
  }
  return raw;
}

/**
 * 校验断言行（保存链路用）：全空行跳过；状态码 eq 需非负整数（0~599）；
 * JSONPath 路径语法预检（与运行期共用 parseJsonPath）、非 exists 需期望值、
 * 正则需可编译；Schema 目标路径（若填）语法合法、Schema 需为可解析的 JSON
 * 对象。
 *
 * @returns 合法返回 null；非法返回可直接展示的错误文案
 */
export function validateAssertionRows(rows: readonly AssertionRow[]): string | null {
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const position = index + 1;
    const path = row.path.trim();
    const statusValue = row.statusValue.trim();
    const jsonValue = row.jsonValue.trim();
    const schemaPath = row.schemaPath.trim();
    const schemaText = row.schemaText.trim();

    if (row.kind === "status") {
      if (row.statusOp !== "eq") continue;
      if (statusValue === "") {
        return `第 ${position} 条断言：选择「等于」需填写期望状态码（或改用 2xx 段比较）`;
      }
      if (!/^\d+$/.test(statusValue) || Number.parseInt(statusValue, 10) > 599) {
        return `第 ${position} 条断言：期望状态码需为 0~599 的整数`;
      }
      continue;
    }

    if (row.kind === "jsonPath") {
      if (isBlankRow(row)) continue;
      const parsed = parseJsonPath(path);
      if (!parsed.ok) return `第 ${position} 条断言：${parsed.error}`;
      if (row.jsonOp === "exists") continue;
      if (jsonValue === "") {
        return `第 ${position} 条断言：该比较方式需填写期望值（「存在」检查请改用 exists）`;
      }
      if (row.jsonOp === "regex") {
        try {
          new RegExp(jsonValue);
        } catch (error) {
          return `第 ${position} 条断言：正则表达式非法（${error instanceof Error ? error.message : String(error)}）`;
        }
      }
      continue;
    }

    // schema 行
    if (isBlankRow(row)) continue;
    if (schemaPath !== "") {
      const parsed = parseJsonPath(schemaPath);
      if (!parsed.ok) return `第 ${position} 条断言：${parsed.error}`;
    }
    if (schemaText === "") return `第 ${position} 条断言：Schema 定义不能为空`;
    let parsedSchema: unknown;
    try {
      parsedSchema = JSON.parse(schemaText);
    } catch (error) {
      return `第 ${position} 条断言：Schema 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`;
    }
    if (parsedSchema === null || typeof parsedSchema !== "object" || Array.isArray(parsedSchema)) {
      return `第 ${position} 条断言：Schema 需为 JSON 对象（如 {"type":"object"}）`;
    }
  }
  return null;
}

/** 编辑行 → 落库断言规则（全空行丢弃；非法行已由 validateAssertionRows 阻断保存） */
export function rowsToAssertions(rows: readonly AssertionRow[]): AssertionRule[] {
  const result: AssertionRule[] = [];
  for (const row of rows) {
    const path = row.path.trim();
    const statusValue = row.statusValue.trim();
    const jsonValue = row.jsonValue.trim();
    const schemaPath = row.schemaPath.trim();
    const schemaText = row.schemaText.trim();
    if (row.kind === "status") {
      if (isBlankRow(row)) continue;
      const rule: StatusAssertionRule = { kind: "status", op: row.statusOp };
      if (row.statusOp === "eq") rule.value = Number.parseInt(statusValue, 10);
      result.push(rule);
      continue;
    }
    if (row.kind === "jsonPath") {
      if (isBlankRow(row)) continue;
      const rule: JsonPathAssertionRule = { kind: "jsonPath", path, op: row.jsonOp };
      if (row.jsonOp !== "exists") rule.value = parseAssertionValueText(jsonValue);
      result.push(rule);
      continue;
    }
    // schema：validateAssertionRows 已保证 schemaText 可解析为对象
    if (isBlankRow(row)) continue;
    let schema: Record<string, unknown> = {};
    try {
      schema = JSON.parse(schemaText) as Record<string, unknown>;
    } catch {
      // 防御性忽略（保存被校验阻断，不会走到这里）
    }
    const rule: SchemaAssertionRule = { kind: "schema", schema };
    if (schemaPath !== "") rule.path = schemaPath;
    result.push(rule);
  }
  return result;
}

/** 断言表单的整体校验（保存门控数据源） */
export function validateAssertDraft(rows: readonly AssertionRow[]): string | null {
  return validateAssertionRows(rows);
}

/** 编辑草稿 → 断言节点 config 落库分片（恒落 assertions 键，空数组合法 = 纯透传） */
export function buildAssertShard(rows: readonly AssertionRow[]): AssertConfigShard {
  return { assertions: rowsToAssertions(rows) };
}
