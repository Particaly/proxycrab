import { describe, expect, it } from "vitest";
import { resolveLoopExecutionOptions, resolveLoopItems } from "./logic-nodes";
import type { RenderContext } from "./template";

/** M10-T6 loop data-source contracts kept separate from the pre-existing logic-node suite. */
describe("logic nodes M10-T6 loop extensions", () => {
  const context: RenderContext = { node: {}, input: null };

  it("parses CSV rows and gives the CSV source precedence over items", () => {
    expect(
      resolveLoopItems({ items: ["ignored"], csvText: "id,name\n1,Ada\n2,Lin" }, context),
    ).toEqual([
      { id: "1", name: "Ada" },
      { id: "2", name: "Lin" },
    ]);
  });

  it("safely serializes configured concurrency while preserving interval limits", () => {
    expect(resolveLoopExecutionOptions({ concurrency: 4, intervalMs: 125 })).toEqual({
      concurrency: 1,
      intervalMs: 125,
    });
    expect(resolveLoopExecutionOptions({ concurrency: -1, intervalMs: 99_999 })).toEqual({
      concurrency: 1,
      intervalMs: 60_000,
    });
  });
});
