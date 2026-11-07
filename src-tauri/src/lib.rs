mod body_download;
mod cert_install;
mod file_writer;
mod http_permissions;
mod share_ui;
mod skill_manager;
mod system_proxy;
mod workspace_selection;

use std::sync::{Arc, Mutex, RwLock};

use proxy_crab_mgr::{
    MitmManager, ProxyCrabManager,
    clash_subscription::{
        ClashConfig, ClashSubscriptionState, EnableClashSubscriptionRequest, SaveClashConfigRequest,
    },
    dto::{
        ActiveSession, AgentsPresetState, BreakpointDetailPayload, BreakpointQuery, BypassPage,
        BypassQuery, CertificateResponse, CreateAgentsPresetRequest, CreateEnvSetRequest,
        CreateRequestLibraryRequest, CreateSessionRequest, DebugFilterScriptRequest, DeleteCount,
        EnvSetsPayload, EnvWriteBackRequest, EnvWriteBackResult, ExecuteTemporaryScriptRequest,
        ExtendBreakpointRequest, FlowListQuery, FlowProjectCreateRequest, FlowProjectPage,
        FlowProjectUpdateRequest, FlowRenderPreviewRequest, FlowRunDetailPayload, FlowRunListQuery,
        FlowRunPage, FlowRunTriggerRequest, FlowScriptDryRunRequest, HttpApiChange,
        HttpApiResource, HttpServiceStatus, IngestCaptureRequest, InterceptorCreateRequest,
        InterceptorDetail, InterceptorLibraryList, InterceptorUpdateRequest, LogDetail,
        LogIdsPayload, LogIdsRequest, LogViewsPayload, LogViewsRequest, ManagerError,
        ReplaceActiveEnvSetRequest, ReplaceEnvGlobalsRequest, ReplaceSessionInterceptorsRequest,
        ReplaceSessionViewRequest, ReplayRequestPayload, ReplayResult, RequestLibraryPage,
        RequestLibraryQuery, RoutingSelection, SaveEnvSetRequest, ScriptRequest,
        SessionInterceptorsPayload, SessionViewPayload, SessionsPayload, SystemLogsQuery,
        UpdateAgentsPresetRequest, UpdateRequestLibraryRequest, UpdateScriptRequest,
        UpdateSessionRequest, WorkflowCreateRequest, WorkflowImportRequest, WorkflowImportResult,
        WorkflowListQuery, WorkflowPage, WorkflowUpdateRequest, WorkflowValidationIssue,
    },
    http::{HttpServerHandle, start_http_server_with_routes},
    session_share::{
        SessionShareConfig, SessionShareService, SessionShareState, SessionSharesPayload,
    },
    skill_install,
};
use proxy_crab_mitm::{
    ProxyCrab,
    flow::{
        dry_run::ScriptDryRunOutput,
        env_sets::EnvGlobalVariables,
        mcp_audit::McpAuditEntry,
        mcp_tiers::McpTiers,
        model::{Project, Workflow},
        render_preview::RenderPreviewOutput,
        run_store::FlowRunRecord,
        store::{EnvVariableSet, RequestLibraryEntry},
        transfer,
    },
    log_buffer::{BufferLayer, LogBuffer},
    model::{
        AppConfig, BreakpointSummary, InterceptorKind, InterceptorScriptContent,
        InterceptorSnapshot, ProxyStatus, Script, SessionFilter, SessionMetadata, SystemLogEntry,
        TemporaryExecutionResult,
    },
};
use tauri::{Emitter, Manager, RunEvent, State};
use tauri_plugin_dialog::DialogExt;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::http_permissions::{
    ApiActionView, CreatedApiKey, HttpPermissionService, IdentityPermissions, PendingApproval,
    PermissionEntry, PermissionIdentitySummary, ResolveApprovalRequest,
};
use crate::skill_manager::{SkillManager, SkillManagerState, SkillSaveResult};
use crate::workspace_selection::{WorkspacePaths, WorkspaceSelection};

struct BackendState {
    manager: Arc<dyn ProxyCrabManager>,
    permissions: Option<Arc<HttpPermissionService>>,
    permission_error: Option<String>,
    http: Mutex<Option<HttpServerHandle>>,
    http_error: RwLock<Option<String>>,
    shares: Arc<SessionShareService>,
    skill_manager: SkillManager,
    workspace: WorkspaceSelection,
}

#[tauri::command]
async fn list_session_shares(
    state: State<'_, BackendState>,
) -> Result<SessionSharesPayload, ManagerError> {
    state.shares.list(&state.manager()).await
}

#[tauri::command]
async fn import_bundle(
    app: tauri::AppHandle,
    state: State<'_, BackendState>,
    bytes: Vec<u8>,
    accepted_intent_ids: Vec<String>,
) -> Result<proxy_crab_mgr::bundle::ImportResult, ManagerError> {
    let result = state
        .manager()
        .import_bundle(bytes, accepted_intent_ids)
        .await?;
    if result.import_id.is_none() {
        let _ = app.emit(
            "proxycrab://http-api-change",
            HttpApiChange {
                resources: vec![HttpApiResource::All],
                session_id: None,
            },
        );
    }
    Ok(result)
}
#[tauri::command]
async fn resolve_bundle(
    app: tauri::AppHandle,
    state: State<'_, BackendState>,
    id: String,
    resolutions: Vec<proxy_crab_mgr::bundle::Resolution>,
) -> Result<proxy_crab_mgr::bundle::ImportResult, ManagerError> {
    let result = state.manager().resolve_bundle(id, resolutions).await?;
    if result.import_id.is_none() {
        let _ = app.emit(
            "proxycrab://http-api-change",
            HttpApiChange {
                resources: vec![HttpApiResource::All],
                session_id: None,
            },
        );
    }
    Ok(result)
}

#[tauri::command]
async fn get_session_share(
    state: State<'_, BackendState>,
    session_id: u64,
) -> Result<SessionShareState, ManagerError> {
    state.shares.status(&state.manager(), session_id).await
}

#[tauri::command]
async fn enable_session_share(
    state: State<'_, BackendState>,
    session_id: u64,
    session_share_config: Option<SessionShareConfig>,
) -> Result<SessionShareState, ManagerError> {
    state.permissions()?;
    state
        .shares
        .enable_with_config(&state.manager(), session_id, session_share_config)
        .await
}

#[tauri::command]
async fn disable_session_share(
    state: State<'_, BackendState>,
    session_id: u64,
) -> Result<SessionShareState, ManagerError> {
    state.shares.disable(&state.manager(), session_id).await
}

impl BackendState {
    fn manager(&self) -> Arc<dyn ProxyCrabManager> {
        self.manager.clone()
    }

