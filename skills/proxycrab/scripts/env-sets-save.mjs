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
  assertAllowedArgs(args, ["id", "name", "values-json", "secret-values-json"]);
  if (args.help) {
    printHelp(`
Usage: node env-sets-save.mjs --id SET_ID --name NAME [options] [--base-url URL]

Replace one environment variable set's name and variable tables. The save contract requires
--name; the set id never appears in the body.

  --id SET_ID            Set to save (required)
  --name NAME            New set name (required by the save contract)
  --values-json JSON     Normal values table, e.g. '{"baseUrl":"https://dev.example.com"}'
  --secret-values-json JSON
                         Secret values table. Masked round trip: a value left as "******"
                         keeps the stored plaintext; an explicit new value overrides it.

Only provided tables are sent; omitted tables stay unchanged on the server side.
`);
    return;
  }
  const id = requiredString(args, "id");
  const body = { name: requiredString(args, "name") };
  if (args["values-json"] !== undefined) body.values = parseTableJson(args["values-json"], "values-json");
  if (args["secret-values-json"] !== undefined) {
    body.secretValues = parseTableJson(args["secret-values-json"], "secret-values-json");
  }
  printJson(
    await apiRequest(args, `/api/env-sets/${encodeURIComponent(id)}`, { method: "PUT", body }),
  );
});
