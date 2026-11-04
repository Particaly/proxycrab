#!/usr/bin/env node
import {
  apiRequest,
  assertAllowedArgs,
  optionalInteger,
  parseArgs,
  printHelp,
  printJson,
  requiredString,
  run,
} from "./lib/common.mjs";

const TERMINAL_STATUSES = ["success", "failed", "cancelled", "interrupted"];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Condense the run detail into a terminal summary: keep the run fields (status, error,
// timestamps), drop the bulky graph snapshot, and digest every node checkpoint to its
// status/error/duration without the input/output snapshots.
function runSummary(detail) {
  const { nodeRuns, graphSnapshot, ...record } = detail;
  return {
    ...record,
    nodes: (nodeRuns ?? []).map((nodeRun) => ({
      nodeId: nodeRun.nodeId,
      status: nodeRun.status,
      durationMs: nodeRun.durationMs,
      error: nodeRun.error,
    })),
  };
}

run(async () => {
  const args = parseArgs();
  assertAllowedArgs(args, ["run-id", "timeout-ms", "interval-ms"]);
  if (args.help) {
    printHelp(`
Usage: node run-wait.mjs --run-id ID [options]

Poll one workflow run until it settles, then print a terminal summary: the run fields (id,
status, error, timestamps) plus a per-node digest { nodeId, status, durationMs, error } without
the bulky graph/input/output snapshots. Missing runs fail with 404 not_found.

Polling:
  --run-id ID            Run record to watch (required)
  --timeout-ms N         Give up with an error after this long; default 300000
  --interval-ms N        Time between polls; default 500, minimum 50

A run settles as success, failed, cancelled, or interrupted. A timeout does not stop the run;
run-wait again afterwards or inspect run-query.mjs.
`);
    return;
  }
  const runId = requiredString(args, "run-id");
  const timeoutMs = optionalInteger(args, "timeout-ms", { min: 1, max: 3_600_000 }) ?? 300_000;
  const intervalMs = optionalInteger(args, "interval-ms", { min: 50, max: 60_000 }) ?? 500;
  const endpoint = `/api/flow/runs/${encodeURIComponent(runId)}`;

  let detail = await apiRequest(args, endpoint);
  const deadline = Date.now() + timeoutMs;
  while (!TERMINAL_STATUSES.includes(detail.status) && Date.now() <= deadline) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    detail = await apiRequest(args, endpoint);
  }
  if (!TERMINAL_STATUSES.includes(detail.status)) {
    throw new Error(`run ${runId} still ${detail.status} after ${timeoutMs} ms`);
  }
  printJson(runSummary(detail));
});
