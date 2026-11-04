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

function readGraph(document, label) {
  if (document.nodes === undefined && document.edges === undefined) return {};
  if (document.nodes === undefined || document.edges === undefined) {
    throw new UsageError(
      `${label} must provide nodes and edges together (the API replaces the graph as one unit)`,
    );
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
  assertAllowedArgs(args, ["workflow-id", "project-id", "name", "description", "file"]);
  if (args.help) {
    printHelp(`
Usage: node workflow-save.mjs (--workflow-id ID | --project-id ID --name NAME) [options]

Create a workflow definition, or apply a partial update to an existing one.

Identity:
  --workflow-id ID       Update this definition instead of creating a new one
  --project-id ID        Target project for a new definition (not checked for existence)
  --name NAME            Definition name (required when creating)
  --description TEXT     Free-form description; an empty string clears it

Graph:
  --file GRAPH.json      JSON object with { nodes, edges }, optionally variables and
                         secretVariables. A full workflow document from workflow-get also works;
                         its id/name/project fields are ignored. nodes and edges are always sent
                         together as one whole-graph replacement.

Creating without --file produces an empty definition skeleton. Updating requires at least one of
--name, --description, or --file. Writes default to the approval permission tier.
`);
    return;
  }
  const workflowId = optionalString(args, "workflow-id");
  const filePath = optionalString(args, "file");
  let file;
  if (filePath !== undefined) {
    file = await readJson(filePath);
    if (typeof file !== "object" || file === null || Array.isArray(file)) {
      throw new UsageError("--file must contain a JSON object");
    }
  }
  const graph = file === undefined ? {} : readGraph(file, "--file");

  if (workflowId === undefined) {
    const body = {
      projectId: requiredString(args, "project-id"),
      name: requiredString(args, "name"),
      ...(args.description === undefined ? {} : { description: args.description }),
      ...graph,
    };
    const workflow = await apiRequest(args, "/api/workflows", { method: "POST", body });
    printJson({ action: "created", workflow });
    return;
  }

  const body = {};
  const name = optionalString(args, "name");
  if (name !== undefined) body.name = name;
  if (args.description !== undefined) body.description = args.description;
  Object.assign(body, graph);
  if (Object.keys(body).length === 0) {
    throw new UsageError("nothing to update: provide --name, --description, or --file");
  }
  const workflow = await apiRequest(args, `/api/workflows/${encodeURIComponent(workflowId)}`, {
    method: "PUT",
    body,
  });
  printJson({ action: "updated", workflow });
});