    fn permissions(&self) -> Result<Arc<HttpPermissionService>, ManagerError> {
        self.permissions.clone().ok_or_else(|| {
            ManagerError::internal(
                self.permission_error
                    .clone()
                    .unwrap_or_else(|| "management API permissions are unavailable".into()),
            )
        })
    }
}

#[tauri::command]
async fn get_workspace(state: State<'_, BackendState>) -> Result<WorkspacePaths, ManagerError> {
    state.workspace.paths()
}

#[tauri::command]
async fn switch_workspace(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), ManagerError> {
    let restart = tauri::async_runtime::spawn_blocking(move || {
        let state = window.state::<BackendState>();
        let selected = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("切换工作区")
            .set_directory(state.workspace.current_path())
            .blocking_pick_folder();
        let Some(selected) = selected else {
            return Ok(false);
        };
        let path = selected
            .into_path()
            .map_err(|error| ManagerError::bad_request(format!("无法访问所选目录：{error}")))?;
        state.workspace.select_for_restart(&path)
    })
    .await
    .map_err(|error| ManagerError::internal(format!("切换工作区失败：{error}")))??;
    if restart {
        // Run the existing Exit handler to stop the proxy and management HTTP service.
        app.request_restart();
    }
    Ok(())
}

#[tauri::command]
async fn get_config(state: State<'_, BackendState>) -> Result<AppConfig, ManagerError> {
    state.manager().config().await
}

#[tauri::command]
async fn replace_config(
    state: State<'_, BackendState>,
    config: AppConfig,
) -> Result<AppConfig, ManagerError> {
    state.manager().replace_config(config).await
}

#[tauri::command]
async fn get_agents_presets(
    state: State<'_, BackendState>,
) -> Result<AgentsPresetState, ManagerError> {
    state.manager().agents_presets().await
}

#[tauri::command]
async fn create_agents_preset(
    state: State<'_, BackendState>,
    request: CreateAgentsPresetRequest,
) -> Result<AgentsPresetState, ManagerError> {
    state.manager().create_agents_preset(request).await
}

#[tauri::command]
async fn update_agents_preset(
    state: State<'_, BackendState>,
    id: String,
    request: UpdateAgentsPresetRequest,
) -> Result<AgentsPresetState, ManagerError> {
    state.manager().update_agents_preset(id, request).await
}

#[tauri::command]
async fn activate_agents_preset(
    state: State<'_, BackendState>,
    id: String,
) -> Result<AgentsPresetState, ManagerError> {
    state.manager().activate_agents_preset(id).await
}

#[tauri::command]
async fn delete_agents_preset(
    state: State<'_, BackendState>,
    id: String,
) -> Result<AgentsPresetState, ManagerError> {
    state.manager().delete_agents_preset(id).await
}

#[tauri::command]
async fn reimport_default_agents_presets(
    state: State<'_, BackendState>,
) -> Result<AgentsPresetState, ManagerError> {
    state.manager().reimport_default_agents_presets().await
}

#[tauri::command]
async fn get_proxy_status(state: State<'_, BackendState>) -> Result<ProxyStatus, ManagerError> {
    state.manager().proxy_status().await
}

/// Enumerates the machine's IPv4 addresses (including loopback) for display
/// in the UI. The management HTTP service currently listens on IPv4 only.
#[tauri::command]
fn list_local_ips() -> Vec<String> {
    let mut ips: Vec<String> = if_addrs::get_if_addrs()
        .map(|interfaces| {
            interfaces
                .into_iter()
                .map(|interface| interface.addr.ip())
                .filter(|ip| ip.is_ipv4())
                .map(|ip| ip.to_string())
                .collect()
        })
        .unwrap_or_default();
    ips.sort();
    ips.dedup();
    ips
}

#[tauri::command]
async fn start_proxy(state: State<'_, BackendState>) -> Result<ProxyStatus, ManagerError> {
    let status = state.manager().start_proxy().await?;
    if let ProxyStatus::Running { port, .. } = &status
        && let Err(error) = system_proxy::enable(state.workspace.app_data_dir(), *port)
    {
        tracing::warn!("failed to take over the system proxy: {error}");
    }
    Ok(status)
}

#[tauri::command]
async fn stop_proxy(state: State<'_, BackendState>) -> Result<ProxyStatus, ManagerError> {
    let status = state.manager().stop_proxy().await?;
    if let Err(error) = system_proxy::restore(state.workspace.app_data_dir()) {
        tracing::warn!("failed to restore the system proxy: {error}");
    }
    Ok(status)
}

/// 当前系统代理接管状态；非 Windows 平台 `supported` 为 false。
#[tauri::command]
fn get_system_proxy_status(state: State<'_, BackendState>) -> system_proxy::SystemProxyStatus {
    system_proxy::status(state.workspace.app_data_dir())
}

/// CA 在当前系统证书存储中的安装状态。
#[tauri::command]
async fn get_certificate_install_status(
    state: State<'_, BackendState>,
) -> Result<cert_install::CertificateInstallState, ManagerError> {
    let certificate = state.manager().certificate().await?;
    Ok(cert_install::install_status(&certificate.pem))
}

/// 一键安装 CA 到当前用户受信任的根证书存储；系统会弹出一次确认框。
#[tauri::command]
fn install_certificate(state: State<'_, BackendState>) -> Result<(), String> {
    cert_install::install(&state.workspace.current_path().join("proxy-crab-ca.crt"))
}

#[tauri::command]
async fn list_sessions(state: State<'_, BackendState>) -> Result<SessionsPayload, ManagerError> {
    state.manager().sessions().await
}

#[tauri::command]
async fn list_archived_sessions(
    state: State<'_, BackendState>,
) -> Result<Vec<SessionMetadata>, ManagerError> {
    state.manager().archived_sessions().await
}

#[tauri::command]
async fn replace_active_session(
    state: State<'_, BackendState>,
    active: ActiveSession,
) -> Result<ActiveSession, ManagerError> {
    state.manager().replace_active_session(active).await
}

#[tauri::command]
async fn create_session(
    state: State<'_, BackendState>,
    request: CreateSessionRequest,
) -> Result<SessionMetadata, ManagerError> {
    state.manager().create_session(request).await
}

#[tauri::command]
async fn update_session(
    state: State<'_, BackendState>,
    id: u64,
    request: UpdateSessionRequest,
) -> Result<SessionMetadata, ManagerError> {
    state.manager().update_session(id, request).await
}

#[tauri::command]
async fn archive_session(
    state: State<'_, BackendState>,
    id: u64,
) -> Result<SessionMetadata, ManagerError> {
    state.manager().archive_session(id).await
}

#[tauri::command]
async fn restore_session(
    state: State<'_, BackendState>,
    id: u64,
) -> Result<SessionMetadata, ManagerError> {
    state.manager().restore_session(id).await
}

