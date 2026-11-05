# Runtime and development notes

ProxyCrab is a macOS-first HTTP/HTTPS MITM capture application. The same Vue management UI runs in the Tauri desktop application and from the headless CLI's HTTP server through target-specific backends.

## Rust workspace

- `crates/proxy-crab-mitm`: proxy lifecycle, CA/TLS, sessions, SQLite captures, request/response bodies, Lua scripts, diagnostic failures, and the in-memory system-log ring.
- `crates/proxy-crab-mgr`: the object-safe `ProxyCrabManager` trait, its MITM adapter, typed DTOs, stable errors, the local management HTTP server, and a route-level permission contract.
- `src-tauri`: Tauri initialization, application lifecycle, trusted host commands, and workspace-pointer ownership; ordinary proxy commands call the same management trait as HTTP handlers.
- `cli-app`: headless proxy runner, embedded browser UI, per-run UI authentication, and CLI-specific allow/deny permission management.

Neither reusable crate depends on Tauri.

## Linux development against the packaged WebKit

Linux releases ship only as AppImage, which embeds its own WebKitGTK runtime. To develop against
exactly that runtime instead of the system WebKit:

```bash
scripts/dev-appimage-webkit.sh import path/to/proxy-crab-t_amd64.AppImage   # one-time import
scripts/dev-appimage-webkit.sh                                             # build + run
```

The script unpacks the AppImage into `.webkit-runtime/`, replaces its payload with the local debug
build, and launches it through the original `AppRun`. The window still loads the vite dev server
with hot reload, while GTK/WebKit and the helper processes are the exact binaries that ship.

## Runtime defaults

- MITM proxy: `0.0.0.0:8089`, stopped when the app launches.
- Management API: `0.0.0.0:18089`, started with the app. Remote management calls still require Bearer authentication.
- Certificate management opens on “1.证书配置”; “2. 代理连接” provides a temporary Clash subscription in both desktop and CLI management UIs. Select a non-loopback local IPv4 and enable the subscription; the fixed link is `http://<selected IPv4>:<api-port>/clash.yaml` and has no download token. Copy/scan it or import it into Clash. The complete YAML lives at `<workspace>/clash/config.yaml`, must contain `{{server}}` and `{{port}}`, and can be edited in the lower half of the tab; saves are validated, downloads substitute the selected IP and current proxy port. The default config forwards all matched traffic to ProxyCrab. This does not start the proxy or enable the OS system proxy. Disabling stops serving the subscription only; restarting resets the switch and IP selection but keeps the config file and the same URL for the same IP.
- CA download: `http://<selected local IPv4>:18089/ca.crt`, available without configuring or starting the proxy. The certificate and Clash tabs share the same IP selector.
- Windows desktop only: starting the proxy takes over the WinINET system proxy (`127.0.0.1:{proxy_port}`) and clears the live `ProxyOverride` bypass list (loopback addresses never use a proxy by default), so intranet addresses such as `192.168.*` reach the proxy instead of being silently bypassed by the browser; the previous `ProxyEnable`/`ProxyServer`/`ProxyOverride` values are backed up to `<app-data>/system_proxy_backup.json` and restored when the proxy stops, on app exit, or — after a crash — silently on the next launch. Stopping the proxy restores whatever was backed up, deleting registry values that did not exist before. The certificate tab also offers one-click CA installation via `certutil -user -addstore Root` (current-user trusted-root store, one system confirmation dialog, no administrator rights); installation status is detected by checking the SHA-1 thumbprint key under the `SystemCertificates\Root\Certificates` registry paths (current user, local machine, enterprise). Both features report `supported: false` on other platforms and are hidden in the CLI browser UI.
- Upstream proxy: `app_config.json` gains an optional `upstream_proxy` (`host:port`, IPv6 with brackets). When set, every outbound dial goes through that HTTP proxy via CONNECT: MITM request sends, un-captured bypass tunnels, request replays, WebSocket upgrades and the HTTP/1 + HTTP/2 pools all route through it (pooled clients fall back to the dedicated path, so pooling is disabled while an upstream proxy is active). Changing it while the proxy is running rebuilds the upstream client and rotates in-flight connections. It is host-level configuration, like the proxy port: desktop edits it through the trusted `replace_config` command (连接 → 3.上游代理) and the CLI through `--upstream-proxy HOST:PORT` / `PROXYCRAB_UPSTREAM_PROXY` (in-memory override, empty value forces direct). There is no management HTTP route.
- System log buffer: the newest 10,000 entries in memory.
- Captured request/response bodies stream directly to disk without an application-level size limit; at most 256 client connections are accepted.
- Body toolbars offer complete decoded downloads in desktop, CLI browser, and Session share views, including interceptor snapshots and supported breakpoint views. Downloads preserve original bytes and ignore preview formatting and the 16 MiB/1 GiB preview limits. Desktop saves stream to disk; browser saves use browser-managed Blobs.
- Blocking capture/bypass queries and management Lua evaluations: at most eight concurrently; excess work waits without occupying Tokio worker threads.

