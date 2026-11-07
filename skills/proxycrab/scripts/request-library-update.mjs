#!/usr/bin/env node
import {
  UsageError,
  apiRequest,
  assertAllowedArgs,
  optionalString,
  parseArgs,
  printHelp,
  printJson,
  readText,
  requiredString,
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
  if (inline !== undefined && file !== undefined) {
    throw new UsageError("use only one of --har-json and --har-file");
  }
  if (inline !== undefined) return parseHar(inline, "har-json");
  if (file !== undefined) return parseHar(await readText(file), "har-file");
  return undefined;
}

run(async () => {
  const args = parseArgs();
  assertAllowedArgs(args, ["id", "name", "tags-json", "origin", "har-json", "har-file"]);
  if (args.help) {
    printHelp(`
Usage: node request-library-update.mjs --id ID [options] [--base-url URL]

Apply a partial update to one request-library entry. Absent fields stay unchanged; id, source
and createdAt are never editable and updatedAt is refreshed by the server. Replacing the
snapshot with one that embeds an inline request body drops a stale bodyRef blob.

  --id ID                Entry to update (required)
  --name NAME            Entry name
  --tags-json JSON       JSON array of tag strings, e.g. '["checkout","debug"]'
  --origin TEXT          Free-form provenance note
  --har-json JSON        Replacement HAR document (inline)
  --har-file FILE        Replacement HAR document (file path)

At least one field must be provided.
`);
    return;
  }
  const id = requiredString(args, "id");
  const body = {};
  const name = optionalString(args, "name");
  if (name !== undefined) body.name = name;
  if (args["tags-json"] !== undefined) body.tags = parseTagsJson(args["tags-json"]);
  const origin = optionalString(args, "origin");
  if (origin !== undefined) body.origin = origin;
  const har = await loadHar(args);
  if (har !== undefined) body.har = har;
  if (Object.keys(body).length === 0) {
    throw new UsageError("nothing to update: provide --name, --tags-json, --origin, or --har-json/--har-file");
  }
  printJson(
    await apiRequest(args, `/api/request-library/${encodeURIComponent(id)}`, { method: "PUT", body }),
  );
});
