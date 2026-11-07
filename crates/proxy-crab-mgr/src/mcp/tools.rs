//! MCP 策展工具注册表与调用机制（plan Task 24 Step 3/4）。
//!
//! 每个策展工具声明其等价的管理 API 路由；`tools/call` 逐次鉴权：MCP
//! 端点本身的档位已由 `authorize_request` 中间件按 "POST /mcp" 检查过，
//! 这里再按「映射路由的 action」对同一调用者做一次 `check_permission`，
//! 两次检查任一拒绝即拒绝，即更严者生效。审批档复用既有桌面审批窗
//! 链路：`check_permission` 在审批档等待既有审批队列（含超时），拒绝/
//! 超时以 `PermissionDenied` 返回并映射为 MCP `isError` 结果，不静默
//! 降级、不挂死。策展工具清单的扩充由 Task 25 负责，本模块交付机制与
//! 首个端到端验证载体。
//!
//! 边界（Step 4）：在途调用并发上限（超限快速失败不排队）、单次执行
//! 超时（超时即丢弃执行 future，底层工作随之取消）、断连取消（工具
//! 执行内联 await 于 HTTP 处理器，客户端断开时 axum/hyper 丢弃处理器
//! future 即取消底层工作）、错误文案统一映射（不含文件路径与凭据）。
//!
//! 脱敏绑定与审计（plan Task 25 Step 4）：`tools/call` 执行前经
//! `PermissionManager::redaction_script` 按调用者身份解析脱敏脚本绑定
//! （与 HTTP API 的 `authorize_request` 对 `/api/*` 同源解析）。有绑定
//! 时执行段改用 `manager.reader(Some(&script), "mcp")`，工具结果与
//! `/api/*` 读路径同走脱敏（脚本内可用 `context.api == "mcp"` 区分入
//! 口）；解析失败按 `ManagerError` 拒绝（fail closed），无绑定用原
//! manager。每次调用（权限拒绝与执行完成）均落一条审计到工作区
//! `flow/mcp-audit.json`：只存截断后的入参摘要，不存结果体；追加失败
//! 仅告警，不阻断工具调用（审计是辅助观测数据，不是关键路径）。

use std::{
    sync::{Arc, LazyLock},
    time::Duration,
};

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use proxy_crab_mitm::{
    flow::mcp_audit::McpAuditEntry,
    flow::mcp_tiers::McpTiers,
    storage::{BodySide, read_body_payload},
};

use crate::{
    dto::{
        CreateEnvSetRequest, CreateRequestLibraryRequest, ErrorCode, FlowRenderPreviewRequest,
        FlowRunListQuery, FlowRunTriggerRequest, FlowScriptDryRunRequest, IngestCaptureRequest,
        LogIdsRequest, LogSearchRequest, ManagerError, ReplaceActiveEnvSetRequest,
        ReplayHttpRequest, RequestLibraryBodyQuery, RequestLibraryQuery, SaveEnvSetRequest,
        SessionQuery, UpdateRequestLibraryRequest, WorkflowCreateRequest,
        WorkflowDeepValidateRequest, WorkflowListQuery, WorkflowPatchRequest,
        WorkflowStoragePutRequest, WorkflowUpdateRequest, default_body_max_size,
    },
    manager::ProxyCrabManager,
    permission::{
        ManagementCredential, PermissionAction, PermissionDenied, PermissionDeniedStatus,
        PermissionManager, find_api_action,
    },
};

use super::protocol::{self, RpcRequest};

/// 单次工具调用（授权之后的执行段）超时上限；与既有审批窗 30s 同量级。
pub const TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// `workflow_run_wait` 的执行预算（工具级放宽）：该工具自身就是服务端轮询
/// 等待，须容纳 manager 侧 55s 的等待上限；60s 兼容常见 MCP 客户端的请求
/// 超时量级（服务端等待被客户端先断开也只是丢本次摘要，运行不受影响）。
pub const WAIT_TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// 同时在途的工具调用上限；超出直接拒绝（快速失败，不排队）。
pub const MAX_IN_FLIGHT_TOOL_CALLS: usize = 4;

/// 进程级在途工具调用闸：每次 `tools/call` 先取许可，断连/超时丢弃
/// future 时随 Drop 释放。
static TOOL_CALL_PERMITS: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)));

/// HTTP 端点使用的进程级在途许可闸。
pub fn tool_call_permits() -> Arc<Semaphore> {
    TOOL_CALL_PERMITS.clone()
}

/// 工具档位（plan Task 25 Step 2）：MCP 暴露三档开关按该分级门控。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ToolTier {
    /// 读类：只读查询（如列表/详情）。
    Read,
    /// 写类：修改工作区状态（如保存/删除）。
    Write,
    /// 执行类：触发运行/工作流等有副作用的操作。
    Execute,
}

/// 单个策展工具的静态描述：名称、说明、映射路由、档位分级与入参契约。
pub struct ToolDescriptor {
    pub name: &'static str,
    pub description: &'static str,
    /// 映射的管理路由 `(METHOD, PATH)`；鉴权档位由 permission 层对该
    /// 路由登记的 action 决定，未登记路由的工具不得上架。
    pub route: (&'static str, &'static str),
    /// 工具档位分级：read/write/execute，MCP 三档开关据此门控。
    pub tier: ToolTier,
    /// 入参契约：`(参数名, JSON Schema 类型, 说明)`，与映射路由的
    /// 查询/请求体字段保持一致。
    pub params: &'static [(&'static str, &'static str, &'static str)],
}

impl ToolTier {
    /// MCP 暴露档位是否放行该工具（plan Task 25 Step 2）。
    pub fn enabled(self, tiers: &McpTiers) -> bool {
        match self {
            ToolTier::Read => tiers.read,
            ToolTier::Write => tiers.write,
            ToolTier::Execute => tiers.execute,
        }
    }
}

