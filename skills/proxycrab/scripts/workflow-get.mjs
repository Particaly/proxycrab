#!/usr/bin/env node
import {
  apiRequest,
  assertAllowedArgs,
  parseArgs,
  printHelp,
  printJson,
  requiredString,
  run,
} from "./lib/common.mjs";

run(async () => {
  const args = parseArgs();
  assertAllowedArgs(args, ["workflow-id"]);
  if (args.help) {
    printHelp(`
Usage: node workflow-get.mjs --workflow-id ID [--base-url URL]

Read one workflow definition (read-time schema migration applies). Missing ids fail with
404 not_found.
`);
    return;
  }
  const workflowId = requiredString(args, "workflow-id");
  printJson(await apiRequest(args, `/api/workflows/${encodeURIComponent(workflowId)}`));
});
