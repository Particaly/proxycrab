//! MCP over management HTTP（plan Task 24 Step 1/2）：`POST /mcp` 端点骨架。
//!
//! 不引入 MCP SDK，JSON-RPC 2.0 信封自实现于 [`protocol`]；请求期无状态，
//! 每请求独立复用既有身份体系鉴权（由 HTTP 层权限中间件经
//! `POST /mcp` 权限目录 action 完成，语义与 `/api/*` 一致）。

pub mod protocol;
pub mod tools;

/// 单条 MCP 消息的请求体上限（MCP 消息均为小型 JSON 信封）。
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// 处理一次 `POST /mcp` 请求体：畸形信封返回协议错误应答（HTTP 200 携带
/// JSON-RPC error），通知类消息返回 `None`（调用方回 202 无正文）。
pub fn respond(body: &[u8]) -> Option<serde_json::Value> {
    protocol::handle(protocol::parse(body))
}
