use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use proxy_crab_mitm::{
    ProxyCrab, ReplayBody, ReplayError, ReplayRequest,
    asset::{Asset, AssetError, AssetUpload},
    flow::{
        dry_run::{self, ScriptDryRunOutput, ScriptSide},
        env_sets::{
            self, EnvGlobalVariables, mask_env_set, mask_globals, restore_masked_secret_values,
        },
        mcp_audit::McpAuditEntry,
        mcp_tiers::McpTiers,
        model::{
            Project, WORKFLOW_SCHEMA_VERSION, Workflow, WorkflowEdge, WorkflowNode, generate_ref_id,
        },
        render_preview::{self, RenderPreviewLoadError, RenderPreviewOutput},
        request_library::{CapturedRequest, RequestLibraryEntry, RequestSource},
        run::{FlowRunEvent, FlowRunManager, RunTriggerError},
        run_store::{FlowNodeRunRecord, FlowRunRecord, flow_run_status_is_terminal},
        store::{EnvVariableSet, FlowStore, generate_flow_id},
        transfer,
        validate::{ValidationIssue, ValidationSeverity, validate_workflow_graph},
        validate_deep::{DeepValidationIssue, deep_issues},
        workflow_data::WorkflowStorageEntry,
    },
    lua::{CaptureBodyAccess, ColumnEvaluator, FilterEvaluator},
    model::{
        AppConfig, BreakpointListFilter, BreakpointSummary, CaptureDetail, CaptureOutcome,
        CaptureSummary, Column, FilterColumn, FilterOption, HeaderValues, InterceptorKind,
        InterceptorScriptContent, InterceptorSnapshot, NewSession, ProxyStatus, Script, ScriptKind,
        SessionFilter, SessionInterceptor, SessionInterceptors, SessionMetadata, SystemLogEntry,
        TemporaryExecutionResult,
    },
    storage::{BodySide, BodySource},
    workspace::now_millis,
};
use regex::Regex;
use serde_json::Value as JsonValue;

use crate::{
    agents::AgentsStore,
    clash_subscription::{
        ClashConfig, ClashSubscription, ClashSubscriptionState, EnableClashSubscriptionRequest,
        SaveClashConfigRequest,
    },
    dto::{
        ActiveSession, AgentsPresetState, BreakpointDetailPayload, BreakpointQuery, BypassPage,
        BypassQuery, CertificateResponse, CreateAgentsPresetRequest, CreateEnvSetRequest,
        CreateRequestLibraryRequest, CreateSessionRequest, DebugFilterScriptRequest, DeleteCount,
        EnvSetsPayload, EnvWriteBackRequest, EnvWriteBackResult, ErrorCode,
        ExecuteTemporaryScriptRequest, ExtendBreakpointRequest, FLOW_RUN_DEFAULT_LIMIT,
        FLOW_RUN_MAX_LIMIT, FlowListQuery, FlowNodeRunDigest, FlowProjectCreateRequest,
        FlowProjectPage, FlowProjectUpdateRequest, FlowRenderPreviewRequest, FlowRunDetailPayload,
        FlowRunListQuery, FlowRunPage, FlowRunTriggerRequest, FlowRunWaitPayload,
        FlowScriptDryRunRequest, HeaderItem, IngestCaptureRequest, InterceptorCreateRequest,
        InterceptorDetail, InterceptorLibraryList, InterceptorUpdateRequest, LogDetail,
        LogIdsPayload, LogIdsRequest, LogSearchMatch, LogSearchPayload, LogSearchRequest,
        LogViewException, LogViewRow, LogViewsPayload, LogViewsRequest, ManagerError,
        ManagerResult, REQUEST_LIBRARY_DEFAULT_LIMIT, REQUEST_LIBRARY_MAX_LIMIT,
        ReplaceActiveEnvSetRequest, ReplaceEnvGlobalsRequest, ReplaceSessionInterceptorsRequest,
        ReplaceSessionViewRequest, ReplayBodyPayload, ReplayHttpRequest, ReplayOverridePayload,
        ReplayRequestPayload, ReplayResult, RequestDetail, RequestLibraryPage, RequestLibraryQuery,
        ResponseDetail, RoutingSelection, SaveEnvSetRequest, ScriptRequest, SessionInterceptorItem,
        SessionInterceptorsPayload, SessionViewPayload, SessionsPayload, SystemLogsQuery,
        UpdateAgentsPresetRequest, UpdateRequestLibraryRequest, UpdateScriptRequest,
        UpdateSessionRequest, WorkflowCreateRequest, WorkflowDeepValidateRequest,
        WorkflowImportCreated, WorkflowImportExtensionSkipped, WorkflowImportRequest,
        WorkflowImportResult, WorkflowImportSkipped, WorkflowListQuery, WorkflowPage,
        WorkflowPatchRequest, WorkflowPatchResult, WorkflowStorageEntryDto, WorkflowStoragePayload,
        WorkflowStoragePutRequest, WorkflowUpdateRequest, WorkflowValidationIssue,
    },
};
use tokio::sync::{Semaphore, broadcast, watch};

pub(crate) mod redaction;
use redaction::{ReadPolicy, ReadRedactor};

const MAX_BLOCKING_MANAGEMENT_TASKS: usize = 8;

#[async_trait]
pub trait ProxyCrabManager: Send + Sync {
    async fn export_session_config(
        &self,
        id: u64,
        config: crate::bundle::ConfigShare,
    ) -> ManagerResult<Vec<u8>>;
    async fn import_bundle(
        &self,
        bytes: Vec<u8>,
        accepted: Vec<String>,
    ) -> ManagerResult<crate::bundle::ImportResult>;
    async fn resolve_bundle(
        &self,
        id: String,
        resolutions: Vec<crate::bundle::Resolution>,
    ) -> ManagerResult<crate::bundle::ImportResult>;

    fn reader(&self, script: Option<&str>, api: &str) -> ManagerResult<Arc<dyn ProxyCrabManager>>;
    async fn redaction_scripts(&self) -> ManagerResult<Vec<Script>>;
    async fn redaction_script(&self, name: String) -> ManagerResult<Script>;
    async fn create_redaction_script(&self, request: ScriptRequest) -> ManagerResult<()>;
    async fn update_redaction_script(
        &self,
        name: String,
        request: UpdateScriptRequest,
    ) -> ManagerResult<()>;
    async fn delete_redaction_script(&self, name: String) -> ManagerResult<()>;
    fn subscribe_proxy_status_changes(&self) -> watch::Receiver<u64>;
    async fn asset(&self, id: String) -> ManagerResult<Asset>;
    async fn begin_asset_upload(
        &self,
        id: String,
        content_type: String,
    ) -> ManagerResult<AssetUpload>;
    async fn config(&self) -> ManagerResult<AppConfig>;
    async fn replace_config(&self, config: AppConfig) -> ManagerResult<AppConfig>;
    async fn agents_presets(&self) -> ManagerResult<AgentsPresetState>;
    async fn agents_markdown(&self) -> ManagerResult<String>;
    async fn create_agents_preset(
        &self,
        request: CreateAgentsPresetRequest,
    ) -> ManagerResult<AgentsPresetState>;
    async fn update_agents_preset(
        &self,
        id: String,
        request: UpdateAgentsPresetRequest,
    ) -> ManagerResult<AgentsPresetState>;
    async fn activate_agents_preset(&self, id: String) -> ManagerResult<AgentsPresetState>;
    async fn delete_agents_preset(&self, id: String) -> ManagerResult<AgentsPresetState>;
    async fn reimport_default_agents_presets(&self) -> ManagerResult<AgentsPresetState>;
    async fn proxy_status(&self) -> ManagerResult<ProxyStatus>;
    async fn start_proxy(&self) -> ManagerResult<ProxyStatus>;
    async fn stop_proxy(&self) -> ManagerResult<ProxyStatus>;
    async fn sessions(&self) -> ManagerResult<SessionsPayload>;
    async fn archived_sessions(&self) -> ManagerResult<Vec<SessionMetadata>>;
    async fn replace_active_session(&self, active: ActiveSession) -> ManagerResult<ActiveSession>;
    async fn create_session(&self, request: CreateSessionRequest)
    -> ManagerResult<SessionMetadata>;
    async fn update_session(
        &self,
        id: u64,
        request: UpdateSessionRequest,
    ) -> ManagerResult<SessionMetadata>;
    async fn archive_session(&self, id: u64) -> ManagerResult<SessionMetadata>;
    async fn restore_session(&self, id: u64) -> ManagerResult<SessionMetadata>;
    async fn delete_archived_session(&self, id: u64) -> ManagerResult<()>;
    async fn log_ids(&self, request: LogIdsRequest) -> ManagerResult<LogIdsPayload>;
    /// Search capture logs with simple AND-composed predicates (host/path/
    /// keyword/method/status + id range + limit), returning compact match
    /// summaries instead of bare ids (MCP `log_search`).
    async fn log_search(&self, request: LogSearchRequest) -> ManagerResult<LogSearchPayload>;
    async fn log_views(&self, request: LogViewsRequest) -> ManagerResult<LogViewsPayload>;
    async fn log(&self, session_id: Option<u64>, id: u64) -> ManagerResult<LogDetail>;
    async fn websocket_messages(
        &self,
        session_id: Option<u64>,
        id: u64,
        side: BodySide,
        after_id: u32,
        limit: usize,
    ) -> ManagerResult<proxy_crab_mitm::websocket::WebSocketPage>;
    async fn websocket_message_body(
        &self,
        session_id: Option<u64>,
        id: u64,
        side: BodySide,
        message_id: u32,
        max_size: u64,
    ) -> ManagerResult<BodySource>;
    async fn replay(
        &self,
        session_id: u64,
        request: ReplayRequestPayload,
    ) -> ManagerResult<ReplayResult>;
    /// Envelope entry of `POST /api/replay` (MCP `replay_once`): replay a raw
    /// request or a request-library entry (optionally overridden) into the
    /// given (default: active) session and return the new capture id.
    async fn replay_request(&self, request: ReplayHttpRequest) -> ManagerResult<ReplayResult>;
    async fn assets(&self) -> ManagerResult<Vec<proxy_crab_mitm::asset::AssetMetadata>>;
    async fn log_body_source(
        &self,
        session_id: Option<u64>,
        id: u64,
        side: BodySide,
    ) -> ManagerResult<BodySource>;
    async fn interceptor_snapshot_body_source(
        &self,
        session_id: Option<u64>,
        capture_id: u64,
        execution_id: u64,
        side: BodySide,
    ) -> ManagerResult<BodySource>;
    async fn interceptor_script_content(
        &self,
        session_id: Option<u64>,
        capture_id: u64,
        execution_id: u64,
    ) -> ManagerResult<InterceptorScriptContent>;
    async fn interceptor_snapshot(
        &self,
        session_id: Option<u64>,
        capture_id: u64,
        execution_id: u64,
    ) -> ManagerResult<InterceptorSnapshot>;
    async fn breakpoints(&self, query: BreakpointQuery) -> ManagerResult<Vec<BreakpointSummary>>;
    async fn breakpoint(&self, id: u64) -> ManagerResult<BreakpointDetailPayload>;
    async fn breakpoint_body_source(&self, id: u64, side: BodySide) -> ManagerResult<BodySource>;
    async fn extend_breakpoint(
        &self,
        id: u64,
        request: ExtendBreakpointRequest,
    ) -> ManagerResult<BreakpointSummary>;
    async fn release_breakpoint(&self, id: u64) -> ManagerResult<()>;
    async fn execute_breakpoint_script(
        &self,
        id: u64,
        request: ExecuteTemporaryScriptRequest,
    ) -> ManagerResult<TemporaryExecutionResult>;
    async fn session_view(&self, session_id: Option<u64>) -> ManagerResult<SessionViewPayload>;
    async fn replace_session_filter(
        &self,
        session_id: u64,
        filter: SessionFilter,
    ) -> ManagerResult<SessionViewPayload>;
    async fn replace_session_view(
        &self,
        session_id: Option<u64>,
        request: ReplaceSessionViewRequest,
    ) -> ManagerResult<SessionViewPayload>;
    async fn column_scripts(&self) -> ManagerResult<Vec<Script>>;
    async fn create_column_script(&self, request: ScriptRequest) -> ManagerResult<()>;
    async fn column_script(&self, name: String) -> ManagerResult<Script>;
    async fn update_column_script(
        &self,
        name: String,
        request: UpdateScriptRequest,
    ) -> ManagerResult<()>;
    async fn delete_column_script(&self, name: String) -> ManagerResult<()>;
    async fn filter_scripts(&self) -> ManagerResult<Vec<Script>>;
    async fn create_filter_script(&self, request: ScriptRequest) -> ManagerResult<()>;
    async fn filter_script(&self, name: String) -> ManagerResult<Script>;
    async fn update_filter_script(
        &self,
        name: String,
        request: UpdateScriptRequest,
    ) -> ManagerResult<()>;
    async fn delete_filter_script(&self, name: String) -> ManagerResult<()>;
    async fn debug_filter_script(
        &self,
        name: String,
        request: DebugFilterScriptRequest,
    ) -> ManagerResult<bool>;
    async fn routing_scripts(&self) -> ManagerResult<Vec<Script>>;
    async fn create_routing_script(&self, request: ScriptRequest) -> ManagerResult<()>;
    async fn routing_script(&self, name: String) -> ManagerResult<Script>;
    async fn update_routing_script(
        &self,
        name: String,
        request: UpdateScriptRequest,
    ) -> ManagerResult<()>;
    async fn delete_routing_script(&self, name: String) -> ManagerResult<()>;
    async fn routing_selection(&self) -> ManagerResult<RoutingSelection>;
    async fn replace_routing_selection(
        &self,
        selection: RoutingSelection,
    ) -> ManagerResult<RoutingSelection>;
    async fn interceptors(&self, kind: InterceptorKind) -> ManagerResult<InterceptorLibraryList>;
    async fn create_interceptor(&self, request: InterceptorCreateRequest) -> ManagerResult<()>;
    async fn interceptor(
        &self,
        kind: InterceptorKind,
        name: String,
    ) -> ManagerResult<InterceptorDetail>;
    async fn update_interceptor(
        &self,
        kind: InterceptorKind,
        name: String,
        request: InterceptorUpdateRequest,
    ) -> ManagerResult<()>;
    async fn delete_interceptor(&self, kind: InterceptorKind, name: String) -> ManagerResult<()>;
    async fn session_interceptors(
        &self,
        session_id: Option<u64>,
    ) -> ManagerResult<SessionInterceptorsPayload>;
    async fn replace_session_interceptors(
        &self,
        session_id: Option<u64>,
        request: ReplaceSessionInterceptorsRequest,
    ) -> ManagerResult<SessionInterceptorsPayload>;
    async fn certificate(&self) -> ManagerResult<CertificateResponse>;
    async fn clash_subscription(&self) -> ManagerResult<ClashSubscriptionState>;
    async fn enable_clash_subscription(
        &self,
        request: EnableClashSubscriptionRequest,
    ) -> ManagerResult<ClashSubscriptionState>;
    async fn disable_clash_subscription(&self) -> ManagerResult<ClashSubscriptionState>;
    async fn clash_subscription_yaml(&self) -> ManagerResult<String>;
    async fn clash_config(&self) -> ManagerResult<ClashConfig>;
    async fn save_clash_config(
        &self,
        request: SaveClashConfigRequest,
    ) -> ManagerResult<ClashConfig>;
    async fn reset_clash_config(&self) -> ManagerResult<ClashConfig>;
    async fn regenerate_certificate(&self) -> ManagerResult<CertificateResponse>;
    async fn system_logs(&self, query: SystemLogsQuery) -> ManagerResult<Vec<SystemLogEntry>>;
    async fn clear_system_logs(&self) -> ManagerResult<()>;
    async fn bypass_entries(&self, query: BypassQuery) -> ManagerResult<BypassPage>;
    async fn delete_bypass_entry(&self, id: u64) -> ManagerResult<()>;
    async fn delete_bypass_entries(&self, ids: Vec<u64>) -> ManagerResult<DeleteCount>;
    async fn clear_bypass_entries(&self) -> ManagerResult<DeleteCount>;
    async fn flow_projects(&self, query: FlowListQuery) -> ManagerResult<FlowProjectPage>;
    async fn create_flow_project(
        &self,
        request: FlowProjectCreateRequest,
    ) -> ManagerResult<Project>;
    async fn flow_project(&self, id: String) -> ManagerResult<Project>;
    async fn update_flow_project(
        &self,
        id: String,
        request: FlowProjectUpdateRequest,
    ) -> ManagerResult<Project>;
    async fn delete_flow_project(&self, id: String) -> ManagerResult<()>;
    async fn workflows(&self, query: WorkflowListQuery) -> ManagerResult<WorkflowPage>;
    async fn create_workflow(&self, request: WorkflowCreateRequest) -> ManagerResult<Workflow>;
    async fn workflow(&self, id: String) -> ManagerResult<Workflow>;
    async fn update_workflow(
        &self,
        id: String,
        request: WorkflowUpdateRequest,
    ) -> ManagerResult<Workflow>;
    /// Patch one workflow graph incrementally (`PATCH /api/workflows/{id}`,
    /// MCP `workflow_patch`): apply add/update/remove operations by id without
    /// resending the whole definition, then structurally validate before
    /// persisting. Returns the compact patch summary.
    async fn patch_workflow(
        &self,
        id: String,
        request: WorkflowPatchRequest,
    ) -> ManagerResult<WorkflowPatchResult>;
    async fn delete_workflow(&self, id: String) -> ManagerResult<()>;
    async fn validate_workflow(&self, id: String) -> ManagerResult<Vec<WorkflowValidationIssue>>;
    /// Deep-validate a workflow graph (`POST /api/flow/validate`, MCP
    /// `workflow_validate_deep`): structural checks plus request-library,
    /// template and assertion rules. Never gates saves or runs — deep issues
    /// are editor diagnostics.
    async fn validate_workflow_deep(
        &self,
        request: WorkflowDeepValidateRequest,
    ) -> ManagerResult<Vec<WorkflowValidationIssue>>;
    /// Build the workflow export envelope for the given ids (plan Task 23):
    /// secret variable values are blanked, referenced request-library entries
    /// are carried along, env sets lose their whole secret table.
    async fn export_workflows(
        &self,
        ids: Vec<String>,
    ) -> ManagerResult<transfer::WorkflowExportFile>;
    /// Import one workflow export envelope (plan Task 23): shape validation,
    /// confirm-scripts semantics, name dedupe and id remapping happen before
    /// anything is written; envelope extension entries never overwrite.
    async fn import_workflows(
        &self,
        request: WorkflowImportRequest,
    ) -> ManagerResult<WorkflowImportResult>;
    async fn flow_script_dry_run(
        &self,
        request: FlowScriptDryRunRequest,
    ) -> ManagerResult<ScriptDryRunOutput>;
    /// Preview the rendered request of one httpReplay node (template render
    /// dry-run): the run-chain inputs are assembled from storage and the exact
    /// outgoing request is rendered in a throwaway VM — zero outbound traffic,
    /// nothing persisted, preProcess scripts are not executed.
    async fn flow_render_preview(
        &self,
        request: FlowRenderPreviewRequest,
    ) -> ManagerResult<RenderPreviewOutput>;
    async fn trigger_workflow_run(
        &self,
        request: FlowRunTriggerRequest,
    ) -> ManagerResult<FlowRunRecord>;
    async fn cancel_workflow_run(&self, run_id: String) -> ManagerResult<()>;
    async fn workflow_runs(&self, query: FlowRunListQuery) -> ManagerResult<FlowRunPage>;
    async fn workflow_run_detail(&self, run_id: String) -> ManagerResult<FlowRunDetailPayload>;
    /// Poll a run server-side until it reaches a terminal state (MCP-only
    /// convenience layered on `GET /api/flow/runs/{id}`; the wait deadline is
    /// bounded so a single tool call stays under its 60s execution budget —
    /// see `mcp::tools::WAIT_TOOL_CALL_TIMEOUT`) and return a
    /// compact digest. `settled` is `false` when the deadline elapsed first.
    async fn wait_workflow_run(
        &self,
        run_id: String,
        timeout_ms: Option<u64>,
        interval_ms: Option<u64>,
    ) -> ManagerResult<FlowRunWaitPayload>;
    fn subscribe_flow_run_events(&self) -> broadcast::Receiver<FlowRunEvent>;
    async fn request_library_page(
        &self,
        query: RequestLibraryQuery,
    ) -> ManagerResult<RequestLibraryPage>;
    async fn request_library_entry(&self, id: String) -> ManagerResult<RequestLibraryEntry>;
    async fn create_request_library_entry(
        &self,
        request: CreateRequestLibraryRequest,
    ) -> ManagerResult<RequestLibraryEntry>;
    async fn update_request_library_entry(
        &self,
        id: String,
        request: UpdateRequestLibraryRequest,
    ) -> ManagerResult<RequestLibraryEntry>;
    async fn delete_request_library_entry(&self, id: String) -> ManagerResult<()>;
    async fn ingest_request_from_capture(
        &self,
        request: IngestCaptureRequest,
    ) -> ManagerResult<RequestLibraryEntry>;
    async fn request_library_body_source(
        &self,
        id: String,
        max_size: u64,
    ) -> ManagerResult<BodySource>;
    async fn env_sets(&self) -> ManagerResult<EnvSetsPayload>;
    async fn create_env_set(&self, request: CreateEnvSetRequest) -> ManagerResult<EnvVariableSet>;
    async fn save_env_set(
        &self,
        id: String,
        request: SaveEnvSetRequest,
    ) -> ManagerResult<EnvVariableSet>;
    /// MCP 侧受限保存：仅替换普通表与名称，secret 表（键级掩码标记）
    /// 原样保留——标记对 MCP 只读，改动须经桌面 UI / HTTP 侧的
    /// `save_env_set`（含 `******` 掩码恢复约定）。
    async fn save_env_set_values(
        &self,
        id: String,
        name: String,
        values: BTreeMap<String, String>,
    ) -> ManagerResult<EnvVariableSet>;
    async fn delete_env_set(&self, id: String) -> ManagerResult<()>;
    async fn replace_active_env_set(
        &self,
        request: ReplaceActiveEnvSetRequest,
    ) -> ManagerResult<Option<String>>;
    async fn replace_env_globals(
        &self,
        request: ReplaceEnvGlobalsRequest,
    ) -> ManagerResult<EnvGlobalVariables>;
    async fn env_write_back(
        &self,
        request: EnvWriteBackRequest,
    ) -> ManagerResult<EnvWriteBackResult>;
    // ---- 工作流存储（工作流级持久化 KV，与 env 家族同域异用）----
    /// 读一个工作流的全部存储条目（按键字典序）。目标工作流不存在 → 404。
    async fn workflow_storage(&self, workflow_id: String) -> ManagerResult<WorkflowStoragePayload>;
    /// 实时写入一个键并持久化（put 即落盘；配额/键名违规 → 400）。
    async fn workflow_storage_put(
        &self,
        workflow_id: String,
        key: String,
        request: WorkflowStoragePutRequest,
    ) -> ManagerResult<WorkflowStoragePayload>;
    /// 删除一个键（缺键 → 404），返回刷新后的全量载荷。
    async fn workflow_storage_delete_key(
        &self,
        workflow_id: String,
        key: String,
    ) -> ManagerResult<WorkflowStoragePayload>;
    /// 清空一个工作流的全部存储条目，返回清空后的（空）载荷。
    async fn workflow_storage_clear(
        &self,
        workflow_id: String,
    ) -> ManagerResult<WorkflowStoragePayload>;
    async fn mcp_tiers(&self) -> ManagerResult<McpTiers>;
    async fn replace_mcp_tiers(&self, tiers: McpTiers) -> ManagerResult<McpTiers>;
    /// 追加一条 MCP 工具调用审计（plan Task 25 Step 4）。调用方（MCP 工具
    /// 链）以 best-effort 语义使用：追加失败只告警，不阻断工具调用。
    async fn append_mcp_audit(&self, entry: McpAuditEntry) -> ManagerResult<()>;
    /// 查询 MCP 工具调用审计条目（seq 倒序，最新在前）。
    async fn mcp_audit(&self, limit: usize) -> ManagerResult<Vec<McpAuditEntry>>;
    /// 当前 MCP 暴露档位下 `tools/list` 会出现的工具数（桌面
    /// `get_mcp_tool_count`；与 `POST /mcp` `tools/list` 同源过滤）。
    async fn mcp_tool_count(&self) -> ManagerResult<usize>;
}

