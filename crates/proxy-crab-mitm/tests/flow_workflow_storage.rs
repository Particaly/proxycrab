//! Integration tests for the workflow-scoped persistent key/value storage
//! (`flow/workflow-data/{workflowId}.json`): CRUD, key validation, quotas,
//! corrupt-envelope read/write policies and the dispatch snapshot.

use std::fs;

use proxy_crab_mitm::error::Error;
use proxy_crab_mitm::flow::store::FlowStore;
use proxy_crab_mitm::flow::workflow_data::{
    WORKFLOW_STORAGE_KEY_MAX_LEN, WORKFLOW_STORAGE_MAX_ENTRIES, WORKFLOW_STORAGE_SCHEMA_VERSION,
    WORKFLOW_STORAGE_TOTAL_MAX_BYTES, WORKFLOW_STORAGE_VALUE_MAX_BYTES,
};
use serde_json::{Value, json};
use tempfile::tempdir;

fn read_envelope_raw(root: &std::path::Path, workflow_id: &str) -> Value {
    serde_json::from_slice(
        &fs::read(
            root.join("flow/workflow-data")
                .join(format!("{workflow_id}.json")),
        )
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn put_get_delete_round_trip_persists_json_values() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();

    // Missing file reads as empty everywhere.
    assert!(
        store
            .workflow_storage_get("wf-a", "counter")
            .unwrap()
            .is_none()
    );
    assert!(store.workflow_storage_entries("wf-a").unwrap().is_empty());
    assert!(store.workflow_storage_snapshot("wf-a").unwrap().is_empty());

    // Arbitrary JSON values persist immediately (put = durable).
    let stored = store
        .workflow_storage_put("wf-a", "counter", &json!({ "hits": 3, "tags": ["a", "b"] }))
        .unwrap();
    assert_eq!(stored.value, json!({ "hits": 3, "tags": ["a", "b"] }));
    assert!(stored.updated_at > 0);
    assert_eq!(
        store
            .workflow_storage_get("wf-a", "counter")
            .unwrap()
            .unwrap()
            .value,
        json!({ "hits": 3, "tags": ["a", "b"] })
    );

    // A scalar value is as legal as an object.
    store
        .workflow_storage_put("wf-a", "flag", &json!(true))
        .unwrap();
    assert_eq!(
        store
            .workflow_storage_get("wf-a", "flag")
            .unwrap()
            .unwrap()
            .value,
        json!(true)
    );

    // The wire envelope is the versioned camelCase shape.
    let raw = read_envelope_raw(root.path(), "wf-a");
    assert_eq!(raw["schemaVersion"], WORKFLOW_STORAGE_SCHEMA_VERSION);
    assert_eq!(raw["entries"]["flag"]["value"], json!(true));
    assert!(raw["entries"]["flag"]["updatedAt"].is_u64());

    // Delete removes exactly one key; a second delete of the same key is 404.
    store.workflow_storage_delete("wf-a", "flag").unwrap();
    assert!(
        store
            .workflow_storage_get("wf-a", "flag")
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .workflow_storage_get("wf-a", "counter")
            .unwrap()
            .is_some()
    );
    let error = store.workflow_storage_delete("wf-a", "flag").unwrap_err();
    assert!(matches!(
        error.downcast_ref::<Error>(),
        Some(Error::FlowEntityNotFound(_, _))
    ));

    // Different workflows never see each other's entries.
    assert!(
        store
            .workflow_storage_get("wf-b", "counter")
            .unwrap()
            .is_none()
    );
}

#[test]
fn put_merges_single_key_without_clobbering_others() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    store
        .workflow_storage_put("wf-a", "k1", &json!("v1"))
        .unwrap();
    store
        .workflow_storage_put("wf-a", "k2", &json!("v2"))
        .unwrap();

    // Overwriting k1 keeps k2 (per-key merge, not whole-file replace).
    store
        .workflow_storage_put("wf-a", "k1", &json!("v1-updated"))
        .unwrap();
    assert_eq!(
        store
            .workflow_storage_get("wf-a", "k1")
            .unwrap()
            .unwrap()
            .value,
        json!("v1-updated")
    );
    assert_eq!(
        store
            .workflow_storage_get("wf-a", "k2")
            .unwrap()
            .unwrap()
            .value,
        json!("v2")
    );
    assert_eq!(store.workflow_storage_entries("wf-a").unwrap().len(), 2);
}

#[test]
fn key_validation_rejects_unsafe_or_oversized_keys() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();

    for key in ["", ".", "..", "a/b", "a b", "键", "lead "] {
        let error = store
            .workflow_storage_put("wf-a", key, &json!(1))
            .err()
            .unwrap_or_else(|| panic!("key {key:?} should be rejected"));
        assert!(
            matches!(
                error.downcast_ref::<Error>(),
                Some(Error::InvalidArgument(_))
            ),
            "key {key:?} should map to InvalidArgument, got {error:#}"
        );
    }
    let long_key = "k".repeat(WORKFLOW_STORAGE_KEY_MAX_LEN + 1);
    assert!(
        store
            .workflow_storage_put("wf-a", &long_key, &json!(1))
            .is_err()
    );

    // The boundary key length itself is accepted, including dots in the middle.
    let max_key = "k".repeat(WORKFLOW_STORAGE_KEY_MAX_LEN);
    store
        .workflow_storage_put("wf-a", &max_key, &json!(1))
        .unwrap();
    store
        .workflow_storage_put("wf-a", "a.b_c-d", &json!(1))
        .unwrap();
}