/// 工具注册表：仅登记已实现且映射路由已有 action 档位的工具；策展子集
/// 按域分组（Task 25 Step 1）：抓包读取 / 请求库 / 工作流 / 运行。
const REGISTRY: &[ToolDescriptor] = &[
    /* ---- 抓包读取：全部 Read 档 ---- */
    ToolDescriptor {
        name: "sessions_list",
        description: "List capture Sessions, mirroring GET /api/sessions.",
        route: ("GET", "/api/sessions"),
        tier: ToolTier::Read,
        params: &[],
    },
    ToolDescriptor {
        name: "log_ids",
        description: "List capture log ids matching a filter, mirroring POST /api/logs/ids.",
        route: ("POST", "/api/logs/ids"),
        tier: ToolTier::Read,
        params: &[
            (
                "session_id",
                "integer",
                "Optional Session to read logs from; defaults to the active one.",
            ),
            (
                "filter",
                "object",
                "Optional capture filter, shaped {\"option\":{\"kind\":\"column\",\"column\":{\"kind\":\"uri\"|\"method\"|\"code\"|\"source\"|\"stage\"|\"script\"},\"regex\":false},\"input\":\"...\"} (column kinds: uri/method/code/source/stage or script{scriptName}); matching is a case-sensitive substring unless regex is true. Note: omitting option (or an empty input) matches ALL captures — use log_search for host/path/status filtering.",
            ),
            ("ids", "array", "Optional explicit log ids to select."),
            (
                "min_id",
                "integer",
                "Optional exclusive lower bound of the log id range (ids above it).",
            ),
            (
                "max_id",
                "integer",
                "Optional exclusive upper bound of the log id range (ids below it).",
            ),
            (
                "limit",
                "integer",
                "Max ids to return; the manager caps it at 10000.",
            ),
        ],
    },
    ToolDescriptor {
        name: "log_search",
        description: "Search capture logs with simple AND-composed predicates and get compact match summaries (id/method/uri/code), mirroring POST /api/logs/search. Prefer this over pulling every log via log_ids + log_detail to locate requests. Cursor semantics: matches are ordered DESCENDING by id unless you pass a lone min_id (ascending scan); `truncated:true` means limit was reached — feed `next_cursor` back as `max_id` (descending, the default) or as `min_id` (ascending) to fetch the next page. `next_cursor` is the last inspected id and is an EXCLUSIVE bound (itself not re-matched).",
        route: ("POST", "/api/logs/search"),
        tier: ToolTier::Read,
        params: &[
            (
                "session_id",
                "integer",
                "Optional Session to search; defaults to the active one (echoed back in the response).",
            ),
            (
                "host",
                "string",
                "Substring (or regex with regex=true) matched against the request URI.",
            ),
            (
                "path",
                "string",
                "Substring (or regex with regex=true) matched against the request URI.",
            ),
            (
                "method",
                "string",
                "HTTP method, compared case-insensitively (GET, POST, ...).",
            ),
            (
                "status",
                "string",
                "Response status code compared exactly; \"...\" matches captures without a response yet.",
            ),
            (
                "keyword",
                "string",
                "Substring (or regex with regex=true) matched against the request URI.",
            ),
            (
                "regex",
                "boolean",
                "Treat host/path/keyword/status as Rust regex patterns instead of substrings.",
            ),
            (
                "min_id",
                "integer",
                "Optional exclusive lower bound of the log id range (ids above it); a lone min_id scans ascending.",
            ),
            (
                "max_id",
                "integer",
                "Optional exclusive upper bound of the log id range (ids below it); the default scans descending.",
            ),
            (
                "limit",
                "integer",
                "Max matches to return; defaults to 200, capped at 10000. When truncated, continue from next_cursor via max_id (descending default) or min_id (ascending scans).",
            ),
        ],
    },
    ToolDescriptor {
        name: "log_detail",
        description: "Fetch one capture log detail, mirroring GET /api/logs/{id}. Response/request bodies can be large; pass max_body_length to bound them in the returned payload.",
        route: ("GET", "/api/logs/{id}"),
        tier: ToolTier::Read,
        params: &[
            ("id", "integer", "Capture log id to fetch."),
            (
                "session_id",
                "integer",
                "Optional Session owning the log; defaults to the active one.",
            ),
            (
                "max_body_length",
                "integer",
                "Optional cap in characters for request/response body text inside the returned detail; longer bodies are cut and marked with a [truncated ...] suffix. Omit for the full payload.",
            ),
        ],
    },
    ToolDescriptor {
        name: "log_body",
        description: "Read one capture log body as bounded detail (cut at 64 KiB), mirroring GET /api/logs/{id}/body.",
        route: ("GET", "/api/logs/{id}/body"),
        tier: ToolTier::Read,
        params: &[
            ("id", "integer", "Capture log id whose body is read."),
            ("side", "string", "Which side to read: request or response."),
            (
                "session_id",
                "integer",
                "Optional Session owning the log; defaults to the active one.",
            ),
        ],
    },
    ToolDescriptor {
        name: "replay_once",
        description: "Send one replay and return the new capture id, mirroring POST /api/replay. Either reference a request-library entry (library_id) or send a raw request (method + url); `override` adjusts either source. Sends real traffic — the execute MCP tier must be enabled. The replayed capture appears in the target session for inspection via log_detail.",
        route: ("POST", "/api/replay"),
        tier: ToolTier::Execute,
        params: &[
            (
                "session_id",
                "integer",
                "Optional target Session; defaults to the active one.",
            ),
            (
                "library_id",
                "string",
                "Request-library entry id to replay (its first HAR request; blob-backed bodies are inlined). Mutually exclusive with method/url and top-level headers/body.",
            ),
            (
                "method",
                "string",
                "HTTP method for a raw request; required together with url when library_id is absent.",
            ),
            (
                "url",
                "string",
                "Target URL for a raw request; required together with method when library_id is absent.",
            ),
            (
                "headers",
                "array",
                "Raw request headers as [name, value] pairs; raw mode only.",
            ),
            (
                "body",
                "object",
                "Raw request body, shaped {\"type\":\"text\",\"text\":\"...\"} (or body_ref/asset forms per POST /api/replay); raw mode only.",
            ),
            (
                "override",
                "object",
                "Optional overrides applied on top of the baseline: {method?, url?, headers?: [[name,value],...], removed_headers?: [name,...], body?: \"text\"}.",
            ),
        ],
    },
    /* ---- 请求库 ---- */
    ToolDescriptor {
        name: "request_library_list",
        description: "List request library entries, mirroring GET /api/request-library.",
        route: ("GET", "/api/request-library"),
        tier: ToolTier::Read,
        params: &[
            (
                "query",
                "string",
                "Case-insensitive text matched against entry name and first request URL.",
            ),
            (
                "tags",
                "string",
                "Comma-separated tag list; entries must carry every requested tag.",
            ),
            ("source", "string", "Filter by entry source."),
            (
                "limit",
                "integer",
                "Max entries to return, between 1 and 1000; defaults to 200.",
            ),
            ("offset", "integer", "Entries to skip."),
        ],
    },
    ToolDescriptor {
        name: "request_library_detail",
        description: "Fetch one request library entry, mirroring GET /api/request-library/{id}.",
        route: ("GET", "/api/request-library/{id}"),
        tier: ToolTier::Read,
        params: &[("id", "string", "Request library entry id.")],
    },
    ToolDescriptor {
        name: "request_library_create",
        description: "Create one request library entry from a HAR snapshot, mirroring POST /api/request-library. The server assigns the id/timestamps and source=manual; the HAR must carry at least one entry.",
        route: ("POST", "/api/request-library"),
        tier: ToolTier::Write,
        params: &[
            (
                "har",
                "object",
                "HAR snapshot object: {\"log\":{\"entries\":[{\"request\":{\"method\":\"GET\",\"url\":\"...\",\"headers\":[{\"name\",\"value\"}],\"postData\":{\"mimeType\",\"text\"}?}}]}} (minimal HAR 1.2 subset).",
            ),
            (
                "name",
                "string",
                "Optional entry name; defaults to METHOD host+path (deduplicated).",
            ),
            ("tags", "array", "Optional tags assigned to the entry."),
            ("origin", "string", "Optional page origin string."),
        ],
    },
    ToolDescriptor {
        name: "request_library_update",
        description: "Partially update one request library entry, mirroring PUT /api/request-library/{id}: absent fields stay unchanged; id/source/createdAt are never editable.",
        route: ("PUT", "/api/request-library/{id}"),
        tier: ToolTier::Write,
        params: &[
            ("id", "string", "Request library entry id to update."),
            ("name", "string", "Optional new entry name."),
            ("tags", "array", "Optional replacement tag list."),
            ("origin", "string", "Optional new page origin string."),
            (
                "har",
                "object",
                "Optional replacement HAR snapshot (same shape as create).",
            ),
        ],
    },
    ToolDescriptor {
        name: "request_library_delete",
        description: "Delete one request library entry, mirroring DELETE /api/request-library/{id}.",
        route: ("DELETE", "/api/request-library/{id}"),
        tier: ToolTier::Write,
        params: &[("id", "string", "Request library entry id to delete.")],
    },
    ToolDescriptor {
        name: "request_library_body",
        description: "Read one request library entry's raw request body (inline text or blob), mirroring GET /api/request-library/{id}/body.",
        route: ("GET", "/api/request-library/{id}/body"),
        tier: ToolTier::Read,
        params: &[
            (
                "id",
                "string",
                "Request library entry id whose body is read.",
            ),
            (
                "max_size",
                "integer",
                "Optional body size cap in bytes; defaults to 16 MiB.",
            ),
        ],
    },
    ToolDescriptor {
        name: "request_library_from_capture",
        description: "Ingest one capture into the request library, mirroring POST /api/request-library/from-capture.",
        route: ("POST", "/api/request-library/from-capture"),
        tier: ToolTier::Write,
        params: &[
            ("capture_id", "integer", "Capture (log) id to ingest."),
            (
                "session_id",
                "integer",
                "Optional Session owning the capture; defaults to the active one.",
            ),
            (
                "name",
                "string",
                "Optional entry name; defaults to METHOD host+path.",
            ),
            ("tags", "array", "Optional tags assigned to the new entry."),
        ],
    },
    /* ---- 环境变量集（读回显脱敏值；写回还原掩码语义见各工具描述） ---- */
    ToolDescriptor {
        name: "env_sets_list",
        description: "List environment variable sets with the activation preference and global variables, mirroring GET /api/env-sets. Secret values are always masked as \"******\" in the response; the active set id is echoed so callers can verify what a workflow run would resolve.",
        route: ("GET", "/api/env-sets"),
        tier: ToolTier::Read,
        params: &[],
    },
    ToolDescriptor {
        name: "env_sets_create",
        description: "Create one environment variable set (or duplicate an existing one via copyFrom), mirroring POST /api/env-sets. Returns the new set with masked secret values.",
        route: ("POST", "/api/env-sets"),
        tier: ToolTier::Write,
        params: &[
            ("name", "string", "Set name (e.g. dev / staging)."),
            (
                "copyFrom",
                "string",
                "Optional source set id to duplicate values from (including secrets).",
            ),
            (
                "values",
                "object",
                "Optional plain variable map (string keys and values); ignored when copyFrom is set.",
            ),
            (
                "secretValues",
                "object",
                "Optional secret variable map; ignored when copyFrom is set.",
            ),
        ],
    },
    ToolDescriptor {
        name: "env_sets_save",
        description: "Replace one environment variable set's editable fields, mirroring PUT /api/env-sets/{id}. Same masked round-trip as HTTP: pass \"******\" as a secretValues entry to keep its stored plaintext, a real value to add or replace it, omit a key to remove it; secret values are always masked in responses. name is required (send back the current name to keep it).",
        route: ("PUT", "/api/env-sets/{id}"),
        tier: ToolTier::Write,
        params: &[
            ("id", "string", "Environment variable set id to save."),
            (
                "name",
                "string",
                "Set name (required by the save contract).",
            ),
            (
                "values",
                "object",
                "Replacement plain variable map (whole map replaces the previous one).",
            ),
            (
                "secretValues",
                "object",
                "Replacement secret variable map; \"******\" entries restore the stored plaintext, real values write (and stay masked in responses).",
            ),
        ],
    },
    ToolDescriptor {
        name: "env_sets_activate",
        description: "Switch the activated environment variable set, mirroring PUT /api/env-sets/active. Pass setId (string) to activate one set or null to clear the preference; workflows resolve {{ env.* }} templates from the activated set at dispatch time.",
        route: ("PUT", "/api/env-sets/active"),
        tier: ToolTier::Write,
        params: &[(
            "setId",
            "string",
            "Set id to activate, or null to clear the activation.",
        )],
    },
    ToolDescriptor {
        name: "env_sets_delete",
        description: "Delete one environment variable set, mirroring DELETE /api/env-sets/{id}. Deleting the activated set clears the activation preference.",
        route: ("DELETE", "/api/env-sets/{id}"),
        tier: ToolTier::Write,
        params: &[("id", "string", "Environment variable set id to delete.")],
    },
    /* ---- 工作流 ---- */
    ToolDescriptor {
        name: "workflows_list",
        description: "List workflow definitions, mirroring GET /api/workflows.",
        route: ("GET", "/api/workflows"),
        tier: ToolTier::Read,
        params: &[
            ("projectId", "string", "Filter by owning flow project id."),
            (
                "limit",
                "integer",
                "Max entries to return, between 1 and 200; omitted defaults to 50.",
            ),
            (
                "offset",
                "integer",
                "Entries to skip; must be non-negative.",
            ),
        ],
    },
    ToolDescriptor {
        name: "workflow_detail",
        description: "Fetch one workflow definition, mirroring GET /api/workflows/{id}.",
        route: ("GET", "/api/workflows/{id}"),
        tier: ToolTier::Read,
        params: &[("id", "string", "Workflow id.")],
    },
    ToolDescriptor {
        name: "workflow_create",
        description: "Create one workflow definition, mirroring POST /api/workflows. The server generates the id (wf- prefix) and timestamps; projectId is not checked for existence. Prefer validating a draft graph with workflow_validate_deep before or after creating.",
        route: ("POST", "/api/workflows"),
        tier: ToolTier::Write,
        params: &[
            ("projectId", "string", "Owning flow project id (required)."),
            ("name", "string", "Workflow name (required)."),
            ("description", "string", "Optional description."),
            (
                "nodes",
                "array",
                "Optional node list ({id, type, position, config, label?, refId?}); types: start/httpReplay/condition/loop/delay/setVariable/assert/transform/stickyNote.",
            ),
            (
                "edges",
                "array",
                "Optional edge list ({id, source, target, sourceHandle?}).",
            ),
            ("variables", "object", "Optional workflow variables map."),
            (
                "secretVariables",
                "object",
                "Optional secret variables map.",
            ),
        ],
    },
    ToolDescriptor {
        name: "workflow_save",
        description: "Update one workflow definition, mirroring PUT /api/workflows/{id}.",
        route: ("PUT", "/api/workflows/{id}"),
        tier: ToolTier::Write,
        params: &[
            ("id", "string", "Workflow id to update."),
            (
                "projectId",
                "string",
                "Optional new owning flow project id.",
            ),
            ("name", "string", "Optional new workflow name."),
            ("description", "string", "Optional new description."),
            (
                "nodes",
                "array",
                "Replacement node list; send together with edges as one graph unit.",
            ),
            (
                "edges",
                "array",
                "Replacement edge list; send together with nodes as one graph unit.",
            ),
            ("variables", "object", "Replacement workflow variables map."),
            (
                "secretVariables",
                "object",
                "Replacement secret variables map.",
            ),
        ],
    },
    ToolDescriptor {
        name: "workflow_patch",
        description: "Patch one workflow graph incrementally (mirrors PATCH /api/workflows/{id}): apply addNodes/updateNodes/removeNodes/addEdges/updateEdges/removeEdges by id instead of resending the whole graph — the right tool for surgical edits on large graphs (workflow_save replaces everything). updateNodes[].config follows JSON Merge Patch (RFC 7386: objects merge recursively, null deletes a key, arrays/scalars replace); removeNodes cascades incident edges away. Returns a compact summary of applied ids, not the full document; the graph is structurally validated before persisting and the whole patch is rejected on any error-level issue. Pass at least one operation list.",
        route: ("PATCH", "/api/workflows/{id}"),
        tier: ToolTier::Write,
        params: &[
            ("id", "string", "Workflow id to patch."),
            (
                "addNodes",
                "array",
                "Complete WorkflowNode documents to insert; ids must not exist yet.",
            ),
            (
                "updateNodes",
                "array",
                "Objects with a required id plus optional position/label/refId (replace; null clears) and config (JSON Merge Patch fragment). Unknown fields are rejected.",
            ),
            (
                "removeNodes",
                "array",
                "Node ids to remove; incident edges are cascade-deleted.",
            ),
            (
                "addEdges",
                "array",
                "Complete WorkflowEdge documents to insert; ids must not exist yet, source/target must reference existing nodes.",
            ),
            (
                "updateEdges",
                "array",
                "Objects with a required id plus optional source/target (must reference existing nodes) and sourceHandle (\"true\"/\"false\"/null). Unknown fields are rejected.",
            ),
            ("removeEdges", "array", "Edge ids to remove."),
        ],
    },
    ToolDescriptor {
        name: "workflow_validate",
        description: "Validate one stored workflow graph, mirroring POST /api/workflows/{id}/validate. Returns structural (run-blocking) issues; each issue carries severity=error. For request-library reference, template and assertion checks on a draft, use workflow_validate_deep.",
        route: ("POST", "/api/workflows/{id}/validate"),
        tier: ToolTier::Read,
        params: &[("id", "string", "Workflow id to validate.")],
    },
    ToolDescriptor {
        name: "workflow_validate_deep",
        description: "Deep-validate a workflow graph (editor diagnostics), mirroring POST /api/flow/validate. Runs the structural checks plus deep rules: requestId existence in the request library, {{ }} template syntax and resolvable node/env/var/fake references, assertion rule shape, and unknown config keys (inline mode only). Deep issues never gate saves or runs; exactly one of id or nodes+edges must be provided.",
        route: ("POST", "/api/flow/validate"),
        tier: ToolTier::Read,
        params: &[
            (
                "id",
                "string",
                "Stored workflow id to deep-validate; mutually exclusive with nodes/edges.",
            ),
            (
                "nodes",
                "array",
                "Draft node list (same shape as workflow_create nodes); requires edges too. Unknown config keys are detectable only in this inline mode.",
            ),
            ("edges", "array", "Draft edge list; requires nodes too."),
            (
                "variables",
                "object",
                "Optional draft variables map considered for {{ var.* }} resolution (the stored/global/project tables are also consulted).",
            ),
            (
                "secretVariables",
                "object",
                "Optional draft secret variables map (same resolution as variables).",
            ),
        ],
    },
    ToolDescriptor {
        name: "script_dry_run",
        description: "Dry-run one pre/post processing script against a sample payload, mirroring POST /api/flow/script/dry-run. Executes in a throwaway flow-engine VM: nothing is persisted or broadcast, and outbound replay is blocked. Use it to sanity-check preProcess/postProcess scripts before saving a workflow.",
        route: ("POST", "/api/flow/script/dry-run"),
        tier: ToolTier::Execute,
        params: &[
            (
                "side",
                "string",
                "\"pre\" (sample: aggregated upstream input) or \"post\" (sample: raw response envelope).",
            ),
            ("script", "string", "Script source to execute."),
            (
                "sampleInput",
                "object",
                "Optional sample input for pre scripts (any JSON).",
            ),
            (
                "sampleResponse",
                "object",
                "Optional sample response envelope for post scripts (any JSON).",
            ),
        ],
    },
    ToolDescriptor {
        name: "workflow_render_preview",
        description: "Preview the rendered request of one httpReplay node (template render dry-run), mirroring POST /api/flow/render-preview. Assembles the run-chain inputs (3-layer variable table, active env set, workflow storage, request-library projection) and renders the exact outgoing request — baseline + override, browser-only header stripping, {{ }} templates (node/input refs render empty and are reported in warnings), fake.* sampled once consistently per preview, header-fidelity/cookie merged. No preProcess script execution (use script_dry_run for that), zero outbound traffic, nothing persisted, secret values masked in the response. Requires a saved workflow.",
        route: ("POST", "/api/flow/render-preview"),
        tier: ToolTier::Execute,
        params: &[
            (
                "workflowId",
                "string",
                "Owning workflow id (stored workflows only).",
            ),
            ("nodeId", "string", "Target httpReplay node id."),
            (
                "variableOverrides",
                "object",
                "Optional var.* sample values (highest precedence) — e.g. sample values for setVariable-declared runtime variables.",
            ),
        ],
    },
    /* ---- 工作流存储（工作流级持久化 KV；与 env 家族同域异用）---- */
    ToolDescriptor {
        name: "workflow_storage_list",
        description: "Read the persistent key/value storage of one workflow, mirroring GET /api/workflows/{id}/storage. Entries are sorted by key and carry their last-write updatedAt. This is the same store workflow runs access live via host.storage.",
        route: ("GET", "/api/workflows/{id}/storage"),
        tier: ToolTier::Read,
        params: &[("workflowId", "string", "Owning workflow id.")],
    },
    ToolDescriptor {
        name: "workflow_storage_put",
        description: "Upsert one key with an arbitrary JSON value in a workflow's persistent storage, mirroring PUT /api/workflows/{id}/storage/{key}. The write persists immediately and is visible to running and later runs in real time; returns the refreshed entry list. Key charset: [A-Za-z0-9._-], max 128 bytes.",
        route: ("PUT", "/api/workflows/{id}/storage/{key}"),
        tier: ToolTier::Write,
        params: &[
            ("workflowId", "string", "Owning workflow id."),
            ("key", "string", "Storage key to upsert."),
            (
                "value",
                "object",
                "Any JSON value to store (may also be a string/number/boolean/array/null).",
            ),
        ],
    },
    ToolDescriptor {
        name: "workflow_storage_delete",
        description: "Delete one key from a workflow's persistent storage, mirroring DELETE /api/workflows/{id}/storage/{key}; omit key to clear the whole workflow storage (mirrors DELETE /api/workflows/{id}/storage). Returns the refreshed entry list.",
        route: ("DELETE", "/api/workflows/{id}/storage/{key}"),
        tier: ToolTier::Write,
        params: &[
            ("workflowId", "string", "Owning workflow id."),
            (
                "key",
                "string",
                "Storage key to delete; omit to clear the whole workflow storage.",
            ),
        ],
    },
    /* ---- 运行 ---- */
    ToolDescriptor {
        name: "workflow_runs_list",
        description: "List workflow runs, mirroring GET /api/flow/runs.",
        route: ("GET", "/api/flow/runs"),
        tier: ToolTier::Read,
        params: &[
            ("workflowId", "string", "Filter by workflow id."),
            ("status", "string", "Filter by run status."),
            (
                "limit",
                "integer",
                "Max entries to return, between 1 and 1000; defaults to 200.",
            ),
            ("offset", "integer", "Entries to skip."),
        ],
    },
    ToolDescriptor {
        name: "workflow_run_trigger",
        description: "Trigger one workflow run, mirroring POST /api/flow/runs. The response is slimmed by default: the graph snapshot captured at dispatch (can exceed 35KB on large graphs) is omitted unless includeGraph is true — fetch it later via workflow_run_detail.",
        route: ("POST", "/api/flow/runs"),
        tier: ToolTier::Execute,
        params: &[
            ("workflowId", "string", "Workflow to run."),
            (
                "sessionId",
                "integer",
                "Optional target Session; defaults to the active one.",
            ),
            (
                "startNodeId",
                "string",
                "Optional entry start-node id; required when the workflow has multiple start nodes.",
            ),
            (
                "includeGraph",
                "boolean",
                "Optional; include the run's graphSnapshot in the response. Defaults to false (slim response) — the snapshot stays available via workflow_run_detail.",
            ),
        ],
    },
    ToolDescriptor {
        name: "workflow_run_cancel",
        description: "Cancel one workflow run, mirroring POST /api/flow/runs/{id}/cancel.",
        route: ("POST", "/api/flow/runs/{id}/cancel"),
        tier: ToolTier::Execute,
        params: &[("id", "string", "Workflow run id to cancel.")],
    },
    ToolDescriptor {
        name: "workflow_run_detail",
        description: "Fetch one workflow run detail with node checkpoints, mirroring GET /api/flow/runs/{id}.",
        route: ("GET", "/api/flow/runs/{id}"),
        tier: ToolTier::Read,
        params: &[("id", "string", "Workflow run id.")],
    },
    ToolDescriptor {
        name: "workflow_run_wait",
        description: "Wait for one workflow run to reach a terminal state (server-side polling; reuses the GET /api/flow/runs/{id} permission) and return a compact digest: run record fields plus per-node {nodeId,status,durationMs,error}. Omits graphSnapshot and node input/output; use workflow_run_detail for the full checkpoints. `settled:false` means the deadline elapsed first — the caller may wait again.",
        route: ("GET", "/api/flow/runs/{id}"),
        tier: ToolTier::Read,
        params: &[
            ("id", "string", "Workflow run id."),
            (
                "timeoutMs",
                "integer",
                "Max wait in milliseconds, between 1 and 55000 (this tool alone gets a 60s execution budget); defaults to 20000.",
            ),
            (
                "intervalMs",
                "integer",
                "Poll interval in milliseconds, between 50 and 60000; defaults to 500.",
            ),
        ],
    },
];