#[derive(Clone)]
pub struct MitmManager {
    imports: Arc<crate::bundle::BundleImports>,
    forced_redaction: Option<Script>,
    read_policy: Option<ReadPolicy>,
    runtime: Arc<ProxyCrab>,
    agents: Arc<AgentsStore>,
    clash_subscription: Arc<ClashSubscription>,
    flow_runs: Arc<FlowRunManager>,
    blocking_tasks: Arc<Semaphore>,
}

enum PreparedFilter {
    All,
    Column {
        column: FilterColumn,
        input: String,
        regex: Option<Regex>,
        script: Option<PreparedColumnScript>,
    },
    Script {
        script: PreparedFilterScript,
        input: String,
    },
}

struct PreparedColumnScript {
    evaluator: Result<ColumnEvaluator, String>,
}

struct PreparedFilterScript {
    evaluator: Result<FilterEvaluator, String>,
}

impl MitmManager {
    pub fn new(runtime: Arc<ProxyCrab>) -> Arc<Self> {
        let agents = Arc::new(AgentsStore::new(runtime.workspace().root()));
        if let Err(error) = agents.initialize() {
            tracing::error!("failed to initialize AGENTS.md presets: {error}");
        }
        let clash_subscription = Arc::new(ClashSubscription::new(runtime.workspace().root()));
        // 运行记录库随管理器打开（收敛孤儿 `running` 行；打开失败只记日志，
        // 运行类接口统一报「运行记录库不可用」）。
        let flow_runs = Arc::new(FlowRunManager::open(
            runtime.workspace().root().to_path_buf(),
            runtime.clone(),
        ));
        Arc::new(Self {
            imports: Arc::new(crate::bundle::BundleImports::default()),
            forced_redaction: None,
            read_policy: None,
            runtime,
            agents,
            clash_subscription,
            flow_runs,
            blocking_tasks: Arc::new(Semaphore::new(MAX_BLOCKING_MANAGEMENT_TASKS)),
        })
    }

    /// Pin a validated, process-local policy that overrides identity and share bindings.
    pub fn with_forced_redaction(&self, script: Script) -> ManagerResult<Arc<Self>> {
        proxy_crab_mitm::lua::redaction::RedactionEvaluator::new(&script.content, &script.name)
            .map_err(|error| ManagerError::bad_request(error.to_string()))?;
        let mut manager = self.clone();
        manager.forced_redaction = Some(script);
        Ok(Arc::new(manager))
    }

    fn ensure_redaction_management_enabled(&self) -> ManagerResult<()> {
        if self.forced_redaction.is_some() {
            return Err(ManagerError::new(
                ErrorCode::RedactionManagementDisabled,
                "脱敏接口管理功能已禁用",
            ));
        }
        Ok(())
    }

    pub fn runtime(&self) -> &Arc<ProxyCrab> {
        &self.runtime
    }

