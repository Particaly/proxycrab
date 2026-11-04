mod auth;

use std::{io, net::SocketAddr, pin::Pin, sync::Arc};

use async_compression::tokio::bufread::{
    BrotliDecoder, GzipDecoder, GzipEncoder, ZlibDecoder, ZlibEncoder, ZstdDecoder,
};
use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{
        ConnectInfo, FromRequest, FromRequestParts, MatchedPath, Path, Query, Request, State,
    },
    http::{
        HeaderMap, HeaderValue, Method, StatusCode,
        header::{
            ACCEPT_ENCODING, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_ENCODING, CONTENT_LENGTH,
            CONTENT_TYPE, VARY,
        },
        request::Parts,
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use bytes::Bytes;
use futures::{StreamExt, stream};
use proxy_crab_mitm::model::{InterceptorKind, InterceptorScriptContent, SessionFilter};
use proxy_crab_mitm::storage::{BodySide, BodySource, BodySourceData};
use proxy_crab_mitm::flow::run::FlowRunEvent;
use proxy_crab_mitm::flow::mcp_tiers::McpTiers;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, BufReader};
use tokio::{sync::broadcast, task::JoinHandle};
use tokio_util::{
    io::{ReaderStream, StreamReader},
    sync::CancellationToken,
};

use crate::{
    clash_subscription::{EnableClashSubscriptionRequest, SaveClashConfigRequest},
    dto::{
        ActiveSession, AssetQuery, BodyQuery, BreakpointQuery, BypassQuery,
        CreateEnvSetRequest, CreateRequestLibraryRequest, CreateSessionRequest,
        DebugFilterScriptRequest, DeleteBypassRequest, EnvWriteBackRequest, ErrorCode,
        ExecuteTemporaryScriptRequest, ExtendBreakpointRequest, FlowListQuery,
        FlowProjectCreateRequest, FlowProjectUpdateRequest, HttpApiChange, HttpApiResource,
        IngestCaptureRequest, InterceptorCreateRequest, InterceptorUpdateRequest,
        FlowRunListQuery, FlowRunTriggerRequest,
        FlowScriptDryRunRequest, LogIdsRequest, LogViewsRequest, ManagerError, ManagerResult,
        ReplaceActiveEnvSetRequest, ReplaceEnvGlobalsRequest,
        ReplaceSessionInterceptorsRequest, ReplaceSessionViewRequest, ReplayRequestPayload,
        RequestLibraryBodyQuery, RequestLibraryQuery, RoutingSelection, SaveEnvSetRequest,
        ScriptRequest, SessionQuery, SystemLogsQuery, UpdateRequestLibraryRequest,
        UpdateScriptRequest, UpdateSessionRequest, WebSocketQuery, WorkflowCreateRequest,
        WorkflowExportQuery, WorkflowImportRequest, WorkflowListQuery, WorkflowUpdateRequest,
        default_body_max_size,
    },
    manager::ProxyCrabManager,
    mcp,
    permission::{
        ManagementCredential, PermissionAction, PermissionDenied, PermissionDeniedStatus,
        PermissionManager, api_actions, find_api_action,
    },
    session_share::{EnableSessionShareRequest, SessionShareService},
};

type ManagerState = Arc<dyn ProxyCrabManager>;
type ChangeSender = broadcast::Sender<HttpApiChange>;
type ApiResult = Result<Json<Value>, ApiError>;

#[cfg(test)]
#[derive(Clone, Copy)]
struct InProcessLocalRequest;

struct ReadManager(ManagerState);
impl FromRequestParts<ManagerState> for ReadManager {
    type Rejection = ApiError;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &ManagerState,
    ) -> Result<Self, Self::Rejection> {
        let name = parts
            .extensions
            .get::<crate::dto::RedactionBinding>()
            .and_then(|b| b.redaction_script.as_deref());
        let api = parts
            .extensions
            .get::<MatchedPath>()
            .map(|p| p.as_str())
            .unwrap_or(parts.uri.path());
        Ok(Self(state.reader(name, api)?))
    }
}
/* ---- Workflow run domain (plan Task 19) ---- */

async fn trigger_workflow_run(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<FlowRunTriggerRequest>,
) -> ApiResult {
    success(manager.trigger_workflow_run(request).await?)
}

async fn workflow_runs(
    State(manager): State<ManagerState>,
    ApiQuery(query): ApiQuery<FlowRunListQuery>,
) -> ApiResult {
    success(manager.workflow_runs(query).await?)
}

async fn workflow_run_detail(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<String>,
) -> ApiResult {
    success(manager.workflow_run_detail(id).await?)
}

async fn cancel_workflow_run(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<String>,
) -> ApiResult {
    manager.cancel_workflow_run(id).await?;
    success(json!({}))
}

struct ApiJson<T>(T);
struct ApiPath<T>(T);
struct ApiQuery<T>(T);

impl<T, S> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|error| ApiError(ManagerError::bad_request(error.body_text())))
    }
}

impl<T, S> FromRequestParts<S> for ApiPath<T>
where
    T: DeserializeOwned + Send,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Path::<T>::from_request_parts(parts, state)
            .await
            .map(|Path(value)| Self(value))
            .map_err(|error| ApiError(ManagerError::bad_request(error.body_text())))
    }
}

impl<T, S> FromRequestParts<S> for ApiQuery<T>
where
    T: DeserializeOwned + Send,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Query::<T>::from_request_parts(parts, state)
            .await
            .map(|Query(value)| Self(value))
            .map_err(|error| ApiError(ManagerError::bad_request(error.body_text())))
    }
}

pub struct HttpServerHandle {
    pub host: String,
    pub port: u16,
    cancellation: CancellationToken,
    task: JoinHandle<()>,
    changes: ChangeSender,
}

impl HttpServerHandle {
    pub fn is_running(&self) -> bool {
        !self.task.is_finished()
    }

    pub async fn shutdown(self) {
        self.cancellation.cancel();
        let _ = self.task.await;
    }

    pub fn subscribe_changes(&self) -> broadcast::Receiver<HttpApiChange> {
        self.changes.subscribe()
    }
}

pub async fn start_http_server(
    manager: ManagerState,
    permissions: Arc<dyn PermissionManager>,
) -> Result<HttpServerHandle, ManagerError> {
    start_http_server_with_routes(manager, permissions, SessionShareService::new(), |_| {
        Router::new()
    })
    .await
}

pub async fn start_http_server_with_routes<F>(
    manager: ManagerState,
    permissions: Arc<dyn PermissionManager>,
    shares: Arc<SessionShareService>,
    extra_routes: F,
) -> Result<HttpServerHandle, ManagerError>
where
    F: FnOnce(broadcast::Sender<HttpApiChange>) -> Router,
{
    let config = manager.config().await?;
    let address = std::net::SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, config.api_port));
    let listener = tokio::net::TcpListener::bind(&address)
        .await
        .map_err(|error| ManagerError::internal(format!("failed to bind {address}: {error}")))?;
    let cancellation = CancellationToken::new();
    let server_shutdown = cancellation.clone();
    let task_shutdown = cancellation.clone();
    let (changes, _) = broadcast::channel(128);
    let change_task = spawn_proxy_status_change_bridge(
        manager.subscribe_proxy_status_changes(),
        changes.clone(),
        cancellation.clone(),
    );
    let run_change_task = spawn_flow_run_change_bridge(
        manager.subscribe_flow_run_events(),
        changes.clone(),
        cancellation.clone(),
    );
    let extra = extra_routes(changes.clone());
    let app =
        secured_router_with_changes_and_extra(manager, permissions, shares, changes.clone(), extra);
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move { server_shutdown.cancelled().await })
        .await
        {
            tracing::error!("management HTTP server failed: {error}");
        }
        task_shutdown.cancel();
        let _ = change_task.await;
        let _ = run_change_task.await;
    });
    Ok(HttpServerHandle {
        host: std::net::Ipv4Addr::UNSPECIFIED.to_string(),
        port: config.api_port,
        cancellation,
        task,
        changes,
    })
}

fn spawn_proxy_status_change_bridge(
    mut status_changes: tokio::sync::watch::Receiver<u64>,
    changes: ChangeSender,
    cancellation: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                result = status_changes.changed() => {
                    if result.is_err() {
                        break;
                    }
                    let _ = changes.send(HttpApiChange {
                        resources: vec![HttpApiResource::Proxy],
                        session_id: None,
                    });
                }
                _ = cancellation.cancelled() => break,
            }
        }
    })
}

fn spawn_flow_run_change_bridge(
    mut run_events: broadcast::Receiver<FlowRunEvent>,
    changes: ChangeSender,
    cancellation: CancellationToken,
) -> JoinHandle<()> {
    // Step 2 进度事件桥：把运行编排的节点级 / 运行级事件折算成 `FlowRuns`
    // 资源变更广播（前端收到后拉取运行列表 / 详情刷新，运行级与节点级
    // 统一收敛为一个资源域，避免高频节点事件逐条建模）。
    tokio::spawn(async move {
        loop {
            tokio::select! {
                result = run_events.recv() => {
                    match result {
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {
                            let _ = changes.send(HttpApiChange {
                                resources: vec![HttpApiResource::FlowRuns],
                                session_id: None,
                            });
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                _ = cancellation.cancelled() => break,
            }
        }
    })
}

#[cfg(test)]
pub(crate) fn router(manager: ManagerState, permissions: Arc<dyn PermissionManager>) -> Router {
    let (changes, _) = broadcast::channel(128);
    router_with_changes(manager, permissions, changes)
}

#[cfg(test)]
fn router_with_changes(
    manager: ManagerState,
    permissions: Arc<dyn PermissionManager>,
    changes: ChangeSender,
) -> Router {
    router_with_changes_and_extra(
        manager,
        permissions,
        SessionShareService::new(),
        changes,
        Router::new(),
    )
    .layer(Extension(InProcessLocalRequest))
}

fn router_with_changes_and_extra(
    manager: ManagerState,
    permissions: Arc<dyn PermissionManager>,
    shares: Arc<SessionShareService>,
    changes: ChangeSender,
    extra: Router,
) -> Router {
    shares.set_permissions(permissions.clone());
    let downloads = Router::new()
        .route("/ca.crt", get(download_certificate))
        .with_state(manager.clone())
        .merge(crate::clash_subscription::router(manager.clone()));
    Router::new()
        .route(
            "/api/redaction-scripts",
            get(redaction_scripts).post(create_redaction_script),
        )
        .route(
            "/api/redaction-scripts/{name}",
            get(redaction_script)
                .put(update_redaction_script)
                .delete(delete_redaction_script),
        )
        .route("/api/agents.md", get(agents_markdown))
        .route("/api/assets", get(assets))
        .route("/api/assets/{*asset_id}", get(asset).post(upload_asset))
        .route("/api/replay", post(replay))
        .route("/api/config", get(get_config))
        .route("/api/proxy/status", get(proxy_status))
        .route("/api/proxy/start", post(start_proxy))
        .route("/api/proxy/stop", post(stop_proxy))
        .route("/api/sessions", get(sessions).post(create_session))
        .route("/api/archived-sessions", get(archived_sessions))
        .route("/api/sessions/{id}/archive", post(archive_session))
        .route("/api/sessions/{id}/filter", put(replace_session_filter))
        .route("/api/archived-sessions/{id}/restore", post(restore_session))
        .route(
            "/api/archived-sessions/{id}",
            axum::routing::delete(delete_archived_session),
        )
        .route("/api/active-session", put(replace_active_session))
        .route(
            "/api/imports",
            post(import_bundle).layer(axum::extract::DefaultBodyLimit::max(129 * 1024 * 1024)),
        )
        .route("/api/imports/{id}/resolve", post(resolve_bundle))
        .route("/api/sessions/{id}", put(update_session))
        .route(
            "/api/session-shares",
            get(list_session_shares).post(enable_session_share),
        )
        .route(
            "/api/session-shares/{id}",
            get(get_session_share).delete(disable_session_share),
        )
        .route("/api/logs/ids", post(log_ids))
        .route("/api/logs/views", post(log_views))
        .route("/api/logs/{id}/body", get(log_body))
        .route("/api/logs/{id}/websocket/messages", get(websocket_messages))
        .route(
            "/api/logs/{id}/websocket/messages/{message_id}/body",
            get(websocket_message_body),
        )
        .route(
            "/api/logs/{id}/interceptors/{execution_id}/content",
            get(log_interceptor_content),
        )
        .route(
            "/api/logs/{id}/interceptors/{execution_id}/snapshot",
            get(log_interceptor_snapshot),
        )
        .route("/api/logs/{id}", get(log))
        .route("/api/breakpoints", get(breakpoints))
        .route("/api/breakpoints/{id}/body", get(breakpoint_body))
        .route("/api/breakpoints/{id}", get(breakpoint))
        .route("/api/breakpoints/{id}/extend", post(extend_breakpoint))
        .route("/api/breakpoints/{id}/release", post(release_breakpoint))
        .route(
            "/api/breakpoints/{id}/execute",
            post(execute_breakpoint_script),
        )
        .route(
            "/api/session-view",
            get(session_view).put(replace_session_view),
        )
        .route(
            "/api/session-interceptors",
            get(session_interceptors).put(replace_session_interceptors),
        )
        .route(
            "/api/column-scripts",
            get(column_scripts).post(create_column_script),
        )
        .route(
            "/api/column-scripts/{name}",
            get(column_script)
                .put(update_column_script)
                .delete(delete_column_script),
        )
        .route(
            "/api/filter-scripts",
            get(filter_scripts).post(create_filter_script),
        )
        .route(
            "/api/filter-scripts/{name}/debug",
            post(debug_filter_script),
        )
        .route(
            "/api/filter-scripts/{name}",
            get(filter_script)
                .put(update_filter_script)
                .delete(delete_filter_script),
        )
        .route(
            "/api/routing-scripts",
            get(routing_scripts).post(create_routing_script),
        )
        .route(
            "/api/routing-scripts/{name}",
            get(routing_script)
                .put(update_routing_script)
                .delete(delete_routing_script),
        )
        .route(
            "/api/routing-script-selection",
            get(routing_selection).put(replace_routing_selection),
        )
        .route(
            "/api/interceptors",
            get(interceptors).post(create_interceptor),
        )
        .route(
            "/api/interceptors/{kind}/{name}",
            get(interceptor)
                .put(update_interceptor)
                .delete(delete_interceptor),
        )
        .route(
            "/api/clash-subscription",
            get(clash_subscription)
                .put(enable_clash_subscription)
                .delete(disable_clash_subscription),
        )
        .route(
            "/api/clash-config",
            get(clash_config)
                .put(save_clash_config)
                .delete(reset_clash_config),
        )
        .route("/api/env-sets", get(env_sets).post(create_env_set))
        .route("/api/env-sets/active", put(replace_active_env_set))
        .route(
            "/api/env-sets/{id}",
            axum::routing::put(save_env_set).delete(delete_env_set),
        )
        .route("/api/env-globals", put(replace_env_globals))
        .route("/api/env-write-back", post(env_write_back))
        /* MCP exposure tiers (plan Task 25 Step 2): read (allow) and write
        (approval, like other posture-changing settings). */
        .route("/api/mcp-tiers", get(get_mcp_tiers).put(replace_mcp_tiers))
        .route(
            "/api/system-logs",
            get(system_logs).delete(clear_system_logs),
        )
        .route(
            "/api/flow-projects",
            get(flow_projects).post(create_flow_project),
        )
        .route(
            "/api/flow-projects/{id}",
            get(flow_project)
                .put(update_flow_project)
                .delete(delete_flow_project),
        )
        .route("/api/workflows", get(workflows).post(create_workflow))
        .route(
            "/api/workflows/{id}",
            get(workflow).put(update_workflow).delete(delete_workflow),
        )
        .route("/api/workflows/{id}/validate", post(validate_workflow))
        .route("/api/flow/script/dry-run", post(flow_script_dry_run))
        /* ---- Workflow run domain (plan Task 19): standalone section ---- */
        .route(
            "/api/flow/runs",
            get(workflow_runs).post(trigger_workflow_run),
        )
        .route("/api/flow/runs/{id}", get(workflow_run_detail))
        .route(
            "/api/flow/runs/{id}/cancel",
            post(cancel_workflow_run),
        )
        .route("/api/workflows/export", get(export_workflows))
        .route("/api/workflows/import", post(import_workflows))
        .route(
            "/api/request-library",
            get(request_library_list).post(request_library_create),
        )
        .route(
            "/api/request-library/from-capture",
            post(request_library_from_capture),
        )
        .route(
            "/api/request-library/{id}",
            get(request_library_get)
                .put(request_library_update)
                .delete(request_library_delete),
        )
        .route("/api/request-library/{id}/body", get(request_library_body))
        .route(
            "/api/bypass",
            get(bypass_entries).delete(clear_bypass_entries),
        )
        .route("/api/bypass/delete", post(delete_bypass_entries))
        .route(
            "/api/bypass/{id}",
            axum::routing::delete(delete_bypass_entry),
        )
        /* MCP endpoint (plan Task 24): stateless JSON-RPC 2.0 over POST /mcp.
        Registered before the authorize_request layer so every request is
        independently authenticated through the "POST /mcp" catalog action,
        with the same identity semantics as the /api routes. */
        .route("/mcp", post(mcp_endpoint))
        .route_layer(middleware::from_fn_with_state(
            permissions.clone(),
            authorize_request,
        ))
        .with_state(manager)
        .layer(Extension(shares))
        .layer(Extension(permissions))
        .layer(Extension(changes.clone()))
        .layer(middleware::from_fn_with_state(
            changes,
            publish_successful_http_changes,
        ))
        .merge(extra)
        .merge(downloads)
        .fallback(not_found)
}

#[cfg(test)]
fn secured_router(manager: ManagerState, permissions: Arc<dyn PermissionManager>) -> Router {
    let (changes, _) = broadcast::channel(128);
    secured_router_with_changes(manager, permissions, changes)
}

#[cfg(test)]
fn secured_router_with_changes(
    manager: ManagerState,
    permissions: Arc<dyn PermissionManager>,
    changes: ChangeSender,
) -> Router {
    secured_router_with_changes_and_extra(
        manager,
        permissions,
        SessionShareService::new(),
        changes,
        Router::new(),
    )
}

fn secured_router_with_changes_and_extra(
    manager: ManagerState,
    permissions: Arc<dyn PermissionManager>,
    shares: Arc<SessionShareService>,
    changes: ChangeSender,
    extra: Router,
) -> Router {
    router_with_changes_and_extra(manager, permissions, shares, changes, extra)
        .layer(middleware::from_fn(auth::prepare_management_request))
}

const BODY_PREVIEW_LIMIT: usize = 16 * 1024;

/// 脚本试跑端点的权限目录 action id：该请求体整体跳过审计/审批预览
/// （请求体内嵌脚本内容，不写入任何日志或审批展示）。
const FLOW_SCRIPT_DRY_RUN_ACTION_ID: &str = "POST /api/flow/script/dry-run";

async fn authorize_request(
    State(permissions): State<Arc<dyn PermissionManager>>,
    request: Request,
    next: Next,
) -> Response {
    let route_template = request
        .extensions()
        .get::<MatchedPath>()
        .map(|path| path.as_str().to_owned());
    let Some(route_template) = route_template else {
        return next.run(request).await;
    };
    let Some(action) = find_api_action(request.method().as_str(), &route_template) else {
        let known_template = api_actions()
            .iter()
            .any(|action| action.route_template == route_template);
        if known_template || !route_template.starts_with("/api/") {
            return next.run(request).await;
        }
        return permission_denied_response(PermissionDenied::internal(
            "permission_check_failed",
            "management API route is missing from the permission catalog",
        ));
    };

    let credential = match request.extensions().get::<ManagementCredential>().cloned() {
        Some(credential) => Ok(credential),
        None => match auth::resolve_management_credential(&request) {
            Err(error)
                if error.code == "remote_auth_required"
                    && accepts_in_process_local_request(&request) =>
            {
                Ok(ManagementCredential::LocalLoopback)
            }
            result => result,
        },
    };
    let credential = match credential {
        Ok(credential) => credential,
        Err(error) => return permission_denied_response(error),
    };
    let source = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|value| value.0);
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let content_length = request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok());
    let actual_path = request.uri().path().to_owned();
    let query = request.uri().query().map(str::to_owned);
    // The script dry-run request body embeds the whole script source; it is
    // kept out of the audit/approval preview entirely (plan Task 18 Step 4).
    let (request, body_preview, body_preview_truncated) =
        if action.id == FLOW_SCRIPT_DRY_RUN_ACTION_ID {
            (request, None, false)
        } else {
            preview_request_body(request, content_type.as_deref()).await
        };

    let permission = PermissionAction {
        action,
        credential: credential.clone(),
        actual_path,
        query,
        source,
        content_type,
        content_length,
        body_preview,
        body_preview_truncated: body_preview_truncated
            || content_length.is_some_and(|length| length > BODY_PREVIEW_LIMIT as u64),
    };
    if let Some(denied) = permissions.check_permission(permission).await {
        return permission_denied_response(denied);
    }
    let binding = match permissions.redaction_script(&credential).await {
        Ok(redaction_script) => crate::dto::RedactionBinding { redaction_script },
        Err(error) => return permission_denied_response(error),
    };
    let mut request = request;
    request.extensions_mut().insert(binding);
    request.extensions_mut().insert(credential);
    next.run(request).await
}

fn accepts_in_process_local_request(request: &Request) -> bool {
    #[cfg(test)]
    {
        request
            .extensions()
            .get::<InProcessLocalRequest>()
            .is_some()
    }
    #[cfg(not(test))]
    {
        let _ = request;
        false
    }
}

async fn preview_request_body(
    request: Request,
    content_type: Option<&str>,
) -> (Request, Option<String>, bool) {
    let textual = content_type.is_some_and(|value| {
        value.starts_with("text/")
            || value.contains("json")
            || value.contains("xml")
            || value.contains("x-www-form-urlencoded")
    });
    if !textual {
        return (request, None, false);
    }
    let (parts, body) = request.into_parts();
    let mut stream = body.into_data_stream();
    let mut buffered = Vec::new();
    let mut preview = Vec::new();
    let mut truncated = false;
    while !truncated {
        let Some(item) = stream.next().await else {
            break;
        };
        match item {
            Ok(bytes) => {
                let remaining = BODY_PREVIEW_LIMIT - preview.len();
                let has_bytes = !bytes.is_empty();
                preview.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
                truncated |= bytes.len() > remaining;
                buffered.push(Ok::<Bytes, axum::Error>(bytes));
                if remaining == 0 && has_bytes {
                    truncated = true;
                }
            }
            Err(error) => {
                buffered.push(Err(error));
                break;
            }
        }
    }
    let body = Body::from_stream(stream::iter(buffered).chain(stream));
    let preview = String::from_utf8(preview).ok();
    (Request::from_parts(parts, body), preview, truncated)
}

fn permission_denied_response(denied: PermissionDenied) -> Response {
    let status = match denied.status {
        PermissionDeniedStatus::Unauthorized => StatusCode::UNAUTHORIZED,
        PermissionDeniedStatus::Forbidden => StatusCode::FORBIDDEN,
        PermissionDeniedStatus::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (
        status,
        Json(json!({
            "ok": false,
            "error": { "code": denied.code, "message": denied.message }
        })),
    )
        .into_response()
}

async fn publish_successful_http_changes(
    State(changes): State<ChangeSender>,
    request: Request,
    next: Next,
) -> Response {
    let change = change_for_request(
        request.method(),
        request.uri().path(),
        request.uri().query(),
    );
    let response = next.run(request).await;
    if response.status().is_success()
        && let Some(change) = change
    {
        let _ = changes.send(change);
    }
    response
}

fn change_for_request(method: &Method, path: &str, query: Option<&str>) -> Option<HttpApiChange> {
    let resources = match (method, path) {
        (&Method::POST, value) if value == "/api/imports" || value.starts_with("/api/imports/") => {
            vec![HttpApiResource::All]
        }
        (&Method::POST | &Method::PUT | &Method::DELETE, value)
            if value.starts_with("/api/redaction-scripts") || value.ends_with("/redaction") =>
        {
            vec![HttpApiResource::All]
        }
        (&Method::POST, "/api/sessions") => {
            vec![HttpApiResource::Sessions, HttpApiResource::ActiveSession]
        }
        (&Method::POST, value) if value.ends_with("/archive") => {
            vec![HttpApiResource::Sessions, HttpApiResource::ArchivedSessions]
        }
        (&Method::POST, value) if value.ends_with("/restore") => {
            vec![HttpApiResource::Sessions, HttpApiResource::ArchivedSessions]
        }
        (&Method::DELETE, value) if value.starts_with("/api/archived-sessions/") => {
            vec![HttpApiResource::ArchivedSessions]
        }
        (&Method::PUT, value)
            if value.starts_with("/api/sessions/") && value.ends_with("/filter") =>
        {
            vec![HttpApiResource::SessionView]
        }
        (&Method::PUT, value) if value.starts_with("/api/sessions/") => {
            vec![HttpApiResource::Sessions]
        }
        (&Method::PUT, "/api/active-session") => {
            vec![HttpApiResource::ActiveSession, HttpApiResource::Config]
        }
        (&Method::PUT | &Method::DELETE, "/api/clash-subscription") => {
            vec![HttpApiResource::ClashSubscription]
        }
        (&Method::PUT | &Method::DELETE, "/api/clash-config") => {
            vec![HttpApiResource::ClashConfig]
        }
        (&Method::POST | &Method::PUT | &Method::DELETE, value)
            if value == "/api/env-sets"
                || value == "/api/env-sets/active"
                || value.starts_with("/api/env-sets/")
                || value == "/api/env-globals"
                || value == "/api/env-write-back" =>
        {
            vec![HttpApiResource::EnvSets]
        }
        (&Method::POST, "/api/session-shares") => vec![HttpApiResource::SessionShare],
        (&Method::DELETE, value) if value.starts_with("/api/session-shares/") => {
            vec![HttpApiResource::SessionShare]
        }
        (&Method::PUT, "/api/session-view") => vec![HttpApiResource::SessionView],
        (&Method::POST, "/api/column-scripts") => {
            vec![HttpApiResource::ColumnScripts, HttpApiResource::SessionView]
        }
        (&Method::PUT | &Method::DELETE, value) if value.starts_with("/api/column-scripts/") => {
            vec![HttpApiResource::ColumnScripts, HttpApiResource::SessionView]
        }
        (&Method::POST, "/api/filter-scripts") => {
            vec![HttpApiResource::FilterScripts, HttpApiResource::SessionView]
        }
        (&Method::PUT | &Method::DELETE, value) if value.starts_with("/api/filter-scripts/") => {
            vec![HttpApiResource::FilterScripts, HttpApiResource::SessionView]
        }
        (&Method::POST, "/api/routing-scripts") => vec![HttpApiResource::RoutingScripts],
        (&Method::PUT | &Method::DELETE, value) if value.starts_with("/api/routing-scripts/") => {
            vec![
                HttpApiResource::RoutingScripts,
                HttpApiResource::RoutingSelection,
            ]
        }
        (&Method::PUT, "/api/routing-script-selection") => {
            vec![HttpApiResource::RoutingSelection]
        }
        (&Method::POST, "/api/interceptors") => vec![
            HttpApiResource::Interceptors,
            HttpApiResource::SessionInterceptors,
        ],
        (&Method::PUT | &Method::DELETE, value) if value.starts_with("/api/interceptors/") => {
            vec![
                HttpApiResource::Interceptors,
                HttpApiResource::SessionInterceptors,
            ]
        }
        (&Method::PUT, "/api/session-interceptors") => {
            vec![HttpApiResource::SessionInterceptors]
        }
        (&Method::DELETE, "/api/system-logs") => vec![HttpApiResource::SystemLogs],
        (&Method::POST, "/api/request-library")
        | (&Method::POST, "/api/request-library/from-capture") => {
            vec![HttpApiResource::RequestLibrary]
        }
        (&Method::PUT | &Method::DELETE, value) if value.starts_with("/api/request-library/") => {
            vec![HttpApiResource::RequestLibrary]
        }
        (&Method::DELETE, "/api/bypass") | (&Method::POST, "/api/bypass/delete") => {
            vec![HttpApiResource::Bypass]
        }
        (&Method::DELETE, value) if value.starts_with("/api/bypass/") => {
            vec![HttpApiResource::Bypass]
        }
        // Workflow runs (plan Task 19): triggering creates a run row and
        // cancelling requests a terminal transition; the progress event bridge
        // additionally broadcasts on every FlowRunEvent.
        (&Method::POST, "/api/flow/runs") => vec![HttpApiResource::FlowRuns],
        (&Method::POST, value)
            if value.starts_with("/api/flow/runs/") && value.ends_with("/cancel") =>
            vec![HttpApiResource::FlowRuns],
        _ => return None,
    };
    Some(HttpApiChange {
        resources,
        session_id: session_id_from_query(query)
            .or_else(|| session_filter_id_from_path(path))
            .or_else(|| session_share_id_from_path(path)),
    })
}

fn session_filter_id_from_path(path: &str) -> Option<u64> {
    path.strip_prefix("/api/sessions/")?
        .strip_suffix("/filter")?
        .parse()
        .ok()
}

fn session_share_id_from_path(path: &str) -> Option<u64> {
    path.strip_prefix("/api/session-shares/")?.parse().ok()
}

fn session_id_from_query(query: Option<&str>) -> Option<u64> {
    query?
        .split('&')
        .filter_map(|part| part.split_once('='))
        .find_map(|(key, value)| {
            (key == "session_id" || key == "session")
                .then(|| value.parse().ok())
                .flatten()
        })
}

#[derive(Debug, Deserialize)]
struct ReplayQuery {
    session: u64,
}

async fn assets(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.assets().await?)
}

async fn replay(
    State(manager): State<ManagerState>,
    ApiQuery(query): ApiQuery<ReplayQuery>,
    Json(request): Json<ReplayRequestPayload>,
) -> ApiResult {
    success(manager.replay(query.session, request).await?)
}

async fn get_config(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.config().await?)
}