#[test]
fn quota_violations_are_rejected_as_invalid_arguments() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();

    // Value over the per-value budget.
    let oversized = "x".repeat(WORKFLOW_STORAGE_VALUE_MAX_BYTES);
    let error = store
        .workflow_storage_put("wf-a", "big", &json!(oversized))
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<Error>(),
        Some(Error::InvalidArgument(_))
    ));
    assert!(store.workflow_storage_get("wf-a", "big").unwrap().is_none());

    // Total budget: fill up with values just under the per-value cap.
    let chunk = "y".repeat(WORKFLOW_STORAGE_VALUE_MAX_BYTES - 16);
    let mut total = 0usize;
    let mut index = 0usize;
    while total + chunk.len() + 8 <= WORKFLOW_STORAGE_TOTAL_MAX_BYTES {
        let key = format!("k{index:04}");
        store
            .workflow_storage_put("wf-a", &key, &json!(chunk))
            .unwrap();
        total += chunk.len() + key.len();
        index += 1;
    }
    let error = store
        .workflow_storage_put("wf-a", "overflow", &json!(chunk))
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<Error>(),
        Some(Error::InvalidArgument(_))
    ));

    // Clear resets everything (and reports how much was removed).
    let cleared = store.workflow_storage_clear("wf-a").unwrap();
    assert_eq!(cleared, index);
    assert!(store.workflow_storage_entries("wf-a").unwrap().is_empty());
    assert!(!root.path().join("flow/workflow-data/wf-a.json").exists());
    assert_eq!(store.workflow_storage_clear("wf-a").unwrap(), 0);
}

#[test]
fn entry_count_quota_rejects_new_keys_only() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    // 直接预置「配额 - 1」条目的原始信封（避开 10k 次逐键落盘的测试开销，
    // Windows 上每次原子写约几十毫秒），再经真实 put 验证边界两侧。
    let mut entries = serde_json::Map::new();
    for index in 0..(WORKFLOW_STORAGE_MAX_ENTRIES - 1) {
        entries.insert(
            format!("k{index:05}"),
            json!({ "value": index, "updatedAt": 1 }),
        );
    }
    let envelope = json!({
        "schemaVersion": WORKFLOW_STORAGE_SCHEMA_VERSION,
        "entries": entries,
    });
    fs::create_dir_all(root.path().join("flow/workflow-data")).unwrap();
    fs::write(
        root.path().join("flow/workflow-data/wf-a.json"),
        serde_json::to_vec(&envelope).unwrap(),
    )
    .unwrap();

    // 第 WORKFLOW_STORAGE_MAX_ENTRIES 条新键恰好放行…
    store
        .workflow_storage_put("wf-a", "last", &json!(1))
        .unwrap();
    // …再多一条新键被拒绝…
    let error = store
        .workflow_storage_put("wf-a", "extra", &json!(1))
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<Error>(),
        Some(Error::InvalidArgument(_))
    ));
    // …但覆盖既有键不受条目数限制。
    store
        .workflow_storage_put("wf-a", "k00000", &json!("updated"))
        .unwrap();
    assert_eq!(
        store
            .workflow_storage_get("wf-a", "k00000")
            .unwrap()
            .unwrap()
            .value,
        json!("updated")
    );
}

#[test]
fn corrupt_envelope_reads_degrade_and_writes_refuse() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    store
        .workflow_storage_put("wf-a", "counter", &json!(1))
        .unwrap();

    // Corrupt the file behind the store's back.
    fs::write(
        root.path().join("flow/workflow-data/wf-a.json"),
        b"{not json",
    )
    .unwrap();

    // Reads degrade to empty with a warning (never block a run).
    assert!(store.workflow_storage_entries("wf-a").unwrap().is_empty());
    assert!(
        store
            .workflow_storage_get("wf-a", "counter")
            .unwrap()
            .is_none()
    );
    assert!(store.workflow_storage_snapshot("wf-a").unwrap().is_empty());

    // Read-modify-write refuses to persist over the corrupt envelope.
    assert!(
        store
            .workflow_storage_put("wf-a", "other", &json!(2))
            .is_err()
    );
    assert!(store.workflow_storage_delete("wf-a", "counter").is_err());

    // A newer schema version is equally refused on write…
    let newer = json!({ "schemaVersion": WORKFLOW_STORAGE_SCHEMA_VERSION + 1, "entries": {} });
    fs::write(
        root.path().join("flow/workflow-data/wf-a.json"),
        serde_json::to_vec(&newer).unwrap(),
    )
    .unwrap();
    assert!(
        store
            .workflow_storage_put("wf-a", "other", &json!(2))
            .is_err()
    );
    // …while reads still degrade instead of failing the caller.
    assert!(store.workflow_storage_snapshot("wf-a").unwrap().is_empty());
}

#[test]
fn snapshot_and_cascade_follow_the_workflow_id() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    store.workflow_storage_put("wf-a", "a", &json!(1)).unwrap();
    store
        .workflow_storage_put("wf-a", "b", &json!({ "c": [2] }))
        .unwrap();

    let snapshot = store.workflow_storage_snapshot("wf-a").unwrap();
    assert_eq!(snapshot.get("a"), Some(&json!(1)));
    assert_eq!(snapshot.get("b"), Some(&json!({ "c": [2] })));

    // Cascade delete removes the whole file and is idempotent.
    store.delete_workflow_data("wf-a").unwrap();
    assert!(!root.path().join("flow/workflow-data/wf-a.json").exists());
    store.delete_workflow_data("wf-a").unwrap();
    assert!(store.workflow_storage_snapshot("wf-a").unwrap().is_empty());
}

#[test]
fn invalid_workflow_ids_are_rejected_before_io() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    assert!(store.workflow_storage_entries("bad/id").is_err());
    assert!(
        store
            .workflow_storage_put("bad/id", "k", &json!(1))
            .is_err()
    );
    assert!(store.workflow_storage_clear("bad/id").is_err());
    assert!(store.delete_workflow_data("bad/id").is_err());
}
