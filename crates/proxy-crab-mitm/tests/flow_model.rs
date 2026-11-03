//! Workflow domain model acceptance (plan Task 10): serde camelCase on-disk
//! shapes field-aligned with the archived ReqFlow types, tolerant reads of
//! legacy values, and read-time migration of old workflow documents (refId
//! backfill + template rewrite, mirroring the archived `WorkflowRepo.get`).

use std::collections::BTreeMap;
use std::fs;

use proxy_crab_mitm::flow::model::{
    AssertionRule, ConditionBranchHandle, ConditionGroup, ConditionGroupOperator, ConditionLeaf,
    ConditionNode, ConditionOperator, ConditionRuleRow, CsvDelimiter, HeaderFidelityItem,
    HeaderFidelitySource, JsonPathAssertionRule, JsonPathOperator, LoopItems, ManualRequest,
    NodeConfig, NodeCookieMode, NodeFailPolicy, NodeHeaderFidelity, NodePinnedOutput,
    NodeRetryConfig, Position, RequestOverride, SchemaAssertionRule, StatusAssertionRule,
    StatusCodeOperator, StickyNoteSize, TransformEngine, TransformExtractionRule,
    VariableAssignment, VariableAssignmentSource, WORKFLOW_SCHEMA_VERSION, Workflow, WorkflowEdge,
    WorkflowNode, WorkflowNodeType,
};
use proxy_crab_mitm::flow::store::FlowStore;
use proxy_crab_mitm::flow::validate::{
    ValidationIssueCode, has_blocking_issues, validate_workflow_graph,
};
use tempfile::tempdir;

fn node(id: &str, node_type: WorkflowNodeType, config: NodeConfig) -> WorkflowNode {
    WorkflowNode {
        id: id.to_owned(),
        node_type,
        position: Position { x: 1.5, y: -2.5 },
        config,
        label: None,
        ref_id: None,
    }
}

fn workflow(id: &str, nodes: Vec<WorkflowNode>, edges: Vec<WorkflowEdge>) -> Workflow {
    Workflow {
        id: id.to_owned(),
        project_id: "proj-1".to_owned(),
        name: "checkout".to_owned(),
        description: "结算链路".to_owned(),
        nodes,
        edges,
        variables: BTreeMap::from([("token".to_owned(), "abc".to_owned())]),
        secret_variables: BTreeMap::new(),
        schema_version: WORKFLOW_SCHEMA_VERSION,
        created_at: 100,
        updated_at: 100,
    }
}

fn read_raw(root: &std::path::Path, id: &str) -> serde_json::Value {
    serde_json::from_slice(&fs::read(root.join("flow/workflows").join(format!("{id}.json"))).unwrap())
        .unwrap()
}