/// `tools/list` 展示的策展清单（Task 25 扩充工具面）。
pub fn list() -> &'static [ToolDescriptor] {
    REGISTRY
}

/// 档位放行的策展工具迭代器：`tools/list` 清单与工具计数共用同一过滤源
/// （plan Task 25 Step 2；桌面 `get_mcp_tool_count` 复用）。
fn tier_enabled_tools(tiers: &McpTiers) -> impl Iterator<Item = &'static ToolDescriptor> {
    REGISTRY.iter().filter(move |tool| tool.tier.enabled(tiers))
}

/// `tools/list` 应答的策展工具清单（含各工具的 inputSchema），按 MCP 暴露
/// 档位过滤：档位关闭的工具不出现在清单里（plan Task 25 Step 2）。
pub fn list_envelope(tiers: &McpTiers) -> Value {
    json!({
        "tools": tier_enabled_tools(tiers)
            .map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": input_schema(tool),
            }))
            .collect::<Vec<_>>()
    })
}

/// 当前档位下 `tools/list` 会出现的工具数（桌面 `get_mcp_tool_count` 与
/// `tools/list` 同源过滤）。
pub fn tier_tool_count(tiers: &McpTiers) -> usize {
    tier_enabled_tools(tiers).count()
}

/// 工具入参的 JSON Schema（对象 + 注册表声明的属性）。
pub fn input_schema(tool: &ToolDescriptor) -> Value {
    let properties = tool
        .params
        .iter()
        .map(|(name, kind, description)| {
            (
                (*name).to_owned(),
                json!({ "type": kind, "description": description }),
            )
        })
        .collect::<serde_json::Map<String, Value>>();
    json!({ "type": "object", "properties": properties })
}

/// 按名查找工具描述；未登记工具返回 `None`（`tools/call` 报未知工具）。
pub fn lookup(name: &str) -> Option<&'static ToolDescriptor> {
    if let Some(tool) = REGISTRY.iter().find(|tool| tool.name == name) {
        return Some(tool);
    }
    #[cfg(test)]
    {
        // 测试专用长任务桩：不进入 tools/list 与生产注册表。
        if name == "test_slow_tool" {
            return Some(&TEST_SLOW_TOOL);
        }
    }
    None
}

/// 一次 `tools/call` 的执行环境：管理状态、权限服务、调用者身份
/// （身份已由 `authorize_request` 依据既有体系解析完成）、MCP 暴露档位
/// 与在途许可闸。
#[derive(Clone)]
pub struct ToolCallContext {
    pub manager: Arc<dyn ProxyCrabManager>,
    pub permissions: Arc<dyn PermissionManager>,
    pub credential: ManagementCredential,
    /// MCP 暴露三档开关（plan Task 25 Step 2）：与端点档位、映射路由档位
    /// 叠加为三检，任一拒绝即拒。
    pub tiers: McpTiers,
    pub permits: Arc<Semaphore>,
}

/// `tools/call` 全流程：名称校验 → 注册表查找 → 在途并发闸 → 映射路由
/// 逐次鉴权（审批档复用既有审批窗）→ 带超时执行 → 统一错误映射。
/// 缺名/空名维持协议层 -32602（信封问题），其余失败一律 MCP `isError`。
pub async fn call(request: &RpcRequest, context: &ToolCallContext, timeout: Duration) -> Value {
    let Some(name) = request
        .params
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
    else {
        return protocol::error(
            &request.id,
            protocol::INVALID_PARAMS,
            "tools/call requires a non-empty tool name",
        );
    };
    let Some(tool) = lookup(name) else {
        return tool_error(&request.id, name, "unknown tool");
    };
    // 三检之一：MCP 暴露档位（plan Task 25 Step 2）。档位关闭时即使直呼
    // 工具名也硬拒，与 tools/list 的过滤保持一致（更严者生效）。
    if !tool.tier.enabled(&context.tiers) {
        return tool_error(&request.id, name, "该工具类别的 MCP 档位已关闭");
    }
    let arguments = request
        .params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !arguments.is_object() {
        return tool_error(&request.id, name, "arguments must be an object");
    }
    // 在途并发上限：快速失败，不排队；许可在调用结束（含断连/超时丢弃
    // future）时随 Drop 释放。
    let Ok(_permit) = context.permits.clone().try_acquire_owned() else {
        return tool_error(
            &request.id,
            name,
            "too many concurrent tool calls; retry later",
        );
    };
    // 逐次鉴权：按映射路由的 action 档位检查；审批档在此等待既有桌面
    // 审批窗（队列自带超时），拒绝/超时得到 PermissionDenied。
    let Some(action) = find_api_action(tool.route.0, tool.route.1) else {
        // 目录漂移防护：注册表声明的路由必须已登记，缺失时拒绝执行。
        return tool_error(
            &request.id,
            name,
            "tool route is missing from the permission catalog",
        );
    };
    let arguments_json = arguments.to_string();
    let denied = context
        .permissions
        .check_permission(PermissionAction {
            action,
            credential: context.credential.clone(),
            actual_path: "/mcp".into(),
            query: None,
            source: None,
            content_type: Some("application/json".into()),
            content_length: None,
            body_preview: Some(arguments_json.clone()),
            body_preview_truncated: false,
        })
        .await;
    // 审计身份解析（plan Task 25 Step 4）：本地直连记 "local"，分享身份
    // 记其稳定 id，解析失败记 "unresolved"。
    let identity = match context
        .permissions
        .share_identity(&context.credential)
        .await
    {
        Ok(None) => "local".to_owned(),
        Ok(Some(identity)) => identity.id,
        Err(_) => "unresolved".to_owned(),
    };
    if let Some(denied) = denied {
        let reason = denial_reason(&denied);
        record_audit(
            context,
            McpAuditEntry::new(
                name,
                identity.as_str(),
                &arguments_json,
                "denied",
                "denied",
                Some(reason.clone()),
            ),
        )
        .await;
        return tool_error(&request.id, name, &reason);
    }
    // 脱敏绑定（plan Task 25 Step 4）：有绑定时执行段换成 reader
    // (Some(&script), "mcp")，工具结果与 HTTP API 同路径脱敏；reader 解析
    // 失败按 ManagerError 走 tool_error（fail closed），无绑定用原 manager。
    let manager = match context
        .permissions
        .redaction_script(&context.credential)
        .await
    {
        Ok(Some(script)) => match context.manager.reader(Some(&script), "mcp") {
            Ok(reader) => reader,
            Err(error) => {
                let reason = manager_error_reason(&error);
                record_audit(
                    context,
                    McpAuditEntry::new(
                        name,
                        identity.as_str(),
                        &arguments_json,
                        "error",
                        "allowed",
                        Some(reason.clone()),
                    ),
                )
                .await;
                return tool_error(&request.id, name, &reason);
            }
        },
        Ok(None) => context.manager.clone(),
        Err(denied) => {
            let reason = manager_error_reason(&ManagerError::internal(denied.message));
            record_audit(
                context,
                McpAuditEntry::new(
                    name,
                    identity.as_str(),
                    &arguments_json,
                    "error",
                    "allowed",
                    Some(reason.clone()),
                ),
            )
            .await;
            return tool_error(&request.id, name, &reason);
        }
    };
    // 执行段带超时；超时即丢弃执行 future（底层工作随之取消）。整个
    // 调用内联 await 于 HTTP 处理器，客户端断开同样以丢弃取消底层。
    // workflow_run_wait 是唯一例外：它本身就是服务端轮询等待，统一 30s
    // 预算下等不满 55s 的等待上限，单独放宽到 60s（其余工具维持调用方
    // 传入的缺省 30s 预算）。
    let effective_timeout = if tool.name == "workflow_run_wait" {
        timeout.max(WAIT_TOOL_CALL_TIMEOUT)
    } else {
        timeout
    };
    match tokio::time::timeout(effective_timeout, execute(tool.name, &arguments, &manager)).await {
        Ok(Ok(value)) => {
            record_audit(
                context,
                McpAuditEntry::new(
                    name,
                    identity.as_str(),
                    &arguments_json,
                    "ok",
                    "allowed",
                    None,
                ),
            )
            .await;
            protocol::success(
                &request.id,
                json!({ "content": [{ "type": "text", "text": value.to_string() }] }),
            )
        }
        Ok(Err(error)) => {
            let reason = manager_error_reason(&error);
            record_audit(
                context,
                McpAuditEntry::new(
                    name,
                    identity.as_str(),
                    &arguments_json,
                    "error",
                    "allowed",
                    Some(reason.clone()),
                ),
            )
            .await;
            tool_error(&request.id, name, &reason)
        }
        Err(_) => {
            let reason = format!("execution timed out after {}s", timeout.as_secs());
            record_audit(
                context,
                McpAuditEntry::new(
                    name,
                    identity.as_str(),
                    &arguments_json,
                    "error",
                    "allowed",
                    Some(reason.clone()),
                ),
            )
            .await;
            tool_error(&request.id, name, &reason)
        }
    }
}

