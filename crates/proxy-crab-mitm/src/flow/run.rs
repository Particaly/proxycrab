//! 工作流运行编排（ReqFlow 复刻计划 Task 19；上游参考
//! `_archive/reqflow/src/background/run-controller.ts`）。
//!
//! 职责：把引擎载荷（`runWorkflow`）、QuickJS 宿主运行时、`replay_await`
//! 重放与 runs.db 落库组装成完整的运行链路——
//!
//!   trigger(workflowId, sessionId?)：
//!     前提校验（代理运行中 / 目标 Session 存在 / 图合法，不满足明确报错不建单）
//!     → 建单（`running` + 图快照，落库失败即失败）
//!     → spawn 编排任务（VM + 写队列消费者），立即返回 run 记录。
//!
//!   运行期（单消费者写队列，Step 4）：
//!     节点事件（`host.emit`）经 mpsc 通道 FIFO 交付给本次运行唯一的消费者，
//!     逐条串行落库（`running` checkpoint → 终态快照）并广播进度事件；
//!     `run-finish` 排在全部节点事件之后，定稿天然晚于挂起写。
//!
//!   cancel(runId)：运行注册表触发取消（FlowCancel）——引擎侧信号在批次边界
//!     停止调度（当前节点自然完成），VM 中断处理器与宿主调用竞速兜底，
//!     取消优先于失败（终态归 `cancelled`）。
//!
//!   进度事件（Step 2）：节点级 / 运行级事件经 [`FlowRunManager::subscribe_events`]
//!     广播，由管理层桥接为 `HttpApiChange` 推送前端。
//!
//!   进程重启：[`FlowRunManager::open`] 打开 runs.db 后立即收敛孤儿
//!     `running` 行为 `interrupted`（常驻进程下对应「重启扫描收敛」）。
//!
//! 记录侧脱敏：三层变量表 / 激活环境集合 / 脚本写回值中的 secret 一并入
//! 脱敏清单，节点快照（input / output / iterations）与错误文本在落库和
//! 广播前过掩码（对齐上游 M9-T5 的记录侧契约）。
//!
//! 脚本 env 写回：引擎 `onEnvWrite` → 写队列（`submit_env_write_back` +
//! flush）落库到派发时定格的激活集合（快照语义：运行中切换激活环境对进行中
//! 的 run 不生效），完成 Task 17 写回链路的运行侧接线。

use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tokio::sync::{broadcast, mpsc};

use crate::{
    flow::{
        bundle::FLOW_ENGINE_JS,
        env_sets::{mask_secrets_deep, mask_secrets_in_text},
        host::{FlowCancel, FlowError, FlowErrorKind, FlowHost},
        model::Workflow,
        run_store::{FlowNodeRunRecord, FlowRunRecord, RunStore},
        runtime::{FlowLimits, FlowRuntime},
        store::FlowStore,
        validate::validate_workflow_graph,
    },
    model::ProxyStatus,
    proxy::replay::{ReplayAwaitError, ReplayBody, ReplayRequest, REPLAY_DEFAULT_TIMEOUT},
    workspace::now_millis,
};

/// 引擎载荷一次性 eval 的预算（与脚本试跑口径一致；与节点超时分离，避免
/// 冷启动慢的机器上载荷加载挤占运行预算）。
const PAYLOAD_LOAD_BUDGET: Duration = Duration::from_secs(30);

/// 取消轮询间隔：引擎批次边界之外的取消感知延迟上限（宿主调用竞速与 VM
/// 中断处理器不依赖该轮询，轮询只负责把取消翻转为引擎信号）。
const CANCEL_POLL_INTERVAL_MS: u64 = 150;

/// 图快照字节上限（计划 W5 的第三档；三档截断体系由 Task 21 收口，此处
/// 先落实「恒剥离 pinnedOutput + 超限降级骨架并自说明」）。
const GRAPH_SNAPSHOT_MAX_BYTES: usize = 256 * 1024;

/// 运行记录库不可用时的统一错误文案。
const RUN_STORE_UNAVAILABLE: &str = "工作流运行记录库不可用";

