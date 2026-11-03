import { describe, expect, it } from "vitest";
import { evaluateExtractions } from "./transform-nodes";

describe("transform extraction (M10-T6)", () => {
  it("evaluates JSONPath and normalizes zero / multiple matches", () => {
    const input = { rows: [{ id: 1 }, { id: 2 }], optional: null };
    expect(
      evaluateExtractions([{ name: "id", engine: "jsonPath", path: "$.rows[*].id" }], input),
    ).toEqual([1, 2]);
    expect(
      evaluateExtractions([{ name: "missing", engine: "jsonPath", path: "$.missing" }], input),
    ).toBeNull();
  });

  it("evaluates JMESPath and groups multiple named rules", () => {
    const input = { user: { name: "Ada" }, rows: [{ id: 1 }, { id: 2 }] };
    expect(
      evaluateExtractions(
        [
          { name: "name", engine: "jmespath", path: "user.name" },
          { name: "ids", engine: "jmespath", path: "rows[*].id" },
        ],
        input,
      ),
    ).toEqual({ name: "Ada", ids: [1, 2] });
  });

  it("passes input through without rules and reports malformed expressions with rule name", () => {
    const input = { ok: true };
    expect(evaluateExtractions([], input)).toBe(input);
    expect(() =>
      evaluateExtractions([{ name: "bad-rule", engine: "jsonPath", path: "rows" }], input),
    ).toThrow(/bad-rule.*JSONPath/);
    expect(() =>
      evaluateExtractions([{ name: "bad-rule", engine: "jmespath", path: "items[?bad" }], input),
    ).toThrow(/bad-rule.*JMESPath/);
  });
});
