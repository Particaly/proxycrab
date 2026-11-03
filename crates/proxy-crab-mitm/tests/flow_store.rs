//! Flow store acceptance (schema v4): flow directory family initialization,
//! idempotent v3→v4 migration, entity CRUD with shape validation, corrupt-file
//! degradation and concurrent writes.

use std::{collections::BTreeMap, fs, path::Path, thread};

use proxy_crab_mitm::flow::model::{
    WORKFLOW_SCHEMA_VERSION, ConditionBranchHandle, NodeConfig, Position, Workflow, WorkflowEdge,
    WorkflowNode, WorkflowNodeType,
};
use proxy_crab_mitm::flow::store::{
    ENV_SETS_SCHEMA_VERSION, EnvVariableSet, FlowStore, RequestLibraryEntry, RequestSource,
};
use proxy_crab_mitm::workspace::Workspace;
use tempfile::tempdir;

fn sample_entry(id: &str) -> RequestLibraryEntry {
    RequestLibraryEntry {
        id: id.into(),
        name: "login".into(),
        tags: vec!["auth".into()],
        source: RequestSource::Capture,
        origin: "https://example.com".into(),
        har: serde_json::json!({ "log": { "entries": [] } }),
        created_at: 100,
        updated_at: 100,
    }
}

fn sample_workflow(id: &str) -> Workflow {
    Workflow {
        id: id.into(),
        project_id: "proj-1".into(),
        name: "checkout".into(),
        description: String::new(),
        nodes: vec![WorkflowNode {
            id: "start".into(),
            node_type: WorkflowNodeType::Start,
            position: Position { x: 0.0, y: 0.0 },
            config: NodeConfig::default(),
            label: None,
            ref_id: None,
        }],
        edges: vec![],
        variables: BTreeMap::new(),
        secret_variables: BTreeMap::new(),
        schema_version: WORKFLOW_SCHEMA_VERSION,
        created_at: 100,
        updated_at: 100,
    }
}

fn sample_env_set(id: &str, name: &str) -> EnvVariableSet {
    EnvVariableSet {
        id: id.into(),
        name: name.into(),
        values: BTreeMap::from([("baseUrl".into(), "https://example.com".into())]),
        secret_values: BTreeMap::new(),
        created_at: 100,
        updated_at: 100,
    }
}

fn schema_version(root: &Path) -> u32 {
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(root.join("workspace_schema.json")).unwrap())
            .unwrap();
    value["version"].as_u64().unwrap() as u32
}

#[test]
fn workspace_open_initializes_flow_directories_and_schema_v4() {
    let root = tempdir().unwrap();
    Workspace::open(root.path()).unwrap();
    for directory in [
        "flow",
        "flow/projects",
        "flow/request-library",
        "flow/workflows",
    ] {
        assert!(root.path().join(directory).is_dir(), "{directory}");
    }
    assert_eq!(schema_version(root.path()), 4);
    // No data, no empty files: env-sets.json and runs.db are not pre-created.
    assert!(!root.path().join("flow/env-sets.json").exists());
    assert!(!root.path().join("flow/runs.db").exists());
}

#[test]
fn v3_workspace_advances_to_v4_on_open_without_touching_existing_data() {
    let root = tempdir().unwrap();
    fs::create_dir_all(root.path().join("sessions/1")).unwrap();
    fs::write(
        root.path().join("sessions/1/metadata.json"),
        br#"{"id":1,"name":"capture","created_at":1}"#,
    )
    .unwrap();
    fs::write(root.path().join("workspace_schema.json"), b"{\"version\":3}").unwrap();

    let workspace = Workspace::open(root.path()).unwrap();
    assert_eq!(schema_version(root.path()), 4);
    assert!(root.path().join("flow/request-library").is_dir());
    assert_eq!(workspace.sessions().len(), 1);

    drop(workspace);
    Workspace::open(root.path()).unwrap();
    assert_eq!(schema_version(root.path()), 4);
    assert!(root.path().join("flow/workflows").is_dir());
}

