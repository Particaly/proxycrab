//! flow 运行时失败面测试（ReqFlow 复刻计划 Task 1 Step 3）。
//!
//! 覆盖：死循环超指令配额、墙钟预算耗尽、内存超限、脚本抛错、宿主函数抛错、
//! 取消中断（睡眠中与纯计算中），以及一次宿主函数 JSON 往返的 smoke 用例。
//! 所有用例统一 10 秒兜底超时，断言 Rust 侧不会被失控脚本拖死。

use std::{sync::Arc, time::Duration};

use proxy_crab_mitm::flow::{
    host::{FlowCancel, FlowError, FlowErrorKind, FlowHost},
    runtime::{FlowLimits, FlowRuntime},
};
use serde_json::{Value as JsonValue, json};

/// 桩宿主：记录 log/emit 载荷；replay 按预设返回（默认 200 响应或注入错误）；
/// sleep 走 tokio 定时器；cancelled 读取共享取消句柄。真实重放接线由后续任务提供。
#[derive(Clone)]
struct StubHost {
    cancel: FlowCancel,
    replay_error: Option<FlowError>,
    logs: Arc<std::sync::Mutex<Vec<JsonValue>>>,
    events: Arc<std::sync::Mutex<Vec<JsonValue>>>,
}

impl StubHost {
    /// 创建绑定取消句柄的桩宿主。
    fn new(cancel: &FlowCancel) -> Self {
        Self {
            cancel: cancel.clone(),
            replay_error: None,
            logs: Arc::default(),
            events: Arc::default(),
        }
    }
}

#[async_trait::async_trait]
impl FlowHost for StubHost {
    async fn replay(&self, _payload: JsonValue) -> Result<JsonValue, FlowError> {
        match &self.replay_error {
            Some(error) => Err(error.clone()),
            None => Ok(json!({"status": 200, "headers": {}, "body": ""})),
        }
    }

    async fn now(&self) -> Result<JsonValue, FlowError> {
        Ok(json!(1_700_000_000_000u64))
    }

    async fn log(&self, payload: JsonValue) -> Result<JsonValue, FlowError> {
        self.logs.lock().unwrap().push(payload);
        Ok(JsonValue::Null)
    }

    async fn sleep(&self, payload: JsonValue) -> Result<JsonValue, FlowError> {
        let millis = payload.as_u64().unwrap_or(0);
        tokio::time::sleep(Duration::from_millis(millis)).await;
        Ok(JsonValue::Null)
    }

    async fn emit(&self, payload: JsonValue) -> Result<JsonValue, FlowError> {
        self.events.lock().unwrap().push(payload);
        Ok(JsonValue::Null)
    }

    async fn cancelled(&self) -> Result<JsonValue, FlowError> {
        Ok(json!(self.cancel.is_cancelled()))
    }
}

/// 统一执行入口：创建 VM 后以 10 秒兜底超时运行脚本，
/// 超时即 panic——证明任何失败面都不会把 Rust 侧拖死。
async fn run_script(
    host: Arc<dyn FlowHost>,
    cancel: &FlowCancel,
    limits: FlowLimits,
    script: &str,
) -> Result<JsonValue, FlowError> {
    let vm = FlowRuntime::new(host, cancel.clone(), limits)
        .await
        .expect("VM creation should not fail");
    tokio::time::timeout(Duration::from_secs(10), vm.run(script))
        .await
        .expect("runtime did not settle within 10s")
}

/// 异步脚本骨架：顶层 eval 不支持 await，统一用 async IIFE 返回 Promise。
fn async_main(body: &str) -> String {
    format!("(async () => {{ {body} }})()")
}