/// 审计落盘（plan Task 25 Step 4，best-effort）：追加失败只告警，绝不
/// 阻断工具调用——审计是辅助观测数据，不是关键路径。追加经 manager
/// trait 走 blocking 通道（审计文件小，单次原子写，无需额外异步化）。
async fn record_audit(context: &ToolCallContext, entry: McpAuditEntry) {
    if let Err(error) = context.manager.append_mcp_audit(entry).await {
        tracing::warn!(
            "failed to append MCP tool call audit entry: {}",
            error.message
        );
    }
}

/// 工具级失败结果：MCP `isError` 形态，原因文案经统一映射。
fn tool_error(id: &Value, name: &str, reason: &str) -> Value {
    protocol::success(
        id,
        json!({
            "content": [{ "type": "text", "text": format!("tool '{name}': {reason}") }],
            "isError": true,
        }),
    )
}

/// 鉴权拒绝的可读文案：`message` 来自权限目录固定文案（如
/// "management API approval timed out"），可透传；internal 档位降级
/// 为固定文案，避免内部细节进入 MCP 应答。
fn denial_reason(denied: &PermissionDenied) -> String {
    match denied.status {
        PermissionDeniedStatus::Unauthorized => {
            format!("caller is not authorized: {}", denied.message)
        }
        PermissionDeniedStatus::Forbidden => format!("permission denied: {}", denied.message),
        PermissionDeniedStatus::Internal => "permission check failed".to_owned(),
    }
}

/// 管理端错误的统一映射：入参校验（bad_request）与业务校验类
/// （not_found / conflict / workflow_graph_invalid，manager 侧策展文案）
/// 连同服务端 message 透出，供调用方自纠（如多开始节点需指定
/// startNodeId）；其余类别（internal/storage/IO 等，可能携带文件路径、
/// 连接串等内部细节）只暴露稳定错误码。
fn manager_error_reason(error: &ManagerError) -> String {
    match error.code {
        ErrorCode::BadRequest => format!("invalid arguments: {}", error.message),
        ErrorCode::NotFound | ErrorCode::Conflict | ErrorCode::WorkflowGraphInvalid => {
            format!(
                "execution failed ({}): {}",
                error.code.as_str(),
                error.message
            )
        }
        _ => format!("execution failed ({})", error.code.as_str()),
    }
}

/// 读类工具的工具层分页界限（plan Task 25 Step 3）：`(工具名, (缺省
/// limit, 上限))`。上限与既有 manager 侧校验量级对齐；未列入的工具
/// 不在此检查——已有 manager 侧校验的（如 workflow_runs_list）依赖
/// 既有校验，单资源读取与天然少量的清单（sessions_list）无需分页。
const PAGE_BOUNDS: &[(&str, (usize, usize))] = &[("workflows_list", (50, 200))];

/// 读类工具强制分页（plan Task 25 Step 3）：对声明了分页界限的工具，
/// 分发前统一检查 limit/offset——limit 为 0/负数或超上限、offset 为
/// 负数时以 bad_request 拒绝并说明合法范围（文案经 manager_error_reason
/// 原样透出）；未带 limit 时注入安全缺省值，避免一次拉爆全量返回。
/// 类型不符的入参仍交由 parse_arguments 报错，未声明界限的工具原样放行。
fn enforce_page_bounds(name: &str, arguments: &Value) -> Result<Value, ManagerError> {
    let Some(&(_, (default_limit, max_limit))) = PAGE_BOUNDS.iter().find(|(tool, _)| *tool == name)
    else {
        return Ok(arguments.clone());
    };
    if !arguments.is_object() {
        return Ok(arguments.clone());
    }
    let mut bounded = arguments.clone();
    let has_limit = matches!(bounded.get("limit"), Some(value) if !value.is_null());
    if !has_limit {
        bounded["limit"] = json!(default_limit);
    } else if let Some(limit) = bounded.get("limit").and_then(Value::as_i64)
        && !(1..=(max_limit as i64)).contains(&limit)
    {
        return Err(ManagerError::bad_request(format!(
            "limit must be between 1 and {max_limit}"
        )));
    }
    if let Some(offset) = bounded.get("offset").and_then(Value::as_i64)
        && offset < 0
    {
        return Err(ManagerError::bad_request(
            "offset must be a non-negative integer",
        ));
    }
    Ok(bounded)
}

/// 工具体执行：按注册表名分发。执行错误统一为 `ManagerError`，文案
/// 出口收敛在 `manager_error_reason`。分发前先做读类工具的分页界限
/// 检查（plan Task 25 Step 3）。
async fn execute(
    name: &str,
    arguments: &Value,
    manager: &Arc<dyn ProxyCrabManager>,
) -> Result<Value, ManagerError> {
    let arguments = &enforce_page_bounds(name, arguments)?;
    match name {
        "workflow_runs_list" => {
            // manager 侧已校验 limit（1..=1000，缺省 200），工具层依赖既有校验。
            let query: FlowRunListQuery = parse_arguments(arguments)?;
            serialize_result(manager.workflow_runs(query).await?)
        }
        /* ---- 抓包读取 ---- */
        // 会话数量天然少：无分页入参，全量返回可接受。
        "sessions_list" => serialize_result(manager.sessions().await?),
        "log_ids" => {
            // manager 侧已限界：缺省 10000 且收敛到 ≤10000，limit=0 亦合法
            // （仅校验过滤条件不扫描），工具层无需重复检查。
            let request: LogIdsRequest = parse_arguments(arguments)?;
            serialize_result(manager.log_ids(request).await?)
        }
        "log_search" => {
            // manager 侧已限界：缺省 200、上限 10000；响应回显 session_id 与
            // 截断游标，工具层无需重复检查。
            let request: LogSearchRequest = parse_arguments(arguments)?;
            serialize_result(manager.log_search(request).await?)
        }
        "log_detail" => {
            let args: LogDetailArgs = parse_arguments(arguments)?;
            let mut detail = serialize_result(manager.log(args.session_id, args.id).await?)?;
            if let Some(max_len) = args.max_body_length {
                if max_len == 0 {
                    return Err(ManagerError::bad_request(
                        "max_body_length must be greater than zero",
                    ));
                }
                truncate_log_detail_bodies(&mut detail, max_len);
            }
            Ok(detail)
        }
        "log_body" => {
            let id = path_argument(arguments, "id")?;
            let side: BodySide = path_argument(arguments, "side")?;
            let query: SessionQuery = parse_arguments(arguments)?;
            let source = manager.log_body_source(query.session_id, id, side).await?;
            // BodySource 不序列化上送：走读时受限渲染（与日志详情的 body
            // 形态一致，超限降级为 Large 摘要）。
            let payload = read_body_payload(source).map_err(|_| {
                ManagerError::new(ErrorCode::BodyReadFailed, "read capture body failed")
            })?;
            serialize_result(payload)
        }
        "replay_once" => {
            // 请求源互斥（library_id XOR method+url）与 override 应用都在
            // manager 侧统一校验，工具层只透传。
            let request: ReplayHttpRequest = parse_arguments(arguments)?;
            serialize_result(manager.replay_request(request).await?)
        }
        /* ---- 请求库 ---- */
        "request_library_list" => {
            // manager 侧已校验 limit（1..=1000，缺省 200），工具层依赖既有校验。
            let query: RequestLibraryQuery = parse_arguments(arguments)?;
            serialize_result(manager.request_library_page(query).await?)
        }
        "request_library_detail" => {
            let id = path_argument(arguments, "id")?;
            serialize_result(manager.request_library_entry(id).await?)
        }
        "request_library_from_capture" => {
            let request: IngestCaptureRequest = parse_arguments(arguments)?;
            serialize_result(manager.ingest_request_from_capture(request).await?)
        }
        "request_library_create" => {
            let request: CreateRequestLibraryRequest = parse_arguments(arguments)?;
            serialize_result(manager.create_request_library_entry(request).await?)
        }
        "request_library_update" => {
            let id = path_argument(arguments, "id")?;
            let request: UpdateRequestLibraryRequest =
                parse_arguments(&strip_argument(arguments, "id"))?;
            serialize_result(manager.update_request_library_entry(id, request).await?)
        }
        "request_library_delete" => {
            let id = path_argument(arguments, "id")?;
            manager.delete_request_library_entry(id).await?;
            Ok(json!({ "deleted": true }))
        }
        "request_library_body" => {
            let id = path_argument(arguments, "id")?;
            let query: RequestLibraryBodyQuery = parse_arguments(arguments)?;
            let source = manager
                .request_library_body_source(id, query.max_size.unwrap_or(default_body_max_size()))
                .await?;
            // BodySource 不序列化上送：走读时受限渲染（与抓包 body 同形态）。
            let payload = read_body_payload(source).map_err(|_| {
                ManagerError::new(
                    ErrorCode::BodyReadFailed,
                    "read request library body failed",
                )
            })?;
            serialize_result(payload)
        }
        /* ---- 环境变量集 ---- */
        "env_sets_list" => serialize_result(manager.env_sets().await?),
        "env_sets_create" => {
            let request: CreateEnvSetRequest = parse_arguments(arguments)?;
            serialize_result(manager.create_env_set(request).await?)
        }
        "env_sets_save" => {
            // 与 HTTP PUT 同契约：masked `******` 回写恢复存量明文、显式新值
            // 覆盖、缺键删除；响应恒掩码（secret 明文不回传 MCP）。
            let id = path_argument(arguments, "id")?;
            let request: SaveEnvSetRequest = parse_arguments(&strip_argument(arguments, "id"))?;
            serialize_result(manager.save_env_set(id, request).await?)
        }
        "env_sets_activate" => {
            let request: ReplaceActiveEnvSetRequest = parse_arguments(arguments)?;
            let active_set_id = manager.replace_active_env_set(request).await?;
            Ok(json!({ "active_set_id": active_set_id }))
        }
        "env_sets_delete" => {
            let id = path_argument(arguments, "id")?;
            manager.delete_env_set(id).await?;
            Ok(json!({ "deleted": true }))
        }
        /* ---- 工作流 ---- */
        "workflows_list" => {
            let query: WorkflowListQuery = parse_arguments(arguments)?;
            serialize_result(manager.workflows(query).await?)
        }
        "workflow_detail" => {
            let id = path_argument(arguments, "id")?;
            serialize_result(manager.workflow(id).await?)
        }
        "workflow_create" => {
            let request: WorkflowCreateRequest = parse_arguments(arguments)?;
            serialize_result(manager.create_workflow(request).await?)
        }
        "workflow_save" => {
            // WorkflowUpdateRequest 不含 id：路径 id 从入参取出，其余整体
            // 反序列化（多出的 id 字段被 serde 忽略）。
            let id = path_argument(arguments, "id")?;
            let request: WorkflowUpdateRequest = parse_arguments(arguments)?;
            serialize_result(manager.update_workflow(id, request).await?)
        }
        "workflow_patch" => {
            // 补丁按 id 增量应用：路径 id 取出后整体反序列化为补丁请求；
            // 应用与结构校验都在 manager 侧，响应为紧凑摘要。
            let id = path_argument(arguments, "id")?;
            let request: WorkflowPatchRequest = parse_arguments(arguments)?;
            serialize_result(manager.patch_workflow(id, request).await?)
        }
        "workflow_validate" => {
            let id = path_argument(arguments, "id")?;
            serialize_result(manager.validate_workflow(id).await?)
        }
        "workflow_validate_deep" => {
            let request: WorkflowDeepValidateRequest = parse_arguments(arguments)?;
            serialize_result(manager.validate_workflow_deep(request).await?)
        }
        "script_dry_run" => {
            let request: FlowScriptDryRunRequest = parse_arguments(arguments)?;
            serialize_result(manager.flow_script_dry_run(request).await?)
        }
        "workflow_render_preview" => {
            let request: FlowRenderPreviewRequest = parse_arguments(arguments)?;
            serialize_result(manager.flow_render_preview(request).await?)
        }
        /* ---- 工作流存储 ---- */
        "workflow_storage_list" => {
            let workflow_id = path_argument(arguments, "workflowId")?;
            serialize_result(manager.workflow_storage(workflow_id).await?)
        }
        "workflow_storage_put" => {
            let workflow_id = path_argument(arguments, "workflowId")?;
            let key = path_argument(arguments, "key")?;
            // value 为任意 JSON（缺省 null）；其余键（workflowId/key）不进请求体。
            let value = arguments.get("value").cloned().unwrap_or(Value::Null);
            serialize_result(
                manager
                    .workflow_storage_put(workflow_id, key, WorkflowStoragePutRequest { value })
                    .await?,
            )
        }
        "workflow_storage_delete" => {
            let workflow_id = path_argument(arguments, "workflowId")?;
            match arguments.get("key").and_then(Value::as_str) {
                // 带 key：删除单键；缺 key：清空整个工作流存储（描述与 route
                // 映射见 registry 条目）。
                Some(key) => serialize_result(
                    manager
                        .workflow_storage_delete_key(workflow_id, key.to_owned())
                        .await?,
                ),
                None => serialize_result(manager.workflow_storage_clear(workflow_id).await?),
            }
        }
        /* ---- 运行 ---- */
        "workflow_run_trigger" => {
            // includeGraph 是 MCP 响应形态开关（默认瘦身），不属于 HTTP 请求体
            // —— 先剥掉再透传；缺省从结果中剔除 graphSnapshot（大图可达数十
            // KB，且刚保存过、需要时经 workflow_run_detail 可再取）。
            let include_graph = arguments
                .get("includeGraph")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let request: FlowRunTriggerRequest =
                parse_arguments(&strip_argument(arguments, "includeGraph"))?;
            let mut result = serialize_result(manager.trigger_workflow_run(request).await?)?;
            if !include_graph && let Some(record) = result.as_object_mut() {
                record.remove("graphSnapshot");
            }
            Ok(result)
        }
        "workflow_run_cancel" => {
            let id = path_argument(arguments, "id")?;
            manager.cancel_workflow_run(id).await?;
            Ok(json!({ "cancelled": true }))
        }
        "workflow_run_detail" => {
            let id = path_argument(arguments, "id")?;
            serialize_result(manager.workflow_run_detail(id).await?)
        }
        "workflow_run_wait" => {
            let args: WorkflowRunWaitArgs = parse_arguments(arguments)?;
            serialize_result(
                manager
                    .wait_workflow_run(args.id, args.timeout_ms, args.interval_ms)
                    .await?,
            )
        }
        #[cfg(test)]
        "test_slow_tool" => Ok(slow_tool_stub::run().await),
        // lookup 已把执行器与注册表对齐；此分支不可达。
        _ => Err(ManagerError::internal("tool has no executor")),
    }
}

