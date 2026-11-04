#!/usr/bin/env node
import {
  apiRequest,
  assertAllowedArgs,
  optionalInteger,
  optionalString,
  parseArgs,
  printHelp,
  printJson,
  run,
} from "./lib/common.mjs";

run(async () => {
  const args = parseArgs();
  assertAllowedArgs(args, ["project-id", "limit", "offset"]);
  if (args.help) {
    printHelp(`
Usage: node workflow-list.mjs [options]

List workflow definitions as one page, sorted by (createdAt, id).

  --project-id ID        Only definitions inside this project
  --limit N              Page size
  --offset N             Entries to skip before the page

Prints { workflows: [...], total } where total counts every matching definition.
`);
    return;
  }
  const params = new URLSearchParams();
  const projectId = optionalString(args, "project-id");
  if (projectId !== undefined) params.set("projectId", projectId);
  const limit = optionalInteger(args, "limit", { min: 1 });
  if (limit !== undefined) params.set("limit", String(limit));
  const offset = optionalInteger(args, "offset", { min: 0 });
  if (offset !== undefined) params.set("offset", String(offset));
  const search = params.toString();
  printJson(await apiRequest(args, `/api/workflows${search ? `?${search}` : ""}`));
});