async fn agents_markdown(State(manager): State<ManagerState>) -> Result<Response, ApiError> {
    let markdown = manager.agents_markdown().await?;
    Ok(([(CONTENT_TYPE, "text/plain; charset=utf-8")], markdown).into_response())
}

async fn proxy_status(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.proxy_status().await?)
}

async fn start_proxy(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.start_proxy().await?)
}

async fn stop_proxy(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.stop_proxy().await?)
}

async fn sessions(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.sessions().await?)
}

async fn archived_sessions(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.archived_sessions().await?)
}

async fn import_bundle(
    State(manager): State<ManagerState>,
    mut multipart: axum::extract::Multipart,
) -> ApiResult {
    let mut bytes = None;
    let mut accepted = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ManagerError::bad_request(e.to_string()))?
    {
        match field.name() {
            Some("file") if bytes.is_none() => {
                bytes = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| ManagerError::bad_request(e.to_string()))?
                        .to_vec(),
                )
            }
            Some("accepted_intent_ids") if accepted.is_none() => {
                accepted = Some(
                    serde_json::from_str::<Vec<String>>(
                        &field
                            .text()
                            .await
                            .map_err(|e| ManagerError::bad_request(e.to_string()))?,
                    )
                    .map_err(|e| ManagerError::bad_request(e.to_string()))?,
                )
            }
            _ => {
                return Err(
                    ManagerError::bad_request("unexpected or duplicate import field").into(),
                );
            }
        }
    }
    success(
        manager
            .import_bundle(
                bytes.ok_or_else(|| ManagerError::bad_request("missing file"))?,
                accepted.ok_or_else(|| ManagerError::bad_request("missing accepted_intent_ids"))?,
            )
            .await?,
    )
}
async fn resolve_bundle(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<String>,
    ApiJson(resolutions): ApiJson<Vec<crate::bundle::Resolution>>,
) -> ApiResult {
    success(manager.resolve_bundle(id, resolutions).await?)
}

async fn replace_active_session(
    State(manager): State<ManagerState>,
    ApiJson(active): ApiJson<ActiveSession>,
) -> ApiResult {
    success(manager.replace_active_session(active).await?)
}

async fn create_session(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<CreateSessionRequest>,
) -> ApiResult {
    success(manager.create_session(request).await?)
}

async fn update_session(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<u64>,
    ApiJson(request): ApiJson<UpdateSessionRequest>,
) -> ApiResult {
    success(manager.update_session(id, request).await?)
}

async fn enable_session_share(
    State(manager): State<ManagerState>,
    Extension(shares): Extension<Arc<SessionShareService>>,
    Extension(permissions): Extension<Arc<dyn PermissionManager>>,
    Extension(credential): Extension<ManagementCredential>,
    ApiJson(request): ApiJson<EnableSessionShareRequest>,
) -> ApiResult {
    let identity = permissions
        .share_identity(&credential)
        .await
        .map_err(|error| {
            ApiError(ManagerError::new(
                ErrorCode::ShareRedactionForbidden,
                error.message,
            ))
        })?;
    success(
        shares
            .enable_for_identity(
                &manager,
                request.session_id,
                request.session_share_config,
                identity,
            )
            .await?,
    )
}

async fn list_session_shares(
    State(manager): State<ManagerState>,
    Extension(shares): Extension<Arc<SessionShareService>>,
) -> ApiResult {
    success(shares.list(&manager).await?)
}

async fn get_session_share(
    State(manager): State<ManagerState>,
    Extension(shares): Extension<Arc<SessionShareService>>,
    ApiPath(id): ApiPath<u64>,
) -> ApiResult {
    success(shares.status(&manager, id).await?)
}

async fn disable_session_share(
    State(manager): State<ManagerState>,
    Extension(shares): Extension<Arc<SessionShareService>>,
    ApiPath(id): ApiPath<u64>,
) -> ApiResult {
    success(shares.disable(&manager, id).await?)
}

async fn archive_session(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<u64>,
) -> ApiResult {
    success(manager.archive_session(id).await?)
}

async fn restore_session(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<u64>,
) -> ApiResult {
    success(manager.restore_session(id).await?)
}

async fn delete_archived_session(
    State(manager): State<ManagerState>,
    Extension(shares): Extension<Arc<SessionShareService>>,
    ApiPath(id): ApiPath<u64>,
) -> ApiResult {
    shares.delete_archived_session(&manager, id).await?;
    success(json!({}))
}

async fn log_ids(
    ReadManager(manager): ReadManager,
    ApiJson(request): ApiJson<LogIdsRequest>,
) -> ApiResult {
    success(manager.log_ids(request).await?)
}

async fn log_views(
    ReadManager(manager): ReadManager,
    ApiJson(request): ApiJson<LogViewsRequest>,
) -> ApiResult {
    success(manager.log_views(request).await?)
}

async fn upload_asset(
    State(manager): State<ManagerState>,
    ApiPath(asset_id): ApiPath<String>,
    request: Request,
) -> Result<Response, ApiError> {
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .trim()
        .to_owned();
    let mut upload = manager.begin_asset_upload(asset_id, content_type).await?;
    let mut body = request.into_body().into_data_stream();
    while let Some(bytes) = body.next().await {
        let bytes = bytes.map_err(|error| {
            ApiError(ManagerError::new(
                ErrorCode::AssetStoreFailed,
                format!("failed to read asset upload: {error}"),
            ))
        })?;
        upload.write(&bytes).await.map_err(|error| {
            ApiError(ManagerError::new(
                ErrorCode::AssetStoreFailed,
                error.to_string(),
            ))
        })?;
    }
    let metadata = upload.finish().await.map_err(|error| {
        let error = match error {
            proxy_crab_mitm::asset::AssetError::AlreadyExists(id) => ManagerError::new(
                ErrorCode::AssetAlreadyExists,
                format!("asset {id} already exists"),
            ),
            proxy_crab_mitm::asset::AssetError::PathConflict(id) => ManagerError::new(
                ErrorCode::AssetPathConflict,
                format!("asset path conflicts with an existing file or directory: {id}"),
            ),
            other => ManagerError::new(ErrorCode::AssetStoreFailed, other.to_string()),
        };
        ApiError(error)
    })?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "ok": true, "data": metadata })),
    )
        .into_response())
}

async fn asset(
    State(manager): State<ManagerState>,
    ApiPath(asset_id): ApiPath<String>,
    ApiQuery(query): ApiQuery<AssetQuery>,
) -> Result<Response, ApiError> {
    let asset = manager.asset(asset_id).await?;
    match query.format.as_deref() {
        None => Ok(Json(json!({ "ok": true, "data": asset.metadata })).into_response()),
        Some("raw") => {
            let filename = asset
                .metadata
                .id
                .rsplit('/')
                .next()
                .expect("validated asset id has a filename");
            let file = tokio::fs::File::open(asset.path()).await.map_err(|error| {
                ApiError(ManagerError::new(
                    ErrorCode::AssetStoreFailed,
                    format!("failed to open asset: {error}"),
                ))
            })?;
            let stream = ReaderStream::new(file);
            let mut response = Response::new(Body::from_stream(stream));
            let headers = response.headers_mut();
            headers.insert(
                CONTENT_TYPE,
                HeaderValue::from_str(&asset.metadata.content_type).map_err(|error| {
                    ApiError(ManagerError::new(
                        ErrorCode::AssetStoreFailed,
                        error.to_string(),
                    ))
                })?,
            );
            headers.insert(
                CONTENT_LENGTH,
                HeaderValue::from_str(&asset.metadata.size.to_string())
                    .expect("u64 is always a valid Content-Length"),
            );
            headers.insert(
                CONTENT_DISPOSITION,
                HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
                    .expect("validated asset filenames are safe header values"),
            );
            headers.insert(
                "x-proxycrab-asset-sha256",
                HeaderValue::from_str(&asset.metadata.sha256)
                    .expect("SHA-256 hex is a safe header value"),
            );
            Ok(response)
        }
        Some(_) => Err(ApiError(ManagerError::new(
            ErrorCode::InvalidAssetFormat,
            "asset format must be raw when present",
        ))),
    }
}

async fn log(
    ReadManager(manager): ReadManager,
    ApiPath(id): ApiPath<u64>,
    ApiQuery(query): ApiQuery<SessionQuery>,
) -> ApiResult {
    success(manager.log(query.session_id, id).await?)
}

async fn websocket_messages(
    ReadManager(manager): ReadManager,
    ApiPath(id): ApiPath<u64>,
    ApiQuery(query): ApiQuery<WebSocketQuery>,
) -> ApiResult {
    success(
        manager
            .websocket_messages(
                query.session_id,
                id,
                query.body_side()?,
                query.after_id,
                query.limit.unwrap_or(500),
            )
            .await?,
    )
}
async fn websocket_message_body(
    ReadManager(manager): ReadManager,
    ApiPath((id, message_id)): ApiPath<(u64, u32)>,
    ApiQuery(query): ApiQuery<WebSocketQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let source = manager
        .websocket_message_body(
            query.session_id,
            id,
            query.body_side()?,
            message_id,
            query.max_size.unwrap_or_else(default_body_max_size),
        )
        .await?;
    let mut response = body_response(source, &headers, query.max_size)
        .await
        .map_err(ApiError)?;
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn log_body(
    ReadManager(manager): ReadManager,
    ApiPath(id): ApiPath<u64>,
    ApiQuery(query): ApiQuery<BodyQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let side = parse_body_side(&query.side)?;
    validate_body_query(&query)?;
    let source = match query.execution_id {
        Some(execution_id) => {
            manager
                .interceptor_snapshot_body_source(query.session_id, id, execution_id, side)
                .await?
        }
        None => manager.log_body_source(query.session_id, id, side).await?,
    };
    body_response(source, &headers, query.max_size)
        .await
        .map_err(ApiError)
}

async fn log_interceptor_content(
    State(manager): State<ManagerState>,
    ApiPath((id, execution_id)): ApiPath<(u64, u64)>,
    ApiQuery(query): ApiQuery<SessionQuery>,
) -> Result<Response, ApiError> {
    let InterceptorScriptContent { hash, content } = manager
        .interceptor_script_content(query.session_id, id, execution_id)
        .await?;
    let length = content.len();
    let mut response = Response::new(Body::from(content));
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string()).expect("usize is always a valid Content-Length"),
    );
    headers.insert(
        "x-proxycrab-script-sha256",
        HeaderValue::from_str(&hash).expect("SHA-256 hex is a safe header value"),
    );
    Ok(response)
}

async fn log_interceptor_snapshot(
    ReadManager(manager): ReadManager,
    ApiPath((id, execution_id)): ApiPath<(u64, u64)>,
    ApiQuery(query): ApiQuery<SessionQuery>,
) -> ApiResult {
    success(
        manager
            .interceptor_snapshot(query.session_id, id, execution_id)
            .await?,
    )
}

async fn breakpoints(
    ReadManager(manager): ReadManager,
    ApiQuery(query): ApiQuery<BreakpointQuery>,
) -> ApiResult {
    success(manager.breakpoints(query).await?)
}

async fn breakpoint(ReadManager(manager): ReadManager, ApiPath(id): ApiPath<u64>) -> ApiResult {
    success(manager.breakpoint(id).await?)
}

async fn breakpoint_body(
    ReadManager(manager): ReadManager,
    ApiPath(id): ApiPath<u64>,
    ApiQuery(query): ApiQuery<BodyQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let side = parse_body_side(&query.side)?;
    validate_body_query(&query)?;
    let source = manager.breakpoint_body_source(id, side).await?;
    body_response(source, &headers, query.max_size)
        .await
        .map_err(ApiError)
}

async fn extend_breakpoint(
    ReadManager(manager): ReadManager,
    ApiPath(id): ApiPath<u64>,
    ApiJson(request): ApiJson<ExtendBreakpointRequest>,
) -> ApiResult {
    success(manager.extend_breakpoint(id, request).await?)
}

async fn release_breakpoint(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<u64>,
) -> ApiResult {
    manager.release_breakpoint(id).await?;
    success(json!({}))
}

async fn execute_breakpoint_script(
    ReadManager(manager): ReadManager,
    ApiPath(id): ApiPath<u64>,
    ApiJson(request): ApiJson<ExecuteTemporaryScriptRequest>,
) -> ApiResult {
    success(manager.execute_breakpoint_script(id, request).await?)
}

async fn session_view(
    ReadManager(manager): ReadManager,
    ApiQuery(query): ApiQuery<SessionQuery>,
) -> ApiResult {
    success(manager.session_view(query.session_id).await?)
}

async fn replace_session_view(
    State(manager): State<ManagerState>,
    ApiQuery(query): ApiQuery<SessionQuery>,
    ApiJson(request): ApiJson<ReplaceSessionViewRequest>,
) -> ApiResult {
    success(
        manager
            .replace_session_view(query.session_id, request)
            .await?,
    )
}

async fn replace_session_filter(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<u64>,
    ApiJson(filter): ApiJson<SessionFilter>,
) -> ApiResult {
    success(manager.replace_session_filter(id, filter).await?)
}

async fn session_interceptors(
    State(manager): State<ManagerState>,
    ApiQuery(query): ApiQuery<SessionQuery>,
) -> ApiResult {
    success(manager.session_interceptors(query.session_id).await?)
}

async fn replace_session_interceptors(
    State(manager): State<ManagerState>,
    ApiQuery(query): ApiQuery<SessionQuery>,
    ApiJson(request): ApiJson<ReplaceSessionInterceptorsRequest>,
) -> ApiResult {
    success(
        manager
            .replace_session_interceptors(query.session_id, request)
            .await?,
    )
}

async fn column_scripts(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.column_scripts().await?)
}

async fn create_column_script(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<ScriptRequest>,
) -> ApiResult {
    manager.create_column_script(request).await?;
    success(json!({}))
}

async fn column_script(
    State(manager): State<ManagerState>,
    ApiPath(name): ApiPath<String>,
) -> ApiResult {
    success(manager.column_script(name).await?)
}

async fn update_column_script(
    State(manager): State<ManagerState>,
    ApiPath(name): ApiPath<String>,
    ApiJson(request): ApiJson<UpdateScriptRequest>,
) -> ApiResult {
    manager.update_column_script(name, request).await?;
    success(json!({}))
}

async fn delete_column_script(
    State(manager): State<ManagerState>,
    ApiPath(name): ApiPath<String>,
) -> ApiResult {
    manager.delete_column_script(name).await?;
    success(json!({}))
}

async fn filter_scripts(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.filter_scripts().await?)
}

async fn create_filter_script(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<ScriptRequest>,
) -> ApiResult {
    manager.create_filter_script(request).await?;
    success(json!({}))
}

async fn filter_script(
    State(manager): State<ManagerState>,
    ApiPath(name): ApiPath<String>,
) -> ApiResult {
    success(manager.filter_script(name).await?)
}

async fn update_filter_script(
    State(manager): State<ManagerState>,
    ApiPath(name): ApiPath<String>,
    ApiJson(request): ApiJson<UpdateScriptRequest>,
) -> ApiResult {
    manager.update_filter_script(name, request).await?;
    success(json!({}))
}

async fn delete_filter_script(
    State(manager): State<ManagerState>,
    ApiPath(name): ApiPath<String>,
) -> ApiResult {
    manager.delete_filter_script(name).await?;
    success(json!({}))
}

