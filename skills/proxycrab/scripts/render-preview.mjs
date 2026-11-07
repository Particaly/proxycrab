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
  assertAllowedArgs(args, ["workflow-id", "node-id", "variable-overrides-json"]);
  if (args.help) {
    printHelp(`
Usage: node render-preview.mjs --workflow-id ID --node-id ID [options]

Preview the rendered request of one httpReplay node (template render dry-run): renders the
exact request that would be sent — request-library/manual baseline + node override, browser
-only header stripping, {{ }} templates (env from the activated set, var from the 3-layer
table + overrides), fake.* sampled once consistently per preview, header-fidelity/cookie
merged. Zero outbound traffic, nothing persisted, secret values masked as ****** in the
response. preProcess scripts are NOT executed (pair with script-dry-run.mjs for those).

  --workflow-id ID       Stored workflow definition (required)
  --node-id ID           httpReplay node id to preview (required)
  --variable-overrides-json JSON
                         Optional var.* sample values (highest precedence) — e.g. sample
                         values for setVariable-declared runtime variables
                         ({"runTag":"rt-1"})

Prints {"ok":true,"baseline":"requestLibrary"|"manual","request":{method,url,headers,
body?,bodyBase64?,timeoutMs?},"warnings":[…]} on success, or
{"ok":false,"error":{"kind":"missing-baseline"|"engine"|"timeout","message":"…"}} on failure.
HTTP-level failures (unknown workflow/node 404; non-httpReplay node or missing baseline 422)
surface through the management error envelope.
`);
    return;
  }
  const workflowId = requiredString(args, "workflow-id");
  const nodeId = requiredString(args, "node-id");
  const body = { workflowId, nodeId };
  if (args["variable-overrides-json"] !== undefined) {
    try {
      body.variableOverrides = JSON.parse(args["variable-overrides-json"]);
    } catch (error) {
      throw new UsageError(`invalid JSON for --variable-overrides-json: ${error.message}`);
    }
  }
  printJson(await apiRequest(args, "/api/flow/render-preview", { method: "POST", body }));
});
