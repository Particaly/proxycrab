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

function parseTableJson(raw, flag) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`invalid JSON for --${flag}: ${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`--${flag} must be a JSON object`);
  }
  return value;
}

run(async () => {
  const args = parseArgs();
  assertAllowedArgs(args, ["name", "copy-from", "values-json", "secret-values-json"]);
  if (args.help) {
    printHelp(`
Usage: node env-sets-create.mjs --name NAME [options] [--base-url URL]

Create one environment variable set, or duplicate an existing one under a generated "env-…"
id. The response echoes the stored set with secrets masked as "******".

  --name NAME            Set name (required)
  --copy-from SET_ID     Duplicate this set (including its secrets) instead of starting empty
  --values-json JSON     Normal values table, e.g. '{"baseUrl":"https://dev.example.com"}'
  --secret-values-json JSON
                         Secret values table, e.g. '{"token":"s3cret"}'
`);
    return;
  }
  const body = { name: requiredString(args, "name") };
  const copyFrom = args["copy-from"];
  if (copyFrom !== undefined) {
    if (copyFrom.length === 0) throw new UsageError("--copy-from must not be empty");
    body.copyFrom = copyFrom;
  }
  if (args["values-json"] !== undefined) body.values = parseTableJson(args["values-json"], "values-json");
  if (args["secret-values-json"] !== undefined) {
    body.secretValues = parseTableJson(args["secret-values-json"], "secret-values-json");
  }
  printJson(await apiRequest(args, "/api/env-sets", { method: "POST", body }));
});