/// All nine node types persist their config with the exact camelCase field
/// names of the archived ReqFlow `NodeConfig`.
#[test]
fn all_node_config_fields_round_trip_as_camel_case() {
    let configs: Vec<(WorkflowNodeType, NodeConfig, serde_json::Value)> = vec![
        // start：空配置
        (WorkflowNodeType::Start, NodeConfig::default(), serde_json::json!({})),
        // httpReplay：请求引用 / 覆盖 / 保真 / cookie / 脚本 / 超时 / failPolicy / 重试 / 固定输出
        (
            WorkflowNodeType::HttpReplay,
            NodeConfig {
                request_id: Some("req-1".into()),
                manual_request: Some(ManualRequest {
                    method: "POST".into(),
                    url: "https://example.com/api".into(),
                    headers: Some(BTreeMap::from([("X-A".into(), "1".into())])),
                    body: Some("payload".into()),
                }),
                override_: Some(RequestOverride {
                    method: Some("PUT".into()),
                    url: Some("https://example.com/api/2".into()),
                    headers: Some(BTreeMap::from([("X-B".into(), "2".into())])),
                    removed_headers: Some(vec!["X-Drop".into()]),
                    body: Some("overridden".into()),
                }),
                pre_process: Some("input => input".into()),
                post_process: Some("response => response".into()),
                timeout_ms: Some(5000),
                fail_policy: Some(NodeFailPolicy::Continue),
                header_fidelity: Some(NodeHeaderFidelity {
                    origin: Some(HeaderFidelityItem {
                        source: HeaderFidelitySource::Static,
                        value: Some("https://example.com".into()),
                    }),
                    referer: Some(HeaderFidelityItem {
                        source: HeaderFidelitySource::FromCapture,
                        value: None,
                    }),
                    user_agent: None,
                }),
                cookie_mode: Some(NodeCookieMode::Custom),
                cookie_value: Some("session=1".into()),
                retry: Some(NodeRetryConfig {
                    max_attempts: 3,
                    backoff_ms: 200,
                    multiplier: Some(1.5),
                }),
                pinned_output: Some(NodePinnedOutput {
                    value: serde_json::json!({ "status": 200 }),
                    pinned_at: 123456,
                    source_run_id: "run-1".into(),
                }),
                ..NodeConfig::default()
            },
            serde_json::json!({
                "requestId": "req-1",
                "manualRequest": {
                    "method": "POST",
                    "url": "https://example.com/api",
                    "headers": { "X-A": "1" },
                    "body": "payload"
                },
                "override": {
                    "method": "PUT",
                    "url": "https://example.com/api/2",
                    "headers": { "X-B": "2" },
                    "removedHeaders": ["X-Drop"],
                    "body": "overridden"
                },
                "preProcess": "input => input",
                "postProcess": "response => response",
                "timeoutMs": 5000,
                "failPolicy": "continue",
                "headerFidelity": {
                    "origin": { "source": "static", "value": "https://example.com" },
                    "referer": { "source": "fromCapture" }
                },
                "cookieMode": "custom",
                "cookieValue": "session=1",
                "retry": { "maxAttempts": 3, "backoffMs": 200, "multiplier": 1.5 },
                "pinnedOutput": { "value": { "status": 200 }, "pinnedAt": 123456, "sourceRunId": "run-1" }
            }),
        ),
        // condition：表达式 + 条件树 + legacy 字段
        (
            WorkflowNodeType::Condition,
            NodeConfig {
                expression: Some("input => input.status === 200".into()),
                condition: Some(ConditionGroup {
                    op: ConditionGroupOperator::Or,
                    not: true,
                    children: vec![
                        ConditionNode::Cond(ConditionLeaf {
                            left: "{{ var.token }}".into(),
                            operator: ConditionOperator::NotContains,
                            right: Some(serde_json::json!("expired")),
                        }),
                        ConditionNode::Group(ConditionGroup {
                            op: ConditionGroupOperator::And,
                            children: vec![ConditionNode::Cond(ConditionLeaf {
                                left: "status".into(),
                                operator: ConditionOperator::IsEmpty,
                                right: None,
                            })],
                            ..ConditionGroup::default()
                        }),
                    ],
                }),
                true_targets: Some(vec!["n1".into()]),
                false_targets: Some(vec!["n2".into()]),
                condition_rules: Some(vec![ConditionRuleRow {
                    join: ConditionGroupOperator::Or,
                    left: "status".into(),
                    op: ConditionOperator::Matches,
                    right: Some(serde_json::json!("^2\\d\\d$")),
                }]),
                ..NodeConfig::default()
            },
            serde_json::json!({
                "expression": "input => input.status === 200",
                "condition": {
                    "op": "or",
                    "not": true,
                    "children": [
                        { "type": "cond", "left": "{{ var.token }}", "operator": "notContains", "right": "expired" },
                        { "type": "group", "op": "and", "children": [
                            { "type": "cond", "left": "status", "operator": "isEmpty" }
                        ]}
                    ]
                },
                "trueTargets": ["n1"],
                "falseTargets": ["n2"],
                "conditionRules": [
                    { "join": "or", "left": "status", "op": "matches", "right": "^2\\d\\d$" }
                ]
            }),
        ),
        // loop：items 数组与模板双形态 / CSV / 并发 / 限速
        (
            WorkflowNodeType::Loop,
            NodeConfig {
                items: Some(LoopItems::Array(vec![serde_json::json!(1), serde_json::json!({"k":"v"})])),
                max_iterations: Some(50),
                csv_text: Some("id,name\n1,a".into()),
                csv_delimiter: Some(CsvDelimiter::Semicolon),
                concurrency: Some(4),
                interval_ms: Some(100),
                ..NodeConfig::default()
            },
            serde_json::json!({
                "items": [1, { "k": "v" }],
                "maxIterations": 50,
                "csvText": "id,name\n1,a",
                "csvDelimiter": ";",
                "concurrency": 4,
                "intervalMs": 100
            }),
        ),
        // delay
        (
            WorkflowNodeType::Delay,
            NodeConfig { duration_ms: Some(3000), ..NodeConfig::default() },
            serde_json::json!({ "durationMs": 3000 }),
        ),
        // setVariable
        (
            WorkflowNodeType::SetVariable,
            NodeConfig {
                assignments: Some(vec![
                    VariableAssignment {
                        name: "token".into(),
                        from: VariableAssignmentSource::Node,
                        path: Some("body.token".into()),
                        node: Some("replay-1".into()),
                        value: None,
                    },
                    VariableAssignment {
                        name: "greeting".into(),
                        from: VariableAssignmentSource::Literal,
                        path: None,
                        node: None,
                        value: Some(serde_json::json!("hi {{ var.token }}")),
                    },
                ]),
                ..NodeConfig::default()
            },
            serde_json::json!({
                "assignments": [
                    { "name": "token", "from": "node", "path": "body.token", "node": "replay-1" },
                    { "name": "greeting", "from": "literal", "value": "hi {{ var.token }}" }
                ]
            }),
        ),
        // assert：三类规则
        (
            WorkflowNodeType::Assert,
            NodeConfig {
                assertions: Some(vec![
                    AssertionRule::Status(StatusAssertionRule {
                        op: StatusCodeOperator::Class2Xx,
                        value: None,
                    }),
                    AssertionRule::JsonPath(JsonPathAssertionRule {
                        path: "$.body.token".into(),
                        op: JsonPathOperator::Exists,
                        value: None,
                    }),
                    AssertionRule::Schema(SchemaAssertionRule {
                        path: Some("$.body".into()),
                        schema: serde_json::json!({ "type": "object", "required": ["id"] }),
                    }),
                ]),
                ..NodeConfig::default()
            },
            serde_json::json!({
                "assertions": [
                    { "kind": "status", "op": "2xx" },
                    { "kind": "jsonPath", "path": "$.body.token", "op": "exists" },
                    { "kind": "schema", "path": "$.body", "schema": { "type": "object", "required": ["id"] } }
                ]
            }),
        ),
        // transform
        (
            WorkflowNodeType::Transform,
            NodeConfig {
                extractions: Some(vec![TransformExtractionRule {
                    name: "token".into(),
                    engine: TransformEngine::Jmespath,
                    path: "response.body.token".into(),
                }]),
                ..NodeConfig::default()
            },
            serde_json::json!({
                "extractions": [ { "name": "token", "engine": "jmespath", "path": "response.body.token" } ]
            }),
        ),
        // stickyNote
        (
            WorkflowNodeType::StickyNote,
            NodeConfig {
                text: Some("token 10 分钟过期".into()),
                color: Some("amber".into()),
                size: Some(StickyNoteSize { width: 220.0, height: 140.0 }),
                ..NodeConfig::default()
            },
            serde_json::json!({
                "text": "token 10 分钟过期",
                "color": "amber",
                "size": { "width": 220.0, "height": 140.0 }
            }),
        ),
    ];

    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();

    let nodes = configs
        .iter()
        .enumerate()
        .map(|(index, (node_type, config, _))| {
            node(&format!("n{index}"), *node_type, config.clone())
        })
        .collect();
    store
        .put_workflow(&workflow("wf-all", nodes, Vec::new()))
        .unwrap();

    // On-disk shape: every node's config matches the archived field names.
    let raw = read_raw(root.path(), "wf-all");
    for (index, (_, _, expected)) in configs.iter().enumerate() {
        assert_eq!(
            raw["nodes"][index]["config"],
            *expected,
            "node {index} config shape"
        );
        assert_eq!(raw["nodes"][index]["position"], serde_json::json!({ "x": 1.5, "y": -2.5 }));
    }

    // Typed round-trip is lossless.
    let stored = store.get_workflow("wf-all").unwrap().unwrap();
    for (index, (_, config, _)) in configs.iter().enumerate() {
        assert_eq!(stored.nodes[index].config, *config);
    }

    // Branch handles persist as the 'true' / 'false' literals.
    let mut with_branch = workflow("wf-branch", Vec::new(), Vec::new());
    with_branch.edges.push(WorkflowEdge {
        id: "e1".into(),
        source: "c".into(),
        target: "t".into(),
        source_handle: Some(ConditionBranchHandle::False),
    });
    store.put_workflow(&with_branch).unwrap();
    assert_eq!(read_raw(root.path(), "wf-branch")["edges"][0]["sourceHandle"], "false");
    assert_eq!(
        store.get_workflow("wf-branch").unwrap().unwrap().edges[0].source_handle,
        Some(ConditionBranchHandle::False)
    );
}

