#!/usr/bin/env node
import {
  UsageError,
  apiRequest,
  assertAllowedArgs,
  parseArgs,
  printHelp,
  printJson,
  readText,
  requiredString,
  run,
} from "./lib/common.mjs";

function parseSampleJson(raw, flag) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`invalid JSON for --${flag}: ${error.message}`);
  }
}

run(async () => {
  const args = parseArgs();
  assertAllowedArgs(args, ["side", "file", "inline", "sample-input-json", "sample-response-json"]);
  if (args.help) {
    printHelp(`
Usage: node script-dry-run.mjs --side pre|post (--file SCRIPT.js | --inline CODE) [options]

Dry-run one workflow pre/post script against a sample payload in a throwaway flow VM: nothing
is created, persisted, broadcast, or replayed, and the executed script is excluded from the
permission audit preview. Prints {"ok":true,"value":…,"warnings":[…]} on success or
{"ok":false,"error":{"kind":…,"message":…}} on failure.

  --side pre|post        pre scripts receive input (the upstream aggregate) and return a
                         request-override object (url/headers/body/timeoutMs); post scripts
                         receive response (status/headers/body/json?/durationMs) and return
                         the node output (default response.body)
  --file SCRIPT.js       Read the script source from a file (the script is a function body,
                         so use return)
  --inline CODE          Script source given inline instead of --file
  --sample-input-json JSON
                         Sample upstream aggregate (useful with --side pre)
  --sample-response-json JSON
                         Sample response object (useful with --side post)

The side picks which sample field is used (missing → null); both samples are optional.
`);
    return;
  }
  const side = requiredString(args, "side");
  if (side !== "pre" && side !== "post") {
    throw new UsageError("--side must be pre or post");
  }
  const inline = args["inline"];
  const file = args["file"];
  if ((inline === undefined) === (file === undefined)) {
    throw new UsageError("provide exactly one of --file and --inline");
  }
  const body = { side, script: inline !== undefined ? inline : await readText(file) };
  if (args["sample-input-json"] !== undefined) {
    body.sampleInput = parseSampleJson(args["sample-input-json"], "sample-input-json");
  }
  if (args["sample-response-json"] !== undefined) {
    body.sampleResponse = parseSampleJson(args["sample-response-json"], "sample-response-json");
  }
  printJson(await apiRequest(args, "/api/flow/script/dry-run", { method: "POST", body }));
});