#[tauri::command]
async fn delete_archived_session(
    state: State<'_, BackendState>,
    id: u64,
) -> Result<(), ManagerError> {
    state
        .shares
        .delete_archived_session(&state.manager(), id)
        .await
}

#[tauri::command]
async fn get_log_ids(
    state: State<'_, BackendState>,
    request: LogIdsRequest,
) -> Result<LogIdsPayload, ManagerError> {
    state.manager().log_ids(request).await
}

#[tauri::command]
async fn get_log_views(
    state: State<'_, BackendState>,
    request: LogViewsRequest,
) -> Result<LogViewsPayload, ManagerError> {
    state.manager().log_views(request).await
}

#[tauri::command]
fn validate_filter_regex(pattern: String) -> Option<String> {
    filter_regex_error(&pattern)
}

fn filter_regex_error(pattern: &str) -> Option<String> {
    regex::Regex::new(pattern)
        .err()
        .map(|error| error.to_string())
}

#[tauri::command]
async fn replay(
    state: State<'_, BackendState>,
    session_id: u64,
    request: ReplayRequestPayload,
) -> Result<ReplayResult, ManagerError> {
    state.manager().replay(session_id, request).await
}

#[tauri::command]
async fn list_assets(
    state: State<'_, BackendState>,
) -> Result<Vec<proxy_crab_mgr::asset::AssetMetadata>, ManagerError> {
    state.manager().assets().await
}

#[tauri::command]
async fn upload_asset(
    state: State<'_, BackendState>,
    request: tauri::ipc::Request<'_>,
) -> Result<proxy_crab_mgr::asset::AssetMetadata, ManagerError> {
    use proxy_crab_mgr::{dto::ErrorCode, manager::map_asset_error};
    let id = request
        .headers()
        .get("x-asset-id")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ManagerError::new(ErrorCode::InvalidAssetId, "missing asset id"))?;
    let content_type = request
        .headers()
        .get("x-asset-content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream");
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(ManagerError::new(
            ErrorCode::AssetStoreFailed,
            "expected binary upload body",
        ));
    };
    let mut upload = state
        .manager()
        .begin_asset_upload(id.to_owned(), content_type.to_owned())
        .await?;
    upload.write(bytes).await.map_err(map_asset_error)?;
    upload.finish().await.map_err(map_asset_error)
}

#[tauri::command]
async fn get_log(
    state: State<'_, BackendState>,
    session_id: Option<u64>,
    id: u64,
) -> Result<LogDetail, ManagerError> {
    state.manager().log(session_id, id).await
}

#[tauri::command]
async fn get_websocket_messages(
    state: State<'_, BackendState>,
    session_id: u64,
    id: u64,
    side: String,
    after_id: u32,
    limit: Option<usize>,
) -> Result<proxy_crab_mitm::websocket::WebSocketPage, ManagerError> {
    let query = proxy_crab_mgr::dto::WebSocketQuery {
        session_id: Some(session_id),
        side,
        after_id,
        limit,
        max_size: None,
    };
    state
        .manager()
        .websocket_messages(
            Some(session_id),
            id,
            query.body_side()?,
            after_id,
            limit.unwrap_or(500),
        )
        .await
}

#[tauri::command]
async fn get_interceptor_content(
    state: State<'_, BackendState>,
    session_id: Option<u64>,
    id: u64,
    execution_id: u64,
) -> Result<InterceptorScriptContent, ManagerError> {
    state
        .manager()
        .interceptor_script_content(session_id, id, execution_id)
        .await
}

#[tauri::command]
async fn get_interceptor_snapshot(
    state: State<'_, BackendState>,
    session_id: Option<u64>,
    id: u64,
    execution_id: u64,
) -> Result<InterceptorSnapshot, ManagerError> {
    state
        .manager()
        .interceptor_snapshot(session_id, id, execution_id)
        .await
}

#[tauri::command]
async fn list_breakpoints(
    state: State<'_, BackendState>,
    query: BreakpointQuery,
) -> Result<Vec<BreakpointSummary>, ManagerError> {
    state.manager().breakpoints(query).await
}

#[tauri::command]
async fn get_breakpoint(
    state: State<'_, BackendState>,
    id: u64,
) -> Result<BreakpointDetailPayload, ManagerError> {
    state.manager().breakpoint(id).await
}

#[tauri::command]
async fn extend_breakpoint(
    state: State<'_, BackendState>,
    id: u64,
    request: ExtendBreakpointRequest,
) -> Result<BreakpointSummary, ManagerError> {
    state.manager().extend_breakpoint(id, request).await
}

#[tauri::command]
async fn release_breakpoint(state: State<'_, BackendState>, id: u64) -> Result<(), ManagerError> {
    state.manager().release_breakpoint(id).await
}

#[tauri::command]
async fn execute_breakpoint_script(
    state: State<'_, BackendState>,
    id: u64,
    request: ExecuteTemporaryScriptRequest,
) -> Result<TemporaryExecutionResult, ManagerError> {
    state.manager().execute_breakpoint_script(id, request).await
}

#[tauri::command]
async fn get_session_view(
    state: State<'_, BackendState>,
    session_id: Option<u64>,
) -> Result<SessionViewPayload, ManagerError> {
    state.manager().session_view(session_id).await
}

#[tauri::command]
async fn replace_session_view(
    state: State<'_, BackendState>,
    session_id: Option<u64>,
    request: ReplaceSessionViewRequest,
) -> Result<SessionViewPayload, ManagerError> {
    state
        .manager()
        .replace_session_view(session_id, request)
        .await
}

#[tauri::command]
async fn replace_session_filter(
    state: State<'_, BackendState>,
    session_id: u64,
    filter: SessionFilter,
) -> Result<SessionViewPayload, ManagerError> {
    state
        .manager()
        .replace_session_filter(session_id, filter)
        .await
}

#[tauri::command]
async fn list_column_scripts(state: State<'_, BackendState>) -> Result<Vec<Script>, ManagerError> {
    state.manager().column_scripts().await
}

#[tauri::command]
async fn create_column_script(
    state: State<'_, BackendState>,
    request: ScriptRequest,
) -> Result<(), ManagerError> {
    state.manager().create_column_script(request).await
}

#[tauri::command]
async fn get_column_script(
    state: State<'_, BackendState>,
    name: String,
) -> Result<Script, ManagerError> {
    state.manager().column_script(name).await
}

#[tauri::command]
async fn update_column_script(
    state: State<'_, BackendState>,
    name: String,
    request: UpdateScriptRequest,
) -> Result<(), ManagerError> {
    state.manager().update_column_script(name, request).await
}

#[tauri::command]
async fn delete_column_script(
    state: State<'_, BackendState>,
    name: String,
) -> Result<(), ManagerError> {
    state.manager().delete_column_script(name).await
}