/// Legacy values keep reading: historical 'browser' cookie mode normalizes to
/// the snapshot semantics, unknown CSV delimiters fall back to comma.
#[test]
fn legacy_config_values_read_tolerantly() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    fs::write(
        root.path().join("flow/workflows/wf-legacy.json"),
        serde_json::to_vec(&serde_json::json!({
            "id": "wf-legacy",
            "projectId": "proj-1",
            "name": "legacy",
            "description": "",
            "nodes": [
                {
                    "id": "r1",
                    "type": "httpReplay",
                    "position": { "x": 0.0, "y": 0.0 },
                    "config": { "cookieMode": "browser", "csvDelimiter": "x", "items": "leaf template" }
                },
                {
                    "id": "l1",
                    "type": "loop",
                    "position": { "x": 10.0, "y": 0.0 },
                    "config": { "items": ["a", 2] }
                }
            ],
            "edges": [],
            "variables": {},
            "secretVariables": {},
            "createdAt": 1,
            "updatedAt": 1
        }))
        .unwrap(),
    )
    .unwrap();

    // Missing schemaVersion reads as version 0 and migrates on get.
    let migrated = store.get_workflow("wf-legacy").unwrap().unwrap();
    assert_eq!(migrated.schema_version, WORKFLOW_SCHEMA_VERSION);
    let replay = &migrated.nodes[0].config;
    assert_eq!(replay.cookie_mode, Some(NodeCookieMode::Snapshot));
    assert_eq!(replay.csv_delimiter, Some(CsvDelimiter::Comma));
    assert_eq!(
        replay.items,
        Some(LoopItems::Template("leaf template".into()))
    );
    assert_eq!(
        migrated.nodes[1].config.items,
        Some(LoopItems::Array(vec![serde_json::json!("a"), serde_json::json!(2)]))
    );
    // Backfilled refIds are five letters and unique within the workflow.
    let ref_ids: Vec<_> = migrated
        .nodes
        .iter()
        .filter_map(|node| node.ref_id.clone())
        .collect();
    assert_eq!(ref_ids.len(), 2);
    let mut sorted = ref_ids.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), ref_ids.len());
    for ref_id in &ref_ids {
        assert_eq!(ref_id.len(), 5);
        assert!(ref_id.chars().all(|c| c.is_ascii_alphabetic()));
    }

    // The migrated document was written back at the current schema version...
    let raw = read_raw(root.path(), "wf-legacy");
    assert_eq!(raw["schemaVersion"], WORKFLOW_SCHEMA_VERSION);
    assert_eq!(raw["nodes"][0]["config"]["cookieMode"], "snapshot");
    // ...with legacy fields normalized on disk and refIds persisted.
    assert!(raw["nodes"][0]["refId"].is_string());
    assert!(raw["nodes"][1]["refId"].is_string());
}

