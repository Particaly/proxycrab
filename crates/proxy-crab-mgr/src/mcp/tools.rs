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

use std::{
    sync::{Arc, LazyLock},
    time::Duration,
};

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use crate::{
    dto::{ErrorCode, FlowRunListQuery, ManagerError},
    manager::ProxyCrabManager,
    permission::{
        ManagementCredential, PermissionAction, PermissionDenied, PermissionDeniedStatus,
        PermissionManager, find_api_action,
    },
};

use super::protocol::{self, RpcRequest};

/// 单次工具调用（授权之后的执行段）超时上限；与既有审批窗 30s 同量级。
pub const TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(30);
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

/// 单个策展工具的静态描述：名称、说明、映射路由与入参契约。
pub struct ToolDescriptor {
    pub name: &'static str,
    pub description: &'static str,
    /// 映射的管理路由 `(METHOD, PATH)`；鉴权档位由 permission 层对该
    /// 路由登记的 action 决定，未登记路由的工具不得上架。
    pub route: (&'static str, &'static str),
    /// 入参契约：`(参数名, JSON Schema 类型, 说明)`，与映射路由的
    /// 查询/请求体字段保持一致。
    pub params: &'static [(&'static str, &'static str, &'static str)],
}

/// 工具注册表：仅登记已实现且映射路由已有 action 档位的工具。
const REGISTRY: &[ToolDescriptor] = &[ToolDescriptor {
    name: "workflow_runs_list",
    description: "List workflow runs, mirroring GET /api/flow/runs.",
    route: ("GET", "/api/flow/runs"),
    params: &[
        ("workflowId", "string", "Filter by workflow id."),
        ("status", "string", "Filter by run status."),
        ("limit", "integer", "Max entries to return."),
        ("offset", "integer", "Entries to skip."),
    ],
}];

/// `tools/list` 展示的策展清单（Task 25 扩充工具面）。
pub fn list() -> &'static [ToolDescriptor] {
    REGISTRY
}

/// `tools/list` 应答的策展工具清单（含各工具的 inputSchema）。
pub fn list_envelope() -> Value {
    json!({
        "tools": REGISTRY
            .iter()
            .map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": input_schema(tool),
            }))
            .collect::<Vec<_>>()
    })
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
/// （身份已由 `authorize_request` 依据既有体系解析完成）与在途许可闸。
#[derive(Clone)]
pub struct ToolCallContext {
    pub manager: Arc<dyn ProxyCrabManager>,
    pub permissions: Arc<dyn PermissionManager>,
    pub credential: ManagementCredential,
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
            body_preview: Some(arguments.to_string()),
            body_preview_truncated: false,
        })
        .await;
    if let Some(denied) = denied {
        return tool_error(&request.id, name, &denial_reason(&denied));
    }
    // 执行段带超时；超时即丢弃执行 future（底层工作随之取消）。整个
    // 调用内联 await 于 HTTP 处理器，客户端断开同样以丢弃取消底层。
    match tokio::time::timeout(timeout, execute(tool.name, &arguments, &context.manager)).await {
        Ok(Ok(value)) => protocol::success(
            &request.id,
            json!({ "content": [{ "type": "text", "text": value.to_string() }] }),
        ),
        Ok(Err(error)) => tool_error(&request.id, name, &manager_error_reason(&error)),
        Err(_) => tool_error(
            &request.id,
            name,
            &format!("execution timed out after {}s", timeout.as_secs()),
        ),
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

/// 管理端错误的统一映射：只有入参校验（bad_request，manager 侧策展
/// 校验文案）原样透出；其余类别只暴露稳定错误码，绝不透传内部错误
/// 详情（可能含文件路径、连接串等）。
fn manager_error_reason(error: &ManagerError) -> String {
    match error.code {
        ErrorCode::BadRequest => format!("invalid arguments: {}", error.message),
        _ => format!("execution failed ({})", error.code.as_str()),
    }
}

/// 工具体执行：按注册表名分发。执行错误统一为 `ManagerError`，文案
/// 出口收敛在 `manager_error_reason`。
async fn execute(
    name: &str,
    arguments: &Value,
    manager: &Arc<dyn ProxyCrabManager>,
) -> Result<Value, ManagerError> {
    match name {
        "workflow_runs_list" => {
            let query: FlowRunListQuery = parse_arguments(arguments)?;
            let page = manager.workflow_runs(query).await?;
            serde_json::to_value(page)
                .map_err(|_| ManagerError::internal("workflow run page serialization failed"))
        }
        #[cfg(test)]
        "test_slow_tool" => Ok(slow_tool_stub::run().await),
        // lookup 已把执行器与注册表对齐；此分支不可达。
        _ => Err(ManagerError::internal("tool has no executor")),
    }
}

/// 反序列化工具入参为映射路由的查询/请求体类型；失败归入 bad_request。
fn parse_arguments<T: DeserializeOwned>(arguments: &Value) -> Result<T, ManagerError> {
    serde_json::from_value(arguments.clone())
        .map_err(|error| ManagerError::bad_request(format!("arguments do not match the tool schema: {error}")))
}

/// 测试专用长任务桩：验证超时与断连取消的可观察信号（STARTED 置位后
/// 长眠，被取消时经 Drop guard 置位 CANCELLED）。
#[cfg(test)]
const TEST_SLOW_TOOL: ToolDescriptor = ToolDescriptor {
    name: "test_slow_tool",
    description: "test-only long task stub",
    route: ("GET", "/api/flow/runs"),
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
    use crate::manager::MitmManager;
    use async_trait::async_trait;
    use proxy_crab_mitm::log_buffer::LogBuffer;
    use proxy_crab_mitm::ProxyCrab;
    use tempfile::tempdir;

    struct AllowTools;

    #[async_trait]
    impl PermissionManager for AllowTools {
        async fn check_permission(&self, _: PermissionAction) -> Option<PermissionDenied> {
            None
        }
    }

    fn test_context(manager: Arc<dyn ProxyCrabManager>, permits: Arc<Semaphore>) -> ToolCallContext {
        ToolCallContext {
            manager,
            permissions: Arc::new(AllowTools),
            credential: ManagementCredential::LocalLoopback,
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
        let envelope = list_envelope();
        let tools = envelope["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "workflow_runs_list");
        assert_eq!(tools[0]["inputSchema"]["type"], "object");
        assert_eq!(
            tools[0]["inputSchema"]["properties"]["limit"]["type"],
            "integer"
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
        let response = call(
            &slow_tool_request(3),
            &context,
            Duration::from_millis(50),
        )
        .await;

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
                tokio::spawn(async move { call(&slow_tool_request(id), &context, TOOL_CALL_TIMEOUT).await })
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
}
