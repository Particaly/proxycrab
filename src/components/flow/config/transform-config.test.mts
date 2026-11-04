import { describe, expect, it } from "vitest";
import {
  TRANSFORM_ENGINES,
  buildTransformShard,
  createExtractionRow,
  extractionsToRows,
  rowsToExtractions,
  validateTransformRows,
  type TransformRow,
} from "./transform-config";

/** 快捷构造编辑行。 */
function row(patch: Partial<Omit<TransformRow, "id">>): TransformRow {
  return { id: "r1", name: "", engine: "jsonPath", path: "$", ...patch };
}

describe("extractionsToRows 回填", () => {
  it("合法规则回填；脏数据回退 jsonPath / 空串；非数组为空清单", () => {
    expect(extractionsToRows([{ name: "token", engine: "jmespath", path: "data.token" }])).toEqual([
      { id: expect.any(String), name: "token", engine: "jmespath", path: "data.token" },
    ]);
    expect(extractionsToRows([{ name: 1, engine: "weird", path: null }])).toEqual([
      { id: expect.any(String), name: "", engine: "jsonPath", path: "" },
    ]);
    expect(extractionsToRows("garbage")).toEqual([]);
    expect(extractionsToRows(undefined)).toEqual([]);
  });
});

describe("validateTransformRows", () => {
  it("名称与表达式必填", () => {
    expect(validateTransformRows([])).toBeNull();
    expect(validateTransformRows([row({ name: " " })])).toContain("名称不能为空");
    expect(validateTransformRows([row({ name: "a", path: " " })])).toContain("表达式不能为空");
  });

  it("JSONPath 语法预检；JMESPath 试查与运行期同源", () => {
    expect(validateTransformRows([row({ name: "a", path: "$.[" })])).toContain("JSONPath 语法非法");
    expect(validateTransformRows([row({ name: "a", path: "$.data.token" })])).toBeNull();
    expect(validateTransformRows([row({ name: "a", engine: "jmespath", path: "data[bad" })])).toContain(
      "JMESPath 语法非法",
    );
    expect(
      validateTransformRows([row({ name: "a", engine: "jmespath", path: "locations[?state == 'WA'].name" })]),
    ).toBeNull();
  });
});

describe("rowsToExtractions / buildTransformShard", () => {
  it("name / path trim 后落库；空清单落空数组（= 透传 input）；分片形状只含 extractions", () => {
    expect(
      rowsToExtractions([row({ name: " token ", engine: "jmespath", path: " data.token " })]),
    ).toEqual([{ name: "token", engine: "jmespath", path: "data.token" }]);
    expect(buildTransformShard([])).toEqual({ extractions: [] });
    expect(Object.keys(buildTransformShard([row({ name: "a" })]))).toEqual(["extractions"]);
  });

  it("新增行缺省 jsonPath + 根占位 $；引擎清单为二态", () => {
    expect(createExtractionRow()).toEqual({ id: expect.any(String), name: "", engine: "jsonPath", path: "$" });
    expect(TRANSFORM_ENGINES.map((engine) => engine.value)).toEqual(["jsonPath", "jmespath"]);
  });
});