    async fn run_blocking<T, F>(&self, name: &'static str, task: F) -> ManagerResult<T>
    where
        T: Send + 'static,
        F: FnOnce() -> ManagerResult<T> + Send + 'static,
    {
        let permit = self
            .blocking_tasks
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ManagerError::internal("management task limiter closed"))?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            task()
        })
        .await
        .map_err(|error| ManagerError::internal(format!("{name} task failed: {error}")))?
    }

    fn session_id(&self, requested: Option<u64>) -> ManagerResult<u64> {
        requested
            .or_else(|| self.runtime.active_session_id())
            .ok_or_else(|| ManagerError::conflict("no active Session"))
    }

    fn render_builtin_cell(column: &Column, item: &CaptureSummary) -> Option<String> {
        match column {
            Column::Method { .. } => Some(item.request.method.clone()),
            Column::Uri { .. } => Some(item.request.uri.clone()),
            Column::Code { .. } => item
                .response
                .as_ref()
                .map(|response| response.status.to_string())
                .or_else(|| Some("...".into())),
            Column::Source { .. } => Some(item.source.clone()),
            Column::Stage { .. } => Some(item.stage.clone()),
            Column::CreatedAt { .. } => Some(item.created_at.to_string()),
            Column::UpdatedAt { .. } => Some(item.updated_at.to_string()),
            Column::Script { .. } => None,
        }
    }

    fn capture_body_access(runtime: &Arc<ProxyCrab>, item: &CaptureSummary) -> CaptureBodyAccess {
        let runtime = runtime.clone();
        let session_id = item.session_id;
        let capture_id = item.id;
        CaptureBodyAccess::new(move |side| {
            runtime.capture_body_source(session_id, capture_id, side)
        })
    }

    fn prepare_filter(
        runtime: &ProxyCrab,
        filter: &SessionFilter,
    ) -> ManagerResult<PreparedFilter> {
        if filter.input.is_empty() {
            return Ok(PreparedFilter::All);
        }
        match &filter.option {
            None => Ok(PreparedFilter::All),
            Some(FilterOption::Column { column, regex }) => {
                let script = match column {
                    FilterColumn::Script { script_name } => {
                        let script = runtime
                            .script(ScriptKind::Column, script_name)
                            .map_err(map_error)?;
                        Some(PreparedColumnScript {
                            evaluator: ColumnEvaluator::new(&script.content, &script.name)
                                .map_err(|error| error.to_string()),
                        })
                    }
                    _ => None,
                };
                Ok(PreparedFilter::Column {
                    column: column.clone(),
                    input: filter.input.clone(),
                    regex: regex
                        .then(|| Regex::new(&filter.input))
                        .transpose()
                        .map_err(|error| ManagerError::bad_request(error.to_string()))?,
                    script,
                })
            }
            Some(FilterOption::Script { script_name }) => {
                let script = runtime
                    .script(ScriptKind::Filter, script_name)
                    .map_err(map_error)?;
                Ok(PreparedFilter::Script {
                    script: PreparedFilterScript {
                        evaluator: FilterEvaluator::new(&script.content, &script.name)
                            .map_err(|error| error.to_string()),
                    },
                    input: filter.input.clone(),
                })
            }
        }
    }

    fn matches_filter<F>(filter: &PreparedFilter, item: &CaptureSummary, body_access: F) -> bool
    where
        F: FnOnce() -> CaptureBodyAccess,
    {
        match filter {
            PreparedFilter::All => true,
            PreparedFilter::Script { script, input } => {
                let Ok(evaluator) = &script.evaluator else {
                    return false;
                };
                evaluator
                    .evaluate_with_bodies(input, item, body_access())
                    .unwrap_or(false)
            }
            PreparedFilter::Column {
                column,
                input,
                regex,
                script,
            } => {
                let value = match column {
                    FilterColumn::Method => item.request.method.clone(),
                    FilterColumn::Uri => item.request.uri.clone(),
                    FilterColumn::Code => item
                        .response
                        .as_ref()
                        .map(|response| response.status.to_string())
                        .unwrap_or_else(|| "...".into()),
                    FilterColumn::Source => item.source.clone(),
                    FilterColumn::Stage => item.stage.clone(),
                    FilterColumn::Script { .. } => {
                        let Some(script) = script else {
                            return false;
                        };
                        let Ok(evaluator) = &script.evaluator else {
                            return false;
                        };
                        let Ok(value) = evaluator.evaluate_with_bodies(item, body_access()) else {
                            return false;
                        };
                        value
                    }
                };
                regex
                    .as_ref()
                    .map_or_else(|| value.contains(input), |regex| regex.is_match(&value))
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn classify_log_id<F>(
        filter: &PreparedFilter,
        item: &CaptureSummary,
        active_ids: &BTreeSet<u64>,
        body_access: F,
        matched_ids: &mut Vec<u64>,
        in_progress_ids: &mut Vec<u64>,
        redactor: Option<&ReadRedactor>,
        runtime: &Arc<ProxyCrab>,
    ) -> ManagerResult<()>
    where
        F: FnOnce() -> CaptureBodyAccess,
    {
        let mut sanitized = None;
        let mut sanitized_bodies = None;
        let mut sanitized_view = None;
        if let Some(redactor) = redactor {
            match filter {
                PreparedFilter::Column {
                    column: FilterColumn::Uri,
                    ..
                } => {
                    let mut value = item.clone();
                    value.request.uri = redactor.uri(&item.request.uri)?;
                    sanitized = Some(value);
                }
                PreparedFilter::Script { .. }
                | PreparedFilter::Column {
                    column: FilterColumn::Script { .. },
                    ..
                } => {
                    let view = redactor.view(runtime, item)?;
                    sanitized_bodies = Some(view.body_access());
                    sanitized = Some(view.summary());
                    sanitized_view = Some(view);
                }
                _ => {}
            }
        }
        let matched = Self::matches_filter(filter, sanitized.as_ref().unwrap_or(item), || {
            sanitized_bodies.unwrap_or_else(body_access)
        });
        if let Some(view) = sanitized_view {
            view.ensure_success().map_err(|_| redaction::failed())?;
        }
        if matched {
            matched_ids.push(item.id);
        }
        if item.outcome == CaptureOutcome::InProgress && active_ids.contains(&item.id) {
            in_progress_ids.push(item.id);
        }
        Ok(())
    }
}

/// One compiled log-search predicate: substring by default, exact
/// (case-insensitive) for method/status, or Rust regex with `regex = true`.
enum SearchMatcher {
    Substring(String),
    Exact(String),
    Regex(Regex),
}

impl SearchMatcher {
    fn compile(value: &str, regex: bool, exact: bool) -> ManagerResult<Self> {
        if regex {
            return Ok(Self::Regex(
                Regex::new(value).map_err(|error| ManagerError::bad_request(error.to_string()))?,
            ));
        }
        if exact {
            return Ok(Self::Exact(value.to_uppercase()));
        }
        Ok(Self::Substring(value.to_owned()))
    }

    fn is_match(&self, value: &str) -> bool {
        match self {
            Self::Substring(pattern) => value.contains(pattern.as_str()),
            Self::Exact(pattern) => value.to_uppercase().contains(pattern.as_str()),
            Self::Regex(regex) => regex.is_match(value),
        }
    }
}

/// Compiled AND-composed predicates of one capture-log search
/// (`POST /api/logs/search`): every provided field must match, absent (or
/// empty) fields are ignored — unlike the session filter, a bare or empty
/// `keyword` never degrades to "match everything".
struct PreparedLogSearch {
    host: Option<SearchMatcher>,
    path: Option<SearchMatcher>,
    method: Option<SearchMatcher>,
    status: Option<SearchMatcher>,
    keyword: Option<SearchMatcher>,
}

impl PreparedLogSearch {
    fn compile(request: &LogSearchRequest) -> ManagerResult<Self> {
        fn one(
            value: &Option<String>,
            regex: bool,
            exact: bool,
        ) -> ManagerResult<Option<SearchMatcher>> {
            match value.as_deref() {
                Some(value) if !value.is_empty() => {
                    Ok(Some(SearchMatcher::compile(value, regex, exact)?))
                }
                _ => Ok(None),
            }
        }
        let regex = request.regex;
        Ok(Self {
            host: one(&request.host, regex, false)?,
            path: one(&request.path, regex, false)?,
            keyword: one(&request.keyword, regex, false)?,
            method: one(&request.method, regex, true)?,
            status: one(&request.status, regex, true)?,
        })
    }

    /// AND-composition over the capture summary; `uri` is passed in already
    /// redacted for redaction-bound readers.
    fn matches(&self, item: &CaptureSummary, uri: &str) -> bool {
        if let Some(matcher) = &self.host
            && !matcher.is_match(uri)
        {
            return false;
        }
        if let Some(matcher) = &self.path
            && !matcher.is_match(uri)
        {
            return false;
        }
        if let Some(matcher) = &self.keyword
            && !matcher.is_match(uri)
        {
            return false;
        }
        if let Some(matcher) = &self.method
            && !matcher.is_match(&item.request.method)
        {
            return false;
        }
        if let Some(matcher) = &self.status {
            let code = item
                .response
                .as_ref()
                .map(|response| response.status.to_string())
                .unwrap_or_else(|| "...".into());
            if !matcher.is_match(&code) {
                return false;
            }
        }
        true
    }
}

#[async_trait]
impl ProxyCrabManager for MitmManager {
    async fn export_session_config(
        &self,
        id: u64,
        config: crate::bundle::ConfigShare,
    ) -> ManagerResult<Vec<u8>> {
        let runtime = self.runtime.clone();
        self.run_blocking("export configuration", move || {
            crate::bundle::export(&runtime, id, &config)
                .map_err(|e| ManagerError::bad_request(format!("{e:#}")))
        })
        .await
    }
    async fn import_bundle(
        &self,
        bytes: Vec<u8>,
        accepted: Vec<String>,
    ) -> ManagerResult<crate::bundle::ImportResult> {
        let runtime = self.runtime.clone();
        let imports = self.imports.clone();
        self.run_blocking("import bundle", move || {
            imports
                .import(&runtime, bytes, accepted)
                .map_err(|e| ManagerError::bad_request(format!("{e:#}")))
        })
        .await
    }
    async fn resolve_bundle(
        &self,
        id: String,
        resolutions: Vec<crate::bundle::Resolution>,
    ) -> ManagerResult<crate::bundle::ImportResult> {
        let runtime = self.runtime.clone();
        let imports = self.imports.clone();
        self.run_blocking("resolve bundle", move || {
            imports
                .resolve(&runtime, id, resolutions)
                .map_err(|e| ManagerError::bad_request(format!("{e:#}")))
        })
        .await
    }

    fn reader(&self, script: Option<&str>, api: &str) -> ManagerResult<Arc<dyn ProxyCrabManager>> {
        let mut reader = self.clone();
        let script = match &self.forced_redaction {
            Some(forced) => Some(forced.clone()),
            None => script
                .map(|name| {
                    self.runtime
                        .script(ScriptKind::Redaction, name)
                        .map_err(|_| redaction::failed())
                })
                .transpose()?,
        };
        reader.read_policy = script.map(|script| ReadPolicy {
            script,
            api: api.into(),
        });
        Ok(Arc::new(reader))
    }
    async fn redaction_scripts(&self) -> ManagerResult<Vec<Script>> {
        self.ensure_redaction_management_enabled()?;
        self.runtime
            .scripts(ScriptKind::Redaction)
            .map_err(map_error)
    }
    async fn redaction_script(&self, name: String) -> ManagerResult<Script> {
        self.ensure_redaction_management_enabled()?;
        self.runtime
            .script(ScriptKind::Redaction, &name)
            .map_err(map_error)
    }
    async fn create_redaction_script(&self, request: ScriptRequest) -> ManagerResult<()> {
        self.ensure_redaction_management_enabled()?;
        self.runtime
            .create_script(
                ScriptKind::Redaction,
                Script {
                    name: request.name,
                    content: request.content,
                },
            )
            .map_err(map_error)
    }
    async fn update_redaction_script(
        &self,
        name: String,
        request: UpdateScriptRequest,
    ) -> ManagerResult<()> {
        self.ensure_redaction_management_enabled()?;
        self.runtime
            .update_script(ScriptKind::Redaction, &name, request.content)
            .map_err(map_error)
    }
    async fn delete_redaction_script(&self, name: String) -> ManagerResult<()> {
        self.ensure_redaction_management_enabled()?;
        self.runtime
            .delete_script(ScriptKind::Redaction, &name)
            .map_err(map_error)
    }

    fn subscribe_proxy_status_changes(&self) -> watch::Receiver<u64> {
        self.runtime.subscribe_proxy_status_changes()
    }

    async fn asset(&self, id: String) -> ManagerResult<Asset> {
        self.runtime
            .asset(&id)
            .map_err(map_asset_error)?
            .ok_or_else(|| {
                ManagerError::new(ErrorCode::AssetNotFound, format!("asset {id} not found"))
            })
    }

    async fn begin_asset_upload(
        &self,
        id: String,
        content_type: String,
    ) -> ManagerResult<AssetUpload> {
        self.runtime
            .begin_asset_upload(&id, content_type)
            .await
            .map_err(map_asset_error)
    }

    async fn config(&self) -> ManagerResult<AppConfig> {
        Ok(self.runtime.config())
    }

    async fn replace_config(&self, config: AppConfig) -> ManagerResult<AppConfig> {
        self.runtime.replace_config(config).await.map_err(map_error)
    }

    async fn agents_presets(&self) -> ManagerResult<AgentsPresetState> {
        let agents = self.agents.clone();
        self.run_blocking("AGENTS.md preset", move || {
            agents.state().map_err(map_error)
        })
        .await
    }

    async fn agents_markdown(&self) -> ManagerResult<String> {
        let agents = self.agents.clone();
        self.run_blocking("AGENTS.md", move || {
            agents.active_markdown().map_err(map_error)
        })
        .await
    }

    async fn create_agents_preset(
        &self,
        request: CreateAgentsPresetRequest,
    ) -> ManagerResult<AgentsPresetState> {
        let agents = self.agents.clone();
        self.run_blocking("AGENTS.md preset", move || {
            agents.create(request.name).map_err(map_error)
        })
        .await
    }

    async fn update_agents_preset(
        &self,
        id: String,
        request: UpdateAgentsPresetRequest,
    ) -> ManagerResult<AgentsPresetState> {
        let agents = self.agents.clone();
        self.run_blocking("AGENTS.md preset", move || {
            agents
                .update(&id, request.name, request.content)
                .map_err(map_error)
        })
        .await
    }

    async fn activate_agents_preset(&self, id: String) -> ManagerResult<AgentsPresetState> {
        let agents = self.agents.clone();
        self.run_blocking("AGENTS.md preset", move || {
            agents.activate(&id).map_err(map_error)
        })
        .await
    }

    async fn delete_agents_preset(&self, id: String) -> ManagerResult<AgentsPresetState> {
        let agents = self.agents.clone();
        self.run_blocking("AGENTS.md preset", move || {
            agents.delete(&id).map_err(map_error)
        })
        .await
    }

    async fn reimport_default_agents_presets(&self) -> ManagerResult<AgentsPresetState> {
        let agents = self.agents.clone();
        self.run_blocking("AGENTS.md preset", move || {
            agents.reimport_defaults().map_err(map_error)
        })
        .await
    }

    async fn proxy_status(&self) -> ManagerResult<ProxyStatus> {
        Ok(self.runtime.proxy_status())
    }

    async fn start_proxy(&self) -> ManagerResult<ProxyStatus> {
        self.runtime.start_proxy().await.map_err(map_error)
    }

    async fn stop_proxy(&self) -> ManagerResult<ProxyStatus> {
        self.runtime.stop_proxy().await.map_err(map_error)
    }

    async fn sessions(&self) -> ManagerResult<SessionsPayload> {
        Ok(SessionsPayload {
            sessions: self.runtime.sessions(),
            active_session_id: self.runtime.active_session_id(),
        })
    }

    async fn archived_sessions(&self) -> ManagerResult<Vec<SessionMetadata>> {
        Ok(self.runtime.archived_sessions())
    }

    async fn replace_active_session(&self, active: ActiveSession) -> ManagerResult<ActiveSession> {
        self.runtime
            .replace_active_session(active.session_id)
            .await
            .map_err(map_error)?;
        Ok(active)
    }

    async fn create_session(
        &self,
        request: CreateSessionRequest,
    ) -> ManagerResult<SessionMetadata> {
        self.runtime
            .create_session(NewSession {
                name: request.name,
                description: request.description,
                view: request.view,
                interceptors: request.interceptors,
            })
            .map_err(map_error)
    }

    async fn update_session(
        &self,
        id: u64,
        request: UpdateSessionRequest,
    ) -> ManagerResult<SessionMetadata> {
        self.runtime
            .update_session(id, request.name, request.description)
            .map_err(map_error)
    }

    async fn archive_session(&self, id: u64) -> ManagerResult<SessionMetadata> {
        self.runtime.archive_session(id).await.map_err(map_error)
    }

    async fn restore_session(&self, id: u64) -> ManagerResult<SessionMetadata> {
        self.runtime.restore_session(id).await.map_err(map_error)
    }

    async fn delete_archived_session(&self, id: u64) -> ManagerResult<()> {
        self.runtime
            .delete_archived_session(id)
            .await
            .map_err(map_error)
    }

    async fn log_ids(&self, request: LogIdsRequest) -> ManagerResult<LogIdsPayload> {
        const DEFAULT_LIMIT: usize = 10_000;
        const MAX_IDS: usize = 10_000;
        const SCAN_PAGE_SIZE: usize = 512;

        let session_id = self.session_id(request.session_id)?;
        let limit = request.limit.unwrap_or(DEFAULT_LIMIT).min(DEFAULT_LIMIT);
        if request.ids.is_some() && (request.min_id.is_some() || request.max_id.is_some()) {
            return Err(ManagerError::bad_request(
                "ids cannot be combined with min_id or max_id",
            ));
        }
        if request.ids.as_ref().is_some_and(|ids| ids.len() > MAX_IDS) {
            return Err(ManagerError::bad_request(format!(
                "at most {MAX_IDS} log IDs may be requested"
            )));
        }
        let ascending = request.min_id.is_some() && request.max_id.is_none();
        let filter = request.filter.unwrap_or_default();
        let active_ids = match self.runtime.proxy_status() {
            ProxyStatus::Running { active_netlog, .. } => active_netlog
                .get(&session_id)
                .into_iter()
                .flatten()
                .copied()
                .collect(),
            _ => BTreeSet::new(),
        };
        let runtime = self.runtime.clone();
        let requested_ids = request.ids;
        let min_id = request.min_id;
        let max_id = request.max_id;
        let policy = self.read_policy.clone();
        self.run_blocking("log ID", move || {
            let prepared = Self::prepare_filter(&runtime, &filter)?;
            let needs_redaction = matches!(
                &prepared,
                PreparedFilter::Script { .. }
                    | PreparedFilter::Column {
                        column: FilterColumn::Uri | FilterColumn::Script { .. },
                        ..
                    }
            );
            let redactor = if needs_redaction {
                ReadRedactor::prepare(&policy)?
            } else {
                None
            };
            let mut matched_ids = Vec::with_capacity(limit);
            let mut in_progress_ids = Vec::new();
            if let Some(ids) = requested_ids {
                let unique_ids = ids.into_iter().collect::<BTreeSet<_>>();
                let mut summaries = HashMap::new();
                for ids in unique_ids
                    .iter()
                    .copied()
                    .collect::<Vec<_>>()
                    .chunks(SCAN_PAGE_SIZE)
                {
                    for item in runtime.captures(session_id, ids).map_err(map_error)? {
                        summaries.insert(item.id, item);
                    }
                }
                for id in unique_ids.into_iter().rev() {
                    if let Some(item) = summaries.get(&id) {
                        Self::classify_log_id(
                            &prepared,
                            item,
                            &active_ids,
                            || Self::capture_body_access(&runtime, item),
                            &mut matched_ids,
                            &mut in_progress_ids,
                            redactor.as_ref(),
                            &runtime,
                        )?;
                    }
                }
            } else if limit == 0 {
                // A zero limit is useful for validating a filter without scanning logs.
            } else if matches!(prepared, PreparedFilter::All) {
                for item in runtime
                    .list_captures_range(session_id, limit, min_id, max_id, ascending)
                    .map_err(map_error)?
                {
                    Self::classify_log_id(
                        &prepared,
                        &item,
                        &active_ids,
                        || Self::capture_body_access(&runtime, &item),
                        &mut matched_ids,
                        &mut in_progress_ids,
                        redactor.as_ref(),
                        &runtime,
                    )?;
                }
            } else {
                let mut min_id = min_id;
                let mut max_id = max_id;
                'scan: while matched_ids.len() < limit {
                    let page = runtime
                        .list_captures_range(session_id, SCAN_PAGE_SIZE, min_id, max_id, ascending)
                        .map_err(map_error)?;
                    if page.is_empty() {
                        break;
                    }
                    let page_len = page.len();
                    let cursor = page.last().map(|item| item.id);
                    for item in page {
                        Self::classify_log_id(
                            &prepared,
                            &item,
                            &active_ids,
                            || Self::capture_body_access(&runtime, &item),
                            &mut matched_ids,
                            &mut in_progress_ids,
                            redactor.as_ref(),
                            &runtime,
                        )?;
                        if matched_ids.len() == limit {
                            break 'scan;
                        }
                    }
                    if page_len < SCAN_PAGE_SIZE {
                        break;
                    }
                    if ascending {
                        min_id = cursor;
                    } else {
                        max_id = cursor;
                    }
                }
            }
            Ok(LogIdsPayload {
                session_id,
                matched_ids,
                in_progress_ids,
            })
        })
        .await
    }

    async fn log_search(&self, request: LogSearchRequest) -> ManagerResult<LogSearchPayload> {
        const DEFAULT_LIMIT: usize = 200;
        const MAX_LIMIT: usize = 10_000;
        const SCAN_PAGE_SIZE: usize = 512;

        let session_id = self.session_id(request.session_id)?;
        let limit = request.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
        let ascending = request.min_id.is_some() && request.max_id.is_none();
        let runtime = self.runtime.clone();
        // 请求行（uri）会随命中回显，绑定脱敏的读取方统一先拿脱敏后的 uri。
        let redactor = ReadRedactor::prepare(&self.read_policy)?;
        self.run_blocking("log search", move || {
            let prepared = PreparedLogSearch::compile(&request)?;
            let mut matches = Vec::new();
            let mut truncated = false;
            let mut next_cursor = None;
            if limit > 0 {
                let mut min_id = request.min_id;
                let mut max_id = request.max_id;
                'scan: loop {
                    let page = runtime
                        .list_captures_range(session_id, SCAN_PAGE_SIZE, min_id, max_id, ascending)
                        .map_err(map_error)?;
                    if page.is_empty() {
                        break;
                    }
                    let page_len = page.len();
                    let cursor = page.last().map(|item| item.id);
                    for item in page {
                        let uri = match &redactor {
                            Some(redactor) => redactor.uri(&item.request.uri)?,
                            None => item.request.uri.clone(),
                        };
                        if prepared.matches(&item, &uri) {
                            matches.push(LogSearchMatch {
                                id: item.id,
                                in_progress: item.outcome == CaptureOutcome::InProgress,
                                method: item.request.method.clone(),
                                uri,
                                code: item
                                    .response
                                    .as_ref()
                                    .map(|response| response.status.to_string())
                                    .unwrap_or_else(|| "...".into()),
                            });
                        }
                        if matches.len() == limit {
                            truncated = true;
                            next_cursor = Some(item.id);
                            break 'scan;
                        }
                    }
                    if page_len < SCAN_PAGE_SIZE {
                        break;
                    }
                    if ascending {
                        min_id = cursor;
                    } else {
                        max_id = cursor;
                    }
                }
            }
            Ok(LogSearchPayload {
                session_id,
                matches,
                truncated,
                next_cursor,
            })
        })
        .await
    }

    async fn log_views(&self, request: LogViewsRequest) -> ManagerResult<LogViewsPayload> {
        const MAX_LOGS: usize = 200;

        if request.logs.len() > MAX_LOGS {
            return Err(ManagerError::bad_request(format!(
                "at most {MAX_LOGS} logs may be requested"
            )));
        }
        let session_id = self.session_id(request.session_id)?;
        let runtime = self.runtime.clone();
        let policy = self.read_policy.clone();
        self.run_blocking("log view", move || {
            let redactor = ReadRedactor::prepare(&policy)?;
            let columns = match request.view {
                Some(view) => view.columns,
                None => runtime.session_view(session_id).map_err(map_error)?.columns,
            };
            if columns
                .iter()
                .any(|column| !column.width().is_finite() || column.width() <= 0.0)
            {
                return Err(ManagerError::bad_request("column width must be positive"));
            }
            let mut requested = HashMap::new();
            for item in request.logs {
                requested.insert(item.id, item.updated_at);
            }
            let ids = requested.keys().copied().collect::<Vec<_>>();
            let summaries = runtime.captures(session_id, &ids).map_err(map_error)?;
            let summaries = summaries
                .into_iter()
                .map(|item| (item.id, item))
                .collect::<HashMap<_, _>>();
            let mut scripts = HashMap::<String, Result<ColumnEvaluator, String>>::new();
            for column in &columns {
                if let Column::Script { script_name, .. } = column {
                    scripts.entry(script_name.clone()).or_insert_with(|| {
                        runtime
                            .script(ScriptKind::Column, script_name)
                            .and_then(|script| ColumnEvaluator::new(&script.content, &script.name))
                            .map_err(|error| error.to_string())
                    });
                }
            }

            let mut rows = Vec::new();
            let mut exceptions = Vec::new();
            for (id, client_updated_at) in requested {
                let Some(item) = summaries.get(&id) else {
                    exceptions.push(LogViewException {
                        id,
                        column_index: None,
                        code: "log_not_found".into(),
                        message: format!("log {id} not found"),
                    });
                    continue;
                };
                if redactor.is_none()
                    && client_updated_at.is_some_and(|updated_at| item.updated_at <= updated_at)
                {
                    continue;
                }

                let view = redactor
                    .as_ref()
                    .map(|r| r.view(&runtime, item))
                    .transpose()?;
                let output = view.as_ref().map(|v| v.summary());
                let item = output.as_ref().unwrap_or(item);
                let bodies = (!scripts.is_empty()).then(|| {
                    view.as_ref()
                        .map(|v| v.body_access())
                        .unwrap_or_else(|| Self::capture_body_access(&runtime, item))
                });
                let mut cells = Vec::with_capacity(columns.len());
                for (column_index, column) in columns.iter().enumerate() {
                    if let Some(value) = Self::render_builtin_cell(column, item) {
                        cells.push(value);
                        continue;
                    }
                    let Column::Script { script_name, .. } = column else {
                        unreachable!("all built-in columns were rendered above");
                    };
                    let result = match scripts
                        .get(script_name)
                        .expect("every script column is preloaded")
                    {
                        Ok(evaluator) => evaluator
                            .evaluate_with_bodies(
                                item,
                                bodies
                                    .as_ref()
                                    .expect("script columns require body access")
                                    .clone(),
                            )
                            .map_err(|error| error.to_string()),
                        Err(message) => Err(message.clone()),
                    };
                    match result {
                        Ok(value) => cells.push(value),
                        Err(message) => {
                            cells.push(String::new());
                            exceptions.push(LogViewException {
                                id,
                                column_index: Some(column_index),
                                code: "column_script_error".into(),
                                message,
                            });
                        }
                    }
                }
                if let Some(view) = &view {
                    view.ensure_success().map_err(|_| redaction::failed())?;
                }
                rows.push(LogViewRow {
                    id,
                    created_at: item.created_at,
                    updated_at: item.updated_at,
                    outcome: outcome_name(item.outcome).into(),
                    cells,
                });
            }
            Ok(LogViewsPayload {
                columns,
                rows,
                exceptions,
            })
        })
        .await
    }

    async fn replay(
        &self,
        session_id: u64,
        request: ReplayRequestPayload,
    ) -> ManagerResult<ReplayResult> {
        let body = match request.body {
            None => None,
            Some(ReplayBodyPayload::Text { text, charset }) => match charset.as_deref() {
                None | Some("utf8") => Some(ReplayBody::Text { text }),
                Some(other) => {
                    return Err(ManagerError::bad_request(format!(
                        "unsupported charset: {other}"
                    )));
                }
            },
            Some(ReplayBodyPayload::BodyRef {
                session_id,
                log_id,
                side,
            }) => {
                let side = match side.as_str() {
                    "request" => BodySide::Request,
                    "response" => BodySide::Response,
                    other => {
                        return Err(ManagerError::bad_request(format!(
                            "invalid body side: {other}"
                        )));
                    }
                };
                Some(ReplayBody::BodyRef {
                    session_id,
                    log_id,
                    side,
                })
            }
            Some(ReplayBodyPayload::Asset { asset_id }) => Some(ReplayBody::Asset { asset_id }),
        };
        let log_id = self
            .runtime
            .replay(
                session_id,
                ReplayRequest {
                    method: request.method,
                    url: request.url,
                    headers: request.headers,
                    body,
                },
            )
            .await
            .map_err(|error| match error {
                ReplayError::SessionNotFound => {
                    ManagerError::not_found(format!("session {session_id} not found or archived"))
                }
                ReplayError::ProxyNotRunning => {
                    ManagerError::new(ErrorCode::ProxyNotRunning, "proxy is not running")
                }
                ReplayError::BodyNotFound => {
                    ManagerError::not_found("referenced capture body not found")
                }
                ReplayError::AssetNotFound => ManagerError::not_found("referenced asset not found"),
                ReplayError::Invalid(message) => ManagerError::bad_request(message),
                ReplayError::Internal(error) => {
                    ManagerError::new(ErrorCode::ReplayFailed, error.to_string())
                }
            })?;
        Ok(ReplayResult { log_id })
    }

    async fn replay_request(&self, request: ReplayHttpRequest) -> ManagerResult<ReplayResult> {
        let session_id = self.session_id(request.session_id)?;
        let baseline = if let Some(library_id) = request.library_id.as_deref() {
            if request.method.is_some() || request.url.is_some() {
                return Err(ManagerError::bad_request(
                    "library_id cannot be combined with method or url",
                ));
            }
            if request.headers.is_some() || request.body.is_some() {
                return Err(ManagerError::bad_request(
                    "library_id replay takes header/body adjustments through `override` only",
                ));
            }
            self.replay_baseline_from_library(library_id).await?
        } else {
            let (Some(method), Some(url)) = (request.method, request.url) else {
                return Err(ManagerError::bad_request(
                    "method and url are required when library_id is absent",
                ));
            };
            ReplayRequestPayload {
                method,
                url,
                headers: request.headers.unwrap_or_default(),
                body: request.body,
            }
        };
        let payload = match request.override_ {
            Some(over) => Self::apply_replay_override(baseline, over),
            None => baseline,
        };
        self.replay(session_id, payload).await
    }

    async fn assets(&self) -> ManagerResult<Vec<proxy_crab_mitm::asset::AssetMetadata>> {
        self.runtime
            .assets()
            .map_err(|error| ManagerError::new(ErrorCode::AssetStoreFailed, error.to_string()))
    }

    async fn log(&self, session_id: Option<u64>, id: u64) -> ManagerResult<LogDetail> {
        let session_id = self.session_id(session_id)?;
        let runtime = self.runtime.clone();
        let policy = self.read_policy.clone();
        self.run_blocking("log read", move || {
            let redactor = ReadRedactor::prepare(&policy)?;
            let detail = runtime
                .capture(session_id, id)
                .map_err(map_error)?
                .ok_or_else(|| ManagerError::not_found(format!("log {id} not found")))?;
            let detail = match redactor {
                Some(ref r) => r.detail(&runtime, detail)?,
                None => detail,
            };
            let mut result = log_detail_from_capture(detail);
            result.websocket = runtime.websocket_info(session_id, id).map_err(map_error)?;
            if policy.is_some()
                && let Some(info) = &mut result.websocket
            {
                info.close_reason = None;
                // Negotiated headers must follow the same policy as the handshake.
                let handshake = runtime
                    .capture(session_id, info.handshake_log_id)
                    .map_err(map_error)?
                    .ok_or_else(|| ManagerError::not_found("handshake not found"))?;
                let safe = redactor
                    .as_ref()
                    .expect("policy redactor")
                    .detail(&runtime, handshake)?
                    .summary;
                info.subprotocol = safe
                    .response
                    .as_ref()
                    .and_then(|r| r.headers.get("sec-websocket-protocol"))
                    .and_then(|v| v.first())
                    .cloned();
                info.extensions = safe
                    .response
                    .as_ref()
                    .and_then(|r| r.headers.get("sec-websocket-extensions"))
                    .map(|v| v.join(","))
                    .unwrap_or_default();
            }
            Ok(result)
        })
        .await
    }

    async fn websocket_messages(
        &self,
        session_id: Option<u64>,
        id: u64,
        side: BodySide,
        after_id: u32,
        limit: usize,
    ) -> ManagerResult<proxy_crab_mitm::websocket::WebSocketPage> {
        if !(1..=2000).contains(&limit) {
            return Err(ManagerError::bad_request(
                "limit must be between 1 and 2000",
            ));
        }
        let sid = self.session_id(session_id)?;
        let runtime = self.runtime.clone();
        let redact = self.read_policy.is_some();
        self.run_blocking("websocket message index", move || {
            let mut page = runtime
                .websocket_messages(sid, id, side, after_id, limit)
                .map_err(map_error)?
                .ok_or_else(|| ManagerError::not_found("WebSocket connection not found"))?;
            if redact {
                for message in &mut page.messages {
                    if message.error.is_some() {
                        message.error = Some("WebSocket delivery failed".into());
                    }
                    for error in &mut message.errors {
                        error.error = "WebSocket callback failed".into();
                    }
                }
            }
            Ok(page)
        })
        .await
    }

    async fn websocket_message_body(
        &self,
        session_id: Option<u64>,
        id: u64,
        side: BodySide,
        message_id: u32,
        max_size: u64,
    ) -> ManagerResult<BodySource> {
        if message_id == 0 || max_size == 0 {
            return Err(ManagerError::bad_request(
                "message_id and max_size must be positive",
            ));
        }
        let sid = self.session_id(session_id)?;
        let runtime = self.runtime.clone();
        let policy = self.read_policy.clone();
        self.run_blocking("websocket message body", move || {
            let page = runtime
                .websocket_messages(sid, id, side, message_id - 1, 1)
                .map_err(map_error)?
                .ok_or_else(|| ManagerError::not_found("WebSocket connection not found"))?;
            let meta = page
                .messages
                .into_iter()
                .find(|m| m.id == message_id)
                .ok_or_else(|| ManagerError::not_found("message not found"))?;
            if !meta.content_available {
                return Err(ManagerError::new(
                    ErrorCode::MessageContentUnavailable,
                    "message content was omitted during capture",
                ));
            }
            if meta.size > max_size {
                return Err(ManagerError::body_too_large(meta.size, max_size));
            }
            let mut bytes = runtime
                .websocket_message_body(sid, id, side, message_id)
                .map_err(map_error)?
                .ok_or_else(|| ManagerError::not_found("message not found"))?;
            if let Some(policy) = policy {
                let summary = runtime
                    .captures(sid, &[id])
                    .map_err(map_error)?
                    .pop()
                    .ok_or_else(|| ManagerError::not_found("log not found"))?;
                let evaluator = proxy_crab_mitm::lua::redaction::RedactionEvaluator::new(
                    &policy.script.content,
                    &policy.script.name,
                )
                .map_err(|_| redaction::failed())?;
                let mut context = serde_json::to_value(&meta).map_err(|_| redaction::failed())?;
                context["session_id"] = sid.into();
                context["log_id"] = id.into();
                bytes = evaluator
                    .websocket_message(&policy.api, &summary.request.uri, side, &context, bytes)
                    .map_err(|_| redaction::failed())?
                    .ok_or_else(|| {
                        ManagerError::new(
                            ErrorCode::MessageContentHidden,
                            "message content is hidden by policy",
                        )
                    })?;
            }
            if bytes.len() as u64 > max_size {
                return Err(ManagerError::body_too_large(bytes.len() as u64, max_size));
            }
            Ok(BodySource {
                stored_size: bytes.len() as u64,
                data: proxy_crab_mitm::storage::BodySourceData::Bytes(bytes),
                path: None,
                content_type: Some(
                    if serde_json::to_value(&meta).map_err(|_| redaction::failed())?["type"]
                        == "text"
                    {
                        "text/plain; charset=utf-8"
                    } else {
                        "application/octet-stream"
                    }
                    .into(),
                ),
                content_encodings: Vec::new(),
            })
        })
        .await
    }

    async fn log_body_source(
        &self,
        session_id: Option<u64>,
        id: u64,
        side: BodySide,
    ) -> ManagerResult<BodySource> {
        let session_id = self.session_id(session_id)?;
        let runtime = self.runtime.clone();
        let policy = self.read_policy.clone();
        self.run_blocking("log body source", move || {
            if runtime
                .captures(session_id, &[id])
                .map_err(map_error)?
                .first()
                .is_some_and(|s| s.request.version.starts_with("WebSocket/"))
            {
                return Err(ManagerError::bad_request(
                    "WebSocket containers are internal; read individual messages",
                ));
            }
            let redactor = ReadRedactor::prepare(&policy)?;
            if !runtime.has_capture(session_id, id).map_err(map_error)? {
                return Err(ManagerError::new(
                    ErrorCode::LogNotFound,
                    format!("log {id} not found"),
                ));
            }
            if let Some(redactor) = redactor {
                let summary = runtime
                    .captures(session_id, &[id])
                    .map_err(map_error)?
                    .pop()
                    .ok_or_else(|| ManagerError::not_found("log not found"))?;
                return redactor
                    .view(&runtime, &summary)?
                    .body_source(side)
                    .map_err(|_| redaction::failed())?
                    .ok_or_else(|| ManagerError::new(ErrorCode::BodyNotFound, "body not found"));
            }
            runtime
                .capture_body_source(session_id, id, side)
                .map_err(|error| ManagerError::new(ErrorCode::BodyReadFailed, error.to_string()))?
                .ok_or_else(|| {
                    ManagerError::new(ErrorCode::BodyNotFound, format!("{side:?} body not found"))
                })
        })
        .await
    }

    async fn interceptor_snapshot_body_source(
        &self,
        session_id: Option<u64>,
        capture_id: u64,
        execution_id: u64,
        side: BodySide,
    ) -> ManagerResult<BodySource> {
        let session_id = self.session_id(session_id)?;
        let runtime = self.runtime.clone();
        let policy = self.read_policy.clone();
        self.run_blocking("interceptor snapshot body source", move || {
            let redactor = ReadRedactor::prepare(&policy)?;
            if let Some(redactor) = redactor {
                let (_, view) =
                    redactor.snapshot(&runtime, session_id, capture_id, execution_id)?;
                return view
                    .body_source(side)
                    .map_err(|_| redaction::failed())?
                    .ok_or_else(|| {
                        ManagerError::new(
                            ErrorCode::SnapshotBodyNotFound,
                            "snapshot body not found",
                        )
                    });
            }
            runtime
                .interceptor_snapshot_body_source(session_id, capture_id, execution_id, side)
                .map_err(|error| ManagerError::new(ErrorCode::BodyReadFailed, error.to_string()))?
                .ok_or_else(|| {
                    ManagerError::new(
                        ErrorCode::SnapshotBodyNotFound,
                        format!("interceptor execution {execution_id} snapshot body not found"),
                    )
                })
        })
        .await
    }

    async fn interceptor_script_content(
        &self,
        session_id: Option<u64>,
        capture_id: u64,
        execution_id: u64,
    ) -> ManagerResult<InterceptorScriptContent> {
        let session_id = self.session_id(session_id)?;
        let runtime = self.runtime.clone();
        self.run_blocking("interceptor script content", move || {
            runtime
                .interceptor_script_content(session_id, capture_id, execution_id)
                .map_err(map_error)?
                .ok_or_else(|| {
                    ManagerError::new(
                        ErrorCode::ExecutionNotFound,
                        format!("interceptor execution {execution_id} not found"),
                    )
                })
        })
        .await
    }

    async fn interceptor_snapshot(
        &self,
        session_id: Option<u64>,
        capture_id: u64,
        execution_id: u64,
    ) -> ManagerResult<InterceptorSnapshot> {
        let session_id = self.session_id(session_id)?;
        let runtime = self.runtime.clone();
        let policy = self.read_policy.clone();
        self.run_blocking("interceptor snapshot", move || {
            let redactor = ReadRedactor::prepare(&policy)?;
            if let Some(redactor) = redactor {
                let (snapshot, view) =
                    redactor.snapshot(&runtime, session_id, capture_id, execution_id)?;
                return redaction::snapshot_output(snapshot, &view);
            }
            runtime
                .interceptor_snapshot(session_id, capture_id, execution_id)
                .map_err(map_error)?
                .ok_or_else(|| {
                    ManagerError::new(
                        ErrorCode::SnapshotNotFound,
                        format!("interceptor execution {execution_id} has no snapshot"),
                    )
                })
        })
        .await
    }

    async fn breakpoints(&self, query: BreakpointQuery) -> ManagerResult<Vec<BreakpointSummary>> {
        let session_id = self.session_id(query.session_id)?;
        let runtime = self.runtime.clone();
        let policy = self.read_policy.clone();
        self.run_blocking("breakpoint list", move || {
            let redactor = ReadRedactor::prepare(&policy)?;
            let mut rows = runtime.breakpoints(&BreakpointListFilter {
                session_id,
                phase: query.phase,
                interceptor_name: query.interceptor_name,
            });
            if let Some(redactor) = redactor {
                for row in &mut rows {
                    row.uri = redactor.uri(&row.uri)?;
                }
            }
            Ok(rows)
        })
        .await
    }

    async fn breakpoint(&self, id: u64) -> ManagerResult<BreakpointDetailPayload> {
        let runtime = self.runtime.clone();
        let policy = self.read_policy.clone();
        self.run_blocking("breakpoint read", move || {
            let redactor = ReadRedactor::prepare(&policy)?;
            let mut detail = runtime.breakpoint(id).map_err(map_error)?;
            if let Some(redactor) = redactor {
                let live_runtime = runtime.clone();
                let view = redactor.with_sources(detail.capture.summary.clone(), move |side| {
                    live_runtime.breakpoint_body_source(id, side)
                })?;
                detail.capture.request_body = redaction::payload(
                    view.body_source(BodySide::Request)
                        .map_err(|_| redaction::failed())?,
                )?;
                detail.capture.response_body = redaction::payload(
                    view.body_source(BodySide::Response)
                        .map_err(|_| redaction::failed())?,
                )?;
                detail.capture.summary = view.summary();
                detail.breakpoint.uri = detail.capture.summary.request.uri.clone();
            }
            Ok(BreakpointDetailPayload {
                breakpoint: detail.breakpoint,
                log: log_detail_from_capture(detail.capture),
            })
        })
        .await
    }

    async fn breakpoint_body_source(&self, id: u64, side: BodySide) -> ManagerResult<BodySource> {
        let runtime = self.runtime.clone();
        let policy = self.read_policy.clone();
        self.run_blocking("breakpoint body source", move || {
            let redactor = ReadRedactor::prepare(&policy)?;
            if let Some(redactor) = redactor {
                let detail = runtime.breakpoint(id).map_err(map_error)?;
                let live_runtime = runtime.clone();
                return redactor
                    .with_sources(detail.capture.summary, move |side| {
                        live_runtime.breakpoint_body_source(id, side)
                    })?
                    .body_source(side)
                    .map_err(|_| redaction::failed())?
                    .ok_or_else(|| ManagerError::new(ErrorCode::BodyNotFound, "body not found"));
            }
            runtime
                .breakpoint_body_source(id, side)
                .map_err(map_error)?
                .ok_or_else(|| {
                    ManagerError::new(ErrorCode::BodyNotFound, format!("{side:?} body not found"))
                })
        })
        .await
    }

    async fn extend_breakpoint(
        &self,
        id: u64,
        request: ExtendBreakpointRequest,
    ) -> ManagerResult<BreakpointSummary> {
        let runtime = self.runtime.clone();
        let policy = self.read_policy.clone();
        self.run_blocking("breakpoint extend", move || {
            let redactor = ReadRedactor::prepare(&policy)?;
            let mut result = runtime
                .extend_breakpoint(id, request.timeout_ms)
                .map_err(map_error)?;
            if let Some(redactor) = redactor {
                result.uri = redactor.uri(&result.uri)?;
            }
            Ok(result)
        })
        .await
    }

    async fn release_breakpoint(&self, id: u64) -> ManagerResult<()> {
        self.runtime.release_breakpoint(id).map_err(map_error)
    }

    async fn execute_breakpoint_script(
        &self,
        id: u64,
        request: ExecuteTemporaryScriptRequest,
    ) -> ManagerResult<TemporaryExecutionResult> {
        let runtime = self.runtime.clone();
        let policy = self.read_policy.clone();
        self.run_blocking("breakpoint script", move || {
            let redactor = ReadRedactor::prepare(&policy)?;
            let mut result = runtime
                .execute_breakpoint_script(id, &request.content)
                .map_err(map_error)?;
            if let Some(redactor) = redactor {
                result.breakpoint.uri = redactor.uri(&result.breakpoint.uri)?;
            }
            Ok(result)
        })
        .await
    }

    async fn session_view(&self, session_id: Option<u64>) -> ManagerResult<SessionViewPayload> {
        let session_id = self.session_id(session_id)?;
        let view = self.runtime.session_view(session_id).map_err(map_error)?;
        Ok(SessionViewPayload {
            redaction_revision: self
                .read_policy
                .as_ref()
                .map(|p| proxy_crab_mitm::model::script_content_hash(&p.script.content)),
            session_id,
            columns: view.columns,
            filter: view.filter,
        })
    }

    async fn replace_session_filter(
        &self,
        session_id: u64,
        filter: SessionFilter,
    ) -> ManagerResult<SessionViewPayload> {
        let view = self
            .runtime
            .replace_session_filter(session_id, filter)
            .map_err(map_error)?;
        Ok(SessionViewPayload {
            redaction_revision: self
                .read_policy
                .as_ref()
                .map(|p| proxy_crab_mitm::model::script_content_hash(&p.script.content)),
            session_id,
            columns: view.columns,
            filter: view.filter,
        })
    }

    async fn replace_session_view(
        &self,
        session_id: Option<u64>,
        request: ReplaceSessionViewRequest,
    ) -> ManagerResult<SessionViewPayload> {
        let session_id = self.session_id(session_id)?;
        let view = self
            .runtime
            .replace_session_columns(session_id, request.columns)
            .map_err(map_error)?;
        Ok(SessionViewPayload {
            redaction_revision: self
                .read_policy
                .as_ref()
                .map(|p| proxy_crab_mitm::model::script_content_hash(&p.script.content)),
            session_id,
            columns: view.columns,
            filter: view.filter,
        })
    }

    async fn column_scripts(&self) -> ManagerResult<Vec<Script>> {
        self.runtime.scripts(ScriptKind::Column).map_err(map_error)
    }

    async fn create_column_script(&self, request: ScriptRequest) -> ManagerResult<()> {
        self.runtime
            .create_script(
                ScriptKind::Column,
                Script {
                    name: request.name,
                    content: request.content,
                },
            )
            .map_err(map_error)
    }

    async fn column_script(&self, name: String) -> ManagerResult<Script> {
        self.runtime
            .script(ScriptKind::Column, &name)
            .map_err(map_error)
    }

    async fn update_column_script(
        &self,
        name: String,
        request: UpdateScriptRequest,
    ) -> ManagerResult<()> {
        self.runtime
            .update_script(ScriptKind::Column, &name, request.content)
            .map_err(map_error)
    }

    async fn delete_column_script(&self, name: String) -> ManagerResult<()> {
        self.runtime
            .delete_script(ScriptKind::Column, &name)
            .map_err(map_error)
    }

    async fn filter_scripts(&self) -> ManagerResult<Vec<Script>> {
        self.runtime.scripts(ScriptKind::Filter).map_err(map_error)
    }

    async fn create_filter_script(&self, request: ScriptRequest) -> ManagerResult<()> {
        self.runtime
            .create_script(
                ScriptKind::Filter,
                Script {
                    name: request.name,
                    content: request.content,
                },
            )
            .map_err(map_error)
    }

    async fn filter_script(&self, name: String) -> ManagerResult<Script> {
        self.runtime
            .script(ScriptKind::Filter, &name)
            .map_err(map_error)
    }

    async fn update_filter_script(
        &self,
        name: String,
        request: UpdateScriptRequest,
    ) -> ManagerResult<()> {
        self.runtime
            .update_script(ScriptKind::Filter, &name, request.content)
            .map_err(map_error)
    }

    async fn delete_filter_script(&self, name: String) -> ManagerResult<()> {
        self.runtime
            .delete_script(ScriptKind::Filter, &name)
            .map_err(map_error)
    }

    async fn debug_filter_script(
        &self,
        name: String,
        request: DebugFilterScriptRequest,
    ) -> ManagerResult<bool> {
        let session_id = self.session_id(request.session_id)?;
        let runtime = self.runtime.clone();
        let policy = self.read_policy.clone();
        self.run_blocking("filter script", move || {
            let redactor = ReadRedactor::prepare(&policy)?;
            let script = runtime
                .script(ScriptKind::Filter, &name)
                .map_err(map_error)?;
            let detail = runtime
                .capture(session_id, request.log_id)
                .map_err(map_error)?
                .ok_or_else(|| {
                    ManagerError::not_found(format!("log {} not found", request.log_id))
                })?;
            let evaluator = FilterEvaluator::new(&script.content, &script.name)
                .map_err(|error| ManagerError::bad_request(error.to_string()))?;
            let view = redactor
                .as_ref()
                .map(|r| r.view(&runtime, &detail.summary))
                .transpose()?;
            let summary = view.as_ref().map(|v| v.summary()).unwrap_or(detail.summary);
            let bodies = view
                .as_ref()
                .map(|v| v.body_access())
                .unwrap_or_else(|| Self::capture_body_access(&runtime, &summary));
            let result = evaluator.evaluate_with_bodies(&request.input, &summary, bodies);
            if let Some(view) = &view {
                view.ensure_success().map_err(|_| redaction::failed())?;
            }
            result.map_err(|error| ManagerError::bad_request(error.to_string()))
        })
        .await
    }

    async fn routing_scripts(&self) -> ManagerResult<Vec<Script>> {
        self.runtime.scripts(ScriptKind::Routing).map_err(map_error)
    }

    async fn create_routing_script(&self, request: ScriptRequest) -> ManagerResult<()> {
        self.runtime
            .create_script(
                ScriptKind::Routing,
                Script {
                    name: request.name,
                    content: request.content,
                },
            )
            .map_err(map_error)
    }

    async fn routing_script(&self, name: String) -> ManagerResult<Script> {
        self.runtime
            .script(ScriptKind::Routing, &name)
            .map_err(map_error)
    }

    async fn update_routing_script(
        &self,
        name: String,
        request: UpdateScriptRequest,
    ) -> ManagerResult<()> {
        self.runtime
            .update_routing_script(&name, request.content)
            .await
            .map_err(map_error)
    }

    async fn delete_routing_script(&self, name: String) -> ManagerResult<()> {
        self.runtime
            .delete_routing_script(&name)
            .await
            .map_err(map_error)
    }

    async fn routing_selection(&self) -> ManagerResult<RoutingSelection> {
        Ok(RoutingSelection {
            name: self.runtime.config().routing_script_name,
        })
    }

    async fn replace_routing_selection(
        &self,
        selection: RoutingSelection,
    ) -> ManagerResult<RoutingSelection> {
        let name = self
            .runtime
            .replace_routing_selection(selection.name)
            .await
            .map_err(map_error)?;
        Ok(RoutingSelection { name })
    }

    async fn interceptors(&self, kind: InterceptorKind) -> ManagerResult<InterceptorLibraryList> {
        Ok(InterceptorLibraryList {
            kind,
            items: self.runtime.interceptor_library(kind).map_err(map_error)?,
        })
    }

    async fn create_interceptor(&self, request: InterceptorCreateRequest) -> ManagerResult<()> {
        let kind = interceptor_script_kind(request.kind);
        self.runtime
            .create_script(
                kind,
                Script {
                    name: request.name.clone(),
                    content: request.content,
                },
            )
            .map_err(map_error)?;
        Ok(())
    }

    async fn interceptor(
        &self,
        kind: InterceptorKind,
        name: String,
    ) -> ManagerResult<InterceptorDetail> {
        let script = self
            .runtime
            .script(interceptor_script_kind(kind), &name)
            .map_err(map_error)?;
        Ok(InterceptorDetail {
            kind,
            display_name: proxy_crab_mitm::model::script_display_name(&script.content)
                .map(str::to_owned),
            name: script.name,
            content: script.content,
        })
    }

    async fn update_interceptor(
        &self,
        kind: InterceptorKind,
        name: String,
        request: InterceptorUpdateRequest,
    ) -> ManagerResult<()> {
        let script_kind = interceptor_script_kind(kind);
        self.runtime
            .update_script(script_kind, &name, request.content)
            .map_err(map_error)?;
        Ok(())
    }

    async fn delete_interceptor(&self, kind: InterceptorKind, name: String) -> ManagerResult<()> {
        self.runtime
            .delete_script(interceptor_script_kind(kind), &name)
            .map_err(map_error)
    }

    async fn session_interceptors(
        &self,
        session_id: Option<u64>,
    ) -> ManagerResult<SessionInterceptorsPayload> {
        let session_id = self.session_id(session_id)?;
        let value = self
            .runtime
            .resolved_session_interceptors(session_id)
            .map_err(map_error)?;
        Ok(SessionInterceptorsPayload {
            session_id,
            request: value
                .request
                .into_iter()
                .map(|item| SessionInterceptorItem {
                    display_name: item.display_name,
                    name: item.name,
                    enabled: item.enabled,
                    valid: item.valid,
                })
                .collect(),
            response: value
                .response
                .into_iter()
                .map(|item| SessionInterceptorItem {
                    display_name: item.display_name,
                    name: item.name,
                    enabled: item.enabled,
                    valid: item.valid,
                })
                .collect(),
        })
    }

    async fn replace_session_interceptors(
        &self,
        session_id: Option<u64>,
        request: ReplaceSessionInterceptorsRequest,
    ) -> ManagerResult<SessionInterceptorsPayload> {
        let session_id = self.session_id(session_id)?;
        self.runtime
            .replace_session_interceptors(
                session_id,
                SessionInterceptors {
                    request: request
                        .request
                        .into_iter()
                        .map(|item| SessionInterceptor {
                            name: item.name,
                            enabled: item.enabled,
                        })
                        .collect(),
                    response: request
                        .response
                        .into_iter()
                        .map(|item| SessionInterceptor {
                            name: item.name,
                            enabled: item.enabled,
                        })
                        .collect(),
                },
            )
            .map_err(map_error)?;
        self.session_interceptors(Some(session_id)).await
    }

    async fn clash_subscription(&self) -> ManagerResult<ClashSubscriptionState> {
        Ok(self.clash_subscription.state())
    }

    async fn enable_clash_subscription(
        &self,
        request: EnableClashSubscriptionRequest,
    ) -> ManagerResult<ClashSubscriptionState> {
        self.clash_subscription.enable(&request.server)
    }

    async fn disable_clash_subscription(&self) -> ManagerResult<ClashSubscriptionState> {
        Ok(self.clash_subscription.disable())
    }

    async fn clash_subscription_yaml(&self) -> ManagerResult<String> {
        self.clash_subscription
            .yaml(self.runtime.config().proxy_port)
    }

    async fn clash_config(&self) -> ManagerResult<ClashConfig> {
        self.clash_subscription.config()
    }

    async fn save_clash_config(
        &self,
        request: SaveClashConfigRequest,
    ) -> ManagerResult<ClashConfig> {
        self.clash_subscription.save_config(&request.yaml)
    }

    async fn reset_clash_config(&self) -> ManagerResult<ClashConfig> {
        self.clash_subscription.reset_config()
    }

    async fn certificate(&self) -> ManagerResult<CertificateResponse> {
        Ok(CertificateResponse {
            pem: self.runtime.certificate_pem(),
        })
    }

    async fn regenerate_certificate(&self) -> ManagerResult<CertificateResponse> {
        self.runtime
            .regenerate_ca()
            .await
            .map(|pem| CertificateResponse { pem })
            .map_err(map_error)
    }

    async fn system_logs(&self, query: SystemLogsQuery) -> ManagerResult<Vec<SystemLogEntry>> {
        Ok(self
            .runtime
            .system_logs(query.after_seq, query.limit.unwrap_or(1000).min(10_000)))
    }

    async fn clear_system_logs(&self) -> ManagerResult<()> {
        self.runtime.clear_system_logs();
        Ok(())
    }

    async fn bypass_entries(&self, query: BypassQuery) -> ManagerResult<BypassPage> {
        let limit = query.limit.unwrap_or(200).clamp(1, 1000);
        let runtime = self.runtime.clone();
        let policy = self.read_policy.clone();
        self.run_blocking("bypass read", move || {
            let redactor = ReadRedactor::prepare(&policy)?;
            let mut rows = runtime
                .bypass_entries(limit + 1, query.before_id)
                .map_err(map_error)?;
            let has_more = rows.len() > limit;
            rows.truncate(limit);
            if let Some(redactor) = redactor {
                for row in &mut rows {
                    row.uri = redactor.uri(&row.uri)?;
                }
            }
            Ok(BypassPage { rows, has_more })
        })
        .await
    }

    async fn delete_bypass_entry(&self, id: u64) -> ManagerResult<()> {
        let runtime = self.runtime.clone();
        self.run_blocking("bypass delete", move || {
            runtime.delete_bypass_entry(id).map_err(map_error)
        })
        .await
    }

    async fn delete_bypass_entries(&self, ids: Vec<u64>) -> ManagerResult<DeleteCount> {
        let runtime = self.runtime.clone();
        self.run_blocking("bypass delete", move || {
            runtime
                .delete_bypass_entries(&ids)
                .map(|deleted| DeleteCount { deleted })
                .map_err(map_error)
        })
        .await
    }

    async fn clear_bypass_entries(&self) -> ManagerResult<DeleteCount> {
        let runtime = self.runtime.clone();
        self.run_blocking("bypass clear", move || {
            runtime
                .clear_bypass_entries()
                .map(|deleted| DeleteCount { deleted })
                .map_err(map_error)
        })
        .await
    }

    /* ---- Workflow domain (flow projects / workflows) ---- */

    async fn flow_projects(&self, query: FlowListQuery) -> ManagerResult<FlowProjectPage> {
        let flow_root = self.flow_root();
        self.run_blocking("flow project list", move || {
            let mut projects = FlowStore::open(&flow_root)
                .and_then(|store| store.list_projects())
                .map_err(map_flow_error)?;
            let total = projects.len();
            paginate(&mut projects, query);
            Ok(FlowProjectPage { projects, total })
        })
        .await
    }

    async fn create_flow_project(
        &self,
        request: FlowProjectCreateRequest,
    ) -> ManagerResult<Project> {
        let flow_root = self.flow_root();
        self.run_blocking("flow project create", move || {
            let store = FlowStore::open(&flow_root).map_err(map_flow_error)?;
            let now = now_millis();
            let project = Project {
                id: generate_flow_id("proj").map_err(map_flow_error)?,
                name: request.name,
                description: request.description,
                color: request.color,
                variables: request.variables,
                secret_variables: request.secret_variables,
                created_at: now,
                updated_at: now,
            };
            store.put_project(&project).map_err(map_flow_error)?;
            Ok(project)
        })
        .await
    }

    async fn flow_project(&self, id: String) -> ManagerResult<Project> {
        let flow_root = self.flow_root();
        self.run_blocking("flow project read", move || {
            require_flow_project(&flow_root, &id)
        })
        .await
    }

    async fn update_flow_project(
        &self,
        id: String,
        request: FlowProjectUpdateRequest,
    ) -> ManagerResult<Project> {
        let flow_root = self.flow_root();
        self.run_blocking("flow project update", move || {
            let store = FlowStore::open(&flow_root).map_err(map_flow_error)?;
            let mut project = require_flow_project(&flow_root, &id)?;
            if let Some(name) = request.name {
                project.name = name;
            }
            if let Some(description) = request.description {
                project.description = description;
            }
            if let Some(color) = request.color {
                project.color = color;
            }
            if let Some(variables) = request.variables {
                project.variables = variables;
            }
            if let Some(secret_variables) = request.secret_variables {
                project.secret_variables = secret_variables;
            }
            project.updated_at = now_millis();
            store.put_project(&project).map_err(map_flow_error)?;
            Ok(project)
        })
        .await
    }

    async fn delete_flow_project(&self, id: String) -> ManagerResult<()> {
        let flow_root = self.flow_root();
        self.run_blocking("flow project delete", move || {
            let store = FlowStore::open(&flow_root).map_err(map_flow_error)?;
            require_flow_project(&flow_root, &id)?;
            store.delete_project(&id).map_err(map_flow_error)
        })
        .await
    }

    async fn workflows(&self, query: WorkflowListQuery) -> ManagerResult<WorkflowPage> {
        let flow_root = self.flow_root();
        self.run_blocking("workflow list", move || {
            let mut workflows = FlowStore::open(&flow_root)
                .and_then(|store| store.list_workflows())
                .map_err(map_flow_error)?;
            if let Some(project_id) = query.project_id.as_deref() {
                workflows.retain(|workflow| workflow.project_id == project_id);
            }
            let total = workflows.len();
            paginate(
                &mut workflows,
                FlowListQuery {
                    limit: query.limit,
                    offset: query.offset,
                },
            );
            Ok(WorkflowPage { workflows, total })
        })
        .await
    }

    async fn create_workflow(&self, request: WorkflowCreateRequest) -> ManagerResult<Workflow> {
        let flow_root = self.flow_root();
        self.run_blocking("workflow create", move || {
            let store = FlowStore::open(&flow_root).map_err(map_flow_error)?;
            let now = now_millis();
            let workflow = Workflow {
                id: generate_flow_id("wf").map_err(map_flow_error)?,
                project_id: request.project_id,
                name: request.name,
                description: request.description,
                nodes: request.nodes,
                edges: request.edges,
                variables: request.variables,
                secret_variables: request.secret_variables,
                // put_workflow persists at the current schema version; mirror it
                // on the returned document.
                schema_version: WORKFLOW_SCHEMA_VERSION,
                created_at: now,
                updated_at: now,
            };
            store.put_workflow(&workflow).map_err(map_flow_error)?;
            Ok(workflow)
        })
        .await
    }

    async fn workflow(&self, id: String) -> ManagerResult<Workflow> {
        let flow_root = self.flow_root();
        self.run_blocking("workflow read", move || require_workflow(&flow_root, &id))
            .await
    }

    async fn update_workflow(
        &self,
        id: String,
        request: WorkflowUpdateRequest,
    ) -> ManagerResult<Workflow> {
        if request.nodes.is_some() != request.edges.is_some() {
            return Err(ManagerError::bad_request(
                "workflow graph update requires both nodes and edges",
            ));
        }
        let flow_root = self.flow_root();
        self.run_blocking("workflow update", move || {
            let store = FlowStore::open(&flow_root).map_err(map_flow_error)?;
            let mut workflow = require_workflow(&flow_root, &id)?;
            if let Some(project_id) = request.project_id {
                workflow.project_id = project_id;
            }
            if let Some(name) = request.name {
                workflow.name = name;
            }
            if let Some(description) = request.description {
                workflow.description = description;
            }
            if let Some(nodes) = request.nodes {
                workflow.nodes = nodes;
            }
            if let Some(edges) = request.edges {
                workflow.edges = edges;
            }
            if let Some(variables) = request.variables {
                workflow.variables = variables;
            }
            if let Some(secret_variables) = request.secret_variables {
                workflow.secret_variables = secret_variables;
            }
            workflow.updated_at = now_millis();
            store.put_workflow(&workflow).map_err(map_flow_error)?;
            Ok(workflow)
        })
        .await
    }

    async fn patch_workflow(
        &self,
        id: String,
        request: WorkflowPatchRequest,
    ) -> ManagerResult<WorkflowPatchResult> {
        let flow_root = self.flow_root();
        self.run_blocking("workflow patch", move || {
            let store = FlowStore::open(&flow_root).map_err(map_flow_error)?;
            let mut workflow = require_workflow(&flow_root, &id)?;
            // 应用补丁（纯 JSON 层操作，id 级冲突在应用前拒绝），再按运行
            // 门禁同款口径做结构校验，全过后才落盘。
            let result = apply_workflow_patch(&workflow, &request)?;
            workflow.nodes = result.nodes;
            workflow.edges = result.edges;
            let issues = validate_workflow_graph(&workflow.nodes, &workflow.edges);
            let blocking: Vec<&ValidationIssue> = issues
                .iter()
                .filter(|issue| issue.severity == ValidationSeverity::Error)
                .collect();
            if !blocking.is_empty() {
                let detail = blocking
                    .iter()
                    .map(|issue| issue.message.clone())
                    .collect::<Vec<_>>()
                    .join("；");
                return Err(ManagerError::new(
                    ErrorCode::WorkflowGraphInvalid,
                    format!("workflow graph patch leaves the graph invalid: {detail}"),
                ));
            }
            workflow.updated_at = now_millis();
            store.put_workflow(&workflow).map_err(map_flow_error)?;
            Ok(WorkflowPatchResult {
                id: workflow.id,
                project_id: workflow.project_id,
                name: workflow.name,
                node_count: workflow.nodes.len(),
                edge_count: workflow.edges.len(),
                added_node_ids: result.added_node_ids,
                updated_node_ids: result.updated_node_ids,
                removed_node_ids: result.removed_node_ids,
                added_edge_ids: result.added_edge_ids,
                updated_edge_ids: result.updated_edge_ids,
                removed_edge_ids: result.removed_edge_ids,
            })
        })
        .await
    }

    async fn delete_workflow(&self, id: String) -> ManagerResult<()> {
        let flow_root = self.flow_root();
        self.run_blocking("workflow delete", move || {
            let store = FlowStore::open(&flow_root).map_err(map_flow_error)?;
            require_workflow(&flow_root, &id)?;
            store.delete_workflow(&id).map_err(map_flow_error)?;
            // 级联清理该工作流的持久化存储（best-effort：失败仅告警，不阻断
            // 定义删除——孤儿存储文件无引用，可由后续清理任务回收）。
            if let Err(error) = store.delete_workflow_data(&id) {
                tracing::warn!("failed to cascade-delete workflow storage {id}: {error:#}");
            }
            Ok(())
        })
        .await
    }

    async fn validate_workflow(&self, id: String) -> ManagerResult<Vec<WorkflowValidationIssue>> {
        let flow_root = self.flow_root();
        self.run_blocking("workflow validate", move || {
            let workflow = require_workflow(&flow_root, &id)?;
            let issues = validate_workflow_graph(&workflow.nodes, &workflow.edges);
            Ok(issues.into_iter().map(validation_issue).collect())
        })
        .await
    }

    async fn validate_workflow_deep(
        &self,
        request: WorkflowDeepValidateRequest,
    ) -> ManagerResult<Vec<WorkflowValidationIssue>> {
        let flow_root = self.flow_root();
        self.run_blocking("workflow deep validate", move || {
            let store = FlowStore::open(&flow_root).map_err(map_flow_error)?;
            // 草稿模式：原始 JSON 保留未知 config 键（供未知字段检查），typed
            // 解析在 manager 边界做（坏形状整体 400）。
            let (workflow, raw_configs) = if let Some(id) = request.id.as_deref() {
                if request.nodes.is_some() || request.edges.is_some() {
                    return Err(ManagerError::bad_request(
                        "validate either a stored workflow by id or an inline graph, not both",
                    ));
                }
                (require_workflow(&flow_root, id)?, None)
            } else {
                let (Some(raw_nodes), Some(raw_edges)) =
                    (request.nodes.as_ref(), request.edges.as_ref())
                else {
                    return Err(ManagerError::bad_request(
                        "inline deep validation requires both nodes and edges",
                    ));
                };
                let nodes: Vec<WorkflowNode> = raw_nodes
                    .iter()
                    .map(|raw| {
                        serde_json::from_value(raw.clone())
                            .map_err(|error| ManagerError::bad_request(format!("{error}")))
                    })
                    .collect::<ManagerResult<_>>()?;
                let edges: Vec<WorkflowEdge> = raw_edges
                    .iter()
                    .map(|raw| {
                        serde_json::from_value(raw.clone())
                            .map_err(|error| ManagerError::bad_request(format!("{error}")))
                    })
                    .collect::<ManagerResult<_>>()?;
                let workflow = Workflow {
                    id: String::new(),
                    project_id: String::new(),
                    name: String::new(),
                    description: String::new(),
                    nodes,
                    edges,
                    variables: request.variables.clone(),
                    secret_variables: request.secret_variables.clone(),
                    schema_version: WORKFLOW_SCHEMA_VERSION,
                    created_at: 0,
                    updated_at: 0,
                };
                (workflow, Some(raw_nodes.clone()))
            };
            let mut issues: Vec<WorkflowValidationIssue> =
                validate_workflow_graph(&workflow.nodes, &workflow.edges)
                    .into_iter()
                    .map(validation_issue)
                    .collect();
            issues.extend(
                deep_issues(&store, &workflow, raw_configs.as_deref())
                    .into_iter()
                    .map(deep_issue),
            );
            Ok(issues)
        })
        .await
    }

    /// 构造工作流导出信封（计划 Task 23）：逐 id 读取（缺失即 `404`），流程
    /// 剔除 secret 变量值（名留值空），带出流程引用到的请求库条目，环境变量
    /// 集剔除整张 secret 表；序列化为下载文件由 HTTP 层完成。
    async fn export_workflows(
        &self,
        ids: Vec<String>,
    ) -> ManagerResult<transfer::WorkflowExportFile> {
        if ids.is_empty() {
            return Err(ManagerError::bad_request(
                "workflow export requires at least one workflow id",
            ));
        }
        let flow_root = self.flow_root();
        self.run_blocking("workflow export", move || {
            let store = FlowStore::open(&flow_root).map_err(map_flow_error)?;
            let mut workflows = Vec::with_capacity(ids.len());
            let mut seen = BTreeSet::new();
            for id in &ids {
                // 重复 id 只带出一次；缺失 id 整体 404（显式导出不该静默截断）。
                if seen.insert(id.clone()) {
                    let workflow =
                        store
                            .get_workflow(id)
                            .map_err(map_flow_error)?
                            .ok_or_else(|| {
                                ManagerError::not_found(format!("workflow {id} not found"))
                            })?;
                    workflows.push(workflow);
                }
            }
            let library = store.list_requests().map_err(map_flow_error)?;
            let env_sets = store.list_env_sets().map_err(map_flow_error)?;
            Ok(transfer::build_workflow_export_file(
                &workflows,
                &transfer::collect_referenced_requests(&workflows, &library),
                &env_sets,
                now_millis(),
            ))
        })
        .await
    }

    /// 导入一份工作流导出信封（计划 Task 23）。写库前完成全部裁决：文件级
    /// 解析与逐流程形状校验（不通过的流程记 issues 跳过）、confirmScripts
    /// 脚本审查（缺省拒绝，确认集合之外全部置空）、重名消解（`(导入 N)`
    /// 后缀）与 id / refId 全量重映射；信封扩展字段（requests / envSets）
    /// 保守入库——id 冲突记原因跳过，绝不覆盖既有条目。
    async fn import_workflows(
        &self,
        request: WorkflowImportRequest,
    ) -> ManagerResult<WorkflowImportResult> {
        let WorkflowImportRequest {
            file,
            project_id,
            confirm_scripts,
            confirmed_scripts,
        } = request;
        let project_id = project_id.unwrap_or_default();
        if project_id.trim().is_empty() {
            return Err(ManagerError::bad_request(
                "workflow import requires a target projectId",
            ));
        }
        let text = file.to_string();
        // 信封扩展字段按强类型读出；请求库 / 环境集条目形状非法是客户端
        // 错误（流程本身另有逐条 issues 通道，不做整体硬失败）。
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Extensions {
            #[serde(default)]
            requests: Vec<RequestLibraryEntry>,
            #[serde(default)]
            env_sets: Vec<EnvVariableSet>,
        }
        let extensions: Extensions = serde_json::from_value(file).map_err(|error| {
            ManagerError::bad_request(format!("导出文件扩展字段形状非法：{error}"))
        })?;
        let runtime = self.runtime.clone();
        self.run_blocking("workflow import", move || {
            let mut parsed =
                transfer::parse_workflow_import(&text).map_err(ManagerError::bad_request)?;

            // 脚本逐条审查（M19 口径）：确认集合之外全部置空。未携带确认
            // （confirmScripts 缺省 false）时 confirmed 为空，等于全部拒绝。
            let mut confirmed: BTreeSet<String> = BTreeSet::new();
            if confirm_scripts {
                confirmed.extend(confirmed_scripts);
            }
            let unconfirmed: BTreeSet<String> = transfer::collect_imported_scripts(&parsed)
                .into_iter()
                .map(|script| {
                    transfer::imported_script_key(
                        script.workflow_index,
                        script.node_index,
                        script.kind,
                    )
                })
                .filter(|key| !confirmed.contains(key))
                .collect();
            for (index, workflow) in parsed.iter_mut().enumerate() {
                transfer::clear_unconfirmed_scripts(workflow, index, &unconfirmed);
            }

            let store = flow_store(&runtime)?;
            let mut result = WorkflowImportResult::default();
            let mut taken_names: BTreeSet<String> = store
                .list_workflows()
                .map_err(map_error)?
                .into_iter()
                .map(|workflow| workflow.name)
                .collect();

            // 预生成重映射阶段要消耗的 id 池（每节点一个 + 每连线一个），
            // 让 generate_flow_id 的失败在写库前以普通 500 呈现。
            let mut pending_ids = Vec::new();
            for workflow in &parsed {
                if let Some(data) = workflow.data.as_ref() {
                    for _ in 0..data.nodes.len() + data.edges.len() {
                        pending_ids.push(generate_flow_id("wf").map_err(map_error)?);
                    }
                }
            }
            let mut pending_ids = pending_ids.into_iter();
            let mut new_id = || pending_ids.next().unwrap_or_default();
            let mut new_ref_id = |taken: &BTreeSet<String>| generate_ref_id(taken);

            for (index, workflow) in parsed.iter().enumerate() {
                let Some(_) = workflow.data.as_ref() else {
                    result.skipped.push(WorkflowImportSkipped {
                        index,
                        name: workflow.name.clone(),
                        issues: workflow.issues.clone(),
                    });
                    continue;
                };
                let name = transfer::dedupe_workflow_name(&workflow.name, &taken_names);
                let item =
                    transfer::remap_imported_workflow(workflow, &mut new_id, &mut new_ref_id)
                        .map_err(ManagerError::internal)?;
                let now = unix_millis();
                let doc = Workflow {
                    id: generate_flow_id("wf").map_err(map_error)?,
                    project_id: project_id.clone(),
                    name,
                    description: item.description,
                    nodes: item.nodes,
                    edges: item.edges,
                    variables: item.variables,
                    secret_variables: item.secret_variables,
                    schema_version: WORKFLOW_SCHEMA_VERSION,
                    created_at: now,
                    updated_at: now,
                };
                store.put_workflow(&doc).map_err(map_error)?;
                taken_names.insert(doc.name.clone());
                result.imported.push(WorkflowImportCreated {
                    index,
                    id: doc.id.clone(),
                    name: doc.name.clone(),
                });
            }

            // 信封扩展字段裁决：既有条目绝不覆盖——id 冲突跳过并报告原因。
            // 请求库条目新 id 原样入库（导入流程的 requestId 引用它，原样
            // 入库才保持引用可解析）；环境变量集导入物已无 secret 表。
            for entry in &extensions.requests {
                let exists = store.get_request(&entry.id).map_err(map_error)?.is_some();
                if exists {
                    result
                        .requests
                        .skipped
                        .push(WorkflowImportExtensionSkipped {
                            id: entry.id.clone(),
                            reason: format!("请求库条目已存在，跳过导入：{}", entry.id),
                        });
                } else {
                    store.put_request(entry).map_err(map_error)?;
                    result.requests.imported += 1;
                }
            }
            let env_set_ids: BTreeSet<String> = store
                .list_env_sets()
                .map_err(map_error)?
                .into_iter()
                .map(|set| set.id)
                .collect();
            for set in &extensions.env_sets {
                if env_set_ids.contains(&set.id) {
                    result
                        .env_sets
                        .skipped
                        .push(WorkflowImportExtensionSkipped {
                            id: set.id.clone(),
                            reason: format!("环境变量集已存在，跳过导入：{}", set.id),
                        });
                } else {
                    store.save_env_set(set).map_err(map_error)?;
                    result.env_sets.imported += 1;
                }
            }
            Ok(result)
        })
        .await
    }

    /// 试跑一次 pre/post 脚本（计划 Task 18）：一次性装配 flow VM + 引擎载荷
    /// 执行，不建档、不落库、不广播；请求体（含脚本内容）也不进权限审计预览。
    /// 脚本自身失败（语法/运行时/超时/返回值非法等）以分类错误结果返回，
    /// 只有基础设施失败（VM 初始化/载荷加载）才按 500 报错。
    async fn flow_script_dry_run(
        &self,
        request: FlowScriptDryRunRequest,
    ) -> ManagerResult<ScriptDryRunOutput> {
        let sample = match request.side {
            ScriptSide::Pre => request.sample_input,
            ScriptSide::Post => request.sample_response,
        }
        .unwrap_or(JsonValue::Null);
        dry_run::dry_run_script(request.side, &request.script, sample)
            .await
            .map_err(|error| ManagerError::internal(error.to_string()))
    }

    /// 预览一次 httpReplay 节点的请求面（模板渲染 dry-run）：阻塞阶段复用运行
    /// 链装配（变量三层合并 / 激活环境集 / 存储快照 / 请求库投影 / 脱敏清单）
    /// 并做节点类型与请求基线的前提校验（404 / 422 语义），随后在一次性 VM 中
    /// 渲染「将要发出」的请求——零出站、不建档、不落库；preProcess 脚本不执行
    /// （输出附带提示，脚本验证走 flow_script_dry_run 组合）。
    async fn flow_render_preview(
        &self,
        request: FlowRenderPreviewRequest,
    ) -> ManagerResult<RenderPreviewOutput> {
        let flow_root = self.flow_root();
        let inputs = self
            .run_blocking("flow render preview load", move || {
                render_preview::load_render_preview_inputs(
                    &flow_root,
                    &request.workflow_id,
                    &request.node_id,
                    request.variable_overrides.as_ref(),
                )
                .map_err(map_render_preview_load_error)
            })
            .await?;
        render_preview::render_preview(inputs)
            .await
            .map_err(|error| ManagerError::internal(format!("flow render preview failed: {error}")))
    }

    async fn trigger_workflow_run(
        &self,
        request: FlowRunTriggerRequest,
    ) -> ManagerResult<FlowRunRecord> {
        self.flow_runs
            .trigger(
                &request.workflow_id,
                request.session_id,
                request.start_node_id,
            )
            .await
            .map_err(map_trigger_error)
    }

    async fn cancel_workflow_run(&self, run_id: String) -> ManagerResult<()> {
        if self.flow_runs.cancel(&run_id) {
            Ok(())
        } else {
            Err(ManagerError::not_found(format!(
                "workflow run {run_id} not found or already finished"
            )))
        }
    }

    async fn workflow_runs(&self, query: FlowRunListQuery) -> ManagerResult<FlowRunPage> {
        let limit = query.limit.unwrap_or(FLOW_RUN_DEFAULT_LIMIT);
        if limit == 0 || limit > FLOW_RUN_MAX_LIMIT {
            return Err(ManagerError::bad_request(format!(
                "limit must be between 1 and {FLOW_RUN_MAX_LIMIT}"
            )));
        }
        self.flow_runs
            .list_runs(
                query.workflow_id,
                query.status,
                limit,
                query.offset.unwrap_or(0),
            )
            .await
            .map(|(runs, total)| FlowRunPage { runs, total })
            .map_err(map_error)
    }

    async fn workflow_run_detail(&self, run_id: String) -> ManagerResult<FlowRunDetailPayload> {
        let detail = self
            .flow_runs
            .get_run_detail(&run_id)
            .await
            .map_err(map_error)?
            .ok_or_else(|| ManagerError::not_found(format!("workflow run {run_id} not found")))?;
        Ok(FlowRunDetailPayload {
            run: detail.run,
            node_runs: detail.node_runs,
        })
    }

    async fn wait_workflow_run(
        &self,
        run_id: String,
        timeout_ms: Option<u64>,
        interval_ms: Option<u64>,
    ) -> ManagerResult<FlowRunWaitPayload> {
        // 等待上限须为 60s 的该工具 MCP 调用硬超时留出余量（workflow_run_wait
        // 单独放宽了工具执行预算，见 mcp::tools；polling 只查主记录，终态后再
        // 取一次节点 checkpoint 组摘要）。
        const DEFAULT_TIMEOUT_MS: u64 = 20_000;
        const MAX_TIMEOUT_MS: u64 = 55_000;
        const DEFAULT_INTERVAL_MS: u64 = 500;
        const MIN_INTERVAL_MS: u64 = 50;
        const MAX_INTERVAL_MS: u64 = 60_000;
        let timeout_ms = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        if timeout_ms == 0 || timeout_ms > MAX_TIMEOUT_MS {
            return Err(ManagerError::bad_request(format!(
                "timeoutMs must be between 1 and {MAX_TIMEOUT_MS}"
            )));
        }
        let interval_ms = interval_ms.unwrap_or(DEFAULT_INTERVAL_MS);
        if !(MIN_INTERVAL_MS..=MAX_INTERVAL_MS).contains(&interval_ms) {
            return Err(ManagerError::bad_request(format!(
                "intervalMs must be between {MIN_INTERVAL_MS} and {MAX_INTERVAL_MS}"
            )));
        }
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let run = loop {
            let current = self
                .flow_runs
                .get_run(&run_id)
                .await
                .map_err(map_error)?
                .ok_or_else(|| {
                    ManagerError::not_found(format!("workflow run {run_id} not found"))
                })?;
            if flow_run_status_is_terminal(&current.status) || Instant::now() >= deadline {
                break current;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            tokio::time::sleep(remaining.min(Duration::from_millis(interval_ms))).await;
        };
        // 终态（或到点未终态）补一次 checkpoint 读取；摘要不带
        // graphSnapshot 与节点 input/output（重载荷走 workflow_run_detail）。
        let node_runs = self
            .flow_runs
            .get_run_detail(&run_id)
            .await
            .map_err(map_error)?
            .map(|detail| detail.node_runs)
            .unwrap_or_default();
        let settled = flow_run_status_is_terminal(&run.status);
        Ok(FlowRunWaitPayload {
            id: run.id,
            workflow_id: run.workflow_id,
            workflow_name: run.workflow_name,
            trigger: run.trigger,
            status: run.status,
            session_id: run.session_id,
            start_node_id: run.start_node_id,
            started_at: run.started_at,
            finished_at: run.finished_at,
            error: run.error,
            settled,
            nodes: node_runs
                .into_iter()
                .map(|node: FlowNodeRunRecord| FlowNodeRunDigest {
                    node_id: node.node_id,
                    status: node.status,
                    duration_ms: node.duration_ms,
                    error: node.error,
                })
                .collect(),
        })
    }

    fn subscribe_flow_run_events(&self) -> broadcast::Receiver<FlowRunEvent> {
        self.flow_runs.subscribe_events()
    }

    async fn request_library_page(
        &self,
        query: RequestLibraryQuery,
    ) -> ManagerResult<RequestLibraryPage> {
        let limit = query.limit.unwrap_or(REQUEST_LIBRARY_DEFAULT_LIMIT);
        if limit == 0 || limit > REQUEST_LIBRARY_MAX_LIMIT {
            return Err(ManagerError::bad_request(format!(
                "limit must be between 1 and {REQUEST_LIBRARY_MAX_LIMIT}"
            )));
        }
        let runtime = self.runtime.clone();
        self.run_blocking("request library list", move || {
            let store = flow_store(&runtime)?;
            let source = match query.source.as_deref() {
                None | Some("") => None,
                Some(value) => Some(parse_request_source(value)?),
            };
            let tags: Vec<String> = match query.tags.as_deref() {
                None | Some("") => Vec::new(),
                Some(value) => value
                    .split(',')
                    .map(str::trim)
                    .filter(|tag| !tag.is_empty())
                    .map(str::to_owned)
                    .collect(),
            };
            let needle = query
                .query
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_ascii_lowercase);
            let matched: Vec<RequestLibraryEntry> = store
                .list_requests()
                .map_err(map_error)?
                .into_iter()
                .filter(|entry| {
                    source.is_none_or(|source| entry.source == source)
                        && tags.iter().all(|tag| entry.tags.contains(tag))
                        && needle.as_deref().is_none_or(|needle| {
                            entry.name.to_ascii_lowercase().contains(needle)
                                || entry.har.log.entries.first().is_some_and(|har_entry| {
                                    har_entry.request.url.to_ascii_lowercase().contains(needle)
                                })
                        })
                })
                .collect();
            let total = matched.len();
            let entries = matched
                .into_iter()
                .skip(query.offset.unwrap_or(0))
                .take(limit)
                .collect();
            Ok(RequestLibraryPage { entries, total })
        })
        .await
    }

    async fn request_library_entry(&self, id: String) -> ManagerResult<RequestLibraryEntry> {
        let runtime = self.runtime.clone();
        self.run_blocking("request library read", move || {
            flow_store(&runtime)?
                .get_request(&id)
                .map_err(map_error)?
                .ok_or_else(|| {
                    ManagerError::not_found(format!("request library entry {id} not found"))
                })
        })
        .await
    }

    async fn create_request_library_entry(
        &self,
        request: CreateRequestLibraryRequest,
    ) -> ManagerResult<RequestLibraryEntry> {
        let runtime = self.runtime.clone();
        self.run_blocking("request library create", move || {
            flow_store(&runtime)?
                .add_request(
                    request.har,
                    RequestSource::Manual,
                    request.name.as_deref(),
                    &request.tags,
                    request.origin,
                )
                .map_err(map_error)
        })
        .await
    }

    async fn update_request_library_entry(
        &self,
        id: String,
        request: UpdateRequestLibraryRequest,
    ) -> ManagerResult<RequestLibraryEntry> {
        let runtime = self.runtime.clone();
        self.run_blocking("request library update", move || {
            flow_store(&runtime)?
                .update_request(
                    &id,
                    request.name.as_deref(),
                    request.tags.as_deref(),
                    request.origin.as_deref(),
                    request.har,
                )
                .map_err(map_error)
        })
        .await
    }

    async fn delete_request_library_entry(&self, id: String) -> ManagerResult<()> {
        let runtime = self.runtime.clone();
        self.run_blocking("request library delete", move || {
            flow_store(&runtime)?.delete_request(&id).map_err(map_error)
        })
        .await
    }

    async fn ingest_request_from_capture(
        &self,
        request: IngestCaptureRequest,
    ) -> ManagerResult<RequestLibraryEntry> {
        let runtime = self.runtime.clone();
        self.run_blocking("request library ingest", move || {
            let store = flow_store(&runtime)?;
            let session_id = match request.session_id {
                Some(session_id) => session_id,
                None => runtime
                    .active_session_id()
                    .ok_or_else(|| ManagerError::conflict("no active Session"))?,
            };
            let captured = load_captured_request(&runtime, session_id, request.capture_id)?;
            store
                .ingest_capture(&captured, request.name.as_deref(), &request.tags)
                .map_err(map_error)
        })
        .await
    }

    async fn request_library_body_source(
        &self,
        id: String,
        max_size: u64,
    ) -> ManagerResult<BodySource> {
        if max_size == 0 {
            return Err(ManagerError::bad_request(
                "max_size must be greater than zero",
            ));
        }
        let runtime = self.runtime.clone();
        self.run_blocking("request library body", move || {
            request_library_body_source(&flow_store(&runtime)?, &id, max_size)
        })
        .await
    }

    async fn env_sets(&self) -> ManagerResult<EnvSetsPayload> {
        let root = self.runtime.workspace().root().to_path_buf();
        self.run_blocking("env sets", move || {
            let store = FlowStore::open(&root).map_err(map_error)?;
            let sets = store.list_env_sets().map_err(map_error)?;
            let active_set_id = store.active_env_set_id().map_err(map_error)?;
            let globals = store.env_globals().map_err(map_error)?;
            Ok(EnvSetsPayload {
                sets: sets.iter().map(mask_env_set).collect(),
                active_set_id,
                globals: mask_globals(&globals),
            })
        })
        .await
    }

    async fn create_env_set(&self, request: CreateEnvSetRequest) -> ManagerResult<EnvVariableSet> {
        let root = self.runtime.workspace().root().to_path_buf();
        self.run_blocking("create env set", move || {
            let store = FlowStore::open(&root).map_err(map_error)?;
            let sets = store.list_env_sets().map_err(map_error)?;
            let (values, secret_values) = match request.copy_from.as_deref() {
                Some(source_id) => {
                    let source = find_env_set(&sets, source_id)?;
                    (source.values.clone(), source.secret_values.clone())
                }
                None => (request.values, request.secret_values),
            };
            let now = unix_millis();
            let set = EnvVariableSet {
                id: env_sets::next_env_set_id(&sets),
                name: request.name,
                values,
                secret_values,
                created_at: now,
                updated_at: now,
            };
            store.save_env_set(&set).map_err(map_error)?;
            Ok(mask_env_set(&set))
        })
        .await
    }

    async fn save_env_set(
        &self,
        id: String,
        request: SaveEnvSetRequest,
    ) -> ManagerResult<EnvVariableSet> {
        let root = self.runtime.workspace().root().to_path_buf();
        self.run_blocking("save env set", move || {
            let store = FlowStore::open(&root).map_err(map_error)?;
            let sets = store.list_env_sets().map_err(map_error)?;
            let existing = find_env_set(&sets, &id)?;
            // secret 表缺省（字段未传）= 存量 secret 原样保留（普通客户端 /
            // MCP 不传该字段时不得擦库）；整表提供 = 全表替换，其中掩码条目
            // 恢复存量明文、缺键删除（逐键语义见 restore_masked_secret_values）。
            let secret_values = match request.secret_values {
                None => existing.secret_values.clone(),
                Some(map) => {
                    let mut map = map;
                    restore_masked_secret_values(&mut map, &existing.secret_values);
                    map
                }
            };
            let set = EnvVariableSet {
                id,
                name: request.name,
                values: request.values,
                secret_values,
                created_at: existing.created_at,
                updated_at: unix_millis(),
            };
            store.save_env_set(&set).map_err(map_error)?;
            Ok(mask_env_set(&set))
        })
        .await
    }

    async fn delete_env_set(&self, id: String) -> ManagerResult<()> {
        let root = self.runtime.workspace().root().to_path_buf();
        self.run_blocking("delete env set", move || {
            let store = FlowStore::open(&root).map_err(map_error)?;
            store.delete_env_set(&id).map_err(map_error)
        })
        .await
    }

    async fn save_env_set_values(
        &self,
        id: String,
        name: String,
        values: BTreeMap<String, String>,
    ) -> ManagerResult<EnvVariableSet> {
        let root = self.runtime.workspace().root().to_path_buf();
        self.run_blocking("save env set values", move || {
            let store = FlowStore::open(&root).map_err(map_error)?;
            let sets = store.list_env_sets().map_err(map_error)?;
            let existing = find_env_set(&sets, &id)?;
            // secret 表（键级掩码标记）原样保留：MCP 侧标记只读。
            let set = EnvVariableSet {
                id,
                name,
                values,
                secret_values: existing.secret_values.clone(),
                created_at: existing.created_at,
                updated_at: unix_millis(),
            };
            store.save_env_set(&set).map_err(map_error)?;
            Ok(mask_env_set(&set))
        })
        .await
    }

    async fn replace_active_env_set(
        &self,
        request: ReplaceActiveEnvSetRequest,
    ) -> ManagerResult<Option<String>> {
        let root = self.runtime.workspace().root().to_path_buf();
        self.run_blocking("activate env set", move || {
            let store = FlowStore::open(&root).map_err(map_error)?;
            if let Some(id) = request.set_id.as_deref() {
                let sets = store.list_env_sets().map_err(map_error)?;
                find_env_set(&sets, id)?;
            }
            store
                .set_active_env_set(request.set_id.as_deref())
                .map_err(map_error)
        })
        .await
    }

    async fn replace_env_globals(
        &self,
        request: ReplaceEnvGlobalsRequest,
    ) -> ManagerResult<EnvGlobalVariables> {
        let root = self.runtime.workspace().root().to_path_buf();
        self.run_blocking("save env globals", move || {
            let store = FlowStore::open(&root).map_err(map_error)?;
            let current = store.env_globals().map_err(map_error)?;
            let mut secret_values = request.secret_values;
            restore_masked_secret_values(&mut secret_values, &current.secret_values);
            let globals = EnvGlobalVariables {
                values: request.values,
                secret_values,
            };
            store.save_env_globals(&globals).map_err(map_error)?;
            Ok(mask_globals(&globals))
        })
        .await
    }

    async fn env_write_back(
        &self,
        request: EnvWriteBackRequest,
    ) -> ManagerResult<EnvWriteBackResult> {
        let root = self.runtime.workspace().root().to_path_buf();
        self.run_blocking("env write-back", move || {
            let store = FlowStore::open(&root).map_err(map_error)?;
            // Committed on submit; never withdrawn on later failures or hard
            // timeouts. The flush persists serially and reports drops.
            store
                .submit_env_write_back(request.set_id, request.writes)
                .map_err(map_error)?;
            let flush = store.flush_env_write_backs().map_err(map_error)?;
            Ok(EnvWriteBackResult {
                applied: flush.applied,
                dropped: flush.dropped,
            })
        })
        .await
    }

    async fn workflow_storage(&self, workflow_id: String) -> ManagerResult<WorkflowStoragePayload> {
        let flow_root = self.flow_root();
        self.run_blocking("workflow storage read", move || {
            let store = FlowStore::open(&flow_root).map_err(map_error)?;
            require_workflow(&flow_root, &workflow_id)?;
            let entries = store
                .workflow_storage_entries(&workflow_id)
                .map_err(map_error)?;
            Ok(workflow_storage_payload(&workflow_id, entries))
        })
        .await
    }

    async fn workflow_storage_put(
        &self,
        workflow_id: String,
        key: String,
        request: WorkflowStoragePutRequest,
    ) -> ManagerResult<WorkflowStoragePayload> {
        let flow_root = self.flow_root();
        self.run_blocking("workflow storage put", move || {
            let store = FlowStore::open(&flow_root).map_err(map_error)?;
            require_workflow(&flow_root, &workflow_id)?;
            store
                .workflow_storage_put(&workflow_id, &key, &request.value)
                .map_err(map_error)?;
            let entries = store
                .workflow_storage_entries(&workflow_id)
                .map_err(map_error)?;
            Ok(workflow_storage_payload(&workflow_id, entries))
        })
        .await
    }

    async fn workflow_storage_delete_key(
        &self,
        workflow_id: String,
        key: String,
    ) -> ManagerResult<WorkflowStoragePayload> {
        let flow_root = self.flow_root();
        self.run_blocking("workflow storage delete", move || {
            let store = FlowStore::open(&flow_root).map_err(map_error)?;
            require_workflow(&flow_root, &workflow_id)?;
            store
                .workflow_storage_delete(&workflow_id, &key)
                .map_err(map_error)?;
            let entries = store
                .workflow_storage_entries(&workflow_id)
                .map_err(map_error)?;
            Ok(workflow_storage_payload(&workflow_id, entries))
        })
        .await
    }

    async fn workflow_storage_clear(
        &self,
        workflow_id: String,
    ) -> ManagerResult<WorkflowStoragePayload> {
        let flow_root = self.flow_root();
        self.run_blocking("workflow storage clear", move || {
            let store = FlowStore::open(&flow_root).map_err(map_error)?;
            require_workflow(&flow_root, &workflow_id)?;
            store
                .workflow_storage_clear(&workflow_id)
                .map_err(map_error)?;
            let entries = store
                .workflow_storage_entries(&workflow_id)
                .map_err(map_error)?;
            Ok(workflow_storage_payload(&workflow_id, entries))
        })
        .await
    }

    async fn mcp_tiers(&self) -> ManagerResult<McpTiers> {
        let root = self.runtime.workspace().root().to_path_buf();
        self.run_blocking("read mcp tiers", move || {
            FlowStore::open(&root)
                .and_then(|store| store.mcp_tiers())
                .map_err(map_error)
        })
        .await
    }

    async fn replace_mcp_tiers(&self, tiers: McpTiers) -> ManagerResult<McpTiers> {
        let root = self.runtime.workspace().root().to_path_buf();
        self.run_blocking("save mcp tiers", move || {
            let store = FlowStore::open(&root).map_err(map_error)?;
            store.save_mcp_tiers(&tiers).map_err(map_error)?;
            Ok(tiers)
        })
        .await
    }

    async fn append_mcp_audit(&self, entry: McpAuditEntry) -> ManagerResult<()> {
        let root = self.runtime.workspace().root().to_path_buf();
        self.run_blocking("append mcp audit", move || {
            FlowStore::open(&root)
                .and_then(|store| store.append_mcp_audit(&entry))
                .map_err(map_error)
        })
        .await
    }

    async fn mcp_audit(&self, limit: usize) -> ManagerResult<Vec<McpAuditEntry>> {
        let root = self.runtime.workspace().root().to_path_buf();
        self.run_blocking("read mcp audit", move || {
            FlowStore::open(&root)
                .and_then(|store| store.mcp_audit_entries(limit))
                .map_err(map_error)
        })
        .await
    }

    async fn mcp_tool_count(&self) -> ManagerResult<usize> {
        let root = self.runtime.workspace().root().to_path_buf();
        self.run_blocking("count mcp tools", move || {
            let tiers = FlowStore::open(&root)
                .and_then(|store| store.mcp_tiers())
                .map_err(map_error)?;
            Ok(crate::mcp::tools::tier_tool_count(&tiers))
        })
        .await
    }
}