#[tokio::test(flavor = "multi_thread")]
async fn dead_loop_hits_instruction_quota() {
    let cancel = FlowCancel::new();
    let limits = FlowLimits {
        instruction_quota: 1_000,
        ..FlowLimits::default()
    };
    let error = run_script(
        Arc::new(StubHost::new(&cancel)),
        &cancel,
        limits,
        "while (true) {}",
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, FlowErrorKind::Timeout);
    assert!(
        error.message.contains("instruction quota"),
        "unexpected message: {error}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn dead_loop_hits_wall_clock_budget() {
    let cancel = FlowCancel::new();
    // 配额给到实际不可触达，验证墙钟预算独立生效。
    let limits = FlowLimits {
        instruction_quota: u64::MAX,
        wall_clock: Duration::from_millis(150),
        ..FlowLimits::default()
    };
    let error = run_script(
        Arc::new(StubHost::new(&cancel)),
        &cancel,
        limits,
        "while (true) {}",
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, FlowErrorKind::Timeout);
    assert!(
        error.message.contains("wall-clock"),
        "unexpected message: {error}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn memory_explosion_hits_memory_limit() {
    let cancel = FlowCancel::new();
    let limits = FlowLimits {
        memory_bytes: 2 * 1024 * 1024,
        ..FlowLimits::default()
    };
    let error = run_script(
        Arc::new(StubHost::new(&cancel)),
        &cancel,
        limits,
        "const rows = []; while (true) { rows.push(new Array(1024).fill('x')); }",
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, FlowErrorKind::Timeout);
    assert!(
        error.message.contains("memory limit"),
        "unexpected message: {error}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn script_throw_classifies_script() {
    let cancel = FlowCancel::new();
    let host = Arc::new(StubHost::new(&cancel));
    let error = run_script(
        host.clone(),
        &cancel,
        FlowLimits::default(),
        "throw new Error('boom');",
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, FlowErrorKind::Script);
    assert!(
        error.message.contains("boom"),
        "unexpected message: {error}"
    );

    // 语法错误同样归 script。
    let error = run_script(host, &cancel, FlowLimits::default(), "function {")
        .await
        .unwrap_err();
    assert_eq!(error.kind, FlowErrorKind::Script);
}

#[tokio::test(flavor = "multi_thread")]
async fn host_error_kind_crosses_boundary() {
    let cancel = FlowCancel::new();
    let mut stub = StubHost::new(&cancel);
    stub.replay_error = Some(FlowError::new(
        FlowErrorKind::Network,
        "upstream unreachable",
    ));
    let script = async_main("await host.replay({ method: 'GET' });");
    let error = run_script(Arc::new(stub), &cancel, FlowLimits::default(), &script)
        .await
        .unwrap_err();
    // 宿主桥错误跨 JS 边界后保持宿主给定的类别与消息。
    assert_eq!(error.kind, FlowErrorKind::Network);
    assert!(
        error.message.contains("upstream unreachable"),
        "unexpected message: {error}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_interrupts_pending_sleep() {
    let cancel = FlowCancel::new();
    let host = Arc::new(StubHost::new(&cancel));
    let vm = Arc::new(
        FlowRuntime::new(host, cancel.clone(), FlowLimits::default())
            .await
            .expect("VM creation should not fail"),
    );
    let script = async_main("await host.sleep(60_000);");
    let run = tokio::spawn({
        let vm = vm.clone();
        async move {
            tokio::time::timeout(Duration::from_secs(10), vm.run(&script))
                .await
                .expect("runtime did not settle within 10s")
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    cancel.cancel();
    // 睡眠中的宿主调用被立即放弃并归一为 cancelled，无需等满 60 秒。
    let error = run.await.unwrap().unwrap_err();
    assert_eq!(error.kind, FlowErrorKind::Cancelled);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_interrupts_compute_loop() {
    let cancel = FlowCancel::new();
    let host = Arc::new(StubHost::new(&cancel));
    // 配额与墙钟都很宽裕，验证取消优先于超限并尽快中断纯计算循环。
    let limits = FlowLimits {
        instruction_quota: u64::MAX,
        wall_clock: Duration::from_secs(60),
        ..FlowLimits::default()
    };
    let vm = Arc::new(
        FlowRuntime::new(host, cancel.clone(), limits)
            .await
            .expect("VM creation should not fail"),
    );
    let run = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(10), vm.run("while (true) {}"))
            .await
            .expect("runtime did not settle within 10s")
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    cancel.cancel();
    let error = run.await.unwrap().unwrap_err();
    assert_eq!(error.kind, FlowErrorKind::Cancelled);
}

#[tokio::test(flavor = "multi_thread")]
async fn smoke_host_json_round_trip() {
    let cancel = FlowCancel::new();
    let stub = Arc::new(StubHost::new(&cancel));
    let script = async_main(
        r"
        const started = await host.now();
        await host.sleep(1);
        await host.log({ message: 'hello', level: 'info' });
        await host.emit({ type: 'node-started', node: 'a1' });
        const wasCancelled = await host.cancelled();
        const replayed = await host.replay({ method: 'GET', url: 'https://example.invalid/' });
        return { started, wasCancelled, replayed };
        ",
    );
    let result = run_script(stub.clone(), &cancel, FlowLimits::default(), &script)
        .await
        .expect("smoke script should succeed");
    assert_eq!(result["started"].as_f64(), Some(1_700_000_000_000.0));
    assert_eq!(result["wasCancelled"], json!(false));
    assert_eq!(result["replayed"]["status"].as_i64(), Some(200));
    let logs = stub.logs.lock().unwrap();
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0]["message"], json!("hello"));
    let events = stub.events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["node"], json!("a1"));
}
