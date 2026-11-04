import { describe, expect, it } from "vitest";
import {
  assertionsToRows,
  buildAssertShard,
  createAssertionRow,
  parseAssertionValueText,
  rowsToAssertions,
  validateAssertionRows,
  type AssertionRow,
} from "./assert-config";

/** 快捷构造编辑行（缺省类别 status）。 */
function row(patch: Partial<Omit<AssertionRow, "id">>): AssertionRow {
  return {
    id: "r1",
    kind: "status",
    statusOp: "eq",
    statusValue: "",
    path: "",
    jsonOp: "eq",
    jsonValue: "",
    schemaPath: "",
    schemaText: "",
    ...patch,
  };
}

describe("assertionsToRows 回填", () => {
  it("三类规则回填对应字段；脏数据回退空行缺省值", () => {
    expect(
      assertionsToRows([
        { kind: "status", op: "2xx" },
        { kind: "status", op: "eq", value: 200 },
        { kind: "jsonPath", path: "$.a", op: "contains", value: "x" },
        { kind: "jsonPath", path: "$.b", op: "exists" },
        { kind: "schema", path: "$.c", schema: { type: "object" } },
        { kind: "weird" },
        null,
      ]),
    ).toEqual([
      { id: expect.any(String), kind: "status", statusOp: "2xx", statusValue: "", path: "", jsonOp: "eq", jsonValue: "", schemaPath: "", schemaText: "" },
      { id: expect.any(String), kind: "status", statusOp: "eq", statusValue: "200", path: "", jsonOp: "eq", jsonValue: "", schemaPath: "", schemaText: "" },
      { id: expect.any(String), kind: "jsonPath", statusOp: "eq", statusValue: "", path: "$.a", jsonOp: "contains", jsonValue: "x", schemaPath: "", schemaText: "" },
      { id: expect.any(String), kind: "jsonPath", statusOp: "eq", statusValue: "", path: "$.b", jsonOp: "exists", jsonValue: "", schemaPath: "", schemaText: "" },
      { id: expect.any(String), kind: "schema", statusOp: "eq", statusValue: "", path: "", jsonOp: "eq", jsonValue: "", schemaPath: "$.c", schemaText: '{\n  "type": "object"\n}' },
      { id: expect.any(String), kind: "status", statusOp: "eq", statusValue: "", path: "", jsonOp: "eq", jsonValue: "", schemaPath: "", schemaText: "" },
      { id: expect.any(String), kind: "status", statusOp: "eq", statusValue: "", path: "", jsonOp: "eq", jsonValue: "", schemaPath: "", schemaText: "" },
    ]);
    expect(assertionsToRows("garbage")).toEqual([]);
    expect(assertionsToRows(undefined)).toEqual([]);
  });
});

describe("parseAssertionValueText", () => {
  it("数字 / 布尔 / null / 对象 / 数组反序列化；其余按原样字符串", () => {
    expect(parseAssertionValueText("200")).toBe(200);
    expect(parseAssertionValueText("true")).toBe(true);
    expect(parseAssertionValueText("null")).toBeNull();
    expect(parseAssertionValueText('{"a":1}')).toEqual({ a: 1 });
    expect(parseAssertionValueText("[1,2]")).toEqual([1, 2]);
    expect(parseAssertionValueText("paid")).toBe("paid");
    expect(parseAssertionValueText("{bad")).toBe("{bad"); // 首字符像 JSON 但整体不合法
    expect(parseAssertionValueText("^ok$")).toBe("^ok$");
  });
});

describe("validateAssertionRows", () => {
  it("空清单放行；段比较不用值；空白的 eq 状态行视为未配置意图（报错提示，与上游口径一致）", () => {
    expect(validateAssertionRows([])).toBeNull();
    expect(validateAssertionRows([createAssertionRow()])).toContain("需填写期望状态码");
    expect(validateAssertionRows([row({ statusOp: "2xx" })])).toBeNull();
    expect(validateAssertionRows([row({ statusOp: "eq" })])).toContain("需填写期望状态码");
    expect(validateAssertionRows([row({ statusValue: "600" })])).toContain("0~599");
    expect(validateAssertionRows([row({ statusValue: "200" })])).toBeNull();
  });

  it("JSONPath 行：路径语法预检、非 exists 需期望值、正则需可编译", () => {
    expect(validateAssertionRows([row({ kind: "jsonPath", path: "$.a[", jsonOp: "exists" })])).toContain(
      "JSONPath",
    );
    expect(validateAssertionRows([row({ kind: "jsonPath", path: "$.a", jsonOp: "eq" })])).toContain(
      "需填写期望值",
    );
    expect(validateAssertionRows([row({ kind: "jsonPath", path: "$.a", jsonOp: "exists" })])).toBeNull();
    expect(
      validateAssertionRows([row({ kind: "jsonPath", path: "$.a", jsonOp: "regex", jsonValue: "(" })]),
    ).toContain("正则表达式非法");
    expect(
      validateAssertionRows([row({ kind: "jsonPath", path: "$.a", jsonOp: "regex", jsonValue: "^ok$" })]),
    ).toBeNull();
  });

  it("Schema 行：目标路径预检、定义必填且为 JSON 对象", () => {
    expect(
      validateAssertionRows([row({ kind: "schema", schemaPath: "$.[", schemaText: "{}" })]),
    ).toContain("JSONPath");
    expect(validateAssertionRows([row({ kind: "schema", schemaPath: "$.c" })])).toContain(
      "Schema 定义不能为空",
    );
    expect(validateAssertionRows([row({ kind: "schema", schemaText: "{bad" })])).toContain(
      "不是合法 JSON",
    );
    expect(validateAssertionRows([row({ kind: "schema", schemaText: "[1]" })])).toContain(
      "需为 JSON 对象",
    );
    expect(validateAssertionRows([row({ kind: "schema", schemaText: '{"type":"object"}' })])).toBeNull();
  });
});

describe("rowsToAssertions / buildAssertShard", () => {
  it("全空行丢弃；三类规则按落库形状组装（段比较不带 value、exists 不带 value）", () => {
    expect(
      rowsToAssertions([
        createAssertionRow(),
        row({ statusOp: "4xx" }),
        row({ statusValue: "201" }),
        row({ kind: "jsonPath", path: " $.a ", jsonOp: "ne", jsonValue: "0" }),
        row({ kind: "jsonPath", path: "$.b", jsonOp: "exists" }),
        row({ kind: "schema", schemaPath: " $.c ", schemaText: '{"type":"object"}' }),
      ]),
    ).toEqual([
      { kind: "status", op: "4xx" },
      { kind: "status", op: "eq", value: 201 },
      { kind: "jsonPath", path: "$.a", op: "ne", value: 0 },
      { kind: "jsonPath", path: "$.b", op: "exists" },
      { kind: "schema", path: "$.c", schema: { type: "object" } },
    ]);
  });

  it("schemaPath 空串不落键；空清单落空数组（= 纯透传）；分片形状只含 assertions", () => {
    expect(rowsToAssertions([row({ kind: "schema", schemaText: "{}" })])).toEqual([
      { kind: "schema", schema: {} },
    ]);
    expect(buildAssertShard([])).toEqual({ assertions: [] });
    expect(Object.keys(buildAssertShard([row({ statusValue: "1" })]))).toEqual(["assertions"]);
  });
});
