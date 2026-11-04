//! Integration tests for the env family storage (`flow/env-sets.json`):
//! activation semantics, global variables, secret masking round trips and the
//! script env write-back queue (plan Task 17 Steps 1 and 4).

use std::collections::BTreeMap;
use std::fs;
use std::sync::Mutex;

use proxy_crab_mitm::flow::env_sets::{
    self, EnvGlobalVariables, SECRET_MASK_PLACEHOLDER, mask_env_set, mask_globals,
    resolve_active_env_snapshot, strip_globals_secrets_for_export, strip_secrets_for_export,
};
use proxy_crab_mitm::flow::store::{ENV_SETS_SCHEMA_VERSION, EnvVariableSet, FlowStore};
use serde_json::{Value, json};
use tempfile::tempdir;

/// 写回队列是进程级单例：同二进制内使用队列的测试必须串行，避免批次互串。
static WRITE_BACK_QUEUE_LOCK: Mutex<()> = Mutex::new(());

fn sample_set(id: &str, name: &str) -> EnvVariableSet {
    EnvVariableSet {
        id: id.to_owned(),
        name: name.to_owned(),
        values: BTreeMap::new(),
        secret_values: BTreeMap::new(),
        created_at: 1,
        updated_at: 1,
    }
}

fn writes(entries: &[(&str, Value)]) -> BTreeMap<String, Value> {
    entries
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect()
}

fn read_envelope_raw(root: &std::path::Path) -> Value {
    serde_json::from_slice(&fs::read(root.join("flow/env-sets.json")).unwrap()).unwrap()
}

#[test]
fn activation_preference_round_trips_and_refuses_unknown_sets() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();

    // No activation by default; reading with no file at all is fine.
    assert_eq!(store.active_env_set_id().unwrap(), None);
    assert_eq!(store.active_env_snapshot().unwrap(), Default::default());

    store.save_env_set(&sample_set("env-dev", "dev")).unwrap();
    store.save_env_set(&sample_set("env-prod", "prod")).unwrap();

    // One-click activation, then switching sets.
    assert_eq!(
        store
            .set_active_env_set(Some("env-dev"))
            .unwrap()
            .as_deref(),
        Some("env-dev")
    );
    assert_eq!(
        store
            .set_active_env_set(Some("env-prod"))
            .unwrap()
            .as_deref(),
        Some("env-prod")
    );

    // Activating an unknown set is refused and keeps the old preference.
    assert!(store.set_active_env_set(Some("env-missing")).is_err());
    assert_eq!(
        store.active_env_set_id().unwrap().as_deref(),
        Some("env-prod")
    );

    // Clearing the preference works.
    assert_eq!(store.set_active_env_set(None).unwrap(), None);
    store.set_active_env_set(Some("env-dev")).unwrap();

    // The preference is persisted inside the same envelope.
    let raw = read_envelope_raw(root.path());
    assert_eq!(raw["activeSetId"], "env-dev");
    assert_eq!(raw["schemaVersion"], ENV_SETS_SCHEMA_VERSION);
}

#[test]
fn deleting_the_active_set_clears_the_preference() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    store.save_env_set(&sample_set("env-dev", "dev")).unwrap();
    store.save_env_set(&sample_set("env-prod", "prod")).unwrap();
    store.set_active_env_set(Some("env-dev")).unwrap();

    // Deleting an inactive set keeps the preference.
    store.delete_env_set("env-prod").unwrap();
    assert_eq!(
        store.active_env_set_id().unwrap().as_deref(),
        Some("env-dev")
    );

    // Deleting the active set auto-clears the preference (archived semantics).
    store.delete_env_set("env-dev").unwrap();
    assert_eq!(store.active_env_set_id().unwrap(), None);
}

#[test]
fn save_and_delete_preserve_globals_and_preference() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    store.save_env_set(&sample_set("env-dev", "dev")).unwrap();
    store.set_active_env_set(Some("env-dev")).unwrap();
    store
        .save_env_globals(&EnvGlobalVariables {
            values: BTreeMap::from([("region".to_owned(), "cn".to_owned())]),
            secret_values: BTreeMap::from([("license".to_owned(), "key-1234".to_owned())]),
        })
        .unwrap();

    // Set writes keep globals + preference.
    let mut updated = sample_set("env-dev", "dev");
    updated
        .values
        .insert("baseUrl".to_owned(), "http://x".to_owned());
    store.save_env_set(&updated).unwrap();
    let globals = store.env_globals().unwrap();
    assert_eq!(globals.values.get("region").map(String::as_str), Some("cn"));
    assert_eq!(
        store.active_env_set_id().unwrap().as_deref(),
        Some("env-dev")
    );

    // Globals writes keep sets + preference.
    store
        .save_env_globals(&EnvGlobalVariables {
            values: BTreeMap::from([("region".to_owned(), "us".to_owned())]),
            secret_values: BTreeMap::new(),
        })
        .unwrap();
    assert_eq!(store.list_env_sets().unwrap().len(), 1);
    assert_eq!(
        store.active_env_set_id().unwrap().as_deref(),
        Some("env-dev")
    );

    // Empty variable keys are rejected on both tables.
    let bad_globals = EnvGlobalVariables {
        values: BTreeMap::from([("  ".to_owned(), "x".to_owned())]),
        secret_values: BTreeMap::new(),
    };
    assert!(store.save_env_globals(&bad_globals).is_err());
    let mut bad_set = sample_set("env-bad", "bad");
    bad_set.secret_values.insert(" ".to_owned(), "x".to_owned());
    assert!(store.save_env_set(&bad_set).is_err());
}