/// `log_detail` 工具入参：session 解析与日志 id 之外多一个可选的正文截断
/// 上限（仅影响返回载荷，不改变抓包数据本身）。
#[derive(serde::Deserialize)]
struct LogDetailArgs {
    id: u64,
    session_id: Option<u64>,
    max_body_length: Option<usize>,
}

/// `workflow_run_wait` 工具入参：路径 id 之外多出可选的等待上限与轮询
/// 间隔（服务端收敛参数，取值界内校验在 manager 侧统一做）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowRunWaitArgs {
    id: String,
    timeout_ms: Option<u64>,
    interval_ms: Option<u64>,
}

/// 有界渲染 `log_detail`：截断 request/response 正文字符串并附标记。text
/// 正文与 json 字符串正文参与截断；json 对象形态保持原样（结构化的 body
/// 建议改走 `log_body` 的受限渲染），binary/large/empty 本就不含正文。
fn truncate_log_detail_bodies(detail: &mut Value, max_len: usize) {
    for section in ["request", "response"] {
        let Some(body) = detail
            .get_mut(section)
            .and_then(|side| side.get_mut("body"))
        else {
            continue;
        };
        let kind = body
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let Some(content) = body.get_mut("content") else {
            continue;
        };
        let text = match (kind.as_str(), &*content) {
            ("text", Value::String(text)) => Some(text.to_owned()),
            ("json", Value::String(text)) => Some(text.to_owned()),
            _ => None,
        };
        let Some(text) = text else { continue };
        let total = text.chars().count();
        if total <= max_len {
            continue;
        }
        let truncated: String = text.chars().take(max_len).collect();
        *content = Value::String(format!("{truncated}…[truncated {total} chars total]"));
    }
}

/// 反序列化工具入参为映射路由的查询/请求体类型；失败归入 bad_request。
fn parse_arguments<T: DeserializeOwned>(arguments: &Value) -> Result<T, ManagerError> {
    serde_json::from_value(arguments.clone()).map_err(|error| {
        ManagerError::bad_request(format!("arguments do not match the tool schema: {error}"))
    })
}

/// 从工具入参中提取路径参数（id 等，提升为入参的路由段）；缺失或类型
/// 不符归入 bad_request。
fn path_argument<T: DeserializeOwned>(arguments: &Value, name: &str) -> Result<T, ManagerError> {
    let value = arguments
        .get(name)
        .ok_or_else(|| ManagerError::bad_request(format!("missing required argument: {name}")))?;
    serde_json::from_value(value.clone()).map_err(|error| {
        ManagerError::bad_request(format!(
            "argument '{name}' does not match the tool schema: {error}"
        ))
    })
}

/// 路径参数已单独提取后的剩余入参：路径 id 不是路由的 body 字段，先剥掉再
/// 整体反序列化，避免 `deny_unknown_fields` 的请求体 DTO 拒收工具层的
/// `id` 形参。
fn strip_argument(arguments: &Value, name: &str) -> Value {
    let mut fields = arguments.clone();
    if let Some(object) = fields.as_object_mut() {
        object.remove(name);
    }
    fields
}

/// 执行结果统一序列化；失败归入 internal（不透出内部细节）。
fn serialize_result<T: serde::Serialize>(value: T) -> Result<Value, ManagerError> {
    serde_json::to_value(value)
        .map_err(|_| ManagerError::internal("tool result serialization failed"))
}

/// 测试专用长任务桩：验证超时与断连取消的可观察信号（STARTED 置位后
/// 长眠，被取消时经 Drop guard 置位 CANCELLED）。
#[cfg(test)]
const TEST_SLOW_TOOL: ToolDescriptor = ToolDescriptor {
    name: "test_slow_tool",
    description: "test-only long task stub",
    route: ("GET", "/api/flow/runs"),
    tier: ToolTier::Read,
    params: &[],
};

