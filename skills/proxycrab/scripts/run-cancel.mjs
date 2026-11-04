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
  assertAllowedArgs(args, ["run-id"]);
  if (args.help) {
    printHelp(`
Usage: node run-cancel.mjs --run-id ID [--base-url URL]

Request cancellation of one workflow run and print the updated run record. The engine stops
scheduling at the next batch boundary (the current node completes) and the run settles as
"cancelled" — cancellation wins over failure. Unknown or already finished runs fail with
404 not_found (a second cancel after the run settled is an error, not a no-op). The endpoint
defaults to the approval permission tier.
`);
    return;
  }
  const runId = requiredString(args, "run-id");
  printJson(
    await apiRequest(args, `/api/flow/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
    }),
  );
});