#[test]
fn unsupported_envelope_versions_are_refused_like_before() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    store.save_env_set(&sample_set("env-dev", "dev")).unwrap();
    let path = root.path().join("flow/env-sets.json");

    fs::write(
        &path,
        format!(
            r#"{{"schemaVersion":{},"sets":[]}}"#,
            ENV_SETS_SCHEMA_VERSION + 1
        ),
    )
    .unwrap();
    assert!(store.list_env_sets().unwrap().is_empty());
    assert!(store.save_env_set(&sample_set("env-prod", "prod")).is_err());
    assert!(store.set_active_env_set(Some("env-dev")).is_err());

    // A legacy layout without the extras still loads (defaults apply).
    fs::write(
        &path,
        format!(
            r#"{{"schemaVersion":{ENV_SETS_SCHEMA_VERSION},"sets":[{{"id":"env-dev","name":"dev","values":{{}},"secretValues":{{}},"createdAt":1,"updatedAt":1}}]}}"#
        ),
    )
    .unwrap();
    assert_eq!(store.list_env_sets().unwrap().len(), 1);
    assert_eq!(store.active_env_set_id().unwrap(), None);
    assert_eq!(store.env_globals().unwrap(), EnvGlobalVariables::default());

    // A corrupt activation preference degrades to None without losing sets.
    fs::write(
        &path,
        format!(
            r#"{{"schemaVersion":{ENV_SETS_SCHEMA_VERSION},"sets":[{{"id":"env-dev","name":"dev","values":{{}},"secretValues":{{}},"createdAt":1,"updatedAt":1}}],"activeSetId":"../escape"}}"#
        ),
    )
    .unwrap();
    assert_eq!(store.active_env_set_id().unwrap(), None);
    assert_eq!(store.list_env_sets().unwrap().len(), 1);
}

#[test]
fn masked_reads_and_restored_writes_keep_secrets_intact() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    let mut set = sample_set("env-dev", "dev");
    set.values
        .insert("baseUrl".to_owned(), "http://localhost".to_owned());
    set.secret_values
        .insert("password".to_owned(), "hunter2".to_owned());
    store.save_env_set(&set).unwrap();

    // Reads handed to the UI mask secret values only.
    let masked = mask_env_set(&store.list_env_sets().unwrap()[0]);
    assert_eq!(
        masked.secret_values.get("password").map(String::as_str),
        Some(SECRET_MASK_PLACEHOLDER)
    );
    assert_eq!(
        masked.values.get("baseUrl").map(String::as_str),
        Some("http://localhost")
    );

    // A masked write round trip restores the untouched secret and keeps the
    // explicit override.
    let mut incoming = masked.clone();
    incoming
        .secret_values
        .insert("token".to_owned(), "new-token".to_owned());
    let existing = &store.list_env_sets().unwrap()[0];
    env_sets::restore_masked_secret_values(&mut incoming.secret_values, &existing.secret_values);
    assert_eq!(
        incoming.secret_values.get("password").map(String::as_str),
        Some("hunter2")
    );
    incoming.id = "env-dev".to_owned();
    incoming.created_at = existing.created_at;
    store.save_env_set(&incoming).unwrap();
    let stored = &store.list_env_sets().unwrap()[0];
    assert_eq!(
        stored.secret_values.get("password").map(String::as_str),
        Some("hunter2")
    );
    assert_eq!(
        stored.secret_values.get("token").map(String::as_str),
        Some("new-token")
    );

    // Globals mask/restore behaves the same.
    store
        .save_env_globals(&EnvGlobalVariables {
            values: BTreeMap::new(),
            secret_values: BTreeMap::from([("license".to_owned(), "key-1234".to_owned())]),
        })
        .unwrap();
    let masked_globals = mask_globals(&store.env_globals().unwrap());
    assert_eq!(
        masked_globals
            .secret_values
            .get("license")
            .map(String::as_str),
        Some(SECRET_MASK_PLACEHOLDER)
    );
    assert_eq!(
        strip_globals_secrets_for_export(&store.env_globals().unwrap())
            .secret_values
            .len(),
        0
    );
    assert_eq!(strip_secrets_for_export(stored).secret_values.len(), 0);
}