#[cfg(test)]
pub(crate) mod slow_tool_stub {
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        time::Duration,
    };

    use serde_json::{Value, json};

    /// 桩已开始执行（测试等待该信号后再断开连接）。
    pub static STARTED: AtomicBool = AtomicBool::new(false);
    /// 桩被取消：执行 future 被丢弃（断连或超时）的可观察信号。
    pub static CANCELLED: AtomicBool = AtomicBool::new(false);

    pub fn reset() {
        STARTED.store(false, Ordering::SeqCst);
        CANCELLED.store(false, Ordering::SeqCst);
    }

    pub fn started() -> bool {
        STARTED.load(Ordering::SeqCst)
    }

    pub fn cancelled() -> bool {
        CANCELLED.load(Ordering::SeqCst)
    }

    struct CancelGuard;

    impl Drop for CancelGuard {
        fn drop(&mut self) {
            CANCELLED.store(true, Ordering::SeqCst);
        }
    }

    pub async fn run() -> Value {
        STARTED.store(true, Ordering::SeqCst);
        let _guard = CancelGuard;
        tokio::time::sleep(Duration::from_secs(120)).await;
        json!({ "slept": true })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::ScriptRequest;
    use crate::manager::MitmManager;
    use async_trait::async_trait;
    use proxy_crab_mitm::ProxyCrab;
    use proxy_crab_mitm::flow::model::{
        ManualRequest, NodeConfig, Position, RequestOverride, WorkflowEdge, WorkflowNode,
        WorkflowNodeType,
    };
    use proxy_crab_mitm::log_buffer::LogBuffer;
    use proxy_crab_mitm::model::{HeaderValues, NewSession, RequestData};
    use proxy_crab_mitm::storage::CaptureStore;
    use tempfile::tempdir;

    struct AllowTools;

    #[async_trait]
    impl PermissionManager for AllowTools {
        async fn check_permission(&self, _: PermissionAction) -> Option<PermissionDenied> {
            None
        }
    }

    struct DenyTools;

    #[async_trait]
    impl PermissionManager for DenyTools {
        async fn check_permission(&self, _: PermissionAction) -> Option<PermissionDenied> {
            Some(PermissionDenied::forbidden("test_denied", "denied by test"))
        }
    }

    /// 模拟带脱敏绑定的调用者身份（与 http.rs 的 BoundReads 同构）。
    struct BoundRedaction;

    #[async_trait]
    impl PermissionManager for BoundRedaction {
        async fn check_permission(&self, _: PermissionAction) -> Option<PermissionDenied> {
            None
        }
        async fn redaction_script(
            &self,
            _: &ManagementCredential,
        ) -> Result<Option<String>, PermissionDenied> {
            Ok(Some("mask".into()))
        }
    }

    fn test_context(
        manager: Arc<dyn ProxyCrabManager>,
        permits: Arc<Semaphore>,
    ) -> ToolCallContext {
        test_context_with_tiers(manager, McpTiers::default(), permits)
    }

    fn test_context_with_tiers(
        manager: Arc<dyn ProxyCrabManager>,
        tiers: McpTiers,
        permits: Arc<Semaphore>,
    ) -> ToolCallContext {
        ToolCallContext {
            manager,
            permissions: Arc::new(AllowTools),
            credential: ManagementCredential::LocalLoopback,
            tiers,
            permits,
        }
    }

    fn slow_tool_request(id: usize) -> RpcRequest {
        RpcRequest {
            id: json!(id),
            method: "tools/call".into(),
            params: json!({ "name": "test_slow_tool", "arguments": {} }),
        }
    }

    #[test]
    fn registry_routes_are_registered_in_the_permission_catalog() {
        for tool in list() {
            assert!(
                find_api_action(tool.route.0, tool.route.1).is_some(),
                "{} maps to an unregistered route",
                tool.name
            );
        }
    }

    #[test]
    fn tools_list_envelope_declares_the_curated_surface() {
        let envelope = list_envelope(&McpTiers::default());
        let tools = envelope["tools"].as_array().unwrap();
        // 缺省档只放行 Read 类：注册表 35 个工具中的 17 个读类在列（新增的
        // workflow_render_preview 是 Execute 档，读类数量不变）。
        assert_eq!(tools.len(), 17);
        let runs_list = tools
            .iter()
            .find(|tool| tool["name"] == "workflow_runs_list")
            .unwrap();
        assert_eq!(runs_list["inputSchema"]["type"], "object");
        assert_eq!(
            runs_list["inputSchema"]["properties"]["limit"]["type"],
            "integer"
        );
        // 抽查 log_body：side 参数在 inputSchema 中声明且写明合法取值。
        let log_body = tools
            .iter()
            .find(|tool| tool["name"] == "log_body")
            .unwrap();
        assert_eq!(
            log_body["inputSchema"]["properties"]["side"]["type"],
            "string"
        );
        assert!(
            log_body["inputSchema"]["properties"]["side"]["description"]
                .as_str()
                .unwrap()
                .contains("request or response")
        );
        // 写/执行类工具缺省不出现在清单里（更严者生效）。
        assert!(
            tools
                .iter()
                .all(|tool| tool["name"] != "workflow_run_trigger"
                    && tool["name"] != "workflow_save")
        );
    }

    #[test]
    fn tier_gate_matrix_matches_the_three_switches() {
        let all_on = McpTiers {
            read: true,
            write: true,
            execute: true,
        };
        let all_off = McpTiers {
            read: false,
            write: false,
            execute: false,
        };
        // 缺省：读开 / 写关 / 执行关；全开全放行；全关全拒绝。
        for (tier, default_allowed) in [
            (ToolTier::Read, true),
            (ToolTier::Write, false),
            (ToolTier::Execute, false),
        ] {
            assert_eq!(
                tier.enabled(&McpTiers::default()),
                default_allowed,
                "{tier:?} default"
            );
            assert!(tier.enabled(&all_on), "{tier:?} must pass when all on");
            assert!(!tier.enabled(&all_off), "{tier:?} must fail when all off");
        }
    }

    #[test]
    fn tools_list_omits_tools_of_closed_tiers() {
        // 缺省档（新工作区）：注册表中的读类工具在列。
        assert_eq!(
            list_envelope(&McpTiers::default())["tools"]
                .as_array()
                .unwrap()
                .len(),
            17
        );
        // 读档关闭：tools/list 不再出现该类别工具。
        let read_off = McpTiers {
            read: false,
            ..McpTiers::default()
        };
        assert_eq!(
            list_envelope(&read_off)["tools"].as_array().unwrap().len(),
            0
        );
        // 三档全开：完整策展清单（35 个）在列，并抽查 execute 档的
        // workflow_run_trigger 及其入参 schema。
        let all_on = McpTiers {
            read: true,
            write: true,
            execute: true,
        };
        let envelope = list_envelope(&all_on);
        let tools = envelope["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 35);
        let trigger = tools
            .iter()
            .find(|tool| tool["name"] == "workflow_run_trigger")
            .unwrap();
        assert_eq!(
            trigger["inputSchema"]["properties"]["workflowId"]["type"],
            "string"
        );
        assert_eq!(
            trigger["inputSchema"]["properties"]["startNodeId"]["type"],
            "string"
        );
        // 抽查 read 档的 workflow_run_wait：等待上限有界（30s 硬超时内）。
        let wait = tools
            .iter()
            .find(|tool| tool["name"] == "workflow_run_wait")
            .unwrap();
        assert_eq!(wait["inputSchema"]["properties"]["id"]["type"], "string");
        assert!(
            wait["inputSchema"]["properties"]["timeoutMs"]["description"]
                .as_str()
                .unwrap()
                .contains("55000")
        );
        // 仅开写档：13 个 Write 类工具在列。
        let write_only = McpTiers {
            read: false,
            write: true,
            execute: false,
        };
        assert_eq!(
            list_envelope(&write_only)["tools"]
                .as_array()
                .unwrap()
                .len(),
            13
        );
    }

    #[tokio::test]
    async fn call_hard_rejects_tools_of_closed_tiers() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        // 读档关闭：即使逐次鉴权全放行（AllowTools），tools/call 直呼工具
        // 名也硬拒——档位门控独立于权限目录，先于执行段生效。
        let context = test_context_with_tiers(
            MitmManager::new(runtime),
            McpTiers {
                read: false,
                write: true,
                execute: true,
            },
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );
        let request = RpcRequest {
            id: json!(7),
            method: "tools/call".into(),
            params: json!({ "name": "workflow_runs_list", "arguments": {} }),
        };
        let response = call(&request, &context, TOOL_CALL_TIMEOUT).await;
        assert_eq!(response["result"]["isError"], true);
        assert!(response.get("error").is_none());
        assert!(
            response["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("该工具类别的 MCP 档位已关闭")
        );
    }

    #[test]
    fn internal_error_reasons_never_leak_paths_or_credentials() {
        let error = ManagerError::new(
            ErrorCode::InternalError,
            "open sqlite D:\\secret\\runs.db failed; credential Bearer pcrab_topsecret",
        );
        let reason = manager_error_reason(&error);
        assert!(!reason.contains("D:\\"));
        assert!(!reason.contains("pcrab_topsecret"));
        assert!(reason.contains("internal_error"));
        // 入参校验文案（manager 侧策展）保持可读。
        assert_eq!(
            manager_error_reason(&ManagerError::bad_request(
                "limit must be between 1 and 200"
            )),
            "invalid arguments: limit must be between 1 and 200"
        );
        // 业务校验类（白名单码）连同策展 message 透出，供调用方自纠。
        let reason = manager_error_reason(&ManagerError::new(
            ErrorCode::WorkflowGraphInvalid,
            "工作流图校验未通过：存在 2 个开始节点（多入口流程），需指定入口 startNodeId：s1、s2",
        ));
        assert!(
            reason.contains("execution failed (workflow_graph_invalid)")
                && reason.contains("需指定入口 startNodeId"),
            "{reason}"
        );
        assert_eq!(
            manager_error_reason(&ManagerError::not_found("workflow run run-1 not found")),
            "execution failed (not_found): workflow run run-1 not found"
        );
        assert_eq!(
            manager_error_reason(&ManagerError::conflict("no active session")),
            "execution failed (conflict): no active session"
        );
        // 非白名单类别（如 body_read_failed）仍只暴露稳定错误码。
        let reason = manager_error_reason(&ManagerError::new(
            ErrorCode::BodyReadFailed,
            "read D:\\secret\\body.bin failed",
        ));
        assert_eq!(reason, "execution failed (body_read_failed)");
    }

    #[test]
    fn page_bounds_inject_safe_default_and_reject_out_of_range() {
        // 未声明界限的工具原样放行（含已有 manager 侧校验的 workflow_runs_list）。
        let raw = json!({ "limit": 999, "offset": -1 });
        assert_eq!(
            enforce_page_bounds("workflow_runs_list", &raw).unwrap(),
            raw
        );
        // 不带 limit（含显式 null）时注入安全缺省值，避免一次拉爆全量。
        assert_eq!(
            enforce_page_bounds("workflows_list", &json!({})).unwrap(),
            json!({ "limit": 50 })
        );
        assert_eq!(
            enforce_page_bounds("workflows_list", &json!({ "limit": null, "offset": 10 })).unwrap(),
            json!({ "limit": 50, "offset": 10 })
        );
        // 越界拒绝：limit=0/超上限/负 limit/负 offset，文案说明合法范围。
        for arguments in [
            json!({ "limit": 0 }),
            json!({ "limit": 201 }),
            json!({ "limit": -1 }),
            json!({ "limit": 50, "offset": -1 }),
        ] {
            let error = enforce_page_bounds("workflows_list", &arguments).unwrap_err();
            assert_eq!(error.code, ErrorCode::BadRequest);
            assert!(
                error.message.contains("1 and 200") || error.message.contains("non-negative"),
                "{}",
                error.message
            );
        }
    }

    #[tokio::test]
    async fn call_rejects_out_of_bounds_pagination_with_the_legal_range() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let context = test_context(
            MitmManager::new(runtime),
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );
        // 工具层界限（workflows_list）：越界在执行前即拒，文案带合法范围。
        for (arguments, reason) in [
            (json!({ "limit": 0 }), "limit must be between 1 and 200"),
            (json!({ "limit": 201 }), "limit must be between 1 and 200"),
            (
                json!({ "offset": -1 }),
                "offset must be a non-negative integer",
            ),
        ] {
            let request = RpcRequest {
                id: json!(1),
                method: "tools/call".into(),
                params: json!({ "name": "workflows_list", "arguments": arguments }),
            };
            let response = call(&request, &context, TOOL_CALL_TIMEOUT).await;
            assert_eq!(response["result"]["isError"], true, "{reason}");
            assert!(response.get("error").is_none());
            assert!(
                response["result"]["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains(reason)
            );
        }
    }

    /// 构造一个带会话与三条抓包的运行时（/first /second /third，均无响应侧）。
    fn runtime_with_three_captures(
        app_data: &tempfile::TempDir,
    ) -> (std::sync::Arc<proxy_crab_mitm::ProxyCrab>, u64) {
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let store = CaptureStore::open(session.id, runtime.workspace().root()).unwrap();
        for path in ["first", "second", "third"] {
            store
                .begin(
                    "127.0.0.1",
                    &RequestData {
                        method: "GET".into(),
                        uri: format!("http://example.com/{path}"),
                        version: "HTTP/1.1".into(),
                        headers: HeaderValues::new(),
                        tags: Default::default(),
                    },
                    "request",
                )
                .unwrap();
        }
        (runtime, session.id)
    }

    #[tokio::test]
    async fn log_search_tool_returns_summaries_and_echoes_the_session() {
        let app_data = tempdir().unwrap();
        let (runtime, session_id) = runtime_with_three_captures(&app_data);
        let context = test_context(
            MitmManager::new(runtime),
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );
        let request = RpcRequest {
            id: json!(1),
            method: "tools/call".into(),
            params: json!({
                "name": "log_search",
                "arguments": { "session_id": session_id, "path": "/second" },
            }),
        };
        let response = call(&request, &context, TOOL_CALL_TIMEOUT).await;
        assert_eq!(response["result"]["isError"], json!(null));
        let payload: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(payload["session_id"], json!(session_id));
        assert_eq!(payload["matches"].as_array().unwrap().len(), 1);
        assert_eq!(payload["matches"][0]["method"], "GET");
        assert_eq!(payload["matches"][0]["uri"], "http://example.com/second");
        // begin() 只建请求侧：在途 capture 的 code 为 "..."。
        assert_eq!(payload["matches"][0]["code"], "...");
        assert_eq!(payload["matches"][0]["in_progress"], json!(true));
    }

    /// 测试助手：直接发起一次 tools/call。
    async fn call_tool(context: &ToolCallContext, id: i64, name: &str, arguments: Value) -> Value {
        let request = RpcRequest {
            id: json!(id),
            method: "tools/call".into(),
            params: json!({ "name": name, "arguments": arguments }),
        };
        call(&request, context, TOOL_CALL_TIMEOUT).await
    }

    #[tokio::test]
    async fn env_sets_tools_manage_the_masked_lifecycle() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let context = test_context_with_tiers(
            MitmManager::new(runtime),
            McpTiers {
                read: true,
                write: true,
                execute: false,
            },
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );

        // 创建：含 secret 表。
        let response = call_tool(
            &context,
            1,
            "env_sets_create",
            json!({
                "name": "staging",
                "values": { "baseUrl": "https://staging.example.com" },
                "secretValues": { "token": "s3cret" },
            }),
        )
        .await;
        assert_eq!(response["result"]["isError"], json!(null));
        let created: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        let set_id = created["id"].as_str().unwrap().to_owned();
        // 读回脱敏：secret 一律 "******"。
        assert_eq!(created["secretValues"]["token"], json!("******"));

        // 清单：回显激活偏好与脱敏集。
        let response = call_tool(&context, 2, "env_sets_list", json!({})).await;
        let listed: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(listed["active_set_id"], json!(null));
        assert_eq!(listed["sets"][0]["secretValues"]["token"], json!("******"));

        // 激活：回显激活集 id。
        let response =
            call_tool(&context, 3, "env_sets_activate", json!({ "setId": set_id })).await;
        let activated: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(activated["active_set_id"], json!(set_id));

        // 保存：与 HTTP PUT 同契约的 masked 回写——"******" 恢复存量明文、
        // 显式新值新增/覆盖；响应恒掩码。
        let response = call_tool(
            &context,
            4,
            "env_sets_save",
            json!({
                "id": set_id,
                "name": "staging",
                "values": { "baseUrl": "https://staging2.example.com" },
                "secretValues": { "token": "******", "apiKey": "n3w-pass-1234" },
            }),
        )
        .await;
        assert_eq!(response["result"]["isError"], json!(null));
        let saved: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(saved["secretValues"]["token"], json!("******"));
        assert_eq!(saved["secretValues"]["apiKey"], json!("******"));
        let response = call_tool(
            &context,
            5,
            "env_sets_save",
            json!({
                "id": set_id,
                "name": "staging",
                "values": { "baseUrl": "https://staging2.example.com" },
            }),
        )
        .await;
        assert_eq!(response["result"]["isError"], json!(null));
        let response = call_tool(&context, 6, "env_sets_list", json!({})).await;
        let listed: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(
            listed["sets"][0]["values"]["baseUrl"],
            json!("https://staging2.example.com")
        );
        // masked 回写不丢存量 secret（token 恢复），新增键掩码落库。
        assert_eq!(listed["sets"][0]["secretValues"]["token"], json!("******"));
        assert_eq!(listed["sets"][0]["secretValues"]["apiKey"], json!("******"));
        // 缺键删除：只回传 apiKey 的掩码 → token 键被移除。
        let response = call_tool(
            &context,
            7,
            "env_sets_save",
            json!({
                "id": set_id,
                "name": "staging",
                "values": { "baseUrl": "https://staging2.example.com" },
                "secretValues": { "apiKey": "******" },
            }),
        )
        .await;
        assert_eq!(response["result"]["isError"], json!(null));
        let response = call_tool(&context, 8, "env_sets_list", json!({})).await;
        let listed: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert!(listed["sets"][0]["secretValues"].get("token").is_none());
        assert_eq!(listed["sets"][0]["secretValues"]["apiKey"], json!("******"));

        // 删除：确认删除标记。
        let response = call_tool(&context, 9, "env_sets_delete", json!({ "id": set_id })).await;
        let deleted: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(deleted["deleted"], json!(true));
        let response = call_tool(&context, 10, "env_sets_list", json!({})).await;
        let listed: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(listed["sets"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn replay_once_tool_rejects_ambiguous_and_missing_sources() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        // 重放要落到会话：先建会话并设为 active（工具缺省走 active）。
        let session = manager
            .create_session(crate::dto::CreateSessionRequest {
                name: None,
                description: None,
                view: None,
                interceptors: None,
            })
            .await
            .unwrap();
        manager
            .replace_active_session(crate::dto::ActiveSession {
                session_id: Some(session.id),
            })
            .await
            .unwrap();
        let context = test_context_with_tiers(
            manager,
            McpTiers {
                read: true,
                write: true,
                execute: true,
            },
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );

        // library_id 与 method/url 互斥。
        let response = call_tool(
            &context,
            1,
            "replay_once",
            json!({
                "library_id": "req-1",
                "method": "GET",
                "url": "https://example.com/",
            }),
        )
        .await;
        assert_eq!(response["result"]["isError"], json!(true));
        assert!(
            response["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("cannot be combined")
        );

        // 无 library_id 时必须给出 method+url。
        let response = call_tool(
            &context,
            2,
            "replay_once",
            json!({ "url": "https://example.com/" }),
        )
        .await;
        assert_eq!(response["result"]["isError"], json!(true));
        assert!(
            response["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("method and url are required")
        );

        // library_id 指向不存在的条目 → not_found。
        let response = call_tool(
            &context,
            3,
            "replay_once",
            json!({ "library_id": "req-ghost" }),
        )
        .await;
        assert_eq!(response["result"]["isError"], json!(true));
        // not_found 属白名单码：稳定码之外策展 message（含目标 id）也透出。
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("execution failed (not_found)"), "{text}");
        assert!(text.contains("req-ghost"), "{text}");
    }

    #[tokio::test]
    async fn workflow_validate_deep_tool_reports_deep_issues() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let context = test_context(
            MitmManager::new(runtime),
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );
        let request = RpcRequest {
            id: json!(1),
            method: "tools/call".into(),
            params: json!({
                "name": "workflow_validate_deep",
                "arguments": {
                    "nodes": [
                        { "id": "s", "type": "start", "position": { "x": 0.0, "y": 0.0 }, "config": {} },
                        {
                            "id": "r",
                            "type": "httpReplay",
                            "position": { "x": 100.0, "y": 0.0 },
                            "config": {
                                "requestId": "req-ghost",
                                "override": { "url": "https://example.com/{{ env.baseUrl }}" }
                            }
                        },
                    ],
                    "edges": [
                        { "id": "e1", "source": "s", "target": "r" }
                    ],
                },
            }),
        };
        let response = call(&request, &context, TOOL_CALL_TIMEOUT).await;
        assert_eq!(response["result"]["isError"], json!(null));
        let payload: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        let issues = payload.as_array().unwrap();
        let codes: Vec<&str> = issues
            .iter()
            .map(|issue| issue["code"].as_str().unwrap())
            .collect();
        assert!(codes.contains(&"request-id-missing"), "{codes:?}");
        assert!(codes.contains(&"env-key-unknown"), "{codes:?}");
        // 结构检查（缺开始节点的校验不触发——图里有 start）下 error 级
        // request-id-missing 带 severity 字段。
        let missing = issues
            .iter()
            .find(|issue| issue["code"] == "request-id-missing")
            .unwrap();
        assert_eq!(missing["severity"], "error");
        assert_eq!(missing["nodeIds"], json!(["r"]));

        // id 模式与草稿模式互斥。
        let request = RpcRequest {
            id: json!(2),
            method: "tools/call".into(),
            params: json!({
                "name": "workflow_validate_deep",
                "arguments": {
                    "id": "wf-1",
                    "nodes": [{ "id": "s", "type": "start", "position": { "x": 0.0, "y": 0.0 }, "config": {} }],
                    "edges": [],
                },
            }),
        };
        let response = call(&request, &context, TOOL_CALL_TIMEOUT).await;
        assert_eq!(response["result"]["isError"], json!(true));
        assert!(
            response["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("not both")
        );
    }

    /// 请求面预览工具：渲染结果对齐「将要发出」口径（manualRequest 基线 +
    /// override 模板渲染 + variableOverrides 最高优先级 + timeoutMs 兜底），
    /// 未解析引用渲染为空串并进警告；非 httpReplay 节点按 422 分类错误返回。
    #[tokio::test(flavor = "multi_thread")]
    async fn workflow_render_preview_renders_request_and_reports_unresolved() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager: Arc<dyn ProxyCrabManager> = MitmManager::new(runtime);
        let workflow_id = create_run_workflow(
            &*manager,
            "preview",
            vec![
                run_node("s", WorkflowNodeType::Start, NodeConfig::default()),
                run_node(
                    "r",
                    WorkflowNodeType::HttpReplay,
                    NodeConfig {
                        manual_request: Some(ManualRequest {
                            method: "POST".into(),
                            url: "https://api.example.com/base".into(),
                            headers: None,
                            body: None,
                        }),
                        override_: Some(RequestOverride {
                            url: Some(
                                "{{ env.baseUrl }}/orders?tag={{ var.runTag }}&plate={{ fake.plate }}"
                                    .into(),
                            ),
                            ..RequestOverride::default()
                        }),
                        timeout_ms: Some(9000),
                        ..NodeConfig::default()
                    },
                ),
            ],
            vec![run_edge("e1", "s", "r")],
        )
        .await;

        let context = test_context_with_tiers(
            manager,
            McpTiers {
                execute: true,
                ..McpTiers::default()
            },
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );
        let request = RpcRequest {
            id: json!(1),
            method: "tools/call".into(),
            params: json!({
                "name": "workflow_render_preview",
                "arguments": {
                    "workflowId": workflow_id,
                    "nodeId": "r",
                    "variableOverrides": { "runTag": "rt-1" },
                },
            }),
        };
        let response = call(&request, &context, TOOL_CALL_TIMEOUT).await;
        assert_eq!(response["result"]["isError"], json!(null));
        let payload: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(payload["ok"], json!(true), "{payload:?}");
        assert_eq!(payload["baseline"], json!("manual"));
        // env.baseUrl 缺省空环境 → 渲染为空串（url 无 origin）；var.runTag 走
        // variableOverrides；fake.plate 按真实口径采样非空。
        let url = payload["request"]["url"].as_str().unwrap();
        assert!(url.starts_with("/orders?tag=rt-1&plate="), "{url}");
        assert_eq!(payload["request"]["method"], json!("POST"));
        assert_eq!(payload["request"]["timeoutMs"], json!(9000));
        assert!(payload["request"]["headers"].is_object());
        assert!(
            payload["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|warning| warning.as_str().unwrap_or_default().contains("baseUrl"))
        );

        // 非 httpReplay 节点：装配侧 422 分类错误（文案点名节点类型）。
        let request = RpcRequest {
            id: json!(2),
            method: "tools/call".into(),
            params: json!({
                "name": "workflow_render_preview",
                "arguments": { "workflowId": workflow_id, "nodeId": "s" },
            }),
        };
        let response = call(&request, &context, TOOL_CALL_TIMEOUT).await;
        assert_eq!(response["result"]["isError"], json!(true));
        assert!(
            response["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("httpReplay")
        );
    }

    fn delay_config(ms: u64) -> NodeConfig {
        NodeConfig {
            duration_ms: Some(ms),
            ..NodeConfig::default()
        }
    }

    fn run_node(id: &str, node_type: WorkflowNodeType, config: NodeConfig) -> WorkflowNode {
        WorkflowNode {
            id: id.to_owned(),
            node_type,
            position: Position { x: 0.0, y: 0.0 },
            config,
            label: None,
            ref_id: None,
        }
    }

    fn run_edge(id: &str, source: &str, target: &str) -> WorkflowEdge {
        WorkflowEdge {
            id: id.to_owned(),
            source: source.to_owned(),
            target: target.to_owned(),
            source_handle: None,
        }
    }

    /// 直存一个流程图（绕过工具层校验面，多开始节点图存储允许）。
    async fn create_run_workflow(
        manager: &dyn ProxyCrabManager,
        name: &str,
        nodes: Vec<WorkflowNode>,
        edges: Vec<WorkflowEdge>,
    ) -> String {
        manager
            .create_workflow(crate::dto::WorkflowCreateRequest {
                project_id: "proj".into(),
                name: name.into(),
                description: String::new(),
                nodes,
                edges,
                variables: Default::default(),
                secret_variables: Default::default(),
            })
            .await
            .unwrap()
            .id
    }

    /// 触发/等待工具的自纠信息面：白名单错误码透出服务端策展文案；
    /// wait 轮询到终态只回紧凑摘要（无 graphSnapshot / 节点载荷）。
    #[tokio::test(flavor = "multi_thread")]
    async fn workflow_run_trigger_surfaces_messages_and_wait_returns_digest() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        // 触发缺省走 active Session（replay 用例同款前置）。
        let session = manager
            .create_session(crate::dto::CreateSessionRequest {
                name: None,
                description: None,
                view: None,
                interceptors: None,
            })
            .await
            .unwrap();
        manager
            .replace_active_session(crate::dto::ActiveSession {
                session_id: Some(session.id),
            })
            .await
            .unwrap();
        let context = test_context_with_tiers(
            manager,
            McpTiers {
                read: true,
                write: true,
                execute: true,
            },
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );

        // 多开始节点工作流（存储允许），缺 startNodeId 触发：isError 文本
        // 透出服务端策展文案与全部候选入口，不再只有稳定错误码。
        let workflow_id = create_run_workflow(
            context.manager.as_ref(),
            "multi-start",
            vec![
                run_node("s1", WorkflowNodeType::Start, NodeConfig::default()),
                run_node("s2", WorkflowNodeType::Start, NodeConfig::default()),
                run_node("d1", WorkflowNodeType::Delay, delay_config(50)),
                run_node("d2", WorkflowNodeType::Delay, delay_config(50)),
            ],
            vec![run_edge("e1", "s1", "d1"), run_edge("e2", "s2", "d2")],
        )
        .await;
        let response = call_tool(
            &context,
            1,
            "workflow_run_trigger",
            json!({ "workflowId": workflow_id }),
        )
        .await;
        assert_eq!(response["result"]["isError"], json!(true));
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("execution failed (workflow_graph_invalid)")
                && text.contains("需指定入口 startNodeId")
                && text.contains("s1")
                && text.contains("s2"),
            "{text}"
        );

        // wait 参数界内校验：bad_request 文案带合法范围。
        for (arguments, expected) in [
            (
                json!({ "id": "run-ghost", "timeoutMs": 0 }),
                "timeoutMs must be between 1 and 55000",
            ),
            (
                json!({ "id": "run-ghost", "timeoutMs": 55001 }),
                "timeoutMs must be between 1 and 55000",
            ),
            (
                json!({ "id": "run-ghost", "intervalMs": 10 }),
                "intervalMs must be between 50 and 60000",
            ),
        ] {
            let response = call_tool(&context, 2, "workflow_run_wait", arguments).await;
            assert_eq!(response["result"]["isError"], json!(true));
            assert!(
                response["result"]["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains(expected)
            );
        }

        // not_found：白名单码，稳定码之外 message（含目标 id）也透出。
        let response = call_tool(
            &context,
            3,
            "workflow_run_wait",
            json!({ "id": "run-ghost" }),
        )
        .await;
        assert_eq!(response["result"]["isError"], json!(true));
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("execution failed (not_found)") && text.contains("run-ghost"),
            "{text}"
        );

        // 可运行工作流（start → delay）：wait 轮询到终态，只回紧凑摘要。
        let workflow_id = create_run_workflow(
            context.manager.as_ref(),
            "quick-run",
            vec![
                run_node("s", WorkflowNodeType::Start, NodeConfig::default()),
                run_node("d", WorkflowNodeType::Delay, delay_config(120)),
            ],
            vec![run_edge("e1", "s", "d")],
        )
        .await;
        let response = call_tool(
            &context,
            4,
            "workflow_run_trigger",
            json!({ "workflowId": workflow_id }),
        )
        .await;
        let run: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        let run_id = run["id"].as_str().unwrap().to_owned();
        // 默认瘦身：响应不含 graphSnapshot（大图可达数十 KB，需要时经 detail 再取）。
        assert!(run.get("graphSnapshot").is_none(), "{run}");
        // includeGraph:true 时快照随响应返回。
        let response = call_tool(
            &context,
            8,
            "workflow_run_trigger",
            json!({ "workflowId": workflow_id, "includeGraph": true }),
        )
        .await;
        let run: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert!(
            run.get("graphSnapshot")
                .is_some_and(|snapshot| snapshot.is_object()),
            "{run}"
        );
        let response = call_tool(
            &context,
            5,
            "workflow_run_wait",
            json!({ "id": run_id, "intervalMs": 50 }),
        )
        .await;
        assert_eq!(response["result"]["isError"], json!(null));
        let digest: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(digest["id"], json!(run_id));
        assert_eq!(digest["status"], json!("success"));
        assert_eq!(digest["settled"], json!(true));
        // 摘要形状：无 graphSnapshot / nodeRuns，节点 digest 无载荷字段。
        assert!(digest.get("graphSnapshot").is_none());
        assert!(digest.get("nodeRuns").is_none());
        let nodes = digest["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 2);
        let mut node_ids: Vec<&str> = nodes
            .iter()
            .map(|node| node["nodeId"].as_str().unwrap())
            .collect();
        node_ids.sort_unstable();
        assert_eq!(node_ids, ["d", "s"]);
        assert!(
            nodes
                .iter()
                .all(|node| node.get("input").is_none() && node.get("output").is_none())
        );

        // 慢节点 + 小等待上限：settled=false（附当前进度），调用方可再等。
        let workflow_id = create_run_workflow(
            context.manager.as_ref(),
            "slow-run",
            vec![
                run_node("s", WorkflowNodeType::Start, NodeConfig::default()),
                run_node("d", WorkflowNodeType::Delay, delay_config(2000)),
            ],
            vec![run_edge("e1", "s", "d")],
        )
        .await;
        let response = call_tool(
            &context,
            6,
            "workflow_run_trigger",
            json!({ "workflowId": workflow_id }),
        )
        .await;
        let run: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        let response = call_tool(
            &context,
            7,
            "workflow_run_wait",
            json!({ "id": run["id"], "timeoutMs": 100, "intervalMs": 50 }),
        )
        .await;
        assert_eq!(response["result"]["isError"], json!(null));
        let digest: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(digest["settled"], json!(false));
        assert_eq!(digest["status"], json!("running"));
    }

    /// `workflow_patch`：增量手术（加节点/合并改写/重接线）落盘为紧凑摘要；
    /// id 冲突、未知字段、空补丁与结构失效整体拒绝。
    #[tokio::test]
    async fn workflow_patch_applies_incremental_operations() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let context = test_context_with_tiers(
            MitmManager::new(runtime),
            McpTiers {
                read: true,
                write: true,
                execute: false,
            },
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );
        // 存量图：s → d1 → d2（e1、e2）。
        let workflow_id = create_run_workflow(
            context.manager.as_ref(),
            "patched",
            vec![
                run_node("s", WorkflowNodeType::Start, NodeConfig::default()),
                run_node("d1", WorkflowNodeType::Delay, delay_config(120)),
                run_node("d2", WorkflowNodeType::Delay, delay_config(120)),
            ],
            vec![run_edge("e1", "s", "d1"), run_edge("e2", "d1", "d2")],
        )
        .await;

        // 空补丁与未知字段：bad_request 文案。
        for (arguments, expected) in [
            (json!({ "id": workflow_id }), "requires at least one"),
            (
                json!({ "id": workflow_id, "updateNodes": [{ "id": "d1", "overide": {} }] }),
                "unknown field",
            ),
        ] {
            let response = call_tool(&context, 1, "workflow_patch", arguments).await;
            assert_eq!(response["result"]["isError"], json!(true));
            assert!(
                response["result"]["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains(expected)
            );
        }

        // id 冲突：add 已存在节点 / update 缺失节点 / addEdge 引用缺失节点。
        for (arguments, expected) in [
            (
                json!({
                    "id": workflow_id,
                    "addNodes": [{ "id": "d1", "type": "delay", "position": {"x": 1.0, "y": 1.0}, "config": {"durationMs": 5} }],
                }),
                "adds an existing node id",
            ),
            (
                json!({ "id": workflow_id, "updateNodes": [{ "id": "ghost", "label": "x" }] }),
                "updates a missing node id",
            ),
            (
                json!({
                    "id": workflow_id,
                    "addEdges": [{ "id": "e9", "source": "ghost", "target": "d2" }],
                }),
                "references a missing node id",
            ),
        ] {
            let response = call_tool(&context, 2, "workflow_patch", arguments).await;
            assert_eq!(response["result"]["isError"], json!(true));
            assert!(
                response["result"]["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains(expected)
            );
        }

        // 增量手术：加 1 节点（d3）、config merge-patch 改 d1、重接 e2、加 e3。
        let response = call_tool(
            &context,
            3,
            "workflow_patch",
            json!({
                "id": workflow_id,
                "addNodes": [
                    { "id": "d3", "type": "delay", "position": {"x": 30.0, "y": 0.0}, "config": {"durationMs": 30} },
                ],
                "updateNodes": [
                    { "id": "d1", "label": "renamed", "config": { "durationMs": 250 } },
                ],
                "updateEdges": [{ "id": "e2", "target": "d3" }],
                "addEdges": [{ "id": "e3", "source": "d3", "target": "d2" }],
            }),
        )
        .await;
        assert_eq!(response["result"]["isError"], json!(null));
        let summary: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(summary["nodeCount"], json!(4));
        assert_eq!(summary["edgeCount"], json!(3));
        assert_eq!(summary["addedNodeIds"], json!(["d3"]));
        assert_eq!(summary["updatedNodeIds"], json!(["d1"]));
        assert_eq!(summary["addedEdgeIds"], json!(["e3"]));
        assert_eq!(summary["updatedEdgeIds"], json!(["e2"]));
        // 落盘校验：merge-patch 只动了 durationMs；重接线与新增边生效。
        let response =
            call_tool(&context, 4, "workflow_detail", json!({ "id": workflow_id })).await;
        let detail: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        let d1 = detail["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "d1")
            .unwrap();
        assert_eq!(d1["config"]["durationMs"], json!(250));
        assert_eq!(d1["label"], json!("renamed"));
        let e2 = detail["edges"]
            .as_array()
            .unwrap()
            .iter()
            .find(|edge| edge["id"] == "e2")
            .unwrap();
        assert_eq!(e2["target"], json!("d3"));

        // removeNodes 级联删除关联边：摘掉 d3 时 e2/e3 一并消失，图回到
        // s → d1 → d2（结构校验仍通过）。
        let response = call_tool(
            &context,
            5,
            "workflow_patch",
            json!({ "id": workflow_id, "removeNodes": ["d3"] }),
        )
        .await;
        assert_eq!(response["result"]["isError"], json!(null));
        let summary: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(summary["removedNodeIds"], json!(["d3"]));
        let mut removed_edges: Vec<&str> = summary["removedEdgeIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap())
            .collect();
        removed_edges.sort_unstable();
        assert_eq!(removed_edges, ["e2", "e3"]);

        // label: null 清除可选字段；再删掉唯一 start 节点 → 结构校验拒绝
        // （workflow_graph_invalid，缺 start）。
        let response = call_tool(
            &context,
            6,
            "workflow_patch",
            json!({ "id": workflow_id, "updateNodes": [{ "id": "d1", "label": null }] }),
        )
        .await;
        assert_eq!(response["result"]["isError"], json!(null));
        let response = call_tool(
            &context,
            7,
            "workflow_patch",
            json!({ "id": workflow_id, "removeNodes": ["s"] }),
        )
        .await;
        assert_eq!(response["result"]["isError"], json!(true));
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("workflow_graph_invalid") && text.contains("开始"),
            "{text}"
        );
    }

    #[test]
    fn log_detail_truncation_marks_long_bodies_and_keeps_shapes() {
        let mut detail = json!({
            "id": 1,
            "request": {
                "method": "POST",
                "body": { "type": "text", "content": "abcdefghij", "size": 10 }
            },
            "response": {
                "status": 200,
                "body": { "type": "json", "content": { "code": 0 }, "size": 12 }
            }
        });
        truncate_log_detail_bodies(&mut detail, 4);
        // text 正文截断并带标记。
        assert_eq!(
            detail["request"]["body"]["content"],
            json!("abcd…[truncated 10 chars total]")
        );
        // json 对象形态保持原样（结构化正文不降级为字符串）。
        assert_eq!(detail["response"]["body"]["content"], json!({ "code": 0 }));
        // 长度内不截断。
        let mut short = json!({ "request": { "body": { "type": "text", "content": "ab" } } });
        truncate_log_detail_bodies(&mut short, 4);
        assert_eq!(short["request"]["body"]["content"], json!("ab"));
    }

    #[tokio::test]
    async fn call_applies_the_safe_default_and_keeps_manager_validated_bounds() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let context = test_context(
            MitmManager::new(runtime),
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );
        // 不带 limit：工具层注入安全缺省后调用成功（空工作区返回空页）。
        let request = RpcRequest {
            id: json!(2),
            method: "tools/call".into(),
            params: json!({ "name": "workflows_list", "arguments": {} }),
        };
        let response = call(&request, &context, TOOL_CALL_TIMEOUT).await;
        assert!(response.get("error").is_none());
        assert!(response["result"]["isError"].is_null());
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        let payload: Value = serde_json::from_str(text).unwrap();
        assert_eq!(payload["workflows"], json!([]));
        assert_eq!(payload["total"], 0);
        // 边界值 limit=200 仍在合法范围内。
        let request = RpcRequest {
            id: json!(3),
            method: "tools/call".into(),
            params: json!({ "name": "workflows_list", "arguments": { "limit": 200 } }),
        };
        let response = call(&request, &context, TOOL_CALL_TIMEOUT).await;
        assert!(response.get("error").is_none());
        assert!(response["result"]["isError"].is_null());
        // 已有 manager 侧校验的工具抽检（workflow_runs_list）：limit=0 走
        // manager 校验路径同样被拒，文案带 manager 的合法范围（1..=1000）。
        let request = RpcRequest {
            id: json!(4),
            method: "tools/call".into(),
            params: json!({ "name": "workflow_runs_list", "arguments": { "limit": 0 } }),
        };
        let response = call(&request, &context, TOOL_CALL_TIMEOUT).await;
        assert_eq!(response["result"]["isError"], true);
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("limit must be between 1 and 1000"), "{text}");
    }

    #[tokio::test]
    async fn call_rejects_unknown_tools_and_unusable_arguments() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let context = test_context(
            MitmManager::new(runtime),
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );
        // 缺名/空名维持协议层 -32602。
        for params in [json!({}), json!({ "name": "" })] {
            let request = RpcRequest {
                id: json!(1),
                method: "tools/call".into(),
                params,
            };
            assert_eq!(
                call(&request, &context, TOOL_CALL_TIMEOUT).await["error"]["code"],
                protocol::INVALID_PARAMS
            );
        }
        // 未知工具与非对象入参走工具级 isError。
        for (params, reason) in [
            (json!({ "name": "nope", "arguments": {} }), "unknown tool"),
            (
                json!({ "name": "workflow_runs_list", "arguments": "scalar" }),
                "arguments must be an object",
            ),
            (
                json!({ "name": "workflow_runs_list", "arguments": { "limit": "abc" } }),
                "arguments do not match the tool schema",
            ),
        ] {
            let request = RpcRequest {
                id: json!(2),
                method: "tools/call".into(),
                params,
            };
            let response = call(&request, &context, TOOL_CALL_TIMEOUT).await;
            assert_eq!(response["result"]["isError"], true, "{reason}");
            assert!(response.get("error").is_none());
            assert!(
                response["result"]["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains(reason)
            );
        }
    }

    #[tokio::test]
    async fn tool_execution_times_out_and_cancels_the_underlying_work() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let context = test_context(
            MitmManager::new(runtime),
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );
        slow_tool_stub::reset();
        let response = call(&slow_tool_request(3), &context, Duration::from_millis(50)).await;

        assert!(slow_tool_stub::started(), "stub must have started running");
        assert_eq!(response["result"]["isError"], true);
        assert!(
            response["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("timed out")
        );
        // 超时丢弃执行 future：桩的 Drop guard 落地即底层被取消。
        assert!(slow_tool_stub::cancelled());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn in_flight_tool_calls_beyond_the_limit_fail_fast() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let context = test_context(
            MitmManager::new(runtime),
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );
        slow_tool_stub::reset();
        let tasks = (0..MAX_IN_FLIGHT_TOOL_CALLS)
            .map(|id| {
                let context = context.clone();
                tokio::spawn(async move {
                    call(&slow_tool_request(id), &context, TOOL_CALL_TIMEOUT).await
                })
            })
            .collect::<Vec<_>>();
        for _ in 0..500 {
            if context.permits.available_permits() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            context.permits.available_permits(),
            0,
            "in-flight calls must hold every permit"
        );
        // 超限的调用立刻被拒（快速失败，不排队）。
        let overflow = call(&slow_tool_request(99), &context, TOOL_CALL_TIMEOUT).await;
        assert_eq!(overflow["result"]["isError"], true);
        assert!(
            overflow["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("too many concurrent tool calls")
        );
        for task in tasks {
            task.abort();
        }
        for _ in 0..500 {
            if context.permits.available_permits() == MAX_IN_FLIGHT_TOOL_CALLS {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            context.permits.available_permits(),
            MAX_IN_FLIGHT_TOOL_CALLS,
            "permits must be released once in-flight calls end"
        );
    }

    #[tokio::test]
    async fn ok_calls_append_one_audit_entry() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let context = test_context(
            manager.clone(),
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );
        let request = RpcRequest {
            id: json!(5),
            method: "tools/call".into(),
            params: json!({ "name": "workflows_list", "arguments": {} }),
        };
        let response = call(&request, &context, TOOL_CALL_TIMEOUT).await;
        assert!(response.get("error").is_none());
        assert!(response["result"]["isError"].is_null());
        // 执行完成落一条审计：身份 local、判定 allowed、结果 ok。
        let entries = manager.mcp_audit(10).await.unwrap();
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.tool, "workflows_list");
        assert_eq!(entry.identity, "local");
        assert_eq!(entry.decision, "allowed");
        assert_eq!(entry.outcome, "ok");
        assert_eq!(entry.reason, None);
        assert_eq!(entry.arguments_summary, "{}");
        assert!(entry.timestamp_ms > 0);
    }

    #[tokio::test]
    async fn denied_calls_append_one_audit_entry() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let mut context = test_context(
            manager.clone(),
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );
        context.permissions = Arc::new(DenyTools);
        let request = RpcRequest {
            id: json!(6),
            method: "tools/call".into(),
            params: json!({ "name": "sessions_list", "arguments": { "x": "y" } }),
        };
        let response = call(&request, &context, TOOL_CALL_TIMEOUT).await;
        assert_eq!(response["result"]["isError"], true);
        assert!(
            response["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("denied by test")
        );
        // 拒绝也落一条审计：decision/outcome 均为 denied，reason 为拒绝文案。
        let entries = manager.mcp_audit(10).await.unwrap();
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.tool, "sessions_list");
        assert_eq!(entry.identity, "local");
        assert_eq!(entry.decision, "denied");
        assert_eq!(entry.outcome, "denied");
        assert_eq!(
            entry.reason.as_deref(),
            Some("permission denied: denied by test")
        );
        assert_eq!(entry.arguments_summary, r#"{"x":"y"}"#);
    }

    #[tokio::test]
    async fn bound_callers_read_tools_through_the_redaction_path() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let store = CaptureStore::open(session.id, runtime.workspace().root()).unwrap();
        let id = store
            .begin(
                "client",
                &RequestData {
                    method: "GET".into(),
                    uri: "https://example.com/secret".into(),
                    version: "HTTP/1.1".into(),
                    headers: HeaderValues::new(),
                    tags: Default::default(),
                },
                "request",
            )
            .unwrap();
        let manager = MitmManager::new(runtime);
        // context.api 断言为 "mcp"：绑定未走 reader 路径时脚本会失败。
        manager
            .create_redaction_script(ScriptRequest {
                name: "mask".into(),
                content: "assert(context.api == 'mcp'); req.uri = 'https://example.com/masked'"
                    .into(),
            })
            .await
            .unwrap();
        let mut context = test_context(
            manager.clone(),
            Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOL_CALLS)),
        );
        context.permissions = Arc::new(BoundRedaction);
        context.credential = ManagementCredential::Bearer("pcrab_test".into());
        let request = RpcRequest {
            id: json!(7),
            method: "tools/call".into(),
            params: json!({ "name": "log_detail", "arguments": { "id": id, "session_id": session.id } }),
        };
        let response = call(&request, &context, TOOL_CALL_TIMEOUT).await;
        assert!(response.get("error").is_none());
        assert!(response["result"]["isError"].is_null());
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        // 结果经 reader 脱敏路径返回，与 HTTP API 同路。
        assert!(text.contains("masked"), "{text}");
        assert!(!text.contains("secret"), "{text}");
        // Bearer 无分享身份：审计身份记 unresolved，结果仍 ok。
        let entries = manager.mcp_audit(10).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].identity, "unresolved");
        assert_eq!(entries[0].outcome, "ok");
        assert_eq!(entries[0].decision, "allowed");
    }
}
