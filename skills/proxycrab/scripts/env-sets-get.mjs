#!/usr/bin/env node
import {
  apiRequest,
  assertAllowedArgs,
  parseArgs,
  printHelp,
  printJson,
  run,
} from "./lib/common.mjs";

run(async () => {
  const args = parseArgs();
  assertAllowedArgs(args, []);
  if (args.help) {
    printHelp(`
Usage: node env-sets-get.mjs [--base-url URL]

Read the whole environment variable sets envelope: named sets (each with values and
secretValues tables), the activeSetId activation preference, and the global variables table.
Secret values are masked end to end — every secret reads back as "******"; normal values stay
readable. Writing "******" back restores the stored plaintext (see env-sets-save.mjs).
`);
    return;
  }
  printJson(await apiRequest(args, "/api/env-sets"));
});