#[tauri::command]
async fn list_filter_scripts(state: State<'_, BackendState>) -> Result<Vec<Script>, ManagerError> {
    state.manager().filter_scripts().await
}

#[tauri::command]
async fn create_filter_script(
    state: State<'_, BackendState>,
    request: ScriptRequest,
) -> Result<(), ManagerError> {
    state.manager().create_filter_script(request).await
}

#[tauri::command]
async fn get_filter_script(
    state: State<'_, BackendState>,
    name: String,
) -> Result<Script, ManagerError> {
    state.manager().filter_script(name).await
}

#[tauri::command]
async fn update_filter_script(
    state: State<'_, BackendState>,
    name: String,
    request: UpdateScriptRequest,
) -> Result<(), ManagerError> {
    state.manager().update_filter_script(name, request).await
}

#[tauri::command]
async fn delete_filter_script(
    state: State<'_, BackendState>,
    name: String,
) -> Result<(), ManagerError> {
    state.manager().delete_filter_script(name).await
}

#[tauri::command]
async fn debug_filter_script(
    state: State<'_, BackendState>,
    name: String,
    request: DebugFilterScriptRequest,
) -> Result<bool, ManagerError> {
    state.manager().debug_filter_script(name, request).await
}

#[tauri::command]
async fn list_routing_scripts(state: State<'_, BackendState>) -> Result<Vec<Script>, ManagerError> {
    state.manager().routing_scripts().await
}

#[tauri::command]
async fn create_routing_script(
    state: State<'_, BackendState>,
    request: ScriptRequest,
) -> Result<(), ManagerError> {
    state.manager().create_routing_script(request).await
}

#[tauri::command]
async fn get_routing_script(
    state: State<'_, BackendState>,
    name: String,
) -> Result<Script, ManagerError> {
    state.manager().routing_script(name).await
}

#[tauri::command]
async fn update_routing_script(
    state: State<'_, BackendState>,
    name: String,
    request: UpdateScriptRequest,
) -> Result<(), ManagerError> {
    state.manager().update_routing_script(name, request).await
}

#[tauri::command]
async fn delete_routing_script(
    state: State<'_, BackendState>,
    name: String,
) -> Result<(), ManagerError> {
    state.manager().delete_routing_script(name).await
}

#[tauri::command]
async fn get_routing_selection(
    state: State<'_, BackendState>,
) -> Result<RoutingSelection, ManagerError> {
    state.manager().routing_selection().await
}

#[tauri::command]
async fn replace_routing_selection(
    state: State<'_, BackendState>,
    selection: RoutingSelection,
) -> Result<RoutingSelection, ManagerError> {
    state.manager().replace_routing_selection(selection).await
}

#[tauri::command]
async fn get_env_sets(state: State<'_, BackendState>) -> Result<EnvSetsPayload, ManagerError> {
    state.manager().env_sets().await
}

#[tauri::command]
async fn create_env_set(
    state: State<'_, BackendState>,
    request: CreateEnvSetRequest,
) -> Result<EnvVariableSet, ManagerError> {
    state.manager().create_env_set(request).await
}

#[tauri::command]
async fn save_env_set(
    state: State<'_, BackendState>,
    id: String,
    request: SaveEnvSetRequest,
) -> Result<EnvVariableSet, ManagerError> {
    state.manager().save_env_set(id, request).await
}

#[tauri::command]
async fn delete_env_set(state: State<'_, BackendState>, id: String) -> Result<(), ManagerError> {
    state.manager().delete_env_set(id).await
}

#[tauri::command]
async fn replace_active_env_set(
    state: State<'_, BackendState>,
    request: ReplaceActiveEnvSetRequest,
) -> Result<Option<String>, ManagerError> {
    state.manager().replace_active_env_set(request).await
}

#[tauri::command]
async fn replace_env_globals(
    state: State<'_, BackendState>,
    request: ReplaceEnvGlobalsRequest,
) -> Result<EnvGlobalVariables, ManagerError> {
    state.manager().replace_env_globals(request).await
}

#[tauri::command]
async fn env_write_back(
    state: State<'_, BackendState>,
    request: EnvWriteBackRequest,
) -> Result<EnvWriteBackResult, ManagerError> {
    state.manager().env_write_back(request).await
}

#[tauri::command]
async fn get_request_library_page(
    state: State<'_, BackendState>,
    query: RequestLibraryQuery,
) -> Result<RequestLibraryPage, ManagerError> {
    state.manager().request_library_page(query).await
}

#[tauri::command]
async fn get_request_library_entry(
    state: State<'_, BackendState>,
    id: String,
) -> Result<RequestLibraryEntry, ManagerError> {
    state.manager().request_library_entry(id).await
}

#[tauri::command]
async fn create_request_library_entry(
    state: State<'_, BackendState>,
    request: CreateRequestLibraryRequest,
) -> Result<RequestLibraryEntry, ManagerError> {
    state.manager().create_request_library_entry(request).await
}

#[tauri::command]
async fn update_request_library_entry(
    state: State<'_, BackendState>,
    id: String,
    request: UpdateRequestLibraryRequest,
) -> Result<RequestLibraryEntry, ManagerError> {
    state
        .manager()
        .update_request_library_entry(id, request)
        .await
}

#[tauri::command]
async fn delete_request_library_entry(
    state: State<'_, BackendState>,
    id: String,
) -> Result<(), ManagerError> {
    state.manager().delete_request_library_entry(id).await
}

#[tauri::command]
async fn ingest_request_from_capture(
    state: State<'_, BackendState>,
    request: IngestCaptureRequest,
) -> Result<RequestLibraryEntry, ManagerError> {
    state.manager().ingest_request_from_capture(request).await
}

/* ---- 请求工作流域（flow projects / workflows / 导入导出）----
 * 桌面信任面薄包装：直调管理 trait，与 HTTP 管理面同类型、同 camelCase
 * 线格式；命令层不加业务逻辑、不加工错误。 */

/// 分页列出 flow 项目；`query` 的 limit/offset 缺省时返回全量。
#[tauri::command]
async fn list_flow_projects(
    state: State<'_, BackendState>,
    query: FlowListQuery,
) -> Result<FlowProjectPage, ManagerError> {
    state.manager().flow_projects(query).await
}

/// 新建 flow 项目（id 与时间戳由服务端生成）。
#[tauri::command]
async fn create_flow_project(
    state: State<'_, BackendState>,
    request: FlowProjectCreateRequest,
) -> Result<Project, ManagerError> {
    state.manager().create_flow_project(request).await
}

/// 读取单个 flow 项目；不存在返回 404 not_found。
#[tauri::command]
async fn get_flow_project(
    state: State<'_, BackendState>,
    id: String,
) -> Result<Project, ManagerError> {
    state.manager().flow_project(id).await
}