async fn debug_filter_script(
    ReadManager(manager): ReadManager,
    ApiPath(name): ApiPath<String>,
    ApiJson(request): ApiJson<DebugFilterScriptRequest>,
) -> ApiResult {
    success(manager.debug_filter_script(name, request).await?)
}

async fn routing_scripts(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.routing_scripts().await?)
}

async fn create_routing_script(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<ScriptRequest>,
) -> ApiResult {
    manager.create_routing_script(request).await?;
    success(json!({}))
}

async fn routing_script(
    State(manager): State<ManagerState>,
    ApiPath(name): ApiPath<String>,
) -> ApiResult {
    success(manager.routing_script(name).await?)
}

async fn update_routing_script(
    State(manager): State<ManagerState>,
    ApiPath(name): ApiPath<String>,
    ApiJson(request): ApiJson<UpdateScriptRequest>,
) -> ApiResult {
    manager.update_routing_script(name, request).await?;
    success(json!({}))
}

async fn delete_routing_script(
    State(manager): State<ManagerState>,
    ApiPath(name): ApiPath<String>,
) -> ApiResult {
    manager.delete_routing_script(name).await?;
    success(json!({}))
}

async fn routing_selection(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.routing_selection().await?)
}

async fn replace_routing_selection(
    State(manager): State<ManagerState>,
    ApiJson(selection): ApiJson<RoutingSelection>,
) -> ApiResult {
    success(manager.replace_routing_selection(selection).await?)
}

#[derive(Deserialize)]
struct KindQuery {
    kind: InterceptorKind,
}

async fn interceptors(
    State(manager): State<ManagerState>,
    ApiQuery(query): ApiQuery<KindQuery>,
) -> ApiResult {
    success(manager.interceptors(query.kind).await?)
}

async fn create_interceptor(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<InterceptorCreateRequest>,
) -> ApiResult {
    manager.create_interceptor(request).await?;
    success(json!({}))
}

async fn interceptor(
    State(manager): State<ManagerState>,
    ApiPath((kind, name)): ApiPath<(String, String)>,
) -> ApiResult {
    let kind = parse_kind(&kind)?;
    success(manager.interceptor(kind, name).await?)
}

async fn update_interceptor(
    State(manager): State<ManagerState>,
    ApiPath((kind, name)): ApiPath<(String, String)>,
    ApiJson(request): ApiJson<InterceptorUpdateRequest>,
) -> ApiResult {
    manager
        .update_interceptor(parse_kind(&kind)?, name, request)
        .await?;
    success(json!({}))
}

async fn delete_interceptor(
    State(manager): State<ManagerState>,
    ApiPath((kind, name)): ApiPath<(String, String)>,
) -> ApiResult {
    manager.delete_interceptor(parse_kind(&kind)?, name).await?;
    success(json!({}))
}

async fn clash_subscription(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.clash_subscription().await?)
}

async fn enable_clash_subscription(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<EnableClashSubscriptionRequest>,
) -> ApiResult {
    success(manager.enable_clash_subscription(request).await?)
}

async fn disable_clash_subscription(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.disable_clash_subscription().await?)
}

async fn clash_config(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.clash_config().await?)
}

async fn save_clash_config(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<SaveClashConfigRequest>,
) -> ApiResult {
    success(manager.save_clash_config(request).await?)
}

async fn reset_clash_config(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.reset_clash_config().await?)
}

async fn download_certificate(State(manager): State<ManagerState>) -> Response {
    let mut response = match manager.certificate().await {
        Ok(certificate) => (
            [
                (CONTENT_TYPE, "application/x-x509-ca-cert"),
                (
                    CONTENT_DISPOSITION,
                    "attachment; filename=\"proxycrab-ca.crt\"",
                ),
            ],
            certificate.pem,
        )
            .into_response(),
        Err(error) => ApiError(error).into_response(),
    };
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn system_logs(
    State(manager): State<ManagerState>,
    ApiQuery(query): ApiQuery<SystemLogsQuery>,
) -> ApiResult {
    success(manager.system_logs(query).await?)
}

async fn clear_system_logs(State(manager): State<ManagerState>) -> ApiResult {
    manager.clear_system_logs().await?;
    success(json!({}))
}

/* ---- Workflow domain (flow projects / workflows) ---- */

async fn flow_projects(
    State(manager): State<ManagerState>,
    ApiQuery(query): ApiQuery<FlowListQuery>,
) -> ApiResult {
    success(manager.flow_projects(query).await?)
}

async fn create_flow_project(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<FlowProjectCreateRequest>,
) -> ApiResult {
    success(manager.create_flow_project(request).await?)
}

async fn flow_project(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<String>,
) -> ApiResult {
    success(manager.flow_project(id).await?)
}

async fn update_flow_project(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<String>,
    ApiJson(request): ApiJson<FlowProjectUpdateRequest>,
) -> ApiResult {
    success(manager.update_flow_project(id, request).await?)
}

async fn delete_flow_project(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<String>,
) -> ApiResult {
    manager.delete_flow_project(id).await?;
    success(json!({}))
}

async fn workflows(
    State(manager): State<ManagerState>,
    ApiQuery(query): ApiQuery<WorkflowListQuery>,
) -> ApiResult {
    success(manager.workflows(query).await?)
}

async fn create_workflow(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<WorkflowCreateRequest>,
) -> ApiResult {
    success(manager.create_workflow(request).await?)
}

async fn workflow(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<String>,
) -> ApiResult {
    success(manager.workflow(id).await?)
}

async fn update_workflow(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<String>,
    ApiJson(request): ApiJson<WorkflowUpdateRequest>,
) -> ApiResult {
    success(manager.update_workflow(id, request).await?)
}

async fn delete_workflow(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<String>,
) -> ApiResult {
    manager.delete_workflow(id).await?;
    success(json!({}))
}

async fn validate_workflow(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<String>,
) -> ApiResult {
    success(json!({ "issues": manager.validate_workflow(id).await? }))
}

// Pre/post script dry-run (plan Task 18): executes in a throwaway flow VM —
// no entity is created, nothing is persisted or broadcast, and the request
// body (which embeds the script) is excluded from the permission audit preview.
async fn flow_script_dry_run(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<FlowScriptDryRunRequest>,
) -> ApiResult {
    success(manager.flow_script_dry_run(request).await?)
}

// Workflow transfer (plan Task 23). The export response is the raw envelope
// document itself (a JSON file download aligned with the CA-certificate
// download precedent), not the management `{ok,data}` wrapper, so the saved
// file is directly importable.
async fn export_workflows(
    State(manager): State<ManagerState>,
    ApiQuery(query): ApiQuery<WorkflowExportQuery>,
) -> Result<Response, ApiError> {
    let ids: Vec<String> = query
        .ids
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect();
    let file = manager.export_workflows(ids).await?;
    let body = serde_json::to_string(&file)
        .map_err(|error| ApiError(ManagerError::internal(error.to_string())))?;
    let mut response = Response::new(Body::from(body));
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"reqflow-workflows.json\""),
    );
    Ok(response)
}

async fn import_workflows(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<WorkflowImportRequest>,
) -> ApiResult {
    success(manager.import_workflows(request).await?)
}

// Environment variable sets and global variables; reads return masked secret
// values, writes restore stored plaintext for values left masked.

async fn env_sets(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.env_sets().await?)
}

/* ---- MCP exposure tiers (plan Task 25 Step 2) ---- */

async fn get_mcp_tiers(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.mcp_tiers().await?)
}

async fn replace_mcp_tiers(
    State(manager): State<ManagerState>,
    ApiJson(tiers): ApiJson<McpTiers>,
) -> ApiResult {
    success(manager.replace_mcp_tiers(tiers).await?)
}

async fn create_env_set(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<CreateEnvSetRequest>,
) -> ApiResult {
    success(manager.create_env_set(request).await?)
}

async fn save_env_set(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<String>,
    ApiJson(request): ApiJson<SaveEnvSetRequest>,
) -> ApiResult {
    success(manager.save_env_set(id, request).await?)
}

async fn delete_env_set(State(manager): State<ManagerState>, ApiPath(id): ApiPath<String>) -> ApiResult {
    manager.delete_env_set(id).await?;
    success(json!({}))
}

async fn replace_active_env_set(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<ReplaceActiveEnvSetRequest>,
) -> ApiResult {
    let active_set_id = manager.replace_active_env_set(request).await?;
    success(json!({ "activeSetId": active_set_id }))
}

async fn replace_env_globals(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<ReplaceEnvGlobalsRequest>,
) -> ApiResult {
    success(manager.replace_env_globals(request).await?)
}

async fn env_write_back(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<EnvWriteBackRequest>,
) -> ApiResult {
    success(manager.env_write_back(request).await?)
}

async fn bypass_entries(
    ReadManager(manager): ReadManager,
    ApiQuery(query): ApiQuery<BypassQuery>,
) -> ApiResult {
    success(manager.bypass_entries(query).await?)
}

async fn delete_bypass_entry(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<u64>,
) -> ApiResult {
    manager.delete_bypass_entry(id).await?;
    success(json!({}))
}

async fn delete_bypass_entries(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<DeleteBypassRequest>,
) -> ApiResult {
    success(manager.delete_bypass_entries(request.ids).await?)
}

async fn clear_bypass_entries(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.clear_bypass_entries().await?)
}

async fn request_library_list(
    State(manager): State<ManagerState>,
    ApiQuery(query): ApiQuery<RequestLibraryQuery>,
) -> ApiResult {
    success(manager.request_library_page(query).await?)
}

async fn request_library_create(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<CreateRequestLibraryRequest>,
) -> ApiResult {
    success(manager.create_request_library_entry(request).await?)
}

async fn request_library_from_capture(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<IngestCaptureRequest>,
) -> ApiResult {
    success(manager.ingest_request_from_capture(request).await?)
}

async fn request_library_get(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<String>,
) -> ApiResult {
    success(manager.request_library_entry(id).await?)
}

async fn request_library_update(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<String>,
    ApiJson(request): ApiJson<UpdateRequestLibraryRequest>,
) -> ApiResult {
    success(manager.update_request_library_entry(id, request).await?)
}

async fn request_library_delete(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<String>,
) -> ApiResult {
    manager.delete_request_library_entry(id).await?;
    success(json!({}))
}

async fn request_library_body(
    State(manager): State<ManagerState>,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<RequestLibraryBodyQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if query.max_size == Some(0) {
        return Err(ApiError(ManagerError::bad_request(
            "max_size must be greater than zero",
        )));
    }
    let source = manager
        .request_library_body_source(
            id,
            query.max_size.unwrap_or_else(default_body_max_size),
        )
        .await?;
    body_response(source, &headers, query.max_size).await.map_err(ApiError)
}

async fn not_found() -> ApiResult {
    Err(ApiError(ManagerError::not_found("api endpoint not found")))
}

fn parse_kind(kind: &str) -> Result<InterceptorKind, ApiError> {
    match kind {
        "request" => Ok(InterceptorKind::Request),
        "response" => Ok(InterceptorKind::Response),
        _ => Err(ApiError(ManagerError::bad_request(
            "interceptor kind must be request or response",
        ))),
    }
}

fn parse_body_side(side: &str) -> Result<BodySide, ApiError> {
    match side {
        "request" => Ok(BodySide::Request),
        "response" => Ok(BodySide::Response),
        _ => Err(ApiError(ManagerError::bad_request(
            "body side must be request or response",
        ))),
    }
}

