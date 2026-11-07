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
  requiredString,
  run,
} from "./lib/common.mjs";

function parseArrayJson(raw, flag) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`invalid JSON for --${flag}: ${error.message}`);
  }
  if (!Array.isArray(value)) throw new UsageError(`--${flag} must be a JSON array`);
  return value;
}

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

function readDraftGraph(document, label) {
  if (document.nodes === undefined || document.edges === undefined) {
    throw new UsageError(`${label} must provide nodes and edges together`);
  }
  if (!Array.isArray(document.nodes) || !Array.isArray(document.edges)) {
    throw new UsageError(`${label} nodes and edges must be arrays`);
  }
  const graph = { nodes: document.nodes, edges: document.edges };
  if (document.variables !== undefined) graph.variables = document.variables;
  if (document.secretVariables !== undefined) graph.secretVariables = document.secretVariables;
  return graph;
}

run(async () => {
  const args = parseArgs();
  assertAllowedArgs(args, [
    "workflow-id",
    "graph-file",
    "nodes-json",
    "edges-json",
    "variables-json",
    "secret-variables-json",
  ]);
  if (args.help) {
    printHelp(`
Usage:
  node workflow-validate-deep.mjs --workflow-id ID [--base-url URL]
  node workflow-validate-deep.mjs (--graph-file GRAPH.json | --nodes-json JSON --edges-json JSON)
                                  [--variables-json JSON] [--secret-variables-json JSON]

Deep-validate a workflow graph (editor diagnostics; read-only despite the POST verb). Prints
{ issues: [{ severity, code, message, nodeIds }] }; an empty issues list means the graph is
valid. The body is exactly one of:

  --workflow-id ID             Deep-check the stored definition (body {"id":…})
  --graph-file FILE            JSON document with { nodes, edges }, optionally variables and
                               secretVariables; those fields are sent verbatim
  --nodes-json + --edges-json  Inline draft arrays as an alternative to --graph-file
  --variables-json JSON        Draft mode only: variables table (overrides the document's)
  --secret-variables-json JSON Draft mode only: secretVariables table (overrides the document's)

Deep issues never gate saves or runs (the run gate stays structural-only; use
workflow-validate.mjs for the structural endpoint).
`);
    return;
  }
  const workflowId = optionalString(args, "workflow-id");
  const graphFile = optionalString(args, "graph-file");
  const nodesJson = args["nodes-json"];
  const edgesJson = args["edges-json"];

  if (workflowId !== undefined) {
    if (graphFile !== undefined || nodesJson !== undefined || edgesJson !== undefined) {
      throw new UsageError(
        "--workflow-id cannot be combined with --graph-file/--nodes-json/--edges-json",
      );
    }
    if (args["variables-json"] !== undefined || args["secret-variables-json"] !== undefined) {
      throw new UsageError("--variables-json/--secret-variables-json only apply in draft mode");
    }
    printJson(
      await apiRequest(args, "/api/flow/validate", { method: "POST", body: { id: workflowId } }),
    );
    return;
  }

  if (graphFile !== undefined && (nodesJson !== undefined || edgesJson !== undefined)) {
    throw new UsageError("use --graph-file or --nodes-json + --edges-json, not both");
  }
  let graph;
  if (graphFile !== undefined) {
    const document = await readJson(graphFile);
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      throw new UsageError("--graph-file must contain a JSON object");
    }
    graph = readDraftGraph(document, "--graph-file");
  } else if (nodesJson !== undefined || edgesJson !== undefined) {
    if (nodesJson === undefined || edgesJson === undefined) {
      throw new UsageError("--nodes-json and --edges-json must be provided together");
    }
    graph = {
      nodes: parseArrayJson(nodesJson, "nodes-json"),
      edges: parseArrayJson(edgesJson, "edges-json"),
    };
  } else {
    throw new UsageError("provide --workflow-id, --graph-file, or --nodes-json + --edges-json");
  }
  if (args["variables-json"] !== undefined) {
    graph.variables = parseTableJson(args["variables-json"], "variables-json");
  }
  if (args["secret-variables-json"] !== undefined) {
    graph.secretVariables = parseTableJson(args["secret-variables-json"], "secret-variables-json");
  }
  printJson(await apiRequest(args, "/api/flow/validate", { method: "POST", body: graph }));
});
