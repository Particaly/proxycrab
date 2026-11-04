import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_SOURCES,
  assignmentsToRows,
  buildSetVariableShard,
  createAssignmentRow,
  rowsToAssignments,
  validateAssignmentRows,
  validateSetVariableDraft,
  type AssignmentRow,
} from "./set-variable-config";

/** 快捷构造编辑行（缺省来源 input）。 */
function row(patch: Partial<Omit<AssignmentRow, "id">>): AssignmentRow {
  return { id: "r1", name: "", from: "input", path: "", node: "", value: "", ...patch };
}

describe("assignmentsToRows 回填", () => {
  it("合法赋值项回填编辑行；literal 非字符串值按 JSON 文本展示", () => {
    expect(
      assignmentsToRows([
        { name: "token", from: "node", node: "n1", path: "body.token" },
        { name: "flag", from: "literal", value: true },
        { name: "greet", from: "literal", value: "你好 {{ var.name }}" },
      ]),
    ).toEqual([
      { id: expect.any(String), name: "token", from: "node", path: "body.token", node: "n1", value: "" },
      { id: expect.any(String), name: "flag", from: "literal", path: "", node: "", value: "true" },
      {
        id: expect.any(String),
        name: "greet",
        from: "literal",
        path: "",
        node: "",
        value: "你好 {{ var.name }}",
      },
    ]);
  });

  it("脏数据容错：非法 from 回退 literal、非对象条目回退空行、非数组为空清单", () => {
    expect(assignmentsToRows([{ name: 1, from: "weird" }])).toEqual([
      { id: expect.any(String), name: "", from: "literal", path: "", node: "", value: "" },
    ]);
    expect(assignmentsToRows([null, 42])).toHaveLength(2);
    expect(assignmentsToRows("garbage")).toEqual([]);
    expect(assignmentsToRows(undefined)).toEqual([]);
  });
});

describe("validateAssignmentRows / validateSetVariableDraft", () => {
  it("全空行跳过；变量名必填且不重复；node 来源需指定节点", () => {
    expect(validateAssignmentRows([createAssignmentRow()])).toBeNull();
    expect(validateAssignmentRows([row({ path: "x" })])).toBe("赋值项的变量名不能为空");
    expect(validateAssignmentRows([row({ name: "a" }), row({ name: " a " })])).toContain(
      "变量名重复：a",
    );
    expect(validateAssignmentRows([row({ name: "a", from: "node" })])).toContain(
      "未指定节点",
    );
    expect(
      validateAssignmentRows([
        row({ name: "a", from: "node", node: "n1" }),
        row({ name: "b", from: "var", path: "x" }),
      ]),
    ).toBeNull();
    expect(validateSetVariableDraft([])).toBeNull();
  });
});

describe("rowsToAssignments / buildSetVariableShard", () => {
  it("全空行丢弃；空白路径 / 节点不落键；literal 数值布尔 null 文本反序列化", () => {
    expect(
      rowsToAssignments([
        createAssignmentRow(),
        row({ name: "count", from: "literal", value: "3" }),
        row({ name: "flag", from: "literal", value: "true" }),
        row({ name: "nothing", from: "literal", value: "null" }),
        row({ name: "text", from: "literal", value: "Bearer {{ var.token }}" }),
        row({ name: "status", from: "input", path: " status " }),
        row({ name: "body", from: "node", node: " n1 ", path: "" }),
      ]),
    ).toEqual([
      { name: "count", from: "literal", value: 3 },
      { name: "flag", from: "literal", value: true },
      { name: "nothing", from: "literal", value: null },
      { name: "text", from: "literal", value: "Bearer {{ var.token }}" },
      { name: "status", from: "input", path: "status" },
      { name: "body", from: "node", node: "n1" },
    ]);
  });

  it("空清单落空数组（= 纯透传）；分片形状只含 assignments", () => {
    expect(buildSetVariableShard([])).toEqual({ assignments: [] });
    const shard = buildSetVariableShard([row({ name: "a" })]);
    expect(Object.keys(shard)).toEqual(["assignments"]);
  });

  it("来源清单覆盖四态且 value 为落库字面量", () => {
    expect(ASSIGNMENT_SOURCES.map((source) => source.value)).toEqual([
      "input",
      "node",
      "var",
      "literal",
    ]);
  });
});