#[test]
fn write_back_batches_persist_serially_with_secret_routing() {
    let _guard = WRITE_BACK_QUEUE_LOCK.lock().unwrap();
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    let mut set = sample_set("env-dev", "dev");
    set.secret_values
        .insert("password".to_owned(), "hunter2".to_owned());
    store.save_env_set(&set).unwrap();
    store.set_active_env_set(Some("env-dev")).unwrap();

    // The dispatch-time active snapshot feeds the run chain (Task 19).
    let snapshot = store.active_env_snapshot().unwrap();
    assert_eq!(
        snapshot.values.get("password").map(String::as_str),
        Some("hunter2")
    );
    assert_eq!(snapshot.secret_values, vec!["hunter2".to_owned()]);

    // Submit several batches; application order follows submission order.
    store
        .submit_env_write_back(
            "env-dev",
            writes(&[
                ("baseUrl", json!("http://localhost:3000")),
                ("password", json!("hunter3")),
                ("count", json!(42)),
            ]),
        )
        .unwrap();
    store
        .submit_env_write_back(
            "env-dev",
            writes(&[("baseUrl", json!("http://localhost:5173"))]),
        )
        .unwrap();
    // Unknown set ids are accepted at submit time (committed) and dropped at flush.
    store
        .submit_env_write_back("env-gone", writes(&[("x", json!(1))]))
        .unwrap();
    // Invalid set ids are refused at submit time.
    assert!(
        store
            .submit_env_write_back("../escape", writes(&[("x", json!(1))]))
            .is_err()
    );
    assert!(
        store
            .submit_env_write_back("env-dev", BTreeMap::new())
            .is_err()
    );

    let flush = store.flush_env_write_backs().unwrap();
    assert_eq!(flush.applied, 2);
    assert_eq!(flush.dropped, 1);

    let stored = &store.list_env_sets().unwrap()[0];
    // Same-key writes end last-write-wins; cross-key writes merge.
    assert_eq!(
        stored.values.get("baseUrl").map(String::as_str),
        Some("http://localhost:5173")
    );
    // Numbers are stringified like the archived contract.
    assert_eq!(stored.values.get("count").map(String::as_str), Some("42"));
    // Keys already in the secret table keep their secret marking.
    assert_eq!(
        stored.secret_values.get("password").map(String::as_str),
        Some("hunter3")
    );
    assert!(!stored.values.contains_key("password"));

    // The set was rewritten (updatedAt bumped) and preference untouched.
    assert!(stored.updated_at > 1);
    assert_eq!(
        store.active_env_set_id().unwrap().as_deref(),
        Some("env-dev")
    );

    // A drained queue flushes nothing.
    let flush = store.flush_env_write_backs().unwrap();
    assert_eq!(flush.applied, 0);
    assert_eq!(flush.dropped, 0);

    // Objects serialize to JSON text.
    store
        .submit_env_write_back("env-dev", writes(&[("payload", json!({"a": [1, 2]}))]))
        .unwrap();
    store.flush_env_write_backs().unwrap();
    let stored = &store.list_env_sets().unwrap()[0];
    assert_eq!(
        stored.values.get("payload").map(String::as_str),
        Some(r#"{"a":[1,2]}"#)
    );
}

#[test]
fn write_back_to_a_deleted_set_is_dropped_without_resurrection() {
    let _guard = WRITE_BACK_QUEUE_LOCK.lock().unwrap();
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    store.save_env_set(&sample_set("env-dev", "dev")).unwrap();
    store
        .submit_env_write_back("env-dev", writes(&[("x", json!(1))]))
        .unwrap();
    store.delete_env_set("env-dev").unwrap();

    let flush = store.flush_env_write_backs().unwrap();
    assert_eq!(flush.applied, 0);
    assert_eq!(flush.dropped, 1);
    // The deleted set is not silently recreated.
    assert!(store.list_env_sets().unwrap().is_empty());
    // A missing file entirely also just drops the batch.
    store
        .submit_env_write_back("env-dev", writes(&[("x", json!(1))]))
        .unwrap();
    let flush = store.flush_env_write_backs().unwrap();
    assert_eq!(flush.dropped, 1);
}

#[test]
fn resolve_active_env_snapshot_matches_the_archived_semantics() {
    let mut set = sample_set("env-dev", "dev");
    set.values.insert("a".to_owned(), "normal".to_owned());
    set.secret_values
        .insert("b".to_owned(), "secret".to_owned());
    // Unknown active id: empty snapshot (no environment).
    assert_eq!(
        resolve_active_env_snapshot(std::slice::from_ref(&set), Some("env-x")),
        Default::default()
    );
}
