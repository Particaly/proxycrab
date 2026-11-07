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
Usage: node request-library-delete.mjs --id ID [--base-url URL]

Delete one request-library entry together with its blob; missing ids return 404 not_found.
`);
    return;
  }
  const id = requiredString(args, "id");
  printJson(
    await apiRequest(args, `/api/request-library/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
});
