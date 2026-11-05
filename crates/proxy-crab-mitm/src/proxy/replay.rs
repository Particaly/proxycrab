use std::{
    collections::BTreeMap,
    io::Read,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::Context;
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::{Request, Version, header::HeaderName, header::HeaderValue};
use serde::Serialize;
use thiserror::Error;

use super::{ConnectionGeneration, TrafficSource, body::boxed_full, mitm};
use crate::{
    ProxyCrab,
    model::{CaptureOutcome, CaptureSummary, HeaderValues},
    storage::{BodySide, BodySource, BodySourceData, decode_body, is_textual},
};

/// 信封响应体上限（字节）：超过即按 UTF-8 字符边界截断并标记 `truncated`
/// （对齐 ReqFlow 的 1MB 响应体上限）。
const REPLAY_BODY_LIMIT: usize = 1024 * 1024;
/// 原始（可能仍处于压缩态）响应字节的读取上限，防止解压炸弹读入超大原文。
const REPLAY_RAW_READ_LIMIT: u64 = 8 * 1024 * 1024;
/// capture 终态的轮询间隔。完成信号即 captures.outcome 离开 in_progress。
const REPLAY_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// `replay_await` 的建议默认等待上限（30 秒，略保守于上游请求超时 60 秒
/// 与常见工作流节点超时；调用方应按节点 `timeoutMs` 显式传入）。
pub const REPLAY_DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayBody {
    Text {
        text: String,
    },
    BodyRef {
        session_id: u64,
        log_id: u64,
        side: BodySide,
    },
    Asset {
        asset_id: String,
    },
}

#[derive(Debug, Clone)]
pub struct ReplayRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<ReplayBody>,
}

/// 信封响应体类型（对齐 ReqFlow bodyType，另加 binary：content-type 明确
/// 非文本类型时标记，body 为有损文本化参考）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplayBodyType {
    Json,
    Text,
    Empty,
    Binary,
}

/// `replay_await` 回传的归一化响应信封（对齐 ReqFlow ReplayResponseOutput）。
/// 4xx/5xx 不算失败：照常返回信封，由上层按 `status >= 400` 判定 HTTP 失败。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayResponse {
    pub status: u16,
    /// 状态短语。capture 管线不保留原始短语，此处为状态码的规范短语
    /// （如 "OK"）；无规范短语时为空串（对齐 ReqFlow 桥路径的 `statusText: ''`）。
    pub status_text: String,
    /// 响应头：同名多值合并为逗号拼接（ReqFlow Headers 迭代语义）。
    pub headers: BTreeMap<String, String>,
    /// 响应体文本（上限 [`REPLAY_BODY_LIMIT`]，UTF-8 边界截断）；
    /// binary 时为有损文本化参考，不代表原始字节。
    pub body: String,
    /// 解析后的 JSON 值（仅 `body_type == Json` 时存在；body 保持原文）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json: Option<serde_json::Value>,
    pub body_type: ReplayBodyType,
    /// 发起重放到响应完成（capture 终态）的耗时毫秒。
    pub duration_ms: u64,
    /// 响应体超限截断（或 blob 读取不完整）时为 true。
    pub truncated: bool,
}

#[derive(Debug, Error)]
pub enum ReplayError {
    #[error("session not found or archived")]
    SessionNotFound,
    #[error("proxy is not running")]
    ProxyNotRunning,
    #[error("referenced capture body not found")]
    BodyNotFound,
    #[error("referenced asset not found")]
    AssetNotFound,
    #[error("invalid replay request: {0}")]
    Invalid(String),
    #[error("replay failed: {0}")]
    Internal(#[from] anyhow::Error),
}

/// `replay_await` 的错误：Timeout / Cancelled / Network 对齐 ReqFlow 错误分类
/// （`timeout | cancelled | network`）；发起阶段的会话/参数/内部错误原样透传
/// 为 [`ReplayAwaitError::Replay`]，供上层映射到其余分类。
#[derive(Debug, Error)]
pub enum ReplayAwaitError {
    #[error("replay wait timed out")]
    Timeout,
    #[error("replay was cancelled")]
    Cancelled,
    #[error("replay network failure: {0}")]
    Network(String),
    #[error(transparent)]
    Replay(#[from] ReplayError),
}

impl ProxyCrab {
    /// 在指定 Session 中重放一条请求：复用 MITM 会话链路（拦截器、捕获、出站），
    /// capture 建立后立即返回 log_id，不等待响应完成。要求代理运行中。
    pub async fn replay(
        self: &Arc<Self>,
        session_id: u64,
        request: ReplayRequest,
    ) -> std::result::Result<u64, ReplayError> {
        Ok(self
            .dispatch_replay(session_id, request, || {
                self.proxy_controller()
                    .replay_generation()
                    .ok_or(ReplayError::ProxyNotRunning)
            })
            .await?
            .0)
    }

