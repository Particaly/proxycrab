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
  assertAllowedArgs(args, ["set-id"]);
  if (args.help) {
    printHelp(`
Usage: node env-sets-activate.mjs --set-id SET_ID|none [--base-url URL]

Switch the activated environment variable set; the activation preference holds at most one set.

  --set-id SET_ID        Set to activate
  --set-id none          Clear the activation preference (sends {"setId":null})
`);
    return;
  }
  const setId = requiredString(args, "set-id");
  const body = { setId: setId === "none" ? null : setId };
  printJson(await apiRequest(args, "/api/env-sets/active", { method: "PUT", body }));
});