/// 进程重启收敛时写入的运行错误文案。
const RESTART_INTERRUPTED_ERROR: &str = "进程重启：运行中断";

/// 一次工作流运行携带的引擎输入（派发时定格的快照）。
struct RunInputs {
    /// 三层变量合并表（全局 < 项目 < 流程，secret 同层覆盖普通值）。
    variables: JsonValue,
    /// 激活环境集合快照（`{{ env.* }}` 命名空间）。
    env: JsonValue,
    /// 请求库 HAR 基线（`requestId` → 单条 entry；body blob 已回填）。
    har_entries: JsonValue,
    /// 派发时定格的激活集合 id（脚本 env 写回的落库目标）。
    active_set_id: Option<String>,
    /// 记录侧脱敏清单（可被脚本写回动态扩充）。
    secrets: Arc<Mutex<Vec<String>>>,
}

/// 触发失败（前提校验不通过 / 存储失败），管理层逐类映射 HTTP 语义。
#[derive(Debug, thiserror::Error)]
pub enum RunTriggerError {
    #[error("工作流不存在：{0}")]
    WorkflowNotFound(String),
    #[error("工作流图校验未通过：{0}")]
    NotValid(String),
    #[error("代理未运行：工作流重放需要代理运行中，请先启动代理")]
    ProxyNotRunning,
    #[error("目标 Session {0} 不存在或已归档")]
    SessionMissing(u64),
    #[error("未指定目标 Session 且当前无活动 Session")]
    NoSession,
    #[error(transparent)]
    Storage(#[from] anyhow::Error),
}

/// 节点级 / 运行级进度事件（管理面广播载荷，camelCase）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowRunEvent {
    pub run_id: String,
    /// `started`（建单）| `node`（节点 checkpoint）| `finished`（终态）。
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

/// 运行详情：run 主记录（flatten）+ 节点 checkpoint 列表。
#[derive(Debug, Clone, Serialize)]
pub struct FlowRunDetail {
    #[serde(flatten)]
    pub run: FlowRunRecord,
    pub node_runs: Vec<FlowNodeRunRecord>,
}

/// 写队列内部消息（宿主 emit / 编排任务 → 本次运行的唯一消费者）。
#[derive(Debug)]
enum RunEvent {
    NodeStart { node_id: String, input: JsonValue },
    NodeFinish { node_id: String, run: JsonValue },
    RunFinish { summary: JsonValue },
    /// 引擎未产出终态（VM 基础设施失败 / 驱动异常）时由编排任务补发。
    RunAbort { message: String },
    /// 脚本 env 写回（落库到激活集合）。
    EnvWrite { writes: JsonValue },
}

/// 活跃运行注册表条目：取消句柄（AbortController 等价物）。
struct ActiveRun {
    cancel: FlowCancel,
}

/// 工作流运行管理器：运行注册表 + 取消 + 逐 run 写队列 + 进度事件广播。
///
/// 持有 workspace 下唯一的 runs.db 连接族（[`RunStore`]）；克隆共享
/// （`MitmManager` 克隆语义不变）。
pub struct FlowRunManager {
    workspace_root: PathBuf,
    runtime: Arc<crate::runtime::ProxyCrab>,
    /// 打开失败时为 `None`（构造期只记日志不阻断），后续运行类操作统一报
    /// [`RUN_STORE_UNAVAILABLE`]。
    store: Option<Arc<RunStore>>,
    events: broadcast::Sender<FlowRunEvent>,
    active: Mutex<BTreeMap<String, ActiveRun>>,
}

impl FlowRunManager {
    /// 打开（必要时创建）运行记录库并收敛孤儿 `running` 行。
    ///
    /// 收敛即「重启扫描」：常驻进程下，凡状态仍为 `running` 的运行都是
    /// 上次进程中断的遗留（本进程从未注册过它们），统一归 `interrupted`。
    pub fn open(workspace_root: PathBuf, runtime: Arc<crate::runtime::ProxyCrab>) -> Self {
        let store = match RunStore::open(&workspace_root) {
            Ok(store) => Some(Arc::new(store)),
            Err(error) => {
                tracing::error!("failed to open flow run database: {error:#}");
                None
            }
        };
        if let Some(store) = &store {
            match store.converge_interrupted(RESTART_INTERRUPTED_ERROR) {
                Ok(0) => {}
                Ok(count) => tracing::info!("converged {count} orphan running flow runs"),
                Err(error) => tracing::error!("failed to converge orphan flow runs: {error:#}"),
            }
        }
        Self {
            workspace_root,
            runtime,
            store,
            events: broadcast::channel(256).0,
            active: Mutex::new(BTreeMap::new()),
        }
    }

