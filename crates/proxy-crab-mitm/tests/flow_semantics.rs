//! flow 端到端语义测试（ReqFlow 复刻计划 Task 20 薄片 B，Step 5）。
//!
//! 以桩宿主（假重放）驱动内嵌引擎载荷：`FlowRuntime` 加载 `FLOW_ENGINE_JS`，
//! 以工作流 JSON 调用 `__flowEngine.runWorkflow`，断言执行路径与运行摘要。
//! 用例命名与断言口径逐条对齐上游仓 `src/engine/executor*.test.ts` 与
//! `logic-nodes*.test.ts`（main @ 485fa00）——上游以 fake runner 注入，本文件
//! 以桩宿主可编程的 `host.replay` 承担同等角色，其余执行语义共用同一引擎载荷。
//!
//! 桩宿主要点：
//! - `replay` 按 url 子串匹配预设行为（回显 / 预设信封 / 宿主错误 / 闸门 /
//!   触发引擎级取消），并记录 begin/end 时间线（并发重叠与批次边界的断言依据）；
//! - `cancelled` 返回「引擎级取消」标志（模拟 Rust 运行编排发起取消）——与
//!   VM 级取消（`FlowCancel`，宿主调用竞速中断）分层，本文件只覆盖引擎级
//!   优雅取消路径（执行器停止调度、循环已完成轮次照常结算）。

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use proxy_crab_mitm::flow::{
    bundle::FLOW_ENGINE_JS,
    host::{FlowCancel, FlowError, FlowErrorKind, FlowHost},
    runtime::{FlowLimits, FlowRuntime},
};
use serde_json::{Value as JsonValue, json};

/// 引擎载荷一次性 eval 的预算（与 dry_run 口径一致，独立于工作流运行预算）。
const PAYLOAD_LOAD_BUDGET: Duration = Duration::from_secs(30);

/// 单次工作流运行的整体兜底超时：超时即 panic——任何语义用例都不应把测试拖死。
const RUN_BUDGET: Duration = Duration::from_secs(30);

/// 单个 url 的重放行为（按 url 子串匹配，首个命中生效；未命中走缺省回显）。
#[derive(Clone)]
enum ReplayBehavior {
    /// 先等待共享栅栏（N 方到齐一起放行）再执行后续行为（批量并发验证）
    BarrierThen(Arc<tokio::sync::Barrier>, Box<ReplayBehavior>),
    /// 先等待指定毫秒再执行后续行为（并发重叠 / 引擎级取消窗口）
    SleepThen(u64, Box<ReplayBehavior>),
    /// 置位引擎级取消（host.cancelled → true），等待 settle_ms 让取消轮询
    /// 在本轮重放期间生效，再执行后续行为
    CancelThen(u64, Box<ReplayBehavior>),
    /// 前 remaining 次返回宿主错误，其后执行后续行为（重试验证）
    FailFirst(Arc<AtomicUsize>, Box<ReplayBehavior>),
    /// 返回宿主错误（如重放网络失败——节点 failed 的注入点）
    Fail(FlowError),
    /// 缺省回显：把请求 url / method 回显进响应 json（供下游断言数据流）
    Echo,
}

/// 桩宿主：可编程 replay + 引擎级取消标志 + 重放时间线记录。
struct SemanticHost {
    /// 引擎级取消标志：`host.cancelled()` 的返回值（模拟 Rust 运行编排侧取消）
    engine_cancelled: Arc<AtomicBool>,
    /// 按 url 子串匹配的重放行为表
    behaviors: Vec<(String, ReplayBehavior)>,
    /// 重放时间线：`begin:<url>` / `end:<url>`（并发重叠与批次边界断言依据）
    replay_log: Arc<Mutex<Vec<String>>>,
    /// 全部重放载荷（调用计数与请求内容断言依据）
    replay_payloads: Arc<Mutex<Vec<JsonValue>>>,
    /// 每次 host.sleep 的毫秒数（区分延时节点等待与取消轮询 50ms 心跳）
    sleep_durations: Arc<Mutex<Vec<u64>>>,
}

impl SemanticHost {
    /// 创建桩宿主：绑定取消句柄（本文件不主动触发 VM 级取消）与行为表。
    fn new(_cancel: &FlowCancel, behaviors: Vec<(String, ReplayBehavior)>) -> Self {
        Self {
            engine_cancelled: Arc::default(),
            behaviors,
            replay_log: Arc::default(),
            replay_payloads: Arc::default(),
            sleep_durations: Arc::default(),
        }
    }

    /// 按 url 子串解析首个命中的行为；未命中走缺省回显。
    fn behavior_for(&self, url: &str) -> ReplayBehavior {
        for (pattern, behavior) in &self.behaviors {
            if url.contains(pattern.as_str()) {
                return behavior.clone();
            }
        }
        ReplayBehavior::Echo
    }

    /// 执行行为链（Sleep/Barrier/Cancel 为前置等待，逐层解包到叶子行为）。
    async fn apply(
        &self,
        mut behavior: ReplayBehavior,
        payload: &JsonValue,
    ) -> Result<JsonValue, FlowError> {
        loop {
            match behavior {
                ReplayBehavior::BarrierThen(barrier, next) => {
                    barrier.wait().await;
                    behavior = *next;
                }
                ReplayBehavior::SleepThen(ms, next) => {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    behavior = *next;
                }
                ReplayBehavior::CancelThen(settle_ms, next) => {
                    self.engine_cancelled.store(true, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(settle_ms)).await;
                    behavior = *next;
                }
                ReplayBehavior::FailFirst(remaining, next) => {
                    if remaining.load(Ordering::SeqCst) > 0 {
                        remaining.fetch_sub(1, Ordering::SeqCst);
                        return Err(FlowError::new(
                            FlowErrorKind::Network,
                            "upstream unreachable",
                        ));
                    }
                    behavior = *next;
                }
                ReplayBehavior::Fail(error) => return Err(error),
                ReplayBehavior::Echo => return Ok(echo_envelope(payload)),
            }
        }
    }
}

#[async_trait::async_trait]
impl FlowHost for SemanticHost {
    async fn replay(&self, payload: JsonValue) -> Result<JsonValue, FlowError> {
        let url = payload["url"].as_str().unwrap_or_default().to_string();
        self.replay_log.lock().unwrap().push(format!("begin:{url}"));
        self.replay_payloads.lock().unwrap().push(payload.clone());
        let result = self.apply(self.behavior_for(&url), &payload).await;
        self.replay_log.lock().unwrap().push(format!("end:{url}"));
        result
    }

    async fn now(&self) -> Result<JsonValue, FlowError> {
        Ok(JsonValue::from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_millis() as u64)
                .unwrap_or_default(),
        ))
    }

    async fn log(&self, _payload: JsonValue) -> Result<JsonValue, FlowError> {
        Ok(JsonValue::Null)
    }

    async fn sleep(&self, payload: JsonValue) -> Result<JsonValue, FlowError> {
        let millis = payload.as_u64().unwrap_or(0);
        self.sleep_durations.lock().unwrap().push(millis);
        tokio::time::sleep(Duration::from_millis(millis)).await;
        Ok(JsonValue::Null)
    }

    async fn emit(&self, _payload: JsonValue) -> Result<JsonValue, FlowError> {
        // 事件时间线由测试脚本内 JS 数组收集（顺序确定性），不走宿主通道。
        Ok(JsonValue::Null)
    }

    async fn cancelled(&self) -> Result<JsonValue, FlowError> {
        Ok(json!(self.engine_cancelled.load(Ordering::SeqCst)))
    }
}

