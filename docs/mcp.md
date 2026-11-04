# ProxyCrab MCP interface

The management server exposes a Model Context Protocol (MCP) endpoint so AI agents can inspect
captures and drive workflows with the same semantics as the management API. This document is the
integration view: how to connect a client, which tools are available, and the safety rails around
them. The wire-level contract of the mirrored `/api/*` routes lives in
[backend-api.md](backend-api.md).

## Overview

- Endpoint: `POST /mcp`, stateless JSON-RPC 2.0 implemented in-repo (no MCP SDK). The endpoint
  shares the listen address and port of the management API; the CLI can override the port with
  `PROXYCRAB_API_PORT`.
- Every request is independently authenticated: loopback callers run as the local identity without
  a token, and every remote caller must send exactly one `Authorization: Bearer pcrab_…` key.
- Protocol negotiation: an `initialize` requesting `2024-11-05`, `2025-03-26`, or `2025-06-18` is
  echoed back verbatim; any other requested version falls back to `2025-06-18`.
- Responses are raw JSON-RPC envelopes (`{jsonrpc, id, result}` / `{jsonrpc, id, error}`) and never
  use the management API's `{ok, data}` wrapper.

## Client configuration

Point any MCP client at the HTTP endpoint. Replace `<port>` with the management API port (the CLI
prints it at startup; `PROXYCRAB_API_PORT` overrides it):

```json
{
  "mcpServers": {
    "proxy-crab": {
      "url": "http://127.0.0.1:<port>/mcp"
    }
  }
}
```

Remote callers add an `Authorization: Bearer pcrab_…` header to every request. The `initialize`
result declares `capabilities.tools` and `serverInfo` (`proxy-crab` plus the crate version).

The same exchange over `curl` (loopback needs no token):

```bash
# 1) initialize
curl -s -X POST http://127.0.0.1:<port>/mcp -H 'Content-Type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": {"name": "curl", "version": "0"}
  }
}'

# 2) list tools
curl -s -X POST http://127.0.0.1:<port>/mcp -H 'Content-Type: application/json' -d '{
  "jsonrpc": "2.0", "id": 2, "method": "tools/list"
}'

# 3) call a tool
curl -s -X POST http://127.0.0.1:<port>/mcp -H 'Content-Type: application/json' -d '{
  "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": {"name": "sessions_list", "arguments": {}}
}'
```

There is no session state between requests; each POST is independent. Notifications (no `id`) are
acknowledged with `202 Accepted` and no body, and request bodies are capped at 1 MiB. Unparsable
JSON returns `-32700`, structurally broken envelopes `-32600`, unknown methods `-32601`, and a
missing/empty tool name `-32602`.

## Tool catalog

Fifteen curated tools mirror management API routes one to one. The tier column is explained in the
next section; the mirrored routes' request/response shapes are documented in
[backend-api.md](backend-api.md).

| Tool | Mirrors | Tier | Description |
| --- | --- | --- | --- |
| `sessions_list` | `GET /api/sessions` | read | List capture sessions and the active session. |
| `log_ids` | `POST /api/logs/ids` | read | Bounded, filterable capture log ID query. |
| `log_detail` | `GET /api/logs/{id}` | read | Complete detail of one capture. |
| `log_body` | `GET /api/logs/{id}/body` | read | Stored or streaming-decoded request/response body. |
| `request_library_list` | `GET /api/request-library` | read | One filtered page of saved requests. |
| `request_library_detail` | `GET /api/request-library/{id}` | read | One saved request's full definition. |
| `request_library_from_capture` | `POST /api/request-library/from-capture` | write | Ingest one capture into the request library. |
| `workflows_list` | `GET /api/workflows` | read | One page of workflow definitions. |
| `workflow_detail` | `GET /api/workflows/{id}` | read | One workflow's whole graph. |
| `workflow_validate` | `POST /api/workflows/{id}/validate` | read | Run the structural graph validator (read-only despite the POST verb). |
| `workflow_save` | `PUT /api/workflows/{id}` | write | Create or replace a workflow graph (PUT update semantics; `nodes` + `edges` form one unit). |
| `workflow_runs_list` | `GET /api/flow/runs` | read | One page of workflow runs, newest first. |
| `workflow_run_detail` | `GET /api/flow/runs/{id}` | read | Run record plus per-node checkpoints. |
| `workflow_run_trigger` | `POST /api/flow/runs` | execute | Start one workflow run. |
| `workflow_run_cancel` | `POST /api/flow/runs/{id}/cancel` | execute | Request cancellation of a running workflow. |

There is no MCP tool for creating a workflow definition from scratch. Create it through
`POST /api/workflows` or the creation mode of `workflow-save.mjs` first, then persist the graph
with `workflow_save`.

## Exposure tiers

Every tool declares one of three tiers, gated by workspace-level switches:

| Tier | Default | Tools |
| --- | --- | --- |
| `read` | on | the eleven read tools |
| `write` | off | `request_library_from_capture`, `workflow_save` |
| `execute` | off | `workflow_run_trigger`, `workflow_run_cancel` |

The switches persist as a versioned envelope at `<workspace>/flow/mcp-tools.json`; a corrupt
envelope degrades reads to the defaults with a warning and refuses writes. Manage the switches
over HTTP:

- `GET /api/mcp-tiers` returns the current `{read, write, execute}` switches (default `allow`).
- `PUT /api/mcp-tiers` replaces all three switches (default `approval`).

A tool whose tier is off does not appear in `tools/list`, and `tools/call` hard-rejects it with the
tool-level error `tool '<name>': 该工具类别的 MCP 档位已关闭` even when addressed by name.

## Approval chain

Every `tools/call` passes three gates, and the strictest outcome wins:

