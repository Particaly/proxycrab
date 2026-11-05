# ProxyCrab debugging best practices

For authentication, mutation boundaries, and sensitive-data handling, follow [SKILL.md](../SKILL.md).

## Scope first

Use a dedicated active Session when possible. Record the Session ID in notes and commands so later
active-Session changes cannot silently redirect reads. Remember that direct HTTP routing runs per
request, while a CONNECT result pins one Session for the whole tunnel.

When capture traffic must keep using an existing Clash (proxy chains, airport rules), suggest the
user set the workspace upstream proxy to the local Clash mixed port (for example
`127.0.0.1:7890`) in the desktop 连接 → 3.上游代理 tab, or restart the CLI with
`--upstream-proxy 127.0.0.1:7890`. All outbound traffic (captured, bypassed, and replays) then
exits through Clash with no Clash-side rules, while captures stay unchanged. If outbound requests
start failing, check that the upstream proxy service is actually listening before touching other
configuration.

Start with the narrowest stable discriminator available:

1. an exact or distinctive URI substring;
2. request method;
3. response status;
4. a correlation header exposed by a custom column;
5. a Lua filter for compound conditions.

Prefer bounded query batches over unbounded parallel fan-out.

## Separate observation from mutation

Inspect at least one unmodified capture before adding an interceptor. When testing an interceptor:

1. read and save the current Session chains;
2. create or update one small interceptor;
3. attach it at a deliberate position;
4. generate new traffic;
5. inspect the new capture's historical execution;
6. compare the request or response with the baseline.

A successful save only proves syntax validation passed. The capture history is the evidence that the
script executed and shows exactly which modifications were recorded.

## Agent-driven request workflows

Request workflows ([definitions](http-api.md#workflow-projects-and-definitions),
[runs](http-api.md#workflow-runs)) replay request-library entries through a target Session's
pipeline. Keep the loop explicit and observable:

1. build the request library first: ingest a completed capture with `request-library-ingest.mjs`
   and confirm the stored entry with `request-library-query.mjs`;
2. save the graph with `workflow-save.mjs`, then call `workflow-validate.mjs` and resolve every
   reported issue before triggering — the validator does not gate saves, and an unvalidated graph
   only fails later at trigger time (`422 workflow_graph_invalid`);
3. start the run with `run-trigger.mjs`, watch it to a terminal state with `run-wait.mjs`
   (`success`/`failed`/`cancelled`/`interrupted`), and summarize per-node outcomes from the
   terminal node digest or `run-query.mjs`; report the digest as observed instead of inventing
   node input/output.

A run requires the proxy to be running and an existing target Session (explicit `--session-id` or
the active Session); a stopped proxy fails with `409 proxy_not_running` before any run row is
written.

Know the risks before triggering:

- saves and run trigger/cancel are write/execution calls that default to `approval` and need
  desktop approval. A denial or approval timeout surfaces as `403 permission_denied` /
  `403 approval_timeout` (CLI targets treat a persisted approval as deny); report it as an approval
  problem, never as node output or a workflow defect.
- every run replays real requests and creates new captures (source `ProxyCrabRequest`) in the
  target Session; loops and high concurrency can generate large amounts of capture records, so
  scope loops deliberately and confirm volume with the user before high-volume runs.
- run input/output snapshots and error text are secret-masked server-side; do not expect raw secret
  values in run records, and read env effects through the
  [env-set endpoints](http-api.md#environment-variable-sets-and-global-variables).

## Diagnose by lifecycle

- `in_progress`: persisted unfinished state; confirm current activity through
  `ProxyStatus.running.active_netlog` before expecting further updates.
- `success`: transport completed, but application-level status can still be an error.
- `failed`: use `error.stage`, `error.kind`, and `error.message`.
- `tunneled`: traffic was passed through without decrypted HTTP details.

Common stages:

- `connect`: upstream connection failure or invalid target.
- `tls_handshake`: certificate, protocol, or trust failure.
- `request_body`: request body timeout or size failure.
- `interceptor`: Lua or body replacement failure.
- `upstream`: upstream request/response failure.
- `response_body`: response body timeout or size failure.

For CONNECT traffic, a successful TLS MITM handshake retains a CONNECT capture and records decrypted
requests as additional captures. Do not mistake the CONNECT row for the application request.
Bypassed CONNECT traffic has no decrypted request detail; inspect the bypass table for source,
authority, reason, outcome, byte counts, and errors.

For TLS or upstream protocol issues, consult the [request-interceptor controls](lua-api.md#request-interceptors).
For complete or snapshot bodies, use the [Body endpoint contract](http-api.md#get-apilogsidbodysession_id3siderequestmax_size16777216).
Asset replacements are identified by their Asset ID in historical modifications.

## Report with traceable evidence

A useful diagnostic report contains:

- Session ID and capture log IDs;
- capture time, method, URI, outcome, and response status;
- proxy error stage/kind/message when present;
- relevant request and response facts;
- interceptor execution order, modifications, and errors;
- the most likely cause and credible alternatives;
- the next discriminating test.

Distinguish direct observations from inference. Avoid dumping the entire capture when a few fields
support the conclusion.

## Preserve evidence

Keep API-returned output intact; it may already be redacted by the effective read policy. Before
sharing findings, check for credentials, personal data, and internal details unsuitable for the
recipient. Redaction does not cover every field; see the [policy scope](http-api.md#redaction-library-and-bindings).

Do not modify the local source evidence merely to create a redacted summary.