/// Helpers shared by the workflow-domain manager methods: resolve the workspace
/// flow root for use inside blocking tasks.
impl MitmManager {
    fn flow_root(&self) -> std::path::PathBuf {
        self.runtime.workspace().root().to_path_buf()
    }

    /// Resolve a request-library entry into the replay baseline: the first HAR
    /// request, with blob-backed bodies read back in (the flow engine's
    /// baseline convention: base64 postData text decoded to bytes).
    async fn replay_baseline_from_library(&self, id: &str) -> ManagerResult<ReplayRequestPayload> {
        let runtime = self.runtime.clone();
        let id = id.to_owned();
        self.run_blocking("replay baseline", move || {
            let store = flow_store(&runtime)?;
            let entry = store.get_request(&id).map_err(map_error)?.ok_or_else(|| {
                ManagerError::not_found(format!("request library entry {id} not found"))
            })?;
            let har_request = entry
                .har
                .log
                .entries
                .first()
                .map(|har_entry| &har_entry.request)
                .ok_or_else(|| {
                    ManagerError::bad_request(format!(
                        "request library entry {id} carries no HAR request"
                    ))
                })?;
            let mut body_text = match &har_request.post_data {
                Some(post_data) => match (&post_data.text, post_data.encoding.as_deref()) {
                    (Some(text), Some("base64")) => {
                        let bytes = BASE64_STANDARD.decode(text).map_err(|error| {
                            ManagerError::bad_request(format!(
                                "entry {id} postData base64 decode failed: {error}"
                            ))
                        })?;
                        String::from_utf8_lossy(&bytes).into_owned()
                    }
                    (Some(text), _) => text.clone(),
                    (None, _) => String::new(),
                },
                None => String::new(),
            };
            // body 落 blob 的条目回填正文；与 flow 引擎同口径（UTF-8 lossy）。
            if body_text.is_empty()
                && let Some(bytes) = store.read_request_body(&entry).map_err(map_error)?
                && !bytes.is_empty()
            {
                body_text = String::from_utf8_lossy(&bytes).into_owned();
            }
            let body = (!body_text.is_empty()).then_some(ReplayBodyPayload::Text {
                text: body_text,
                charset: None,
            });
            Ok(ReplayRequestPayload {
                method: har_request.method.clone(),
                url: har_request.url.clone(),
                headers: har_request
                    .headers
                    .iter()
                    .map(|header| (header.name.clone(), header.value.clone()))
                    .collect(),
                body,
            })
        })
        .await
    }

