//! MCP over management HTTP（plan Task 24）：`POST /mcp` 端点。
//!
//! 不引入 MCP SDK，JSON-RPC 2.0 信封自实现于 [`protocol`]；策展工具的
//! 注册表、逐次鉴权与执行边界在 [`tools`]。每请求独立复用既有身份体系
//! 鉴权（由 HTTP 层权限中间件经 `POST /mcp` 权限目录 action 完成，
//! 语义与 `/api/*` 一致）。

pub mod protocol;
pub mod tools;

use serde_json::Value;

/// 单条 MCP 消息的请求体上限（MCP 消息均为小型 JSON 信封）。
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// 处理一次 `POST /mcp` 请求体：`tools/call` 走策展工具调用链（逐次
/// 鉴权与执行边界，见 [`tools`]）；其余方法沿用信封分派。畸形信封返回
/// 协议错误应答（HTTP 200 携带 JSON-RPC error），通知类消息返回 `None`
/// （调用方回 202 无正文）。
pub async fn respond(
    body: &[u8],
    context: &tools::ToolCallContext<'_>,
) -> Option<Value> {
    match protocol::parse(body) {
        protocol::Incoming::Request(request) if request.method == "tools/call" => {
            Some(tools::call(&request, context).await)
        }
        incoming => protocol::handle(incoming),
    }
}