The Tauri application data directory contains `config.json`, which points at the workspace. When the pointer is absent or invalid, `app_data_dir/workspace` is used and persisted. Settings > 通用 displays the current path and, on desktop, a 切换工作区 button. It opens a native directory picker, validates the selection, and immediately restarts the application with the new workspace's configuration. Unsaved UI edits are discarded; the proxy starts stopped, as on a cold launch. Canceling or selecting the current directory does nothing.

A new workspace directory must be empty, ignoring dot-prefixed entries. A nonempty directory must contain valid `workspace_schema.json` and `app_config.json` files with a supported schema version. Invalid, unwritable, or occupied workspaces are rejected with a toast before the saved pointer changes. Existing workspace data stays in place; switching never copies data from the previous workspace.

Desktop ProxyCrab Skill parent paths are stored separately in application data as
`skill-paths.json` and do not follow workspace switches. On first use only, an existing
`~/.agents/skills/proxycrab` directory causes `~/.agents/skills` to be adopted automatically;
otherwise the UI warns that no Skill path is configured. Every application launch, path save, and
manual sync completely replaces the `proxycrab` child under each configured parent with the bundled
copy. Removing a path can either leave that child in place or delete it. Corrupt path configuration
is preserved and reported until the user explicitly saves a replacement.

The management API listens on every IPv4 interface and explicitly authenticates each `/api/*`
request as either `LocalLoopback` or `Bearer`. `LocalLoopback` requires a loopback TCP peer, a local
Host, and no Origin or a local Origin. Exactly one `Authorization: Bearer <key>` header always selects
the Bearer identity, including on loopback. Every API key and the local no-key identity have independent
per-route permissions. The desktop target supports `allow`, `approval`, and `deny`; approval waits
for a desktop decision for up to 30 seconds. The CLI target exposes only `allow` and `deny`, and
evaluates any persisted `approval` value as `deny`. API keys and permissions are managed under
Settings > 管理接口 through target-private operations, not the public agent API. Direct Tauri
commands remain trusted and bypass HTTP authentication.

Host mutations such as switching the workspace, replacing global configuration
(including the proxy port), regenerating the CA, and managing bundled Skill paths are not management
HTTP resources. They are available only through trusted Tauri commands or explicit local CLI options
and subcommands. Workspace selection is not exposed through HTTP; the API retains read-only config
and CA resources.

Permission state is stored in the active workspace's `http_api_permissions.json`; a corrupt file
stops only the management HTTP service rather than widening access. Full API keys are displayed once
at creation and are never persisted. Bundled ProxyCrab Skill scripts accept a key only through the
`PROXYCRAB_API_KEY` environment variable.

Each workspace root has a `workspace_schema.json` version label. All persisted-data upgrades are
registered in the centralized migration module and run before workspace stores are opened.
Workspace schema v2 enables SQLite WAL for Session capture databases so management readers can
recover and interoperate with the established workspace format. Each opened capture or bypass
store reuses one configured SQLite connection across its clones and serializes access to it.
Active Sessions live under `sessions/`; archived Sessions move intact to `sessions_archived/` and
can only be permanently deleted from there. Effective active-Session or selected-routing changes
rotate all downstream connections, tunnels/upgrades, and upstream pools while keeping the proxy
listener running; identical updates do not rotate connections.

Workspace-scoped Agent behavior presets are owned by the management layer and stored under
`agents/`. The desktop AI menu edits and activates them, while `GET /api/agents.md` returns the
active Markdown as raw `text/plain`. The bundled ProxyCrab Skill reads this endpoint before making
other management calls. A supplied log filter can be kept stateless with
`persist_filter: false`.