/// 缺省回显信封：200 + json 响应体携带请求 url / method（引擎归一化后
/// output.json.url 即可断言数据流走向）。
fn echo_envelope(payload: &JsonValue) -> JsonValue {
    let url = payload["url"].as_str().unwrap_or_default();
    let method = payload["method"].as_str().unwrap_or_default();
    json!({
        "status": 200,
        "statusText": "OK",
        "headers": {},
        "body": serde_json::to_string(&json!({ "url": url, "method": method })).unwrap(),
        "json": { "url": url, "method": method },
        "bodyType": "json",
        "durationMs": 1,
    })
}

/// 一次端到端运行的结果：运行摘要 + 事件时间线 + 桩宿主句柄（时间线访问）。
struct FlowRun {
    summary: JsonValue,
    events: Vec<JsonValue>,
    host: Arc<SemanticHost>,
}

/// 端到端运行夹具：桩宿主 + VM 装配 + 载荷加载 + runWorkflow 调用。
struct FlowHarness {
    host: Arc<SemanticHost>,
    cancel: FlowCancel,
}

impl FlowHarness {
    /// 创建夹具：行为表按「url 子串 → 行为」给出。
    fn new(behaviors: Vec<(String, ReplayBehavior)>) -> Self {
        let cancel = FlowCancel::new();
        Self {
            host: Arc::new(SemanticHost::new(&cancel, behaviors)),
            cancel,
        }
    }

    /// 行为表条目便捷构造。
    fn on(url_part: &str, behavior: ReplayBehavior) -> (String, ReplayBehavior) {
        (url_part.to_string(), behavior)
    }

    /// 加载内嵌载荷并以工作流 JSON 驱动 `runWorkflow`（事件时间线由脚本内
    /// 数组经 onNodeStart / onNodeFinish 收集，随返回值一并交付）。
    async fn run(&self, workflow: JsonValue, options: JsonValue) -> FlowRun {
        let limits = FlowLimits {
            instruction_quota: 2_000_000,
            ..FlowLimits::default()
        };
        let vm = FlowRuntime::new(self.host.clone(), self.cancel.clone(), limits)
            .await
            .expect("VM creation should not fail");
        tokio::time::timeout(PAYLOAD_LOAD_BUDGET, vm.run(FLOW_ENGINE_JS))
            .await
            .expect("engine payload did not load in time")
            .expect("engine payload eval failed");
        let script = build_run_script(&workflow, &options);
        let result = tokio::time::timeout(RUN_BUDGET, vm.run(&script))
            .await
            .expect("workflow did not settle within budget")
            .expect("workflow run failed at VM level");
        FlowRun {
            summary: result
                .get("summary")
                .cloned()
                .expect("runWorkflow result missing summary"),
            events: result
                .get("events")
                .and_then(JsonValue::as_array)
                .cloned()
                .unwrap_or_default(),
            host: self.host.clone(),
        }
    }
}

/// 构造 runWorkflow 调用脚本：工作流与选项以 JSON 字面量内嵌（天然防注入），
/// 事件回调把 onNodeStart / onNodeFinish 收进 JS 数组（保序、确定性强），
/// 最终返回 `{ summary, events }`。
fn build_run_script(workflow: &JsonValue, options: &JsonValue) -> String {
    let wf = serde_json::to_string(workflow).expect("workflow is not representable");
    let opts = serde_json::to_string(options).expect("options is not representable");
    format!(
        "(async () => {{\n\
         const engine = globalThis.__flowEngine;\n\
         if (!engine) throw new Error('engine payload missing __flowEngine global');\n\
         const options = {opts};\n\
         const events = [];\n\
         options.onNodeStart = (node, input) => {{\n\
           events.push({{ kind: 'node-start', id: node.id, input: input === undefined ? null : input }});\n\
         }};\n\
         options.onNodeFinish = (node, run) => {{\n\
           events.push({{ kind: 'node-finish', id: node.id, status: run.status, error: run.error === undefined ? null : run.error }});\n\
         }};\n\
         const summary = await engine.runWorkflow({wf}, options);\n\
         return {{ summary, events }};\n\
         }})()"
    )
}

/* ------------------------------------------------------------------ *
 * 工作流夹具构造（对齐上游测试的 makeNode / makeEdge / makeWorkflow）
 * ------------------------------------------------------------------ */

/// 构造画布节点（type / config 可覆盖）。
fn node(id: &str, ty: &str, config: JsonValue) -> JsonValue {
    json!({ "id": id, "type": ty, "position": { "x": 0, "y": 0 }, "config": config })
}

/// 开始节点（纯编排起点）。
fn start_node() -> JsonValue {
    node("s", "start", json!({}))
}

/// httpReplay 节点：以 manualRequest 提供请求基线（桩宿主按 url 识别行为）。
fn replay_node(id: &str, url: &str) -> JsonValue {
    node(
        id,
        "httpReplay",
        json!({ "manualRequest": { "method": "GET", "url": url } }),
    )
}

/// 构造连线（id 由 source→target 拼出）。
fn edge(source: &str, target: &str) -> JsonValue {
    json!({ "id": format!("{source}->{target}"), "source": source, "target": target })
}

/// 构造带出边手柄的连线（条件分支手柄路由，M16-T1）。
fn edge_handle(source: &str, target: &str, handle: &str) -> JsonValue {
    json!({
        "id": format!("{source}->{target}"),
        "source": source,
        "target": target,
        "sourceHandle": handle,
    })
}

/// 构造可执行工作流入参（id / nodes / edges 子集）。
fn workflow(nodes: Vec<JsonValue>, edges: Vec<JsonValue>) -> JsonValue {
    json!({ "id": "wf-test", "nodes": nodes, "edges": edges })
}

/// 从摘要中按节点 id 取执行快照（缺失即 panic，对齐上游 runOf）。
fn run_of<'a>(run: &'a FlowRun, id: &str) -> &'a JsonValue {
    run.summary
        .get("nodeRuns")
        .and_then(|node_runs| node_runs.get(id))
        .unwrap_or_else(|| panic!("node run missing: {id}"))
}

/// 节点执行状态（success / failed / skipped）。
fn status_of<'a>(run: &'a FlowRun, id: &str) -> &'a str {
    run_of(run, id)["status"].as_str().unwrap_or_default()
}

/// 运行级状态。
fn run_status(run: &FlowRun) -> &str {
    run.summary["status"].as_str().unwrap_or_default()
}

/// 重放时间线中的 begin 条目（保序）。
fn begin_entries(run: &FlowRun) -> Vec<String> {
    run.host
        .replay_log
        .lock()
        .unwrap()
        .iter()
        .filter(|entry| entry.starts_with("begin:"))
        .cloned()
        .collect()
}