fn validate_body_query(query: &BodyQuery) -> Result<(), ApiError> {
    if query.max_size == Some(0) {
        Err(ApiError(ManagerError::bad_request(
            "max_size must be greater than zero",
        )))
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BodyResponseEncoding {
    Original,
    Gzip,
    Deflate,
    Identity,
}

#[derive(Debug)]
struct EncodingPreference {
    name: String,
    allowed: bool,
}

#[derive(Debug, Default)]
struct AcceptedEncodings {
    values: Vec<EncodingPreference>,
}

impl AcceptedEncodings {
    fn from_headers(headers: &HeaderMap) -> Self {
        let values = headers
            .get_all(ACCEPT_ENCODING)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .filter_map(parse_encoding_preference)
            .collect();
        Self { values }
    }

    fn allows(&self, name: &str) -> bool {
        if let Some(allowed) = self.explicit(name) {
            return allowed;
        }
        if name.eq_ignore_ascii_case("identity") {
            // RFC 9110 §12.5.3：未显式列出的 identity 受 `*` 约束，
            // `*;q=0` 与 `identity;q=0` 等价地禁止 identity。
            return self.explicit("*").unwrap_or(true);
        }
        self.explicit("*").unwrap_or(false)
    }

    fn explicit(&self, name: &str) -> Option<bool> {
        let mut found = false;
        let mut allowed = true;
        for value in &self.values {
            if value.name.eq_ignore_ascii_case(name) {
                found = true;
                allowed &= value.allowed;
            }
        }
        found.then_some(allowed)
    }

    fn select(&self, source: &BodySource) -> Result<BodyResponseEncoding, ManagerError> {
        let original_allowed = if source.content_encodings.is_empty() {
            self.allows("identity")
        } else {
            source
                .content_encodings
                .iter()
                .all(|encoding| self.allows(encoding))
        };
        if original_allowed {
            return Ok(BodyResponseEncoding::Original);
        }
        for (name, encoding) in [
            ("gzip", BodyResponseEncoding::Gzip),
            ("deflate", BodyResponseEncoding::Deflate),
            ("identity", BodyResponseEncoding::Identity),
        ] {
            if self.allows(name) {
                return Ok(encoding);
            }
        }
        Err(ManagerError::new(
            ErrorCode::NotAcceptableEncoding,
            "the client prohibited every available response content encoding",
        ))
    }
}

fn parse_encoding_preference(value: &str) -> Option<EncodingPreference> {
    let mut parts = value.split(';');
    let name = parts.next()?.trim();
    if !is_encoding_token(name) {
        return None;
    }
    let mut allowed = true;
    let mut quality_seen = false;
    for parameter in parts {
        let (key, value) = parameter.split_once('=')?;
        if !key.trim().eq_ignore_ascii_case("q") {
            return None;
        }
        if quality_seen {
            return None;
        }
        quality_seen = true;
        allowed = parse_quality(value.trim())?;
    }
    Some(EncodingPreference {
        name: name.to_ascii_lowercase(),
        allowed,
    })
}

fn parse_quality(value: &str) -> Option<bool> {
    let (whole, fractional) = value.split_once('.').unwrap_or((value, ""));
    if fractional.len() > 3 || !fractional.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    match whole {
        "0" => Some(fractional.bytes().any(|byte| byte != b'0')),
        "1" if fractional.bytes().all(|byte| byte == b'0') => Some(true),
        _ => None,
    }
}

fn is_encoding_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

pub type DynBodyReader = Pin<Box<dyn AsyncRead + Send>>;

/// Open a Body stream for HTTP responses or trusted host file downloads.
pub async fn body_reader(
    source: &BodySource,
    decompress: bool,
) -> Result<DynBodyReader, ManagerError> {
    let mut reader: DynBodyReader = match &source.data {
        BodySourceData::File(path) => Box::pin(
            tokio::fs::File::open(path)
                .await
                .map_err(|error| ManagerError::new(ErrorCode::BodyReadFailed, error.to_string()))?,
        ),
        BodySourceData::Bytes(bytes) => {
            let stream = stream::once({
                let bytes = Bytes::copy_from_slice(bytes);
                async move { Ok::<Bytes, io::Error>(bytes) }
            });
            Box::pin(StreamReader::new(stream))
        }
    };
    if !decompress {
        return Ok(reader);
    }
    for encoding in source.content_encodings.iter().rev() {
        let buffered = BufReader::new(reader);
        reader = match encoding.as_str() {
            "gzip" => Box::pin(GzipDecoder::new(buffered)),
            "br" => Box::pin(BrotliDecoder::new(buffered)),
            "deflate" => Box::pin(ZlibDecoder::new(buffered)),
            "zstd" => Box::pin(ZstdDecoder::new(buffered)),
            other => {
                return Err(ManagerError::new(
                    ErrorCode::BodyDecodeFailed,
                    format!("unsupported content encoding {other}"),
                ));
            }
        };
    }
    Ok(reader)
}

pub(crate) async fn body_response(
    source: BodySource,
    request_headers: &HeaderMap,
    max_size: Option<u64>,
) -> ManagerResult<Response> {
    let max_size = max_size.unwrap_or_else(default_body_max_size);
    if source.stored_size > max_size {
        return Err(ManagerError::body_too_large(source.stored_size, max_size));
    }

    let encoding = AcceptedEncodings::from_headers(request_headers).select(&source)?;
    let reader: DynBodyReader = match encoding {
        BodyResponseEncoding::Original => body_reader(&source, false).await?,
        BodyResponseEncoding::Identity => body_reader(&source, true).await?,
        BodyResponseEncoding::Gzip => {
            let reader = body_reader(&source, true).await?;
            Box::pin(GzipEncoder::new(BufReader::new(reader)))
        }
        BodyResponseEncoding::Deflate => {
            let reader = body_reader(&source, true).await?;
            Box::pin(ZlibEncoder::new(BufReader::new(reader)))
        }
    };
    let stream = ReaderStream::new(reader);
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = StatusCode::OK;
    let content_type = source
        .content_type
        .as_deref()
        .and_then(|value| HeaderValue::from_str(value).ok())
        .unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"));
    response.headers_mut().insert(CONTENT_TYPE, content_type);
    if encoding == BodyResponseEncoding::Original {
        response.headers_mut().insert(
            CONTENT_LENGTH,
            HeaderValue::from_str(&source.stored_size.to_string())
                .expect("u64 is always a valid Content-Length"),
        );
        if !source.content_encodings.is_empty() {
            response.headers_mut().insert(
                CONTENT_ENCODING,
                HeaderValue::from_str(&source.content_encodings.join(", ")).map_err(|error| {
                    ManagerError::new(ErrorCode::BodyReadFailed, error.to_string())
                })?,
            );
        }
    } else if let Some(value) = match encoding {
        BodyResponseEncoding::Gzip => Some(HeaderValue::from_static("gzip")),
        BodyResponseEncoding::Deflate => Some(HeaderValue::from_static("deflate")),
        BodyResponseEncoding::Original | BodyResponseEncoding::Identity => None,
    } {
        response.headers_mut().insert(CONTENT_ENCODING, value);
    }
    response
        .headers_mut()
        .insert(VARY, HeaderValue::from_static("Accept-Encoding"));
    response.headers_mut().insert(
        "x-proxycrab-body-size",
        HeaderValue::from_str(&source.stored_size.to_string())
            .expect("u64 is always a valid header value"),
    );
    Ok(response)
}

/* ---- MCP endpoint (plan Task 24): JSON-RPC 2.0 over POST /mcp ---- */

/// 无状态 JSON-RPC 2.0 端点。鉴权已在 `authorize_request` 中间件完成
/// （"POST /mcp" 目录 action，既有 LocalLoopback/Bearer 身份）；
/// `tools/call` 由策展工具链接管（映射路由逐次鉴权 + 执行，见
/// `mcp::tools`），信封处理不触碰 manager 状态。畸形信封以 HTTP 200
/// 携带 JSON-RPC 协议错误应答；纯通知请求回 202 无正文；读体失败
/// （含超限）按解析错误 -32700 应答。
async fn mcp_endpoint(
    State(manager): State<ManagerState>,
    Extension(permissions): Extension<Arc<dyn PermissionManager>>,
    request: Request,
) -> Response {
    // 中间件已通过 "POST /mcp" action 并把调用者身份写入 extensions；
    // 理论上必然存在，缺失时按未授权拒绝（fail closed）。
    let credential = match request.extensions().get::<ManagementCredential>().cloned() {
        Some(credential) => credential,
        None => {
            return permission_denied_response(PermissionDenied::unauthorized(
                "remote_auth_required",
                "remote management API requests require Authorization",
            ));
        }
    };
    // MCP 暴露档位随请求读取（工作区小 JSON 文件，plan Task 25 Step 2）；
    // 读取失败降级为缺省档并告警（缺省关写/执行，fail-safe）。
    let tiers = manager.mcp_tiers().await.unwrap_or_else(|error| {
        tracing::warn!("degrading MCP exposure tiers to defaults: {}", error.message);
        McpTiers::default()
    });
    let context = mcp::tools::ToolCallContext {
        manager,
        permissions,
        credential,
        tiers,
        permits: mcp::tools::tool_call_permits(),
    };
    let body = match axum::body::to_bytes(request.into_body(), mcp::MAX_MESSAGE_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return (
                StatusCode::OK,
                Json(mcp::protocol::error(
                    &Value::Null,
                    mcp::protocol::PARSE_ERROR,
                    "failed to read request body",
                )),
            )
                .into_response();
        }
    };
    match mcp::respond(&body, &context, mcp::tools::TOOL_CALL_TIMEOUT).await {
        Some(envelope) => (StatusCode::OK, Json(envelope)).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

fn success(value: impl serde::Serialize) -> ApiResult {
    Ok(Json(json!({ "ok": true, "data": value })))
}

impl ErrorCode {
    /// 错误码对应的 HTTP 状态码。穷尽匹配：新增错误码必须在编译期决定状态码。
    pub fn http_status(self) -> StatusCode {
        match self {
            Self::RedactionManagementDisabled
            | Self::MessageContentHidden
            | Self::ShareRedactionForbidden => StatusCode::FORBIDDEN,
            Self::MessageContentUnavailable | Self::WorkflowGraphInvalid => {
                StatusCode::UNPROCESSABLE_ENTITY
            }
            Self::BadRequest | Self::InvalidAssetId | Self::InvalidAssetFormat => {
                StatusCode::BAD_REQUEST
            }
            Self::InvalidApiKey | Self::InvalidUiToken => StatusCode::UNAUTHORIZED,
            Self::NotFound
            | Self::LogNotFound
            | Self::BodyNotFound
            | Self::AssetNotFound
            | Self::ExecutionNotFound
            | Self::SnapshotNotFound
            | Self::SnapshotBodyNotFound
            | Self::ShareSessionUnavailable => StatusCode::NOT_FOUND,
            Self::Conflict
            | Self::ProxyRunning
            | Self::ProxyNotRunning
            | Self::SessionInUse
            | Self::AssetAlreadyExists
            | Self::AssetPathConflict => StatusCode::CONFLICT,
            Self::BodyTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::BodyDecodeFailed => StatusCode::UNPROCESSABLE_ENTITY,
            Self::NotAcceptableEncoding => StatusCode::NOT_ACCEPTABLE,
            Self::InternalError
            | Self::BodyReadFailed
            | Self::AssetStoreFailed
            | Self::ReplayFailed
            | Self::RedactionFailed => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

struct ApiError(ManagerError);

impl From<ManagerError> for ApiError {
    fn from(error: ManagerError) -> Self {
        Self(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let varies_on_accept_encoding = self.0.code == ErrorCode::NotAcceptableEncoding;
        let status = self.0.code.http_status();
        let mut response = (
            status,
            Json(json!({
                "ok": false,
                "error": self.0
            })),
        )
            .into_response();
        if varies_on_accept_encoding {
            response
                .headers_mut()
                .insert(VARY, HeaderValue::from_static("Accept-Encoding"));
        }
        response
    }
}

async fn redaction_scripts(State(manager): State<ManagerState>) -> ApiResult {
    success(manager.redaction_scripts().await?)
}

async fn create_redaction_script(
    State(manager): State<ManagerState>,
    ApiJson(request): ApiJson<ScriptRequest>,
) -> ApiResult {
    manager.create_redaction_script(request).await?;
    success(json!({}))
}

async fn redaction_script(
    State(manager): State<ManagerState>,
    ApiPath(name): ApiPath<String>,
) -> ApiResult {
    success(manager.redaction_script(name).await?)
}

async fn update_redaction_script(
    State(manager): State<ManagerState>,
    ApiPath(name): ApiPath<String>,
    ApiJson(request): ApiJson<UpdateScriptRequest>,
) -> ApiResult {
    manager.update_redaction_script(name, request).await?;
    success(json!({}))
}

async fn delete_redaction_script(
    State(manager): State<ManagerState>,
    ApiPath(name): ApiPath<String>,
) -> ApiResult {
    manager.delete_redaction_script(name).await?;
    success(json!({}))
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use std::{
        io::{Read, Write},
        net::SocketAddr,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use async_trait::async_trait;
    use axum::{
        body::{Body, to_bytes},
        extract::ConnectInfo,
        http::{
            HeaderMap, Method, Request, StatusCode,
            header::{
                ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
                ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_REQUEST_HEADERS, AUTHORIZATION,
            },
        },
        response::IntoResponse,
    };
    use flate2::{
        Compression,
        read::{GzDecoder, ZlibDecoder},
        write::{GzEncoder, ZlibEncoder},
    };
    use proxy_crab_mitm::{ProxyCrab, flow::run::FlowRunEvent, log_buffer::LogBuffer};
    use proxy_crab_mitm::{
        model::{
            BodySourceType, HeaderValues, InterceptorExecutionOrigin, InterceptorKind,
            InterceptorRun, Modification, NewSession, RequestData, RequestInterceptorSnapshot,
            script_content_hash,
        },
        storage::{BodySide, BodySource, BodySourceData, CaptureStore},
    };
    use serde_json::{Value, json};
    use tempfile::tempdir;
    use tokio_util::sync::CancellationToken;
    use tower::ServiceExt;

    use crate::{
        dto::{ErrorCode, HttpApiResource},
        http::{
            ApiError, body_response, change_for_request, router, router_with_changes,
            secured_router, spawn_flow_run_change_bridge, spawn_proxy_status_change_bridge,
            start_http_server,
        },
        manager::{MitmManager, ProxyCrabManager},
        permission::{ManagementCredential, PermissionAction, PermissionDenied, PermissionManager},
    };

    struct BoundReads;
    #[async_trait]
    impl PermissionManager for BoundReads {
        async fn check_permission(&self, _action: PermissionAction) -> Option<PermissionDenied> {
            None
        }
        async fn redaction_script(
            &self,
            credential: &ManagementCredential,
        ) -> Result<Option<String>, PermissionDenied> {
            Ok(match credential {
                ManagementCredential::LocalLoopback => Some("local-mask".into()),
                ManagementCredential::Bearer(_) => Some("token-mask".into()),
            })
        }
    }
    #[tokio::test]
    async fn redaction_management_reads_use_local_or_bearer_binding() {
        let dir = tempdir().unwrap();
        let runtime = ProxyCrab::open(dir.path(), Arc::new(LogBuffer::default())).unwrap();
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
        for name in ["local-mask", "token-mask"] {
            manager.create_redaction_script(crate::dto::ScriptRequest { name: name.into(), content: format!("assert(context.api == '/api/logs/{{id}}'); req.uri = 'https://example.com/{name}'") }).await.unwrap();
        }
        let app = router(manager.clone(), Arc::new(BoundReads));
        for (auth, expected) in [
            (None, "local-mask"),
            (Some("Bearer test-key"), "token-mask"),
        ] {
            let mut request =
                Request::builder().uri(format!("/api/logs/{id}?session_id={}", session.id));
            if let Some(auth) = auth {
                request = request.header("authorization", auth);
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::OK);
            let payload: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            assert_eq!(
                payload["data"]["request"]["uri"],
                format!("https://example.com/{expected}")
            );
        }
        manager
            .delete_redaction_script("local-mask".into())
            .await
            .unwrap();
        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/logs/{id}?session_id={}", session.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
        let text = String::from_utf8(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(text.contains("redaction_failed") && !text.contains("secret"));

        // A pinned policy overrides both missing identity bindings and unbound owner reads.
        let forced = manager.with_forced_redaction(proxy_crab_mitm::model::Script {
            name: "startup.lua".into(),
            content: "assert(context.api == '/api/logs/{id}'); req.uri = 'https://example.com/forced'".into(),
        }).unwrap();
        for permissions in [
            Arc::new(BoundReads) as Arc<dyn PermissionManager>,
            Arc::new(AllowAll),
        ] {
            let app = router(forced.clone(), permissions);
            for auth in [None, Some("Bearer test-key")] {
                let mut request =
                    Request::builder().uri(format!("/api/logs/{id}?session_id={}", session.id));
                if let Some(auth) = auth {
                    request = request.header("authorization", auth);
                }
                let response = app
                    .clone()
                    .oneshot(request.body(Body::empty()).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status(), axum::http::StatusCode::OK);
                let payload: Value = serde_json::from_slice(
                    &to_bytes(response.into_body(), usize::MAX).await.unwrap(),
                )
                .unwrap();
                assert_eq!(
                    payload["data"]["request"]["uri"],
                    "https://example.com/forced"
                );
            }
            for (method, path, body) in [
                ("GET", "/api/redaction-scripts", ""),
                (
                    "POST",
                    "/api/redaction-scripts",
                    r#"{"name":"new","content":""}"#,
                ),
                ("GET", "/api/redaction-scripts/token-mask", ""),
                (
                    "PUT",
                    "/api/redaction-scripts/token-mask",
                    r#"{"content":""}"#,
                ),
                ("DELETE", "/api/redaction-scripts/token-mask", ""),
            ] {
                let response = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method(method)
                            .uri(path)
                            .header("content-type", "application/json")
                            .body(Body::from(body))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
                let payload: Value = serde_json::from_slice(
                    &to_bytes(response.into_body(), usize::MAX).await.unwrap(),
                )
                .unwrap();
                assert_eq!(payload["error"]["code"], "redaction_management_disabled");
                assert_eq!(payload["error"]["message"], "脱敏接口管理功能已禁用");
            }
        }
        assert!(manager.redaction_script("token-mask".into()).await.is_ok());
    }

    #[tokio::test]
    async fn bundle_multipart_requires_explicit_intents_and_runs_without_activation() {
        let directory = tempdir().unwrap();
        let runtime = ProxyCrab::open(directory.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let zip = crate::bundle::export(
            &runtime,
            session.id,
            &crate::bundle::ConfigShare { assets: vec![] },
        )
        .unwrap();
        let app = router(MitmManager::new(runtime.clone()), allow_all());
        for (ids, expected) in [
            ("[]".to_string(), StatusCode::BAD_REQUEST),
            (format!("[\"session-{}\"]", session.id), StatusCode::OK),
        ] {
            let mut body = format!("--bundle-boundary\r\nContent-Disposition: form-data; name=\"accepted_intent_ids\"\r\n\r\n{ids}\r\n--bundle-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"bundle.zip\"\r\nContent-Type: application/zip\r\n\r\n").into_bytes();
            body.extend_from_slice(&zip);
            body.extend_from_slice(b"\r\n--bundle-boundary--\r\n");
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/imports")
                        .header(
                            "content-type",
                            "multipart/form-data; boundary=bundle-boundary",
                        )
                        .header("authorization", "Bearer test")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
        assert_eq!(runtime.sessions().len(), 2);
        assert_eq!(runtime.active_session_id(), None);
    }

    struct AllowAll;

    #[async_trait]
    impl PermissionManager for AllowAll {
        async fn check_permission(&self, _action: PermissionAction) -> Option<PermissionDenied> {
            None
        }
    }

    fn allow_all() -> Arc<dyn PermissionManager> {
        Arc::new(AllowAll)
    }

    #[derive(Debug, PartialEq, Eq)]
    struct RecordedPermission {
        id: &'static str,
        bearer: Option<String>,
        actual_path: String,
        query: Option<String>,
        body_preview: Option<String>,
        body_preview_truncated: bool,
    }

    struct RecordingPermissions {
        items: Arc<Mutex<Vec<RecordedPermission>>>,
        denied: Option<PermissionDenied>,
    }

    #[async_trait]
    impl PermissionManager for RecordingPermissions {
        async fn check_permission(&self, action: PermissionAction) -> Option<PermissionDenied> {
            let bearer = match action.credential {
                ManagementCredential::LocalLoopback => None,
                ManagementCredential::Bearer(token) => Some(token),
            };
            self.items.lock().unwrap().push(RecordedPermission {
                id: action.action.id,
                bearer,
                actual_path: action.actual_path,
                query: action.query,
                body_preview: action.body_preview,
                body_preview_truncated: action.body_preview_truncated,
            });
            self.denied.clone()
        }
    }

    fn recording_permissions(
        denied: Option<PermissionDenied>,
    ) -> (
        Arc<dyn PermissionManager>,
        Arc<Mutex<Vec<RecordedPermission>>>,
    ) {
        let items = Arc::new(Mutex::new(Vec::new()));
        (
            Arc::new(RecordingPermissions {
                items: items.clone(),
                denied,
            }),
            items,
        )
    }

    #[tokio::test]
    async fn permission_middleware_records_template_and_preserves_json_body() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let (permissions, recorded) = recording_permissions(None);
        let app = router(manager, permissions);
        let body = r#"{"name":"through approval","description":"complete body"}"#;

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/sessions?source=test")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer pcrab_example")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            *recorded.lock().unwrap(),
            vec![RecordedPermission {
                id: "POST /api/sessions",
                bearer: Some("pcrab_example".into()),
                actual_path: "/api/sessions".into(),
                query: Some("source=test".into()),
                body_preview: Some(body.into()),
                body_preview_truncated: false,
            }]
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn script_dry_run_executes_and_keeps_body_out_of_audit_preview() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let (permissions, recorded) = recording_permissions(None);
        let app = router(manager, permissions);
        let body = json!({
            "side": "pre",
            "script": "return { url: input.baseUrl + '/api' }",
            "sampleInput": { "baseUrl": "https://example.test" },
        })
        .to_string();

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/flow/script/dry-run")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer pcrab_example")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let envelope: Value = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX).await.unwrap(),
        )
        .unwrap();
        assert_eq!(envelope["ok"], json!(true), "envelope: {envelope}");
        assert_eq!(envelope["data"]["ok"], json!(true), "envelope: {envelope}");
        assert_eq!(
            envelope["data"]["value"]["url"],
            json!("https://example.test/api"),
            "envelope: {envelope}"
        );
        // 请求体（内嵌脚本内容）不进权限审计预览：body_preview 必须整体缺席
        let recorded = recorded.lock().unwrap();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].id, "POST /api/flow/script/dry-run");
        assert_eq!(recorded[0].body_preview, None);
        assert!(!recorded[0].body_preview_truncated);
    }

    #[tokio::test]
    async fn permission_denial_uses_stable_envelope_and_skips_handler() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        assert!(runtime.sessions().is_empty());
        let manager = MitmManager::new(runtime.clone());
        let (permissions, recorded) = recording_permissions(Some(PermissionDenied::forbidden(
            "permission_denied",
            "this action is blocked",
        )));
        let app = router(manager, permissions);

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/sessions")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"must not exist"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["error"]["code"], "permission_denied");
        assert_eq!(recorded.lock().unwrap().len(), 1);
        assert!(runtime.sessions().is_empty());
    }

    #[tokio::test]
    async fn permission_middleware_uses_route_template_for_path_parameters() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let manager = MitmManager::new(runtime);
        let (permissions, recorded) = recording_permissions(None);
        let app = router(manager, permissions);

        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/sessions/{}", session.id))
                    .method(Method::PUT)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"renamed"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(recorded.lock().unwrap()[0].id, "PUT /api/sessions/{id}");
    }

    /// Send one management request with an optional JSON body and deserialize
    /// the response envelope; used by the workflow-domain endpoint tests.
    async fn flow_request(
        app: axum::Router,
        method: Method,
        uri: &str,
        body: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if body.is_some() {
            builder = builder.header("content-type", "application/json");
        }
        let response = app
            .oneshot(
                builder
                    .body(Body::from(body.unwrap_or_default().to_owned()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let payload: Value = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX).await.unwrap(),
        )
        .unwrap_or(Value::Null);
        (status, payload)
    }

    #[tokio::test]
    async fn workflow_domain_endpoints_cover_crud_and_validation() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let (permissions, recorded) = recording_permissions(None);
        let app = router(manager, permissions);

        // Create a project; ids and timestamps are server-generated.
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/flow-projects",
            Some(r##"{"name":"demo","color":"#4f46e5","secretVariables":{"k":"v"}}"##),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["ok"], true);
        let project = &payload["data"];
        assert!(project["id"].as_str().unwrap().starts_with("proj-"));
        assert_eq!(project["name"], "demo");
        assert_eq!(project["color"], "#4f46e5");
        assert_eq!(project["secretVariables"]["k"], "v");
        assert!(project["createdAt"].as_u64().is_some());
        let project_id = project["id"].as_str().unwrap().to_owned();

        // Create a workflow whose graph is intentionally invalid (no start).
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/workflows",
            Some(&format!(
                r#"{{"projectId":"{project_id}","name":"flow","nodes":[{{"id":"n1","type":"httpReplay","position":{{"x":1,"y":2}},"config":{{}}}}],"edges":[{{"id":"e1","source":"n1","target":"ghost"}}]}}"#
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let workflow = &payload["data"];
        assert!(workflow["id"].as_str().unwrap().starts_with("wf-"));
        assert_eq!(workflow["projectId"], project_id.as_str());
        assert_eq!(workflow["schemaVersion"], 1);
        let workflow_id = workflow["id"].as_str().unwrap().to_owned();

        // Validation reports the structural issues without blocking the save.
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            &format!("/api/workflows/{workflow_id}/validate"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let issues = payload["data"]["issues"].as_array().unwrap();
        let codes: Vec<&str> = issues.iter().map(|issue| issue["code"].as_str().unwrap()).collect();
        assert_eq!(
            codes,
            vec!["missing-start", "dangling-edge"],
            "issue DTO shape: {{code,message,nodeIds}} with fixed order"
        );
        assert!(issues[0]["message"].is_string());
        assert_eq!(issues[0]["nodeIds"], json!([]));
        assert_eq!(issues[1]["nodeIds"], json!(["n1"]));

        // Lists are filterable and paginated.
        let (status, payload) = flow_request(
            app.clone(),
            Method::GET,
            &format!("/api/workflows?projectId={project_id}&limit=10&offset=0"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["data"]["total"], 1);
        assert_eq!(payload["data"]["workflows"][0]["id"], workflow_id.as_str());
        let (status, payload) = flow_request(
            app.clone(),
            Method::GET,
            "/api/flow-projects?limit=10",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["data"]["total"], 1);
        assert_eq!(payload["data"]["projects"][0]["id"], project_id.as_str());

        // Whole-graph replacement requires both nodes and edges.
        let (status, payload) = flow_request(
            app.clone(),
            Method::PUT,
            &format!("/api/workflows/{workflow_id}"),
            Some(r#"{"nodes":[]}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(payload["error"]["code"], "bad_request");

        // A valid graph replacement plus a rename succeeds.
        let (status, payload) = flow_request(
            app.clone(),
            Method::PUT,
            &format!("/api/workflows/{workflow_id}"),
            Some(
                r#"{"name":"flow2","nodes":[{"id":"s","type":"start","position":{"x":0,"y":0},"config":{}}],"edges":[]}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["data"]["name"], "flow2");
        assert_eq!(payload["data"]["nodes"][0]["type"], "start");
        assert_eq!(payload["data"]["nodes"].as_array().unwrap().len(), 1);
        assert_eq!(payload["data"]["edges"], json!([]));
        assert!(payload["data"]["updatedAt"].as_u64().is_some());

        // Validation is now clean.
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            &format!("/api/workflows/{workflow_id}/validate"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["data"]["issues"], json!([]));

        // Permission checks resolved the concrete route actions.
        let recorded_ids: Vec<&'static str> =
            recorded.lock().unwrap().iter().map(|item| item.id).collect();
        assert!(recorded_ids.contains(&"POST /api/flow-projects"));
        assert!(recorded_ids.contains(&"POST /api/workflows/{id}/validate"));
        assert!(recorded_ids.contains(&"PUT /api/workflows/{id}"));

        // Single reads, deletes and the 404 paths.
        let (status, _) = flow_request(
            app.clone(),
            Method::GET,
            &format!("/api/flow-projects/{project_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, payload) = flow_request(
            app.clone(),
            Method::DELETE,
            &format!("/api/workflows/{workflow_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["data"], json!({}));
        let (status, payload) = flow_request(
            app.clone(),
            Method::GET,
            &format!("/api/workflows/{workflow_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(payload["error"]["code"], "not_found");
    }

    #[tokio::test]
    async fn workflow_transfer_endpoints_round_trip_confirm_scripts_and_adjudication() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let (permissions, recorded) = recording_permissions(None);
        let app = router(manager, permissions);

        // Fixture: one project, one request-library entry, one env set with
        // secrets, and a workflow referencing the entry while carrying scripts
        // and secret variables.
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/flow-projects",
            Some(r#"{"name":"demo"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let project_id = payload["data"]["id"].as_str().unwrap().to_owned();

        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/request-library",
            Some(
                r#"{"har":{"log":{"entries":[{"request":{"method":"GET","url":"https://api.example.com/v1/ping"}}]}},"name":"ping"}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let request_id = payload["data"]["id"].as_str().unwrap().to_owned();

        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/env-sets",
            Some(
                r#"{"name":"dev","values":{"baseUrl":"http://localhost"},"secretValues":{"password":"hunter2"}}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let env_set_id = payload["data"]["id"].as_str().unwrap().to_owned();

        let workflow_body = json!({
            "projectId": project_id,
            "name": "结算链路",
            "description": "导入导出往返",
            "variables": {"env": "dev"},
            "secretVariables": {"token": "pk-live-9999"},
            "nodes": [
                {"id": "s1", "type": "start", "position": {"x": 0, "y": 0}, "config": {}},
                {"id": "n1", "type": "httpReplay", "position": {"x": 1, "y": 2}, "config": {
                    "requestId": request_id,
                    "preProcess": "return input",
                    "postProcess": "return response",
                    "override": {"url": "http://api.test/{{ node.s1.id }}"}
                }},
                {"id": "n2", "type": "condition", "position": {"x": 3, "y": 4}, "config": {
                    "expression": "input.ok === true",
                    "trueTargets": ["n1"],
                    "falseTargets": ["s1"]
                }}
            ],
            "edges": [
                {"id": "e1", "source": "s1", "target": "n1"},
                {"id": "e2", "source": "n2", "target": "n1", "sourceHandle": "true"}
            ]
        })
        .to_string();
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/workflows",
            Some(&workflow_body),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let workflow_id = payload["data"]["id"].as_str().unwrap().to_owned();

        // Export: the raw envelope document (JSON download), with every secret
        // value stripped but ordinary data carried along.
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri(format!("/api/workflows/export?ids={workflow_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["content-disposition"],
            "attachment; filename=\"reqflow-workflows.json\""
        );
        let envelope_bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let envelope_text = String::from_utf8(envelope_bytes.to_vec()).unwrap();
        assert!(!envelope_text.contains("pk-live-9999"));
        assert!(!envelope_text.contains("hunter2"));
        let envelope: Value = serde_json::from_str(&envelope_text).unwrap();
        assert_eq!(envelope["format"], "reqflow-workflow");
        assert_eq!(envelope["version"], 1);
        assert_eq!(envelope["workflows"].as_array().unwrap().len(), 1);
        assert_eq!(envelope["workflows"][0]["id"], workflow_id.as_str());
        assert_eq!(
            envelope["workflows"][0]["secretVariables"]["token"],
            "",
            "secret variable values are blanked, names kept"
        );
        assert_eq!(envelope["requests"].as_array().unwrap().len(), 1);
        assert_eq!(envelope["requests"][0]["id"], request_id.as_str());
        assert_eq!(envelope["envSets"].as_array().unwrap().len(), 1);
        assert_eq!(envelope["envSets"][0]["id"], env_set_id.as_str());
        assert_eq!(
            envelope["envSets"][0]["secretValues"],
            json!({}),
            "the env-set secret table is removed entirely"
        );
        assert_eq!(
            envelope["envSets"][0]["values"]["baseUrl"],
            "http://localhost"
        );

        // Duplicate ids are carried once; a missing id is a plain 404; an
        // empty selection is a bad request.
        let (status, payload) = flow_request(
            app.clone(),
            Method::GET,
            &format!("/api/workflows/export?ids={workflow_id},{workflow_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["workflows"].as_array().unwrap().len(), 1);
        let (status, payload) = flow_request(
            app.clone(),
            Method::GET,
            "/api/workflows/export?ids=wf-missing",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(payload["error"]["code"], "not_found");
        let (status, payload) = flow_request(app.clone(), Method::GET, "/api/workflows/export", None)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(payload["error"]["code"], "bad_request");

        // Import file-level failures are bad requests.
        for malformed in [
            r#"{"file":"a string"}"#,
            r#"{"file":{"format":"other","version":1,"workflows":[]}}"#,
            r#"{"file":{"format":"reqflow-workflow","version":9,"workflows":[{}]}}"#,
            r#"{"file":{"format":"reqflow-workflow","version":1,"workflows":[]},"projectId":""}"#,
        ] {
            let (status, payload) = flow_request(
                app.clone(),
                Method::POST,
                "/api/workflows/import",
                Some(malformed),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{malformed}");
            assert_eq!(payload["error"]["code"], "bad_request", "{malformed}");
        }

        // Remove the original so the import rebuilds it under the same name.
        let (status, _) = flow_request(
            app.clone(),
            Method::DELETE,
            &format!("/api/workflows/{workflow_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        // Import #1, no confirmScripts: the scripts are denied by default.
        let import_body = json!({"file": envelope, "projectId": project_id}).to_string();
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/workflows/import",
            Some(&import_body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{payload}");
        let data = &payload["data"];
        assert_eq!(data["imported"].as_array().unwrap().len(), 1);
        assert_eq!(data["skipped"].as_array().unwrap().len(), 0);
        assert_eq!(data["imported"][0]["index"], 0);
        assert_eq!(data["imported"][0]["name"], "结算链路");
        let rebuilt_id = data["imported"][0]["id"].as_str().unwrap().to_owned();
        assert_ne!(rebuilt_id, workflow_id);
        // Extension adjudication: both entries already exist, so both are
        // skipped with a reason and nothing is overwritten.
        assert_eq!(data["requests"]["imported"], 0);
        assert_eq!(data["requests"]["skipped"][0]["id"], request_id.as_str());
        assert!(data["requests"]["skipped"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("请求库条目已存在"));
        assert_eq!(data["envSets"]["imported"], 0);
        assert_eq!(data["envSets"]["skipped"][0]["id"], env_set_id.as_str());

        // The rebuilt workflow keeps graph, variables and the request
        // reference, regenerates all ids, and carries no scripts.
        let (status, payload) = flow_request(
            app.clone(),
            Method::GET,
            &format!("/api/workflows/{rebuilt_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let rebuilt = &payload["data"];
        assert_eq!(rebuilt["name"], "结算链路");
        assert_eq!(rebuilt["projectId"], project_id.as_str());
        assert_eq!(rebuilt["variables"]["env"], "dev");
        assert_eq!(
            rebuilt["secretVariables"]["token"],
            "",
            "imported secret variables stay blank placeholders"
        );
        let nodes = rebuilt["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 3);
        assert_eq!(rebuilt["edges"].as_array().unwrap().len(), 2);
        assert_ne!(nodes[1]["id"], "n1");
        assert_eq!(nodes[1]["config"]["requestId"], request_id.as_str());
        assert_eq!(nodes[1]["config"].get("preProcess"), None);
        assert_eq!(nodes[1]["config"].get("postProcess"), None);
        assert_eq!(nodes[2]["config"].get("expression"), None);
        // The template reference points at the regenerated token, not the old
        // node id.
        let override_url = nodes[1]["config"]["override"]["url"]
            .as_str()
            .unwrap()
            .to_owned();
        let token = override_url
            .strip_prefix("http://api.test/{{ node.")
            .and_then(|rest| rest.strip_suffix(".id }}"))
            .unwrap_or_default();
        assert!(
            !token.is_empty() && token != "s1",
            "template reference remapped: {override_url}"
        );

        // Import #2 with an explicit confirmation list: exactly the confirmed
        // script survives, the rest is still cleared, and the name dedupes.
        let envelope: Value = serde_json::from_str(&envelope_text).unwrap();
        let import_body = json!({
            "file": envelope,
            "projectId": project_id,
            "confirmScripts": true,
            "confirmedScripts": ["0:1:preProcess"]
        })
        .to_string();
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/workflows/import",
            Some(&import_body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{payload}");
        let data = &payload["data"];
        let confirmed_id = data["imported"][0]["id"].as_str().unwrap().to_owned();
        assert_eq!(data["imported"][0]["name"], "结算链路 (导入 2)");
        let (status, payload) = flow_request(
            app.clone(),
            Method::GET,
            &format!("/api/workflows/{confirmed_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let nodes = payload["data"]["nodes"].as_array().unwrap();
        assert_eq!(nodes[1]["config"]["preProcess"], "return input");
        assert_eq!(nodes[1]["config"].get("postProcess"), None);
        assert_eq!(nodes[2]["config"].get("expression"), None);

        // Per-workflow shape issues skip the broken workflow and report the
        // reasons without failing the request.
        let envelope: Value = serde_json::from_str(&envelope_text).unwrap();
        let mut broken = envelope.clone();
        broken["workflows"] = json!([{"name": "坏流程", "nodes": "nope", "edges": []}]);
        let import_body = json!({"file": broken, "projectId": project_id}).to_string();
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/workflows/import",
            Some(&import_body),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let data = &payload["data"];
        assert_eq!(data["imported"].as_array().unwrap().len(), 0);
        let skipped = data["skipped"].as_array().unwrap();
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0]["index"], 0);
        assert_eq!(skipped[0]["name"], "坏流程");
        assert!(skipped[0]["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|issue| issue.as_str().unwrap().contains("nodes 必须是数组")));

        // Permission checks resolved the concrete transfer actions.
        let recorded_ids: Vec<&'static str> =
            recorded.lock().unwrap().iter().map(|item| item.id).collect();
        assert!(recorded_ids.contains(&"GET /api/workflows/export"));
        assert!(recorded_ids.contains(&"POST /api/workflows/import"));
    }

    #[tokio::test]
    async fn duplicate_authorization_headers_are_rejected_before_permission_check() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let (permissions, recorded) = recording_permissions(None);
        let app = router(MitmManager::new(runtime), permissions);

        let mut request = Request::builder()
            .uri("/api/config")
            .header("authorization", "Bearer first")
            .body(Body::empty())
            .unwrap();
        request
            .headers_mut()
            .append(AUTHORIZATION, "Bearer second".parse().unwrap());
        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(recorded.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn local_cors_preflight_allows_authorization_without_permission_check() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let (permissions, recorded) = recording_permissions(Some(PermissionDenied::forbidden(
            "permission_denied",
            "must not run for preflight",
        )));
        let app = secured_router(manager, permissions);

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/api/sessions/42")
                    .header("host", "127.0.0.1:18089")
                    .header("origin", "http://localhost:5173")
                    .header("access-control-request-method", "PUT")
                    .header(
                        "access-control-request-headers",
                        "authorization, content-type",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response.headers()[ACCESS_CONTROL_ALLOW_ORIGIN],
            "http://localhost:5173"
        );
        assert!(
            response.headers()[ACCESS_CONTROL_ALLOW_METHODS]
                .to_str()
                .unwrap()
                .contains("PUT")
        );
        assert_eq!(
            response.headers()[ACCESS_CONTROL_ALLOW_HEADERS],
            "Authorization, Content-Type"
        );
        assert!(recorded.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn body_response_negotiates_original_gzip_deflate_and_identity() {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(b"decoded body").unwrap();
        let compressed = encoder.finish().unwrap();
        let source = BodySource {
            stored_size: compressed.len() as u64,
            data: BodySourceData::Bytes(compressed),
            path: None,
            content_type: Some("text/plain; charset=utf-8".into()),
            content_encodings: vec!["gzip".into()],
        };

        let mut headers = HeaderMap::new();
        headers.insert("accept-encoding", "gzip".parse().unwrap());
        let response = body_response(source.clone(), &headers, Some(64))
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(
            response.headers()["content-length"],
            source.stored_size.to_string()
        );
        assert_eq!(
            response.headers()["x-proxycrab-body-size"],
            source.stored_size.to_string()
        );
        assert_eq!(response.headers()["content-encoding"], "gzip");
        assert_eq!(response.headers()["vary"], "Accept-Encoding");
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.len() as u64, source.stored_size);

        headers.insert("accept-encoding", "gzip;q=0, deflate;q=0".parse().unwrap());
        let response = body_response(source.clone(), &headers, None).await.unwrap();
        assert!(response.headers().get("content-length").is_none());
        assert!(response.headers().get("content-encoding").is_none());
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), b"decoded body");

        headers.insert(
            "accept-encoding",
            "gzip;q=0, deflate;q=0, identity;q=0".parse().unwrap(),
        );
        let error = body_response(source.clone(), &headers, None)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::NotAcceptableEncoding);
        let response = ApiError(error).into_response();
        assert_eq!(response.status(), axum::http::StatusCode::NOT_ACCEPTABLE);
        assert_eq!(response.headers()["vary"], "Accept-Encoding");

        // RFC 9110 §12.5.3：未显式列出的 identity 受 `*` 约束
        for header in ["*;q=0", "gzip;q=0, *;q=0", "identity;q=0, *;q=0"] {
            headers.insert("accept-encoding", header.parse().unwrap());
            let error = body_response(source.clone(), &headers, None)
                .await
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::NotAcceptableEncoding, "{header}");
        }

        // `*` 允许 fallback 转码：禁止 gzip 后应协商为 deflate
        headers.insert("accept-encoding", "gzip;q=0, *".parse().unwrap());
        let response = body_response(source.clone(), &headers, None).await.unwrap();
        assert_eq!(response.headers()["content-encoding"], "deflate");
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let mut decoder = ZlibDecoder::new(body.as_ref());
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded).unwrap();
        assert_eq!(decoded, b"decoded body");

        // 原始即为 identity 的 body 同样受 `*;q=0` 禁止
        let identity_source = BodySource {
            stored_size: 12,
            data: BodySourceData::Bytes(b"decoded body".to_vec()),
            path: None,
            content_type: Some("text/plain; charset=utf-8".into()),
            content_encodings: vec![],
        };
        headers.insert("accept-encoding", "*;q=0".parse().unwrap());
        let error = body_response(identity_source.clone(), &headers, None)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::NotAcceptableEncoding);
        headers.insert("accept-encoding", "*".parse().unwrap());
        let response = body_response(identity_source, &headers, None)
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), b"decoded body");

        headers.insert("accept-encoding", "deflate".parse().unwrap());
        let error = body_response(source.clone(), &headers, Some(4))
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::BodyTooLarge);
        assert_eq!(error.actual_size, Some(source.stored_size));
        assert_eq!(error.max_size, Some(4));
        let response = ApiError(error).into_response();
        assert_eq!(response.status(), axum::http::StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn body_response_prefers_original_then_fixed_fallback_order() {
        let original = b"negotiated body";
        let mut brotli = Vec::new();
        {
            let mut writer = brotli::CompressorWriter::new(&mut brotli, 4096, 5, 22);
            writer.write_all(original).unwrap();
        }
        let source = BodySource {
            stored_size: brotli.len() as u64,
            data: BodySourceData::Bytes(brotli.clone()),
            path: None,
            content_type: Some("text/plain".into()),
            content_encodings: vec!["br".into()],
        };

        for value in ["br", "*"] {
            let mut headers = HeaderMap::new();
            headers.insert("accept-encoding", value.parse().unwrap());
            let response = body_response(source.clone(), &headers, None).await.unwrap();
            assert_eq!(response.headers()["content-encoding"], "br", "{value}");
            assert_eq!(
                response.headers()["content-length"],
                brotli.len().to_string()
            );
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert_eq!(body.as_ref(), brotli.as_slice(), "{value}");
        }

        let mut headers = HeaderMap::new();
        headers.insert("accept-encoding", "*;q=1, br;q=0".parse().unwrap());
        let response = body_response(source.clone(), &headers, None).await.unwrap();
        assert_eq!(response.headers()["content-encoding"], "gzip");
        assert!(response.headers().get("content-length").is_none());
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let mut decoder = GzDecoder::new(body.as_ref());
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded).unwrap();
        assert_eq!(decoded, original);

        headers.insert(
            "accept-encoding",
            "gzip;q=0.1, deflate;q=1".parse().unwrap(),
        );
        let response = body_response(source.clone(), &headers, None).await.unwrap();
        assert_eq!(response.headers()["content-encoding"], "gzip");

        headers.insert("accept-encoding", "gzip;q=.5, deflate".parse().unwrap());
        let response = body_response(source.clone(), &headers, None).await.unwrap();
        assert_eq!(response.headers()["content-encoding"], "deflate");
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let mut decoder = ZlibDecoder::new(body.as_ref());
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded).unwrap();
        assert_eq!(decoded, original);

        headers.insert("accept-encoding", "".parse().unwrap());
        let response = body_response(source, &headers, None).await.unwrap();
        assert!(response.headers().get("content-encoding").is_none());
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), original);
    }

    #[tokio::test]
    async fn server_decompression_supports_brotli_deflate_zstd_and_stacks() {
        let original = b"all encodings";
        let mut brotli = Vec::new();
        {
            let mut writer = brotli::CompressorWriter::new(&mut brotli, 4096, 5, 22);
            writer.write_all(original).unwrap();
        }
        let mut deflate = ZlibEncoder::new(Vec::new(), Compression::default());
        deflate.write_all(original).unwrap();
        let deflate = deflate.finish().unwrap();
        let zstd = zstd::stream::encode_all(original.as_slice(), 1).unwrap();

        for (encoding, bytes) in [("br", brotli), ("deflate", deflate), ("zstd", zstd)] {
            let source = BodySource {
                stored_size: bytes.len() as u64,
                data: BodySourceData::Bytes(bytes),
                path: None,
                content_type: None,
                content_encodings: vec![encoding.into()],
            };
            let response = body_response(source, &HeaderMap::new(), None)
                .await
                .unwrap();
            assert!(response.headers().get("content-encoding").is_none());
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert_eq!(body.as_ref(), original, "{encoding}");
        }

        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        gzip.write_all(original).unwrap();
        let gzip = gzip.finish().unwrap();
        let mut stacked = Vec::new();
        {
            let mut writer = brotli::CompressorWriter::new(&mut stacked, 4096, 5, 22);
            writer.write_all(&gzip).unwrap();
        }
        let source = BodySource {
            stored_size: stacked.len() as u64,
            data: BodySourceData::Bytes(stacked),
            path: None,
            content_type: None,
            content_encodings: vec!["gzip".into(), "br".into()],
        };
        let mut headers = HeaderMap::new();
        headers.insert("accept-encoding", "gzip, br".parse().unwrap());
        let response = body_response(source.clone(), &headers, None).await.unwrap();
        assert_eq!(response.headers()["content-encoding"], "gzip, br");
        assert_eq!(
            response.headers()["content-length"],
            source.stored_size.to_string()
        );

        let response = body_response(source, &HeaderMap::new(), None)
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), original);
    }

    #[tokio::test]
    async fn log_body_route_returns_the_capture_file() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let store = CaptureStore::open(session.id, runtime.workspace().root()).unwrap();
        let request = RequestData {
            method: "POST".into(),
            uri: "https://example.com/body".into(),
            version: "HTTP/1.1".into(),
            headers: HeaderValues::from([(
                "content-type".into(),
                vec!["application/octet-stream".into()],
            )]),
            tags: Default::default(),
        };
        let id = store.begin("127.0.0.1", &request, "request").unwrap();
        store
            .save_body(id, BodySide::Request, b"captured bytes")
            .unwrap();
        let app = router(MitmManager::new(runtime), allow_all());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/logs/{id}/body?session_id={}&side=request&max_size=64",
                        session.id
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);

        assert_eq!(response.headers()["x-proxycrab-body-size"], "14");
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), b"captured bytes");
    }

    #[tokio::test]
    async fn interceptor_content_and_snapshot_have_dedicated_routes() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let store = CaptureStore::open(session.id, runtime.workspace().root()).unwrap();
        let request = RequestData {
            method: "GET".into(),
            uri: "https://example.com/snapshot".into(),
            version: "HTTP/1.1".into(),
            headers: HeaderValues::new(),
            tags: Default::default(),
        };
        let id = store.begin("127.0.0.1", &request, "request").unwrap();
        let source = "req.headers:set('x-debug', '1')";
        let run = InterceptorRun {
            origin: InterceptorExecutionOrigin::Saved,
            completed: true,
            phase: InterceptorKind::Request,
            position: 0,
            name: "debug".into(),
            script_hash: script_content_hash(source),
            content: source.into(),
            modifications: vec![
                Modification::Snapshot {
                    request: Some(RequestInterceptorSnapshot {
                        method: "GET".into(),
                        uri: "https://example.com/snapshot".into(),
                        version: "HTTP/1.1".into(),
                        headers: HeaderValues::new(),
                        body: BodySourceType::Original,
                    }),
                    response: None,
                },
                Modification::HeaderSet {
                    name: "x-debug".into(),
                    value: "1".into(),
                },
            ],
            error: None,
        };
        let execution_id = store.begin_interceptor_run(id, &run).unwrap();

        let app = router(MitmManager::new(runtime), allow_all());

        let detail = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/logs/{id}?session_id={}", session.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(detail.status(), axum::http::StatusCode::OK);
        let detail = to_bytes(detail.into_body(), usize::MAX).await.unwrap();
        let detail: Value = serde_json::from_slice(&detail).unwrap();
        let execution = &detail["data"]["request_interceptors"][0];
        assert_eq!(execution["has_snapshot"], Value::Bool(true));
        assert!(execution.get("content").is_none());
        assert_eq!(execution["modifications"].as_array().unwrap().len(), 1);
        assert_eq!(execution["modifications"][0]["kind"], "header_set");

        let content = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/logs/{id}/interceptors/{execution_id}/content?session_id={}",
                        session.id
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(content.status(), axum::http::StatusCode::OK);
        assert_eq!(
            content.headers()["x-proxycrab-script-sha256"],
            script_content_hash(source)
        );
        let content = to_bytes(content.into_body(), usize::MAX).await.unwrap();
        assert_eq!(content.as_ref(), source.as_bytes());

        let snapshot = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/logs/{id}/interceptors/{execution_id}/snapshot?session_id={}",
                        session.id
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(snapshot.status(), axum::http::StatusCode::OK);
        let snapshot = to_bytes(snapshot.into_body(), usize::MAX).await.unwrap();
        let snapshot: Value = serde_json::from_slice(&snapshot).unwrap();
        assert_eq!(snapshot["data"]["request"]["method"], "GET");
        assert_eq!(snapshot["data"]["request"]["body"]["type"], "original");
    }

    #[tokio::test]
    async fn client_errors_map_to_precise_status_codes() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime
            .create_session(NewSession {
                ..Default::default()
            })
            .unwrap();
        runtime
            .replace_active_session(Some(session.id))
            .await
            .unwrap();
        let store = CaptureStore::open(session.id, runtime.workspace().root()).unwrap();
        let request = RequestData {
            method: "GET".into(),
            uri: "https://example.com/".into(),
            version: "HTTP/1.1".into(),
            headers: HeaderValues::new(),
            tags: Default::default(),
        };
        let id = store.begin("127.0.0.1", &request, "request").unwrap();
        let app = router(MitmManager::new(runtime), allow_all());

        async fn error_of(response: axum::response::Response) -> (axum::http::StatusCode, Value) {
            let status = response.status();
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (status, serde_json::from_slice(&body).unwrap())
        }

        // Lua 语法错误 → 400 bad_request，且不泄漏内部 chunk 名
        for method in [Method::POST, Method::PUT] {
            let uri = if method == Method::POST {
                "/api/filter-scripts".to_string()
            } else {
                "/api/filter-scripts/bad".to_string()
            };
            let (status, body) = error_of(
                app.clone()
                    .oneshot(
                        Request::builder()
                            .method(method)
                            .uri(uri)
                            .header("content-type", "application/json")
                            .body(Body::from(r#"{"name":"bad","content":"return ("}"#))
                            .unwrap(),
                    )
                    .await
                    .unwrap(),
            )
            .await;
            assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
            assert_eq!(body["error"]["code"], "bad_request");
            let message = body["error"]["message"].as_str().unwrap();
            assert!(!message.contains("[string"), "message: {message}");
        }

        // 缺失的拦截器执行与快照 → 404
        let (status, body) = error_of(
            app.clone()
                .oneshot(
                    Request::builder()
                        .uri(format!(
                            "/api/logs/{id}/interceptors/99/content?session_id={}",
                            session.id
                        ))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "execution_not_found");

        let (status, body) = error_of(
            app.clone()
                .oneshot(
                    Request::builder()
                        .uri(format!(
                            "/api/logs/{id}/interceptors/99/snapshot?session_id={}",
                            session.id
                        ))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "snapshot_not_found");

        let (status, body) = error_of(
            app.clone()
                .oneshot(
                    Request::builder()
                        .uri(format!(
                            "/api/logs/{id}/body?session_id={}&side=request&execution_id=99",
                            session.id
                        ))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "snapshot_body_not_found");

        // 归档活动 Session → 409 session_in_use
        let (status, body) = error_of(
            app.clone()
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri(format!("/api/sessions/{}/archive", session.id))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert_eq!(body["error"]["code"], "session_in_use");
    }

    #[test]
    fn maps_http_mutations_to_their_ui_resources() {
        let cases = [
            (
                "PUT",
                "/api/active-session",
                None,
                vec![HttpApiResource::ActiveSession, HttpApiResource::Config],
                None,
            ),
            (
                "PUT",
                "/api/sessions/42",
                None,
                vec![HttpApiResource::Sessions],
                None,
            ),
            (
                "POST",
                "/api/sessions/42/archive",
                None,
                vec![HttpApiResource::Sessions, HttpApiResource::ArchivedSessions],
                None,
            ),
            (
                "POST",
                "/api/archived-sessions/42/restore",
                None,
                vec![HttpApiResource::Sessions, HttpApiResource::ArchivedSessions],
                None,
            ),
            (
                "DELETE",
                "/api/archived-sessions/42",
                None,
                vec![HttpApiResource::ArchivedSessions],
                None,
            ),
            (
                "PUT",
                "/api/sessions/42/filter",
                None,
                vec![HttpApiResource::SessionView],
                Some(42),
            ),
            (
                "PUT",
                "/api/session-view",
                Some("session_id=42"),
                vec![HttpApiResource::SessionView],
                Some(42),
            ),
            (
                "POST",
                "/api/session-shares",
                None,
                vec![HttpApiResource::SessionShare],
                None,
            ),
            (
                "DELETE",
                "/api/session-shares/42",
                None,
                vec![HttpApiResource::SessionShare],
                Some(42),
            ),
            (
                "PUT",
                "/api/column-scripts/host",
                None,
                vec![HttpApiResource::ColumnScripts, HttpApiResource::SessionView],
                None,
            ),
            (
                "DELETE",
                "/api/filter-scripts/errors",
                None,
                vec![HttpApiResource::FilterScripts, HttpApiResource::SessionView],
                None,
            ),
            (
                "PUT",
                "/api/routing-script-selection",
                None,
                vec![HttpApiResource::RoutingSelection],
                None,
            ),
            (
                "POST",
                "/api/interceptors",
                None,
                vec![
                    HttpApiResource::Interceptors,
                    HttpApiResource::SessionInterceptors,
                ],
                None,
            ),
            (
                "PUT",
                "/api/session-interceptors",
                Some("session_id=42"),
                vec![HttpApiResource::SessionInterceptors],
                Some(42),
            ),
            (
                "POST",
                "/api/bypass/delete",
                None,
                vec![HttpApiResource::Bypass],
                None,
            ),
            (
                "DELETE",
                "/api/system-logs",
                None,
                vec![HttpApiResource::SystemLogs],
                None,
            ),
            (
                "POST",
                "/api/request-library",
                None,
                vec![HttpApiResource::RequestLibrary],
                None,
            ),
            (
                "POST",
                "/api/request-library/from-capture",
                None,
                vec![HttpApiResource::RequestLibrary],
                None,
            ),
            (
                "PUT",
                "/api/request-library/req-abc",
                None,
                vec![HttpApiResource::RequestLibrary],
                None,
            ),
            (
                "DELETE",
                "/api/request-library/req-abc",
                None,
                vec![HttpApiResource::RequestLibrary],
                None,
            ),
        ];

        for (method, path, query, resources, session_id) in cases {
            let change =
                change_for_request(&method.parse().unwrap(), path, query).expect("mapped change");
            assert_eq!(change.resources, resources, "{method} {path}");
            assert_eq!(change.session_id, session_id, "{method} {path}");
        }
        assert!(change_for_request(&Method::GET, "/api/sessions", None).is_none());
        assert!(
            change_for_request(&Method::POST, "/api/filter-scripts/name/debug", None).is_none()
        );
        assert!(change_for_request(&Method::POST, "/api/logs/ids", None).is_none());
        assert!(change_for_request(&Method::POST, "/api/proxy/start", None).is_none());
    }

    #[tokio::test]
    async fn bridges_runtime_proxy_status_changes_to_ui_events() {
        let (status_sender, status_receiver) = tokio::sync::watch::channel(0_u64);
        let (changes, mut receiver) = tokio::sync::broadcast::channel(8);
        let cancellation = CancellationToken::new();
        let task = spawn_proxy_status_change_bridge(status_receiver, changes, cancellation.clone());

        status_sender.send(1).unwrap();
        let change = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(change.resources, vec![HttpApiResource::Proxy]);
        assert_eq!(change.session_id, None);

        cancellation.cancel();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn returns_the_standard_success_envelope() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let app = router(MitmManager::new(runtime), allow_all());

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/proxy/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::OK);
    }

    #[tokio::test]
    async fn agents_markdown_is_returned_as_raw_plain_text() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let app = router(MitmManager::new(runtime), allow_all());

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/agents.md")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(
            response.headers()["content-type"],
            "text/plain; charset=utf-8"
        );
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = std::str::from_utf8(&body).unwrap();
        assert!(text.starts_with("# ProxyCrab Agent 行为：充分使用能力"));
        assert!(!text.contains("\"ok\""));
    }

    #[tokio::test]
    async fn sessions_http_api_includes_nullable_active_session_and_replaces_old_get() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let app = router(MitmManager::new(runtime.clone()), allow_all());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            body["data"],
            json!({"sessions": [], "active_session_id": null})
        );

        let first = runtime
            .create_session(NewSession {
                name: Some("first".into()),
                ..Default::default()
            })
            .unwrap();
        let second = runtime
            .create_session(NewSession {
                name: Some("second".into()),
                ..Default::default()
            })
            .unwrap();

        // Creation leaves the active ID null; PUT still selects, switches, and clears it.
        for active_id in [None, Some(first.id), Some(second.id), None] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("PUT")
                        .uri("/api/active-session")
                        .header("content-type", "application/json")
                        .body(Body::from(json!({"session_id": active_id}).to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::OK);
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let body: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["data"], json!({"session_id": active_id}));

            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/api/sessions")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::OK);
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let body: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["data"]["active_session_id"], json!(active_id));
            assert_eq!(body["data"]["sessions"], json!([first, second]));
        }

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/active-session")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::METHOD_NOT_ALLOWED
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/active-session")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"session_id":18446744073709551615}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn create_session_accepts_initial_view_and_interceptors() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let app = router(MitmManager::new(runtime), allow_all());
        let create_body = r#"{
            "name": "preconfigured",
            "view": {
                "columns": [{"kind": "stage", "width": 91.0}],
                "filter": {"option": null, "input": "example"}
            },
            "interceptors": {
                "request": [{"name": "rewrite", "enabled": true}],
                "response": []
            }
        }"#;

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/sessions")
                    .header("content-type", "application/json")
                    .body(Body::from(create_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        let session_id = body["data"]["id"].as_u64().unwrap();
        assert_eq!(body["data"]["name"], "preconfigured");

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/session-view?session_id={session_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["data"]["columns"][0]["kind"], "stage");
        assert_eq!(body["data"]["filter"]["input"], "example");

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/session-interceptors?session_id={session_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["data"]["request"][0]["name"], "rewrite");

        // 创建不改变活跃会话。
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["data"]["active_session_id"], Value::Null);

        // 需要活跃会话时显式切换。
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/api/active-session")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(r#"{{"session_id":{session_id}}}"#)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["data"]["active_session_id"], session_id);
    }

    #[tokio::test]
    async fn session_archive_routes_archive_restore_and_delete() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let active = runtime
            .create_session(NewSession {
                name: Some("active".into()),
                ..Default::default()
            })
            .unwrap();
        runtime
            .replace_active_session(Some(active.id))
            .await
            .unwrap();
        let archived = runtime
            .create_session(NewSession {
                name: Some("archive-me".into()),
                description: Some("kept".into()),
                ..Default::default()
            })
            .unwrap();
        let app = router(MitmManager::new(runtime), allow_all());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/sessions/{}/archive", active.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/sessions/{}/archive", archived.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/session-view?session_id={}", archived.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/archived-sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["data"][0]["id"], archived.id);
        assert_eq!(body["data"][0]["description"], "kept");

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/archived-sessions/{}/restore", archived.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);

        app.clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/sessions/{}/archive", archived.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::DELETE)
                    .uri(format!("/api/archived-sessions/{}", archived.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
    }

    #[tokio::test]
    async fn http_and_trait_return_the_same_config_dto() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let expected = serde_json::to_value(manager.config().await.unwrap()).unwrap();
        let app = router(manager, allow_all());

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(body["data"], expected);
    }

    #[tokio::test]
    async fn invalid_json_uses_the_standard_error_envelope() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let app = router(MitmManager::new(runtime), allow_all());

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions")
                    .header("content-type", "application/json")
                    .body(Body::from("{"))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"]["code"], "bad_request");
    }

    #[tokio::test]
    async fn publishes_ui_resources_only_after_a_successful_http_write() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let (changes, mut receiver) = tokio::sync::broadcast::channel(8);
        let app = router_with_changes(MitmManager::new(runtime), allow_all(), changes);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"external"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let change = receiver.try_recv().unwrap();
        assert_eq!(
            change.resources,
            vec![HttpApiResource::Sessions, HttpApiResource::ActiveSession]
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions")
                    .header("content-type", "application/json")
                    .body(Body::from("{"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty
                | tokio::sync::broadcast::error::TryRecvError::Closed)
        ));
    }

    #[tokio::test]
    async fn log_id_reads_are_silent_and_filter_writes_publish_session_view() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime
            .create_session(NewSession {
                ..Default::default()
            })
            .unwrap();
        runtime
            .replace_active_session(Some(session.id))
            .await
            .unwrap();
        let (changes, mut receiver) = tokio::sync::broadcast::channel(8);
        let app = router_with_changes(MitmManager::new(runtime), allow_all(), changes);
        let filter_body = r#"{"option":{"kind":"column","column":{"kind":"uri"},"regex":false},"input":"example"}"#;
        let query_body = format!(r#"{{"filter":{filter_body}}}"#);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/logs/ids")
                    .header("content-type", "application/json")
                    .body(Body::from(query_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/sessions/{}/filter", session.id))
                    .header("content-type", "application/json")
                    .body(Body::from(filter_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let change = receiver.try_recv().unwrap();
        assert_eq!(change.resources, vec![HttpApiResource::SessionView]);
        assert_eq!(change.session_id, Some(session.id));
    }

    #[tokio::test]
    async fn share_summaries_are_read_only_and_permission_controlled() {
        use super::{
            CreateSessionRequest, InProcessLocalRequest, ManagerState, SessionShareService,
            router_with_changes_and_extra,
        };
        let directory = tempdir().unwrap();
        let runtime = ProxyCrab::open(directory.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager: ManagerState = MitmManager::new(runtime);
        let session = manager
            .create_session(CreateSessionRequest::default())
            .await
            .unwrap();
        let shares = SessionShareService::open(directory.path()).unwrap();
        shares.enable(&manager, session.id).await.unwrap();
        let (sender, mut receiver) = tokio::sync::broadcast::channel(16);
        let app = router_with_changes_and_extra(
            manager.clone(),
            allow_all(),
            shares,
            sender,
            axum::Router::new(),
        )
        .layer(axum::Extension(InProcessLocalRequest));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/session-shares")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(
            value,
            json!({"ok":true,"data":{"shares":[{"session_id":session.id,"persistent":false}]}})
        );
        assert!(receiver.try_recv().is_err());
        let (permissions, recorded) = recording_permissions(Some(PermissionDenied::forbidden(
            "permission_denied",
            "denied",
        )));
        let denied = router(manager, permissions);
        let response = denied
            .oneshot(
                Request::builder()
                    .uri("/api/session-shares")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(recorded.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn share_config_updates_are_authorized_and_notify() {
        use super::{
            CreateSessionRequest, InProcessLocalRequest, ManagerState, SessionShareService,
            router_with_changes_and_extra,
        };
        let directory = tempdir().unwrap();
        let runtime = ProxyCrab::open(directory.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager: ManagerState = MitmManager::new(runtime);
        let session = manager
            .create_session(CreateSessionRequest::default())
            .await
            .unwrap();
        let shares = SessionShareService::open(directory.path()).unwrap();
        let (sender, _) = tokio::sync::broadcast::channel(16);
        let mut receiver = sender.subscribe();
        let app = router_with_changes_and_extra(
            manager.clone(),
            allow_all(),
            shares.clone(),
            sender,
            axum::Router::new(),
        )
        .layer(axum::Extension(InProcessLocalRequest));
        let obsolete = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session-shares")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"session_id": session.id, "redaction_script": "mask"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(obsolete.status(), StatusCode::BAD_REQUEST);
        assert!(!shares.status(&manager, session.id).await.unwrap().enabled);
        assert!(receiver.try_recv().is_err());
        let enabled = shares.enable(&manager, session.id).await.unwrap();
        let path = "/api/session-shares".to_string();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(&path)
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"session_id":session.id,"session_share_config":{"persistent":true,"redaction_script":null}}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["data"]["persistent"], true);
        assert_eq!(body["data"]["token"].as_str(), enabled.token.as_deref());
        let change = receiver.try_recv().unwrap();
        assert_eq!(change.resources, vec![HttpApiResource::SessionShare]);
        assert_eq!(change.session_id, None);
        assert!(
            SessionShareService::open(directory.path())
                .unwrap()
                .status(&manager, session.id)
                .await
                .unwrap()
                .persistent
        );
        let (permissions, recorded) = recording_permissions(Some(PermissionDenied::forbidden(
            "permission_denied",
            "denied",
        )));
        let denied = router(manager.clone(), permissions);
        let response = denied
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"session_id":session.id,"session_share_config":{"persistent":false,"redaction_script":null}}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(!recorded.lock().unwrap().is_empty());
        assert!(
            shares
                .status(&manager, session.id)
                .await
                .unwrap()
                .persistent
        );
    }

    #[tokio::test]
    async fn invalid_path_uses_the_standard_error_envelope() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let app = router(MitmManager::new(runtime), allow_all());

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/logs/not-a-number")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"]["code"], "bad_request");
    }

    #[tokio::test]
    async fn exposes_only_the_new_log_and_session_view_routes() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime
            .create_session(NewSession {
                ..Default::default()
            })
            .unwrap();
        runtime
            .replace_active_session(Some(session.id))
            .await
            .unwrap();
        let app = router(MitmManager::new(runtime), allow_all());
        let filter_uri = format!("/api/sessions/{}/filter", session.id);

        for (method, uri, body) in [
            ("POST", "/api/logs/ids", r#"{}"#),
            (
                "POST",
                "/api/logs/ids",
                r#"{"filter":{"option":{"kind":"column","column":{"kind":"uri"},"regex":false},"input":""}}"#,
            ),
            ("POST", "/api/logs/views", r#"{"logs":[]}"#),
            ("GET", "/api/session-view", ""),
            ("GET", "/api/sessions", ""),
            ("GET", "/api/breakpoints", ""),
            ("PUT", "/api/session-view", r#"{"columns":[]}"#),
            ("PUT", filter_uri.as_str(), r#"{"option":null,"input":""}"#),
            ("GET", "/api/session-interceptors", ""),
            (
                "PUT",
                "/api/session-interceptors",
                r#"{"request":[],"response":[]}"#,
            ),
            (
                "POST",
                "/api/filter-scripts",
                r#"{"name":"example","content":"return true"}"#,
            ),
            ("GET", "/api/filter-scripts", ""),
            (
                "POST",
                "/api/routing-scripts",
                r#"{"name":"route","content":"return true"}"#,
            ),
            (
                "PUT",
                "/api/routing-script-selection",
                r#"{"name":"route"}"#,
            ),
            ("PUT", "/api/active-session", r#"{"session_id":null}"#),
            ("GET", "/api/bypass", ""),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(uri)
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::OK, "{uri}");
        }

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session-shares")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(r#"{{"session_id":{}}}"#, session.id)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/session-shares/{}", session.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["data"]["enabled"], true);
        assert!(
            body["data"]["token"]
                .as_str()
                .unwrap()
                .starts_with("pcrab_share_")
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/session-shares/{}", session.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);

        for (method, uri) in [
            ("GET", "/api/logs"),
            ("POST", "/api/logs/filter"),
            ("GET", "/api/sessions/1/logs"),
            ("GET", "/api/columns"),
            ("PUT", "/api/interceptors/order"),
            ("GET", "/api/filter-history"),
            ("POST", "/api/sessions/1/activate"),
            ("POST", "/api/interceptors/request/example/enable"),
            ("POST", "/api/interceptors/request/example/disable"),
            ("GET", "/api/workspace"),
            ("PUT", "/api/workspace"),
            ("PUT", "/api/config"),
            ("GET", "/api/ca"),
            ("POST", "/api/ca"),
            ("POST", "/api/logs/export"),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(uri)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(
                matches!(
                    response.status(),
                    axum::http::StatusCode::NOT_FOUND | axum::http::StatusCode::METHOD_NOT_ALLOWED
                ),
                "{uri}: {}",
                response.status()
            );
        }
    }

    #[tokio::test]
    async fn nested_script_names_round_trip_through_http() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let app = router(MitmManager::new(runtime), allow_all());
        for (collection, item, kind) in [
            ("column-scripts", "column-scripts", None),
            ("filter-scripts", "filter-scripts", None),
            ("routing-scripts", "routing-scripts", None),
            ("redaction-scripts", "redaction-scripts", None),
            ("interceptors", "interceptors/request", Some("request")),
            ("interceptors", "interceptors/response", Some("response")),
        ] {
            let mut payload =
                serde_json::json!({"name": "group/nested/example", "content": "return true"});
            if let Some(kind) = kind {
                payload["kind"] = kind.into();
            }
            let item_uri = format!("/api/{item}/group%2Fnested%2Fexample");
            for (method, uri, body) in [
                ("POST", format!("/api/{collection}"), payload.to_string()),
                ("GET", item_uri.clone(), String::new()),
                (
                    "PUT",
                    item_uri.clone(),
                    r#"{"content":"return false"}"#.into(),
                ),
                ("GET", item_uri.clone(), String::new()),
                ("DELETE", item_uri.clone(), String::new()),
            ] {
                let response = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method(method)
                            .uri(&uri)
                            .header("content-type", "application/json")
                            .body(Body::from(body))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                let status = response.status();
                let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                assert_eq!(
                    status,
                    axum::http::StatusCode::OK,
                    "{method} {uri}: {}",
                    String::from_utf8_lossy(&body)
                );
                if method == "GET" {
                    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(json["data"]["name"], "group/nested/example");
                }
            }
        }
    }

    #[tokio::test]
    async fn script_updates_reject_the_removed_rename_shape() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let app = router(MitmManager::new(runtime), allow_all());

        for uri in [
            "/api/column-scripts/old",
            "/api/filter-scripts/old",
            "/api/routing-scripts/old",
            "/api/interceptors/request/old",
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("PUT")
                        .uri(uri)
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"name":"new","content":"return true"}"#))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        }
    }

    #[tokio::test]
    async fn ca_download_is_public_fresh_and_independent_of_proxy_lifecycle() {
        let directory = tempdir().unwrap();
        let runtime = ProxyCrab::open(directory.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime.clone());
        let (permissions, recorded) = recording_permissions(Some(PermissionDenied::forbidden(
            "permission_denied",
            "blocked",
        )));
        let app = secured_router(manager.clone(), permissions);
        let request = |method: &str, path: &str| {
            Request::builder()
                .method(method)
                .uri(path)
                .header("host", "192.168.1.20:18089")
                .extension(ConnectInfo(
                    "192.168.1.30:50000".parse::<SocketAddr>().unwrap(),
                ))
                .body(Body::empty())
                .unwrap()
        };
        let original = runtime.certificate_pem();
        for round in 0..2 {
            let expected = if round == 0 {
                original.clone()
            } else {
                manager.regenerate_certificate().await.unwrap().pem
            };
            let response = app
                .clone()
                .oneshot(request("GET", "/ca.crt"))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()["content-type"],
                "application/x-x509-ca-cert"
            );
            assert_eq!(
                response.headers()["content-disposition"],
                "attachment; filename=\"proxycrab-ca.crt\""
            );
            assert_eq!(response.headers()["cache-control"], "no-store");
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert_eq!(body.as_ref(), expected.as_bytes());
            assert!(!String::from_utf8_lossy(&body).contains("PRIVATE KEY"));
            assert!(expected.contains("BEGIN CERTIFICATE"));
        }
        assert_ne!(runtime.certificate_pem(), original);
        assert!(recorded.lock().unwrap().is_empty());
        assert_eq!(
            app.clone()
                .oneshot(request("POST", "/ca.crt"))
                .await
                .unwrap()
                .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            runtime.proxy_status(),
            proxy_crab_mitm::model::ProxyStatus::Stopped
        );
        assert!(runtime.sessions().is_empty());
        assert!(runtime.bypass_entries(10, None).unwrap().is_empty());
    }

    #[tokio::test]
    async fn clash_subscription_management_and_download_lifecycle() {
        let directory = tempdir().unwrap();
        let runtime = ProxyCrab::open(directory.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime.clone());
        let (changes, mut receiver) = tokio::sync::broadcast::channel(128);
        let app = router_with_changes(manager.clone(), allow_all(), changes);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/clash-subscription")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["data"],
            serde_json::json!({"enabled": false})
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/clash-config")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        let default_yaml = payload["data"]["yaml"].as_str().unwrap().to_owned();
        assert_eq!(payload["data"]["default_yaml"], default_yaml);
        assert!(payload["data"].get("path").is_none());
        assert!(default_yaml.contains("{{server}}"));
        assert!(default_yaml.contains("{{port}}"));
        assert!(directory.path().join("clash").join("config.yaml").is_file());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/clash-subscription")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"server":"192.168.1.20"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            payload["data"],
            serde_json::json!({"enabled": true, "server": "192.168.1.20"})
        );
        assert!(payload["data"].get("token").is_none());
        assert_eq!(
            receiver.try_recv().unwrap().resources,
            vec![HttpApiResource::ClashSubscription]
        );
        assert!(matches!(
            manager.proxy_status().await.unwrap(),
            proxy_crab_mitm::model::ProxyStatus::Stopped
        ));

        // The LAN download is intentionally independent of management Bearer authentication
        // and no longer carries a download token.
        let remote = secured_router(manager.clone(), allow_all());
        let download = "/clash.yaml";
        let response = remote
            .clone()
            .oneshot(
                Request::builder()
                    .uri(download)
                    .header("host", "192.168.1.20:18089")
                    .extension(ConnectInfo(
                        "192.168.1.30:50000".parse::<SocketAddr>().unwrap(),
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["referrer-policy"], "no-referrer");
        assert_eq!(
            response.headers()["content-type"],
            "application/yaml; charset=utf-8"
        );
        let yaml = String::from_utf8(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(yaml.contains("server: \"192.168.1.20\""));
        assert!(yaml.contains(&format!("port: {}", runtime.config().proxy_port)));
        assert!(yaml.ends_with("  - MATCH,ProxyCrab\n"));

        // Legacy query parameters are ignored rather than rejected.
        for uri in [
            "/clash.yaml?token=legacy",
            "/clash.yaml?token=legacy&extra=1",
        ] {
            let response = remote
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }

        let mut config = manager.config().await.unwrap();
        config.proxy_port = 9876;
        manager.replace_config(config).await.unwrap();
        assert!(
            manager
                .clash_subscription_yaml()
                .await
                .unwrap()
                .contains("port: 9876")
        );

        let custom = default_yaml.replace(
            "rules:\n  - MATCH,ProxyCrab\n",
            "rules:\n  - DOMAIN-SUFFIX,example.com,ProxyCrab\n  - MATCH,DIRECT\n",
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/clash-config")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::json!({"yaml": custom}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["data"]["yaml"], custom);
        assert_eq!(
            receiver.try_recv().unwrap().resources,
            vec![HttpApiResource::ClashConfig]
        );

        let response = remote
            .clone()
            .oneshot(
                Request::builder()
                    .uri(download)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let yaml = String::from_utf8(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(yaml.contains("DOMAIN-SUFFIX,example.com,ProxyCrab"));
        assert!(yaml.ends_with("  - MATCH,DIRECT\n"));

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/clash-config")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({"yaml": "proxies: []\nrules: []\n"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(receiver.try_recv().is_err());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/clash-subscription")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["data"],
            serde_json::json!({"enabled": false})
        );
        assert_eq!(
            receiver.try_recv().unwrap().resources,
            vec![HttpApiResource::ClashSubscription]
        );

        let response = remote
            .clone()
            .oneshot(
                Request::builder()
                    .uri(download)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        // Disabling the subscription does not touch the persistent config file.
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/clash-config")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["data"]["yaml"],
            custom
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/clash-config")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["data"]["yaml"],
            default_yaml
        );
        assert_eq!(
            receiver.try_recv().unwrap().resources,
            vec![HttpApiResource::ClashConfig]
        );

        manager
            .enable_clash_subscription(crate::clash_subscription::EnableClashSubscriptionRequest {
                server: "192.0.2.10".into(),
            })
            .await
            .unwrap();
        let reopened = MitmManager::new(runtime);
        assert!(!reopened.clash_subscription().await.unwrap().enabled);
        assert_eq!(reopened.clash_config().await.unwrap().yaml, default_yaml);
    }

    #[tokio::test]
    async fn clash_subscription_management_requires_permission_and_remote_auth() {
        let directory = tempdir().unwrap();
        let runtime = ProxyCrab::open(directory.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let (permissions, recorded) = recording_permissions(Some(PermissionDenied::forbidden(
            "permission_denied",
            "blocked",
        )));
        let denied = router(manager.clone(), permissions);
        let remote = secured_router(manager.clone(), allow_all());
        for method in ["GET", "PUT", "DELETE"] {
            let request = || {
                Request::builder()
                    .method(method)
                    .uri("/api/clash-subscription")
                    .header("content-type", "application/json")
                    .header("host", "192.168.1.20:18089")
                    .extension(ConnectInfo(
                        "192.168.1.30:50000".parse::<SocketAddr>().unwrap(),
                    ))
                    .body(Body::from(r#"{"server":"192.168.1.20"}"#))
                    .unwrap()
            };
            assert_eq!(
                denied.clone().oneshot(request()).await.unwrap().status(),
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                remote.clone().oneshot(request()).await.unwrap().status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(recorded.lock().unwrap().len(), 3);
        assert!(!manager.clash_subscription().await.unwrap().enabled);
    }

    #[tokio::test]
    async fn clash_config_management_requires_permission_and_remote_auth() {
        let directory = tempdir().unwrap();
        let runtime = ProxyCrab::open(directory.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let (permissions, recorded) = recording_permissions(Some(PermissionDenied::forbidden(
            "permission_denied",
            "blocked",
        )));
        let denied = router(manager.clone(), permissions);
        let remote = secured_router(manager.clone(), allow_all());
        for method in ["GET", "PUT", "DELETE"] {
            let request = || {
                Request::builder()
                    .method(method)
                    .uri("/api/clash-config")
                    .header("content-type", "application/json")
                    .header("host", "192.168.1.20:18089")
                    .extension(ConnectInfo(
                        "192.168.1.30:50000".parse::<SocketAddr>().unwrap(),
                    ))
                    .body(Body::from(r#"{"yaml":"proxies: []\nrules: []\n"}"#))
                    .unwrap()
            };
            assert_eq!(
                denied.clone().oneshot(request()).await.unwrap().status(),
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                remote.clone().oneshot(request()).await.unwrap().status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(recorded.lock().unwrap().len(), 3);
        assert!(!directory.path().join("clash").join("config.yaml").exists());
    }

    #[tokio::test]
    async fn sharing_post_enforces_raw_key_policy_and_empty_string_contract() {
        struct ShareKeys;
        #[async_trait]
        impl PermissionManager for ShareKeys {
            async fn check_permission(&self, _: PermissionAction) -> Option<PermissionDenied> {
                None
            }
            async fn share_identity(
                &self,
                credential: &ManagementCredential,
            ) -> Result<Option<crate::permission::RedactionIdentity>, PermissionDenied>
            {
                let ManagementCredential::Bearer(key) = credential else {
                    return Ok(None);
                };
                Ok(Some(crate::permission::RedactionIdentity {
                    id: key.clone(),
                    redaction_script: match key.as_str() {
                        "bound" => Some("mask".into()),
                        "plain" => Some(String::new()),
                        _ => None,
                    },
                }))
            }
        }
        let directory = tempdir().unwrap();
        let manager: Arc<dyn ProxyCrabManager> = MitmManager::new(
            ProxyCrab::open(directory.path(), Arc::new(LogBuffer::default())).unwrap(),
        );
        let session = manager
            .create_session(crate::dto::CreateSessionRequest::default())
            .await
            .unwrap();
        manager
            .create_redaction_script(crate::dto::ScriptRequest {
                name: "mask".into(),
                content: "return true".into(),
            })
            .await
            .unwrap();
        let app = router(manager, Arc::new(ShareKeys));
        for key in ["bound", "unset", "plain"] {
            for value in [
                None,
                Some(serde_json::Value::Null),
                Some(json!("")),
                Some(json!("mask")),
            ] {
                let mut config = json!({"persistent":false});
                if let Some(value) = value.clone() {
                    config["redaction_script"] = value;
                }
                let request = Request::builder()
                    .method("POST")
                    .uri("/api/session-shares")
                    .header("authorization", format!("Bearer {key}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"session_id":session.id,"session_share_config":config}).to_string(),
                    ))
                    .unwrap();
                let response = app.clone().oneshot(request).await.unwrap();
                let allowed = key == "plain" || value.is_none();
                assert_eq!(
                    response.status(),
                    if allowed {
                        StatusCode::OK
                    } else {
                        StatusCode::FORBIDDEN
                    }
                );
                let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                if !allowed {
                    assert_eq!(body["error"]["code"], "share_redaction_forbidden");
                } else if key == "bound" {
                    assert_eq!(body["data"]["redaction_identity"], "bound");
                }
            }
        }
    }

    #[tokio::test]
    async fn removed_har_routes_are_not_available() {
        let directory = tempdir().unwrap();
        let runtime = ProxyCrab::open(directory.path(), Arc::new(LogBuffer::default())).unwrap();
        let app = router(MitmManager::new(runtime), allow_all());
        for (method, path) in [
            ("POST", "/api/session-har-shares"),
            ("GET", "/api/session-har-shares/1"),
            ("DELETE", "/api/session-har-shares/1"),
            ("PUT", "/api/session-har-shares/1/redaction"),
            ("PUT", "/api/session-shares/1/redaction"),
            ("GET", "/session.har?token=old"),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(matches!(
                response.status(),
                StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
            ));
        }
    }

    #[tokio::test]
    async fn removed_export_route_is_not_available() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let app = router(MitmManager::new(runtime), allow_all());

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/logs/export")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"format":"har"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            axum::http::StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[tokio::test]
    async fn remote_management_requests_require_authorization() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let app = secured_router(manager, allow_all());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/proxy/status")
                    .header("host", "attacker.example")
                    .header("origin", "https://attacker.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["error"]["code"], "remote_auth_required");
    }

    #[tokio::test]
    async fn remote_management_requests_with_authorization_reach_permission_check() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let (permissions, recorded) = recording_permissions(None);
        let app = secured_router(manager, permissions);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/proxy/status")
                    .header("host", "proxy.example:18089")
                    .header("origin", "https://proxy.example")
                    .header(AUTHORIZATION, "Bearer pcrab_ui_test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(
            response.headers()[ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://proxy.example"
        );
        assert_eq!(
            recorded.lock().unwrap()[0].bearer,
            Some("pcrab_ui_test".into())
        );
    }

    #[tokio::test]
    async fn remote_cors_preflight_requires_authorization_header() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let app = secured_router(manager, allow_all());

        let request = || {
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/api/sessions/42")
                .header("host", "proxy.example:18089")
                .header("origin", "https://proxy.example")
                .header("access-control-request-method", "PUT")
        };
        let response = app
            .clone()
            .oneshot(request().body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);

        let response = app
            .oneshot(
                request()
                    .header(
                        ACCESS_CONTROL_REQUEST_HEADERS,
                        "authorization, content-type",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::NO_CONTENT);
        assert_eq!(
            response.headers()[ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://proxy.example"
        );
    }

    #[tokio::test]
    async fn local_management_requests_remain_unauthenticated() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let app = secured_router(manager, allow_all());

        let mut request = Request::builder()
            .uri("/api/proxy/status")
            .header("host", "127.0.0.1:18089")
            .header("origin", "tauri://localhost")
            .body(Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((
                std::net::Ipv4Addr::LOCALHOST,
                40000,
            ))));
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(
            response.headers()["access-control-allow-origin"],
            "tauri://localhost"
        );
    }

    #[tokio::test]
    async fn non_api_routes_allow_remote_host_for_cli_ui_assets() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let app = secured_router(manager, allow_all());

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/")
                    .header("host", "proxy.example:18089")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
    }

    /* ---- MCP endpoint (plan Task 24 Step 1/2) ---- */

    #[tokio::test]
    async fn mcp_endpoint_requires_authorization_for_remote_callers() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let app = secured_router(manager, allow_all());

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/mcp")
                    .header("host", "proxy.example:18089")
                    .header("origin", "https://proxy.example")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#.to_vec(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let payload: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(payload["error"]["code"], "remote_auth_required");
    }

    #[tokio::test]
    async fn mcp_initialize_handshake_succeeds_for_local_identity() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let app = secured_router(manager, allow_all());

        let mut request = Request::builder()
            .method(Method::POST)
            .uri("/mcp")
            .header("host", "127.0.0.1:18089")
            .header("content-type", "application/json")
            .body(Body::from(
                br#"{"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}"#
                    .to_vec(),
            ))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((
                std::net::Ipv4Addr::LOCALHOST,
                40000,
            ))));
        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(payload["jsonrpc"], "2.0");
        assert_eq!(payload["id"], 7);
        assert_eq!(payload["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(payload["result"]["capabilities"]["tools"], json!({}));
        assert_eq!(payload["result"]["serverInfo"]["name"], "proxy-crab");
    }

    #[tokio::test]
    async fn mcp_tools_call_over_http_reports_tool_level_is_error() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime);
        let app = secured_router(manager, allow_all());

        let mut request = Request::builder()
            .method(Method::POST)
            .uri("/mcp")
            .header("host", "127.0.0.1:18089")
            .header("content-type", "application/json")
            .body(Body::from(
                br#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"nope","arguments":{}}}"#
                    .to_vec(),
            ))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((
                std::net::Ipv4Addr::LOCALHOST,
                40000,
            ))));
        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(payload["result"]["isError"], true);
        assert!(payload.get("error").is_none());
    }

    /// 只对映射路由（GET /api/flow/runs）拒绝的权限桩：端点档位
    /// ("POST /mcp") 放行，用于验证 tools/call 的逐次鉴权——若逐次
    /// 鉴权没有按映射路由 action 再查一次，调用将成功而不是被拒。
    struct DenyMappedRoute {
        denied: PermissionDenied,
    }

    #[async_trait]
    impl PermissionManager for DenyMappedRoute {
        async fn check_permission(&self, action: PermissionAction) -> Option<PermissionDenied> {
            (action.action.id == "GET /api/flow/runs").then(|| self.denied.clone())
        }
    }

    async fn mcp_tools_call_workflow_runs_list(app: axum::Router, id: i64) -> Value {
        let mut request = Request::builder()
            .method(Method::POST)
            .uri("/mcp")
            .header("host", "127.0.0.1:18089")
            .header("content-type", "application/json")
            .body(Body::from(
                format!(
                    r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{{"name":"workflow_runs_list","arguments":{{}}}}}}"#
                )
                .into_bytes(),
            ))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((
                std::net::Ipv4Addr::LOCALHOST,
                40000,
            ))));
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
    }

    #[tokio::test]
    async fn mcp_tools_call_workflow_runs_list_returns_curated_page() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let app = secured_router(MitmManager::new(runtime), allow_all());

        let payload = mcp_tools_call_workflow_runs_list(app, 3).await;

        assert_eq!(payload["jsonrpc"], "2.0");
        assert_eq!(payload["id"], 3);
        assert!(payload.get("error").is_none());
        assert!(payload["result"].get("isError").is_none());
        let text = payload["result"]["content"][0]["text"].as_str().unwrap();
        // 空库返回与 GET /api/flow/runs 一致的分页形态。
        assert_eq!(
            serde_json::from_str::<Value>(text).unwrap(),
            json!({ "runs": [], "total": 0 })
        );
    }

    /// `tools/list` 的 HTTP 级助手：POST /mcp JSON-RPC 信封并返回应答。
    async fn mcp_tools_list(app: axum::Router, id: i64) -> Value {
        let mut request = Request::builder()
            .method(Method::POST)
            .uri("/mcp")
            .header("host", "127.0.0.1:18089")
            .header("content-type", "application/json")
            .body(Body::from(
                format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/list","params":{{}}}}"#)
                    .into_bytes(),
            ))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((
                std::net::Ipv4Addr::LOCALHOST,
                40000,
            ))));
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
    }

    #[tokio::test]
    async fn mcp_tools_list_and_call_follow_the_exposure_tiers() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        // router()（测试用）把请求标记为本机进程内调用，/api/* 无需身份头。
        let app = router(MitmManager::new(runtime), allow_all());

        // 新工作区缺省档：读开 / 写关 / 执行关，读类工具在 tools/list。
        let payload = mcp_tools_list(app.clone(), 1).await;
        let tools = payload["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 5);
        assert!(
            tools
                .iter()
                .any(|tool| tool["name"] == "workflow_runs_list")
        );
        let (status, payload) = flow_request(app.clone(), Method::GET, "/api/mcp-tiers", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            payload["data"],
            json!({ "read": true, "write": false, "execute": false })
        );

        // 关闭读档：tools/list 不再出现该工具，tools/call 直呼工具名也硬拒。
        let body = json!({ "read": false, "write": false, "execute": true }).to_string();
        let (status, payload) =
            flow_request(app.clone(), Method::PUT, "/api/mcp-tiers", Some(&body)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            payload["data"],
            json!({ "read": false, "write": false, "execute": true })
        );
        let payload = mcp_tools_list(app.clone(), 2).await;
        assert_eq!(payload["result"]["tools"].as_array().unwrap().len(), 0);
        let payload = mcp_tools_call_workflow_runs_list(app.clone(), 3).await;
        assert_eq!(payload["result"]["isError"], true);
        assert!(
            payload["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("该工具类别的 MCP 档位已关闭")
        );

        // 持久化往返：管理器每请求重读工作区文件，保存后读取一致。
        let (status, payload) = flow_request(app, Method::GET, "/api/mcp-tiers", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            payload["data"],
            json!({ "read": false, "write": false, "execute": true })
        );
    }

    #[tokio::test]
    async fn mcp_tools_call_maps_approval_timeout_to_a_tool_level_error() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let app = secured_router(
            MitmManager::new(runtime),
            Arc::new(DenyMappedRoute {
                denied: PermissionDenied::forbidden(
                    "approval_timeout",
                    "management API approval timed out",
                ),
            }),
        );

        let payload = mcp_tools_call_workflow_runs_list(app, 4).await;

        assert!(payload.get("error").is_none());
        assert_eq!(payload["result"]["isError"], true);
        let text = payload["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("workflow_runs_list"));
        assert!(text.contains("approval timed out"));
    }

    #[tokio::test]
    async fn mcp_tools_call_maps_denial_to_a_tool_level_error() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let app = secured_router(
            MitmManager::new(runtime),
            Arc::new(DenyMappedRoute {
                denied: PermissionDenied::forbidden(
                    "permission_denied",
                    "management API action was denied",
                ),
            }),
        );

        let payload = mcp_tools_call_workflow_runs_list(app, 5).await;

        assert!(payload.get("error").is_none());
        assert_eq!(payload["result"]["isError"], true);
        let text = payload["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("permission denied"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn mcp_tools_call_cancels_the_underlying_tool_on_client_disconnect() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let mut config = runtime.config();
        config.api_port = unused_port();
        runtime.replace_config(config).await.unwrap();
        let handle = start_http_server(MitmManager::new(runtime), allow_all())
            .await
            .unwrap();
        crate::mcp::tools::slow_tool_stub::reset();
        let body =
            br#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"test_slow_tool","arguments":{}}}"#;
        let mut stream =
            std::net::TcpStream::connect(("127.0.0.1", handle.port)).unwrap();
        write!(
            stream,
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            handle.port,
            body.len()
        )
        .unwrap();
        stream.write_all(body).unwrap();
        stream.flush().unwrap();
        // 等长任务桩真正开始执行，再断开连接。
        for _ in 0..500 {
            if crate::mcp::tools::slow_tool_stub::started() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            crate::mcp::tools::slow_tool_stub::started(),
            "stub tool must start before the disconnect"
        );
        drop(stream);
        for _ in 0..500 {
            if crate::mcp::tools::slow_tool_stub::cancelled() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            crate::mcp::tools::slow_tool_stub::cancelled(),
            "tool execution must be cancelled once the client disconnects"
        );
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn uploads_assets_and_returns_metadata_or_raw_bytes() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let app = router(MitmManager::new(runtime), allow_all());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/assets/fixtures/example.json")
                    .header("content-type", "application/json; charset=utf-8")
                    .body(Body::from(r#"{"ok":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let payload: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(payload["data"]["id"], "fixtures/example.json");
        assert_eq!(payload["data"]["size"], 11);
        assert_eq!(
            payload["data"]["content_type"],
            "application/json; charset=utf-8"
        );
        assert_eq!(payload["data"]["sha256"].as_str().unwrap().len(), 64);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/assets/fixtures/example.json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let metadata: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(metadata["data"], payload["data"]);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/assets/fixtures/example.json?format=raw")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[axum::http::header::CONTENT_TYPE],
            "application/json; charset=utf-8"
        );
        assert_eq!(response.headers()[axum::http::header::CONTENT_LENGTH], "11");
        assert_eq!(
            to_bytes(response.into_body(), usize::MAX).await.unwrap(),
            r#"{"ok":true}"#
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/assets/fixtures/example.json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/assets/fixtures/example.json?format=decoded")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn replay_route_validates_input_and_reports_guards() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let app = router(MitmManager::new(runtime), allow_all());

        // 缺少 ?session= → 4xx
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/replay")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"method":"GET","url":"http://127.0.0.1:1/x"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_client_error());

        // 代理未运行 → 409 proxy_not_running
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/replay?session={}", session.id))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"method":"GET","url":"http://127.0.0.1:1/x"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "proxy_not_running");

        // 不支持的 charset → bad_request
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/replay?session={}", session.id))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"method":"GET","url":"http://127.0.0.1:1/x","body":{"type":"text","text":"a","charset":"gbk"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "bad_request");
    }

    #[tokio::test]
    async fn assets_route_lists_metadata() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let mut upload = runtime
            .begin_asset_upload("fixtures/a.json", "application/json".into())
            .await
            .unwrap();
        upload.write(b"{}").await.unwrap();
        upload.finish().await.unwrap();
        let app = router(MitmManager::new(runtime), allow_all());

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/assets")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["data"][0]["id"], "fixtures/a.json");
        assert_eq!(body["data"][0]["content_type"], "application/json");
    }

    /// Parse an `{ok: true, data: ...}` envelope, failing on error envelopes.
    async fn ok_data(response: axum::response::Response) -> Value {
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["ok"], true, "{value}");
        value["data"].clone()
    }

    async fn error_of(response: axum::response::Response) -> (StatusCode, String, Value) {
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["ok"], false, "{value}");
        (status, value["error"]["code"].as_str().unwrap().to_owned(), value)
    }

    fn har_json(method: &str, url: &str) -> Value {
        json!({"log": {"entries": [{"request": {"method": method, "url": url}}]}})
    }

    async fn request_library_json(
        app: &axum::Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> axum::response::Response {
        let mut builder = Request::builder().method(method).uri(uri);
        if body.is_some() {
            builder = builder.header("content-type", "application/json");
        }
        app.clone()
            .oneshot(
                builder
                    .body(Body::from(
                        body.map(|value| value.to_string()).unwrap_or_default(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn request_library_crud_shapes_filters_and_conflicts() {
        let directory = tempdir().unwrap();
        let runtime = ProxyCrab::open(directory.path(), Arc::new(LogBuffer::default())).unwrap();
        let app = router(MitmManager::new(runtime), allow_all());

        // Manual create: default naming, camelCase DTO, server-assigned fields.
        let har = json!({
            "log": {"entries": [{
                "request": {
                    "method": "POST",
                    "url": "https://api.example.com/v1/login?debug=1",
                    "headers": [{"name": "content-type", "value": "application/json"}],
                    "queryString": [{"name": "debug", "value": "1"}],
                    "postData": {"mimeType": "application/json", "text": "{\"user\":\"u\"}"}
                }
            }]}
        });
        let created = ok_data(
            request_library_json(&app, "POST", "/api/request-library", Some(json!({"har": har})))
                .await,
        )
        .await;
        assert!(created["id"].as_str().unwrap().starts_with("req-"));
        assert_eq!(created["name"], "POST api.example.com/v1/login");
        assert_eq!(created["source"], "manual");
        assert_eq!(created["tags"], json!([]));
        assert_eq!(created["origin"], "");
        assert!(created["createdAt"].as_u64().unwrap() > 0);
        assert_eq!(created["createdAt"], created["updatedAt"]);
        assert_eq!(created.get("created_at"), None);
        assert_eq!(
            created["har"]["log"]["entries"][0]["request"]["url"],
            "https://api.example.com/v1/login?debug=1"
        );
        assert_eq!(
            created["har"]["log"]["entries"][0]["request"]["queryString"][0]["name"],
            "debug"
        );
        assert_eq!(
            created["har"]["log"]["entries"][0]["request"]["postData"]["text"],
            "{\"user\":\"u\"}"
        );
        let id = created["id"].as_str().unwrap().to_owned();

        // Explicit name, tags and origin; the same default name dedups with a suffix.
        let tagged = ok_data(
            request_library_json(
                &app,
                "POST",
                "/api/request-library",
                Some(json!({
                    "har": har_json("GET", "https://api.example.com/v1/ping"),
                    "name": "checkout call",
                    "tags": ["auth", "slow"],
                    "origin": "https://app.example.com"
                })),
            )
            .await,
        )
        .await;
        assert_eq!(tagged["name"], "checkout call");
        assert_eq!(tagged["tags"], json!(["auth", "slow"]));
        assert_eq!(tagged["origin"], "https://app.example.com");
        let duplicate = ok_data(
            request_library_json(
                &app,
                "POST",
                "/api/request-library",
                Some(json!({"har": har})),
            )
            .await,
        )
        .await;
        assert_eq!(duplicate["name"], "POST api.example.com/v1/login 2");

        // Invalid input: unknown fields and empty snapshots are bad requests.
        let (status, code, _) = error_of(
            request_library_json(
                &app,
                "POST",
                "/api/request-library",
                Some(json!({"har": har, "source": "manual"})),
            )
            .await,
        )
        .await;
        assert_eq!((status, code.as_str()), (StatusCode::BAD_REQUEST, "bad_request"));
        let (status, code, _) = error_of(
            request_library_json(
                &app,
                "POST",
                "/api/request-library",
                Some(json!({"har": {"log": {"entries": []}}})),
            )
            .await,
        )
        .await;
        assert_eq!((status, code.as_str()), (StatusCode::BAD_REQUEST, "bad_request"));

        // List: total, keyword (case-insensitive over name and URL), tag AND
        // semantics, source filter.
        let listed = ok_data(request_library_json(&app, "GET", "/api/request-library", None).await)
            .await;
        assert_eq!(listed["total"], 3);
        assert_eq!(listed["entries"].as_array().unwrap().len(), 3);
        let listed = ok_data(
            request_library_json(&app, "GET", "/api/request-library?query=CHECKOUT", None).await,
        )
        .await;
        assert_eq!(listed["total"], 1);
        assert_eq!(listed["entries"][0]["name"], "checkout call");
        let listed = ok_data(
            request_library_json(&app, "GET", "/api/request-library?query=api.example.com", None)
                .await,
        )
        .await;
        assert_eq!(listed["total"], 3);
        let listed = ok_data(
            request_library_json(&app, "GET", "/api/request-library?tags=auth,missing", None).await,
        )
        .await;
        assert_eq!(listed["total"], 0);
        let listed = ok_data(
            request_library_json(&app, "GET", "/api/request-library?tags=auth", None).await,
        )
        .await;
        assert_eq!(listed["total"], 1);
        let listed = ok_data(
            request_library_json(&app, "GET", "/api/request-library?source=manual", None).await,
        )
        .await;
        assert_eq!(listed["total"], 3);
        let (status, code, _) = error_of(
            request_library_json(&app, "GET", "/api/request-library?source=bogus", None).await,
        )
        .await;
        assert_eq!((status, code.as_str()), (StatusCode::BAD_REQUEST, "bad_request"));

        // Pagination bounds: the hard caps reject, offset/limit slice.
        for limit in ["limit=0", "limit=1001"] {
            let (status, code, _) = error_of(
                request_library_json(&app, "GET", &format!("/api/request-library?{limit}"), None)
                    .await,
            )
            .await;
            assert_eq!(
                (status, code.as_str()),
                (StatusCode::BAD_REQUEST, "bad_request"),
                "{limit}"
            );
        }
        let listed = ok_data(
            request_library_json(&app, "GET", "/api/request-library?limit=2&offset=1", None).await,
        )
        .await;
        assert_eq!(listed["total"], 3);
        assert_eq!(listed["entries"].as_array().unwrap().len(), 2);

        // Read one; a missing id is a plain 404.
        let fetched =
            ok_data(request_library_json(&app, "GET", &format!("/api/request-library/{id}"), None)
                .await)
            .await;
        assert_eq!(fetched, created);
        let (status, code, _) = error_of(
            request_library_json(&app, "GET", "/api/request-library/req-missing", None).await,
        )
        .await;
        assert_eq!((status, code.as_str()), (StatusCode::NOT_FOUND, "not_found"));

        // Partial update: name/tags change, identity fields never do.
        let created_at = created["createdAt"].as_u64().unwrap();
        let updated = ok_data(
            request_library_json(
                &app,
                "PUT",
                &format!("/api/request-library/{id}"),
                Some(json!({"name": "renamed entry", "tags": ["x"]})),
            )
            .await,
        )
        .await;
        assert_eq!(updated["name"], "renamed entry");
        assert_eq!(updated["tags"], json!(["x"]));
        assert_eq!(updated["origin"], "");
        assert_eq!(updated["id"], created["id"]);
        assert_eq!(updated["source"], "manual");
        assert_eq!(updated["createdAt"], created_at);
        assert!(updated["updatedAt"].as_u64().unwrap() >= created_at);

        // Snapshot replacement, and a 404 for missing ids.
        let replaced = ok_data(
            request_library_json(
                &app,
                "PUT",
                &format!("/api/request-library/{id}"),
                Some(json!({"har": har_json("GET", "https://api.example.com/v2/other")})),
            )
            .await,
        )
        .await;
        assert_eq!(
            replaced["har"]["log"]["entries"][0]["request"]["url"],
            "https://api.example.com/v2/other"
        );
        let (status, code, _) = error_of(
            request_library_json(
                &app,
                "PUT",
                "/api/request-library/req-missing",
                Some(json!({"name": "ghost"})),
            )
            .await,
        )
        .await;
        assert_eq!((status, code.as_str()), (StatusCode::NOT_FOUND, "not_found"));

        // Delete removes the entry; deleting again is a typed 404.
        let deleted =
            ok_data(request_library_json(&app, "DELETE", &format!("/api/request-library/{id}"), None)
                .await)
            .await;
        assert_eq!(deleted, json!({}));
        let (status, code, _) = error_of(
            request_library_json(&app, "GET", &format!("/api/request-library/{id}"), None).await,
        )
        .await;
        assert_eq!((status, code.as_str()), (StatusCode::NOT_FOUND, "not_found"));
        let (status, code, _) = error_of(
            request_library_json(&app, "DELETE", &format!("/api/request-library/{id}"), None).await,
        )
        .await;
        assert_eq!((status, code.as_str()), (StatusCode::NOT_FOUND, "not_found"));
    }

    #[tokio::test]
    async fn request_library_list_pages_with_default_limit_and_caps() {
        let directory = tempdir().unwrap();
        let runtime = ProxyCrab::open(directory.path(), Arc::new(LogBuffer::default())).unwrap();
        let store = proxy_crab_mitm::flow::store::FlowStore::open(runtime.workspace().root())
            .unwrap();
        for index in 0..205 {
            let snapshot: proxy_crab_mitm::flow::request_library::HarSnapshot =
                serde_json::from_value(har_json(
                    "GET",
                    &format!("https://p.example.com/{index}"),
                ))
                .unwrap();
            store
                .add_request(
                    snapshot,
                    proxy_crab_mitm::flow::request_library::RequestSource::Manual,
                    None,
                    &[],
                    String::new(),
                )
                .unwrap();
        }
        let app = router(MitmManager::new(runtime), allow_all());

        // The default page size keeps one response bounded; total is unfiltered.
        let listed = ok_data(request_library_json(&app, "GET", "/api/request-library", None).await)
            .await;
        assert_eq!(listed["total"], 205);
        assert_eq!(listed["entries"].as_array().unwrap().len(), 200);

        // Offset pages are disjoint slices of the same sorted set.
        let first = ok_data(
            request_library_json(&app, "GET", "/api/request-library?limit=3", None).await,
        )
        .await;
        let second = ok_data(
            request_library_json(&app, "GET", "/api/request-library?limit=3&offset=3", None).await,
        )
        .await;
        let first_ids: Vec<&str> = first["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect();
        let second_ids: Vec<&str> = second["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect();
        assert_eq!(first_ids.len(), 3);
        assert_eq!(second_ids.len(), 3);
        for id in &first_ids {
            assert!(!second_ids.contains(id), "offset page overlaps");
        }
    }

    #[tokio::test]
    async fn request_library_ingests_captures_and_serves_bodies() {
        let directory = tempdir().unwrap();
        let runtime = ProxyCrab::open(directory.path(), Arc::new(LogBuffer::default())).unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let captures =
            CaptureStore::open(session.id, runtime.workspace().root()).unwrap();
        let mut headers = HeaderValues::new();
        headers.insert("content-type".into(), vec!["application/json".into()]);
        headers.insert(
            "referer".into(),
            vec!["https://app.example.com/checkout".into()],
        );
        let id = captures
            .begin(
                "127.0.0.1",
                &RequestData {
                    method: "POST".into(),
                    uri: "https://api.example.com/v1/login?debug=1".into(),
                    version: "HTTP/1.1".into(),
                    headers,
                    tags: Default::default(),
                },
                "request",
            )
            .unwrap();
        captures
            .save_body(id, BodySide::Request, br#"{"user":"u"}"#)
            .unwrap();
        captures
            .complete(
                id,
                &proxy_crab_mitm::model::ResponseData {
                    status: 200,
                    version: "HTTP/1.1".into(),
                    headers: HeaderValues::new(),
                },
                &BodySourceType::Original,
            )
            .unwrap();
        captures.save_body(id, BodySide::Response, b"{}").unwrap();

        // A large binary request body goes to a blob (over the 64 KiB inline limit).
        let large_id = captures
            .begin(
                "127.0.0.1",
                &RequestData {
                    method: "PUT".into(),
                    uri: "https://files.example.com/upload".into(),
                    version: "HTTP/1.1".into(),
                    headers: HeaderValues::new(),
                    tags: Default::default(),
                },
                "request",
            )
            .unwrap();
        let large_bytes = vec![7_u8; 64 * 1024 + 1];
        captures
            .save_body(large_id, BodySide::Request, &large_bytes)
            .unwrap();
        captures
            .complete(
                large_id,
                &proxy_crab_mitm::model::ResponseData {
                    status: 200,
                    version: "HTTP/1.1".into(),
                    headers: HeaderValues::new(),
                },
                &BodySourceType::Original,
            )
            .unwrap();
        let app = router(MitmManager::new(runtime.clone()), allow_all());

        // Ingest from the live session: HAR snapshot, origin and naming.
        let entry = ok_data(
            request_library_json(
                &app,
                "POST",
                "/api/request-library/from-capture",
                Some(json!({
                    "session_id": session.id,
                    "capture_id": id,
                    "tags": ["auth"]
                })),
            )
            .await,
        )
        .await;
        assert_eq!(entry["source"], "capture");
        assert_eq!(entry["name"], "POST api.example.com/v1/login");
        assert_eq!(entry["origin"], "https://app.example.com");
        assert_eq!(entry["tags"], json!(["auth"]));
        assert_eq!(
            entry["har"]["log"]["entries"][0]["request"]["postData"]["text"],
            "{\"user\":\"u\"}"
        );
        assert_eq!(
            entry["har"]["log"]["entries"][0]["response"]["status"],
            200
        );
        assert_eq!(
            entry["har"]["log"]["entries"][0]["response"]["content"]["size"],
            2
        );
        let entry_id = entry["id"].as_str().unwrap().to_owned();

        // Explicit names dedup like ingestion defaults.
        for expected in ["login", "login 2"] {
            let named = ok_data(
                request_library_json(
                    &app,
                    "POST",
                    "/api/request-library/from-capture",
                    Some(json!({
                        "session_id": session.id,
                        "capture_id": id,
                        "name": "login"
                    })),
                )
                .await,
            )
            .await;
            assert_eq!(named["name"], expected);
        }

        // Missing capture and missing session produce typed errors.
        let (status, code, _) = error_of(
            request_library_json(
                &app,
                "POST",
                "/api/request-library/from-capture",
                Some(json!({"session_id": session.id, "capture_id": 999})),
            )
            .await,
        )
        .await;
        assert_eq!((status, code.as_str()), (StatusCode::NOT_FOUND, "not_found"));
        let (status, code, _) = error_of(
            request_library_json(
                &app,
                "POST",
                "/api/request-library/from-capture",
                Some(json!({"session_id": 424242, "capture_id": id})),
            )
            .await,
        )
        .await;
        assert_eq!((status, code.as_str()), (StatusCode::NOT_FOUND, "not_found"));
        let (status, code, _) = error_of(
            request_library_json(
                &app,
                "POST",
                "/api/request-library/from-capture",
                Some(json!({"capture_id": id})),
            )
            .await,
        )
        .await;
        assert_eq!((status, code.as_str()), (StatusCode::CONFLICT, "conflict"));

        // Inline body: raw bytes with the HAR mimeType.
        let response = request_library_json(
            &app,
            "GET",
            &format!("/api/request-library/{entry_id}/body"),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok()),
            Some("application/json")
        );
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&bytes[..], br#"{"user":"u"}"#);

        // A bodyless manual entry reports body_not_found.
        let bare = ok_data(
            request_library_json(
                &app,
                "POST",
                "/api/request-library",
                Some(json!({"har": har_json("GET", "https://a.example.com/none")})),
            )
            .await,
        )
        .await;
        let (status, code, _) = error_of(
            request_library_json(
                &app,
                "GET",
                &format!("/api/request-library/{}/body", bare["id"].as_str().unwrap()),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(
            (status, code.as_str()),
            (StatusCode::NOT_FOUND, "body_not_found")
        );

        // Blob body: full read and max_size enforcement.
        let large = ok_data(
            request_library_json(
                &app,
                "POST",
                "/api/request-library/from-capture",
                Some(json!({"session_id": session.id, "capture_id": large_id})),
            )
            .await,
        )
        .await;
        assert!(
            large.get("bodyRef").is_some(),
            "over-limit bodies are blob-referenced"
        );
        let large_id_path = format!("/api/request-library/{}/body", large["id"].as_str().unwrap());
        let response = request_library_json(&app, "GET", &large_id_path, None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&bytes[..], &large_bytes[..]);
        let (status, code, payload) = error_of(
            request_library_json(&app, "GET", &format!("{large_id_path}?max_size=1024"), None).await,
        )
        .await;
        assert_eq!((status, code.as_str()), (StatusCode::PAYLOAD_TOO_LARGE, "body_too_large"));
        assert_eq!(payload["error"]["max_size"], 1024);
        let (status, code, _) = error_of(
            request_library_json(&app, "GET", &format!("{large_id_path}?max_size=0"), None).await,
        )
        .await;
        assert_eq!((status, code.as_str()), (StatusCode::BAD_REQUEST, "bad_request"));

        // Archiving the Session keeps both ingestion and the library intact.
        drop(captures);
        runtime.archive_session(session.id).await.unwrap();
        let archived = ok_data(
            request_library_json(
                &app,
                "POST",
                "/api/request-library/from-capture",
                Some(json!({"session_id": session.id, "capture_id": id})),
            )
            .await,
        )
        .await;
        assert_eq!(archived["name"], "POST api.example.com/v1/login 2");
        let response = request_library_json(&app, "GET", &large_id_path, None).await;
        assert_eq!(response.status(), StatusCode::OK);
    }
    fn unused_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    async fn settle_run(app: &axum::Router, run_id: &str) -> Value {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            assert!(
                std::time::Instant::now() < deadline,
                "run {run_id} did not settle in time"
            );
            let (status, payload) =
                flow_request(app.clone(), Method::GET, &format!("/api/flow/runs/{run_id}"), None)
                    .await;
            assert_eq!(status, StatusCode::OK);
            if payload["data"]["status"] != "running" {
                return payload;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    #[tokio::test]
    async fn bridges_flow_run_events_to_ui_events() {
        let (events, event_receiver) = tokio::sync::broadcast::channel(8);
        let (changes, mut receiver) = tokio::sync::broadcast::channel(8);
        let cancellation = CancellationToken::new();
        let task = spawn_flow_run_change_bridge(event_receiver, changes, cancellation.clone());

        events
            .send(FlowRunEvent {
                run_id: "run-1".into(),
                kind: "node".into(),
                node_id: Some("n1".into()),
            })
            .unwrap();
        let change = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(change.resources, vec![HttpApiResource::FlowRuns]);
        assert_eq!(change.session_id, None);

        cancellation.cancel();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn workflow_run_trigger_reports_precondition_failures_without_creating_runs() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = MitmManager::new(runtime.clone());
        let (permissions, recorded) = recording_permissions(None);
        let app = router(manager, permissions);

        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/flow-projects",
            Some(r#"{"name":"demo"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let project_id = payload["data"]["id"].as_str().unwrap().to_owned();
        // 合法图：start → delay（不发起真实出站请求）。
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/workflows",
            Some(&format!(
                r#"{{"projectId":"{project_id}","name":"valid","nodes":[{{"id":"s","type":"start","position":{{"x":0,"y":0}},"config":{{}}}},{{"id":"n1","type":"delay","position":{{"x":1,"y":0}},"config":{{"durationMs":200}}}}],"edges":[{{"id":"e1","source":"s","target":"n1"}}]}}"#
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let workflow_id = payload["data"]["id"].as_str().unwrap().to_owned();
        // 无效图：缺 start 节点。
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/workflows",
            Some(&format!(
                r#"{{"projectId":"{project_id}","name":"invalid","nodes":[{{"id":"n1","type":"delay","position":{{"x":1,"y":0}},"config":{{}}}}],"edges":[]}}"#
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let invalid_workflow_id = payload["data"]["id"].as_str().unwrap().to_owned();

        // 代理未运行：未知工作流 404（输入读取先于代理检查）；无效图 409
        // proxy_not_running（代理检查先于图校验）。都不建单。
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/flow/runs",
            Some(r#"{"workflowId":"wf-ghost"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(payload["error"]["code"], "not_found");
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/flow/runs",
            Some(&format!(r#"{{"workflowId":"{invalid_workflow_id}"}}"#)),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(payload["error"]["code"], "proxy_not_running");
        let (status, payload) = flow_request(app.clone(), Method::GET, "/api/flow/runs", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["data"]["total"], 0, "no run row is created on guards");

        // 代理运行后：无活动 Session → 409 conflict（会话检查先于图校验）。
        let mut config = runtime.config();
        config.proxy_host = "127.0.0.1".into();
        config.proxy_port = unused_port();
        runtime.replace_config(config).await.unwrap();
        runtime.start_proxy().await.unwrap();
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/flow/runs",
            Some(&format!(r#"{{"workflowId":"{invalid_workflow_id}"}}"#)),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(payload["error"]["code"], "conflict");

        // 有 Session 后：无效图 422；指定不存在的 Session 404。
        let session = runtime.create_session(NewSession::default()).unwrap();
        runtime
            .replace_active_session(Some(session.id))
            .await
            .unwrap();
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/flow/runs",
            Some(&format!(r#"{{"workflowId":"{invalid_workflow_id}"}}"#)),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(payload["error"]["code"], "workflow_graph_invalid");
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/flow/runs",
            Some(&format!(r#"{{"workflowId":"{workflow_id}","sessionId":999999}}"#)),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(payload["error"]["code"], "not_found");

        // 成功触发：run 记录返回 `running` 且携带图快照。
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/flow/runs",
            Some(&format!(
                r#"{{"workflowId":"{workflow_id}","sessionId":{}}}"#,
                session.id
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let run = &payload["data"];
        assert!(run["id"].as_str().unwrap().starts_with("run-"));
        assert_eq!(run["status"], "running");
        assert_eq!(run["trigger"], "manual");
        assert_eq!(run["sessionId"], session.id);
        assert!(run["graphSnapshot"].is_object());
        let run_id = run["id"].as_str().unwrap().to_owned();
        let payload = settle_run(&app, &run_id).await;
        assert_eq!(payload["data"]["status"], "success");

        // 权限检查按具体路由模板解析。
        let recorded_ids: Vec<&'static str> =
            recorded.lock().unwrap().iter().map(|item| item.id).collect();
        assert!(recorded_ids.contains(&"POST /api/flow/runs"));
        assert!(recorded_ids.contains(&"GET /api/flow/runs"));
    }

    #[tokio::test]
    async fn workflow_run_detail_list_pagination_and_cancel_settle_cancelled() {
        let app_data = tempdir().unwrap();
        let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
        let mut config = runtime.config();
        config.proxy_host = "127.0.0.1".into();
        config.proxy_port = unused_port();
        runtime.replace_config(config).await.unwrap();
        runtime.start_proxy().await.unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let app = router(MitmManager::new(runtime), allow_all());

        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/flow-projects",
            Some(r#"{"name":"demo"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let project_id = payload["data"]["id"].as_str().unwrap().to_owned();
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/workflows",
            Some(&format!(
                r#"{{"projectId":"{project_id}","name":"flow","nodes":[{{"id":"s","type":"start","position":{{"x":0,"y":0}},"config":{{}}}},{{"id":"n1","type":"delay","position":{{"x":1,"y":0}},"config":{{"durationMs":200}}}}],"edges":[{{"id":"e1","source":"s","target":"n1"}}]}}"#
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let workflow_id = payload["data"]["id"].as_str().unwrap().to_owned();

        // 详情形状：flatten 的 run 主记录 + nodeRuns 节点 checkpoint 列表。
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/flow/runs",
            Some(&format!(
                r#"{{"workflowId":"{workflow_id}","sessionId":{}}}"#,
                session.id
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let run_id = payload["data"]["id"].as_str().unwrap().to_owned();
        let payload = settle_run(&app, &run_id).await;
        assert_eq!(payload["data"]["status"], "success");
        assert_eq!(payload["data"]["id"], run_id.as_str());
        assert_eq!(payload["data"]["workflowId"], workflow_id.as_str());
        assert!(payload["data"]["finishedAt"].as_u64().is_some());
        let node_runs = payload["data"]["nodeRuns"].as_array().unwrap();
        assert!(
            node_runs
                .iter()
                .any(|node| node["nodeId"] == "n1" && node["status"] == "success"),
            "delay node settles with a success checkpoint: {node_runs:?}"
        );

        // 列表分页与筛选。
        let (status, payload) = flow_request(
            app.clone(),
            Method::GET,
            &format!("/api/flow/runs?workflowId={workflow_id}&limit=10&offset=0"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["data"]["total"], 1);
        assert_eq!(payload["data"]["runs"][0]["id"], run_id.as_str());
        let (status, payload) = flow_request(
            app.clone(),
            Method::GET,
            &format!("/api/flow/runs?workflowId={workflow_id}&status=success"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["data"]["total"], 1);
        let (status, payload) = flow_request(
            app.clone(),
            Method::GET,
            &format!("/api/flow/runs?workflowId={workflow_id}&status=failed"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["data"]["total"], 0);
        let (status, payload) = flow_request(
            app.clone(),
            Method::GET,
            "/api/flow/runs?limit=1&offset=0",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["data"]["runs"].as_array().unwrap().len(), 1);

        // 未知运行：详情与取消都是 404。
        let (status, _) = flow_request(
            app.clone(),
            Method::GET,
            "/api/flow/runs/run-ghost",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = flow_request(
            app.clone(),
            Method::POST,
            "/api/flow/runs/run-ghost/cancel",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // 取消：长运行在时限内归 `cancelled`（取消优先于失败），二次取消 404。
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/workflows",
            Some(&format!(
                r#"{{"projectId":"{project_id}","name":"long","nodes":[{{"id":"s","type":"start","position":{{"x":0,"y":0}},"config":{{}}}},{{"id":"n1","type":"delay","position":{{"x":1,"y":0}},"config":{{"durationMs":30000}}}}],"edges":[{{"id":"e1","source":"s","target":"n1"}}]}}"#
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let long_workflow_id = payload["data"]["id"].as_str().unwrap().to_owned();
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            "/api/flow/runs",
            Some(&format!(
                r#"{{"workflowId":"{long_workflow_id}","sessionId":{}}}"#,
                session.id
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let run_id = payload["data"]["id"].as_str().unwrap().to_owned();
        // 等首个节点 checkpoint 落库，保证取消命中运行中的编排。
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (status, payload) = flow_request(
            app.clone(),
            Method::POST,
            &format!("/api/flow/runs/{run_id}/cancel"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["data"], json!({}));
        let payload = settle_run(&app, &run_id).await;
        assert_eq!(payload["data"]["status"], "cancelled");
        let (status, _) = flow_request(
            app.clone(),
            Method::POST,
            &format!("/api/flow/runs/{run_id}/cancel"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

}

