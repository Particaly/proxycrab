//! MCP 策展工具注册表与调用机制（plan Task 24 Step 3）。
//!
//! 每个策展工具声明其等价的管理 API 路由；`tools/call` 逐次鉴权：MCP
//! 端点本身的档位已由 `authorize_request` 中间件按 "POST /mcp" 检查过，
//! 这里再按「映射路由的 action」对同一调用者做一次 `check_permission`，
//! 两次检查任一拒绝即拒绝，即更严者生效。审批档复用既有桌面审批窗
//! 链路：`check_permission` 在审批档等待既有审批队列（含超时），拒绝/
//! 超时以 `PermissionDenied` 返回并映射为 MCP `isError` 结果，不静默
//! 降级、不挂死。策展工具清单的扩充由 Task 25 负责，本模块交付机制与
//! 首个端到端验证载体。

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::{
    dto::{ErrorCode, FlowRunListQuery, ManagerError},
    manager::ProxyCrabManager,
    permission::{
        ManagementCredential, PermissionAction, PermissionDenied, PermissionDeniedStatus,
        PermissionManager, find_api_action,
    },
};

use super::protocol::{self, RpcRequest};

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
    REGISTRY.iter().find(|tool| tool.name == name)
}

/// 一次 `tools/call` 的执行环境：管理状态、权限服务与调用者身份
/// （身份已由 `authorize_request` 依据既有体系解析完成）。
pub struct ToolCallContext<'a> {
    pub manager: &'a Arc<dyn ProxyCrabManager>,
    pub permissions: &'a Arc<dyn PermissionManager>,
    pub credential: ManagementCredential,
}

/// `tools/call` 全流程：名称校验 → 注册表查找 → 映射路由逐次鉴权
/// （审批档复用既有审批窗）→ 执行 → 统一错误映射。缺名/空名维持
/// 协议层 -32602（信封问题），其余失败一律 MCP `isError` 结果。
pub async fn call(request: &RpcRequest, context: &ToolCallContext<'_>) -> Value {
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
    match execute(tool.name, &arguments, context.manager).await {
        Ok(value) => protocol::success(
            &request.id,
            json!({ "content": [{ "type": "text", "text": value.to_string() }] }),
        ),
        Err(error) => tool_error(&request.id, name, &manager_error_reason(&error)),
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
        // lookup 已把执行器与注册表对齐；此分支不可达。
        _ => Err(ManagerError::internal("tool has no executor")),
    }
}

/// 反序列化工具入参为映射路由的查询/请求体类型；失败归入 bad_request。
fn parse_arguments<T: DeserializeOwned>(arguments: &Value) -> Result<T, ManagerError> {
    serde_json::from_value(arguments.clone())
        .map_err(|error| ManagerError::bad_request(format!("arguments do not match the tool schema: {error}")))
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
        let manager: Arc<dyn ProxyCrabManager> = MitmManager::new(runtime);
        let permissions: Arc<dyn PermissionManager> = Arc::new(AllowTools);
        let context = ToolCallContext {
            manager: &manager,
            permissions: &permissions,
            credential: ManagementCredential::LocalLoopback,
        };
        // 缺名/空名维持协议层 -32602。
        for params in [json!({}), json!({ "name": "" })] {
            let request = RpcRequest {
                id: json!(1),
                method: "tools/call".into(),
                params,
            };
            assert_eq!(
                call(&request, &context).await["error"]["code"],
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
            let response = call(&request, &context).await;
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
}