/// 重放时间线中的 end 条目（保序）。
fn end_entries(run: &FlowRun) -> Vec<String> {
    run.host
        .replay_log
        .lock()
        .unwrap()
        .iter()
        .filter(|entry| entry.starts_with("end:"))
        .cloned()
        .collect()
}

/// 指定 url 的首个 begin 条目在时间线中的位置。
fn index_of(entries: &[String], entry: &str) -> usize {
    entries
        .iter()
        .position(|item| item == entry)
        .unwrap_or_else(|| panic!("timeline entry missing: {entry}"))
}

/// 指定类别的节点事件 id 序列（保序）。
fn event_ids(run: &FlowRun, kind: &str) -> Vec<String> {
    run.events
        .iter()
        .filter(|event| event["kind"].as_str() == Some(kind))
        .filter_map(|event| event["id"].as_str().map(str::to_owned))
        .collect()
}

/// 重放调用计数。
fn replay_count(run: &FlowRun) -> usize {
    run.host.replay_payloads.lock().unwrap().len()
}

/* ------------------------------------------------------------------ *
 * 并行调度（M15-T6）：对齐上游 executor.parallel.test.ts
 * ------------------------------------------------------------------ */

/// 上游：无依赖节点并发起跑：a 阻塞期间 b 已完成（时间线重叠），事件按入队序发出。
/// 桩宿主口径：a 的重放阻塞 150ms，b 立即返回——b 的 end 先于 a 的 end 即证明并发；
/// onNodeStart / onNodeFinish 事件按入队序（批内结算确定性）。
#[tokio::test(flavor = "multi_thread")]
async fn concurrent_nodes_overlap_while_blocked_and_events_settle_in_enqueue_order() {
    let harness = FlowHarness::new(vec![
        FlowHarness::on(
            "/n-a",
            ReplayBehavior::SleepThen(150, Box::new(ReplayBehavior::Echo)),
        ),
        FlowHarness::on("/n-b", ReplayBehavior::Echo),
    ]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    replay_node("a", "https://t/n-a"),
                    replay_node("b", "https://t/n-b"),
                ],
                vec![edge("s", "a"), edge("s", "b")],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    // 并发重叠：b（立即返回）在 a（阻塞 150ms）结算前完成。
    let ends = end_entries(&run);
    assert_eq!(ends.len(), 2, "timeline: {:?}", run.host.replay_log);
    assert!(
        index_of(&ends, "end:https://t/n-b") < index_of(&ends, "end:https://t/n-a"),
        "b should settle while a is in flight: {ends:?}"
    );
    // startedAt 重叠：同批起跑，a（先入队）不晚于 b。
    let a_started = run_of(&run, "a")["startedAt"].as_f64().unwrap();
    let b_started = run_of(&run, "b")["startedAt"].as_f64().unwrap();
    assert!(a_started <= b_started, "a must not start after b");
    // 事件按入队序发出（批内结算确定性：onNodeStart / onNodeFinish 均为入队序，
    // start 节点同样是节点、同样发事件）。
    assert_eq!(event_ids(&run, "node-start"), vec!["s", "a", "b"]);
    assert_eq!(event_ids(&run, "node-finish"), vec!["s", "a", "b"]);
    // 各自输出正确（回显信封经引擎归一化）。
    assert_eq!(
        run_of(&run, "a")["output"]["json"]["url"],
        json!("https://t/n-a")
    );
    assert_eq!(
        run_of(&run, "b")["output"]["json"]["url"],
        json!("https://t/n-b")
    );
}

/// 上游：join 节点等双上游都结算后才执行，input 为两份输出的聚合对象。
/// 桩宿主口径：a 阻塞 100ms、b 立即返回——join 的 begin 必须晚于 a、b 的两个 end。
#[tokio::test(flavor = "multi_thread")]
async fn join_node_waits_for_both_upstreams_then_aggregates_inputs() {
    let harness = FlowHarness::new(vec![
        FlowHarness::on(
            "/n-a",
            ReplayBehavior::SleepThen(100, Box::new(ReplayBehavior::Echo)),
        ),
        FlowHarness::on("/n-b", ReplayBehavior::Echo),
        FlowHarness::on("/n-join", ReplayBehavior::Echo),
    ]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    replay_node("a", "https://t/n-a"),
                    replay_node("b", "https://t/n-b"),
                    replay_node("join", "https://t/n-join"),
                ],
                vec![
                    edge("s", "a"),
                    edge("s", "b"),
                    edge("a", "join"),
                    edge("b", "join"),
                ],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    // join 起跑晚于两个上游的结算（end:a 与 end:b 都在 begin:join 之前）。
    let log = run.host.replay_log.lock().unwrap().clone();
    let begin_join = index_of(&log, "begin:https://t/n-join");
    let end_a = index_of(&log, "end:https://t/n-a");
    let end_b = index_of(&log, "end:https://t/n-b");
    assert!(
        end_a < begin_join && end_b < begin_join,
        "join must wait for both upstreams: {log:?}"
    );
    // input 为两份输出的聚合对象（无 refId 回退内部 id 为键）。
    let join_input = &run_of(&run, "join")["input"];
    assert_eq!(join_input["a"]["json"]["url"], json!("https://t/n-a"));
    assert_eq!(join_input["b"]["json"]["url"], json!("https://t/n-b"));
    assert_eq!(status_of(&run, "join"), "success");
}

/// 上游：缺省并发 4——就绪集批量并发，第 5 个节点等首批（4 个）全部结算后才起跑。
/// 桩宿主口径：前 4 个 url 在 4 方栅栏上等待（缺省并发 <4 会死锁、>4 会让第 5 个
/// begin 提前混入），第 5 个立即返回——时间线必为「4 begin、4 end、begin:e、end:e」。
#[tokio::test(flavor = "multi_thread")]
async fn default_max_node_concurrency_four_batches_the_ready_set() {
    let barrier = Arc::new(tokio::sync::Barrier::new(4));
    let gated = ReplayBehavior::BarrierThen(barrier.clone(), Box::new(ReplayBehavior::Echo));
    let harness = FlowHarness::new(vec![
        FlowHarness::on("/n-a", gated.clone()),
        FlowHarness::on("/n-b", gated.clone()),
        FlowHarness::on("/n-c", gated.clone()),
        FlowHarness::on("/n-d", gated),
        FlowHarness::on("/n-e", ReplayBehavior::Echo),
    ]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    replay_node("a", "https://t/n-a"),
                    replay_node("b", "https://t/n-b"),
                    replay_node("c", "https://t/n-c"),
                    replay_node("d", "https://t/n-d"),
                    replay_node("e", "https://t/n-e"),
                ],
                vec![
                    edge("s", "a"),
                    edge("s", "b"),
                    edge("s", "c"),
                    edge("s", "d"),
                    edge("s", "e"),
                ],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    let log = run.host.replay_log.lock().unwrap().clone();
    assert_eq!(log.len(), 10, "timeline: {log:?}");
    // 批 1：恰好 4 个 begin（集合 = a..d），随后 4 个 end；批 2 才轮到 e。
    let batch = |entries: &[String]| -> Vec<String> {
        let mut items = entries.to_vec();
        items.sort();
        items
    };
    assert_eq!(
        batch(&log[0..4]),
        batch(&[
            "begin:https://t/n-a".to_string(),
            "begin:https://t/n-b".to_string(),
            "begin:https://t/n-c".to_string(),
            "begin:https://t/n-d".to_string(),
        ])
    );
    assert_eq!(
        batch(&log[4..8]),
        batch(&[
            "end:https://t/n-a".to_string(),
            "end:https://t/n-b".to_string(),
            "end:https://t/n-c".to_string(),
            "end:https://t/n-d".to_string(),
        ])
    );
    assert_eq!(log[8], "begin:https://t/n-e");
    assert_eq!(log[9], "end:https://t/n-e");
}