/// 局部更新 flow 项目：仅替换请求中出现的字段。
#[tauri::command]
async fn update_flow_project(
    state: State<'_, BackendState>,
    id: String,
    request: FlowProjectUpdateRequest,
) -> Result<Project, ManagerError> {
    state.manager().update_flow_project(id, request).await
}

/// 删除 flow 项目；其中流程的去留语义与 HTTP 层一致（由 manager 决定）。
#[tauri::command]
async fn delete_flow_project(
    state: State<'_, BackendState>,
    id: String,
) -> Result<(), ManagerError> {
    state.manager().delete_flow_project(id).await
}

/// 列出流程定义；`query.project_id` 过滤所属项目后再分页。
#[tauri::command]
async fn list_workflows(
    state: State<'_, BackendState>,
    query: WorkflowListQuery,
) -> Result<WorkflowPage, ManagerError> {
    state.manager().workflows(query).await
}

/// 新建流程定义（id 与时间戳由服务端生成）。
#[tauri::command]
async fn create_workflow(
    state: State<'_, BackendState>,
    request: WorkflowCreateRequest,
) -> Result<Workflow, ManagerError> {
    state.manager().create_workflow(request).await
}

/// 读取单个流程定义；不存在返回 404 not_found。
#[tauri::command]
async fn get_workflow(
    state: State<'_, BackendState>,
    id: String,
) -> Result<Workflow, ManagerError> {
    state.manager().workflow(id).await
}

/// 保存流程画布图：`nodes`+`edges` 作为整体图单元必须成对出现，
/// 其他出现的字段逐项替换（语义在 manager 内实现）。
#[tauri::command]
async fn save_workflow_graph(
    state: State<'_, BackendState>,
    id: String,
    request: WorkflowUpdateRequest,
) -> Result<Workflow, ManagerError> {
    state.manager().update_workflow(id, request).await
}

/// 删除流程定义。
#[tauri::command]
async fn delete_workflow(state: State<'_, BackendState>, id: String) -> Result<(), ManagerError> {
    state.manager().delete_workflow(id).await
}

/// 校验流程图，返回阻塞运行的 issue 列表（不阻塞保存）。
#[tauri::command]
async fn validate_workflow(
    state: State<'_, BackendState>,
    id: String,
) -> Result<Vec<WorkflowValidationIssue>, ManagerError> {
    state.manager().validate_workflow(id).await
}

/// 导出流程信封文档本体（secret 置空、携带引用的请求库条目；桌面由前端
/// 映射层经 saveFile 落盘，非 HTTP 下载）。未知 id 返回 404。
#[tauri::command]
async fn export_workflows(
    state: State<'_, BackendState>,
    ids: Vec<String>,
) -> Result<transfer::WorkflowExportFile, ManagerError> {
    state.manager().export_workflows(ids).await
}

/// 导入一份流程导出信封：形状校验、确认脚本语义、名称去重与 id 重映射
/// 均发生在写入前（语义在 manager 内实现）。
#[tauri::command]
async fn import_workflows(
    state: State<'_, BackendState>,
    request: WorkflowImportRequest,
) -> Result<WorkflowImportResult, ManagerError> {
    state.manager().import_workflows(request).await
}

/* ---- 运行域（workflow runs）：错误码由 manager 映射后在命令层原样透传 ---- */

/// 分页列出运行记录（最新在前）；先按 workflow/status 过滤再分页。
#[tauri::command]
async fn list_flow_runs(
    state: State<'_, BackendState>,
    query: FlowRunListQuery,
) -> Result<FlowRunPage, ManagerError> {
    state.manager().workflow_runs(query).await
}

/// 读取运行详情（含逐节点 checkpoint `nodeRuns`）；图快照随记录走，
/// 流程定义变更后仍可渲染。
#[tauri::command]
async fn get_flow_run_detail(
    state: State<'_, BackendState>,
    run_id: String,
) -> Result<FlowRunDetailPayload, ManagerError> {
    state.manager().workflow_run_detail(run_id).await
}

/// 触发一次运行：立即返回运行记录（编排任务异步执行）。前置条件失败
/// 不落库，错误码（409 proxy_not_running / 404 not_found / 409 conflict /
/// 422 workflow_graph_invalid / 运行记录库不可用）在 manager 内完成映射。
#[tauri::command]
async fn trigger_flow_run(
    state: State<'_, BackendState>,
    request: FlowRunTriggerRequest,
) -> Result<FlowRunRecord, ManagerError> {
    state.manager().trigger_workflow_run(request).await
}

/// 取消运行中的记录；取消已结束/未知记录返回 404（不做幂等承诺）。
#[tauri::command]
async fn cancel_flow_run(
    state: State<'_, BackendState>,
    run_id: String,
) -> Result<(), ManagerError> {
    state.manager().cancel_workflow_run(run_id).await
}

/// 试跑一个前置/后置脚本：一次性 VM 内执行，不落库、不广播。成功返回
/// `{ok,value,warnings}`，失败返回 `{ok:false,error:{kind,message}}`
/// （kind：syntax|blocked|runtime|timeout|invalid-return）。
#[tauri::command]
async fn flow_script_dry_run(
    state: State<'_, BackendState>,
    request: FlowScriptDryRunRequest,
) -> Result<ScriptDryRunOutput, ManagerError> {
    state.manager().flow_script_dry_run(request).await
}

/// 预览一个 httpReplay 节点的请求面（模板渲染 dry-run）：一次性 VM 内渲染
/// 「将要发出」的请求，零出站、不落库、不广播；preProcess 脚本不执行。
/// 成功返回 `{ok,baseline,request,warnings}`（secret 已脱敏），工作流/节点
/// 不存在或节点无请求面按 HTTP 同构错误返回。
#[tauri::command]
async fn flow_render_preview(
    state: State<'_, BackendState>,
    request: FlowRenderPreviewRequest,
) -> Result<RenderPreviewOutput, ManagerError> {
    state.manager().flow_render_preview(request).await
}

/* ---- MCP 暴露档位 / 调用审计（设置窗口两分区）---- */

/// 读取 MCP 暴露三档开关（读/写/执行；缺省读开、写/执行关）。
#[tauri::command]
async fn get_mcp_tiers(state: State<'_, BackendState>) -> Result<McpTiers, ManagerError> {
    state.manager().mcp_tiers().await
}

/// 整体替换 MCP 暴露三档开关并返回保存后的值。
#[tauri::command]
async fn replace_mcp_tiers(
    state: State<'_, BackendState>,
    tiers: McpTiers,
) -> Result<McpTiers, ManagerError> {
    state.manager().replace_mcp_tiers(tiers).await
}

