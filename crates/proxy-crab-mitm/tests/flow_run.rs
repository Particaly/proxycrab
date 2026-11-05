//! 工作流运行编排（ReqFlow 复刻计划 Task 19 薄片 A）集成测试。
//!
//! 走真实引擎载荷 + [`proxy_crab_mitm::flow::run::FlowRunManager`] 公开面，覆盖：
//! 1. 建单（`running` + 图快照）→ 逐节点 checkpoint → 定稿（Step 1 生命周期）；
//! 2. 取消优先于失败（运行注册表 → 终态归 `cancelled`）；
//! 3. 写队列串行化：并行分支的并发 checkpoint 经单消费者 FIFO 落库，
//!    终态记录完整且 `finished` 恒为最后一个事件（Step 4）；
//! 4. `converge_interrupted` 重启收敛孤儿 `running` 行（Step 5 本仓可测面）；
//! 5. 前提校验不满足时明确报错且不建单。
//!
//! 测试工作流只含纯逻辑节点（start / delay），不发起真实出站请求。

mod flow_run {
    use std::{path::Path, sync::Arc, time::Duration};

    use proxy_crab_mitm::{
        ProxyCrab,
        flow::{
            model::{NodeConfig, Position, Workflow, WorkflowEdge, WorkflowNode, WorkflowNodeType},
            run::{FlowRunEvent, FlowRunManager, RunTriggerError},
            run_store::{FlowRunRecord, RunStore},
            store::{FlowStore, generate_flow_id},
        },
        log_buffer::LogBuffer,
        model::NewSession,
    };
    use tempfile::{TempDir, tempdir};
    use tokio::{sync::broadcast, time::timeout};

    /// 运行终态等待上限（取消路径含轮询感知延迟，留足余量）。
    const SETTLE_TIMEOUT: Duration = Duration::from_secs(20);

    fn unused_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn node(id: &str, node_type: WorkflowNodeType, config: NodeConfig) -> WorkflowNode {
        WorkflowNode {
            id: id.to_owned(),
            node_type,
            position: Position { x: 0.0, y: 0.0 },
            config,
            label: None,
            ref_id: None,
        }
    }

    fn edge(id: &str, source: &str, target: &str) -> WorkflowEdge {
        WorkflowEdge {
            id: id.to_owned(),
            source: source.to_owned(),
            target: target.to_owned(),
            source_handle: None,
        }
    }

    fn workflow(nodes: Vec<WorkflowNode>, edges: Vec<WorkflowEdge>) -> Workflow {
        Workflow {
            id: generate_flow_id("wf").unwrap(),
            project_id: "proj".into(),
            name: "run-test".into(),
            description: String::new(),
            nodes,
            edges,
            variables: Default::default(),
            secret_variables: Default::default(),
            schema_version: 1,
            created_at: 1,
            updated_at: 2,
        }
    }

    fn delay_config(ms: u64) -> NodeConfig {
        NodeConfig {
            duration_ms: Some(ms),
            ..NodeConfig::default()
        }
    }

    /// 起一个代理运行中的完整运行环境（含活动 Session）。
    async fn setup() -> (TempDir, Arc<ProxyCrab>, Arc<FlowRunManager>, u64) {
        let root = tempdir().unwrap();
        let runtime = ProxyCrab::open(root.path(), Arc::new(LogBuffer::default())).unwrap();
        let mut config = runtime.config();
        config.proxy_host = "127.0.0.1".into();
        config.proxy_port = unused_port();
        runtime.replace_config(config).await.unwrap();
        runtime.start_proxy().await.unwrap();
        let session = runtime.create_session(NewSession::default()).unwrap();
        let manager = Arc::new(FlowRunManager::open(
            root.path().to_path_buf(),
            runtime.clone(),
        ));
        (root, runtime, manager, session.id)
    }

    fn put_workflow(root: &Path, workflow: &Workflow) {
        FlowStore::open(root)
            .unwrap()
            .put_workflow(workflow)
            .unwrap();
    }

