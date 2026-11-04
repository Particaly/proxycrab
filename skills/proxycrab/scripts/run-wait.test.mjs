import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./run-wait.mjs", import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);
const baseUrl = ["--base-url", "http://127.0.0.1:18089"];

const failedDetail = {
  id: "run-1", workflowId: "wf-1", workflowName: "checkout", trigger: "manual", status: "failed",
  sessionId: 3, startedAt: 100, finishedAt: 250, error: "node n2 failed: boom",
  graphSnapshot: { nodes: [1, 2, 3] },
  nodeRuns: [
    { runId: "run-1", nodeId: "n1", status: "success", input: { big: 1 }, output: { big: 2 },
      error: null, startedAt: 100, durationMs: 10, iterations: null, updatedAt: 110 },
    { runId: "run-1", nodeId: "n2", status: "failed", input: null, output: null, error: "boom",
      startedAt: 110, durationMs: 140, iterations: null, updatedAt: 250 },
  ],
};

const expectedFailedSummary = {
  id: "run-1", workflowId: "wf-1", workflowName: "checkout", trigger: "manual", status: "failed",
  sessionId: 3, startedAt: 100, finishedAt: 250, error: "node n2 failed: boom",
  nodes: [
    { nodeId: "n1", status: "success", durationMs: 10, error: null },
    { nodeId: "n2", status: "failed", durationMs: 140, error: "boom" },
  ],
};

test("run-wait polls until the run fails and prints the terminal summary", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      const detail = ${JSON.stringify(failedDetail)};
      let polls = 0;
      globalThis.fetch = async (url) => {
        if (url.pathname !== "/api/flow/runs/run-1" || url.search !== "") {
          throw new Error("Unexpected request: " + url.pathname + url.search);
        }
        polls += 1;
        return new Response(JSON.stringify({
          ok: true,
          data: polls === 1 ? { ...detail, status: "running", finishedAt: undefined, nodeRuns: [] } : detail,
        }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--run-id", "run-1",
        "--interval-ms", "50", ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), expectedFailedSummary);
});

test("run-wait prints an already-settled run without polling again", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", `
      let polls = 0;
      globalThis.fetch = async () => {
        polls += 1;
        return new Response(JSON.stringify({ ok: true, data: {
          id: "run-2", status: "cancelled", error: null,
          nodeRuns: [{ runId: "run-2", nodeId: "n1", status: "cancelled", durationMs: 5, error: null }],
        } }));
      };
      process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--run-id", "run-2",
        ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
      await import(${JSON.stringify(scriptUrl)});
    `,
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    id: "run-2", status: "cancelled", error: null,
    nodes: [{ nodeId: "n1", status: "cancelled", durationMs: 5, error: null }],
  });
});

test("run-wait gives up with a timeout error while the run keeps going", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      "--input-type=module", "-e", `
        globalThis.fetch = async () => new Response(JSON.stringify({
          ok: true, data: { id: "run-1", status: "running", nodeRuns: [] },
        }));
        process.argv = [process.execPath, ${JSON.stringify(scriptUrl)}, "--run-id", "run-1",
          "--timeout-ms", "120", "--interval-ms", "50",
          ${JSON.stringify(baseUrl[0])}, ${JSON.stringify(baseUrl[1])}];
        await import(${JSON.stringify(scriptUrl)});
      `,
    ]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /run run-1 still running after 120 ms/);
      return true;
    },
  );
});

test("run-wait requires --run-id", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--base-url", "http://127.0.0.1:18089"]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--run-id/);
      return true;
    },
  );
});