/// 查询 MCP 工具调用审计（seq 倒序，最新在前）；`limit` 缺省 100，
/// 上限由存储层收敛（500），与 `GET /api/mcp-audit` 同语义。
#[tauri::command]
async fn list_mcp_audit(
    state: State<'_, BackendState>,
    limit: Option<usize>,
) -> Result<Vec<McpAuditEntry>, ManagerError> {
    state.manager().mcp_audit(limit.unwrap_or(100)).await
}

/// 当前档位下 `POST /mcp` `tools/list` 会出现的工具数。
#[tauri::command]
async fn get_mcp_tool_count(state: State<'_, BackendState>) -> Result<usize, ManagerError> {
    state.manager().mcp_tool_count().await
}

#[tauri::command]
async fn list_interceptors(
    state: State<'_, BackendState>,
    kind: InterceptorKind,
) -> Result<InterceptorLibraryList, ManagerError> {
    state.manager().interceptors(kind).await
}

#[tauri::command]
async fn create_interceptor(
    state: State<'_, BackendState>,
    request: InterceptorCreateRequest,
) -> Result<(), ManagerError> {
    state.manager().create_interceptor(request).await
}

#[tauri::command]
async fn get_interceptor(
    state: State<'_, BackendState>,
    kind: InterceptorKind,
    name: String,
) -> Result<InterceptorDetail, ManagerError> {
    state.manager().interceptor(kind, name).await
}

#[tauri::command]
async fn update_interceptor(
    state: State<'_, BackendState>,
    kind: InterceptorKind,
    name: String,
    request: InterceptorUpdateRequest,
) -> Result<(), ManagerError> {
    state
        .manager()
        .update_interceptor(kind, name, request)
        .await
}

#[tauri::command]
async fn delete_interceptor(
    state: State<'_, BackendState>,
    kind: InterceptorKind,
    name: String,
) -> Result<(), ManagerError> {
    state.manager().delete_interceptor(kind, name).await
}

#[tauri::command]
async fn get_session_interceptors(
    state: State<'_, BackendState>,
    session_id: Option<u64>,
) -> Result<SessionInterceptorsPayload, ManagerError> {
    state.manager().session_interceptors(session_id).await
}

#[tauri::command]
async fn replace_session_interceptors(
    state: State<'_, BackendState>,
    session_id: Option<u64>,
    request: ReplaceSessionInterceptorsRequest,
) -> Result<SessionInterceptorsPayload, ManagerError> {
    state
        .manager()
        .replace_session_interceptors(session_id, request)
        .await
}

#[tauri::command]
async fn get_clash_subscription(
    state: State<'_, BackendState>,
) -> Result<ClashSubscriptionState, ManagerError> {
    state.manager().clash_subscription().await
}

#[tauri::command]
async fn enable_clash_subscription(
    state: State<'_, BackendState>,
    request: EnableClashSubscriptionRequest,
) -> Result<ClashSubscriptionState, ManagerError> {
    state.manager().enable_clash_subscription(request).await
}

#[tauri::command]
async fn disable_clash_subscription(
    state: State<'_, BackendState>,
) -> Result<ClashSubscriptionState, ManagerError> {
    state.manager().disable_clash_subscription().await
}

#[tauri::command]
async fn get_clash_config(state: State<'_, BackendState>) -> Result<ClashConfig, ManagerError> {
    state.manager().clash_config().await
}

#[tauri::command]
async fn save_clash_config(
    state: State<'_, BackendState>,
    request: SaveClashConfigRequest,
) -> Result<ClashConfig, ManagerError> {
    state.manager().save_clash_config(request).await
}

#[tauri::command]
async fn reset_clash_config(state: State<'_, BackendState>) -> Result<ClashConfig, ManagerError> {
    state.manager().reset_clash_config().await
}

#[tauri::command]
async fn get_certificate(
    state: State<'_, BackendState>,
) -> Result<CertificateResponse, ManagerError> {
    state.manager().certificate().await
}

#[tauri::command]
async fn regenerate_certificate(
    state: State<'_, BackendState>,
) -> Result<CertificateResponse, ManagerError> {
    state.manager().regenerate_certificate().await
}

#[tauri::command]
async fn get_system_logs(
    state: State<'_, BackendState>,
    query: SystemLogsQuery,
) -> Result<Vec<SystemLogEntry>, ManagerError> {
    state.manager().system_logs(query).await
}

#[tauri::command]
async fn clear_system_logs(state: State<'_, BackendState>) -> Result<(), ManagerError> {
    state.manager().clear_system_logs().await
}

#[tauri::command]
async fn get_bypass_entries(
    state: State<'_, BackendState>,
    query: BypassQuery,
) -> Result<BypassPage, ManagerError> {
    state.manager().bypass_entries(query).await
}

#[tauri::command]
async fn delete_bypass_entry(state: State<'_, BackendState>, id: u64) -> Result<(), ManagerError> {
    state.manager().delete_bypass_entry(id).await
}

#[tauri::command]
async fn delete_bypass_entries(
    state: State<'_, BackendState>,
    ids: Vec<u64>,
) -> Result<DeleteCount, ManagerError> {
    state.manager().delete_bypass_entries(ids).await
}

#[tauri::command]
async fn clear_bypass_entries(state: State<'_, BackendState>) -> Result<DeleteCount, ManagerError> {
    state.manager().clear_bypass_entries().await
}

#[tauri::command]
fn get_http_service_error(state: State<'_, BackendState>) -> Option<String> {
    state
        .http_error
        .read()
        .expect("HTTP status lock poisoned")
        .clone()
}

fn bundled_skill_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, ManagerError> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| ManagerError::internal(format!("resolve resource directory: {error}")))?
        .join("skills")
        .join("proxycrab");
    #[cfg(debug_assertions)]
    let bundled = if bundled.is_dir() {
        bundled
    } else {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("skills")
            .join("proxycrab")
    };
    Ok(bundled)
}

#[tauri::command]
fn get_proxycrab_skill_manager_state(
    state: State<'_, BackendState>,
) -> Result<SkillManagerState, ManagerError> {
    state.skill_manager.state()
}

#[tauri::command]
fn save_proxycrab_skill_paths(
    state: State<'_, BackendState>,
    paths: Vec<String>,
    delete_removed: bool,
) -> Result<SkillSaveResult, ManagerError> {
    state.skill_manager.save_paths(paths, delete_removed)
}

#[tauri::command]
fn sync_proxycrab_skills(
    state: State<'_, BackendState>,
) -> Result<SkillManagerState, ManagerError> {
    state.skill_manager.sync()
}

#[tauri::command]
async fn get_http_service_status(
    state: State<'_, BackendState>,
) -> Result<HttpServiceStatus, ManagerError> {
    let config = state.manager().config().await?;
    let running = state
        .http
        .lock()
        .expect("HTTP service lock poisoned")
        .as_ref()
        .is_some_and(HttpServerHandle::is_running);
    let mut error = state
        .http_error
        .read()
        .expect("HTTP status lock poisoned")
        .clone();
    if !running && error.is_none() {
        error = Some("management HTTP service is not running".into());
    }
    Ok(HttpServiceStatus {
        running,
        host: std::net::Ipv4Addr::UNSPECIFIED.to_string(),
        port: config.api_port,
        error,
    })
}