1. Endpoint check — `POST /mcp` is itself a permission-catalog action evaluated for the caller's
   identity on every request.
2. Tier gating — the tool's tier switch must be on.
3. Mapped-route check — the mirrored `/api/*` route's own permission runs again for the same
   identity. When it resolves to `approval`, the existing desktop approval window is reused with
   its 30-second timeout, exactly like a direct HTTP call.

Denial and approval timeout/rejection are never transport errors or silent downgrades: the call
returns HTTP 200 with `result.isError: true` and a readable text `content` entry.

## Security boundaries and limits

- A single execution is capped at 30 seconds; the timeout yields a tool-level error and the
  underlying work is cancelled together with the call.
- At most 4 tool calls are in flight process-wide; additional calls fail fast with no queuing.
- A client disconnect drops the handler and cancels the in-flight execution.
- Read tools paginate: `workflows_list` defaults to 50 and caps at 200; other list tools use the
  manager's validation (for example `1..=1000`).
- Body content renders under the restricted rendering limits; oversize bodies collapse to a
  "Large" summary instead of raw bytes.
- Error text is centrally mapped and never contains file paths or credentials; only `bad_request`
  validation messages from the manager pass through verbatim.

### Redaction

A Bearer caller's redaction binding applies to tool results: bound callers receive tool output
through the same redaction path as `/api/*` reads (scripts observe `context.api == "mcp"`). A
binding that fails to resolve fails closed. The `local` identity is not redacted.

## Audit

Every `tools/call` that passes name validation and tier gating — denied by permission or executed
alike — appends one entry to
`<workspace>/flow/mcp-audit.json` (most recent 500 entries; best-effort and never blocks the
call). Entries are camelCase: `seq`, `timestampMs`, `tool`, `identity` (`local`, `unresolved`, or
the caller's share identity id), `argumentsSummary` (the raw arguments JSON truncated to 500
characters with a `…` marker; result bodies are never stored), `outcome` (`ok`/`denied`/`error`),
`decision` (`allowed`/`denied`), and optional `reason`.

Query the trail with `GET /api/mcp-audit?limit=` (default 100, capped at 500, newest first), or
read it in the settings window's “MCP 调用审计” section.

## Known limitations

- `bodyBase64` is textualized lossily for MCP tool results; see
  [runtime-notes.md](runtime-notes.md#workflow-run-orchestration) ("Workflow run orchestration").
- The MCP surface intentionally exposes no script library, permission management, sharing, CA,
  system-log, bypass, redaction-library, env-set, flow-project, or workflow import/export
  operations.

## ReqFlow M19 reconciliation

The upstream ReqFlow plan (milestone M19, decision DD-10) specifies an MCP exposure for a browser
extension that cannot listen on ports. ProxyCrab is a desktop/CLI application that already owns
its management HTTP server, so several M19 mechanisms are structurally inapplicable here:

- **DD-10 (host MCP service + bridge-side tool declaration)** — not applicable: there is no
  ZTools host, no `reqflow-bridge` plugin, and no `plugin.json`/`registerTool`/`mcpName`
  declaration layer. The MCP server is built into `proxy-crab-mgr` (`POST /mcp` on the
  management listen address, JSON-RPC 2.0, Bearer or loopback identity, 1 MiB request cap) and
  tools are declared in the in-repo curated registry (`crates/proxy-crab-mgr/src/mcp/tools.rs`).
- **M19-T1 (bridge ↔ extension command channel)** — not applicable: no browser extension, no
  long-poll command channel, no result backfill, no command TTL/correlation machinery. Tool
  calls execute in-process against the same `ProxyCrabManager` trait the HTTP routes use.
- **M19-T2 (read tools)** — covered: capture reads (`sessions_list`, `log_ids`, `log_detail`,
  `log_body`), request library, workflow and run queries mirror the upstream intent of a curated
  query surface. Env sets, three-layer variables, and bridge status are deliberately not exposed
  (curated-surface decision, see Known limitations). Upstream's secret non-disclosure maps to the
  redaction binding; upstream's header redaction at MCP ingest maps to executing bound callers
  through the same redaction path as `/api/*` reads.
- **M19-T3 (execute tools)** — partially covered: `workflow_run_trigger` and
  `workflow_run_cancel` mirror `run_workflow`/`cancel_run`. There is no server-side `wait_run`
  (clients poll `workflow_run_detail`/`workflow_runs_list`), and no `debug_node`,
  `rerun_from_node`, or `rerun_loop_iteration`.
- **M19-T4 (write tools)** — partially covered: `workflow_save` persists a whole graph with
  structural validation (upstream's validate-before-write), and `request_library_from_capture`
  covers capture ingestion. Project CRUD, workflow import/export (and therefore the
  `confirmScripts` gate), env-set CRUD, and three-layer variable writes are not exposed.
- **M19-T5 (primitive request tools)** — not exposed: no `replay_request`/`send_http_request`
  MCP tool; replay stays on the existing `POST /api/replay` HTTP route outside the curated
  surface.
- **M19-T6 (three-tier switch + audit)** — covered and tightened: read (default on) / write /
  execute (default off) switches persist per workspace, closed tiers hide tools from
  `tools/list` and hard-reject `tools/call`, and every auditable call lands in
  `flow/mcp-audit.json` (tool, identity, arguments summary, outcome, decision, time) with an
  HTTP query and a settings-window view. ProxyCrab additionally stacks a per-route permission
  check with the desktop approval window (stricter of the three gates wins), which upstream's
  two-gate design does not have.
- **M19-T7 (docs + verification)** — covered: this guide plus the implementation-level sections
  in [backend-api.md](backend-api.md), MCP-driven eval cases in
  `skills/proxycrab/evals/evals.json`, and the two-layer tier/bounds/audit test matrix.
