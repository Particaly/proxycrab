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
  assertAllowedArgs(args, ["id"]);
  if (args.help) {
    printHelp(`
Usage: node env-sets-delete.mjs --id SET_ID [--base-url URL]

Delete one environment variable set. Deleting a missing id succeeds silently; deleting the
active set also clears the activation preference in the same write.
`);
    return;
  }
  const id = requiredString(args, "id");
  printJson(
    await apiRequest(args, `/api/env-sets/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
});
