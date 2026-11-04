//! 端到端自动化验收（ReqFlow 复刻计划 Task 28 Step 1）。
//!
//! 一条测试链路串起 ReqFlow 的核心公开面：请求库条目入库 → 构建多节点流程
//! （httpReplay 引用请求库条目、assert 断言、condition 条件分支、loop 循环与
//! 循环体回放）→ 触发运行 → 校验运行记录、节点检查点与图快照。运行 harness
//! 沿用 flow_run.rs 口径，请求库入库沿用 request_library.rs 口径，出站请求
//! 由本地测试上游承接（复用 replay_await.rs 的本地上游模式）。

mod flow_e2e {
    use std::{
        path::Path,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use proxy_crab_mitm::{
        flow::{
            model::{
                AssertionRule, ConditionBranchHandle, JsonPathAssertionRule, JsonPathOperator,
                LoopItems, ManualRequest, NodeConfig, Position, RequestOverride,
                StatusAssertionRule, StatusCodeOperator, Workflow, WorkflowEdge, WorkflowNode,
                WorkflowNodeType,
            },
            request_library::CapturedRequest,
            run::{FlowRunEvent, FlowRunManager},
            store::{generate_flow_id, FlowStore},
        },
        log_buffer::LogBuffer,
        model::{BodySourceType, HeaderValues, NewSession, RequestData, ResponseData},
        storage::{BodySide, CaptureStore},
        ProxyCrab,
    };
    use serde_json::{Value as JsonValue, json};
    use tempfile::{tempdir, TempDir};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::broadcast,
        task::JoinHandle,
        time::timeout,
    };

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

