import { describe, expect, it } from "vitest";
import { parseCsv, resolveCsvDelimiter } from "./csv";

/** CSV 解析测试（M10-T6）：表头映射、引号包裹（分隔符 / 换行 / 转义引号）、
 * \r\n 换行、末尾空行、列数不齐补齐、分隔符解析回退。 */
describe("engine/csv（M10-T6 CSV 数据源）", () => {
  it("首行表头 → 行对象；缺列补空串、多列忽略", () => {
    const rows = parseCsv("id,name\n1,alpha\n2,beta,gamma\n3", ",");
    expect(rows).toEqual([
      { id: "1", name: "alpha" },
      { id: "2", name: "beta" },
      { id: "3", name: "" },
    ]);
  });

  it('引号单元格：内含分隔符 / 换行 / "" 转义', () => {
    const rows = parseCsv('a,b\n"x,1","line1\nline2"\n"say ""hi""",ok', ",");
    expect(rows).toEqual([
      { a: "x,1", b: "line1\nline2" },
      { a: 'say "hi"', b: "ok" },
    ]);
  });

  it("\\r\\n 换行与末尾空行", () => {
    const rows = parseCsv("k\r\nv1\r\nv2\r\n\r\n", ",");
    expect(rows).toEqual([{ k: "v1" }, { k: "v2" }]);
  });

  it("空文本 / 仅表头返回空数组；分号与制表符分隔符", () => {
    expect(parseCsv("", ",")).toEqual([]);
    expect(parseCsv("a,b\n", ",")).toEqual([]);
    expect(parseCsv("a;b\n1;x", ";")).toEqual([{ a: "1", b: "x" }]);
    expect(parseCsv("a\tb\n1\tx", "\t")).toEqual([{ a: "1", b: "x" }]);
  });

  it("resolveCsvDelimiter：合法值原样、非法值回退逗号", () => {
    expect(resolveCsvDelimiter(";")).toBe(";");
    expect(resolveCsvDelimiter("\t")).toBe("\t");
    expect(resolveCsvDelimiter(undefined)).toBe(",");
    expect(resolveCsvDelimiter("|")).toBe(",");
    expect(resolveCsvDelimiter(42)).toBe(",");
  });
});