The Tauri command surface also reports the management HTTP service's `running`, `host`, `port`, and startup error state through `get_http_service_status`.

## Flow JS runtime

ReqFlow workflow execution embeds QuickJS through `rquickjs` in `crates/proxy-crab-mitm/src/flow/`:
`flow/host.rs` defines the host bridge contract and `flow/runtime.rs` the VM;
`tests/flow_runtime.rs` covers the failure faces.

- Threading model: one VM context per run — a dedicated `AsyncRuntime` + `AsyncContext`
  created for a single run and dropped afterwards; runs never share a VM. The runtime is
  tokio-native (rquickjs `futures` + `parallel` features); host calls are awaited as
  promises and never block Tokio worker threads.
- Sandbox surface: only QuickJS standard builtins (Math/JSON/Date/RegExp/…). No rquickjs
  loader/std modules are enabled, so io/os-like host objects cannot enter the sandbox; the
  only injected global is `host`.
- Host bridge: `host.replay(payload)` (async replay envelope), `host.now()` (epoch millis),
  `host.log(payload)`, `host.sleep(ms)` (interruptible), `host.emit(payload)` (run events),
  and `host.cancelled()` (poll). Every call exchanges explicit JSON payloads; host errors
  are normalized to `{kind, message}` and thrown into JS as Error objects carrying `kind`,
  so classification survives script handling and returns to Rust unchanged.
- Limits (`FlowLimits`, all configurable): 64 MiB QuickJS heap, an instruction quota of
  100,000 interrupt-handler ticks (QuickJS polls the handler roughly every few thousand
  bytecode instructions), and a 30-second wall-clock budget measured as accumulated active
  JS execution time — time spent awaiting host calls does not count. Exceeding any limit
  classifies as `timeout`; the failure message names which limit fired.
- Cancellation: `FlowRuntime::cancel` (shared `FlowCancel` token) outranks every limit.
  The interrupt handler aborts pure-JS execution, and each in-flight host call is raced
  against the token and dropped, returning `cancelled` without waiting for the host
  operation to finish.
- Error classes: `script | timeout | blocked | network | http | cancelled | unknown`,
  aligned with ReqFlow's `error-class.ts`. Script exceptions and syntax errors classify as
  `script`; instruction/wall-clock/memory overruns classify as `timeout`; host-bridge
  errors keep the kind supplied by the host implementation; unexpected VM failures
  classify as `unknown`. The engine interrupt surfaces as a JS "interrupted" error which
  the runtime maps back through the handler's recorded reason (cancelled outranks
  over-limit), and QuickJS allocation failures ("out of memory") classify as `timeout`.
- Host-function registration constraint: host functions must be generic fn items whose
  state is stored in runtime user data (`Ctx::store_userdata`) and whose `Ctx` arrives as
  a parameter. Registering a closure that captures a `Ctx` clone pins the function object
  on QuickJS's GC list and aborts the process at VM teardown
  (`list_empty(&rt->gc_obj_list)` assertion); closures are also unusable because their
  late-bound parameter lifetimes cannot satisfy the `'js` future bound.
- Failure-face tests: `cargo test -p proxy-crab-mitm --test flow_runtime` exercises
  instruction-quota and wall-clock dead loops, memory exhaustion, script throws, host
  errors, cancellation during sleep and during pure compute, and a JSON round-trip smoke
  run, each with a 10-second settle bound.

## Workflow run orchestration

Workflow runs compose the flow engine payload, the QuickJS host runtime, replay,
and SQLite persistence in `crates/proxy-crab-mitm/src/flow/run.rs`. The management
layer (`crates/proxy-crab-mgr`) exposes `GET /api/flow/runs` (list), `POST
/api/flow/runs` (trigger), `GET /api/flow/runs/{id}` (detail), and `POST
/api/flow/runs/{id}/cancel` (cancel). Records live in `<workspace>/flow/runs.db`:
one `flow_runs` row per run (including the graph snapshot captured at creation, so
a run renders even after the workflow definition changes) and one `flow_node_runs`
row per node checkpoint with last-write-wins upserts per `(run_id, node_id)`.
The list is newest-first, filters by workflow/status before pagination (default
page size 200, hard cap 1000); the detail payload flattens the run record and
appends its node checkpoints (`nodeRuns`).