    /// 逐个收取进度事件，直到 `finished`；断言运行在时限内定稿。
    async fn collect_until_finished(
        rx: &mut broadcast::Receiver<FlowRunEvent>,
    ) -> Vec<FlowRunEvent> {
        let deadline = std::time::Instant::now() + SETTLE_TIMEOUT;
        let mut events = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            assert!(!remaining.is_zero(), "run did not settle in time");
            match timeout(remaining, rx.recv()).await {
                Ok(Ok(event)) => {
                    let finished = event.kind == "finished";
                    events.push(event);
                    if finished {
                        return events;
                    }
                }
                Ok(Err(broadcast::error::RecvError::Lagged(n))) => {
                    panic!("progress events lagged by {n}")
                }
                Ok(Err(broadcast::error::RecvError::Closed)) => panic!("progress events closed"),
                Err(_) => panic!("run did not settle in time"),
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn trigger_creates_run_records_checkpoints_and_finalizes() {
        let (root, _runtime, manager, session) = setup().await;
        let wf = workflow(
            vec![
                node("s", WorkflowNodeType::Start, NodeConfig::default()),
                node("d", WorkflowNodeType::Delay, delay_config(60)),
            ],
            vec![edge("e1", "s", "d")],
        );
        put_workflow(root.path(), &wf);
        let mut rx = manager.subscribe_events();
        let record = manager.trigger(&wf.id, Some(session)).await.unwrap();

        // 建单即返回 running 记录：图快照在场、目标 Session 已绑定。
        assert_eq!(record.status, "running");
        assert_eq!(record.trigger, "manual");
        assert_eq!(record.session_id, Some(session));
        let snapshot = record
            .graph_snapshot
            .clone()
            .expect("graph snapshot stored");
        assert!(
            snapshot
                .get("nodes")
                .and_then(|nodes| nodes.as_array())
                .is_some()
        );
        assert!(snapshot.get("truncated").is_none());

        let events = collect_until_finished(&mut rx).await;
        assert_eq!(
            events.first().map(|event| event.kind.as_str()),
            Some("started")
        );
        assert_eq!(
            events.last().map(|event| event.kind.as_str()),
            Some("finished")
        );
        // 节点事件先于终态（写队列 FIFO 的可观测次序）。
        let finished_index = events.len() - 1;
        assert!(
            events[..finished_index]
                .iter()
                .all(|event| event.kind != "finished")
        );

        let detail = manager.get_run_detail(&record.id).await.unwrap().unwrap();
        assert_eq!(detail.run.id, record.id);
        assert_eq!(
            detail.run.status, "success",
            "run error: {:?}",
            detail.run.error
        );
        assert!(detail.run.finished_at.is_some());
        // 逐节点 checkpoint 落库：start 与 delay 节点都以终态快照收口。
        assert_eq!(detail.node_runs.len(), 2);
        let delay = detail
            .node_runs
            .iter()
            .find(|node| node.node_id == "d")
            .expect("delay node checkpoint");
        assert_eq!(delay.status, "success");
        assert!(delay.started_at.is_some());
        assert!(delay.duration_ms.is_some());
        let start = detail
            .node_runs
            .iter()
            .find(|node| node.node_id == "s")
            .expect("start node checkpoint");
        assert_eq!(start.status, "success");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_outranks_failure_and_records_cancelled() {
        let (root, _runtime, manager, session) = setup().await;
        let wf = workflow(
            vec![
                node("s", WorkflowNodeType::Start, NodeConfig::default()),
                node("d", WorkflowNodeType::Delay, delay_config(30_000)),
            ],
            vec![edge("e1", "s", "d")],
        );
        put_workflow(root.path(), &wf);
        let mut rx = manager.subscribe_events();
        let record = manager.trigger(&wf.id, Some(session)).await.unwrap();

        // 等 delay 节点开始（checkpoint 已入队）后取消。
        let deadline = std::time::Instant::now() + SETTLE_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            assert!(!remaining.is_zero(), "delay node did not start in time");
            let event = timeout(remaining, rx.recv()).await.unwrap().unwrap();
            if event.kind == "node" && event.node_id.as_deref() == Some("d") {
                break;
            }
        }
        assert!(manager.cancel(&record.id));

        let events = collect_until_finished(&mut rx).await;
        assert_eq!(
            events.last().map(|event| event.kind.as_str()),
            Some("finished")
        );
        let detail = manager.get_run_detail(&record.id).await.unwrap().unwrap();
        // 取消优先：无论引擎侧延迟节点以何种形态收场，终态恒归 cancelled。
        assert_eq!(detail.run.status, "cancelled");
        assert!(detail.run.finished_at.is_some());
        // 定稿后运行注册表已清理：重复取消返回 false。
        assert!(!manager.cancel(&record.id));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_checkpoints_serialize_and_finalize_lands_last() {
        let (root, _runtime, manager, session) = setup().await;
        // start 扇出到两个并行 delay：执行器默认并发 4，两个节点同批启动，
        // 节点事件并发进入写队列，由本次运行的唯一消费者 FIFO 串行落库。
        let wf = workflow(
            vec![
                node("s", WorkflowNodeType::Start, NodeConfig::default()),
                node("a", WorkflowNodeType::Delay, delay_config(80)),
                node("b", WorkflowNodeType::Delay, delay_config(80)),
            ],
            vec![edge("e1", "s", "a"), edge("e2", "s", "b")],
        );
        put_workflow(root.path(), &wf);
        let mut rx = manager.subscribe_events();
        let record = manager.trigger(&wf.id, Some(session)).await.unwrap();

        let events = collect_until_finished(&mut rx).await;
        assert_eq!(
            events.last().map(|event| event.kind.as_str()),
            Some("finished")
        );
        // 并发 checkpoint 全部串行落库：两个分支节点的终态快照都在场且不互踩。
        let detail = manager.get_run_detail(&record.id).await.unwrap().unwrap();
        assert_eq!(detail.run.status, "success");
        for node_id in ["a", "b"] {
            let node = detail
                .node_runs
                .iter()
                .find(|node| node.node_id == node_id)
                .unwrap_or_else(|| panic!("node {node_id} checkpoint missing"));
            assert_eq!(node.status, "success", "node {node_id}");
        }
        assert!(detail.run.finished_at.is_some());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn restart_converges_orphan_running_runs_to_interrupted() {
        let (root, runtime, manager, _session) = setup().await;
        // 模拟上次进程中断的遗留：直接向 runs.db 写入一条 running 行。
        let orphan = FlowRunRecord {
            id: generate_flow_id("run").unwrap(),
            workflow_id: "wf-gone".into(),
            workflow_name: "leftover".into(),
            trigger: "manual".into(),
            status: "running".into(),
            session_id: None,
            started_at: 1,
            finished_at: None,
            error: None,
            graph_snapshot: None,
        };
        RunStore::open(root.path())
            .unwrap()
            .insert_run(&orphan)
            .unwrap();

        // 重新打开管理器（等同重启进程）：收敛扫描立即把孤儿行归 interrupted。
        let reopened = FlowRunManager::open(root.path().to_path_buf(), runtime.clone());
        let run = reopened.get_run(&orphan.id).await.unwrap().unwrap();
        assert_eq!(run.status, "interrupted");
        assert_eq!(run.error.as_deref(), Some("进程重启：运行中断"));
        assert!(run.finished_at.is_some());
        // 收敛结果进入既有读取面；再开一次幂等（无 running 行可收敛）。
        let (page, total) = reopened
            .list_runs(None, Some("interrupted".into()), 10, 0)
            .await
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(page[0].id, orphan.id);
        let again = FlowRunManager::open(root.path().to_path_buf(), runtime.clone());
        let run = again.get_run(&orphan.id).await.unwrap().unwrap();
        assert_eq!(run.status, "interrupted");
        let _ = manager;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn trigger_prechecks_reject_without_creating_runs() {
        let root = tempdir().unwrap();
        let runtime = ProxyCrab::open(root.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = Arc::new(FlowRunManager::open(
            root.path().to_path_buf(),
            runtime.clone(),
        ));
        let wf = workflow(
            vec![node("s", WorkflowNodeType::Start, NodeConfig::default())],
            vec![],
        );
        put_workflow(root.path(), &wf);

        // 代理未运行且无活动 Session：明确报错且不建单（重放走流程专属连接代，
        // 代理状态不再是触发前提）。
        let error = manager.trigger(&wf.id, None).await.unwrap_err();
        assert!(matches!(error, RunTriggerError::NoSession));
        assert_eq!(manager.list_runs(None, None, 10, 0).await.unwrap().1, 0);

        // 工作流不存在同样明确报错（与存储故障分开归类）。
        let error = manager.trigger("wf-missing", None).await.unwrap_err();
        assert!(matches!(error, RunTriggerError::WorkflowNotFound(id) if id == "wf-missing"));

        // 图不合法（缺开始节点）：校验失败不建单。
        let invalid = workflow(
            vec![node(
                "note",
                WorkflowNodeType::StickyNote,
                NodeConfig::default(),
            )],
            vec![],
        );
        put_workflow(root.path(), &invalid);
        let session = runtime.create_session(NewSession::default()).unwrap();
        let error = manager
            .trigger(&invalid.id, Some(session.id))
            .await
            .unwrap_err();
        let RunTriggerError::NotValid(message) = error else {
            panic!("expected NotValid, got {error:?}")
        };
        assert!(message.contains("开始节点"), "{message}");
        assert_eq!(manager.list_runs(None, None, 10, 0).await.unwrap().1, 0);
    }

    /// 代理未启动也能触发并完成运行（重放走流程专属连接代，出站机制与代理
    /// 监听无关）；全流程只有纯逻辑节点，不发起真实出站请求。
    #[tokio::test(flavor = "multi_thread")]
    async fn trigger_succeeds_while_proxy_stopped() {
        let root = tempdir().unwrap();
        let runtime = ProxyCrab::open(root.path(), Arc::new(LogBuffer::default())).unwrap();
        let manager = Arc::new(FlowRunManager::open(
            root.path().to_path_buf(),
            runtime.clone(),
        ));
        let wf = workflow(
            vec![
                node("s", WorkflowNodeType::Start, NodeConfig::default()),
                node("d", WorkflowNodeType::Delay, delay_config(10)),
            ],
            vec![edge("e1", "s", "d")],
        );
        put_workflow(root.path(), &wf);
        let session = runtime.create_session(NewSession::default()).unwrap();

        let mut rx = manager.subscribe_events();
        let run = manager.trigger(&wf.id, Some(session.id)).await.unwrap();
        assert_eq!(run.status, "running");
        collect_until_finished(&mut rx).await;
        let (page, total) = manager.list_runs(None, None, 10, 0).await.unwrap();
        assert_eq!(total, 1);
        assert_eq!(page[0].status, "success");
    }
}