/// failPolicy is a strict enum: an illegal value makes the whole document
/// corrupt (readable error on get, skipped with a warning on list) — the
/// legality gate sits at the deserialization boundary.
#[test]
fn illegal_fail_policy_values_reject_the_document() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    fs::write(
        root.path().join("flow/workflows/wf-badfail.json"),
        serde_json::to_vec(&serde_json::json!({
            "id": "wf-badfail",
            "projectId": "proj-1",
            "name": "badfail",
            "description": "",
            "nodes": [
                {
                    "id": "r1",
                    "type": "httpReplay",
                    "position": { "x": 0.0, "y": 0.0 },
                    "config": { "failPolicy": "sometimes" }
                }
            ],
            "edges": [],
            "variables": {},
            "secretVariables": {},
            "schemaVersion": WORKFLOW_SCHEMA_VERSION,
            "createdAt": 1,
            "updatedAt": 1
        }))
        .unwrap(),
    )
    .unwrap();
    let error = format!("{:#}", store.get_workflow("wf-badfail").unwrap_err());
    assert!(error.contains("failPolicy") || error.contains("unknown variant"), "{error}");
    assert!(store.list_workflows().unwrap().is_empty());
}

/// Read-time migration mirrors `WorkflowRepo.get`: missing refIds are backfilled,
/// `{{ node.<oldId> }}` template references in configs are rewritten to the new
/// short codes, timestamps stay untouched, and the second read is a no-op.
#[test]
fn old_documents_migrate_ref_ids_and_template_refs_idempotently() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    let old_id = "0a2b7c4d-1111-2222-3333-444455556666";
    fs::write(
        root.path().join("flow/workflows/wf-old.json"),
        serde_json::to_vec(&serde_json::json!({
            "id": "wf-old",
            "projectId": "proj-1",
            "name": "old",
            "description": "",
            "nodes": [
                {
                    "id": old_id,
                    "type": "httpReplay",
                    "position": { "x": 0.0, "y": 0.0 },
                    "config": {
                        "postProcess": "({ v: `{{ node.0a2b7c4d-1111-2222-3333-444455556666.body.token }}` })"
                    }
                },
                {
                    "id": "downstream",
                    "type": "setVariable",
                    "position": { "x": 10.0, "y": 0.0 },
                    "refId": "zzzzz",
                    "config": {
                        "assignments": [
                            { "name": "a", "from": "literal",
                              "value": "{{ node.0a2b7c4d-1111-2222-3333-444455556666.body }}" }
                        ]
                    }
                }
            ],
            "edges": [],
            "variables": {},
            "secretVariables": {},
            "createdAt": 7,
            "updatedAt": 9
        }))
        .unwrap(),
    )
    .unwrap();

    let migrated = store.get_workflow("wf-old").unwrap().unwrap();
    assert_eq!(migrated.created_at, 7);
    assert_eq!(migrated.updated_at, 9);
    assert_eq!(migrated.nodes[1].ref_id.as_deref(), Some("zzzzz"));
    let replay_ref = migrated.nodes[0].ref_id.clone().unwrap();
    // Backfill rewrote template references in both nodes' configs.
    let expected_post = format!("({{ v: `{{{{ node.{replay_ref}.body.token }}}}` }})");
    assert_eq!(
        migrated.nodes[0].config.post_process.as_deref(),
        Some(expected_post.as_str())
    );
    let expected_value = format!("{{{{ node.{replay_ref}.body }}}}");
    assert_eq!(
        migrated.nodes[1].config.assignments.as_ref().unwrap()[0].value,
        Some(serde_json::json!(expected_value))
    );
    // Prefix-similar ids are untouched (token-boundary rewrite).
    assert_eq!(read_raw(root.path(), "wf-old")["schemaVersion"], WORKFLOW_SCHEMA_VERSION);

    // Second read is idempotent: the stored document matches the migrated one.
    let again = store.get_workflow("wf-old").unwrap().unwrap();
    assert_eq!(again, migrated);
    // list returns documents as stored (already migrated at this point).
    assert_eq!(store.list_workflows().unwrap()[0].schema_version, WORKFLOW_SCHEMA_VERSION);
}