    /// 发起重放并等待响应完成，回传归一化响应信封（供 flow 域复用）。
    ///
    /// 与 [`ProxyCrab::replay`] 的区别：不满足于 capture 建立，而是等待
    /// capture 到达终态（成功/失败），再从 capture 记录与响应 blob 装配
    /// [`ReplayResponse`]；既有 `replay` / `POST /api/replay` 的
    /// fire-and-forget 语义保持不变。
    ///
    /// * `timeout` — 等待响应完成的上限，超时归一为
    ///   [`ReplayAwaitError::Timeout`]（建议 [`REPLAY_DEFAULT_TIMEOUT`]）。
    /// * 取消（replay 所属连接代被轮换/代理停止）归一为
    ///   [`ReplayAwaitError::Cancelled`]，且优先于失败结果。
    /// * capture 失败按 error_kind 归类：`*_timeout` → Timeout，
    ///   `proxy_shutdown` / `*_task_cancelled` → Cancelled，其余 → Network。
    /// * 4xx/5xx 不是错误：照常返回信封。
    pub async fn replay_await(
        self: &Arc<Self>,
        session_id: u64,
        request: ReplayRequest,
        timeout: Duration,
    ) -> std::result::Result<ReplayResponse, ReplayAwaitError> {
        self.replay_with_generation(session_id, request, timeout, || {
            self.proxy_controller()
                .replay_generation()
                .ok_or(ReplayError::ProxyNotRunning)
        })
        .await
    }

    /// 流程运行专用的重放等待：与 [`ProxyCrab::replay_await`] 同一执行与装配
    /// 链路，但走流程专属连接代（[`ProxyController::flow_generation`]）——
    /// 代理未运行也照常执行，代理停止 / 连接代轮换不取消进行中的流程重放
    /// （取消只随运行自身的取消令牌）。
    pub async fn replay_await_flow(
        self: &Arc<Self>,
        session_id: u64,
        request: ReplayRequest,
        timeout: Duration,
    ) -> std::result::Result<ReplayResponse, ReplayAwaitError> {
        self.replay_with_generation(session_id, request, timeout, || {
            Ok(self.proxy_controller().flow_generation())
        })
        .await
    }

    /// `replay_await` / `replay_await_flow` 共用通路：按给定连接代来源发起
    /// 重放并等待 capture 终态，装配归一化响应信封。
    async fn replay_with_generation(
        self: &Arc<Self>,
        session_id: u64,
        request: ReplayRequest,
        timeout: Duration,
        generation: impl FnOnce() -> std::result::Result<ConnectionGeneration, ReplayError>,
    ) -> std::result::Result<ReplayResponse, ReplayAwaitError> {
        let started_at = Instant::now();
        let (log_id, generation) = self
            .dispatch_replay(session_id, request, generation)
            .await
            .map_err(ReplayAwaitError::from)?;
        let summary = tokio::select! {
            summary = wait_capture_terminal(self, session_id, log_id) => summary,
            _ = generation.cancellation.cancelled() => {
                return Err(ReplayAwaitError::Cancelled);
            }
            _ = tokio::time::sleep(timeout) => {
                return if generation.cancellation.is_cancelled() {
                    Err(ReplayAwaitError::Cancelled)
                } else {
                    Err(ReplayAwaitError::Timeout)
                };
            }
        };
        // 取消优先于失败（对齐 ReqFlow 的取消语义）。
        if generation.cancellation.is_cancelled() {
            return Err(ReplayAwaitError::Cancelled);
        }
        match summary.outcome {
            CaptureOutcome::Success => {
                let response = summary.response.ok_or_else(|| {
                    ReplayAwaitError::Network(
                        "replay capture completed without response metadata".into(),
                    )
                })?;
                let source = self
                    .capture_body_source(session_id, log_id, BodySide::Response)
                    .map_err(|error| ReplayAwaitError::Network(error.to_string()))?
                    .ok_or_else(|| {
                        ReplayAwaitError::Network("replay response body is unavailable".into())
                    })?;
                let (body, body_type, json, truncated) = envelope_body(&source);
                Ok(ReplayResponse {
                    status: response.status,
                    status_text: hyper::StatusCode::from_u16(response.status)
                        .ok()
                        .and_then(|status| status.canonical_reason())
                        .unwrap_or_default()
                        .to_string(),
                    headers: flatten_headers(&response.headers),
                    body,
                    json,
                    body_type,
                    duration_ms: started_at.elapsed().as_millis() as u64,
                    truncated,
                })
            }
            CaptureOutcome::Failed => {
                let error = summary.error.ok_or_else(|| {
                    ReplayAwaitError::Network("replay capture failed without diagnostics".into())
                })?;
                Err(classify_capture_error(&error.kind, &error.message))
            }
            // 终态等待只会返回成功/失败/隧道；仍处于进行中按超时归类。
            CaptureOutcome::InProgress => Err(ReplayAwaitError::Timeout),
            CaptureOutcome::Tunneled => Err(ReplayAwaitError::Network(
                "replay capture ended as a tunnel without a response".into(),
            )),
        }
    }