    /// 带分支手柄的连线（condition 节点出边专用）。
    fn edge_handle(
        id: &str,
        source: &str,
        target: &str,
        handle: ConditionBranchHandle,
    ) -> WorkflowEdge {
        WorkflowEdge {
            source_handle: Some(handle),
            ..edge(id, source, target)
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

    /// 多连接本地测试上游：每笔连接回同一段 JSON 响应并记录请求目标行
    /// （`GET /path HTTP/1.1`，出站数据流的断言依据）。返回端口、目标记录
    /// 与服务任务句柄（测试结束 abort）。
    async fn json_upstream(body: &'static str) -> (u16, Arc<Mutex<Vec<String>>>, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let targets = Arc::new(Mutex::new(Vec::new()));
        let served = targets.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request).await;
                if let Some(first_line) = String::from_utf8_lossy(&request).lines().next() {
                    served.lock().unwrap().push(first_line.to_owned());
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (port, targets, task)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn library_entry_feeds_multi_node_chain_run_to_terminal_record() {
        let (root, _runtime, manager, session) = setup().await;

        // 阶段一：采集一个请求并入库，形成请求库条目（流程请求节点的基线来源）。
        let captures = CaptureStore::open(session, root.path()).unwrap();
        let capture_id = begin(&captures, "GET", "https://api.example.com/v1/login", "HTTP/1.1");
        complete_ok(&captures, capture_id);
        let store = FlowStore::open(root.path()).unwrap();
        let entry = store
            .ingest_capture(&captured(&captures, capture_id), None, &[])
            .unwrap();
        assert_eq!(entry.name, "GET api.example.com/v1/login");
        assert_eq!(entry.har.log.entries.len(), 1);

        // 阶段二：建多节点流程——start → httpReplay（引用请求库条目，override
        // 指向本地上游）→ assert（状态码 + jsonPath 断言）→ condition（恒真，
        // 真分支手柄连线）→ loop（两轮迭代）→ 循环体 httpReplay（模板渲染轮次 url）。
        let (upstream_port, targets, upstream) =
            json_upstream(r#"{"ok":true,"token":"tk-123"}"#).await;
        let upstream_base = format!("http://127.0.0.1:{upstream_port}");
        let wf = workflow(
            vec![
                node("s", WorkflowNodeType::Start, NodeConfig::default()),
                node(
                    "r",
                    WorkflowNodeType::HttpReplay,
                    NodeConfig {
                        request_id: Some(entry.id.clone()),
                        override_: Some(RequestOverride {
                            url: Some(format!("{upstream_base}/v1/login")),
                            ..RequestOverride::default()
                        }),
                        ..NodeConfig::default()
                    },
                ),
                node(
                    "a",
                    WorkflowNodeType::Assert,
                    NodeConfig {
                        assertions: Some(vec![
                            AssertionRule::Status(StatusAssertionRule {
                                op: StatusCodeOperator::Class2Xx,
                                value: None,
                            }),
                            AssertionRule::JsonPath(JsonPathAssertionRule {
                                path: "$.json.ok".into(),
                                op: JsonPathOperator::Eq,
                                value: Some(json!(true)),
                            }),
                        ]),
                        ..NodeConfig::default()
                    },
                ),
                node(
                    "c",
                    WorkflowNodeType::Condition,
                    NodeConfig {
                        expression: Some("return true".into()),
                        ..NodeConfig::default()
                    },
                ),
                node(
                    "L",
                    WorkflowNodeType::Loop,
                    NodeConfig {
                        items: Some(LoopItems::Array(vec![json!("i0"), json!("i1")])),
                        ..NodeConfig::default()
                    },
                ),
                node(
                    "b",
                    WorkflowNodeType::HttpReplay,
                    NodeConfig {
                        manual_request: Some(ManualRequest {
                            method: "GET".into(),
                            url: format!("{upstream_base}/round-{{{{ var.loop.item }}}}"),
                            ..ManualRequest::default()
                        }),
                        ..NodeConfig::default()
                    },
                ),
            ],
            vec![
                edge("e1", "s", "r"),
                edge("e2", "r", "a"),
                edge("e3", "a", "c"),
                edge_handle("e4", "c", "L", ConditionBranchHandle::True),
                edge("e5", "L", "b"),
            ],
        );
        put_workflow(root.path(), &wf);

        // 阶段三：触发运行，建单即返回 running 记录。
        let mut rx = manager.subscribe_events();
        let record = manager.trigger(&wf.id, Some(session)).await.unwrap();
        assert_eq!(record.status, "running");
        assert_eq!(record.trigger, "manual");
        assert_eq!(record.session_id, Some(session));

        // 图快照与定义一致：节点 / 连线齐全，条件真分支手柄在场。
        let snapshot = record.graph_snapshot.clone().expect("graph snapshot stored");
        let snapshot_nodes = snapshot
            .get("nodes")
            .and_then(JsonValue::as_array)
            .expect("snapshot nodes");
        assert_eq!(snapshot_nodes.len(), wf.nodes.len());
        let node_type = |index: usize| {
            snapshot_nodes[index]
                .get("type")
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
        };
        assert_eq!(node_type(0), "start");
        assert_eq!(node_type(1), "httpReplay");
        assert_eq!(node_type(2), "assert");
        assert_eq!(node_type(3), "condition");
        assert_eq!(node_type(4), "loop");
        assert_eq!(node_type(5), "httpReplay");
        let snapshot_edges = snapshot
            .get("edges")
            .and_then(JsonValue::as_array)
            .expect("snapshot edges");
        assert_eq!(snapshot_edges.len(), wf.edges.len());
        let condition_edge = snapshot_edges
            .iter()
            .find(|edge| edge.get("source").and_then(JsonValue::as_str) == Some("c"))
            .expect("condition edge in snapshot");
        assert_eq!(condition_edge.get("sourceHandle"), Some(&json!("true")));
        assert!(snapshot.get("truncated").is_none());

        // 阶段四：等终态，校验运行记录、节点检查点与出站数据流。
        let events = collect_until_finished(&mut rx).await;
        assert_eq!(events.first().map(|event| event.kind.as_str()), Some("started"));
        assert_eq!(events.last().map(|event| event.kind.as_str()), Some("finished"));

        let detail = manager.get_run_detail(&record.id).await.unwrap().unwrap();
        assert_eq!(detail.run.id, record.id);
        assert_eq!(detail.run.status, "success", "run error: {:?}", detail.run.error);
        assert!(detail.run.finished_at.is_some());
        let checkpoint = |node_id: &str| {
            detail
                .node_runs
                .iter()
                .find(|checkpoint| checkpoint.node_id == node_id)
                .unwrap_or_else(|| panic!("node {node_id} checkpoint missing"))
        };
        // 全部 6 个节点都有终态 checkpoint 且 success（断言节点的 success 即断言通过）。
        for node_id in ["s", "r", "a", "c", "L", "b"] {
            assert_eq!(checkpoint(node_id).status, "success", "node {node_id}");
        }
        // 请求节点：输出为归一化响应信封（status + 解析后的 json）。
        let replay_output = checkpoint("r").output.as_ref().expect("replay output");
        assert_eq!(replay_output["status"], json!(200));
        assert_eq!(replay_output["json"]["ok"], json!(true));
        // 条件节点：真分支放行（branch 形态输出在场）。
        let condition_output = checkpoint("c").output.as_ref().expect("condition output");
        assert_eq!(condition_output["branch"], json!("true"));
        // 循环节点：两轮迭代全部结算，逐轮明细按 items 序。
        let iterations = checkpoint("L").iterations.as_ref().expect("loop iterations");
        assert_eq!(iterations["total"], json!(2));
        assert_eq!(iterations["done"], json!(2));
        assert_eq!(iterations["capped"], json!(false));
        let iteration_records = iterations["records"].as_array().expect("iteration records");
        assert_eq!(iteration_records.len(), 2);
        assert_eq!(iteration_records[0]["item"], json!("i0"));
        assert_eq!(iteration_records[0]["status"], json!("success"));
        assert_eq!(iteration_records[1]["item"], json!("i1"));
        assert_eq!(iteration_records[1]["status"], json!("success"));
        // 出站数据流：请求基线（请求库条目）经 override 到达本地上游 1 笔，
        // 循环体按模板渲染逐轮到达 2 笔（串行按 items 序）。
        let targets = targets.lock().unwrap();
        assert_eq!(targets.len(), 3, "upstream targets: {targets:?}");
        assert!(targets[0].contains("/v1/login"), "targets: {targets:?}");
        assert!(targets[1].contains("/round-i0"), "targets: {targets:?}");
        assert!(targets[2].contains("/round-i1"), "targets: {targets:?}");
        drop(targets);
        upstream.abort();
    }
}
