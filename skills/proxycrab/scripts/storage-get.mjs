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
Usage: node storage-get.mjs --workflow-id <id> [--base-url URL]

Read the persistent key/value storage of one workflow (the same store workflow
runs access live via host.storage). Entries are sorted by key and carry their
last-write updatedAt. Unlike env sets (activation-frozen string tables shared
across workflows), this storage binds to one workflow id and accepts arbitrary
JSON values; every write persists immediately.
`);
    return;
  }
  const workflowId = requiredString(args, "workflow-id");
  printJson(
    await apiRequest(args, `/api/workflows/${encodeURIComponent(workflowId)}/storage`),
  );
});
