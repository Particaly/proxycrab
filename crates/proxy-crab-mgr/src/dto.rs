use std::collections::BTreeMap;

use proxy_crab_mitm::{
    bypass::BypassEntry,
    flow::{
        dry_run::ScriptSide,
        env_sets::EnvGlobalVariables,
        model::{Project, Workflow, WorkflowEdge, WorkflowNode},
        request_library::HarSnapshot,
        run_store::{FlowNodeRunRecord, FlowRunRecord},
        store::EnvVariableSet,
    },
    model::{
        AppConfig, BodyPayload, BreakpointSummary, CaptureError, Column, InterceptorExecution,
        InterceptorKind, InterceptorLibraryItem, ProxyStatus, Script, SessionFilter,
        SessionInterceptors, SessionMetadata, SessionView, SystemLogEntry,
    },
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    RedactionFailed,
    ShareRedactionForbidden,
    MessageContentUnavailable,
    MessageContentHidden,
    RedactionManagementDisabled,
    BadRequest,
    NotFound,
    LogNotFound,
    BodyNotFound,
    AssetNotFound,
    ExecutionNotFound,
    SnapshotNotFound,
    SnapshotBodyNotFound,
    Conflict,
    ProxyRunning,
    ProxyNotRunning,
    SessionInUse,
    AssetAlreadyExists,
    AssetPathConflict,
    InvalidAssetId,
    InvalidAssetFormat,
    NotAcceptableEncoding,
    BodyTooLarge,
    BodyDecodeFailed,
    InternalError,
    BodyReadFailed,
    AssetStoreFailed,
    ReplayFailed,
    InvalidApiKey,
    InvalidUiToken,
    ShareSessionUnavailable,
    WorkflowGraphInvalid,
}

impl ErrorCode {
    /// The stable snake_case wire representation.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RedactionManagementDisabled => "redaction_management_disabled",
            Self::RedactionFailed => "redaction_failed",
            Self::ShareRedactionForbidden => "share_redaction_forbidden",
            Self::MessageContentUnavailable => "message_content_unavailable",
            Self::MessageContentHidden => "message_content_hidden",
            Self::BadRequest => "bad_request",
            Self::NotFound => "not_found",
            Self::LogNotFound => "log_not_found",
            Self::BodyNotFound => "body_not_found",
            Self::AssetNotFound => "asset_not_found",
            Self::ExecutionNotFound => "execution_not_found",
            Self::SnapshotNotFound => "snapshot_not_found",
            Self::SnapshotBodyNotFound => "snapshot_body_not_found",
            Self::Conflict => "conflict",
            Self::ProxyRunning => "proxy_running",
            Self::ProxyNotRunning => "proxy_not_running",
            Self::SessionInUse => "session_in_use",
            Self::AssetAlreadyExists => "asset_already_exists",
            Self::AssetPathConflict => "asset_path_conflict",
            Self::InvalidAssetId => "invalid_asset_id",
            Self::InvalidAssetFormat => "invalid_asset_format",
            Self::NotAcceptableEncoding => "not_acceptable_encoding",
            Self::BodyTooLarge => "body_too_large",
            Self::BodyDecodeFailed => "body_decode_failed",
            Self::InternalError => "internal_error",
            Self::BodyReadFailed => "body_read_failed",
            Self::AssetStoreFailed => "asset_store_failed",
            Self::ReplayFailed => "replay_failed",
            Self::InvalidApiKey => "invalid_api_key",
            Self::InvalidUiToken => "invalid_ui_token",
            Self::ShareSessionUnavailable => "share_session_unavailable",
            Self::WorkflowGraphInvalid => "workflow_graph_invalid",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagerError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_size: Option<u64>,
}

impl std::fmt::Display for ManagerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ManagerError {}

impl ManagerError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            actual_size: None,
            max_size: None,
        }
    }

    pub fn body_too_large(actual_size: u64, max_size: u64) -> Self {
        Self {
            code: ErrorCode::BodyTooLarge,
            message: format!("body size {actual_size} exceeds the requested {max_size} byte limit"),
            actual_size: Some(actual_size),
            max_size: Some(max_size),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::BadRequest, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InternalError, message)
    }
}