    /// Apply wire overrides on top of a resolved replay baseline: method/url
    /// replacement, removed-then-applied headers (case-insensitive names),
    /// and body text replacement (charset stays UTF-8).
    fn apply_replay_override(
        mut payload: ReplayRequestPayload,
        over: ReplayOverridePayload,
    ) -> ReplayRequestPayload {
        if let Some(method) = over.method {
            payload.method = method;
        }
        if let Some(url) = over.url {
            payload.url = url;
        }
        if !over.removed_headers.is_empty() {
            let removed: BTreeSet<String> = over
                .removed_headers
                .iter()
                .map(|name| name.to_ascii_lowercase())
                .collect();
            payload
                .headers
                .retain(|(name, _)| !removed.contains(&name.to_ascii_lowercase()));
        }
        for (name, value) in over.headers {
            match payload
                .headers
                .iter_mut()
                .find(|(existing, _)| existing.eq_ignore_ascii_case(&name))
            {
                Some(slot) => slot.1 = value,
                None => payload.headers.push((name, value)),
            }
        }
        if let Some(body) = over.body {
            payload.body = Some(ReplayBodyPayload::Text {
                text: body,
                charset: None,
            });
        }
        payload
    }
}

fn require_flow_project(flow_root: &std::path::Path, id: &str) -> ManagerResult<Project> {
    FlowStore::open(flow_root)
        .and_then(|store| store.get_project(id))
        .map_err(map_flow_error)?
        .ok_or_else(|| ManagerError::not_found(format!("project {id} not found")))
}

