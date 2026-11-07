use std::net::SocketAddr;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    Allow,
    Approval,
    Deny,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct ApiAction {
    pub id: &'static str,
    pub method: &'static str,
    pub route_template: &'static str,
    pub default_mode: PermissionMode,
}

pub struct PermissionAction {
    pub action: &'static ApiAction,
    pub credential: ManagementCredential,
    pub actual_path: String,
    pub query: Option<String>,
    pub source: Option<SocketAddr>,
    pub content_type: Option<String>,
    pub content_length: Option<u64>,
    pub body_preview: Option<String>,
    pub body_preview_truncated: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub enum ManagementCredential {
    LocalLoopback,
    Bearer(String),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDeniedStatus {
    Unauthorized,
    Forbidden,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PermissionDenied {
    pub status: PermissionDeniedStatus,
    pub code: String,
    pub message: String,
}

impl PermissionDenied {
    pub fn unauthorized(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status: PermissionDeniedStatus::Unauthorized,
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn forbidden(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status: PermissionDeniedStatus::Forbidden,
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn internal(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status: PermissionDeniedStatus::Internal,
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RedactionIdentity {
    pub id: String,
    pub redaction_script: Option<String>,
}

#[async_trait]
pub trait PermissionManager: Send + Sync {
    async fn redaction_script(
        &self,
        _credential: &ManagementCredential,
    ) -> Result<Option<String>, PermissionDenied> {
        Ok(None)
    }
    /// None is a trusted owner/UI caller; API keys must return their stable identity.
    async fn share_identity(
        &self,
        credential: &ManagementCredential,
    ) -> Result<Option<RedactionIdentity>, PermissionDenied> {
        match credential {
            ManagementCredential::LocalLoopback => Ok(None),
            ManagementCredential::Bearer(_) => Err(PermissionDenied::forbidden(
                "share_policy_denied",
                "cannot resolve share caller",
            )),
        }
    }
    async fn identity_redaction(&self, id: &str) -> Result<Option<String>, PermissionDenied> {
        if id == "local" {
            self.redaction_script(&ManagementCredential::LocalLoopback)
                .await
        } else {
            Err(PermissionDenied::forbidden(
                "redaction_failed",
                "redaction identity unavailable",
            ))
        }
    }
    async fn check_permission(&self, action: PermissionAction) -> Option<PermissionDenied>;
}

macro_rules! action {
    ($method:literal, $route:literal, $mode:ident) => {
        ApiAction {
            id: concat!($method, " ", $route),
            method: $method,
            route_template: $route,
            default_mode: PermissionMode::$mode,
        }
    };
}

pub static API_ACTIONS: &[ApiAction] = &[
    action!("GET", "/api/redaction-scripts", Allow),
    action!("POST", "/api/redaction-scripts", Allow),
    action!("GET", "/api/redaction-scripts/{name}", Deny),
    action!("PUT", "/api/redaction-scripts/{name}", Approval),
    action!("DELETE", "/api/redaction-scripts/{name}", Approval),
    action!("GET", "/api/agents.md", Allow),
    action!("GET", "/api/assets", Allow),
    action!("GET", "/api/assets/{*asset_id}", Allow),
    action!("POST", "/api/assets/{*asset_id}", Approval),
    action!("POST", "/api/replay", Allow),
    action!("GET", "/api/config", Allow),
    action!("GET", "/api/proxy/status", Allow),
    action!("POST", "/api/proxy/start", Approval),
    action!("POST", "/api/proxy/stop", Approval),
    action!("GET", "/api/sessions", Allow),
    action!("POST", "/api/sessions", Approval),
    action!("GET", "/api/archived-sessions", Allow),
    action!("POST", "/api/sessions/{id}/archive", Deny),
    action!("POST", "/api/archived-sessions/{id}/restore", Approval),
    action!("DELETE", "/api/archived-sessions/{id}", Deny),
    action!("PUT", "/api/active-session", Approval),
    action!("PUT", "/api/sessions/{id}", Approval),
    action!("PUT", "/api/sessions/{id}/filter", Approval),
    action!("GET", "/api/session-shares", Allow),
    action!("GET", "/api/session-shares/{id}", Allow),
    action!("POST", "/api/session-shares", Approval),
    action!("DELETE", "/api/session-shares/{id}", Approval),
    action!("POST", "/api/logs/ids", Allow),
    // Capture-log search reuses the ids scan path with simple predicates and
    // returns compact summaries: pure read (`allow`), same as the ids query.
    action!("POST", "/api/logs/search", Allow),
    action!("POST", "/api/logs/views", Allow),
    action!("GET", "/api/logs/{id}/body", Allow),
    action!("GET", "/api/logs/{id}/websocket/messages", Allow),
    action!(
        "GET",
        "/api/logs/{id}/websocket/messages/{message_id}/body",
        Allow
    ),
    action!(
        "GET",
        "/api/logs/{id}/interceptors/{execution_id}/content",
        Allow
    ),
    action!(
        "GET",
        "/api/logs/{id}/interceptors/{execution_id}/snapshot",
        Allow
    ),
    action!("GET", "/api/logs/{id}", Allow),
    action!("POST", "/api/imports", Approval),
    action!("POST", "/api/imports/{id}/resolve", Approval),
    action!("GET", "/api/session-view", Allow),
    action!("PUT", "/api/session-view", Approval),
    action!("GET", "/api/session-interceptors", Allow),
    action!("PUT", "/api/session-interceptors", Approval),
    action!("GET", "/api/column-scripts", Allow),
    action!("POST", "/api/column-scripts", Approval),
    action!("GET", "/api/column-scripts/{name}", Allow),
    action!("PUT", "/api/column-scripts/{name}", Approval),
    action!("DELETE", "/api/column-scripts/{name}", Deny),
    action!("GET", "/api/filter-scripts", Allow),
    action!("POST", "/api/filter-scripts", Approval),
    action!("POST", "/api/filter-scripts/{name}/debug", Allow),
    action!("GET", "/api/filter-scripts/{name}", Allow),
    action!("PUT", "/api/filter-scripts/{name}", Approval),
    action!("DELETE", "/api/filter-scripts/{name}", Deny),
    action!("GET", "/api/routing-scripts", Allow),
    action!("POST", "/api/routing-scripts", Approval),
    action!("GET", "/api/routing-scripts/{name}", Allow),
    action!("PUT", "/api/routing-scripts/{name}", Approval),
    action!("DELETE", "/api/routing-scripts/{name}", Deny),
    action!("GET", "/api/routing-script-selection", Allow),
    action!("PUT", "/api/routing-script-selection", Approval),
    action!("GET", "/api/interceptors", Allow),
    action!("POST", "/api/interceptors", Approval),
    action!("GET", "/api/interceptors/{kind}/{name}", Allow),
    action!("PUT", "/api/interceptors/{kind}/{name}", Approval),
    action!("DELETE", "/api/interceptors/{kind}/{name}", Deny),
    action!("GET", "/api/breakpoints", Allow),
    action!("GET", "/api/breakpoints/{id}/body", Allow),
    action!("GET", "/api/breakpoints/{id}", Allow),
    action!("POST", "/api/breakpoints/{id}/extend", Approval),
    action!("POST", "/api/breakpoints/{id}/release", Approval),
    action!("POST", "/api/breakpoints/{id}/execute", Approval),
    action!("GET", "/api/bypass", Allow),
    action!("DELETE", "/api/bypass", Deny),
    action!("POST", "/api/bypass/delete", Deny),
    action!("DELETE", "/api/bypass/{id}", Deny),
    action!("GET", "/api/clash-subscription", Allow),
    action!("PUT", "/api/clash-subscription", Approval),
    action!("DELETE", "/api/clash-subscription", Approval),
    action!("GET", "/api/clash-config", Allow),
    action!("PUT", "/api/clash-config", Allow),
    action!("DELETE", "/api/clash-config", Allow),
    action!("GET", "/api/env-sets", Allow),
    action!("POST", "/api/env-sets", Approval),
    action!("PUT", "/api/env-sets/{id}", Approval),
    action!("DELETE", "/api/env-sets/{id}", Approval),
    action!("PUT", "/api/env-sets/active", Approval),
    action!("PUT", "/api/env-globals", Approval),
    action!("POST", "/api/env-write-back", Approval),
    action!("GET", "/api/system-logs", Allow),
    action!("DELETE", "/api/system-logs", Deny),
    // Request library (plan Task 6): reads allow, writes and deletes approval.
    action!("GET", "/api/request-library", Allow),
    action!("POST", "/api/request-library", Approval),
    action!("GET", "/api/request-library/{id}", Allow),
    action!("PUT", "/api/request-library/{id}", Approval),
    action!("DELETE", "/api/request-library/{id}", Approval),
    action!("POST", "/api/request-library/from-capture", Approval),
    action!("GET", "/api/request-library/{id}/body", Allow),
    action!("GET", "/api/flow-projects", Allow),
    action!("POST", "/api/flow-projects", Approval),
    action!("GET", "/api/flow-projects/{id}", Allow),
    action!("PUT", "/api/flow-projects/{id}", Approval),
    action!("DELETE", "/api/flow-projects/{id}", Approval),
    action!("GET", "/api/workflows", Allow),
    action!("POST", "/api/workflows", Approval),
    action!("GET", "/api/workflows/{id}", Allow),
    action!("PUT", "/api/workflows/{id}", Approval),
    // Incremental graph patch mutates a stored definition like PUT, but only
    // the listed operations instead of whole-graph replacement: same
    // `approval` default.
    action!("PATCH", "/api/workflows/{id}", Approval),
    action!("DELETE", "/api/workflows/{id}", Approval),
    // Graph validation only reads the stored definition and runs the structural
    // validator (no mutation), so despite the POST verb it is registered as a
    // read (`allow`) — the POST is the "execute validation" semantics.
    action!("POST", "/api/workflows/{id}/validate", Allow),
    // Deep graph validation (editor diagnostics) reads the request library and
    // env family but writes nothing: registered as a read like the stored-graph
    // validate above, despite the POST verb.
    action!("POST", "/api/flow/validate", Allow),
    // Pre/post script dry-run executes user script code in the flow engine
    // payload (plan Task 18): arbitrary code execution, so it defaults to
    // `approval`; the request body is excluded from the audit preview so the
    // script content never reaches logs or the approval window.
    action!("POST", "/api/flow/script/dry-run", Approval),
    // httpReplay node request-surface preview (template render dry-run):
    // renders the would-be-sent request in a throwaway VM from the run-chain
    // inputs — no user script execution (preProcess is NOT run), zero outbound
    // traffic, nothing persisted, and secret values are masked server-side;
    // a read despite the POST verb, like the validate routes above.
    action!("POST", "/api/flow/render-preview", Allow),
    // Workflow import/export (plan Task 23). Export is a pure read of stored
    // definitions (`allow`); import creates new definitions and envelope
    // extension entries (never overwriting existing ones), so it defaults to
    // `approval` like the other definition writes.
    action!("GET", "/api/workflows/export", Allow),
    action!("POST", "/api/workflows/import", Approval),
    // Workflow storage (workflow-scoped persistent key/value storage). Reads
    // are allow; writes persist data shared with live runs, so they default to
    // `approval` like the other definition-level writes.
    action!("GET", "/api/workflows/{id}/storage", Allow),
    action!("PUT", "/api/workflows/{id}/storage/{key}", Approval),
    action!("DELETE", "/api/workflows/{id}/storage/{key}", Approval),
    action!("DELETE", "/api/workflows/{id}/storage", Approval),
    // Workflow runs (plan Task 19): reads are allow; triggering and cancelling
    // runs execute workflow replays against real traffic, so both default to
    // `approval` (execution-class actions, tightened by default).
    action!("GET", "/api/flow/runs", Allow),
    action!("POST", "/api/flow/runs", Approval),
    action!("GET", "/api/flow/runs/{id}", Allow),
    action!("POST", "/api/flow/runs/{id}/cancel", Approval),
    // MCP endpoint (plan Task 24): the JSON-RPC transport re-uses the existing
    // identity system and is checked per request, so the endpoint itself is
    // registered like other read-class routes (`allow`). Inside `tools/call`
    // each tool runs a second check against its mapped route's action
    // (Task 24 Step 3); both checks must pass, so the stricter tier wins.
    action!("POST", "/mcp", Allow),
    // MCP exposure tiers (plan Task 25 Step 2): reading the switches is
    // read-class (`allow`); changing them widens what MCP clients may do, so
    // the write defaults to `approval` like the other posture-changing
    // settings. Tier gating inside `tools/call` stacks on the endpoint and
    // mapped-route checks — the stricter of the three always wins.
    action!("GET", "/api/mcp-tiers", Allow),
    action!("PUT", "/api/mcp-tiers", Approval),
    // MCP tool call audit (plan Task 25 Step 4): 审计读是 read 类（`allow`）；
    // 审计条目由 `tools/call` 链路内部落盘，不提供独立写端点。
    action!("GET", "/api/mcp-audit", Allow),
];

pub const OBSOLETE_API_ACTION_IDS: &[&str] = &[
    "PUT /api/session-shares/{id}/redaction",
    "PUT /api/session-har-shares/{id}/redaction",
    "GET /api/session-har-shares/{id}",
    "POST /api/session-har-shares",
    "DELETE /api/session-har-shares/{id}",
    "GET /api/workspace",
    "PUT /api/workspace",
    "PUT /api/config",
    "GET /api/ca",
    "POST /api/ca",
    "POST /api/logs/export",
];

pub fn api_actions() -> &'static [ApiAction] {
    API_ACTIONS
}

pub fn find_api_action(method: &str, route_template: &str) -> Option<&'static ApiAction> {
    API_ACTIONS
        .iter()
        .find(|action| action.method == method && action.route_template == route_template)
}

pub fn api_actions_for_path(path: &str) -> impl Iterator<Item = &'static ApiAction> + '_ {
    API_ACTIONS
        .iter()
        .filter(move |action| route_template_matches(action.route_template, path))
}

fn route_template_matches(template: &str, path: &str) -> bool {
    let mut template = template.trim_matches('/').split('/');
    let mut path = path.trim_matches('/').split('/');
    loop {
        match (template.next(), path.next()) {
            (None, None) => return true,
            (Some(expected), Some(_)) if expected.starts_with("{*") && expected.ends_with('}') => {
                return true;
            }
            (Some(expected), Some(actual))
                if !actual.is_empty()
                    && (expected == actual
                        || (expected.starts_with('{') && expected.ends_with('}'))) => {}
            _ => return false,
        }
    }
}
