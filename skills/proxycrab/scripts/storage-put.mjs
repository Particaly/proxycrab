#!/usr/bin/env node
import {
  UsageError,
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
  assertAllowedArgs(args, ["workflow-id", "key", "value-json"]);
  if (args.help) {
    printHelp(`
Usage: node storage-put.mjs --workflow-id <id> --key <key> --value-json <json> [--base-url URL]

Upsert one key with an arbitrary JSON value in a workflow's persistent storage
(mirrors PUT /api/workflows/{id}/storage/{key}). The write persists immediately
and is visible to running and later runs in real time; the response carries the
refreshed entry list. Key charset: [A-Za-z0-9._-], max 128 bytes; quotas: 256 KiB
per value, 4 MiB + 10000 entries per workflow (violations return 400 bad_request).
`);
    return;
  }
  const workflowId = requiredString(args, "workflow-id");
  const key = requiredString(args, "key");
  if (args["value-json"] === undefined) {
    throw new UsageError("--value-json is required (any JSON value)");
  }
  let value;
  try {
    value = JSON.parse(args["value-json"]);
  } catch (error) {
    throw new Error(`--value-json is not valid JSON: ${error.message}`);
  }
  printJson(
    await apiRequest(
      args,
      `/api/workflows/${encodeURIComponent(workflowId)}/storage/${encodeURIComponent(key)}`,
      { method: "PUT", body: { value } },
    ),
  );
});