#[tauri::command]
fn get_http_permission_catalog(
    state: State<'_, BackendState>,
) -> Result<Vec<ApiActionView>, ManagerError> {
    Ok(state.permissions()?.catalog())
}

#[tauri::command]
fn list_http_permission_identities(
    state: State<'_, BackendState>,
) -> Result<Vec<PermissionIdentitySummary>, ManagerError> {
    state.permissions()?.identities()
}

#[tauri::command]
fn get_http_identity_permissions(
    state: State<'_, BackendState>,
    id: String,
) -> Result<IdentityPermissions, ManagerError> {
    state.permissions()?.identity_permissions(&id)
}

#[tauri::command]
fn replace_http_identity_permissions(
    state: State<'_, BackendState>,
    id: String,
    permissions: Vec<PermissionEntry>,
) -> Result<IdentityPermissions, ManagerError> {
    state.permissions()?.replace_permissions(&id, permissions)
}

#[tauri::command]
fn create_http_api_key(
    state: State<'_, BackendState>,
    name: String,
) -> Result<CreatedApiKey, ManagerError> {
    state.permissions()?.create_api_key(name)
}

#[tauri::command]
fn delete_http_api_key(state: State<'_, BackendState>, id: String) -> Result<(), ManagerError> {
    state.permissions()?.delete_api_key(&id)
}

#[tauri::command]
fn list_http_approvals(
    state: State<'_, BackendState>,
) -> Result<Vec<PendingApproval>, ManagerError> {
    state.permissions()?.approvals()
}

#[tauri::command]
fn resolve_http_approval(
    state: State<'_, BackendState>,
    id: u64,
    request: ResolveApprovalRequest,
) -> Result<(), ManagerError> {
    state.permissions()?.resolve_approval(id, request)
}