/// 上游：maxNodeConcurrency 上限生效——并发 2 时 6 个就绪节点按对分批，
/// 每批 begin 成对、批内 end 全部结算后才起跑下一批。
#[tokio::test(flavor = "multi_thread")]
async fn max_node_concurrency_two_runs_the_ready_set_in_pairs() {
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let gated = ReplayBehavior::BarrierThen(barrier.clone(), Box::new(ReplayBehavior::Echo));
    let harness = FlowHarness::new(vec![
        FlowHarness::on("/n-a", gated.clone()),
        FlowHarness::on("/n-b", gated.clone()),
        FlowHarness::on("/n-c", gated.clone()),
        FlowHarness::on("/n-d", gated.clone()),
        FlowHarness::on("/n-e", gated.clone()),
        FlowHarness::on("/n-f", gated),
    ]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    replay_node("a", "https://t/n-a"),
                    replay_node("b", "https://t/n-b"),
                    replay_node("c", "https://t/n-c"),
                    replay_node("d", "https://t/n-d"),
                    replay_node("e", "https://t/n-e"),
                    replay_node("f", "https://t/n-f"),
                ],
                vec![
                    edge("s", "a"),
                    edge("s", "b"),
                    edge("s", "c"),
                    edge("s", "d"),
                    edge("s", "e"),
                    edge("s", "f"),
                ],
            ),
            json!({ "maxNodeConcurrency": 2 }),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    let log = run.host.replay_log.lock().unwrap().clone();
    assert_eq!(log.len(), 12, "timeline: {log:?}");
    // 三批两两成对：[begin, begin]、[end, end] 交替，批序按入队序；
    // 批内 begin / end 各自为集合断言（批内完成先后不影响确定性）。
    let batch = |entries: &[String]| -> Vec<String> {
        let mut items = entries.to_vec();
        items.sort();
        items
    };
    let windows: [(&str, &str, &str); 6] = [
        ("begin", "a", "b"),
        ("end", "a", "b"),
        ("begin", "c", "d"),
        ("end", "c", "d"),
        ("begin", "e", "f"),
        ("end", "e", "f"),
    ];
    for (index, (kind, first, second)) in windows.iter().enumerate() {
        let window = &log[index * 2..index * 2 + 2];
        assert_eq!(
            batch(window),
            batch(&[
                format!("{kind}:https://t/n-{first}"),
                format!("{kind}:https://t/n-{second}"),
            ]),
            "window {index} ({kind}) mismatch: timeline {log:?}"
        );
    }
}

/* ------------------------------------------------------------------ *
 * 条件分支路由（M16-T1 手柄 / M7-T1 legacy 清单 / 直通）
 * ------------------------------------------------------------------ */

/// 上游（condition-branch）：真分支仅真出口出边放行（假出口下游不放行）；
/// 反向同理。c1 输出为 { branch, value } 分支形态。
#[tokio::test(flavor = "multi_thread")]
async fn condition_handle_routes_only_the_matching_branch() {
    for (expression, active, inactive, branch) in [
        ("return true", "t1", "f1", "true"),
        ("return false", "f1", "t1", "false"),
    ] {
        let harness = FlowHarness::new(vec![]);
        let run = harness
            .run(
                workflow(
                    vec![
                        start_node(),
                        node("c1", "condition", json!({ "expression": expression })),
                        replay_node("t1", "https://t/t1"),
                        replay_node("f1", "https://t/f1"),
                    ],
                    vec![
                        edge("s", "c1"),
                        edge_handle("c1", "t1", "true"),
                        edge_handle("c1", "f1", "false"),
                    ],
                ),
                json!({}),
            )
            .await;
        let label = format!("expression={expression}");
        assert_eq!(run_status(&run), "success", "{label}");
        assert_eq!(status_of(&run, active), "success", "{label}");
        assert_eq!(status_of(&run, inactive), "skipped", "{label}");
        assert_eq!(
            run_of(&run, "c1")["output"]["branch"],
            json!(branch),
            "{label}"
        );
        // 未激活分支不发起重放。
        let urls: Vec<String> = begin_entries(&run)
            .iter()
            .map(|entry| entry.trim_start_matches("begin:").to_string())
            .collect();
        assert!(
            urls.iter()
                .all(|url| !url.contains(&format!("/{inactive}"))),
            "{inactive} must not replay: {urls:?}"
        );
    }
}

/// 上游（condition-branch / logic-nodes）：无手柄出边时回退 legacy 清单路由，
/// 且未被任何分支勾选的下游不受条件影响（两个分支都放行的旧「未绑定」语义）。
#[tokio::test(flavor = "multi_thread")]
async fn condition_falls_back_to_legacy_manifest_and_passes_unbound_downstream() {
    let harness = FlowHarness::new(vec![]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    node(
                        "c1",
                        "condition",
                        json!({
                            "expression": "return true",
                            "trueTargets": ["t1"],
                            "falseTargets": ["f1"],
                        }),
                    ),
                    replay_node("t1", "https://t/t1"),
                    replay_node("f1", "https://t/f1"),
                    replay_node("x", "https://t/x"),
                ],
                vec![
                    edge("s", "c1"),
                    edge("c1", "t1"),
                    edge("c1", "f1"),
                    edge("c1", "x"),
                ],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    // 真分支：命中清单的真目标 + 未列入任何清单的下游照常执行；假分支下游 skipped。
    assert_eq!(status_of(&run, "t1"), "success");
    assert_eq!(status_of(&run, "x"), "success");
    assert_eq!(status_of(&run, "f1"), "skipped");
    let urls = begin_entries(&run);
    assert_eq!(urls.len(), 2, "only t1 and x replay: {urls:?}");
}

/// 上游（logic-nodes）：条件节点完全未配置目标（无手柄出边 + 空清单）→ 直通，
/// 全部下游照常调度执行。
#[tokio::test(flavor = "multi_thread")]
async fn condition_without_routing_config_passes_through_to_all_downstream() {
    let harness = FlowHarness::new(vec![]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    node("c1", "condition", json!({ "expression": "return true" })),
                    replay_node("t1", "https://t/t1"),
                    replay_node("f1", "https://t/f1"),
                ],
                vec![edge("s", "c1"), edge("c1", "t1"), edge("c1", "f1")],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    assert_eq!(status_of(&run, "t1"), "success");
    assert_eq!(status_of(&run, "f1"), "success");
    assert_eq!(replay_count(&run), 2);
    // 分支形态输出仍在（路由语义与直通正交）。
    assert_eq!(run_of(&run, "c1")["output"]["branch"], json!("true"));
}

