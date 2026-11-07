#!/usr/bin/env node
import {
  UsageError,
  apiRequest,
  assertAllowedArgs,
  optionalString,
  parseArgs,
  printHelp,
  printJson,
  readJson,
  readText,
  run,
} from "./lib/common.mjs";

function parseHar(raw, flag) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`invalid JSON for --${flag}: ${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`--${flag} must contain a HAR JSON object`);
  }
  return value;
}

function parseTagsJson(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`invalid JSON for --tags-json: ${error.message}`);
  }
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new UsageError("--tags-json must be a JSON array of strings");
  }
  return value;
}

async function loadHar(args) {
  const inline = args["har-json"];
  const file = args["har-file"];
  if ((inline === undefined) === (file === undefined)) {
    throw new UsageError("provide exactly one of --har-json and --har-file");
  }
  if (inline !== undefined) return parseHar(inline, "har-json");
  return parseHar(await readText(file), "har-file");
}

run(async () => {
  const args = parseArgs();
  assertAllowedArgs(args, ["har-json", "har-file", "name", "tags-json", "origin"]);
  if (args.help) {
    printHelp(`
Usage: node request-library-create.mjs (--har-json JSON | --har-file FILE) [options]

Create a manual request-library entry from a HAR snapshot. The snapshot must carry at least one
entry; the server assigns id, timestamps and source "manual", defaulting the name to
"METHOD host+path".

  --har-json JSON        Inline HAR document, e.g. '{"log":{"entries":[...]}}'
  --har-file FILE        Path to a HAR document file
  --name NAME            Entry name
  --tags-json JSON       JSON array of tag strings, e.g. '["checkout","debug"]'
  --origin TEXT          Free-form provenance note for manual entries
`);
    return;
  }
  const har = await loadHar(args);
  const body = { har };
  const name = optionalString(args, "name");
  if (name !== undefined) body.name = name;
  if (args["tags-json"] !== undefined) body.tags = parseTagsJson(args["tags-json"]);
  const origin = optionalString(args, "origin");
  if (origin !== undefined) body.origin = origin;
  printJson(await apiRequest(args, "/api/request-library", { method: "POST", body }));
});
