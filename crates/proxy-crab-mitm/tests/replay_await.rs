//! `ProxyCrab::replay_await`（同步重放与结果回传，ReqFlow W3）集成测试。
//!
//! 复用 `proxy_integration.rs` 的本地测试上游/代理启动模式，覆盖：正常响应、
//! 4xx（不算失败）、等待超时、代理停止取消、代理未运行/Session 不存在、
//! 大响应体截断，以及 JSON bodyType 判定。

use std::{sync::Arc, time::Duration};

use proxy_crab_mitm::{
    ProxyCrab, ReplayAwaitError, ReplayBodyType, ReplayError, ReplayRequest, log_buffer::LogBuffer,
    model::NewSession,
};
use tempfile::tempdir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
    time::{sleep, timeout},
};

fn unused_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

async fn runtime() -> (tempfile::TempDir, Arc<ProxyCrab>) {
    let app_data = tempdir().unwrap();
    let runtime = ProxyCrab::open(app_data.path(), Arc::new(LogBuffer::default())).unwrap();
    let mut config = runtime.config();
    config.proxy_host = "127.0.0.1".into();
    config.proxy_port = unused_port();
    runtime.replace_config(config).await.unwrap();
    runtime.start_proxy().await.unwrap();
    (app_data, runtime)
}

fn get_request(url: String) -> ReplayRequest {
    ReplayRequest {
        method: "GET".into(),
        url,
        headers: Vec::new(),
        body: None,
    }
}

/// 单次原始响应上游：接受一个连接、丢弃请求、写出给定字节后关闭。
async fn raw_http_upstream(response: Vec<u8>) -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let _ = stream.read(&mut request).await;
        let _ = stream.write_all(&response).await;
    });
    (port, task)
}

/// 静默上游：接受连接后不响应，用于触发等待超时/取消。
async fn silent_upstream() -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let _ = stream.read(&mut request).await;
        sleep(Duration::from_secs(120)).await;
        drop(stream);
    });
    (port, task)
}

const OK_RESPONSE: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";

#[tokio::test]
async fn returns_envelope_for_a_normal_response() {
    let (_app_data, runtime) = runtime().await;
    let session = runtime.create_session(NewSession::default()).unwrap();
    let (upstream_port, upstream) = raw_http_upstream(OK_RESPONSE.to_vec()).await;

    let response = timeout(
        Duration::from_secs(5),
        runtime.replay_await(
            session.id,
            get_request(format!("http://127.0.0.1:{upstream_port}/normal")),
            Duration::from_secs(10),
        ),
    )
    .await
    .expect("replay_await did not finish in time")
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.status_text, "OK");
    assert_eq!(response.body_type, ReplayBodyType::Text);
    assert_eq!(response.body, "ok");
    assert_eq!(response.json, None);
    assert_eq!(
        response.headers.get("content-type").map(String::as_str),
        Some("text/plain")
    );
    assert!(response.duration_ms < 5000, "{}", response.duration_ms);
    assert!(!response.truncated);
    // 同一 capture 对既有读取面可见（信封与 capture 记录同源）。
    let captures = runtime.list_captures(session.id, 10, None).unwrap();
    assert_eq!(captures.len(), 1);
    assert_eq!(captures[0].id, 1);
    assert_eq!(captures[0].source, "ProxyCrabRequest");
    runtime.stop_proxy().await.unwrap();
    upstream.abort();
}

#[tokio::test]
async fn http_4xx_is_returned_as_an_envelope_not_an_error() {
    let (_app_data, runtime) = runtime().await;
    let session = runtime.create_session(NewSession::default()).unwrap();
    let (upstream_port, upstream) = raw_http_upstream(
        b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found"
            .to_vec(),
    )
    .await;

    let response = timeout(
        Duration::from_secs(5),
        runtime.replay_await(
            session.id,
            get_request(format!("http://127.0.0.1:{upstream_port}/missing")),
            Duration::from_secs(10),
        ),
    )
    .await
    .expect("replay_await did not finish in time")
    .unwrap();

    assert_eq!(response.status, 404);
    assert_eq!(response.status_text, "Not Found");
    assert_eq!(response.body, "not found");
    assert_eq!(response.body_type, ReplayBodyType::Text);
    runtime.stop_proxy().await.unwrap();
    upstream.abort();
}