fn require_workflow(flow_root: &std::path::Path, id: &str) -> ManagerResult<Workflow> {
    FlowStore::open(flow_root)
        .and_then(|store| store.get_workflow(id))
        .map_err(map_flow_error)?
        .ok_or_else(|| ManagerError::not_found(format!("workflow {id} not found")))
}

/// 把持久层的键 -> 条目表转成读响应载荷（条目按键字典序，BTreeMap 天然有序）。
fn workflow_storage_payload(
    workflow_id: &str,
    entries: BTreeMap<String, WorkflowStorageEntry>,
) -> WorkflowStoragePayload {
    WorkflowStoragePayload {
        workflow_id: workflow_id.to_owned(),
        entries: entries
            .into_iter()
            .map(|(key, entry)| WorkflowStorageEntryDto {
                key,
                value: entry.value,
                updated_at: entry.updated_at,
            })
            .collect(),
    }
}

/// Apply `limit`/`offset` pagination to an already sorted list.
fn paginate<T>(items: &mut Vec<T>, query: FlowListQuery) {
    let offset = query.offset.unwrap_or(0).min(items.len());
    items.drain(..offset);
    if let Some(limit) = query.limit {
        items.truncate(limit);
    }
}

fn validation_issue(issue: ValidationIssue) -> WorkflowValidationIssue {
    WorkflowValidationIssue {
        code: issue.code.as_str().to_owned(),
        severity: issue.severity.as_str().to_owned(),
        message: issue.message,
        node_ids: issue.node_ids,
    }
}

fn deep_issue(issue: DeepValidationIssue) -> WorkflowValidationIssue {
    WorkflowValidationIssue {
        code: issue.code.to_owned(),
        severity: issue.severity.as_str().to_owned(),
        message: issue.message,
        node_ids: issue.node_ids,
    }
}

/// Map flow-store failures to HTTP semantics: shape-validation rejections and
/// vanished entities are client errors, everything else is an internal error.
fn map_flow_error(error: anyhow::Error) -> ManagerError {
    let message = error.to_string();
    if message.contains("not found") {
        ManagerError::not_found(message)
    } else if message.contains("invalid flow id")
        || message.contains("requires a non-empty")
        || message.contains("is not supported")
        || message.contains("without an id")
        || message.contains("without id/source/target")
        || message.contains("non-finite position")
    {
        ManagerError::bad_request(message)
    } else {
        ManagerError::internal(message)
    }
}

/// RFC 7386 JSON Merge Patch：对象递归合并、null 删键、数组/标量整体替换
/// （patch 为对象时逐键处理；其余形态整体替换——调用方在 DTO 层已保证
/// config 为对象形态）。
fn json_merge_patch(target: &mut JsonValue, patch: &JsonValue) {
    match (target, patch) {
        (JsonValue::Object(target_map), JsonValue::Object(patch_map)) => {
            for (key, value) in patch_map {
                if value.is_null() {
                    target_map.remove(key);
                } else {
                    json_merge_patch(
                        target_map.entry(key.clone()).or_insert(JsonValue::Null),
                        value,
                    );
                }
            }
        }
        (target, patch) => *target = patch.clone(),
    }
}

/// 一次工作流图补丁的应用结果：改写后的节点/边（保持画布次序）与逐类操作
/// 实际生效的 id 清单。
#[derive(Debug)]
struct WorkflowPatchApplied {
    nodes: Vec<WorkflowNode>,
    edges: Vec<WorkflowEdge>,
    added_node_ids: Vec<String>,
    updated_node_ids: Vec<String>,
    removed_node_ids: Vec<String>,
    added_edge_ids: Vec<String>,
    updated_edge_ids: Vec<String>,
    removed_edge_ids: Vec<String>,
}

/// 应用工作流图补丁（纯函数，不落盘）：全部操作按 id 生效，任一 id 冲突/
/// 缺失/字段非法都以 bad_request 整体拒绝（不部分应用）；节点/边在 JSON 层
/// 改写后转回 typed 文档。removeNodes 级联删除关联边；removeEdges 对已被
/// 级联删除的边幂等通过。
fn apply_workflow_patch(
    workflow: &Workflow,
    request: &WorkflowPatchRequest,
) -> ManagerResult<WorkflowPatchApplied> {
    if request.add_nodes.is_empty()
        && request.update_nodes.is_empty()
        && request.remove_nodes.is_empty()
        && request.add_edges.is_empty()
        && request.update_edges.is_empty()
        && request.remove_edges.is_empty()
    {
        return Err(ManagerError::bad_request(
            "workflow patch requires at least one of addNodes/updateNodes/removeNodes/addEdges/updateEdges/removeEdges",
        ));
    }
    // JSON 层有序表：保留画布节点/边次序，改动原位生效。
    let mut nodes: Vec<(String, JsonValue)> = workflow
        .nodes
        .iter()
        .map(|node| {
            serde_json::to_value(node)
                .map(|value| (node.id.clone(), value))
                .map_err(|error| map_flow_error(error.into()))
        })
        .collect::<Result<_, ManagerError>>()?;
    let mut edges: Vec<(String, JsonValue)> = workflow
        .edges
        .iter()
        .map(|edge| {
            serde_json::to_value(edge)
                .map(|value| (edge.id.clone(), value))
                .map_err(|error| map_flow_error(error.into()))
        })
        .collect::<Result<_, ManagerError>>()?;

    let mut added_node_ids = Vec::new();
    let mut updated_node_ids = Vec::new();
    let mut removed_node_ids = Vec::new();
    let mut added_edge_ids = Vec::new();
    let mut updated_edge_ids = Vec::new();
    let mut removed_edge_ids = Vec::new();

    // addNodes：id 不得与现有节点或本请求内重复。
    for node in &request.add_nodes {
        if nodes.iter().any(|(id, _)| id == &node.id) || added_node_ids.contains(&node.id) {
            return Err(ManagerError::bad_request(format!(
                "workflow patch adds an existing node id: {}",
                node.id
            )));
        }
        let value = serde_json::to_value(node).map_err(|error| map_flow_error(error.into()))?;
        added_node_ids.push(node.id.clone());
        nodes.push((node.id.clone(), value));
    }

    // updateNodes：id 必须存在；仅接受已知字段——position 整体替换，
    // label/refId 替换（null 清除），config 走 JSON Merge Patch。
    for patch in &request.update_nodes {
        let object = patch.as_object().ok_or_else(|| {
            ManagerError::bad_request("workflow patch updateNodes entries must be objects")
        })?;
        let id = object
            .get("id")
            .and_then(JsonValue::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                ManagerError::bad_request(
                    "workflow patch updateNodes entries require a non-empty string id",
                )
            })?;
        let position = nodes
            .iter()
            .position(|(existing, _)| existing == id)
            .ok_or_else(|| {
                ManagerError::bad_request(format!("workflow patch updates a missing node id: {id}"))
            })?;
        for (key, value) in object {
            let entry = nodes[position]
                .1
                .as_object_mut()
                .expect("serialized node stays an object");
            match key.as_str() {
                "id" => {}
                "position" | "label" | "refId" => {
                    if value.is_null() {
                        entry.remove(key);
                    } else {
                        entry.insert(key.clone(), value.clone());
                    }
                }
                "config" => {
                    json_merge_patch(entry.entry("config").or_insert(JsonValue::Null), value)
                }
                other => {
                    return Err(ManagerError::bad_request(format!(
                        "workflow patch updateNodes entry has an unknown field: {other} (allowed: id, position, label, refId, config)"
                    )));
                }
            }
        }
        updated_node_ids.push(id.to_owned());
    }

    // removeNodes：id 必须存在；级联删除关联边（记录被删的边 id）。
    for id in &request.remove_nodes {
        let before = nodes.len();
        nodes.retain(|(existing, _)| existing != id);
        if nodes.len() == before {
            return Err(ManagerError::bad_request(format!(
                "workflow patch removes a missing node id: {id}"
            )));
        }
        removed_node_ids.push(id.clone());
    }
    if !removed_node_ids.is_empty() {
        edges.retain(|(_, edge)| {
            let source = edge.get("source").and_then(JsonValue::as_str);
            let target = edge.get("target").and_then(JsonValue::as_str);
            let touches_removed = removed_node_ids
                .iter()
                .any(|id| Some(id.as_str()) == source || Some(id.as_str()) == target);
            if touches_removed {
                if let Some(edge_id) = edge.get("id").and_then(JsonValue::as_str) {
                    removed_edge_ids.push(edge_id.to_owned());
                }
                false
            } else {
                true
            }
        });
    }

    // addEdges：id 唯一（可复用刚被级联删除的 id）；source/target 必须指向
    // 补丁应用后的现存节点。
    for edge in &request.add_edges {
        if edges.iter().any(|(id, _)| id == &edge.id) || added_edge_ids.contains(&edge.id) {
            return Err(ManagerError::bad_request(format!(
                "workflow patch adds an existing edge id: {}",
                edge.id
            )));
        }
        if edge.source.is_empty() || edge.target.is_empty() {
            return Err(ManagerError::bad_request(format!(
                "workflow patch edge {} requires non-empty source and target",
                edge.id
            )));
        }
        for endpoint in [&edge.source, &edge.target] {
            if !nodes.iter().any(|(id, _)| id == endpoint) {
                return Err(ManagerError::bad_request(format!(
                    "workflow patch edge {} references a missing node id: {}",
                    edge.id, endpoint
                )));
            }
        }
        let value = serde_json::to_value(edge).map_err(|error| map_flow_error(error.into()))?;
        added_edge_ids.push(edge.id.clone());
        edges.push((edge.id.clone(), value));
    }

    // updateEdges：id 必须存在（未被本补丁级联删除）；仅接受已知字段——
    // source/target 必须指向现存节点，sourceHandle 仅接受 true/false/null。
    for patch in &request.update_edges {
        let object = patch.as_object().ok_or_else(|| {
            ManagerError::bad_request("workflow patch updateEdges entries must be objects")
        })?;
        let id = object
            .get("id")
            .and_then(JsonValue::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                ManagerError::bad_request(
                    "workflow patch updateEdges entries require a non-empty string id",
                )
            })?;
        let position = edges
            .iter()
            .position(|(existing, _)| existing == id)
            .ok_or_else(|| {
                if removed_edge_ids.iter().any(|removed| removed == id) {
                    ManagerError::bad_request(format!(
                        "workflow patch updates edge {id} after removeNodes cascaded it away"
                    ))
                } else {
                    ManagerError::bad_request(format!(
                        "workflow patch updates a missing edge id: {id}"
                    ))
                }
            })?;
        for (key, value) in object {
            let entry = edges[position]
                .1
                .as_object_mut()
                .expect("serialized edge stays an object");
            match key.as_str() {
                "id" => {}
                "source" | "target" => {
                    let node_id = value.as_str().filter(|id| !id.is_empty()).ok_or_else(|| {
                        ManagerError::bad_request(format!(
                            "workflow patch updateEdges entry field {key} must be a non-empty string"
                        ))
                    })?;
                    if !nodes.iter().any(|(existing, _)| existing == node_id) {
                        return Err(ManagerError::bad_request(format!(
                            "workflow patch edge {id} references a missing node id: {node_id}"
                        )));
                    }
                    entry.insert(key.clone(), value.clone());
                }
                "sourceHandle" => {
                    if value.is_null() {
                        entry.remove(key);
                    } else if !matches!(value.as_str(), Some("true") | Some("false")) {
                        return Err(ManagerError::bad_request(
                            "workflow patch updateEdges entry field sourceHandle must be \"true\", \"false\" or null",
                        ));
                    } else {
                        entry.insert(key.clone(), value.clone());
                    }
                }
                other => {
                    return Err(ManagerError::bad_request(format!(
                        "workflow patch updateEdges entry has an unknown field: {other} (allowed: id, source, target, sourceHandle)"
                    )));
                }
            }
        }
        updated_edge_ids.push(id.to_owned());
    }

    // removeEdges：id 必须存在；已被 removeNodes 级联删除的边视为同一删除
    // （幂等通过，不重复计入清单）。
    for id in &request.remove_edges {
        let before = edges.len();
        edges.retain(|(existing, _)| existing != id);
        if edges.len() < before {
            removed_edge_ids.push(id.clone());
        } else if !removed_edge_ids.contains(id) {
            return Err(ManagerError::bad_request(format!(
                "workflow patch removes a missing edge id: {id}"
            )));
        }
    }

    // 转回 typed 文档：应用阶段已保证形状；转换失败按上游形状问题处理。
    let nodes = nodes
        .into_iter()
        .map(|(_, value)| {
            serde_json::from_value(value).map_err(|error| map_flow_error(error.into()))
        })
        .collect::<Result<Vec<WorkflowNode>, ManagerError>>()?;
    let edges = edges
        .into_iter()
        .map(|(_, value)| {
            serde_json::from_value(value).map_err(|error| map_flow_error(error.into()))
        })
        .collect::<Result<Vec<WorkflowEdge>, ManagerError>>()?;

    Ok(WorkflowPatchApplied {
        nodes,
        edges,
        added_node_ids,
        updated_node_ids,
        removed_node_ids,
        added_edge_ids,
        updated_edge_ids,
        removed_edge_ids,
    })
}

/// Map a run trigger failure to the HTTP error envelope (plan Task 19):
/// unknown workflow / target session are 404, a missing active session is 409,
/// an invalid graph is 422, and storage faults stay internal errors. Replays
/// run on the flow-dedicated connection generation, so a stopped proxy is not
/// a trigger precondition. The messages carry no internal paths.
fn map_trigger_error(error: RunTriggerError) -> ManagerError {
    let message = error.to_string();
    match error {
        RunTriggerError::WorkflowNotFound(_) | RunTriggerError::SessionMissing(_) => {
            ManagerError::not_found(message)
        }
        RunTriggerError::NotValid(_) => ManagerError::new(ErrorCode::WorkflowGraphInvalid, message),
        RunTriggerError::NoSession => ManagerError::conflict(message),
        RunTriggerError::Storage(error) => map_error(error),
    }
}

/// Map a render-preview load failure to the HTTP error envelope: unknown
/// workflow / node are 404, a non-httpReplay node or a missing request
/// baseline is a 422 graph-data issue, and storage faults stay internal
/// errors. The messages carry no internal paths.
fn map_render_preview_load_error(error: RenderPreviewLoadError) -> ManagerError {
    let message = error.to_string();
    match error {
        RenderPreviewLoadError::WorkflowNotFound(_) | RenderPreviewLoadError::NodeNotFound(_) => {
            ManagerError::not_found(message)
        }
        RenderPreviewLoadError::InvalidNode(_) | RenderPreviewLoadError::MissingBaseline(_) => {
            ManagerError::new(ErrorCode::WorkflowGraphInvalid, message)
        }
        RenderPreviewLoadError::Storage(fault) => map_error(fault),
    }
}

/// Look up one set by id, mapping a missing id to the not-found API error.
fn find_env_set<'a>(sets: &'a [EnvVariableSet], id: &str) -> ManagerResult<&'a EnvVariableSet> {
    sets.iter()
        .find(|set| set.id == id)
        .ok_or_else(|| ManagerError::not_found(format!("environment variable set {id} not found")))
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Open the workspace flow store for one blocking management task.
fn flow_store(runtime: &ProxyCrab) -> ManagerResult<proxy_crab_mitm::flow::store::FlowStore> {
    proxy_crab_mitm::flow::store::FlowStore::open(runtime.workspace().root()).map_err(map_error)
}

fn parse_request_source(value: &str) -> ManagerResult<RequestSource> {
    match value.to_ascii_lowercase().as_str() {
        "capture" => Ok(RequestSource::Capture),
        "import" => Ok(RequestSource::Import),
        "manual" => Ok(RequestSource::Manual),
        _ => Err(ManagerError::bad_request(
            "source must be one of capture, import, manual",
        )),
    }
}

/// Materialize one capture for request library ingestion: the live session is
/// consulted first and the archive second, so a session id stays usable after
/// archiving. A missing capture inside a known session is a plain 404.
fn load_captured_request(
    runtime: &Arc<ProxyCrab>,
    session_id: u64,
    capture_id: u64,
) -> ManagerResult<CapturedRequest> {
    let mut archived = false;
    let detail = match runtime.capture(session_id, capture_id) {
        Ok(detail) => detail,
        Err(error) => {
            let live = error;
            let is_live_session_missing = live
                .downcast_ref::<proxy_crab_mitm::error::Error>()
                .is_some_and(|mitm| {
                    matches!(mitm, proxy_crab_mitm::error::Error::SessionNotFound(_))
                });
            if !is_live_session_missing {
                return Err(map_error(live));
            }
            archived = true;
            runtime
                .archived_capture(session_id, capture_id)
                .map_err(|_| map_error(live))?
        }
    }
    .ok_or_else(|| ManagerError::not_found(format!("log {capture_id} not found")))?;
    let body = |side| {
        let source = if archived {
            runtime.archived_capture_body_source(session_id, capture_id, side)
        } else {
            runtime.capture_body_source(session_id, capture_id, side)
        };
        source.map_err(map_error)
    };
    Ok(CapturedRequest {
        capture: detail.summary,
        request_body: body(BodySide::Request)?,
        response_body: body(BodySide::Response)?,
    })
}