pub type ManagerResult<T> = Result<T, ManagerError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetWorkspaceRequest {
    pub path: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreateSessionRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub view: Option<SessionView>,
    pub interceptors: Option<SessionInterceptors>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateSessionRequest {
    pub name: Option<String>,
    pub description: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAgentsPresetRequest {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateAgentsPresetRequest {
    pub name: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentsPreset {
    pub id: String,
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentsPresetState {
    pub active_id: String,
    pub presets: Vec<AgentsPreset>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActiveSession {
    pub session_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionsPayload {
    pub sessions: Vec<SessionMetadata>,
    pub active_session_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionQuery {
    pub session_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BodyQuery {
    pub session_id: Option<u64>,
    pub side: String,
    pub max_size: Option<u64>,
    pub execution_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSocketQuery {
    pub session_id: Option<u64>,
    pub side: String,
    #[serde(default)]
    pub after_id: u32,
    pub limit: Option<usize>,
    pub max_size: Option<u64>,
}
impl WebSocketQuery {
    pub fn body_side(&self) -> ManagerResult<proxy_crab_mitm::storage::BodySide> {
        match self.side.as_str() {
            "request" => Ok(proxy_crab_mitm::storage::BodySide::Request),
            "response" => Ok(proxy_crab_mitm::storage::BodySide::Response),
            _ => Err(ManagerError::bad_request(
                "side must be request or response",
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AssetQuery {
    pub format: Option<String>,
}

pub const fn default_body_max_size() -> u64 {
    16 * 1024 * 1024
}

/// Default page size of the request library list; the page (plus the total)
/// keeps one response bounded even though entries may carry inline bodies.
pub const REQUEST_LIBRARY_DEFAULT_LIMIT: usize = 200;
/// Hard upper bound for the request library list page size.
pub const REQUEST_LIBRARY_MAX_LIMIT: usize = 1000;

/// List filter of the workspace request library. `tags` is a comma-separated
/// list and an entry must carry every requested tag; `query` matches the entry
/// name and the first HAR request URL case-insensitively.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RequestLibraryQuery {
    pub query: Option<String>,
    pub tags: Option<String>,
    pub source: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

/// One bounded page of the request library, sorted by (createdAt, id).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLibraryPage {
    pub entries: Vec<proxy_crab_mitm::flow::store::RequestLibraryEntry>,
    pub total: usize,
}

/// Manual creation of one request library entry; the HAR snapshot must carry at
/// least one entry (validated by the flow store). The server assigns the id,
/// timestamps and `source: manual`, and defaults the name to `METHOD host+path`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRequestLibraryRequest {
    pub har: HarSnapshot,
    pub name: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub origin: String,
}

/// Partial update of one request library entry: absent fields stay unchanged.
/// `id`, `source` and `createdAt` are never editable; `updatedAt` is bumped.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateRequestLibraryRequest {
    pub name: Option<String>,
    pub tags: Option<Vec<String>>,
    pub origin: Option<String>,
    pub har: Option<HarSnapshot>,
}

/// Ingest one capture (live or archived Session) into the request library.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IngestCaptureRequest {
    pub capture_id: u64,
    pub session_id: Option<u64>,
    pub name: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Raw request body of one request library entry.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RequestLibraryBodyQuery {
    pub max_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogIdsRequest {
    pub session_id: Option<u64>,
    pub filter: Option<SessionFilter>,
    pub ids: Option<Vec<u64>>,
    pub min_id: Option<u64>,
    pub max_id: Option<u64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogIdsPayload {
    /// Session the ids were read from (resolved active session when the
    /// request omitted `session_id`); echoed so callers never have to guess
    /// which session a result belongs to. `default` keeps old payloads
    /// deserializable.
    #[serde(default)]
    pub session_id: u64,
    pub matched_ids: Vec<u64>,
    pub in_progress_ids: Vec<u64>,
}

/// Search request for capture logs (mirrored by the MCP `log_search` tool).
/// Every provided field composes with AND semantics; absent fields are
/// ignored. `host`, `path` and `keyword` substring-match the capture URI
/// (works for both origin-form and absolute-form URIs), `method` compares
/// case-insensitively, and `status` compares against the response status code
/// (`"..."` while the response is still pending). With `regex = true` the
/// `host`/`path`/`keyword`/`status` patterns switch to Rust regex.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LogSearchRequest {
    pub session_id: Option<u64>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub keyword: Option<String>,
    #[serde(default)]
    pub regex: bool,
    pub min_id: Option<u64>,
    pub max_id: Option<u64>,
    pub limit: Option<usize>,
}

/// One compact search hit: enough context to decide which logs to open next
/// without pulling every detail.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LogSearchMatch {
    pub id: u64,
    /// True while the capture has no final response yet (`code` is `"..."`).
    pub in_progress: bool,
    pub method: String,
    pub uri: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogSearchPayload {
    /// Session the search ran against (resolved active session when the
    /// request omitted `session_id`).
    pub session_id: u64,
    pub matches: Vec<LogSearchMatch>,
    /// True when `limit` cut the scan short; continue from `next_cursor`.
    pub truncated: bool,
    /// Id of the last examined capture when `truncated` is true. Pass it as
    /// `max_id` (descending default) or `min_id` (when scanning ascending
    /// with only `min_id` set) to fetch the next page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogViewItem {
    pub id: u64,
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionViewInput {
    pub columns: Vec<Column>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogViewsRequest {
    pub session_id: Option<u64>,
    pub logs: Vec<LogViewItem>,
    pub view: Option<SessionViewInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogViewRow {
    pub id: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub outcome: String,
    pub cells: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogViewException {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column_index: Option<usize>,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogViewsPayload {
    pub columns: Vec<Column>,
    pub rows: Vec<LogViewRow>,
    pub exceptions: Vec<LogViewException>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionViewPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redaction_revision: Option<String>,
    pub session_id: u64,
    pub columns: Vec<Column>,
    pub filter: SessionFilter,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplaceSessionViewRequest {
    pub columns: Vec<Column>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeaderItem {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestDetail {
    pub method: String,
    pub uri: String,
    pub version: String,
    pub headers: Vec<HeaderItem>,
    pub tags: BTreeMap<String, String>,
    pub body: BodyPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseDetail {
    pub status: u16,
    pub status_text: String,
    pub version: String,
    pub headers: Vec<HeaderItem>,
    pub body: BodyPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogDetail {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub websocket: Option<proxy_crab_mitm::websocket::WebSocketInfo>,
    pub id: u64,
    pub session_id: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub source_type: String,
    pub source_addr: Option<String>,
    pub stage: String,
    pub outcome: String,
    pub error: Option<CaptureError>,
    pub request: RequestDetail,
    pub response: Option<ResponseDetail>,
    pub request_interceptors: Vec<InterceptorExecution>,
    pub response_interceptors: Vec<InterceptorExecution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreakpointQuery {
    pub session_id: Option<u64>,
    pub phase: Option<InterceptorKind>,
    pub interceptor_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreakpointDetailPayload {
    pub breakpoint: BreakpointSummary,
    pub log: LogDetail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExtendBreakpointRequest {
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecuteTemporaryScriptRequest {
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptRequest {
    pub name: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateScriptRequest {
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugFilterScriptRequest {
    pub session_id: Option<u64>,
    pub log_id: u64,
    pub input: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterceptorCreateRequest {
    pub kind: InterceptorKind,
    pub name: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InterceptorUpdateRequest {
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingSelection {
    pub name: Option<String>,
}

// Environment variable sets and global variables (plan Task 17). Reads hand
// masked secret values to callers; writes restore stored plaintext for values
// the caller left masked.

/// Whole env family snapshot: sets (masked), the activation preference and
/// the global variables table (masked).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvSetsPayload {
    pub sets: Vec<EnvVariableSet>,
    pub active_set_id: Option<String>,
    pub globals: EnvGlobalVariables,
}

/// Create one set from scratch or duplicate an existing one (`copy_from`
/// duplicates values including secrets under a new id).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateEnvSetRequest {
    pub name: String,
    #[serde(default)]
    pub copy_from: Option<String>,
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    #[serde(default)]
    pub secret_values: BTreeMap<String, String>,
}

/// Replace one set's editable fields (id and createdAt are bound to the path
/// and the stored document). `secret_values` absent = keep the stored secret
/// table untouched (plain clients and MCP calls that omit the field must not
/// be able to wipe secrets by omission); provided = whole-table replacement
/// with `******` entries restoring stored plaintext and omitted keys removed.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveEnvSetRequest {
    pub name: String,
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    #[serde(default)]
    pub secret_values: Option<BTreeMap<String, String>>,
}

/// Switch the activated set; `None` clears the preference.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceActiveEnvSetRequest {
    pub set_id: Option<String>,
}

/// Replace the global variables table (masked secret values restore).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceEnvGlobalsRequest {
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    #[serde(default)]
    pub secret_values: BTreeMap<String, String>,
}

// Workflow storage (workflow-scoped persistent key/value storage, owned by
// `proxy_crab_mitm::flow::workflow_data`). Values are arbitrary JSON (unlike
// the string tables of the env family); every write persists immediately.

/// One stored key/value pair with its last-write timestamp (read response
/// element; wire format camelCase mirroring the Rust type).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStorageEntryDto {
    pub key: String,
    pub value: serde_json::Value,
    pub updated_at: u64,
}

/// Whole storage snapshot of one workflow: entries sorted by key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStoragePayload {
    pub workflow_id: String,
    pub entries: Vec<WorkflowStorageEntryDto>,
}

/// Upsert one key with an arbitrary JSON value.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStoragePutRequest {
    pub value: serde_json::Value,
}

/// One script env write-back batch targeting the dispatch-time active set.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvWriteBackRequest {
    pub set_id: String,
    pub writes: BTreeMap<String, serde_json::Value>,
}

/// Flush outcome of the write-back batches persisted for one request.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvWriteBackResult {
    pub applied: usize,
    pub dropped: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BypassQuery {
    pub before_id: Option<u64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BypassPage {
    pub rows: Vec<BypassEntry>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteBypassRequest {
    pub ids: Vec<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteCount {
    pub deleted: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterceptorLibraryList {
    pub kind: InterceptorKind,
    pub items: Vec<InterceptorLibraryItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterceptorDetail {
    pub kind: InterceptorKind,
    pub name: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInterceptorInput {
    pub name: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplaceSessionInterceptorsRequest {
    pub request: Vec<SessionInterceptorInput>,
    pub response: Vec<SessionInterceptorInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInterceptorItem {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub enabled: bool,
    pub valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInterceptorsPayload {
    pub session_id: u64,
    pub request: Vec<SessionInterceptorItem>,
    pub response: Vec<SessionInterceptorItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemLogsQuery {
    pub after_seq: Option<u64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CertificateResponse {
    pub pem: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpServiceStatus {
    pub running: bool,
    pub host: String,
    pub port: u16,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HttpApiResource {
    Workspace,
    Config,
    Proxy,
    Sessions,
    ArchivedSessions,
    ActiveSession,
    SessionShare,
    SessionView,
    ColumnScripts,
    FilterScripts,
    RoutingScripts,
    RoutingSelection,
    Bypass,
    Interceptors,
    SessionInterceptors,
    Certificate,
    ClashSubscription,
    ClashConfig,
    SystemLogs,
    RequestLibrary,
    EnvSets,
    FlowRuns,
    WorkflowStorage,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HttpApiChange {
    pub resources: Vec<HttpApiResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<u64>,
}

pub use proxy_crab_mitm::model::{
    AppConfig as Config, Column as NetLogColumn, InterceptorKind as Kind,
    ProxyStatus as MitmStatus, SessionMetadata as Session,
};

pub type AgentsPresetsResponse = AgentsPresetState;
pub type ConfigResponse = AppConfig;
pub type ProxyStatusResponse = ProxyStatus;
pub type SessionsResponse = Vec<SessionMetadata>;
pub type ScriptsResponse = Vec<Script>;
pub type SystemLogsResponse = Vec<SystemLogEntry>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReplayRequestPayload {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<ReplayBodyPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReplayBodyPayload {
    Text {
        text: String,
        #[serde(default)]
        charset: Option<String>,
    },
    BodyRef {
        session_id: u64,
        log_id: u64,
        side: String,
    },
    Asset {
        asset_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReplayResult {
    pub log_id: u64,
}

/// Envelope of `POST /api/replay` (and the MCP `replay_once` tool). Exactly one
/// request source must be present: `library_id` replays a request-library
/// entry (its first HAR request, blob-backed bodies inlined), or `method` +
/// `url` send a raw request. Top-level `headers`/`body` belong to the raw
/// source only; `override` applies on top of either source.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ReplayHttpRequest {
    /// Session to replay into; defaults to the active session.
    pub session_id: Option<u64>,
    #[serde(default)]
    pub library_id: Option<String>,
    #[serde(default, rename = "override")]
    pub override_: Option<ReplayOverridePayload>,
    pub method: Option<String>,
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Option<Vec<(String, String)>>,
    #[serde(default)]
    pub body: Option<ReplayBodyPayload>,
}

/// Overrides applied on top of the resolved replay baseline (request-library
/// entry or raw request): `headers` replace-or-add by header name,
/// `removed_headers` drop names before `headers` are applied, and `body`
/// replaces the body text (charset stays UTF-8).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplayOverridePayload {
    pub method: Option<String>,
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub removed_headers: Vec<String>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RedactionBinding {
    pub redaction_script: Option<String>,
}

/* ---- Workflow domain (flow projects / workflows) ---- */

/// Create one flow project: id and timestamps are server-generated.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowProjectCreateRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
    #[serde(default)]
    pub secret_variables: BTreeMap<String, String>,
}

/// Update one flow project: only the fields present in the body are replaced
/// (clearing a text field is done by sending an empty string, clearing a map
/// by sending an empty object).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowProjectUpdateRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
    pub variables: Option<BTreeMap<String, String>>,
    pub secret_variables: Option<BTreeMap<String, String>>,
}

/// Create one workflow definition: id and timestamps are server-generated.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowCreateRequest {
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub nodes: Vec<WorkflowNode>,
    #[serde(default)]
    pub edges: Vec<WorkflowEdge>,
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
    #[serde(default)]
    pub secret_variables: BTreeMap<String, String>,
}

/// Update one workflow definition. `nodes` and `edges` form one graph unit:
/// they must be sent together (whole replacement) or both omitted. Other
/// present fields are replaced individually.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowUpdateRequest {
    pub project_id: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub nodes: Option<Vec<WorkflowNode>>,
    pub edges: Option<Vec<WorkflowEdge>>,
    pub variables: Option<BTreeMap<String, String>>,
    pub secret_variables: Option<BTreeMap<String, String>>,
}

/// Patch one workflow graph incrementally (large-graph editing without
/// resending the whole definition). Every list is applied by id:
/// - `addNodes`/`addEdges` insert complete documents and reject duplicate ids;
/// - `updateNodes`/`updateEdges` carry raw objects with a required `id` —
///   present fields replace, explicit `null` clears optional fields, and
///   `updateNodes[].config` follows JSON Merge Patch (RFC 7386: objects merge
///   recursively, `null` deletes a key, arrays/scalars replace) so one body
///   tweak needs only the changed fragment;
/// - `removeNodes` cascade-deletes the incident edges.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPatchRequest {
    #[serde(default)]
    pub add_nodes: Vec<WorkflowNode>,
    #[serde(default)]
    pub update_nodes: Vec<serde_json::Value>,
    #[serde(default)]
    pub remove_nodes: Vec<String>,
    #[serde(default)]
    pub add_edges: Vec<WorkflowEdge>,
    #[serde(default)]
    pub update_edges: Vec<serde_json::Value>,
    #[serde(default)]
    pub remove_edges: Vec<String>,
}

/// Compact result of one workflow graph patch: the lists name exactly the ids
/// touched by the request (the caller already knows what it sent — the server
/// confirms what actually landed, in application order). The full updated
/// document stays available via `GET /api/workflows/{id}`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPatchResult {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub node_count: usize,
    pub edge_count: usize,
    pub added_node_ids: Vec<String>,
    pub updated_node_ids: Vec<String>,
    pub removed_node_ids: Vec<String>,
    pub added_edge_ids: Vec<String>,
    pub updated_edge_ids: Vec<String>,
    pub removed_edge_ids: Vec<String>,
}

/// Shared pagination parameters for flow entity lists: `limit` omitted returns
/// every entity, `offset` skips the first entries of the deterministic
/// (createdAt, id) order.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowListQuery {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

/// Workflow list query: filters by owning project before paginating.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowListQuery {
    pub project_id: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlowProjectPage {
    pub projects: Vec<Project>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowPage {
    pub workflows: Vec<Workflow>,
    pub total: usize,
}

/// One workflow-graph validation issue (`flow::validate::ValidationIssue`
/// shaped for the wire). Structural issues are `error` severity (blocking for
/// runs); deep-validation issues may also be `warning` (advisory only, they
/// never gate saves or runs).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowValidationIssue {
    /// Stable kebab-case issue code (`missing-start`, `dangling-edge`, …).
    pub code: String,
    /// `error` (structural, run-blocking) or `warning` (deep-pass advisory).
    pub severity: String,
    /// Human-readable message (already localized by the validator).
    pub message: String,
    /// Node ids for locating the problem; empty for workflow-level issues.
    pub node_ids: Vec<String>,
}

/// Deep-validate one workflow graph (`POST /api/flow/validate`): either `id`
/// (deep-check the stored definition) or the inline `nodes` + `edges` graph
/// unit (draft check, same whole-replacement semantics as saves). Inline
/// `nodes`/`edges` stay raw JSON so per-node `config` unknown keys can be
/// flagged; malformed node/edge shapes are rejected at the manager boundary.
/// Structural checks always run; the deep pass adds request-library, template
/// and assertion rules whose issues never gate saves or runs.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDeepValidateRequest {
    pub id: Option<String>,
    pub nodes: Option<Vec<serde_json::Value>>,
    pub edges: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
    #[serde(default)]
    pub secret_variables: BTreeMap<String, String>,
}

/// Dry-run one pre/post script against a sample payload (plan Task 18): the
/// script executes in the flow engine payload inside a throwaway VM — never
/// persisted, never broadcast, and the request body is kept out of the
/// permission audit preview (`side` picks which sample field is used).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowScriptDryRunRequest {
    pub side: ScriptSide,
    pub script: String,
    /// Sample for `pre` scripts: the aggregated upstream input (any JSON).
    #[serde(default)]
    pub sample_input: Option<serde_json::Value>,
    /// Sample for `post` scripts: the raw response envelope (any JSON).
    #[serde(default)]
    pub sample_response: Option<serde_json::Value>,
}

/// Preview the rendered request of one httpReplay node (template render
/// dry-run): assembles the run-chain inputs (3-layer variables, active env
/// set, workflow storage, request-library projection), then renders the exact
/// outgoing request in a throwaway VM — zero outbound traffic, nothing
/// persisted, preProcess scripts are NOT executed.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowRenderPreviewRequest {
    /// Owning workflow id (stored workflows only; drafts are not previewable).
    pub workflow_id: String,
    /// Target httpReplay node id.
    pub node_id: String,
    /// Optional `var.*` sample values (highest precedence) — e.g. sample
    /// values for setVariable-declared runtime variables.
    #[serde(default)]
    pub variable_overrides: Option<BTreeMap<String, serde_json::Value>>,
}

/* ---- Workflow transfer (plan Task 23: import/export) ---- */

/// Workflow export query: `ids` is a required comma-separated list of workflow
/// ids (`?ids=wf-a,wf-b`); unknown ids resolve to `404 not_found`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowExportQuery {
    pub ids: Option<String>,
}

/// Import one workflow export envelope (plan Task 23). `file` is the raw
/// envelope object (`format`/`version`/`workflows`/`requests`/`envSets`);
/// `projectId` names the target project of the imported copies (required,
/// not checked for existence — same convention as `POST /api/workflows`).
///
/// Script review follows the M19 confirm-scripts semantics: without
/// `confirmScripts` every collected script is cleared from the imported copy;
/// with it, only the scripts listed in `confirmedScripts` (keys shaped
/// `workflowIndex:nodeIndex:kind`, kind one of `preProcess`/`postProcess`/
/// `expression`) are kept verbatim — everything else is still cleared.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowImportRequest {
    pub file: serde_json::Value,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub confirm_scripts: bool,
    #[serde(default)]
    pub confirmed_scripts: Vec<String>,
}

/// One successfully imported workflow copy (`index` is the position of the
/// workflow inside the envelope's `workflows` array).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowImportCreated {
    pub index: usize,
    pub id: String,
    pub name: String,
}

/// One workflow rejected by the import shape validation; the copy is not
/// created and the issues list the reasons.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowImportSkipped {
    pub index: usize,
    pub name: String,
    pub issues: Vec<String>,
}

/// Adjudication outcome of one envelope extension family (`requests` /
/// `envSets`): existing entries are never overwritten — an id conflict skips
/// the entry and reports the reason; a new id is stored verbatim.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowImportExtensionOutcome {
    pub imported: usize,
    pub skipped: Vec<WorkflowImportExtensionSkipped>,
}

/// One skipped extension entry and why.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowImportExtensionSkipped {
    pub id: String,
    pub reason: String,
}

/// Import outcome: created copies, rejected workflows with their issues, and
/// the extension-field adjudication per family.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowImportResult {
    pub imported: Vec<WorkflowImportCreated>,
    pub skipped: Vec<WorkflowImportSkipped>,
    pub requests: WorkflowImportExtensionOutcome,
    pub env_sets: WorkflowImportExtensionOutcome,
}

/* ---- Workflow runs (plan Task 19) ---- */

/// Default page size of the workflow run list; runs carry inline graph
/// snapshots so one response must stay bounded (same shape as the request
/// library page).
pub const FLOW_RUN_DEFAULT_LIMIT: usize = 200;
/// Hard upper bound for the workflow run list page size.
pub const FLOW_RUN_MAX_LIMIT: usize = 1000;

/// Trigger one workflow run (plan Task 19): the workflow is addressed by the
/// body; the target Session defaults to the active one. `startNodeId` selects
/// the entry start node of a multi-start workflow; it must reference an
/// existing `start` node and is required (non-empty or defaulted) whenever the
/// stored graph has more than one start node.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowRunTriggerRequest {
    pub workflow_id: String,
    #[serde(default)]
    pub session_id: Option<u64>,
    #[serde(default)]
    pub start_node_id: Option<String>,
}

/// Workflow run list query: filters by workflow/status before paginating.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowRunListQuery {
    pub workflow_id: Option<String>,
    pub status: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

/// One bounded page of workflow runs, newest first.
#[derive(Debug, Clone, Serialize)]
pub struct FlowRunPage {
    pub runs: Vec<FlowRunRecord>,
    pub total: usize,
}

/// Run detail payload: the flattened run record plus its node checkpoints.
/// Wraps the mitm `FlowRunDetail` to keep the wire shape camelCase
/// (`nodeRuns`) consistent with the run records.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowRunDetailPayload {
    #[serde(flatten)]
    pub run: FlowRunRecord,
    pub node_runs: Vec<FlowNodeRunRecord>,
}

/// Compact digest of one node checkpoint for `workflow_run_wait`: the status
/// fields only — no `input`/`output`/`iterations` payloads (the heavy detail
/// stays behind `workflow_run_detail`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowNodeRunDigest {
    pub node_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `workflow_run_wait` payload (MCP-only): the run record fields plus the
/// per-node digest, mirroring the `run-wait.mjs` summary shape. `settled` is
/// `false` when the wait deadline passed before the run reached a terminal
/// state — `status`/`nodes` then reflect the latest observed progress and the
/// caller may wait again or give up.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowRunWaitPayload {
    pub id: String,
    pub workflow_id: String,
    pub workflow_name: String,
    pub trigger: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_node_id: Option<String>,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub settled: bool,
    pub nodes: Vec<FlowNodeRunDigest>,
}