- Lifecycle: triggering prechecks an existing target Session (defaulting to the
  active one) and a valid graph; replays run on a flow-dedicated connection
  generation, so the proxy does not need to be running. A failed precondition
  creates no run row and maps to stable errors (missing workflow/Session 404,
  invalid graph 422 `workflow_graph_invalid`, no active Session 409). The run
  row is inserted as `running` with its graph snapshot
  (`pinnedOutput` always stripped; over 256 KiB it degrades to a self-describing
  skeleton with `truncated`), then the orchestration task (VM + write consumer)
  spawns and the record returns immediately. Node events flow through
  `host.emit` into one FIFO write queue per run; the single consumer serializes
  checkpoint persistence and progress broadcasts, and `run-finish` is queued
  behind every pending node write, so the terminal write naturally lands last.
  Finalization overwrites node checkpoints from the engine summary (including
  skipped nodes) and then writes the run terminal status.
- Cancellation outranks failure: wherever the engine summary reports `failed`
  while the cancel token has fired — and on both abort paths (VM infrastructure
  failure, channel close without a terminal event) — the run is stored as
  `cancelled`. The graceful cancel path relies on the `host.sleep` abandon
  semantics: the run driver polls every 150 ms through `host.sleep(150)`, an
  abandoned sleep rejects as `cancelled` and flips the engine abort signal, and
  the engine stops scheduling at the next batch boundary (the current node
  completes naturally). Pure-JS execution segments are covered by the VM
  interrupt handler; both routes converge to the same `cancelled` terminal state.
- Write queue and degradation: each active run owns exactly one writer, so
  concurrent runs contend only at the SQLite connection. Failing to open
  `runs.db` only degrades: the manager logs, keeps serving, and every run
  operation reports 工作流运行记录库不可用 instead of blocking anything. When
  the manager opens, a restart scan converges orphan `running` rows to
  `interrupted` (error 进程重启：运行中断，finish timestamp set; node
  checkpoints are left untouched).
- Event bridge: `FlowRunEvent`s (`started` / `node` / `finished`) are folded by
  the management layer into a single `FlowRuns` resource `HttpApiChange` —
  run-level and node-level events share one resource domain, so the frontend
  re-pulls the run list/detail instead of modeling per-event payloads. A lagged
  broadcast subscriber still emits the change; lag never breaks the bridge.
  Desktop degradation (agreed decision): the Tauri bridge subscribes to this
  stream through the management HTTP service (`http.subscribe_changes()` →
  `proxycrab://http-api-change`). When that service cannot start, desktop run
  progress is not live — triggering, cancelling, listing, and reading runs keep
  working through trusted Tauri commands that call the manager directly, and
  the run-history section's manual refresh is the fallback.
- VM limits and inputs: workflow execution reuses `FlowLimits::default()` —
  64 MiB QuickJS heap, 100,000 interrupt-handler ticks, and a 30-second
  accumulated active wall clock (time spent awaiting host calls does not
  count). Loading the engine payload has an independent 30-second budget, and
  workflow execution itself has no overall hard timeout — long runs are legal
  and cancellation stays available. Engine arguments are injected once as a
  JSON literal into `globalThis.__runArgs` (data never enters template source;
  the driver script is a static constant). Run inputs snapshot the merged
  three-layer variables, the active environment set frozen at dispatch (later
  switches do not affect a live run; script env write-backs persist to that
  frozen set), and the request-library HAR baseline (stored body blobs are
  backfilled as base64 `postData`). Secrets from all three layers, the active
  environment set, and script write-backs join the masking list; node snapshots
  and error text are masked before persistence and broadcast.
- Template rendering: node config strings (`{{ … }}`) are rendered by the
  embedded engine per node execution over the namespaces `node.<refId>.<path>` /
  `input.<path>` (bare path shorthand, `$json` alias) / `var.<name>.<path>` /
  `env.<key>` / `fake.<name>(<args>)`. Missing data renders as empty text plus a
  warning on the node checkpoint (rendering never fails a run); the `fake`
  namespace generates built-in fake data (phone / name / address / email /
  idcard / plate / avatar URL / ip / number(min,max) / hex(len) / uuid /
  timestamp — see `flow-engine/src/fake.ts`). Fake values are cached per
  `RenderContext` instance, so one node execution (URL, headers, body, fidelity
  and cookie overrides) sees one value per expression while every new execution
  or loop iteration re-randomizes. Condition-node expressions only compile
  `input` / `var` roots; `node` / `env` / `fake` are rejected at save validation.