/* ------------------------------------------------------------------ *
 * 失败策略（M5-T4）：对齐上游 executor-fail-policy.test.ts
 * ------------------------------------------------------------------ */

/// 上游：线性图 a 失败（缺省 stop）→ 下游 b 不再执行（skipped），run 级错误
/// 摘要即该失败（「节点 <id> 执行失败：<原因>」）。
#[tokio::test(flavor = "multi_thread")]
async fn fail_policy_stop_halts_scheduling_and_marks_downstream_skipped() {
    let harness = FlowHarness::new(vec![FlowHarness::on(
        "/n-a",
        ReplayBehavior::Fail(FlowError::new(
            FlowErrorKind::Network,
            "upstream unreachable",
        )),
    )]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    replay_node("a", "https://t/n-a"),
                    replay_node("b", "https://t/n-b"),
                ],
                vec![edge("s", "a"), edge("a", "b")],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "failed");
    assert_eq!(
        run.summary["error"],
        json!("节点 a 执行失败：upstream unreachable")
    );
    assert_eq!(status_of(&run, "a"), "failed");
    assert_eq!(run_of(&run, "a")["error"], json!("upstream unreachable"));
    assert_eq!(status_of(&run, "b"), "skipped");
    // stop 后不再有任何新重放（b 未发起）。
    assert_eq!(replay_count(&run), 1);
}

/// 上游：a 失败（continue）→ 下游 b 仍执行，b input 为 null（失败上游按缺失聚合）；
/// run 级状态仍为 failed。
#[tokio::test(flavor = "multi_thread")]
async fn fail_policy_continue_runs_downstream_with_missing_upstream_aggregated_as_null() {
    let harness = FlowHarness::new(vec![FlowHarness::on(
        "/n-a",
        ReplayBehavior::Fail(FlowError::new(
            FlowErrorKind::Network,
            "upstream unreachable",
        )),
    )]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    node(
                        "a",
                        "httpReplay",
                        json!({
                            "manualRequest": { "method": "GET", "url": "https://t/n-a" },
                            "failPolicy": "continue",
                        }),
                    ),
                    replay_node("b", "https://t/n-b"),
                ],
                vec![edge("s", "a"), edge("a", "b")],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "failed");
    assert_eq!(
        run.summary["error"],
        json!("节点 a 执行失败：upstream unreachable")
    );
    assert_eq!(status_of(&run, "b"), "success");
    assert_eq!(run_of(&run, "b")["input"], json!(null));
    assert_eq!(replay_count(&run), 2);
}

/// 上游：continue + 汇合——失败上游按缺失聚合，仅剩一个成功上游时原样透传。
#[tokio::test(flavor = "multi_thread")]
async fn fail_policy_continue_join_aggregates_only_successful_upstream() {
    let harness = FlowHarness::new(vec![FlowHarness::on(
        "/n-a",
        ReplayBehavior::Fail(FlowError::new(
            FlowErrorKind::Network,
            "upstream unreachable",
        )),
    )]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    node(
                        "a",
                        "httpReplay",
                        json!({
                            "manualRequest": { "method": "GET", "url": "https://t/n-a" },
                            "failPolicy": "continue",
                        }),
                    ),
                    replay_node("c", "https://t/n-c"),
                    replay_node("join", "https://t/n-join"),
                ],
                vec![
                    edge("s", "a"),
                    edge("s", "c"),
                    edge("a", "join"),
                    edge("c", "join"),
                ],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "failed");
    assert_eq!(status_of(&run, "join"), "success");
    // 聚合只含仍成功的上游（单上游回退原样透传）。
    assert_eq!(
        run_of(&run, "join")["input"]["json"]["url"],
        json!("https://t/n-c")
    );
    assert!(run_of(&run, "join")["input"].get("a").is_none());
}

/// 上游：工作流级 defaultFailPolicy 在节点未显式配置时生效；节点级
/// config.failPolicy 优先于工作流级默认。两条子场景分两次运行（同一批内
/// 出现 stop 失败会终止整个调度——continue 下游也会收尾 skipped，见
/// 执行器「stop 的并发停机窗口」语义）。
#[tokio::test(flavor = "multi_thread")]
async fn workflow_default_fail_policy_applies_and_node_level_overrides() {
    // 子场景 1：节点未显式配置 → 继承工作流级 continue，失败后下游仍执行。
    let harness = FlowHarness::new(vec![FlowHarness::on(
        "/n-a",
        ReplayBehavior::Fail(FlowError::new(FlowErrorKind::Network, "a-down")),
    )]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    node(
                        "a",
                        "httpReplay",
                        json!({ "manualRequest": { "method": "GET", "url": "https://t/n-a" } }),
                    ),
                    replay_node("b", "https://t/n-b"),
                ],
                vec![edge("s", "a"), edge("a", "b")],
            ),
            json!({ "defaultFailPolicy": "continue" }),
        )
        .await;
    assert_eq!(run_status(&run), "failed");
    assert_eq!(run.summary["error"], json!("节点 a 执行失败：a-down"));
    assert_eq!(status_of(&run, "b"), "success");

    // 子场景 2：节点显式 stop 覆盖工作流级 continue → 下游不再执行。
    let harness = FlowHarness::new(vec![FlowHarness::on(
        "/n-c",
        ReplayBehavior::Fail(FlowError::new(FlowErrorKind::Network, "c-down")),
    )]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    node(
                        "c",
                        "httpReplay",
                        json!({
                            "manualRequest": { "method": "GET", "url": "https://t/n-c" },
                            "failPolicy": "stop",
                        }),
                    ),
                    replay_node("d", "https://t/n-d"),
                ],
                vec![edge("s", "c"), edge("c", "d")],
            ),
            json!({ "defaultFailPolicy": "continue" }),
        )
        .await;
    assert_eq!(run_status(&run), "failed");
    assert_eq!(run.summary["error"], json!("节点 c 执行失败：c-down"));
    assert_eq!(status_of(&run, "d"), "skipped");
}

/* ------------------------------------------------------------------ *
 * 重试退避（M10-T6）：对齐上游 executor.retry.test.ts
 * ------------------------------------------------------------------ */

/// 上游：retries a failing runner up to maxAttempts and succeeds——前两次重放
/// 失败、第三次成功，节点按成功结算且重放计数为 3。
#[tokio::test(flavor = "multi_thread")]
async fn retry_replays_until_success_within_max_attempts() {
    let harness = FlowHarness::new(vec![FlowHarness::on(
        "/n-a",
        ReplayBehavior::FailFirst(
            Arc::new(AtomicUsize::new(2)),
            Box::new(ReplayBehavior::Echo),
        ),
    )]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    node(
                        "a",
                        "httpReplay",
                        json!({
                            "manualRequest": { "method": "GET", "url": "https://t/n-a" },
                            "retry": { "maxAttempts": 3, "backoffMs": 0 },
                        }),
                    ),
                ],
                vec![edge("s", "a")],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    assert_eq!(status_of(&run, "a"), "success");
    assert_eq!(
        run_of(&run, "a")["output"]["json"]["url"],
        json!("https://t/n-a")
    );
    assert_eq!(replay_count(&run), 3);
}

