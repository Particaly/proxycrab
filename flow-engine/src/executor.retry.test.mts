import { describe, expect, it, vi } from "vitest";
import { executeWorkflow, type NodeRunner } from "./executor";
import { asEdgeId, asNodeId, asProjectId, asWorkflowId } from "./types";
import type { Workflow } from "./types";

/** Construct a minimal start-to-node workflow for retry behavior tests. */
function workflow(config: Workflow["nodes"][number]["config"]): Workflow {
  return {
    id: asWorkflowId("retry-workflow"),
    projectId: asProjectId("project"),
    name: "retry",
    description: "",
    nodes: [
      { id: asNodeId("start"), type: "start", position: { x: 0, y: 0 }, config: {} },
      { id: asNodeId("node"), type: "httpReplay", position: { x: 100, y: 0 }, config },
    ],
    edges: [{ id: asEdgeId("start-node"), source: asNodeId("start"), target: asNodeId("node") }],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("executor retry backoff (M10-T6)", () => {
  it("retries a failing runner up to maxAttempts and succeeds", async () => {
    let calls = 0;
    const runner: NodeRunner = async () => {
      calls += 1;
      if (calls < 3) throw new Error("temporary");
      return "ok";
    };
    const summary = await executeWorkflow(workflow({ retry: { maxAttempts: 3, backoffMs: 0 } }), {
      runners: { httpReplay: runner },
    });
    expect(summary.status).toBe("success");
    expect(summary.nodeRuns[asNodeId("node")]?.output).toBe("ok");
    expect(calls).toBe(3);
  });

  it("uses backoff delay and preserves the final error", async () => {
    vi.useFakeTimers();
    try {
      const runner: NodeRunner = async () => {
        throw new Error("permanent");
      };
      const promise = executeWorkflow(workflow({ retry: { maxAttempts: 2, backoffMs: 10 } }), {
        runners: { httpReplay: runner },
      });
      await vi.advanceTimersByTimeAsync(10);
      const summary = await promise;
      expect(summary.status).toBe("failed");
      expect(summary.nodeRuns[asNodeId("node")]?.error).toContain("permanent");
    } finally {
      vi.useRealTimers();
    }
  });
});