- Known limitations: engine `bodyBase64` byte bodies replay lossily as UTF-8
  text (`ReplayBody` has no byte variant today; a byte channel would be its own
  task). Cancel idempotency is not promised — cancelling an already-finished or
  unknown run returns 404. The run list `status` filter has no enum validation;
  an unknown value simply yields an empty page.

## Session sharing links

The desktop and CLI management UIs open a managed application window from “链接分享” in a
Session's context menu. Sharing creates one 256-bit `pcrab_share_…` token scoped to that Session.
It is temporary by default. Select “重启后保留” to save its token and redaction binding in
`<workspace>/session-shares.json`; desktop and CLI restore it enabled with the same token on restart.
Switching this option preserves the current token. Temporary shares stay in memory and expire on
exit. Disabling either kind immediately revokes the link and removes any durable entry; enabling it
again generates a new token. Archived Sessions are unavailable until restored, and permanent
Session deletion removes their share records. Persistent files contain plaintext credentials (mode
0600 on Unix). Invalid files report startup errors rather than being silently replaced. The service
must be running to use a link; an IP or port change still requires updating its address.

Shared Session names carry a small link icon, with a tooltip indicating temporary or persistent
sharing. The desktop and CLI read enabled, non-archived summaries through one batch call
(`GET /api/session-shares`, desktop `list_session_shares`), without fetching share tokens. Icons
refresh after share changes and Session archive/restore operations.

Share redaction is resolved by the backend, not copied by the frontend. For a new owner-created
share, omitting `session_share_config.redaction_script` inherits the current local no-API-key binding.
Explicit `null` selects that same inheritance; `""` explicitly disables share-level redaction; a
nonempty name selects a library script. On updates, an omitted redaction field preserves the current
policy; use explicit null to switch back to local inheritance. A supplied config updates persistence
without rotating the token; an omitted config preserves an existing owner share.

API keys have stricter rules. A Key bound to a nonempty script must omit the share redaction field
and the share follows that Key's binding dynamically, including on updates. An unconfigured Key
(null/missing binding) also cannot supply the field; new shares inherit local. Only a Key whose own
binding is explicitly `""` may supply the field, including null, empty, or a script name. Violations
return HTTP 403 `share_redaction_forbidden` before modifying share state. Owner Tauri IPC, local
management requests and the trusted CLI UI may select policies normally. Ordinary route permission
checks still apply. Existing null Key bindings are not treated as explicit opt-out.

Inherited policies resolve their identity on each share request, so changing local or Key bindings
updates share reads without rotating links. A missing/deleted Key or failed identity lookup fails
closed (`redaction_failed`); it never falls back to original data. Status reports the configured
`redaction_script` and optional `redaction_identity` (a stable Key ID, never an API Key credential).
The frontend shows inheritance separately from explicit no redaction and never reads local defaults.
The startup `--redaction-script` policy still overrides all these settings.

Updates use `POST /api/session-shares` exclusively. The old
`PUT /api/session-shares/{id}/redaction` route and desktop `set_session_share_redaction` command
have been removed; persisted permissions drop that obsolete action.

Persistent share files use version 2 and retain policy references. Version 1 files remain readable:
old null share bindings migrate to explicit `""` to preserve their original unredacted behavior;
named script bindings and tokens are preserved. New inherited shares retain null policy references
across restart and resolve the current binding when read.