/// Raw request body bytes of one entry as a [`BodySource`]: blob bytes via
/// `bodyRef`, otherwise the inline snapshot text (base64-decoded when the
/// snapshot says so). The content type follows the HAR `mimeType`.
fn request_library_body_source(
    store: &proxy_crab_mitm::flow::store::FlowStore,
    id: &str,
    max_size: u64,
) -> ManagerResult<BodySource> {
    let entry = store
        .get_request(id)
        .map_err(map_error)?
        .ok_or_else(|| ManagerError::not_found(format!("request library entry {id} not found")))?;
    let post_data = entry.har.log.entries[0].request.post_data.clone();
    let content_type = post_data
        .as_ref()
        .map(|post_data| post_data.mime_type.clone())
        .filter(|mime_type| !mime_type.is_empty());
    let bytes = match &entry.body_ref {
        Some(body_ref) => {
            if body_ref.size > max_size {
                return Err(ManagerError::body_too_large(body_ref.size, max_size));
            }
            store
                .read_request_body(&entry)
                .map_err(map_error)?
                .ok_or_else(|| {
                    ManagerError::internal(format!(
                        "request library body {} is missing",
                        body_ref.path
                    ))
                })?
        }
        None => {
            let text = post_data
                .as_ref()
                .and_then(|post_data| post_data.text.as_ref())
                .ok_or_else(|| {
                    ManagerError::new(
                        ErrorCode::BodyNotFound,
                        format!("request library entry {id} has no stored request body"),
                    )
                })?;
            let bytes = match post_data
                .as_ref()
                .and_then(|post_data| post_data.encoding.as_deref())
            {
                None | Some("") => text.clone().into_bytes(),
                Some("base64") => {
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD
                        .decode(text)
                        .map_err(|error| {
                            ManagerError::bad_request(format!(
                                "invalid base64 request body: {error}"
                            ))
                        })?
                }
                Some(other) => {
                    return Err(ManagerError::bad_request(format!(
                        "unsupported request body encoding {other:?}"
                    )));
                }
            };
            if bytes.len() as u64 > max_size {
                return Err(ManagerError::body_too_large(bytes.len() as u64, max_size));
            }
            bytes
        }
    };
    Ok(BodySource {
        stored_size: bytes.len() as u64,
        data: proxy_crab_mitm::storage::BodySourceData::Bytes(bytes),
        path: None,
        content_type,
        content_encodings: Vec::new(),
    })
}

fn flatten_headers(headers: &HeaderValues) -> Vec<HeaderItem> {
    headers
        .iter()
        .flat_map(|(name, values)| {
            values.iter().map(|value| HeaderItem {
                name: name.clone(),
                value: value.clone(),
            })
        })
        .collect()
}

fn log_detail_from_capture(detail: CaptureDetail) -> LogDetail {
    let id = detail.summary.id;
    let session_id = detail.summary.session_id;
    LogDetail {
        websocket: None,
        id,
        session_id,
        created_at: detail.summary.created_at,
        updated_at: detail.summary.updated_at,
        source_type: "ip".into(),
        source_addr: Some(detail.summary.source),
        stage: detail.summary.stage,
        outcome: outcome_name(detail.summary.outcome).into(),
        error: detail.summary.error,
        request: RequestDetail {
            method: detail.summary.request.method,
            uri: detail.summary.request.uri,
            version: detail.summary.request.version,
            headers: flatten_headers(&detail.summary.request.headers),
            tags: detail.summary.request.tags,
            body: detail.request_body,
        },
        response: detail.summary.response.map(|response| ResponseDetail {
            status: response.status,
            status_text: status_text(response.status),
            version: response.version,
            headers: flatten_headers(&response.headers),
            body: detail.response_body,
        }),
        request_interceptors: detail.request_interceptors,
        response_interceptors: detail.response_interceptors,
    }
}

fn status_text(status: u16) -> String {
    axum::http::StatusCode::from_u16(status)
        .ok()
        .and_then(|status| status.canonical_reason())
        .unwrap_or_default()
        .to_owned()
}

fn outcome_name(outcome: CaptureOutcome) -> &'static str {
    match outcome {
        CaptureOutcome::InProgress => "in_progress",
        CaptureOutcome::Success => "success",
        CaptureOutcome::Failed => "failed",
        CaptureOutcome::Tunneled => "tunneled",
    }
}

fn interceptor_script_kind(kind: InterceptorKind) -> ScriptKind {
    match kind {
        InterceptorKind::Request => ScriptKind::RequestInterceptor,
        InterceptorKind::Response => ScriptKind::ResponseInterceptor,
    }
}

fn map_error(error: anyhow::Error) -> ManagerError {
    use proxy_crab_mitm::error::Error as MitmError;
    let Some(mitm) = error.downcast_ref::<MitmError>() else {
        return ManagerError::internal(error.to_string());
    };
    let message = mitm.to_string();
    match mitm {
        MitmError::SessionNotFound(_)
        | MitmError::ArchivedSessionNotFound(_)
        | MitmError::ScriptNotFound(_)
        | MitmError::CaptureNotFound(_)
        | MitmError::BreakpointNotFound(_)
        | MitmError::BypassEntryNotFound(_)
        | MitmError::FlowEntityNotFound(_, _) => ManagerError::not_found(message),
        MitmError::SessionAlreadyExists(_)
        | MitmError::ArchivedSessionAlreadyExists(_)
        | MitmError::ScriptAlreadyExists(_)
        | MitmError::ProxyMustBeStopped
        | MitmError::BypassEntryInProgress(_) => ManagerError::conflict(message),
        MitmError::ActiveSessionArchive(_) | MitmError::SessionRequestsInProgress(_) => {
            ManagerError::new(ErrorCode::SessionInUse, message)
        }
        MitmError::ProxyAlreadyRunning => ManagerError::new(ErrorCode::ProxyRunning, message),
        MitmError::InvalidScriptName
        | MitmError::InvalidScript(_)
        | MitmError::InvalidArgument(_) => ManagerError::bad_request(message),
    }
}