/// 上游：uses backoff delay and preserves the final error——尝试耗尽后节点
/// failed，错误为最后一次的失败原因，重放计数恰为 maxAttempts。
#[tokio::test(flavor = "multi_thread")]
async fn retry_exhausts_attempts_and_preserves_final_error() {
    let harness = FlowHarness::new(vec![FlowHarness::on(
        "/n-a",
        ReplayBehavior::Fail(FlowError::new(
            FlowErrorKind::Network,
            "upstream unreachable",
        )),
    )]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    node(
                        "a",
                        "httpReplay",
                        json!({
                            "manualRequest": { "method": "GET", "url": "https://t/n-a" },
                            "retry": { "maxAttempts": 2, "backoffMs": 5 },
                        }),
                    ),
                ],
                vec![edge("s", "a")],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "failed");
    assert_eq!(run_of(&run, "a")["error"], json!("upstream unreachable"));
    assert_eq!(
        run.summary["error"],
        json!("节点 a 执行失败：upstream unreachable")
    );
    assert_eq!(replay_count(&run), 2);
}

/// 上游（runWithRetry 结构约定）：loop / delay 自身即长时节点不参与重试——
/// delay 节点配置 retry 也不重复等待（宿主 sleep 只发生一次 1ms 的延时等待）。
#[tokio::test(flavor = "multi_thread")]
async fn retry_does_not_apply_to_delay_nodes() {
    let harness = FlowHarness::new(vec![]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    node(
                        "d",
                        "delay",
                        json!({ "durationMs": 1, "retry": { "maxAttempts": 3 } }),
                    ),
                ],
                vec![edge("s", "d")],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    assert_eq!(status_of(&run, "d"), "success");
    // 恰好一次 1ms 延时等待（取消轮询心跳为 50ms，不在统计内）。
    let delay_waits = run
        .host
        .sleep_durations
        .lock()
        .unwrap()
        .iter()
        .filter(|ms| **ms < 50)
        .count();
    assert_eq!(delay_waits, 1);
}

/* ------------------------------------------------------------------ *
 * 固定输出（M10-T5 pinned data）：对齐上游 executor.pinned-resume.test.ts
 * ------------------------------------------------------------------ */

/// 上游：命中固定的节点不执行 runner，output 取固定值，下游照常执行并聚合
/// 固定值；固定值缺省从 workflow.nodes 的 config.pinnedOutput 投影；事件照发。
#[tokio::test(flavor = "multi_thread")]
async fn pinned_output_from_node_config_skips_execution_and_feeds_downstream() {
    let harness = FlowHarness::new(vec![]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    node(
                        "a",
                        "httpReplay",
                        json!({
                            "manualRequest": { "method": "GET", "url": "https://t/n-a" },
                            "pinnedOutput": {
                                "value": { "token": "pinned" },
                                "pinnedAt": 1,
                                "sourceRunId": "run-src",
                            },
                        }),
                    ),
                    replay_node("b", "https://t/n-b"),
                ],
                vec![edge("s", "a"), edge("a", "b")],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    // a 被固定跳过（不发起重放），b 正常执行。
    assert_eq!(replay_count(&run), 1);
    assert_eq!(status_of(&run, "a"), "success");
    assert_eq!(run_of(&run, "a")["output"], json!({ "token": "pinned" }));
    assert_eq!(run_of(&run, "a")["durationMs"].as_f64(), Some(0.0));
    // b 聚合到 a 的固定输出（单上游透传）。
    assert_eq!(run_of(&run, "b")["input"], json!({ "token": "pinned" }));
    // 事件照发（画布运行态口径与真实执行一致）。
    assert!(event_ids(&run, "node-start").contains(&"a".to_string()));
    assert!(event_ids(&run, "node-finish").contains(&"a".to_string()));
}

/* ------------------------------------------------------------------ *
 * 指定节点重跑（M10-T5 resume，载荷透传口径）：对齐上游
 * executor.pinned-resume.test.ts——上游闭包预置由 Rust 运行编排（Task 19）
 * 经 computeUpstreamClosure 预检后传入，本文件只测载荷内的执行语义。
 * ------------------------------------------------------------------ */

/// 上游：从指定节点起跑——上游闭包预置输出与快照（runner 不再调用），
/// 起点及其下游重新执行，起点 input 为预置输出。
#[tokio::test(flavor = "multi_thread")]
async fn resume_presets_upstream_outputs_and_reruns_from_from_node() {
    let harness = FlowHarness::new(vec![]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    replay_node("a", "https://t/n-a"),
                    replay_node("b", "https://t/n-b"),
                    replay_node("c", "https://t/n-c"),
                ],
                vec![edge("s", "a"), edge("a", "b"), edge("b", "c")],
            ),
            json!({
                "resume": {
                    "fromNode": "b",
                    "outputs": { "s": null, "a": { "token": "from-source-run" } },
                    "nodeRuns": {
                        "s": { "status": "success", "input": null, "output": null, "startedAt": 0, "durationMs": 0 },
                        "a": { "status": "success", "input": null, "output": { "token": "from-source-run" }, "startedAt": 1000, "durationMs": 40 },
                    },
                },
            }),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    // 只有起点及其下游重新执行（a 不再发起重放）。
    let urls: Vec<String> = begin_entries(&run)
        .iter()
        .map(|entry| entry.trim_start_matches("begin:").to_string())
        .collect();
    assert_eq!(
        urls,
        vec!["https://t/n-b".to_string(), "https://t/n-c".to_string()]
    );
    // a 的快照沿用源运行（入参 / 返回值 / 起跑时刻 / 耗时原样保留）。
    let a_run = run_of(&run, "a");
    assert_eq!(a_run["status"], json!("success"));
    assert_eq!(a_run["output"], json!({ "token": "from-source-run" }));
    assert_eq!(a_run["startedAt"].as_f64(), Some(1000.0));
    assert_eq!(a_run["durationMs"].as_f64(), Some(40.0));
    // b 聚合到 a 的预置输出（单上游透传）。
    assert_eq!(
        run_of(&run, "b")["input"],
        json!({ "token": "from-source-run" })
    );
    assert_eq!(status_of(&run, "c"), "success");
}

/// 上游：上游闭包缺输出——载荷内建档前整单判 failed 并逐个列出缺输出的节点，
/// 不执行任何节点（Rust 编排侧（Task 19）另有同型预检，此处为载荷透传语义）。
#[tokio::test(flavor = "multi_thread")]
async fn resume_missing_upstream_output_fails_before_any_node() {
    let harness = FlowHarness::new(vec![]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    replay_node("a", "https://t/n-a"),
                    replay_node("b", "https://t/n-b"),
                ],
                vec![edge("s", "a"), edge("a", "b")],
            ),
            json!({
                "resume": {
                    "fromNode": "b",
                    // 只预置了 s，缺 a（源运行中 a 失败 / 跳过的场景）
                    "outputs": { "s": null },
                    "nodeRuns": {},
                },
            }),
        )
        .await;

    assert_eq!(run_status(&run), "failed");
    let error = run.summary["error"].as_str().unwrap_or_default();
    assert!(
        error.contains("上游节点在源运行中无成功输出"),
        "error: {error}"
    );
    assert!(
        error.contains('a'),
        "error must name the missing node: {error}"
    );
    assert_eq!(replay_count(&run), 0);
    assert_eq!(run.summary["nodeRuns"], json!({}));
}