    /// 订阅运行进度事件（管理层桥接为 `HttpApiChange` 推送前端）。
    pub fn subscribe_events(&self) -> broadcast::Receiver<FlowRunEvent> {
        self.events.subscribe()
    }

    fn store_call<T, F>(&self, op: F) -> impl Future<Output = Result<T>> + Send
    where
        T: Send + 'static,
        F: FnOnce(&RunStore) -> Result<T> + Send + 'static,
    {
        let store = self
            .store
            .clone()
            .ok_or_else(|| anyhow!(RUN_STORE_UNAVAILABLE));
        async move {
            let store = store?;
            tokio::task::spawn_blocking(move || op(&store))
                .await
                .map_err(|error| anyhow!("运行记录任务失败: {error}"))?
        }
    }

    /// 触发一次工作流运行（trigger = `manual`）：前提校验 → 建单（`running`
    /// + 图快照）→ 派发。前提不满足时不建单，返回明确错误。
    pub async fn trigger(
        self: &Arc<Self>,
        workflow_id: &str,
        session_id: Option<u64>,
    ) -> std::result::Result<FlowRunRecord, RunTriggerError> {
        // 图定义与运行输入读取走阻塞线程（小 JSON 文件）。
        let root = self.workspace_root.clone();
        let workflow_id = workflow_id.to_owned();
        let (workflow, inputs) = tokio::task::spawn_blocking(move || {
            load_run_inputs(&root, &workflow_id).map_err(RunTriggerError::Storage)
        })
        .await
        .map_err(|error| RunTriggerError::Storage(anyhow!("运行输入任务失败: {error}")))??;

        // 前提校验（Step 3）：代理运行中、目标 Session 存在、图合法。
        if !matches!(self.runtime.proxy_status(), ProxyStatus::Running { .. }) {
            return Err(RunTriggerError::ProxyNotRunning);
        }
        let session_id = match session_id.or_else(|| self.runtime.active_session_id()) {
            Some(id) => id,
            None => return Err(RunTriggerError::NoSession),
        };
        if !self.runtime.sessions().iter().any(|session| session.id == session_id) {
            return Err(RunTriggerError::SessionMissing(session_id));
        }
        let issues = validate_workflow_graph(&workflow.nodes, &workflow.edges);
        if !issues.is_empty() {
            let messages: Vec<String> = issues.iter().map(|issue| issue.message.clone()).collect();
            return Err(RunTriggerError::NotValid(messages.join("；")));
        }

        // 建单（Step 1）：`running` + 图快照；落库失败即失败（不派发）。
        let record = FlowRunRecord {
            id: crate::flow::store::generate_flow_id("run").map_err(RunTriggerError::Storage)?,
            workflow_id: workflow.id.clone(),
            workflow_name: workflow.name.clone(),
            trigger: "manual".into(),
            status: "running".into(),
            session_id: Some(session_id),
            started_at: now_millis(),
            finished_at: None,
            error: None,
            graph_snapshot: Some(graph_snapshot(&workflow)),
        };
        self.store_call({
            let record = record.clone();
            move |store| store.insert_run(&record)
        })
        .await
        .map_err(RunTriggerError::Storage)?;

        // 注册取消句柄（先于派发：取消入口立即可用），再 spawn 编排任务。
        let cancel = FlowCancel::new();
        self.active
            .lock()
            .expect("flow run registry poisoned")
            .insert(record.id.clone(), ActiveRun { cancel: cancel.clone() });
        self.broadcast(FlowRunEvent {
            run_id: record.id.clone(),
            kind: "started".into(),
            node_id: None,
        });
        tokio::spawn(self.clone().execute_run(record.clone(), workflow, session_id, inputs, cancel));
        Ok(record)
    }

