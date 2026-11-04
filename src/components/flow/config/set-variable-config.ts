/**
 * 变量赋值节点（setVariable）配置表单（SetVariableConfig.vue）的纯函数层：
 * 赋值项行编辑（变量名 / 来源 / 路径 / 节点 / 字面量值）的行转换、校验与
 * 落库分片组装。
 *
 * 语义对齐引擎（flow-engine/src/logic-nodes.ts 的 setVariable runner）与归档
 * 抽屉（`LogicNodeConfigDrawer.tsx @ 485fa00` 的赋值项编辑器，行转换 / 校验 /
 * 组装逻辑逐字移植）：
 *   - 来源四态：input 聚合入参 / node 指定节点输出 / var 既有变量 / literal
 *     字面量（literal 字符串支持 {{ }} 模板渲染）；
 *   - 全空行跳过（变量名 / 路径 / 值均空白且 node 来源未指定节点）；
 *   - 校验：变量名非空且不重复（同名覆盖易掩盖错误）、node 来源需指定节点；
 *   - literal 的 true / false / null / 数字文本反序列化为对应 JSON 值落库，
 *     其余按字符串（支持模板）。
 */

import type { VariableAssignment, VariableAssignmentSource } from "../../../../flow-engine/src/types";

/** 赋值项来源的展示清单（下拉选项；value 为落库值） */
export const ASSIGNMENT_SOURCES: ReadonlyArray<{ value: VariableAssignmentSource; label: string }> = [
  { value: "input", label: "入参 input" },
  { value: "node", label: "节点输出" },
  { value: "var", label: "既有变量" },
  { value: "literal", label: "字面量" },
];

/** 变量赋值节点 config 分片（NodeConfig 相关字段的宽容子集） */
export interface SetVariableConfigShard {
  assignments?: unknown;
}

/** 赋值项编辑器的一行（id 仅供渲染 key，不入库） */
export interface AssignmentRow {
  id: string;
  name: string;
  from: VariableAssignmentSource;
  path: string;
  node: string;
  value: string;
}

/** 行渲染 key 生成（crypto.randomUUID，浏览器可用；不可用时退化为计数器） */
let rowIdSeq = 0;
function newRowId(): string {
  rowIdSeq += 1;
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `row-${rowIdSeq}-${Date.now()}`;
}

/** 一行是否「全空」（与上游口径一致：变量名 / 路径 / 值均空白且 node 来源未指定节点） */
function isBlankRow(row: AssignmentRow): boolean {
  return (
    row.name.trim() === "" &&
    row.path.trim() === "" &&
    row.value.trim() === "" &&
    (row.from !== "node" || row.node.trim() === "")
  );
}

/** 已有赋值项 → 编辑行（容错脏数据：非法 from 回退 literal，非字符串值按 JSON 文本展示） */
export function assignmentsToRows(assignments: unknown): AssignmentRow[] {
  if (!Array.isArray(assignments)) return [];
  return assignments.map((assignment) => {
    const record = assignment !== null && typeof assignment === "object" ? assignment : {};
    const from = ASSIGNMENT_SOURCES.some((source) => source.value === record.from)
      ? (record.from as VariableAssignmentSource)
      : "literal";
    let value = "";
    if (from === "literal" && record.value !== undefined) {
      value = typeof record.value === "string" ? record.value : JSON.stringify(record.value);
    }
    return {
      id: newRowId(),
      name: typeof record.name === "string" ? record.name : "",
      from,
      path: typeof record.path === "string" ? record.path : "",
      node: typeof record.node === "string" ? record.node : "",
      value,
    };
  });
}

/** 新增一条空白编辑行（缺省来源 input） */
export function createAssignmentRow(): AssignmentRow {
  return { id: newRowId(), name: "", from: "input", path: "", node: "", value: "" };
}

/** 校验赋值行（保存链路用）：全空行跳过、变量名非空且不重复、节点来源需指定节点 */
export function validateAssignmentRows(rows: readonly AssignmentRow[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    if (isBlankRow(row)) continue;
    const name = row.name.trim();
    if (name === "") return "赋值项的变量名不能为空";
    if (seen.has(name)) return `变量名重复：${name}（同名覆盖易掩盖错误，请改名）`;
    seen.add(name);
    if (row.from === "node" && row.node.trim() === "") {
      return `赋值项「${name}」选择了节点输出来源，但未指定节点`;
    }
  }
  return null;
}

/** 编辑行 → 落库赋值项（全空行丢弃；literal 的数值 / 布尔 / null 文本反序列化） */
export function rowsToAssignments(rows: readonly AssignmentRow[]): VariableAssignment[] {
  const result: VariableAssignment[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (isBlankRow(row)) continue;
    if (row.from === "literal") {
      const raw = row.value.trim();
      let value: unknown = raw;
      if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(raw)) {
        try {
          value = JSON.parse(raw);
        } catch {
          // 正则已保证形状，防御性忽略
        }
      }
      result.push({ name, from: "literal", value });
      continue;
    }
    const path = row.path.trim();
    const node = row.node.trim();
    result.push({
      name,
      from: row.from,
      ...(path !== "" ? { path } : {}),
      ...(row.from === "node" && node !== "" ? { node } : {}),
    });
  }
  return result;
}

/** 变量表单的整体校验（保存门控数据源） */
export function validateSetVariableDraft(rows: readonly AssignmentRow[]): string | null {
  return validateAssignmentRows(rows);
}

/** 编辑草稿 → 变量赋值节点 config 落库分片（恒落 assignments 键，空数组合法 = 纯透传） */
export function buildSetVariableShard(rows: readonly AssignmentRow[]): SetVariableConfigShard {
  return { assignments: rowsToAssignments(rows) };
}