/// Documents written by a newer schema version are refused instead of being
/// silently read with dropped fields (forward incompatibility).
#[test]
fn newer_schema_versions_are_refused() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    let mut future = workflow("wf-future", Vec::new(), Vec::new());
    future.schema_version = WORKFLOW_SCHEMA_VERSION + 1;
    fs::create_dir_all(root.path().join("flow/workflows")).unwrap();
    fs::write(
        root.path().join("flow/workflows/wf-future.json"),
        serde_json::to_vec(&future).unwrap(),
    )
    .unwrap();
    let error = format!("{:#}", store.get_workflow("wf-future").unwrap_err());
    assert!(error.contains("not supported"), "{error}");
    assert!(store.list_workflows().unwrap().is_empty());
}

/// The graph validation gate shares the model: a saved (but structurally
/// incomplete) graph reads fine, while blocking issues gate runs.
#[test]
fn saved_workflows_may_fail_graph_validation_until_run_time() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();

    // Editing state: an empty workflow is storable and readable.
    let empty = workflow("wf-empty", Vec::new(), Vec::new());
    store.put_workflow(&empty).unwrap();
    assert!(store.get_workflow("wf-empty").unwrap().is_some());

    let issues = validate_workflow_graph(&empty.nodes, &empty.edges);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].code, ValidationIssueCode::MissingStart);
    assert!(has_blocking_issues(&issues));

    // A healthy chain passes the same gate.
    let healthy = workflow(
        "wf-ok",
        vec![
            node("s", WorkflowNodeType::Start, NodeConfig::default()),
            node(
                "r",
                WorkflowNodeType::HttpReplay,
                NodeConfig {
                    request_id: Some("req-1".into()),
                    ..NodeConfig::default()
                },
            ),
        ],
        vec![WorkflowEdge {
            id: "e1".into(),
            source: "s".into(),
            target: "r".into(),
            source_handle: None,
        }],
    );
    store.put_workflow(&healthy).unwrap();
    assert!(validate_workflow_graph(&healthy.nodes, &healthy.edges).is_empty());
}