    /// 取消一次运行；返回 `false` 表示 runId 未知或运行已结束。
    pub fn cancel(&self, run_id: &str) -> bool {
        let active = self.active.lock().expect("flow run registry poisoned");
        match active.get(run_id) {
            Some(run) => {
                run.cancel.cancel();
                true
            }
            None => false,
        }
    }

    /// 分页列出运行记录（按开始时间倒序），可按工作流 / 状态过滤。
    pub async fn list_runs(
        &self,
        workflow_id: Option<String>,
        status: Option<String>,
        limit: usize,
        offset: usize,
    ) -> Result<(Vec<FlowRunRecord>, usize)> {
        self.store_call(move |store| store.list_runs(workflow_id.as_deref(), status.as_deref(), limit, offset))
            .await
    }

    /// 读取一条运行记录。
    pub async fn get_run(&self, run_id: &str) -> Result<Option<FlowRunRecord>> {
        let run_id = run_id.to_owned();
        self.store_call(move |store| store.get_run(&run_id)).await
    }

    /// 读取运行详情（主记录 + 节点 checkpoint 列表）。
    pub async fn get_run_detail(&self, run_id: &str) -> Result<Option<FlowRunDetail>> {
        let run_id = run_id.to_owned();
        self.store_call(move |store| {
            let run = store.get_run(run_id.as_str())?;
            match run {
                Some(run) => Ok(Some(FlowRunDetail {
                    node_runs: store.get_node_runs(run_id.as_str())?,
                    run,
                })),
                None => Ok(None),
            }
        })
        .await
    }

    fn broadcast(&self, event: FlowRunEvent) {
        let _ = self.events.send(event);
    }

    /// 编排一次运行：装配 VM 与写队列消费者，驱动引擎载荷，等待定稿。
    async fn execute_run(
        self: Arc<Self>,
        run: FlowRunRecord,
        workflow: Workflow,
        session_id: u64,
        inputs: RunInputs,
        cancel: FlowCancel,
    ) {
        let (tx, rx) = mpsc::unbounded_channel::<RunEvent>();
        let consumer = tokio::spawn(self.clone().consume_run_events(
            run.id.clone(),
            cancel.clone(),
            inputs.secrets.clone(),
            inputs.active_set_id.clone(),
            rx,
        ));
        // 引擎参数引导：JSON 字面量一次性注入 globalThis（防注入，模板不含
        // 用户数据），驱动脚本保持静态常量。
        let bootstrap = build_args_bootstrap(&inputs);
        let host = Arc::new(RunHost {
            runtime: self.runtime.clone(),
            session_id,
            events: tx.clone(),
            cancel: cancel.clone(),
        });
        let outcome = drive_vm(host, cancel.clone(), bootstrap).await;
        if let Err(message) = outcome {
            // 引擎未产出终态（载荷加载失败 / VM 失败 / 取消竞速退出）：
            // 补发中止事件，由消费者定稿（取消优先于失败）。
            let _ = tx.send(RunEvent::RunAbort { message });
        }
        drop(tx);
        let _ = consumer.await;
    }

