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

Thirty-three curated tools. All of them mirror management API routes one to one except
`workflow_run_wait`,
which layers server-side polling on top of the run-detail route (same permission, compact digest
payload). The tier column is explained in the next section; the mirrored routes' request/response
shapes are documented in [backend-api.md](backend-api.md).

| Tool | Mirrors | Tier | Description |
| --- | --- | --- | --- |
| `sessions_list` | `GET /api/sessions` | read | List capture sessions and the active session. |
| `log_ids` | `POST /api/logs/ids` | read | Bounded, filterable capture log ID query. |
| `log_search` | `POST /api/logs/search` | read | AND-composed host/path/method/status/keyword search returning compact match summaries (the fast way to locate requests). |
| `log_detail` | `GET /api/logs/{id}` | read | Complete detail of one capture; optional `max_body_length` truncates long request/response bodies in the payload. |
| `log_body` | `GET /api/logs/{id}/body` | read | Stored or streaming-decoded request/response body (bounded render). |
| `replay_once` | `POST /api/replay` | execute | Send one replay (raw request or request-library entry + overrides) and get the new capture id. |
| `request_library_list` | `GET /api/request-library` | read | One filtered page of saved requests. |
| `request_library_detail` | `GET /api/request-library/{id}` | read | One saved request's full definition. |
| `request_library_body` | `GET /api/request-library/{id}/body` | read | One saved request's raw body. |
| `request_library_create` | `POST /api/request-library` | write | Create one entry from a HAR snapshot. |
| `request_library_update` | `PUT /api/request-library/{id}` | write | Partially update one entry. |
| `request_library_delete` | `DELETE /api/request-library/{id}` | write | Delete one entry. |
| `request_library_from_capture` | `POST /api/request-library/from-capture` | write | Ingest one capture into the request library. |
| `env_sets_list` | `GET /api/env-sets` | read | Env sets, activation preference and globals; secret values masked as `******`. |
| `env_sets_create` | `POST /api/env-sets` | write | Create one env set (or duplicate one via `copyFrom`). |
| `env_sets_save` | `PUT /api/env-sets/{id}` | write | Replace one env set's plain fields. The secret table (the per-key masked marking) is read-only over MCP and is preserved as-is; passing `secretValues` is rejected — edit secret entries in the desktop UI. |
| `env_sets_activate` | `PUT /api/env-sets/active` | write | Switch the activated env set (workflows resolve `{{ env.* }}` from it at dispatch). |
| `env_sets_delete` | `DELETE /api/env-sets/{id}` | write | Delete one env set. |
| `workflows_list` | `GET /api/workflows` | read | One page of workflow definitions. |
| `workflow_detail` | `GET /api/workflows/{id}` | read | One workflow's whole graph. |
| `workflow_create` | `POST /api/workflows` | write | Create one workflow definition (server-generated id). |
| `workflow_validate` | `POST /api/workflows/{id}/validate` | read | Run the structural graph validator (read-only despite the POST verb). |
| `workflow_validate_deep` | `POST /api/flow/validate` | read | Deep-validate a stored graph (by id) or an inline draft: requestId existence, `{{ }}` template syntax/references, assertion shape, unknown config keys. Diagnostics only — never gates saves or runs. |
| `script_dry_run` | `POST /api/flow/script/dry-run` | execute | Dry-run one pre/post script in a throwaway VM (no persistence, outbound replay blocked). |
| `workflow_render_preview` | `POST /api/flow/render-preview` | execute | Preview the rendered request of one httpReplay node (baseline + override + templates + header-fidelity/cookie) in a throwaway VM — zero outbound traffic, nothing persisted, secrets masked; `variableOverrides` supplies sample values for setVariable-declared vars. |
| `workflow_storage_list` | `GET /api/workflows/{id}/storage` | read | Read a workflow's persistent key/value storage (the same store runs access live via `host.storage`). |
| `workflow_storage_put` | `PUT /api/workflows/{id}/storage/{key}` | write | Upsert one key with an arbitrary JSON value (persists immediately, visible to running/later runs). |
| `workflow_storage_delete` | `DELETE /api/workflows/{id}/storage/{key}` | write | Delete one key; omit `key` to clear the whole workflow storage. |
| `workflow_save` | `PUT /api/workflows/{id}` | write | Replace a workflow graph (PUT update semantics; `nodes` + `edges` form one unit). |
| `workflow_patch` | `PATCH /api/workflows/{id}` | write | Incremental graph surgery by id (`addNodes`/`updateNodes`/`removeNodes`/`addEdges`/`updateEdges`/`removeEdges`; cascade-aware, whole-patch atomic) — preferred over whole-graph `workflow_save` on large graphs. |
| `workflow_runs_list` | `GET /api/flow/runs` | read | One page of workflow runs, newest first. |
| `workflow_run_detail` | `GET /api/flow/runs/{id}` | read | Run record plus per-node checkpoints. |
| `workflow_run_wait` | `GET /api/flow/runs/{id}` (polls it server-side) | read | Wait for one run to reach a terminal state (`timeoutMs` ≤ 55000 — this tool alone gets a 60s call budget, `intervalMs` ≥ 50) and return a compact digest — run record fields plus per-node `{nodeId,status,durationMs,error}`; no graphSnapshot or node input/output. `settled:false` means the deadline elapsed first; use `workflow_run_detail` for the full checkpoints. |
| `workflow_run_trigger` | `POST /api/flow/runs` | execute | Start one workflow run (`startNodeId` selects the entry start node; required when the workflow has multiple start nodes). |
| `workflow_run_cancel` | `POST /api/flow/runs/{id}/cancel` | execute | Request cancellation of a running workflow. |

