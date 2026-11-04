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
Usage: node workflow-validate.mjs --workflow-id ID [--base-url URL]

Run the structural graph validator against the stored workflow definition and print
{ issues: [{ code, message, nodeIds }] }. An empty issues list means the graph is valid.
The endpoint is registered as a read (default permission: allow) despite the POST verb.
`);
    return;
  }
  const workflowId = requiredString(args, "workflow-id");
  printJson(
    await apiRequest(args, `/api/workflows/${encodeURIComponent(workflowId)}/validate`, {
      method: "POST",
    }),
  );
});