#[test]
fn project_crud_round_trip() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    assert!(store.list_projects().unwrap().is_empty());
    assert_eq!(store.get_project("proj-1").unwrap(), None);

    let project = proxy_crab_mitm::flow::model::Project {
        id: "proj-1".into(),
        name: "结算链路".into(),
        description: "checkout flows".into(),
        color: "#4f46e5".into(),
        variables: BTreeMap::from([("baseUrl".into(), "https://example.com".into())]),
        secret_variables: BTreeMap::new(),
        created_at: 100,
        updated_at: 100,
    };
    store.put_project(&project).unwrap();
    assert_eq!(store.get_project("proj-1").unwrap(), Some(project.clone()));
    let mut earlier = project.clone();
    earlier.id = "proj-0".into();
    earlier.created_at = 50;
    earlier.updated_at = 50;
    store.put_project(&earlier).unwrap();
    assert_eq!(
        store
            .list_projects()
            .unwrap()
            .iter()
            .map(|project| project.id.as_str())
            .collect::<Vec<_>>(),
        vec!["proj-0", "proj-1"]
    );
    store.delete_project("proj-0").unwrap();
    assert_eq!(store.list_projects().unwrap().len(), 1);
    assert!(store.delete_project("proj-0").is_err());

    // Projects persist as camelCase JSON.
    let raw: serde_json::Value = serde_json::from_slice(
        &fs::read(root.path().join("flow/projects/proj-1.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(raw["id"], "proj-1");
    assert!(raw.get("secretVariables").is_some());
}

#[test]
fn request_library_and_workflow_crud_round_trip() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();

    let mut earlier = sample_entry("req-2");
    earlier.created_at = 50;
    earlier.updated_at = 50;
    store.put_request(&sample_entry("req-1")).unwrap();
    store.put_request(&earlier).unwrap();

    assert_eq!(
        store.get_request("req-1").unwrap(),
        Some(sample_entry("req-1"))
    );
    assert_eq!(
        store
            .list_requests()
            .unwrap()
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        vec!["req-2", "req-1"]
    );

    let mut renamed = sample_entry("req-1");
    renamed.name = "renamed".into();
    renamed.updated_at = 200;
    store.put_request(&renamed).unwrap();
    assert_eq!(store.get_request("req-1").unwrap().unwrap().name, "renamed");

    store.delete_request("req-1").unwrap();
    assert_eq!(store.get_request("req-1").unwrap(), None);
    assert!(store.delete_request("req-1").is_err());
    assert_eq!(store.list_requests().unwrap().len(), 1);
    assert_eq!(store.get_request("missing").unwrap(), None);

    store.put_workflow(&sample_workflow("wf-1")).unwrap();
    assert_eq!(
        store.get_workflow("wf-1").unwrap(),
        Some(sample_workflow("wf-1"))
    );
    assert_eq!(store.list_workflows().unwrap().len(), 1);
    store.delete_workflow("wf-1").unwrap();
    assert!(store.list_workflows().unwrap().is_empty());
}

#[test]
fn flow_definitions_persist_as_camel_case_json() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();

    let mut workflow = sample_workflow("wf-1");
    workflow.secret_variables.insert("token".into(), "s3cret".into());
    workflow.edges.push(WorkflowEdge {
        id: "e1".into(),
        source: "a".into(),
        target: "b".into(),
        source_handle: Some(ConditionBranchHandle::True),
    });
    store.put_workflow(&workflow).unwrap();

    let raw: serde_json::Value = serde_json::from_slice(
        &fs::read(root.path().join("flow/workflows/wf-1.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(raw["id"], "wf-1");
    assert_eq!(raw["projectId"], "proj-1");
    assert_eq!(raw["schemaVersion"], WORKFLOW_SCHEMA_VERSION);
    assert!(raw.get("secretVariables").is_some());
    assert_eq!(raw["nodes"][0]["type"], "start");
    assert_eq!(raw["nodes"][0]["config"], serde_json::json!({}));
    assert_eq!(raw["edges"][0]["sourceHandle"], "true");

    let mut set = sample_env_set("env-dev", "dev");
    set.secret_values.insert("password".into(), "hunter2".into());
    store.save_env_set(&set).unwrap();
    let raw: serde_json::Value = serde_json::from_slice(
        &fs::read(root.path().join("flow/env-sets.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(raw["schemaVersion"], ENV_SETS_SCHEMA_VERSION);
    assert!(raw["sets"][0].get("secretValues").is_some());
}

#[test]
fn corrupt_entity_files_degrade_list_and_error_on_get() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    store.put_request(&sample_entry("good")).unwrap();
    let library = root.path().join("flow/request-library");
    fs::write(library.join("garbage.json"), b"{not json").unwrap();
    // Valid JSON that fails the minimal shape: HAR snapshot without a log object.
    fs::write(
        library.join("shapeless.json"),
        br#"{"id":"shapeless","name":"x","tags":[],"source":"manual","origin":"","har":{},"createdAt":1,"updatedAt":1}"#,
    )
    .unwrap();
    // A healthy entry whose id does not match its file name is corrupt too.
    fs::write(
        library.join("mismatch.json"),
        serde_json::to_vec(&sample_entry("other")).unwrap(),
    )
    .unwrap();

    assert_eq!(
        store
            .list_requests()
            .unwrap()
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        vec!["good"]
    );
    let error = store.get_request("garbage").unwrap_err().to_string();
    assert!(error.contains("corrupt"), "{error}");
    assert!(store.get_request("shapeless").is_err());
    assert!(store.get_request("mismatch").is_err());
}

#[test]
fn env_sets_crud_upsert_and_delete() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    assert!(store.list_env_sets().unwrap().is_empty());

    store.save_env_set(&sample_env_set("env-dev", "dev")).unwrap();
    store.save_env_set(&sample_env_set("env-prod", "prod")).unwrap();
    store
        .save_env_set(&sample_env_set("env-staging", "staging"))
        .unwrap();
    assert_eq!(
        store
            .list_env_sets()
            .unwrap()
            .iter()
            .map(|set| set.id.as_str())
            .collect::<Vec<_>>(),
        vec!["env-dev", "env-prod", "env-staging"]
    );

    let mut updated = sample_env_set("env-dev", "dev");
    updated
        .values
        .insert("baseUrl".into(), "http://localhost:3000".into());
    updated.updated_at = 200;
    store.save_env_set(&updated).unwrap();
    let sets = store.list_env_sets().unwrap();
    assert_eq!(sets.len(), 3);
    assert_eq!(
        sets[0].values.get("baseUrl").map(String::as_str),
        Some("http://localhost:3000")
    );

    store.delete_env_set("env-prod").unwrap();
    assert_eq!(store.list_env_sets().unwrap().len(), 2);
    // Deleting a missing id succeeds silently.
    store.delete_env_set("env-missing").unwrap();
}

#[test]
fn corrupt_env_sets_degrade_reads_and_refuse_saving() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    store.save_env_set(&sample_env_set("env-dev", "dev")).unwrap();
    let path = root.path().join("flow/env-sets.json");

    fs::write(&path, b"{not json").unwrap();
    assert!(store.list_env_sets().unwrap().is_empty());
    let error = store
        .save_env_set(&sample_env_set("env-prod", "prod"))
        .unwrap_err()
        .to_string();
    assert!(error.contains("corrupt"), "{error}");

    // A newer envelope version is refused for both reads and writes.
    fs::write(
        &path,
        format!(r#"{{"schemaVersion":{},"sets":[]}}"#, ENV_SETS_SCHEMA_VERSION + 1),
    )
    .unwrap();
    assert!(store.list_env_sets().unwrap().is_empty());
    assert!(store.save_env_set(&sample_env_set("env-prod", "prod")).is_err());

    // Corrupt individual entries are dropped; healthy ones survive a save.
    fs::write(
        &path,
        format!(
            r#"{{"schemaVersion":{ENV_SETS_SCHEMA_VERSION},"sets":[{{}},{{"id":"env-dev","name":"dev","values":{{}},"secretValues":{{}},"createdAt":1,"updatedAt":1}}]}}"#
        ),
    )
    .unwrap();
    store
        .save_env_set(&sample_env_set("env-prod", "prod"))
        .unwrap();
    let sets = store.list_env_sets().unwrap();
    let ids = sets
        .iter()
        .map(|set| set.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec!["env-dev", "env-prod"]);
}

#[test]
fn invalid_shapes_and_ids_are_rejected_on_write() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();

    let mut entry = sample_entry("../escape");
    assert!(store.put_request(&entry).is_err());
    entry.id = "req-1".into();
    entry.har = serde_json::json!({ "entries": [] });
    assert!(store.put_request(&entry).is_err());

    // A workflow requires a non-empty projectId and sane node shapes.
    let mut workflow = sample_workflow("wf-1");
    workflow.project_id = "  ".into();
    assert!(store.put_workflow(&workflow).is_err());
    workflow.project_id = "proj-1".into();
    workflow.nodes[0].id = String::new();
    assert!(store.put_workflow(&workflow).is_err());
    workflow.nodes[0].id = "start".into();
    workflow.nodes[0].position = Position { x: f64::NAN, y: 0.0 };
    assert!(store.put_workflow(&workflow).is_err());

    let mut set = sample_env_set("env-dev", "dev");
    set.name = "   ".into();
    assert!(store.save_env_set(&set).is_err());

    let mut project = proxy_crab_mitm::flow::model::Project {
        id: "proj-1".into(),
        name: "  ".into(),
        description: String::new(),
        color: String::new(),
        variables: BTreeMap::new(),
        secret_variables: BTreeMap::new(),
        created_at: 1,
        updated_at: 1,
    };
    assert!(store.put_project(&project).is_err());
    project.name = "结算".into();
    assert!(store.put_project(&project).is_ok());

    // Invalid ids also fail fast on the read and delete paths.
    assert!(store.get_request("../escape").is_err());
    assert!(store.delete_request("../escape").is_err());
    assert!(store.delete_env_set("../escape").is_err());
    assert!(store.get_workflow("../escape").is_err());
    assert!(store.delete_project("../escape").is_err());
}

#[test]
fn concurrent_env_set_saves_do_not_lose_updates() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    thread::scope(|scope| {
        for index in 0..8 {
            let store = &store;
            scope.spawn(move || {
                store
                    .save_env_set(&sample_env_set(
                        &format!("env-{index}"),
                        &format!("env-{index}"),
                    ))
                    .unwrap();
            });
        }
    });
    let sets = store.list_env_sets().unwrap();
    assert_eq!(sets.len(), 8);
    assert_eq!(sets[0].values.get("baseUrl").map(String::as_str), Some("https://example.com"));
}

#[test]
fn concurrent_request_writes_stay_atomic() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    thread::scope(|scope| {
        for index in 0..8 {
            let store = &store;
            let mut entry = sample_entry("req-1");
            entry.name = format!("name-{index}");
            entry.created_at = index;
            entry.updated_at = index;
            scope.spawn(move || store.put_request(&entry).unwrap());
        }
    });
    let entry = store.get_request("req-1").unwrap().unwrap();
    // The file always holds one complete document, never a torn write.
    assert!(entry.name.starts_with("name-"));
    assert_eq!(store.list_requests().unwrap().len(), 1);
}