/// Wraps the generated IPC handler so every Tauri command invocation is echoed
/// directly to the terminal (stderr), bypassing tracing filters. The payload is
/// the JSON of the command's arguments, truncated for readability.
/// 仅在 dev 构建（`debug_assertions`）下输出日志；release 构建中为无操作包装。
fn logging_invoke_handler(
    handler: impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    move |invoke| {
        #[cfg(debug_assertions)]
        {
            let args = match invoke.message.payload() {
                tauri::ipc::InvokeBody::Json(value) => value.to_string(),
                tauri::ipc::InvokeBody::Raw(bytes) => format!("<raw:{} bytes>", bytes.len()),
            };
            let args = if args.chars().count() > 500 {
                let mut truncated: String = args.chars().take(500).collect();
                truncated.push_str("...<truncated>");
                truncated
            } else {
                args
            };
            eprintln!("[tauri-command] {} args={}", invoke.message.command(), args);
        }
        handler(invoke)
    }
}

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(file_writer::FileWriters::default())
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                webview
                    .state::<file_writer::FileWriters>()
                    .cleanup(webview.label());
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<file_writer::FileWriters>()
                    .cleanup(window.label());
            }
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let workspace = WorkspaceSelection::open(app_data_dir.clone())?;
            // 上次进程异常退出可能留下系统代理接管备份，启动时静默恢复。
            system_proxy::recover_if_needed(&app_data_dir);
            let log_buffer = Arc::new(LogBuffer::default());
            let _ = tracing_subscriber::registry()
                .with(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
                )
                .with(tracing_subscriber::fmt::layer())
                .with(BufferLayer::new(log_buffer.clone()))
                .try_init();
            let bundled_skill = bundled_skill_dir(app.handle()).unwrap_or_else(|error| {
                tracing::warn!("failed to resolve bundled Skill directory: {error}");
                app_data_dir.join("missing-bundled-skill")
            });
            let default_skill_parent = skill_install::normalize_parent("~/.agents/skills").ok();
            let skill_manager =
                SkillManager::open(app_data_dir.clone(), bundled_skill, default_skill_parent);
            let runtime = ProxyCrab::open(workspace.current_path(), log_buffer)?;
            let workspace_path = workspace.current_path().to_path_buf();
            let manager: Arc<dyn ProxyCrabManager> = MitmManager::new(runtime);
            let mut proxy_status_changes = manager.subscribe_proxy_status_changes();
            let status_app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while proxy_status_changes.changed().await.is_ok() {
                    let change = HttpApiChange {
                        resources: vec![HttpApiResource::Proxy],
                        session_id: None,
                    };
                    if let Err(error) =
                        status_app_handle.emit("proxycrab://http-api-change", change)
                    {
                        tracing::warn!("failed to emit proxy status change: {error}");
                    }
                }
            });
            let shares = SessionShareService::open(&workspace_path)?;
            let share_assets = app.asset_resolver();
            let approval_handle = app.handle().clone();
            let permissions = HttpPermissionService::open(
                &workspace_path,
                Arc::new(move |count| {
                    if let Err(error) = approval_handle.emit("proxycrab://approval-change", count) {
                        tracing::warn!("failed to emit approval change: {error}");
                    }
                }),
            );
            let permission_error = permissions.as_ref().err().map(ToString::to_string);
            let permissions = permissions.ok();
            if let Some(permissions) = &permissions {
                shares.set_permissions(permissions.clone());
            }
            let (http, http_error) = if let Some(permissions) = permissions.as_ref() {
                let share_manager = manager.clone();
                let share_service = shares.clone();
                match tauri::async_runtime::block_on(start_http_server_with_routes(
                    manager.clone(),
                    permissions.clone(),
                    shares.clone(),
                    move |_| {
                        share_ui::router(share_assets).merge(proxy_crab_mgr::session_share::router(
                            share_manager,
                            share_service,
                        ))
                    },
                )) {
                    Ok(handle) => (Some(handle), None),
                    Err(error) => {
                        tracing::error!("management HTTP service did not start: {error}");
                        (None, Some(error.to_string()))
                    }
                }
            } else {
                (None, permission_error.clone())
            };
            if let Some(http) = http.as_ref() {
                let mut changes = http.subscribe_changes();
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        let change = match changes.recv().await {
                            Ok(change) => change,
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                HttpApiChange {
                                    resources: vec![HttpApiResource::All],
                                    session_id: None,
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        };
                        if let Err(error) = app_handle.emit("proxycrab://http-api-change", change) {
                            tracing::warn!(
                                "failed to emit HTTP API change to the frontend: {error}"
                            );
                        }
                    }
                });
            }
            app.manage(BackendState {
                manager,
                permissions,
                permission_error,
                http: Mutex::new(http),
                http_error: RwLock::new(http_error),
                shares,
                skill_manager,
                workspace,
            });
            Ok(())
        })
        .invoke_handler(logging_invoke_handler(tauri::generate_handler![
            open_devtools,
            get_workspace,
            switch_workspace,
            get_config,
            replace_config,
            get_agents_presets,
            create_agents_preset,
            update_agents_preset,
            activate_agents_preset,
            delete_agents_preset,
            reimport_default_agents_presets,
            get_proxy_status,
            list_local_ips,
            start_proxy,
            stop_proxy,
            list_sessions,
            list_archived_sessions,
            replace_active_session,
            create_session,
            update_session,
            archive_session,
            restore_session,
            delete_archived_session,
            get_log_ids,
            get_log_views,
            validate_filter_regex,
            get_log,
            get_websocket_messages,
            body_download::fetch_websocket_message_body,
            body_download::read_asset,
            replay,
            list_assets,
            upload_asset,
            get_interceptor_content,
            get_interceptor_snapshot,
            list_breakpoints,
            get_breakpoint,
            extend_breakpoint,
            release_breakpoint,
            execute_breakpoint_script,
            get_session_view,
            replace_session_view,
            replace_session_filter,
            list_column_scripts,
            create_column_script,
            get_column_script,
            update_column_script,
            delete_column_script,
            list_redaction_scripts,
            create_redaction_script,
            get_redaction_script,
            update_redaction_script,
            delete_redaction_script,
            set_http_identity_redaction,
            list_filter_scripts,
            create_filter_script,
            get_filter_script,
            update_filter_script,
            delete_filter_script,
            debug_filter_script,
            list_routing_scripts,
            create_routing_script,
            get_routing_script,
            update_routing_script,
            delete_routing_script,
            get_routing_selection,
            replace_routing_selection,
            get_env_sets,
            create_env_set,
            save_env_set,
            delete_env_set,
            replace_active_env_set,
            replace_env_globals,
            env_write_back,
            get_request_library_page,
            get_request_library_entry,
            create_request_library_entry,
            update_request_library_entry,
            delete_request_library_entry,
            ingest_request_from_capture,
            list_flow_projects,
            create_flow_project,
            get_flow_project,
            update_flow_project,
            delete_flow_project,
            list_workflows,
            create_workflow,
            get_workflow,
            save_workflow_graph,
            delete_workflow,
            validate_workflow,
            export_workflows,
            import_workflows,
            list_flow_runs,
            get_flow_run_detail,
            trigger_flow_run,
            cancel_flow_run,
            flow_script_dry_run,
            flow_render_preview,
            get_mcp_tiers,
            replace_mcp_tiers,
            list_mcp_audit,
            get_mcp_tool_count,
            body_download::fetch_request_library_body,
            list_interceptors,
            create_interceptor,
            get_interceptor,
            update_interceptor,
            delete_interceptor,
            get_session_interceptors,
            replace_session_interceptors,
            get_certificate,
            get_clash_subscription,
            enable_clash_subscription,
            disable_clash_subscription,
            get_clash_config,
            save_clash_config,
            reset_clash_config,
            regenerate_certificate,
            get_system_proxy_status,
            get_certificate_install_status,
            install_certificate,
            file_writer::save_file_open,
            file_writer::save_file_append,
            file_writer::save_file_finish,
            file_writer::save_file_abort,
            body_download::fetch_body,
            body_download::download_body,
            get_system_logs,
            clear_system_logs,
            get_bypass_entries,
            delete_bypass_entry,
            delete_bypass_entries,
            clear_bypass_entries,
            get_http_service_error,
            get_http_service_status,
            list_session_shares,
            get_session_share,
            import_bundle,
            resolve_bundle,
            enable_session_share,
            disable_session_share,
            get_http_permission_catalog,
            list_http_permission_identities,
            get_http_identity_permissions,
            replace_http_identity_permissions,
            create_http_api_key,
            delete_http_api_key,
            list_http_approvals,
            resolve_http_approval,
            get_proxycrab_skill_manager_state,
            save_proxycrab_skill_paths,
            sync_proxycrab_skills,
        ]));

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building Tauri application");
    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            let state = app_handle.state::<BackendState>();
            let manager = state.manager();
            let http = state
                .http
                .lock()
                .expect("HTTP service lock poisoned")
                .take();
            let app_data_dir = state.workspace.app_data_dir().to_path_buf();
            tauri::async_runtime::block_on(async move {
                let _ = manager.stop_proxy().await;
                if let Some(http) = http {
                    http.shutdown().await;
                }
            });
            if let Err(error) = system_proxy::restore(&app_data_dir) {
                tracing::warn!("failed to restore the system proxy on exit: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn filter_regex_validation_uses_rust_regex_syntax() {
        assert!(super::filter_regex_error(r"(?i)^get$").is_none());
        assert!(super::filter_regex_error("(").is_some());
    }

    #[test]
    fn list_local_ips_returns_sorted_unique_ipv4() {
        let ips = super::list_local_ips();
        for ip in &ips {
            assert!(
                ip.parse::<std::net::Ipv4Addr>().is_ok(),
                "entry is not an IPv4 address: {ip}"
            );
        }
        assert!(
            ips.windows(2).all(|pair| pair[0] < pair[1]),
            "IPs must be sorted and deduplicated: {ips:?}"
        );
    }
}

#[tauri::command]
async fn list_redaction_scripts(
    state: State<'_, BackendState>,
) -> Result<Vec<Script>, ManagerError> {
    state.manager().redaction_scripts().await
}

#[tauri::command]
async fn create_redaction_script(
    state: State<'_, BackendState>,
    request: ScriptRequest,
) -> Result<(), ManagerError> {
    state.manager().create_redaction_script(request).await
}

#[tauri::command]
async fn get_redaction_script(
    state: State<'_, BackendState>,
    name: String,
) -> Result<Script, ManagerError> {
    state.manager().redaction_script(name).await
}

#[tauri::command]
async fn update_redaction_script(
    state: State<'_, BackendState>,
    name: String,
    request: UpdateScriptRequest,
) -> Result<(), ManagerError> {
    state.manager().update_redaction_script(name, request).await
}

#[tauri::command]
async fn delete_redaction_script(
    state: State<'_, BackendState>,
    name: String,
) -> Result<(), ManagerError> {
    state.manager().delete_redaction_script(name).await
}

#[tauri::command]
async fn set_http_identity_redaction(
    state: State<'_, BackendState>,
    id: String,
    redaction_script: Option<String>,
) -> Result<IdentityPermissions, ManagerError> {
    if let Some(name) = redaction_script.as_ref().filter(|name| !name.is_empty()) {
        state.manager().redaction_script(name.clone()).await?;
    }
    state.permissions()?.set_redaction(&id, redaction_script)
}
