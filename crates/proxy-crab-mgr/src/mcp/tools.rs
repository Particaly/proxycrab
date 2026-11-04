//! MCP 策展工具注册表：工具 → 映射管理路由（plan Task 24 Step 3 机制部分）。
//!
//! 每个策展工具声明其等价的管理 API 路由；`tools/call` 逐次鉴权时取
//! 「该路由 action 的档位」与「MCP 端点本身档位」中更严者。策展工具
//! 清单的扩充由 Task 25 负责，本模块交付机制与首个端到端验证载体。

/// 单个策展工具的静态描述：名称、说明、映射路由与入参契约。
pub struct ToolDescriptor {
    pub name: &'static str,
    pub description: &'static str,
    /// 映射的管理路由 `(METHOD, PATH)`；鉴权档位由 permission 层对该
    /// 路由登记的 action 决定，未登记路由的工具不得上架。
    pub route: (&'static str, &'static str),
    /// 入参名与说明（与映射路由的查询/请求体字段保持一致）。
    pub params: &'static [(&'static str, &'static str)],
}

/// 工具注册表：仅登记已实现且映射路由已有 action 档位的工具。
const REGISTRY: &[ToolDescriptor] = &[ToolDescriptor {
    name: "workflow_runs_list",
    description: "List workflow runs, mirroring GET /api/flow/runs.",
    route: ("GET", "/api/flow/runs"),
    params: &[
        ("workflowId", "Filter by workflow id."),
        ("status", "Filter by run status."),
        ("limit", "Max entries to return."),
        ("offset", "Entries to skip."),
    ],
}];

/// 按名查找工具描述；未登记工具返回 `None`（`tools/call` 报未知工具）。
pub fn lookup(name: &str) -> Option<&'static ToolDescriptor> {
    REGISTRY.iter().find(|tool| tool.name == name)
}

/// `tools/list` 展示的策展清单（Task 25 扩充工具面）。
pub fn list() -> &'static [ToolDescriptor] {
    REGISTRY
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_resolves_known_tool_and_rejects_unknown() {
        assert_eq!(lookup("workflow_runs_list").unwrap().route, ("GET", "/api/flow/runs"));
        assert!(lookup("no_such_tool").is_none());
    }
}