#[tokio::test]
async fn classifies_json_bodies_with_a_parsed_value() {
    let (_app_data, runtime) = runtime().await;
    let session = runtime.create_session(NewSession::default()).unwrap();
    let (upstream_port, upstream) = raw_http_upstream(
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 28\r\nConnection: close\r\n\r\n{\"ok\":true,\"nested\":{\"a\":1}}".to_vec(),
    )
    .await;

    let response = timeout(
        Duration::from_secs(5),
        runtime.replay_await(
            session.id,
            get_request(format!("http://127.0.0.1:{upstream_port}/json")),
            Duration::from_secs(10),
        ),
    )
    .await
    .expect("replay_await did not finish in time")
    .unwrap();

    assert_eq!(response.body_type, ReplayBodyType::Json);
    // body 保持原文（ReqFlow 兼容性约定），解析值放 json 字段。
    assert_eq!(response.body, r#"{"ok":true,"nested":{"a":1}}"#);
    assert_eq!(
        response.json,
        Some(serde_json::json!({"ok": true, "nested": {"a": 1}}))
    );
    runtime.stop_proxy().await.unwrap();
    upstream.abort();
}

#[tokio::test]
async fn waits_are_normalized_as_timeout() {
    let (_app_data, runtime) = runtime().await;
    let session = runtime.create_session(NewSession::default()).unwrap();
    let (upstream_port, upstream) = silent_upstream().await;

    let result = timeout(
        Duration::from_secs(5),
        runtime.replay_await(
            session.id,
            get_request(format!("http://127.0.0.1:{upstream_port}/slow")),
            Duration::from_millis(300),
        ),
    )
    .await
    .expect("replay_await ignored its wait timeout")
    .unwrap_err();

    assert!(matches!(result, ReplayAwaitError::Timeout));
    runtime.stop_proxy().await.unwrap();
    upstream.abort();
}

#[tokio::test]
async fn stopping_the_proxy_cancels_a_pending_wait() {
    let (_app_data, runtime) = runtime().await;
    let session = runtime.create_session(NewSession::default()).unwrap();
    let (upstream_port, upstream) = silent_upstream().await;

    let pending = tokio::spawn({
        let runtime = runtime.clone();
        async move {
            runtime
                .replay_await(
                    session.id,
                    get_request(format!("http://127.0.0.1:{upstream_port}/cancelled")),
                    Duration::from_secs(30),
                )
                .await
        }
    });
    sleep(Duration::from_millis(100)).await;
    runtime.stop_proxy().await.unwrap();

    let result = timeout(Duration::from_secs(5), pending)
        .await
        .expect("pending wait survived the proxy stop")
        .unwrap();
    assert!(matches!(result, Err(ReplayAwaitError::Cancelled)));
    upstream.abort();
}

#[tokio::test]
async fn reports_proxy_not_running_and_missing_sessions() {
    let (_app_data, runtime) = runtime().await;
    let session = runtime.create_session(NewSession::default()).unwrap();
    let archived = runtime.create_session(NewSession::default()).unwrap();
    runtime.archive_session(archived.id).await.unwrap();
    runtime.stop_proxy().await.unwrap();

    let request = get_request("http://127.0.0.1:1/never".into());
    let result = runtime
        .replay_await(session.id, request.clone(), Duration::from_secs(1))
        .await
        .unwrap_err();
    assert!(matches!(
        result,
        ReplayAwaitError::Replay(ReplayError::ProxyNotRunning)
    ));

    let result = runtime
        .replay_await(archived.id, request, Duration::from_secs(1))
        .await
        .unwrap_err();
    assert!(matches!(
        result,
        ReplayAwaitError::Replay(ReplayError::SessionNotFound)
    ));
}

#[tokio::test]
async fn oversized_bodies_are_truncated_and_marked() {
    let (_app_data, runtime) = runtime().await;
    let session = runtime.create_session(NewSession::default()).unwrap();
    let body = vec![b'a'; 1024 * 1024 + 512];
    let mut response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(&body);
    let (upstream_port, upstream) = raw_http_upstream(response).await;

    let envelope = timeout(
        Duration::from_secs(10),
        runtime.replay_await(
            session.id,
            get_request(format!("http://127.0.0.1:{upstream_port}/large")),
            Duration::from_secs(30),
        ),
    )
    .await
    .expect("replay_await did not finish in time")
    .unwrap();

    assert_eq!(envelope.status, 200);
    assert!(envelope.truncated);
    assert_eq!(envelope.body.len(), 1024 * 1024);
    assert!(envelope.body.bytes().all(|byte| byte == b'a'));
    runtime.stop_proxy().await.unwrap();
    upstream.abort();
}