    /// `replay` / `replay_await` / `replay_await_flow` 共用的发起通路：校验并
    /// 装配请求、提交到 `generation` 来源解析出的连接代执行，返回 capture id
    /// 与该连接代（其取消令牌用于等待中断）。generation 在会话 / 参数校验之后
    /// 才解析，保持既有错误优先级（Session 缺失先于代理未运行）。
    async fn dispatch_replay(
        self: &Arc<Self>,
        session_id: u64,
        request: ReplayRequest,
        generation: impl FnOnce() -> std::result::Result<ConnectionGeneration, ReplayError>,
    ) -> std::result::Result<(u64, ConnectionGeneration), ReplayError> {
        if !self
            .sessions()
            .iter()
            .any(|session| session.id == session_id)
        {
            return Err(ReplayError::SessionNotFound);
        }
        if request.method.trim().is_empty() {
            return Err(ReplayError::Invalid("method must not be empty".into()));
        }
        if !(request.url.starts_with("http://") || request.url.starts_with("https://")) {
            return Err(ReplayError::Invalid(
                "url must be an absolute http(s) URL".into(),
            ));
        }
        let body = match &request.body {
            None => Bytes::new(),
            Some(ReplayBody::Text { text }) => Bytes::copy_from_slice(text.as_bytes()),
            Some(ReplayBody::Asset { asset_id }) => {
                let asset = self
                    .asset(asset_id)
                    .map_err(|error| ReplayError::Internal(error.into()))?
                    .ok_or(ReplayError::AssetNotFound)?;
                Bytes::from(
                    tokio::fs::read(asset.path())
                        .await
                        .map_err(|error| ReplayError::Internal(error.into()))?,
                )
            }
            Some(ReplayBody::BodyRef {
                session_id: source_session,
                log_id,
                side,
            }) => {
                let source = self
                    .capture_body_source(*source_session, *log_id, *side)?
                    .ok_or(ReplayError::BodyNotFound)?;
                match source.data {
                    BodySourceData::Bytes(bytes) => Bytes::from(bytes),
                    BodySourceData::File(path) => Bytes::from(
                        tokio::fs::read(&path)
                            .await
                            .map_err(|error| ReplayError::Internal(error.into()))?,
                    ),
                }
            }
        };
        let generation = generation()?;
        let mut builder = Request::builder()
            .method(request.method.as_str())
            .uri(request.url.as_str())
            .version(Version::HTTP_11);
        {
            let headers = builder
                .headers_mut()
                .ok_or_else(|| ReplayError::Invalid("request builder rejected inputs".into()))?;
            for (name, value) in &request.headers {
                let name = HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| ReplayError::Invalid(format!("invalid header name: {name}")))?;
                let value = HeaderValue::from_str(value).map_err(|_| {
                    ReplayError::Invalid(format!("invalid value for header {name}"))
                })?;
                headers.append(name, value);
            }
        }
        let http_request = builder
            .body(boxed_full(body))
            .map_err(|error| ReplayError::Invalid(error.to_string()))?;
        let (capture_tx, capture_rx) = tokio::sync::oneshot::channel();
        let runtime = self.clone();
        let cancellation = generation.cancellation.clone();
        let tasks = generation.tasks.clone();
        generation.tasks.spawn(async move {
            let response = mitm::handle_session_http_request(
                http_request,
                TrafficSource::Replay,
                runtime,
                session_id,
                cancellation,
                tasks,
                Some(capture_tx),
            )
            .await;
            // 完整消费响应 body 以驱动响应捕获完成；重放调用方不需要响应内容。
            let _ = response.into_body().collect().await;
        });
        let capture_id = capture_rx
            .await
            .context("replay capture did not start")
            .map_err(ReplayError::Internal)?;
        Ok((capture_id, generation))
    }
}

/// 轮询等待 capture 终态（成功/失败/隧道）。capture 完成信号即
/// `captures.outcome` 离开 `in_progress`——由 mitm 管线在响应体落盘后写入
/// （`store.complete` / `fail_capture`），无需额外接线。
async fn wait_capture_terminal(
    runtime: &Arc<ProxyCrab>,
    session_id: u64,
    capture_id: u64,
) -> CaptureSummary {
    loop {
        if let Ok(summaries) = runtime.captures(session_id, &[capture_id])
            && let Some(summary) = summaries.first()
            && summary.outcome != CaptureOutcome::InProgress
        {
            return summary.clone();
        }
        tokio::time::sleep(REPLAY_POLL_INTERVAL).await;
    }
}

/// 把 capture 失败的 error_kind 归一为 ReqFlow 错误分类：
/// `*_timeout` → Timeout；代理停止/任务取消 → Cancelled；其余（含存储类
/// 管线失败）一律归 Network。
fn classify_capture_error(kind: &str, message: &str) -> ReplayAwaitError {
    if kind.ends_with("_timeout") {
        ReplayAwaitError::Timeout
    } else if kind == "proxy_shutdown" || kind.ends_with("_task_cancelled") {
        ReplayAwaitError::Cancelled
    } else {
        ReplayAwaitError::Network(format!("{kind}: {message}"))
    }
}

/// 响应头展平：同名多值合并为逗号拼接，头名保留 capture 侧原样（小写）。
fn flatten_headers(headers: &HeaderValues) -> BTreeMap<String, String> {
    headers
        .iter()
        .map(|(name, values)| (name.clone(), values.join(", ")))
        .collect()
}

/// 装配信封响应体：读取响应 blob（原始字节上限 [`REPLAY_RAW_READ_LIMIT`]）、
/// 按 content-encoding 解码（解码结果上限 [`REPLAY_BODY_LIMIT`]）、文本按
/// UTF-8 边界截断，并按 ReqFlow replay-response 的宽松口径判定 bodyType
/// （附加 binary：content-type 明确非文本类型时标记）。blob 读取失败按
/// 空体并标记截断处理（blob 由捕获管线先行落盘，此为极端降级路径）。
fn envelope_body(source: &BodySource) -> (String, ReplayBodyType, Option<serde_json::Value>, bool) {
    let (mut bytes, mut truncated) = match &source.data {
        BodySourceData::Bytes(bytes) => {
            let truncated = bytes.len() as u64 > REPLAY_RAW_READ_LIMIT;
            (
                bytes[..bytes.len().min(REPLAY_RAW_READ_LIMIT as usize)].to_vec(),
                truncated,
            )
        }
        BodySourceData::File(path) => {
            let mut buffer = Vec::new();
            let read = std::fs::File::open(path).and_then(|mut file| {
                (&mut file)
                    .take(REPLAY_RAW_READ_LIMIT + 1)
                    .read_to_end(&mut buffer)
            });
            if read.is_err() {
                return (String::new(), ReplayBodyType::Empty, None, true);
            }
            let truncated = buffer.len() as u64 > REPLAY_RAW_READ_LIMIT;
            buffer.truncate(REPLAY_RAW_READ_LIMIT as usize);
            (buffer, truncated)
        }
    };
    if !source.content_encodings.is_empty() {
        if let Ok((decoded, over_limit)) = decode_body(
            &bytes,
            &source.content_encodings.join(","),
            REPLAY_BODY_LIMIT as u64,
        ) {
            bytes = decoded;
            truncated |= over_limit;
        }
        // 解码失败（未知编码/数据损坏）时保留原始字节，交由内容分类降级。
    } else if bytes.len() > REPLAY_BODY_LIMIT {
        bytes.truncate(REPLAY_BODY_LIMIT);
        truncated = true;
    }
    let text_bytes = truncate_utf8(&bytes, REPLAY_BODY_LIMIT);
    if text_bytes.is_empty() {
        return (String::new(), ReplayBodyType::Empty, None, truncated);
    }
    let content_type = source.content_type.as_deref().unwrap_or_default();
    if !content_type.is_empty() && !is_textual(content_type) {
        return (
            String::from_utf8_lossy(text_bytes).into_owned(),
            ReplayBodyType::Binary,
            None,
            truncated,
        );
    }
    // ReqFlow 宽松判定：content-type 含 json，或原文形如 JSON，即尝试解析；
    // 解析失败（截断 JSON / 伪 JSON 文本）按文本处理。
    let text = String::from_utf8_lossy(text_bytes).into_owned();
    let looks_like_json = content_type.to_ascii_lowercase().contains("json")
        || text.trim_start().starts_with('{')
        || text.trim_start().starts_with('[');
    if looks_like_json && let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
        return (text, ReplayBodyType::Json, Some(json), truncated);
    }
    (text, ReplayBodyType::Text, None, truncated)
}

/// 在 UTF-8 字符边界截断字节序列（对齐 ReqFlow truncateUtf8Body）。
fn truncate_utf8(bytes: &[u8], limit: usize) -> &[u8] {
    if bytes.len() <= limit {
        return bytes;
    }
    let mut end = limit;
    while end > 0 && bytes[end] & 0xC0 == 0x80 {
        end -= 1;
    }
    &bytes[..end]
}
