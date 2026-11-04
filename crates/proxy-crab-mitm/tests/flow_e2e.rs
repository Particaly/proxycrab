//! 端到端自动化验收（ReqFlow 复刻计划 Task 28 Step 1）。
//!
//! 一条测试链路串起 ReqFlow 的核心公开面：请求库条目入库 → 构建流程定义
//! → 触发运行 → 校验运行记录、节点检查点与图快照。harness 口径与
//! flow_run.rs / request_library.rs 保持一致。

mod flow_e2e {
    use std::{path::Path, sync::Arc, time::Duration};

    use proxy_crab_mitm::{
        flow::{
            model::{NodeConfig, Position, Workflow, WorkflowEdge, WorkflowNode, WorkflowNodeType},
            request_library::CapturedRequest,
            run::{FlowRunEvent, FlowRunManager},
            store::{generate_flow_id, FlowStore},
        },
        log_buffer::LogBuffer,
        model::{BodySourceType, HeaderValues, NewSession, RequestData, ResponseData},
        storage::{BodySide, CaptureStore},
        ProxyCrab,
    };
    use tempfile::{tempdir, TempDir};
    use tokio::{sync::broadcast, time::timeout};

    /// 运行终态等待上限（与 flow_run.rs 口径一致，留足余量）。
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
            name: "e2e-run-test".into(),
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
        let manager = Arc::new(FlowRunManager::open(root.path().to_path_buf(), runtime.clone()));
        (root, runtime, manager, session.id)
    }

    fn put_workflow(root: &Path, workflow: &Workflow) {
        FlowStore::open(root).unwrap().put_workflow(workflow).unwrap();
    }

    /// 逐个收取进度事件，直到 `finished`；断言运行在时限内定稿。
    async fn collect_until_finished(rx: &mut broadcast::Receiver<FlowRunEvent>) -> Vec<FlowRunEvent> {
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

    // ---- 请求库入库口径（与 request_library.rs 一致）----

    fn begin(store: &CaptureStore, method: &str, uri: &str, version: &str) -> u64 {
        store
            .begin(
                "127.0.0.1",
                &RequestData {
                    method: method.into(),
                    uri: uri.into(),
                    version: version.into(),
                    headers: HeaderValues::new(),
                    tags: Default::default(),
                },
                "request",
            )
            .unwrap()
    }

    fn complete_ok(store: &CaptureStore, id: u64) {
        store
            .complete(
                id,
                &ResponseData {
                    status: 200,
                    version: "HTTP/1.1".into(),
                    headers: HeaderValues::new(),
                },
                &BodySourceType::Original,
            )
            .unwrap()
    }

    /// 取一条采集的明细摘要与两侧 body 源，供 `ingest_capture` 入库。
    fn captured(store: &CaptureStore, id: u64) -> CapturedRequest {
        let detail = store.get(id).unwrap().expect("capture exists");
        CapturedRequest {
            capture: detail.summary,
            request_body: store.body_source(id, BodySide::Request).unwrap(),
            response_body: store.body_source(id, BodySide::Response).unwrap(),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn entry_then_flow_run_reaches_terminal_record_with_graph_snapshot() {
        let (root, _runtime, manager, session) = setup().await;

        // 阶段一：采集一个请求并入库，形成请求库条目。
        let captures = CaptureStore::open(session, root.path()).unwrap();
        let capture_id = begin(&captures, "GET", "https://api.example.com/v1/login", "HTTP/1.1");
        complete_ok(&captures, capture_id);
        let store = FlowStore::open(root.path()).unwrap();
        let entry = store
            .ingest_capture(&captured(&captures, capture_id), None, &[])
            .unwrap();
        assert_eq!(entry.name, "GET api.example.com/v1/login");
        assert_eq!(entry.har.log.entries.len(), 1);

        // 阶段二：建流程定义（骨架先以 start+delay 最小图占位，
        // 后续补齐 httpReplay + 条件 + 循环 + 断言的多节点图）。
        let wf = workflow(
            vec![
                node("s", WorkflowNodeType::Start, NodeConfig::default()),
                node(
                    "d",
                    WorkflowNodeType::Delay,
                    NodeConfig {
                        duration_ms: Some(60),
                        ..NodeConfig::default()
                    },
                ),
            ],
            vec![edge("e1", "s", "d")],
        );
        put_workflow(root.path(), &wf);

        // 阶段三：触发运行，建单即返回 running 记录。
        let mut rx = manager.subscribe_events();
        let record = manager.trigger(&wf.id, Some(session)).await.unwrap();
        assert_eq!(record.status, "running");
        assert_eq!(record.trigger, "manual");
        assert_eq!(record.session_id, Some(session));

        // 阶段四：运行记录、节点检查点与图快照齐全且与定义一致。
        let snapshot = record.graph_snapshot.clone().expect("graph snapshot stored");
        assert_eq!(
            snapshot.get("nodes").and_then(|nodes| nodes.as_array()).map(Vec::len),
            Some(wf.nodes.len()),
            "graph snapshot nodes must match the definition"
        );
        assert!(snapshot.get("truncated").is_none());

        let events = collect_until_finished(&mut rx).await;
        assert_eq!(events.first().map(|event| event.kind.as_str()), Some("started"));
        assert_eq!(events.last().map(|event| event.kind.as_str()), Some("finished"));

        let detail = manager.get_run_detail(&record.id).await.unwrap().unwrap();
        assert_eq!(detail.run.id, record.id);
        assert_eq!(detail.run.status, "success", "run error: {:?}", detail.run.error);
        assert!(detail.run.finished_at.is_some());
        assert_eq!(detail.node_runs.len(), 2);
        let delay = detail
            .node_runs
            .iter()
            .find(|checkpoint| checkpoint.node_id == "d")
            .expect("delay node checkpoint");
        assert_eq!(delay.status, "success");
        assert!(delay.started_at.is_some());
        assert!(delay.duration_ms.is_some());
        let start = detail
            .node_runs
            .iter()
            .find(|checkpoint| checkpoint.node_id == "s")
            .expect("start node checkpoint");
        assert_eq!(start.status, "success");
    }
}