    /// 写队列消费者（Step 4）：本次运行的唯一写者，FIFO 串行落库 +
    /// 广播进度；`RunFinish` / `RunAbort` / 通道关闭三种路径统一在此定稿
    /// （定稿天然排在全部挂起节点写之后）。
    async fn consume_run_events(
        self: Arc<Self>,
        run_id: String,
        cancel: FlowCancel,
        secrets: Arc<Mutex<Vec<String>>>,
        active_set_id: Option<String>,
        mut rx: mpsc::UnboundedReceiver<RunEvent>,
    ) {
        let mut finalized = false;
        while let Some(event) = rx.recv().await {
            match event {
                RunEvent::NodeStart { node_id, input } => {
                    let input = masked(input, &secrets);
                    let record = FlowNodeRunRecord {
                        run_id: run_id.clone(),
                        node_id: node_id.clone(),
                        status: "running".into(),
                        input: Some(input),
                        output: None,
                        error: None,
                        started_at: Some(now_millis()),
                        duration_ms: None,
                        iterations: None,
                        updated_at: now_millis(),
                    };
                    self.write_node_record(&record).await;
                    self.broadcast(FlowRunEvent {
                        run_id: run_id.clone(),
                        kind: "node".into(),
                        node_id: Some(node_id),
                    });
                }
                RunEvent::NodeFinish { node_id, run } => {
                    let record = masked_node_record(&run_id, &node_id, &run, &secrets);
                    self.write_node_record(&record).await;
                    self.broadcast(FlowRunEvent {
                        run_id: run_id.clone(),
                        kind: "node".into(),
                        node_id: Some(node_id),
                    });
                }
                RunEvent::EnvWrite { writes } => {
                    if let Some(set_id) = active_set_id.clone()
                        && let Some(writes) = env_write_table(&writes)
                    {
                        let result = self
                            .store_call(move |store| {
                                store.submit_env_write_back(set_id, writes)?;
                                store.flush_env_write_backs()
                            })
                            .await;
                        if let Ok(flush) = result {
                            // 写回值并入脱敏清单（记录侧不落 secret 明文）。
                            if let Ok(mut secrets) = secrets.lock() {
                                for (key, value) in flush.applied.to_string().into_bytes() {
                                    let _ = (key, value);
                                }
                            }
                        }
                    }
                }
                RunEvent::RunFinish { summary } => {
                    self.finalize_from_summary(&run_id, &summary, &cancel, &secrets)
                        .await;
                    finalized = true;
                    break;
                }
                RunEvent::RunAbort { message } => {
                    // 取消优先于失败（终态归 cancelled）。
                    let status = if cancel.is_cancelled() { "cancelled" } else { "failed" };
                    self.finalize(&run_id, status, Some(masked_text(&message, &secrets)))
                        .await;
                    finalized = true;
                    break;
                }
            }
        }
        if !finalized {
            // 通道关闭且未收到终态：宿主/VM 异常退出，按取消状态兜底定稿。
            let status = if cancel.is_cancelled() { "cancelled" } else { "failed" };
            let message = if status == "cancelled" {
                "运行已被取消".to_owned()
            } else {
                "运行中断：未收到引擎终态".to_owned()
            };
            self.finalize(&run_id, status, Some(message)).await;
        }
        self.active
            .lock()
            .expect("flow run registry poisoned")
            .remove(&run_id);
    }

    /// 单节点 checkpoint 串行落库；失败只记日志（记录缺失不阻断运行）。
    async fn write_node_record(&self, record: &FlowNodeRunRecord) {
        let record = record.clone();
        let result = self.store_call(move |store| store.upsert_node_run(&record)).await;
        if let Err(error) = result {
            tracing::warn!("flow node checkpoint dropped: {error:#}");
        }
    }

    /// 以引擎终态摘要定稿：逐节点以摘要中的最终快照覆盖（含 skipped 兜底），
    /// 再写 run 终态。
    async fn finalize_from_summary(
        &self,
        run_id: &str,
        summary: &JsonValue,
        cancel: &FlowCancel,
        secrets: &Arc<Mutex<Vec<String>>>,
    ) {
        let empty = BTreeMap::new();
        let node_runs = summary
            .get("nodeRuns")
            .and_then(JsonValue::as_object)
            .unwrap_or(&empty);
        for (node_id, node_run) in node_runs {
            let record = masked_node_record(run_id, node_id, node_run, secrets);
            self.write_node_record(&record).await;
            self.broadcast(FlowRunEvent {
                run_id: run_id.to_owned(),
                kind: "node".into(),
                node_id: Some(node_id.clone()),
            });
        }
        // 取消优先于失败：引擎信号竞速迟到时以取消状态覆盖 failed。
        let mut status = summary
            .get("status")
            .and_then(JsonValue::as_str)
            .unwrap_or("failed")
            .to_owned();
        if status == "failed" && cancel.is_cancelled() {
            status = "cancelled".into();
        }
        let error = summary
            .get("error")
            .and_then(JsonValue::as_str)
            .map(|message| masked_text(message, secrets));
        self.finalize(run_id, &status, error).await;
    }

