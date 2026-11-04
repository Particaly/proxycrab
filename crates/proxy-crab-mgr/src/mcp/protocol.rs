//! MCP JSON-RPC 2.0 信封与方法分派（plan Task 24 Step 1）。
//!
//! 不引入 MCP SDK：信封解析/序列化与错误码在此自实现，覆盖 `initialize` /
//! `tools/list` / `tools/call` 的分派骨架。请求期无状态；策展工具面（tools
//! 实际清单与逐次鉴权）由后续薄片填充。

use serde_json::{Value, json};

/// JSON-RPC 2.0 / MCP 约定的协议错误码。
pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;

/// 本实现支持的最高 MCP 协议版本（`latest` 与协商失败时的回落目标）。
pub const LATEST_PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];

const SERVER_NAME: &str = "proxy-crab";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 带 id 的 JSON-RPC 请求。
#[derive(Debug, Clone, PartialEq)]
pub struct RpcRequest {
    pub id: Value,
    pub method: String,
    pub params: Value,
}

/// 解析后的入站消息。
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// 必须回信的请求。
    Request(RpcRequest),
    /// 无 id 的通知，不回信。
    Notification,
    /// 信封结构非法；`id` 尽力保留（规范要求对畸形请求回 -32600/-32700）。
    Invalid {
        id: Value,
        code: i64,
        message: String,
    },
}

/// 解析原始请求体为入站消息；字节级解析失败按 -32700（id 为 null）处理。
pub fn parse(payload: &[u8]) -> Incoming {
    let value = match serde_json::from_slice::<Value>(payload) {
        Ok(value) => value,
        Err(error) => {
            return Incoming::Invalid {
                id: Value::Null,
                code: PARSE_ERROR,
                message: format!("parse error: {error}"),
            };
        }
    };
    let invalid = |id: Value, message: &str| Incoming::Invalid {
        id,
        code: INVALID_REQUEST,
        message: message.to_owned(),
    };
    let Some(object) = value.as_object() else {
        return invalid(Value::Null, "request must be a JSON object");
    };
    let id = object.get("id").cloned().unwrap_or(Value::Null);
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return invalid(id, r#"jsonrpc must be exactly "2.0""#);
    }
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return invalid(id, "missing string method");
    };
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    if !params.is_object() && !params.is_array() {
        return invalid(id, "params must be an object or array");
    }
    match object.get("id") {
        // 无 id 视为通知；id 一旦出现必须是 string、number 或 null。
        None => Incoming::Notification,
        Some(_) if id.is_string() || id.is_number() || id.is_null() => {
            Incoming::Request(RpcRequest {
                id,
                method: method.to_owned(),
                params,
            })
        }
        Some(_) => invalid(Value::Null, "id must be a string, number, or null"),
    }
}

