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
  assertAllowedArgs(args, [
    "session-id",
    "host",
    "path",
    "method",
    "status",
    "keyword",
    "regex",
    "min-id",
    "max-id",
    "limit",
  ]);
  if (args.help) {
    printHelp(`
Usage: node log-search.mjs [options] [--base-url URL]

Predicate search over captures of one Session (active Session when --session-id is omitted).
Provided predicates combine with AND semantics; absent fields are ignored — a bare or empty
--keyword never degrades to "match everything".

Predicates:
  --session-id ID        Owning Session; defaults to the active Session
  --host TEXT            Substring-matches the request URI host portion
  --path TEXT            Substring-matches the request URI path
  --method TEXT          Case-insensitive method comparison
  --status TEXT          Exact response status code comparison; "..." matches captures that
                         have no response yet (in flight)
  --keyword TEXT         Substring-matches the request URI

Matching:
  --regex                Treat --host/--path/--keyword/--status as Rust regex patterns

Paging:
  --min-id ID            Exclusive lower bound; alone it scans toward newer IDs (ascending)
  --max-id ID            Exclusive upper bound; default scan direction is descending
  --limit N              Default 200, capped at 10,000; 0 returns no matches

Returns compact match summaries ({ id, in_progress, method, uri, code }). When the response is
truncated, continue from next_cursor by passing it as --max-id (descending default) or --min-id
(ascending scans); a page that is not truncated ends the scan.
`);
    return;
  }
  const sessionId = optionalInteger(args, "session-id", { min: 1 });
  const host = optionalString(args, "host");
  const requestPath = optionalString(args, "path");
  const method = optionalString(args, "method");
  const status = optionalString(args, "status");
  const keyword = optionalString(args, "keyword");
  const minId = optionalInteger(args, "min-id", { min: 0 });
  const maxId = optionalInteger(args, "max-id", { min: 1 });
  const limit = optionalInteger(args, "limit", { min: 0, max: 10_000 });
  const body = {
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    ...(host === undefined ? {} : { host }),
    ...(requestPath === undefined ? {} : { path: requestPath }),
    ...(method === undefined ? {} : { method }),
    ...(status === undefined ? {} : { status }),
    ...(keyword === undefined ? {} : { keyword }),
    ...(args.regex === true ? { regex: true } : {}),
    ...(minId === undefined ? {} : { min_id: minId }),
    ...(maxId === undefined ? {} : { max_id: maxId }),
    ...(limit === undefined ? {} : { limit }),
  };
  printJson(await apiRequest(args, "/api/logs/search", { method: "POST", body }));
});