/* ------------------------------------------------------------------ *
 * 循环（loop）：对齐上游 logic-nodes*.test.ts / run-record.iterations.test.ts
 * 的执行口径（以工作流驱动 runWorkflow，经循环子运行逐轮执行循环体）。
 * ------------------------------------------------------------------ */

/// 循环节点便捷构造。
fn loop_node(config: JsonValue) -> JsonValue {
    node("L", "loop", config)
}

/// 循环节点的迭代明细（LoopIterationsSummary）。
fn iterations_of<'a>(run: &'a FlowRun, id: &str) -> &'a JsonValue {
    &run_of(run, id)["iterations"]
}

/// 上游：逐项执行循环体：每轮写入 var.loop（item / index），聚合为逐轮结果数组；
/// 循环节点快照带逐迭代明细（全部 success），循环体节点快照为「最后一轮」。
/// 观察点 after 以循环体外节点 x 作第二上游（有外部上游的节点不入循环体——
/// 留给父调度器按 join 语义在循环结束后执行一次）。
#[tokio::test(flavor = "multi_thread")]
async fn loop_runs_body_per_round_with_loop_variable_and_aggregates_sink_outputs() {
    let harness = FlowHarness::new(vec![]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    loop_node(json!({ "items": ["i0", "i1", "i2"] })),
                    replay_node("body", "https://t/round-{{ var.loop.item }}"),
                    node("x", "setVariable", json!({ "assignments": [] })),
                    replay_node("after", "https://t/after"),
                ],
                vec![
                    edge("s", "L"),
                    edge("L", "body"),
                    edge("s", "x"),
                    edge("L", "after"),
                    edge("x", "after"),
                ],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    // 逐轮串行执行：重放 url 按 items 序（模板渲染出 var.loop.item）。
    let urls: Vec<String> = begin_entries(&run)
        .iter()
        .map(|entry| entry.trim_start_matches("begin:").to_string())
        .collect();
    // 前三笔 = 循环体逐轮重放（串行按 items 序）；末笔 = 循环结束后的观察点。
    assert_eq!(urls.len(), 4, "urls: {urls:?}");
    assert_eq!(
        &urls[..3],
        &[
            "https://t/round-i0".to_string(),
            "https://t/round-i1".to_string(),
            "https://t/round-i2".to_string(),
        ]
    );
    // 聚合 = 单汇点 body 的逐轮输出（引擎归一化响应，json.url 回显请求 url）。
    let loop_output = run_of(&run, "L")["output"]
        .as_array()
        .expect("loop output array");
    assert_eq!(loop_output.len(), 3);
    for (index, item) in loop_output.iter().enumerate() {
        assert_eq!(
            item["json"]["url"],
            json!(format!("https://t/round-i{index}")),
            "round {index}"
        );
    }
    // 循环体下游（有外部上游的观察点）在循环结束后按 join 语义执行一次：
    // input 聚合 { L: 逐轮结果数组, x: 外部节点输出 }。
    assert_eq!(status_of(&run, "after"), "success");
    let after_input = &run_of(&run, "after")["input"];
    let after_loop_input = after_input["L"].as_array().expect("loop results array");
    assert_eq!(after_loop_input.len(), 3);
    assert!(
        after_input.get("x").is_some(),
        "external upstream key present"
    );
    // 逐迭代明细：total / done / capped / records 全 success 且按 index 升序。
    let iterations = iterations_of(&run, "L");
    assert_eq!(iterations["total"].as_i64(), Some(3));
    assert_eq!(iterations["done"].as_i64(), Some(3));
    assert_eq!(iterations["capped"], json!(false));
    assert_eq!(iterations["truncated"], json!(false));
    let records = iterations["records"].as_array().expect("records array");
    assert_eq!(records.len(), 3);
    for (index, record) in records.iter().enumerate() {
        assert_eq!(record["index"].as_i64(), Some(index as i64));
        assert_eq!(record["item"], json!(format!("i{index}")));
        assert_eq!(record["status"], json!("success"));
        assert_eq!(
            record["output"]["json"]["url"],
            json!(format!("https://t/round-i{index}"))
        );
    }
    // 循环体节点快照 = 「最后一轮」执行（经 nestedNodeRun 代替统一 skipped）。
    assert_eq!(status_of(&run, "body"), "success");
    assert_eq!(
        run_of(&run, "body")["output"]["json"]["url"],
        json!("https://t/round-i2")
    );
}

/// 上游（loop-concurrency）：并发迭代互不覆盖——setVariable 写入与 var.loop
/// 走各自 overlay，结束后合并回父层；三轮各自读到自己的 item。
#[tokio::test(flavor = "multi_thread")]
async fn loop_concurrent_rounds_isolate_variable_scope() {
    let harness = FlowHarness::new(vec![]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    loop_node(json!({ "items": ["i0", "i1", "i2"], "concurrency": 3 })),
                    node(
                        "sv",
                        "setVariable",
                        json!({
                            "assignments": [
                                { "name": "seen", "from": "var", "path": "loop.item" },
                            ],
                        }),
                    ),
                    replay_node("sink", "https://t/seen-{{ var.seen }}"),
                ],
                vec![edge("s", "L"), edge("L", "sv"), edge("sv", "sink")],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    // 并发三轮各自可见自己的 item（url 集合 = 三轮各自写入的 seen 值）。
    let mut urls: Vec<String> = begin_entries(&run)
        .iter()
        .map(|entry| entry.trim_start_matches("begin:").to_string())
        .collect();
    urls.sort();
    assert_eq!(
        urls,
        vec![
            "https://t/seen-i0".to_string(),
            "https://t/seen-i1".to_string(),
            "https://t/seen-i2".to_string(),
        ]
    );
    // 逐轮聚合齐全（单汇点 sink，三轮输出）。
    let loop_output = run_of(&run, "L")["output"]
        .as_array()
        .expect("loop output array");
    assert_eq!(loop_output.len(), 3);
    let iterations = iterations_of(&run, "L");
    assert_eq!(iterations["done"].as_i64(), Some(3));
    for record in iterations["records"].as_array().expect("records") {
        assert_eq!(record["status"], json!("success"));
    }
}

