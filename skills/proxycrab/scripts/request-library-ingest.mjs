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
  requiredInteger,
  run,
} from "./lib/common.mjs";

function parseTags(raw) {
  if (raw === undefined) return undefined;
  const tags = raw.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  if (tags.length === 0) throw new UsageError("--tags must name at least one tag");
  return tags;
}

run(async () => {
  const args = parseArgs();
  assertAllowedArgs(args, ["capture-id", "session-id", "name", "tags"]);
  if (args.help) {
    printHelp(`
Usage: node request-library-ingest.mjs --capture-id ID [options]

Ingest one completed ProxyCrab capture into the request library as a replayable entry.

  --capture-id ID        Capture to ingest (required)
  --session-id ID        Owning Session; defaults to the active Session (409 conflict when none
                         is active; archived Sessions are accepted)
  --name NAME            Entry name; defaults to "METHOD host+path"
  --tags A,B             Comma-separated tags attached to the new entry

Prints the stored entry (id, name, tags, source, origin, har, timestamps). A missing capture or
Session fails with 404 not_found. This endpoint defaults to the approval permission tier.
`);
    return;
  }
  const captureId = requiredInteger(args, "capture-id", { min: 1 });
  const sessionId = optionalInteger(args, "session-id", { min: 1 });
  const name = optionalString(args, "name");
  const tags = parseTags(optionalString(args, "tags"));
  const entry = await apiRequest(args, "/api/request-library/from-capture", {
    method: "POST",
    body: {
      capture_id: captureId,
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
      ...(name === undefined ? {} : { name }),
      ...(tags === undefined ? {} : { tags }),
    },
  });
  printJson(entry);
});