Session scoping: every tool that takes `session_id` (logs, replay, captures) defaults to the
workspace's active session and the responses echo the resolved session where applicable
(`log_ids`/`log_search` payloads carry `session_id`), so callers never have to guess which
session they read from.

## Exposure tiers

Every tool declares one of three tiers, gated by workspace-level switches:

| Tier | Default | Tools |
| --- | --- | --- |
| `read` | on | the seventeen read tools |
| `write` | off | `request_library_from_capture` / `request_library_create` / `request_library_update` / `request_library_delete`, `env_sets_create` / `env_sets_save` / `env_sets_activate` / `env_sets_delete`, `workflow_create`, `workflow_save` |
| `execute` | off | `replay_once`, `script_dry_run`, `workflow_render_preview`, `workflow_run_trigger`, `workflow_run_cancel` |

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
- Error text is centrally mapped and never contains file paths or credentials. Curated business
  categories (`bad_request`, `not_found`, `conflict`, `workflow_graph_invalid`) pass the manager's
  message through verbatim so callers can self-correct (for example the multi-start-node
  “需指定入口 startNodeId：…” text); internal/storage categories expose only the stable error code.

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
- Deep validation is editor diagnostics: env/var key and node-reference warnings resolve against
  the current activation state and can change as sets switch; only the structural checks gate runs.
- There is no single-node full trial (`workflow_render_preview` renders one httpReplay node's
  request without sending it, and `script_dry_run` covers one pre/post script, but neither
  executes a node end to end — no response handling, no variable write-through); the MCP surface
  intentionally exposes no script library, permission management,
  sharing, CA, system-log, bypass, redaction-library, flow-project, HAR import, breakpoints, or
  workflow import/export operations.

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
- **M19-T2 (read tools)** — covered: capture reads (`sessions_list`, `log_ids`, `log_search`,
  `log_detail`, `log_body`), request library (list/detail/body), env-set reads (masked), workflow
  and run queries mirror the upstream intent of a curated query surface. Three-layer variable
  writes and bridge status are deliberately not exposed (curated-surface decision, see Known
  limitations). Upstream's secret non-disclosure maps to the redaction binding plus the env-set
  masking convention (`******` reads; restore-on-write over HTTP, secret-table read-only over
  MCP); upstream's header redaction at MCP ingest
  maps to executing bound callers through the same redaction path as `/api/*` reads.
- **M19-T3 (execute tools)** — partially covered: `workflow_run_trigger` and
  `workflow_run_cancel` mirror `run_workflow`/`cancel_run`, and `replay_once` plus
  `script_dry_run` cover single-request and single-script trials. The upstream `wait_run` maps to
  `workflow_run_wait` (server-side polling to a terminal state with a compact digest, bounded by
  the 30s tool-call cap); there is still no `debug_node`,
  `rerun_from_node`, or `rerun_loop_iteration`.
- **M19-T4 (write tools)** — covered beyond upstream: `workflow_save` persists a whole graph with
  structural validation (upstream's validate-before-write), `workflow_create` + deep validation
  (`workflow_validate_deep`) cover draft diagnostics, request-library CRUD and
  `request_library_from_capture` cover entry management, and the four `env_sets_*` tools cover
  env-set CRUD (create may carry `secretValues`; save preserves the secret table — the per-key
  masked marking is read-only over MCP and edited in the desktop UI). Project CRUD, workflow
  import/export (and therefore the `confirmScripts` gate), and three-layer variable writes are
  not exposed.
- **M19-T5 (primitive request tools)** — covered by `replay_once`: one replay per call against a
  raw request or a request-library entry, with optional overrides.
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