/// 上游：迭代上限——items 超出 maxIterations 按长度截断（不视为错误），
/// capped 标注如实置位。
#[tokio::test(flavor = "multi_thread")]
async fn loop_caps_iterations_at_max_iterations_without_error() {
    let harness = FlowHarness::new(vec![]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    loop_node(json!({
                        "items": ["i0", "i1", "i2", "i3", "i4"],
                        "maxIterations": 2,
                    })),
                    replay_node("body", "https://t/round-{{ var.loop.item }}"),
                ],
                vec![edge("s", "L"), edge("L", "body")],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    assert_eq!(replay_count(&run), 2);
    let loop_output = run_of(&run, "L")["output"]
        .as_array()
        .expect("loop output array");
    assert_eq!(loop_output.len(), 2);
    let iterations = iterations_of(&run, "L");
    assert_eq!(iterations["total"].as_i64(), Some(2));
    assert_eq!(iterations["done"].as_i64(), Some(2));
    assert_eq!(iterations["capped"], json!(true));
    let records = iterations["records"].as_array().expect("records array");
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["item"], json!("i0"));
    assert_eq!(records[1]["item"], json!("i1"));
}

/// 上游：多汇点聚合——逐轮结果为 { <汇点 id>: output } 组对象（单汇点原样、
/// 多汇点分组、由 collectIterationResult 决定）。
#[tokio::test(flavor = "multi_thread")]
async fn loop_aggregates_multiple_sinks_grouped_by_node_id() {
    let harness = FlowHarness::new(vec![]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    loop_node(json!({ "items": ["x"] })),
                    replay_node("entry", "https://t/body-{{ var.loop.item }}"),
                    replay_node("s1", "https://t/sink-1-{{ var.loop.item }}"),
                    replay_node("s2", "https://t/sink-2-{{ var.loop.item }}"),
                ],
                vec![
                    edge("s", "L"),
                    edge("L", "entry"),
                    edge("entry", "s1"),
                    edge("entry", "s2"),
                ],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    assert_eq!(replay_count(&run), 3);
    // 单轮多汇点：逐轮结果为按汇点 id 分组的对象。
    let loop_output = run_of(&run, "L")["output"]
        .as_array()
        .expect("loop output array");
    assert_eq!(loop_output.len(), 1);
    let round = &loop_output[0];
    assert_eq!(
        round["s1"]["json"]["url"],
        json!("https://t/sink-1-x"),
        "round: {round}"
    );
    assert_eq!(round["s2"]["json"]["url"], json!("https://t/sink-2-x"));
}

/// 上游（M13-T9）：逐迭代明细条数超 LOOP_ITERATIONS_MAX_RECORDS（100）时按
/// index 升序保留前段并置 truncated；进度（total / done）不因明细截断失真。
#[tokio::test(flavor = "multi_thread")]
async fn loop_iteration_records_truncated_at_max_records() {
    let items: Vec<JsonValue> = (0..102).map(|index| json!(format!("i{index}"))).collect();
    let harness = FlowHarness::new(vec![]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    loop_node(json!({ "items": items, "maxIterations": 102 })),
                    // 体内纯 setVariable（零重放，快跑 102 轮子运行）
                    node("sv", "setVariable", json!({ "assignments": [] })),
                ],
                vec![edge("s", "L"), edge("L", "sv")],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    let loop_output = run_of(&run, "L")["output"]
        .as_array()
        .expect("loop output array");
    assert_eq!(loop_output.len(), 102);
    let iterations = iterations_of(&run, "L");
    assert_eq!(iterations["total"].as_i64(), Some(102));
    assert_eq!(iterations["done"].as_i64(), Some(102));
    assert_eq!(iterations["capped"], json!(false));
    assert_eq!(iterations["truncated"], json!(true));
    let records = iterations["records"].as_array().expect("records array");
    assert_eq!(records.len(), 100);
    // 保留前段：records[0] 是第 0 轮。
    assert_eq!(records[0]["index"].as_i64(), Some(0));
    assert_eq!(records[0]["status"], json!("success"));
}

/// 上游（取消感知）：取消时已完成轮次照常结算——第一轮完整保留，取消轮记
/// cancelled 且不聚合，后续轮次不再执行；run = cancelled（取消优先）。
/// 观察点 after 以循环体外节点 x 作第二上游（不入循环体；取消后收尾 skipped）。
#[tokio::test(flavor = "multi_thread")]
async fn loop_cancel_settles_completed_rounds_and_run_reports_cancelled() {
    let harness = FlowHarness::new(vec![FlowHarness::on(
        "round-2",
        ReplayBehavior::CancelThen(120, Box::new(ReplayBehavior::Echo)),
    )]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    loop_node(json!({ "items": [1, 2, 3] })),
                    replay_node("body", "https://t/round-{{ var.loop.item }}"),
                    node("x", "setVariable", json!({ "assignments": [] })),
                    replay_node("after", "https://t/after"),
                ],
                vec![
                    edge("s", "L"),
                    edge("L", "body"),
                    edge("s", "x"),
                    edge("L", "after"),
                    edge("x", "after"),
                ],
            ),
            json!({}),
        )
        .await;

    // 取消优先于失败：执行器停止调度新节点，run = cancelled。
    assert_eq!(run_status(&run), "cancelled");
    assert_eq!(run.summary["error"], json!("运行已被取消"));
    // 已开始轮次自然结算：只有第 1、2 轮发起了重放（第 3 轮未启动）。
    assert_eq!(replay_count(&run), 2);
    // loop 节点以已完成轮次聚合照常返回（success），其下游收尾 skipped。
    assert_eq!(status_of(&run, "L"), "success");
    assert_eq!(status_of(&run, "after"), "skipped");
    let loop_output = run_of(&run, "L")["output"]
        .as_array()
        .expect("loop output array");
    assert_eq!(loop_output.len(), 1, "only the settled round aggregates");
    assert_eq!(loop_output[0]["json"]["url"], json!("https://t/round-1"));
    // 逐迭代明细如实记录：第 1 轮 success、第 2 轮 cancelled（已开始未跑完）。
    let iterations = iterations_of(&run, "L");
    assert_eq!(iterations["total"].as_i64(), Some(3));
    assert_eq!(iterations["done"].as_i64(), Some(2));
    let records = iterations["records"].as_array().expect("records array");
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["index"].as_i64(), Some(0));
    assert_eq!(records[0]["status"], json!("success"));
    assert_eq!(records[1]["index"].as_i64(), Some(1));
    assert_eq!(records[1]["status"], json!("cancelled"));
    assert_eq!(records[1]["output"], json!(null));
}

/// 上游：空数据源——零轮迭代，输出空数组，循环体不执行。
#[tokio::test(flavor = "multi_thread")]
async fn loop_with_empty_items_runs_zero_rounds() {
    let harness = FlowHarness::new(vec![]);
    let run = harness
        .run(
            workflow(
                vec![
                    start_node(),
                    loop_node(json!({ "items": [] })),
                    replay_node("body", "https://t/round-{{ var.loop.item }}"),
                ],
                vec![edge("s", "L"), edge("L", "body")],
            ),
            json!({}),
        )
        .await;

    assert_eq!(run_status(&run), "success");
    assert_eq!(replay_count(&run), 0);
    assert_eq!(run_of(&run, "L")["output"], json!([]));
    let iterations = iterations_of(&run, "L");
    assert_eq!(iterations["total"].as_i64(), Some(0));
    assert_eq!(iterations["done"].as_i64(), Some(0));
    assert_eq!(iterations["records"], json!([]));
    assert_eq!(iterations["truncated"], json!(false));
}
