#!/usr/bin/env node
import {
  UsageError,
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
  assertAllowedArgs(args, ["query", "tags", "source", "limit", "offset", "json"]);
  if (args.help) {
    printHelp(`
Usage: node request-library-query.mjs [options]

List request-library entries as one filtered page, sorted by (createdAt, id).

Filters:
  --query TEXT           Matches the entry name and the first HAR request URL case-insensitively
  --tags A,B             Comma-separated; an entry must carry every requested tag
  --source NAME          One of capture, import, manual

Paging:
  --limit N              Default 200, must stay within 1-1000
  --offset N             Entries to skip before the page

Output:
  --json                 Condensed output: drop the bulky HAR snapshot from each entry
`);
    return;
  }
  const source = optionalString(args, "source");
  if (source !== undefined && !["capture", "import", "manual"].includes(source)) {
    throw new UsageError("--source must be capture, import, or manual");
  }
  const params = new URLSearchParams();
  const query = optionalString(args, "query");
  if (query !== undefined) params.set("query", query);
  const tags = optionalString(args, "tags");
  if (tags !== undefined) params.set("tags", tags);
  if (source !== undefined) params.set("source", source);
  const limit = optionalInteger(args, "limit", { min: 1, max: 1000 });
  if (limit !== undefined) params.set("limit", String(limit));
  const offset = optionalInteger(args, "offset", { min: 0 });
  if (offset !== undefined) params.set("offset", String(offset));
  const search = params.toString();
  const page = await apiRequest(args, `/api/request-library${search ? `?${search}` : ""}`);
  if (args.json === true) {
    printJson({
      total: page.total,
      entries: page.entries.map(({ har, ...entry }) => entry),
    });
    return;
  }
  printJson(page);
});
