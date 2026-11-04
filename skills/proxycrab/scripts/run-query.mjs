#!/usr/bin/env node
import {
  UsageError,
  apiRequest,
  assertAllowedArgs,
  optionalInteger,
  optionalString,
  parseArgs,
  printHelp,
  printJson,
  run,
} from "./lib/common.mjs";

const RUN_STATUSES = ["running", "success", "failed", "cancelled", "interrupted"];

run(async () => {
  const args = parseArgs();
  assertAllowedArgs(args, ["workflow-id", "status", "limit", "offset"]);
  if (args.help) {
    printHelp(`
Usage: node run-query.mjs [options]

List workflow run records as one page, newest first.

Filters:
  --workflow-id ID       Only runs of this workflow definition
  --status NAME          One of running, success, failed, cancelled, interrupted

Paging (applied after filtering):
  --limit N              Default 200, must stay within 1-1000
  --offset N             Runs to skip before the page

Prints { runs: [...], total } where total counts every matching run.
`);
    return;
  }
  const status = optionalString(args, "status");
  if (status !== undefined && !RUN_STATUSES.includes(status)) {
    throw new UsageError(`--status must be one of ${RUN_STATUSES.join(", ")}`);
  }
  const params = new URLSearchParams();
  const workflowId = optionalString(args, "workflow-id");
  if (workflowId !== undefined) params.set("workflowId", workflowId);
  if (status !== undefined) params.set("status", status);
  const limit = optionalInteger(args, "limit", { min: 1, max: 1000 });
  if (limit !== undefined) params.set("limit", String(limit));
  const offset = optionalInteger(args, "offset", { min: 0 });
  if (offset !== undefined) params.set("offset", String(offset));
  const search = params.toString();
  printJson(await apiRequest(args, `/api/flow/runs${search ? `?${search}` : ""}`));
});