The `/session?token=…` page renders only the main traffic content. It follows new/finished captures
and owner column changes, starts with the Session's current filter, and keeps every viewer's later
filter stateless. An optional `id` query parameter focuses the matching record: the list scrolls to
that row and opens its inline detail panel. Sorting, copying, log details, complete bodies, historical interceptor results,
and script snapshots remain readable. The interceptor pipeline shows the shared Session's current
request/response chain, including labels, order, enabled and valid state, and follows owner changes.
It reuses the main UI component: missing Backend methods hide add/edit/remove/toggle/drag and
breakpoint operations; HAR export remains available through the existing read/save methods.
Toolbar/sidebar management, column editing, interceptor writes and other write surfaces are absent. Its token is accepted only by the
dedicated Session-scoped `/share-api/*` routes as exactly one `token` query parameter and is never an
Agent API key. These routes ignore `Authorization` and return `Cache-Control: no-store`; the share UI
uses a no-referrer policy. Agents can also read a supplied Session link directly through these
routes without a management API key; the [Skill sharing workflow](../skills/proxycrab/SKILL.md#read-a-session-sharing-link)
and [share API reference](../skills/proxycrab/references/http-api.md#session-share-read-api) describe
authentication, capture queries, bodies, WebSocket messages, and interceptor snapshots.

One frontend build produces `index.html` for the application and `session.html` for this HTTP page
from source files under `src/`. Tauri and CLI reuse the same `dist` output, and the application entry
selects its Landing from the runtime host. The desktop HTTP server reads the Session page through
Tauri's embedded asset resolver instead of embedding another copy of the frontend bundle.

The UI lists one complete URL for every non-loopback local IPv4 address; when none exists, it falls
back to `127.0.0.1`. Each row can be opened or copied directly. These links use plain HTTP by default,
so the token and captured data must be shared only on a trusted network or protected by a TLS
reverse proxy.

## HAR export

The export button beside the sweep action opens a floating window. Its Export HAR button freezes
all matching list IDs and their displayed order, then reads details and bodies through existing
Backend methods (`getLog`, `fetchBody`). No HAR export or sharing HTTP endpoint exists. The shared
Session page uses the existing scoped read APIs and exports their policy-filtered data.

Entries are generated one at a time. Failed and unfinished ordinary HTTP records are retained;
missing responses have status 0 and `_proxyCrab` carries outcome/error metadata. WebSocket connection
rows and synthetic TLS CONNECT records are skipped; HTTP upgrade handshakes remain. Body read
failures (including decode and size errors) become text explaining the failure and `bodyErrors`
metadata, with warnings in the export window. Unavailable details produce a failed placeholder
entry. Empty selections produce valid HAR. Body bytes are read separately rather than reusing JSON
previews, preserving formatting; binary content uses Base64 (`encoding` for responses, `_encoding`
for request postData). Detailed timings/header sizes are unknown (-1).

`saveFile({filename})` returns `FileWriter | null`; null means the desktop picker was cancelled.
The Writer offers async `append(bytes)`, `markAsFinish()`, and `markAsError()`. Desktop chunks use
binary IPC (at most 256 KiB each) and a same-directory temporary file; finish publishes the file,
error discards it. Failed writes cannot be committed. Browser writers buffer Blob parts and start
a download only on finish; this acknowledges download initiation, not completion on disk. Abort
never starts a download. No new management or share HTTP route is needed for writing.

Progress includes processed/exported/skipped records and warning counts. The window retains the
latest 1000 log lines; cancel/close abandons an unfinished export. Each Body still uses the existing
read interface (explicit 1 GiB stored-size ceiling); a single entry is buffered, and the browser
fallback buffers the final file. Export does not provide an atomic snapshot of changing captures
or pin one redaction revision across separate reads. Original content is never used as a fallback
for policy-denied reads. Exported files may contain sensitive data from the authorized read view.

Sweep now asks for confirmation before creating a new active Session, archiving the current one,
and disconnecting active traffic.

## CLI browser UI

Browser secure-context compatibility: request windows use page-local incremental IDs and work on
remote HTTP origins. JWT decoding is local and works on HTTP, but signature verification requires
`crypto.subtle` (HTTPS or a trusted localhost context). Copy buttons fall back to `execCommand`
when the asynchronous Clipboard API is unavailable; editor context-menu paste may still depend on
browser support, while keyboard paste uses the normal browser editing path. Downloads use
Blob/object URLs and ordinary workers power Monaco; neither requires HTTPS by itself. Monaco
also falls back from `randomUUID` to `getRandomValues`; its WebGPU renderer is disabled by default.

The web backend uses the current page hostname (without its port) as its address, rather than
requesting container interface addresses. There is no `/ui-api/local-ips` endpoint. Desktop Tauri
continues to enumerate local IPv4 interfaces.

Build the CLI frontend before compiling the binary so Cargo can embed the generated assets:

```bash
pnpm build
cargo build -p proxycrab-cli
```

Run the CLI with a workspace:

```bash
target/debug/proxycrab-cli run --workspace /path/to/workspace
```

To enforce read-time redaction for every supported identity, including UIKey and Session
shares, supply a Lua file:

```bash
target/debug/proxycrab-cli run --workspace /path/to/workspace --redaction-script /path/to/mask.lua
```

The file is read and compiled once before services start; read/compile errors abort startup.
Changes require a restart. This in-memory policy overrides existing bindings and disables the five
redaction-library management endpoints with HTTP 403 `redaction_management_disabled`
(`脱敏接口管理功能已禁用`). The frontend remains unchanged and shows the API error.
Only the existing redaction-supported data is transformed; capture and forwarding are unchanged.
See [the redaction API contract](backend-api.md#redaction-library-and-bindings) for scope.

By default, startup generates a 256-bit, per-run `pcrab_ui_…` Access Token. To choose the UIKey,
pass `--ui-key 'your-custom-key'`, with or without `run`:

```bash
proxycrab-cli run --workspace /path/to/workspace --ui-key 'your-custom-key'
```

The key must be nonempty visible ASCII with no whitespace or control characters; no prefix is
required. There is no environment-variable or persisted-config option. Startup prints the browser
URL and actual `Access token`, whether supplied or generated. Enter it on the landing page.
Custom UIKeys remain subject to `--redaction-script` when supplied. The cleartext token is not persisted; the process
keeps only its SHA-256 digest. It authorizes the browser UI's internal `/ui-api/*` operations and
trusted calls to the shared `/api/*` management resources for that process lifetime.

For access from another machine, the safer setup is an SSH local port forward or authenticated TLS.
The browser can then open `http://127.0.0.1:18089` on the client. Direct access uses one of the
server's reachable IP addresses. Remote `/api/*` requests require the Bearer token, and
the token travels in cleartext over plain HTTP, so direct exposure should be limited to a trusted
network or placed behind authenticated TLS.

The CLI browser backend deliberately has no ProxyCrab Skill path-management capability or HTTP route.
This remains true even if the CLI frontend bundle is hosted outside the local binary. Users who
want to install the bundled Skill must explicitly run the local
`proxycrab-cli install-skill` command; a browser page cannot trigger it.

## Development

`pnpm build` creates one two-entry frontend bundle in `dist`. Both Tauri and CLI consume this same
directory. It contains distinct application and Session-share HTML files backed by shared chunks;
the application entry loads the Tauri or CLI Landing according to its runtime host.

Rust dependencies share `sha2 0.10.9` with Tauri's code generator and use AWS-LC for both
Rustls and rcgen. Keep `hyper-util` features limited to the client/runtime components used by
the proxy, and use ZIP's `deflate-flate2-zlib-rs` feature to avoid compiling the unused
system-proxy and Zopfli implementations.

```bash
cargo check --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm build
```

See [backend API](backend-api.md) and [Lua API](lua-api.md).

### Script library paths

All script managers share a compact file tree with collapsible directories. Create a script
with a relative name such as `business/errors`; ProxyCrab creates the parent directories and
saves `business/errors.lua` inside that library's directory. Existing root-level scripts remain
compatible. Bindings retain the full relative name. Empty folders, renaming and drag-and-drop
moves are outside this UI's scope. See the [script path API contract](../skills/proxycrab/references/http-api.md#script-relative-paths).

Script libraries and the replay workspace-asset picker share `src/components/FileTree.vue`.
Callers provide relative-path entries (`path`, optional `label`/`title`, and business `data`),
a controlled selection, and optional suffix/action slots. The component derives directories,
sorts directories first, handles folding, and reveals selected paths; it does not call APIs or
change business state before the caller accepts selection. Script path validation remains separate.

### Workspace resource manager and file creation

Open **工作区资源** from the script menu when the current backend provides `listAssets`.
The manager shows the shared file tree and selected-resource metadata. Upload actions appear only
when `uploadAsset` is available; both HTTP and Tauri backends implement it. Tauri sends raw binary
IPC directly to the existing asset store, without requiring the management HTTP service.

Each directory has a `+` action; a dashed `+` row creates at the root. Script managers now use
their top input for name/path filtering. Script creation uses the selected directory and the
library's default template. Resource creation opens the shared single-file picker, then an editable
name form before upload. Invalid names are reported without automatic renaming, and existing
resources are never overwritten. The replay asset picker supports the same upload flow and selects
the uploaded resource. Empty directory management, moving and renaming remain unsupported.
