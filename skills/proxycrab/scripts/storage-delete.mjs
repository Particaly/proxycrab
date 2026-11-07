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
  assertAllowedArgs(args, ["workflow-id", "key"]);
  if (args.help) {
    printHelp(`
Usage: node storage-delete.mjs --workflow-id <id> [--key <key>] [--base-url URL]

Delete one key from a workflow's persistent storage (mirrors
DELETE /api/workflows/{id}/storage/{key}); omit --key to clear the whole
workflow storage (mirrors DELETE /api/workflows/{id}/storage). Deleting a
missing key returns 404 not_found; clearing a missing storage succeeds.
`);
    return;
  }
  const workflowId = requiredString(args, "workflow-id");
  if (args.key === undefined) {
    printJson(
      await apiRequest(args, `/api/workflows/${encodeURIComponent(workflowId)}/storage`, {
        method: "DELETE",
      }),
    );
    return;
  }
  printJson(
    await apiRequest(
      args,
      `/api/workflows/${encodeURIComponent(workflowId)}/storage/${encodeURIComponent(args.key)}`,
      { method: "DELETE" },
    ),
  );
});
