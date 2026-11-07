#!/usr/bin/env node
import {
  ApiError,
  apiRequest,
  assertAllowedArgs,
  optionalInteger,
  parseArgs,
  printHelp,
  printJson,
  requiredString,
  run,
} from "./lib/common.mjs";

const RUN_ERROR_HINTS = {
  conflict: "no active Session; pass --session-id or activate one first",
  not_found: "the target Session is missing or archived; pass a live --session-id",
  workflow_graph_invalid:
    "fix the workflow graph (issue messages are joined in the server error) or check it with workflow-validate.mjs",
  permission_denied: "this API identity's permission for POST /api/flow/runs is deny",
  approval_timeout:
    "the request waited 30 seconds for a desktop approval decision; approve it in the desktop UI or change the permission for POST /api/flow/runs",
};

function rethrowWithHint(error) {
  if (!(error instanceof ApiError)) throw error;
  const hint = RUN_ERROR_HINTS[error.code];
  if (hint === undefined) throw error;
  throw new ApiError(error.status, error.code, `${error.message} — ${hint}`);
}

run(async () => {
  const args = parseArgs();
  assertAllowedArgs(args, ["workflow-id", "session-id", "start-node-id"]);
  if (args.help) {
    printHelp(`
Usage: node run-trigger.mjs --workflow-id ID [--session-id ID] [--start-node-id ID] [--base-url URL]

Trigger one workflow run through the target Session's pipeline and print the run record
(id "run-…", status "running", resolved "startNodeId", graph snapshot captured at dispatch).
The proxy does not need to be running (replays use a flow-dedicated connection generation).
The endpoint defaults to the approval permission tier.

  --workflow-id ID       Stored workflow definition to execute (required)
  --session-id ID        Target Session; defaults to the active Session
  --start-node-id ID     Entry start node for multi-start workflows; required when the
                         workflow has more than one start node (the 422 message lists
                         every start id; unchosen start chains settle as "skipped")

Known failure codes are re-emitted with a readable hint appended to the server message:
  404 not_found               The given --session-id is missing or archived
  409 conflict                No active Session (when --session-id is omitted)
  422 workflow_graph_invalid  The stored graph failed error-level validation before the run
                              row was created — including entry errors: a multi-start
                              workflow triggered without --start-node-id, or a
                              --start-node-id that is not an existing start node
  403 permission_denied / approval_timeout  Desktop approval was denied or timed out
`);
    return;
  }
  const workflowId = requiredString(args, "workflow-id");
  const sessionId = optionalInteger(args, "session-id", { min: 1 });
  const startNodeId = args["start-node-id"] === undefined ? undefined : requiredString(args, "start-node-id");
  const record = await apiRequest(args, "/api/flow/runs", {
    method: "POST",
    body: {
      workflowId,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(startNodeId === undefined ? {} : { startNodeId }),
    },
  }).catch(rethrowWithHint);
  printJson(record);
});