pub fn map_asset_error(error: AssetError) -> ManagerError {
    match error {
        AssetError::InvalidId(message) => ManagerError::new(
            ErrorCode::InvalidAssetId,
            format!("invalid asset id: {message}"),
        ),
        AssetError::NotFound(id) => {
            ManagerError::new(ErrorCode::AssetNotFound, format!("asset {id} not found"))
        }
        AssetError::AlreadyExists(id) => ManagerError::new(
            ErrorCode::AssetAlreadyExists,
            format!("asset {id} already exists"),
        ),
        AssetError::PathConflict(id) => ManagerError::new(
            ErrorCode::AssetPathConflict,
            format!("asset path conflicts with an existing file or directory: {id}"),
        ),
        AssetError::Storage(error) => {
            ManagerError::new(ErrorCode::AssetStoreFailed, error.to_string())
        }
        AssetError::InvalidMetadata(error) => {
            ManagerError::new(ErrorCode::AssetStoreFailed, error.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeSet, sync::Arc};

    use proxy_crab_mitm::{
        ProxyCrab,
        log_buffer::LogBuffer,
        lua::CaptureBodyAccess,
        model::{
            BodySourceType, CaptureOutcome, CaptureSummary, Column, FilterColumn, FilterOption,
            HeaderValues, InterceptorKind, NewSession, RequestData, ResponseData, SessionFilter,
        },
        storage::{BodySide, CaptureStore},
    };
    use tempfile::tempdir;

    use crate::dto::{
        CreateAgentsPresetRequest, DebugFilterScriptRequest, ErrorCode, InterceptorCreateRequest,
        LogIdsRequest, LogSearchRequest, LogViewItem, LogViewsRequest,
        ReplaceSessionInterceptorsRequest, ReplaceSessionViewRequest, ScriptRequest,
        SessionInterceptorInput, SessionViewInput, UpdateAgentsPresetRequest, UpdateScriptRequest,
    };

    use super::{
        MAX_BLOCKING_MANAGEMENT_TASKS, MitmManager, PreparedFilter, ProxyCrabManager, status_text,
    };

    /// RFC 7386 合并语义：对象递归合并、null 删键、数组/标量整体替换。
    #[test]
    fn json_merge_patch_follows_rfc_7386() {
        use serde_json::json;
        let mut target = json!({ "a": 1, "b": { "x": 1, "y": 2 }, "c": [1, 2] });
        super::json_merge_patch(
            &mut target,
            &json!({ "a": null, "b": { "y": null, "z": 3 }, "c": [9] }),
        );
        assert_eq!(target, json!({ "b": { "x": 1, "z": 3 }, "c": [9] }));
        // 非 object 的 patch 整体替换（RFC 对象键之外的价值语义）。
        super::json_merge_patch(&mut target, &json!("scalar"));
        assert_eq!(target, json!("scalar"));
    }

    /// 图补丁纯函数：merge-patch 只动目标片段、次序保留、级联删边、
    /// 幂等 removeEdges；id 冲突/缺失整体拒绝。
    #[test]
    fn apply_workflow_patch_merges_cascades_and_rejects_conflicts() {
        use crate::dto::WorkflowPatchRequest;
        use proxy_crab_mitm::flow::model::{
            NodeConfig, Position, WorkflowEdge, WorkflowNode, WorkflowNodeType,
        };
        use serde_json::json;

        let node = |id: &str, node_type| WorkflowNode {
            id: id.to_owned(),
            node_type,
            position: Position { x: 0.0, y: 0.0 },
            config: NodeConfig::default(),
            label: None,
            ref_id: None,
        };
        let edge = |id: &str, source: &str, target: &str| WorkflowEdge {
            id: id.to_owned(),
            source: source.to_owned(),
            target: target.to_owned(),
            source_handle: None,
        };
        let workflow = proxy_crab_mitm::flow::model::Workflow {
            id: "wf".into(),
            project_id: "p".into(),
            name: "n".into(),
            description: String::new(),
            nodes: vec![
                node("s", WorkflowNodeType::Start),
                // d1 带初始 config：供尾部「源文档未被就地改动」断言对照。
                WorkflowNode {
                    config: NodeConfig {
                        duration_ms: Some(120),
                        ..NodeConfig::default()
                    },
                    ..node("d1", WorkflowNodeType::Delay)
                },
                node("d2", WorkflowNodeType::Delay),
            ],
            edges: vec![edge("e1", "s", "d1"), edge("e2", "d1", "d2")],
            variables: Default::default(),
            secret_variables: Default::default(),
            schema_version: 1,
            created_at: 0,
            updated_at: 0,
        };
        let parse = |value: serde_json::Value| {
            serde_json::from_value::<WorkflowPatchRequest>(value).unwrap()
        };

        // 冲突整体拒绝：add 重复 id / update 缺失 id / removeNodes 级联后
        // 再 update 该边被拒。
        for (request, expected) in [
            (
                parse(
                    json!({"addNodes":[{"id":"d1","type":"delay","position":{"x":0.0,"y":0.0},"config":{}}]}),
                ),
                "adds an existing node id",
            ),
            (
                parse(json!({"updateNodes":[{"id":"ghost","label":"x"}]})),
                "updates a missing node id",
            ),
            (
                parse(json!({"addEdges":[{"id":"e1","source":"s","target":"d1"}]})),
                "adds an existing edge id",
            ),
            (
                parse(json!({"addEdges":[{"id":"e9","source":"ghost","target":"d1"}]})),
                "references a missing node id",
            ),
        ] {
            let error = super::apply_workflow_patch(&workflow, &request).unwrap_err();
            assert!(error.message.contains(expected), "{error:?}");
        }

        // 合并/重接/级联：改 d1 config、label 置值；removeNodes d1 级联删
        // e1（s→d1）与 e2（d1→d2）两条关联边；addEdges 复用 e2 的 id 重接为
        // s→d2（实现约定：updateEdges 只作用于存活的边，被级联删除的边用
        // addEdges 复用 id 重接）。
        let request = parse(json!({
            "updateNodes": [{ "id": "d1", "label": "renamed", "config": { "durationMs": 250 } }],
            "removeNodes": ["d1"],
            "addEdges": [{ "id": "e2", "source": "s", "target": "d2" }],
        }));
        let applied = super::apply_workflow_patch(&workflow, &request).unwrap();
        assert_eq!(applied.updated_node_ids, vec!["d1"]);
        assert_eq!(applied.removed_node_ids, vec!["d1"]);
        assert_eq!(applied.added_edge_ids, vec!["e2"]);
        assert_eq!(applied.updated_edge_ids, Vec::<String>::new());
        assert_eq!(applied.removed_edge_ids, vec!["e1", "e2"]);
        // 次序保留：剩余节点仍按画布次序 s → d2。
        let remaining: Vec<&str> = applied.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(remaining, ["s", "d2"]);
        let d1 = &workflow.nodes[1];
        assert_eq!(d1.config.duration_ms, Some(120));
        // 源文档未被就地改动（纯函数）。
        assert_eq!(workflow.nodes[1].label, None);

        // removeEdges 幂等：级联已删的 e1 再显式删除不报错、不重复计入；
        // e2（d1→d2）随 removeNodes d1 一并级联删除。
        let request = parse(json!({ "removeNodes": ["d1"], "removeEdges": ["e1"] }));
        let applied = super::apply_workflow_patch(&workflow, &request).unwrap();
        assert_eq!(applied.removed_edge_ids, vec!["e1", "e2"]);
        // 未被级联覆盖的缺失边仍拒绝。
        let request = parse(json!({ "removeEdges": ["ghost"] }));
        let error = super::apply_workflow_patch(&workflow, &request).unwrap_err();
        assert!(error.message.contains("removes a missing edge id"));
    }

    #[tokio::test]
    async fn websocket_reads_apply_policy_and_never_expose_containers() {
        let dir = tempdir().unwrap();
        let runtime = ProxyCrab::open(dir.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let store = CaptureStore::open(session.id, runtime.workspace().root()).unwrap();
        let handshake = store
            .begin("test", &request("handshake"), "request")
            .unwrap();
        let mut req = request("socket");
        req.version = "WebSocket/13".into();
        req.uri = "wss://example.com/ws?secret=1".into();
        let id = store.begin("test", &req, "websocket").unwrap();
        let db = rusqlite::Connection::open(
            runtime
                .workspace()
                .root()
                .join("sessions")
                .join(session.id.to_string())
                .join("captures.db"),
        )
        .unwrap();
        db.execute("INSERT INTO websocket_captures(capture_id,handshake_id,extensions,opened_at,close_reason) VALUES (?1,?2,'',1,'sensitive close')", rusqlite::params![id as i64,handshake as i64]).unwrap();
        let mut bytes = b"PCWS\x01\0\0\0".to_vec();
        for (message_id, payload, available) in [
            (1u32, b"secret".as_slice(), true),
            (2, b"".as_slice(), false),
        ] {
            let metadata = serde_json::json!({"id":message_id,"type":"text","started_at":1,"completed_at":2,"size":if available {6} else {16777217},"content_available":available,"omitted_reason":if available {None} else {Some("size_limit_exceeded")},"error":"private delivery","errors":[{"execution_id":1,"name":"test","invocation_id":1,"error":"private callback payload"}]});
            let meta = serde_json::to_vec(&metadata).unwrap();
            bytes.extend(message_id.to_le_bytes());
            bytes.extend(((4 + meta.len() + payload.len()) as u32).to_le_bytes());
            bytes.extend((meta.len() as u32).to_le_bytes());
            bytes.extend(meta);
            bytes.extend(payload);
        }
        store.save_body(id, BodySide::Request, &bytes).unwrap();
        let manager = MitmManager::new(runtime.clone());
        let page = manager
            .websocket_messages(Some(session.id), id, BodySide::Request, 0, 1)
            .await
            .unwrap();
        assert_eq!(page.messages.len(), 1);
        assert!(page.has_more);
        assert_eq!(page.next_after_id, 1);
        let page = manager
            .websocket_messages(Some(session.id), id, BodySide::Request, 2, 1)
            .await
            .unwrap();
        assert!(page.messages.is_empty());
        assert_eq!(page.next_after_id, 2);
        assert!(
            manager
                .websocket_messages(Some(session.id), id, BodySide::Request, 0, 2001)
                .await
                .is_err()
        );
        assert_eq!(
            manager
                .log_body_source(Some(session.id), id, BodySide::Request)
                .await
                .unwrap_err()
                .code,
            ErrorCode::BadRequest
        );
        assert!(matches!(
            manager
                .log(Some(session.id), id)
                .await
                .unwrap()
                .request
                .body,
            proxy_crab_mitm::model::BodyPayload::Empty
        ));
        assert_eq!(
            manager
                .websocket_message_body(Some(session.id), id, BodySide::Request, 1, 2)
                .await
                .unwrap_err()
                .code,
            ErrorCode::BodyTooLarge
        );
        assert_eq!(
            manager
                .websocket_message_body(Some(session.id), id, BodySide::Request, 2, 16777216)
                .await
                .unwrap_err()
                .code,
            ErrorCode::MessageContentUnavailable
        );
        for (name, script, expected) in [
            ("old", "", Some(ErrorCode::RedactionFailed)),
            (
                "fail",
                "-- @proxycrab websocket-messages\nerror('private')",
                Some(ErrorCode::RedactionFailed),
            ),
            (
                "hide",
                "-- @proxycrab websocket-messages\nif context.kind == 'websocket_message' then req.body:hide() end",
                Some(ErrorCode::MessageContentHidden),
            ),
            (
                "mask",
                "-- @proxycrab websocket-messages\nif context.kind == 'websocket_message' then assert(resp == nil); req.body:replace_with_string('safe') elseif req then req.uri = 'wss://example.com/safe' end",
                None,
            ),
        ] {
            manager
                .create_redaction_script(ScriptRequest {
                    name: name.into(),
                    content: script.into(),
                })
                .await
                .unwrap();
            let reader = manager
                .reader(
                    Some(name),
                    "/api/logs/{id}/websocket/messages/{message_id}/body",
                )
                .unwrap();
            let safe_page = reader
                .websocket_messages(Some(session.id), id, BodySide::Request, 0, 1)
                .await
                .unwrap();
            assert_eq!(
                safe_page.messages[0].error.as_deref(),
                Some("WebSocket delivery failed")
            );
            assert_eq!(
                safe_page.messages[0].errors[0].error,
                "WebSocket callback failed"
            );
            let result = reader
                .websocket_message_body(Some(session.id), id, BodySide::Request, 1, 16_777_216)
                .await;
            if let Some(code) = expected {
                assert_eq!(result.unwrap_err().code, code);
            } else {
                let source = result.unwrap();
                assert!(
                    matches!(source.data, proxy_crab_mitm::storage::BodySourceData::Bytes(ref b) if b == b"safe")
                );
                let detail = reader.log(Some(session.id), id).await.unwrap();
                assert_eq!(detail.request.uri, "wss://example.com/safe");
                assert!(detail.websocket.unwrap().close_reason.is_none());
            }
        }
        let source = manager
            .websocket_message_body(Some(session.id), id, BodySide::Request, 1, 16_777_216)
            .await
            .unwrap();
        assert!(
            matches!(source.data, proxy_crab_mitm::storage::BodySourceData::Bytes(ref b) if b == b"secret")
        );

        use axum::{
            body::{Body, to_bytes},
            http::Request,
        };
        use tower::ServiceExt;
        struct BoundPolicy;
        #[async_trait::async_trait]
        impl crate::permission::PermissionManager for BoundPolicy {
            async fn check_permission(
                &self,
                _: crate::permission::PermissionAction,
            ) -> Option<crate::permission::PermissionDenied> {
                None
            }
            async fn redaction_script(
                &self,
                _: &crate::permission::ManagementCredential,
            ) -> Result<Option<String>, crate::permission::PermissionDenied> {
                Ok(Some("mask".into()))
            }
        }
        let app = crate::http::router(manager.clone(), Arc::new(BoundPolicy));
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/logs/{id}/websocket/messages/1/body?session_id={}&side=request",
                        session.id
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(
            to_bytes(response.into_body(), 100).await.unwrap().as_ref(),
            b"safe"
        );
        for (path, status) in [
            (
                format!("/api/logs/{id}/body?session_id={}&side=request", session.id),
                400,
            ),
            (
                format!(
                    "/api/logs/{id}/websocket/messages?session_id={}&side=invalid",
                    session.id
                ),
                400,
            ),
            (
                format!(
                    "/api/logs/{id}/websocket/messages?session_id={}&side=request&limit=2001",
                    session.id
                ),
                400,
            ),
        ] {
            assert_eq!(
                app.clone()
                    .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                status
            );
        }
        let shared_manager: Arc<dyn ProxyCrabManager> = manager;
        let shares = crate::session_share::SessionShareService::new();
        let token = shares
            .enable_with_script(&shared_manager, session.id, Some("mask".into()))
            .await
            .unwrap()
            .token
            .unwrap();
        let shared_app = crate::session_share::router(shared_manager, shares);
        let response = shared_app.oneshot(Request::builder().uri(format!("/share-api/logs/{id}/websocket/messages/1/body?session_id=999&side=request&token={token}")).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            to_bytes(response.into_body(), 100).await.unwrap().as_ref(),
            b"safe"
        );
    }

    #[test]
    fn response_status_text_uses_the_canonical_reason() {
        assert_eq!(status_text(200), "OK");
        assert_eq!(status_text(404), "Not Found");
        assert_eq!(status_text(999), "");
    }

    #[test]
    fn log_id_in_progress_requires_current_activity_membership() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let item = CaptureSummary {
            id: 7,
            session_id: 3,
            source: "127.0.0.1".into(),
            request: request("active"),
            response: None,
            outcome: CaptureOutcome::InProgress,
            stage: "request".into(),
            error: None,
            created_at: 1,
            updated_at: 1,
        };
        let mut matched = Vec::new();
        let mut in_progress = Vec::new();
        MitmManager::classify_log_id(
            &PreparedFilter::All,
            &item,
            &BTreeSet::new(),
            CaptureBodyAccess::unavailable,
            &mut matched,
            &mut in_progress,
            None,
            &runtime,
        )
        .unwrap();
        assert_eq!(matched, vec![7]);
        assert!(in_progress.is_empty());

        MitmManager::classify_log_id(
            &PreparedFilter::All,
            &item,
            &BTreeSet::from([7]),
            CaptureBodyAccess::unavailable,
            &mut Vec::new(),
            &mut in_progress,
            None,
            &runtime,
        )
        .unwrap();
        assert_eq!(in_progress, vec![7]);
    }

    #[test]
    fn blocking_management_tasks_are_limited_to_eight() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);

        assert_eq!(MAX_BLOCKING_MANAGEMENT_TASKS, 8);
        let permits = (0..8)
            .map(|_| manager.blocking_tasks.clone().try_acquire_owned().unwrap())
            .collect::<Vec<_>>();
        assert!(manager.blocking_tasks.clone().try_acquire_owned().is_err());
        drop(permits);
        assert_eq!(manager.blocking_tasks.available_permits(), 8);
    }

    #[tokio::test]
    async fn agent_presets_are_managed_through_the_manager() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);

        let state = manager
            .create_agents_preset(CreateAgentsPresetRequest {
                name: "自定义".into(),
            })
            .await
            .unwrap();
        let id = state
            .presets
            .iter()
            .find(|preset| preset.name == "自定义")
            .unwrap()
            .id
            .clone();
        manager
            .update_agents_preset(
                id.clone(),
                UpdateAgentsPresetRequest {
                    name: None,
                    content: Some("# Custom".into()),
                },
            )
            .await
            .unwrap();
        manager.activate_agents_preset(id).await.unwrap();

        assert_eq!(manager.agents_markdown().await.unwrap(), "# Custom");
    }

    #[tokio::test]
    async fn log_ids_can_filter_without_persisting_session_state() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let store = CaptureStore::open(session.id, runtime.workspace().root()).unwrap();
        let first = store
            .begin("127.0.0.1", &request("first"), "request")
            .unwrap();
        store
            .begin("127.0.0.1", &request("second"), "request")
            .unwrap();
        let manager = MitmManager::new(runtime);
        let original = manager.session_view(Some(session.id)).await.unwrap().filter;

        let result = manager
            .log_ids(LogIdsRequest {
                session_id: Some(session.id),
                filter: Some(SessionFilter {
                    option: Some(FilterOption::Column {
                        column: FilterColumn::Uri,
                        regex: false,
                    }),
                    input: "/first".into(),
                }),
                ids: None,
                min_id: None,
                max_id: None,
                limit: None,
            })
            .await
            .unwrap();

        assert_eq!(result.matched_ids, vec![first]);
        assert!(result.in_progress_ids.is_empty());
        assert_eq!(
            manager.session_view(Some(session.id)).await.unwrap().filter,
            original
        );

        let explicit = manager
            .log_ids(LogIdsRequest {
                session_id: Some(session.id),
                filter: Some(SessionFilter {
                    option: Some(FilterOption::Column {
                        column: FilterColumn::Uri,
                        regex: false,
                    }),
                    input: "/first".into(),
                }),
                ids: Some(vec![first]),
                min_id: None,
                max_id: None,
                limit: None,
            })
            .await
            .unwrap();
        assert_eq!(explicit.matched_ids, vec![first]);
        assert!(explicit.in_progress_ids.is_empty());

        store
            .mark_in_progress_range_as_shutdown(first, first)
            .unwrap();
        let completed = manager
            .log_ids(LogIdsRequest {
                session_id: Some(session.id),
                filter: Some(SessionFilter {
                    option: Some(FilterOption::Column {
                        column: FilterColumn::Uri,
                        regex: false,
                    }),
                    input: "/first".into(),
                }),
                ids: Some(vec![first]),
                min_id: None,
                max_id: None,
                limit: None,
            })
            .await
            .unwrap();
        assert_eq!(completed.matched_ids, vec![first]);
        assert!(completed.in_progress_ids.is_empty());

        let invalid = manager
            .log_ids(LogIdsRequest {
                session_id: Some(session.id),
                filter: None,
                ids: Some(vec![first]),
                min_id: Some(0),
                max_id: None,
                limit: None,
            })
            .await
            .unwrap_err();
        assert_eq!(invalid.code, ErrorCode::BadRequest);
    }

    #[tokio::test]
    async fn log_search_composes_predicates_and_echoes_the_session() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let store = CaptureStore::open(session.id, runtime.workspace().root()).unwrap();
        store
            .begin("127.0.0.1", &request("first"), "request")
            .unwrap();
        store
            .begin("127.0.0.1", &request("second"), "request")
            .unwrap();
        let mut third = request("third");
        third.method = "POST".into();
        third.uri = "http://api.example.com/v1/third".into();
        store.begin("127.0.0.1", &third, "request").unwrap();
        let manager = MitmManager::new(runtime);

        // host + path AND 组合只命中第三条；响应回显解析后的 session。
        let result = manager
            .log_search(LogSearchRequest {
                session_id: Some(session.id),
                host: Some("api.example.com".into()),
                path: Some("/v1".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.session_id, session.id);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].method, "POST");
        // begin() 只建请求侧：在途 capture 的 code 为 "..."。
        assert_eq!(result.matches[0].code, "...");
        assert!(result.matches[0].in_progress);

        // method 大小写不敏感；status "..." 命中全部在途，"200" 无命中。
        let post = manager
            .log_search(LogSearchRequest {
                session_id: Some(session.id),
                method: Some("post".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(post.matches.len(), 1);
        let pending = manager
            .log_search(LogSearchRequest {
                session_id: Some(session.id),
                status: Some("...".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(pending.matches.len(), 3);
        let ok200 = manager
            .log_search(LogSearchRequest {
                session_id: Some(session.id),
                status: Some("200".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(ok200.matches.is_empty());

        // 空字符串谓词按缺省忽略，不退化为「匹配一切」之外的特殊语义。
        let empty_keyword = manager
            .log_search(LogSearchRequest {
                session_id: Some(session.id),
                keyword: Some(String::new()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(empty_keyword.matches.len(), 3);
    }

    #[tokio::test]
    async fn log_search_paginates_with_truncation_cursor() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let store = CaptureStore::open(session.id, runtime.workspace().root()).unwrap();
        let first = store
            .begin("127.0.0.1", &request("first"), "request")
            .unwrap();
        let second = store
            .begin("127.0.0.1", &request("second"), "request")
            .unwrap();
        let third = store
            .begin("127.0.0.1", &request("third"), "request")
            .unwrap();
        let manager = MitmManager::new(runtime);

        // 默认降序：limit=2 截断并给出游标（独占边界，续页不重复）。
        let page = manager
            .log_search(LogSearchRequest {
                session_id: Some(session.id),
                limit: Some(2),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(page.truncated);
        assert_eq!(page.matches.len(), 2);
        assert_eq!(page.matches[0].id, third);
        assert_eq!(page.matches[1].id, second);
        let cursor = page.next_cursor.unwrap();
        assert_eq!(cursor, second);
        let rest = manager
            .log_search(LogSearchRequest {
                session_id: Some(session.id),
                limit: Some(2),
                max_id: Some(cursor),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(!rest.truncated);
        assert_eq!(rest.matches.len(), 1);
        assert_eq!(rest.matches[0].id, first);

        // 只有 min_id 时按升序扫描。
        let ascending = manager
            .log_search(LogSearchRequest {
                session_id: Some(session.id),
                min_id: Some(first),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(!ascending.truncated);
        let ids: Vec<u64> = ascending.matches.iter().map(|hit| hit.id).collect();
        assert_eq!(ids, vec![second, third]);
    }

    #[tokio::test]
    async fn log_search_supports_regex_and_rejects_invalid_patterns() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let store = CaptureStore::open(session.id, runtime.workspace().root()).unwrap();
        store
            .begin("127.0.0.1", &request("first"), "request")
            .unwrap();
        store
            .begin("127.0.0.1", &request("second"), "request")
            .unwrap();
        store
            .begin("127.0.0.1", &request("third"), "request")
            .unwrap();
        let manager = MitmManager::new(runtime);

        let matched = manager
            .log_search(LogSearchRequest {
                session_id: Some(session.id),
                path: Some("/(first|third)".into()),
                regex: true,
                ..Default::default()
            })
            .await
            .unwrap();
        let ids: Vec<u64> = matched.matches.iter().map(|hit| hit.id).collect();
        assert_eq!(ids.len(), 2);

        let invalid = manager
            .log_search(LogSearchRequest {
                session_id: Some(session.id),
                path: Some("(".into()),
                regex: true,
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert_eq!(invalid.code, ErrorCode::BadRequest);
    }

    #[tokio::test]
    async fn replacing_session_filter_preserves_columns() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let manager = MitmManager::new(runtime);
        let before = manager.session_view(Some(session.id)).await.unwrap();
        let filter = SessionFilter {
            option: Some(FilterOption::Column {
                column: FilterColumn::Uri,
                regex: false,
            }),
            input: "needle".into(),
        };

        let after = manager
            .replace_session_filter(session.id, filter.clone())
            .await
            .unwrap();

        assert_eq!(after.columns, before.columns);
        assert_eq!(after.filter, filter);
    }

    fn request(path: &str) -> RequestData {
        RequestData {
            method: "GET".into(),
            uri: format!("http://example.com/{path}"),
            version: "HTTP/1.1".into(),
            headers: HeaderValues::new(),
            tags: Default::default(),
        }
    }

    #[tokio::test]
    async fn log_ids_apply_exclusive_bounds_and_batch_views_report_cell_errors() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let store = CaptureStore::open(session.id, runtime.workspace().root()).unwrap();
        let first = store
            .begin("127.0.0.1", &request("first"), "request")
            .unwrap();
        let second = store
            .begin("127.0.0.1", &request("second"), "request")
            .unwrap();
        let third = store
            .begin("127.0.0.1", &request("third"), "request")
            .unwrap();
        let manager = MitmManager::new(runtime);

        let ids = manager
            .log_ids(LogIdsRequest {
                session_id: Some(session.id),
                filter: None,
                ids: None,
                min_id: Some(first),
                max_id: Some(third),
                limit: None,
            })
            .await
            .unwrap();
        assert_eq!(ids.matched_ids, vec![second]);
        assert!(ids.in_progress_ids.is_empty());

        manager
            .create_column_script(ScriptRequest {
                name: "broken".into(),
                content: "error(\"boom\")".into(),
            })
            .await
            .unwrap();
        manager
            .replace_session_view(
                Some(session.id),
                ReplaceSessionViewRequest {
                    columns: vec![
                        Column::Method { width: 50.0 },
                        Column::CreatedAt { width: 200.0 },
                        Column::UpdatedAt { width: 200.0 },
                        Column::Script {
                            width: 100.0,
                            script_name: "broken".into(),
                        },
                    ],
                },
            )
            .await
            .unwrap();
        let payload = manager
            .log_views(LogViewsRequest {
                session_id: Some(session.id),
                logs: vec![
                    LogViewItem {
                        id: second,
                        updated_at: None,
                    },
                    LogViewItem {
                        id: third + 100,
                        updated_at: None,
                    },
                ],
                view: None,
            })
            .await
            .unwrap();

        assert_eq!(payload.columns.len(), 4);
        assert_eq!(
            payload.rows[0].cells,
            vec![
                "GET".to_string(),
                payload.rows[0].created_at.to_string(),
                payload.rows[0].updated_at.to_string(),
                String::new(),
            ]
        );
        assert!(payload.rows[0].created_at > 0);
        assert_eq!(payload.rows[0].outcome, "in_progress");
        assert_eq!(payload.exceptions.len(), 2);
        assert!(payload.exceptions.iter().any(|error| {
            error.id == second
                && error.column_index == Some(3)
                && error.code == "column_script_error"
        }));
        assert!(
            payload
                .exceptions
                .iter()
                .any(|error| error.code == "log_not_found")
        );

        let error = manager
            .log_views(LogViewsRequest {
                session_id: Some(session.id),
                logs: (0..201)
                    .map(|id| LogViewItem {
                        id,
                        updated_at: None,
                    })
                    .collect(),
                view: None,
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::BadRequest);
    }

    #[tokio::test]
    async fn historical_bodies_are_available_to_filter_and_column_scripts() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let store = CaptureStore::open(session.id, runtime.workspace().root()).unwrap();
        let request = RequestData {
            headers: HeaderValues::from([("content-type".into(), vec!["application/json".into()])]),
            ..request("body")
        };
        let response = ResponseData {
            status: 200,
            version: "HTTP/1.1".into(),
            headers: HeaderValues::from([("content-type".into(), vec!["text/plain".into()])]),
        };
        let completed = store.begin("127.0.0.1", &request, "request").unwrap();
        store
            .save_body(completed, BodySide::Request, br#"{"order_id":"42"}"#)
            .unwrap();
        store
            .save_body(completed, BodySide::Response, b"original response")
            .unwrap();
        store
            .complete(
                completed,
                &response,
                &BodySourceType::String {
                    content: "completed response".into(),
                },
            )
            .unwrap();

        let in_progress = store.begin("127.0.0.1", &request, "request").unwrap();
        store
            .save_body(in_progress, BodySide::Request, br#"{"order_id":"42"}"#)
            .unwrap();
        store
            .update_response(in_progress, &response, &BodySourceType::Original)
            .unwrap();
        store
            .save_body(in_progress, BodySide::Response, b"partial response")
            .unwrap();

        let manager = MitmManager::new(runtime);
        manager
            .create_filter_script(ScriptRequest {
                name: "request-order".into(),
                content: "local body = entry.req.body:as_json(); \
                          return body ~= nil and body.order_id == ..."
                    .into(),
            })
            .await
            .unwrap();
        let body_filter = SessionFilter {
            option: Some(FilterOption::Script {
                script_name: "request-order".into(),
            }),
            input: "42".into(),
        };
        assert_eq!(
            manager
                .log_ids(LogIdsRequest {
                    session_id: Some(session.id),
                    filter: Some(body_filter),
                    ids: Some(vec![completed, in_progress]),
                    min_id: None,
                    max_id: None,
                    limit: None,
                })
                .await
                .unwrap()
                .matched_ids,
            vec![completed]
        );
        assert!(
            manager
                .debug_filter_script(
                    "request-order".into(),
                    DebugFilterScriptRequest {
                        session_id: Some(session.id),
                        log_id: completed,
                        input: "42".into(),
                    },
                )
                .await
                .unwrap()
        );

        manager
            .create_column_script(ScriptRequest {
                name: "response-body".into(),
                content: "return entry.resp.body:as_string() or 'unavailable'".into(),
            })
            .await
            .unwrap();
        let view = vec![Column::Script {
            width: 100.0,
            script_name: "response-body".into(),
        }];
        let payload = manager
            .log_views(LogViewsRequest {
                session_id: Some(session.id),
                logs: vec![
                    LogViewItem {
                        id: completed,
                        updated_at: None,
                    },
                    LogViewItem {
                        id: in_progress,
                        updated_at: None,
                    },
                ],
                view: Some(SessionViewInput {
                    columns: view.clone(),
                }),
            })
            .await
            .unwrap();
        assert_eq!(
            payload
                .rows
                .iter()
                .find(|row| row.id == completed)
                .unwrap()
                .cells,
            vec!["completed response"]
        );
        assert_eq!(
            payload
                .rows
                .iter()
                .find(|row| row.id == in_progress)
                .unwrap()
                .cells,
            vec!["unavailable"]
        );
        assert_eq!(
            manager
                .log_ids(LogIdsRequest {
                    session_id: Some(session.id),
                    filter: Some(SessionFilter {
                        option: Some(FilterOption::Column {
                            column: FilterColumn::Script {
                                script_name: "response-body".into(),
                            },
                            regex: false,
                        }),
                        input: "completed".into(),
                    }),
                    ids: Some(vec![completed, in_progress]),
                    min_id: None,
                    max_id: None,
                    limit: None,
                })
                .await
                .unwrap()
                .matched_ids,
            vec![completed]
        );
    }

    #[tokio::test]
    async fn structured_filters_are_read_only_and_script_errors_are_non_matches() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let store = CaptureStore::open(session.id, runtime.workspace().root()).unwrap();
        let first = store
            .begin("127.0.0.1", &request("First"), "request")
            .unwrap();
        let second = store
            .begin("127.0.0.1", &request("second"), "request")
            .unwrap();
        let manager = MitmManager::new(runtime);
        let original = manager.session_view(Some(session.id)).await.unwrap().filter;

        let regex_filter = SessionFilter {
            option: Some(FilterOption::Column {
                column: FilterColumn::Uri,
                regex: true,
            }),
            input: r"(?i)^http://example\.com/first$".into(),
        };
        let ids = manager
            .log_ids(LogIdsRequest {
                session_id: Some(session.id),
                filter: Some(regex_filter.clone()),
                ids: None,
                min_id: None,
                max_id: None,
                limit: None,
            })
            .await
            .unwrap();
        assert_eq!(ids.matched_ids, vec![first]);
        assert_eq!(
            manager.session_view(Some(session.id)).await.unwrap().filter,
            original
        );
        assert_eq!(
            manager
                .log_ids(LogIdsRequest {
                    session_id: Some(session.id),
                    filter: None,
                    ids: None,
                    min_id: None,
                    max_id: None,
                    limit: None,
                })
                .await
                .unwrap()
                .matched_ids,
            vec![second, first]
        );

        let exact = SessionFilter {
            option: Some(FilterOption::Column {
                column: FilterColumn::Uri,
                regex: false,
            }),
            input: "EXAMPLE.COM/FIRST".into(),
        };
        assert!(
            manager
                .log_ids(LogIdsRequest {
                    session_id: Some(session.id),
                    filter: Some(exact),
                    ids: None,
                    min_id: None,
                    max_id: None,
                    limit: None,
                })
                .await
                .unwrap()
                .matched_ids
                .is_empty()
        );

        let invalid = manager
            .log_ids(LogIdsRequest {
                session_id: Some(session.id),
                filter: Some(SessionFilter {
                    option: Some(FilterOption::Column {
                        column: FilterColumn::Uri,
                        regex: true,
                    }),
                    input: "(".into(),
                }),
                ids: None,
                min_id: None,
                max_id: None,
                limit: None,
            })
            .await
            .unwrap_err();
        assert_eq!(invalid.code, ErrorCode::BadRequest);

        manager
            .create_column_script(ScriptRequest {
                name: "path".into(),
                content: "return entry.req.uri.path".into(),
            })
            .await
            .unwrap();
        let custom = SessionFilter {
            option: Some(FilterOption::Column {
                column: FilterColumn::Script {
                    script_name: "path".into(),
                },
                regex: true,
            }),
            input: "^/First$".into(),
        };
        assert_eq!(
            manager
                .log_ids(LogIdsRequest {
                    session_id: Some(session.id),
                    filter: Some(custom),
                    ids: None,
                    min_id: None,
                    max_id: None,
                    limit: None,
                })
                .await
                .unwrap()
                .matched_ids,
            vec![first]
        );

        manager
            .create_column_script(ScriptRequest {
                name: "broken-column".into(),
                content: "error('boom')".into(),
            })
            .await
            .unwrap();
        assert!(
            manager
                .log_ids(LogIdsRequest {
                    session_id: Some(session.id),
                    filter: Some(SessionFilter {
                        option: Some(FilterOption::Column {
                            column: FilterColumn::Script {
                                script_name: "broken-column".into(),
                            },
                            regex: false,
                        }),
                        input: "anything".into(),
                    }),
                    ids: None,
                    min_id: None,
                    max_id: None,
                    limit: None,
                })
                .await
                .unwrap()
                .matched_ids
                .is_empty()
        );

        manager
            .create_filter_script(ScriptRequest {
                name: "path-is".into(),
                content: "local input = ...; return entry.req.uri.path == '/' .. input".into(),
            })
            .await
            .unwrap();
        let scripted = SessionFilter {
            option: Some(FilterOption::Script {
                script_name: "path-is".into(),
            }),
            input: "second".into(),
        };
        assert_eq!(
            manager
                .log_ids(LogIdsRequest {
                    session_id: Some(session.id),
                    filter: Some(scripted),
                    ids: None,
                    min_id: None,
                    max_id: None,
                    limit: None,
                })
                .await
                .unwrap()
                .matched_ids,
            vec![second]
        );
        assert!(
            manager
                .debug_filter_script(
                    "path-is".into(),
                    DebugFilterScriptRequest {
                        session_id: Some(session.id),
                        log_id: second,
                        input: "second".into(),
                    },
                )
                .await
                .unwrap()
        );

        manager
            .create_filter_script(ScriptRequest {
                name: "broken-filter".into(),
                content: "error('boom')".into(),
            })
            .await
            .unwrap();
        assert!(
            manager
                .log_ids(LogIdsRequest {
                    session_id: Some(session.id),
                    filter: Some(SessionFilter {
                        option: Some(FilterOption::Script {
                            script_name: "broken-filter".into(),
                        }),
                        input: "anything".into(),
                    }),
                    ids: None,
                    min_id: None,
                    max_id: None,
                    limit: None,
                })
                .await
                .unwrap()
                .matched_ids
                .is_empty()
        );
        assert!(
            manager
                .debug_filter_script(
                    "broken-filter".into(),
                    DebugFilterScriptRequest {
                        session_id: Some(session.id),
                        log_id: first,
                        input: "anything".into(),
                    },
                )
                .await
                .is_err()
        );

        let empty = SessionFilter {
            option: Some(FilterOption::Script {
                script_name: "path-is".into(),
            }),
            input: String::new(),
        };
        let all = manager
            .log_ids(LogIdsRequest {
                session_id: Some(session.id),
                filter: Some(empty.clone()),
                ids: None,
                min_id: None,
                max_id: None,
                limit: None,
            })
            .await
            .unwrap();
        assert_eq!(all.matched_ids, vec![second, first]);
        assert_eq!(
            manager.session_view(Some(session.id)).await.unwrap().filter,
            original
        );

        let spaced = SessionFilter {
            option: Some(FilterOption::Column {
                column: FilterColumn::Uri,
                regex: false,
            }),
            input: " /First ".into(),
        };
        assert!(
            manager
                .log_ids(LogIdsRequest {
                    session_id: Some(session.id),
                    filter: Some(spaced),
                    ids: None,
                    min_id: None,
                    max_id: None,
                    limit: None,
                })
                .await
                .unwrap()
                .matched_ids
                .is_empty()
        );
    }

    #[tokio::test]
    async fn session_views_validate_new_references_and_script_updates_keep_names() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let manager = MitmManager::new(runtime);

        let error = manager
            .replace_session_view(
                Some(session.id),
                ReplaceSessionViewRequest {
                    columns: vec![Column::Script {
                        width: 100.0,
                        script_name: "missing".into(),
                    }],
                },
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);

        manager
            .create_column_script(ScriptRequest {
                name: "old".into(),
                content: "entry.req().method()".into(),
            })
            .await
            .unwrap();
        manager
            .replace_session_view(
                Some(session.id),
                ReplaceSessionViewRequest {
                    columns: vec![Column::Script {
                        width: 100.0,
                        script_name: "old".into(),
                    }],
                },
            )
            .await
            .unwrap();
        manager
            .update_column_script(
                "old".into(),
                UpdateScriptRequest {
                    content: "-- #display_name: 请求主机\nreturn entry.req().uri().host()".into(),
                },
            )
            .await
            .unwrap();

        let view = manager.session_view(Some(session.id)).await.unwrap();
        let script =
            serde_json::to_value(manager.column_script("old".into()).await.unwrap()).unwrap();
        assert_eq!(script["name"], "old");
        assert_eq!(script["display_name"], "请求主机");
        manager
            .update_column_script(
                "old".into(),
                UpdateScriptRequest {
                    content: "-- #display_name:\nreturn 'ok'".into(),
                },
            )
            .await
            .unwrap();
        let scripts = serde_json::to_value(manager.column_scripts().await.unwrap()).unwrap();
        assert!(scripts[0].get("display_name").is_none());
        assert!(matches!(
            &view.columns[0],
            Column::Script { script_name, .. } if script_name == "old"
        ));
        manager.delete_column_script("old".into()).await.unwrap();
        assert!(
            manager
                .session_view(Some(session.id))
                .await
                .unwrap()
                .columns
                .is_empty()
        );
    }

    #[tokio::test]
    async fn session_interceptors_validate_and_report_global_usage() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let first = runtime.create_session(NewSession::default()).unwrap();
        let second = runtime
            .create_session(NewSession {
                name: Some("second".into()),
                ..Default::default()
            })
            .unwrap();
        let manager = MitmManager::new(runtime);
        manager
            .create_interceptor(InterceptorCreateRequest {
                kind: InterceptorKind::Request,
                name: "header".into(),
                content: "-- #display_name: 请求头处理".into(),
            })
            .await
            .unwrap();

        manager
            .replace_session_interceptors(
                Some(first.id),
                ReplaceSessionInterceptorsRequest {
                    request: vec![SessionInterceptorInput {
                        name: "header".into(),
                        enabled: true,
                    }],
                    response: vec![],
                },
            )
            .await
            .unwrap();

        let first_chain = manager.session_interceptors(Some(first.id)).await.unwrap();
        assert!(first_chain.request[0].valid);
        assert_eq!(
            first_chain.request[0].display_name.as_deref(),
            Some("请求头处理")
        );
        let detail = manager
            .interceptor(InterceptorKind::Request, "header".into())
            .await
            .unwrap();
        assert_eq!(detail.display_name.as_deref(), Some("请求头处理"));
        assert!(
            manager
                .session_interceptors(Some(second.id))
                .await
                .unwrap()
                .request
                .is_empty()
        );
        let library = manager
            .interceptors(InterceptorKind::Request)
            .await
            .unwrap();
        assert_eq!(library.items[0].usage_count, 1);
        assert_eq!(library.items[0].name, "header");
        assert_eq!(library.items[0].display_name.as_deref(), Some("请求头处理"));

        let error = manager
            .replace_session_interceptors(
                Some(first.id),
                ReplaceSessionInterceptorsRequest {
                    request: vec![
                        SessionInterceptorInput {
                            name: "header".into(),
                            enabled: true,
                        },
                        SessionInterceptorInput {
                            name: "header".into(),
                            enabled: false,
                        },
                    ],
                    response: vec![],
                },
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::BadRequest);
    }
}