/// 成功应答信封。
pub fn success(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// 协议错误应答信封。
pub fn error(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

/// 分派单条入站消息：通知返回 `None`（不回信），其余返回应答信封。
pub fn handle(incoming: Incoming) -> Option<Value> {
    match incoming {
        Incoming::Notification => None,
        Incoming::Invalid { id, code, message } => Some(error(&id, code, message)),
        Incoming::Request(request) => Some(handle_request(request)),
    }
}

fn handle_request(request: RpcRequest) -> Value {
    match request.method.as_str() {
        "initialize" => initialize(&request),
        // 策展工具面由后续薄片（Task 25）填充，本薄片返回空清单占位。
        "tools/list" => success(&request.id, json!({ "tools": [] })),
        "tools/call" => tools_call(&request),
        _ => error(
            &request.id,
            METHOD_NOT_FOUND,
            format!("unknown method: {}", request.method),
        ),
    }
}

/// `initialize` 握手与协议版本协商：客户端指定受支持版本则原样确认；
/// 指定 `latest`、缺失或不受支持的版本均回落到本实现最新版本，由客户端
/// 决定是否继续会话。
fn initialize(request: &RpcRequest) -> Value {
    let requested = request.params.get("protocolVersion").and_then(Value::as_str);
    let negotiated = match requested {
        Some(version) if SUPPORTED_PROTOCOL_VERSIONS.contains(&version) => version,
        _ => LATEST_PROTOCOL_VERSION,
    };
    success(
        &request.id,
        json!({
            "protocolVersion": negotiated,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
        }),
    )
}

/// `tools/call` 分派骨架：未知工具名按 MCP 约定返回 `isError` 结果形态
/// （工具级失败），而非协议错误；带 `arguments` 的真实工具执行是后续薄片。
fn tools_call(request: &RpcRequest) -> Value {
    let Some(name) = request.params.get("name").and_then(Value::as_str) else {
        return error(&request.id, INVALID_PARAMS, "tools/call requires a tool name");
    };
    if name.is_empty() {
        return error(&request.id, INVALID_PARAMS, "tools/call requires a non-empty tool name");
    }
    success(
        &request.id,
        json!({
            "content": [{
                "type": "text",
                "text": format!("tool '{name}' is not implemented yet"),
            }],
            "isError": true,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, params: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params
        }))
        .unwrap()
    }

    #[test]
    fn malformed_json_yields_parse_error_with_null_id() {
        let response = handle(parse(b"{not json")).unwrap();
        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["id"], Value::Null);
        assert_eq!(response["error"]["code"], PARSE_ERROR);
    }

    #[test]
    fn structurally_broken_envelopes_yield_invalid_request() {
        for payload in [
            &b"[]"[..],
            br#"{"jsonrpc":"1.0","id":1,"method":"initialize"}"#,
            br#"{"jsonrpc":"2.0","id":1}"#,
            br#"{"jsonrpc":"2.0","id":{"deep":1},"method":"initialize"}"#,
            br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":"scalar"}"#,
        ] {
            let response = handle(parse(payload)).unwrap();
            assert_eq!(response["error"]["code"], INVALID_REQUEST, "{payload:?}");
        }
    }

    #[test]
    fn unknown_method_yields_method_not_found() {
        let response = handle(parse(&request("resources/list", json!({})))).unwrap();
        assert_eq!(response["error"]["code"], METHOD_NOT_FOUND);
        assert_eq!(response["id"], 1);
        assert!(response.get("result").is_none());
    }

    #[test]
    fn notifications_are_acknowledged_without_a_response() {
        let payload = br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        assert_eq!(handle(parse(payload)), None);
    }

    #[test]
    fn initialize_echoes_supported_versions_and_falls_back_to_latest() {
        for (requested, expected) in [
            ("2024-11-05", "2024-11-05"),
            ("2025-03-26", "2025-03-26"),
            ("2025-06-18", "2025-06-18"),
            ("latest", LATEST_PROTOCOL_VERSION),
            ("1999-01-01", LATEST_PROTOCOL_VERSION),
        ] {
            let response = handle(parse(&request(
                "initialize",
                json!({ "protocolVersion": requested }),
            )))
            .unwrap();
            assert_eq!(response["result"]["protocolVersion"], expected, "{requested}");
            assert_eq!(response["result"]["capabilities"]["tools"], json!({}));
            assert_eq!(response["result"]["serverInfo"]["name"], "proxy-crab");
            assert!(response["result"]["serverInfo"]["version"].is_string());
        }
    }

    #[test]
    fn tools_list_is_an_empty_curated_placeholder_until_task_25() {
        let response = handle(parse(&request("tools/list", json!({})))).unwrap();
        assert_eq!(response["result"]["tools"], json!([]));
    }

    #[test]
    fn tools_call_reports_unimplemented_tools_as_tool_level_errors() {
        let response = handle(parse(&request(
            "tools/call",
            json!({ "name": "get_proxy_status", "arguments": {} }),
        )))
        .unwrap();
        // 工具级失败：result.isError 形态，而非协议错误码。
        assert!(response.get("error").is_none());
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(response["result"]["content"][0]["type"], "text");
        assert!(response["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("get_proxy_status"));
    }

    #[test]
    fn tools_call_without_a_name_is_invalid_params() {
        for params in [json!({}), json!({ "name": "" })] {
            let response = handle(parse(&request("tools/call", params))).unwrap();
            assert_eq!(response["error"]["code"], INVALID_PARAMS);
        }
    }
}