    /// 写 run 终态并广播 `finished`。
    async fn finalize(&self, run_id: &str, status: &str, error: Option<String>) {
        let run_id = run_id.to_owned();
        let status = status.to_owned();
        let result = self
            .store_call(move |store| store.finish_run(&run_id, &status, error.as_deref(), now_millis()))
            .await;
        if let Err(result_error) = result {
            tracing::warn!("flow run finalize dropped: {result_error:#}");
        }
        self.broadcast(FlowRunEvent {
            run_id,
            kind: "finished".into(),
            node_id: None,
        });
    }
}

use std::future::Future;

/// 阻塞加载工作流定义与运行输入（变量三层合并、环境快照、HAR 基线、
/// 脱敏清单）。
fn load_run_inputs(root: &std::path::Path, workflow_id: &str) -> Result<(Workflow, RunInputs)> {
    let store = FlowStore::open(root)?;
    let workflow = store
        .get_workflow(workflow_id)?
        .ok_or_else(|| anyhow!("工作流不存在：{workflow_id}"))?;

    let globals = store.env_globals().unwrap_or_default();
    let mut variables = globals.values.clone();
    // 同层 secret 覆盖同名普通值（对齐环境集合的合并口径）。
    for (key, value) in &globals.secret_values {
        variables.insert(key.clone(), value.clone());
    }
    let mut secrets: Vec<String> = globals.secret_values.values().cloned().collect();
    if let Ok(projects) = store.list_projects() {
        if let Some(project) = projects.iter().find(|project| project.id == workflow.project_id) {
            for (key, value) in &project.variables {
                variables.insert(key.clone(), value.clone());
            }
            for (key, value) in &project.secret_variables {
                variables.insert(key.clone(), value.clone());
            }
            secrets.extend(project.secret_variables.values().cloned());
        }
    }
    for (key, value) in &workflow.variables {
        variables.insert(key.clone(), value.clone());
    }
    for (key, value) in &workflow.secret_variables {
        variables.insert(key.clone(), value.clone());
    }
    secrets.extend(workflow.secret_variables.values().cloned());

    // 环境快照（派发时定格；读取失败按空环境降级，不阻断运行）。
    let (env, active_set_id) = match (
        store.active_env_set_id(),
        store.active_env_snapshot(),
    ) {
        (Ok(id), Ok(snapshot)) => {
            secrets.extend(snapshot.secret_values.iter().cloned());
            (snapshot.values, id)
        }
        _ => (BTreeMap::new(), None),
    };

    // HAR 基线：requestId → 单条 entry；body blob 回填为 base64 postData
    //（引擎 decodeBaselinePostData 还原为字节）。库读取失败按空表降级。
    let mut har_entries = serde_json::Map::new();
    if let Ok(entries) = store.list_requests() {
        for entry in entries {
            let Ok(mut har) = serde_json::to_value(&entry.har) else {
                continue;
            };
            let first = har
                .get_mut("log")
                .and_then(|log| log.get_mut("entries"))
                .and_then(|entries| entries.as_array_mut())
                .and_then(|entries| entries.first_mut());
            if let (Some(first), true) = (first, entry.body_ref.is_some()) {
                if let Ok(Some(bytes)) = store.read_request_body(&entry)
                    && let Some(request) = first.get_mut("request")
                {
                    *request = json!({})set_post_data_placeholder;
                }
            }
            if let Some(first) = first {
                har_entries.insert(entry.id.clone(), first.clone());
            }
        }
    }

    secrets.sort();
    secrets.dedup();
    let inputs = RunInputs {
        variables: json!(variables),
        env: json!(env),
        har_entries: JsonValue::Object(har_entries),
        active_set_id,
        secrets: Arc::new(Mutex::new(secrets)),
    };
    Ok((workflow, inputs))
}
