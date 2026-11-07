//! Workflow-scoped persistent key/value storage over
//! `<workspace>/flow/workflow-data/{workflowId}.json` (one file per workflow).
//!
//! This is the workflow *data* store, deliberately distinct from the
//! environment family (`env_sets.rs`): env sets are activation-frozen string
//! tables shared across workflows and written back through a committed queue,
//! while the storage is bound to one workflow id, accepts arbitrary JSON
//! values, and persists every write immediately (put = durable, get = live
//! read). All runs of a workflow — and the management API — observe the same
//! file, so values written by one run are visible to later and concurrent
//! runs in real time.
//!
//! Layout: a versioned envelope per workflow
//! `{ schemaVersion, entries: { <key>: { value, updatedAt } } }` following the
//! env-sets envelope policy:
//! - reads degrade to empty with a warning on a corrupt/newer envelope
//!   (storage is a side enhancement and never blocks a run);
//! - read-modify-write paths re-validate inside the write critical section and
//!   refuse to persist over a corrupt/newer envelope (never silently wiped).
//!
//! Concurrency: every write takes the process-wide [`WRITE_LOCK`] and merges
//! exactly one key, so concurrent puts to different keys never clobber each
//! other; same-key writes resolve last-write-wins. There are no transactions.
//!
//! Not a secret store: values carry no secret marking and flow into run
//! records unmasked.

use std::{collections::BTreeMap, fs, path::PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    error::Error,
    flow::{
        env_sets::now_millis,
        store::{FlowStore, WRITE_LOCK, validate_flow_id},
    },
    workspace::write_json_atomic,
};

/// Current envelope schema version of one workflow-data document; bump
/// together with a migration registered in
/// [`workflow_storage_envelope_migrations`] when the layout evolves.
pub const WORKFLOW_STORAGE_SCHEMA_VERSION: u32 = 1;

/// Directory name of the workflow storage family under `flow/` (one JSON
/// document per workflow id); referenced by `flow_directories` so workspace
/// initialization creates it idempotently.
pub const WORKFLOW_STORAGE_DIRECTORY: &str = "workflow-data";

/// Maximum storage key length (same bound as flow entity ids).
pub const WORKFLOW_STORAGE_KEY_MAX_LEN: usize = 128;

/// Maximum serialized size of one stored value (256 KiB, aligned with the
/// per-node snapshot budget of the run record storage).
pub const WORKFLOW_STORAGE_VALUE_MAX_BYTES: usize = 256 * 1024;

/// Maximum total serialized size of one workflow's storage file payload
/// (keys + values, excluding envelope overhead).
pub const WORKFLOW_STORAGE_TOTAL_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Maximum number of entries per workflow storage.
pub const WORKFLOW_STORAGE_MAX_ENTRIES: usize = 10_000;

/// One stored key/value pair with its last-write timestamp (camelCase wire
/// format, mirroring the env family types).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStorageEntry {
    pub value: Value,
    pub updated_at: u64,
}

/// Versioned envelope persisted as `flow/workflow-data/{workflowId}.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStorageEnvelope {
    pub schema_version: u32,
    /// Insertion-ordered map is not required; BTreeMap keeps the file
    /// deterministic across platforms and readers.
    pub entries: BTreeMap<String, WorkflowStorageEntry>,
}

/// Envelope migration registry: target version -> in-place migration applied
/// to the previous shape. Version 1 is the initial layout, so the registry is
/// empty; register `(current + 1, migration)` here when the layout evolves
/// (same mechanism as [`crate::flow::env_sets`]).
type WorkflowStorageMigration = fn(&mut Value);

fn workflow_storage_envelope_migrations() -> &'static [(u32, WorkflowStorageMigration)] {
    &[]
}

/// Validate one storage key: non-empty, at most
/// [`WORKFLOW_STORAGE_KEY_MAX_LEN`] bytes, restricted to the ASCII flow entity
/// id charset (`[A-Za-z0-9._-]`, no `.` / `..`) so the key survives URL path
/// encoding untouched and the template first-segment resolution
/// (`{{ storage.<key>.<path> }}`) stays unambiguous. Stricter than
/// [`validate_flow_id`] (which accepts non-ASCII alphanumeric ids): storage
/// keys double as URL path segments in the management API.
pub fn validate_storage_key(key: &str) -> Result<()> {
    if key.is_empty()
        || key.len() > WORKFLOW_STORAGE_KEY_MAX_LEN
        || matches!(key, "." | "..")
        || !key.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        bail!(Error::InvalidArgument(format!(
            "invalid workflow storage key {key:?}"
        )));
    }
    Ok(())
}

/// Serialized size of one entry: key bytes plus serialized value bytes.
fn entry_size(key: &str, value: &Value) -> Result<usize> {
    let value_size = serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|error| anyhow!("workflow storage value is not serializable: {error}"))?;
    Ok(key.len() + value_size)
}

fn workflow_data_path(flow_root: &std::path::Path, workflow_id: &str) -> PathBuf {
    flow_root
        .join("workflow-data")
        .join(format!("{workflow_id}.json"))
}

/// Migrate and sanitize one raw envelope (pure function). Envelope-level
/// damage (bad shape, unknown or un-migratable version) errors so callers can
/// apply their read/write policy; per-entry damage is dropped with a warning
/// so one corrupt entry never hides the others.
fn migrate_envelope(raw: Value) -> Result<WorkflowStorageEnvelope> {
    let object = raw
        .as_object()
        .ok_or_else(|| anyhow!("workflow storage envelope is corrupt"))?;
    let version = object
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("workflow storage envelope is corrupt"))? as u32;
    if version > WORKFLOW_STORAGE_SCHEMA_VERSION {
        bail!(
            "workflow storage envelope schema version {version} is not supported (expected <= {WORKFLOW_STORAGE_SCHEMA_VERSION})"
        );
    }
    let mut current = raw;
    for step in (version + 1)..=WORKFLOW_STORAGE_SCHEMA_VERSION {
        let migration = workflow_storage_envelope_migrations()
            .iter()
            .find(|(target, _)| *target == step)
            .map(|(_, migration)| migration)
            .ok_or_else(|| {
                anyhow!("workflow storage envelope migration registry misses v{step}")
            })?;
        migration(&mut current);
    }
    let mut entries = BTreeMap::new();
    for (key, entry) in current
        .get("entries")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("workflow storage envelope is corrupt"))?
    {
        match validate_storage_key(key).and_then(|()| {
            serde_json::from_value::<WorkflowStorageEntry>(entry.clone())
                .map_err(|error| anyhow!(error))
        }) {
            Ok(entry) => {
                entries.insert(key.clone(), entry);
            }
            Err(error) => tracing::warn!("ignoring corrupt workflow storage entry: {error:#}"),
        }
    }
    Ok(WorkflowStorageEnvelope {
        schema_version: WORKFLOW_STORAGE_SCHEMA_VERSION,
        entries,
    })
}

/// Load and migrate one workflow's envelope: `None` when the file does not
/// exist yet. A corrupt or unsupported envelope errors so callers pick their
/// policy (reads degrade, read-modify-write refuses).
fn load_envelope(
    flow_root: &std::path::Path,
    workflow_id: &str,
) -> Result<Option<WorkflowStorageEnvelope>> {
    validate_flow_id(workflow_id)?;
    let bytes = match fs::read(workflow_data_path(flow_root, workflow_id)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).context(format!("failed to read workflow storage {workflow_id}"));
        }
    };
    let raw: Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("workflow storage {workflow_id} is corrupt"))?;
    migrate_envelope(raw).map(Some)
}

fn write_envelope(
    flow_root: &std::path::Path,
    workflow_id: &str,
    envelope: &WorkflowStorageEnvelope,
) -> Result<()> {
    write_json_atomic(&workflow_data_path(flow_root, workflow_id), envelope)
        .with_context(|| format!("failed to save workflow storage {workflow_id}"))
}

impl FlowStore {
    /// Read all entries of one workflow's storage. A missing file yields an
    /// empty map; a corrupt or unsupported envelope degrades to empty with a
    /// warning so stored data never blocks callers. An invalid workflow id is
    /// a caller bug and surfaces as [`Error::InvalidArgument`] (never
    /// degraded).
    pub fn workflow_storage_entries(
        &self,
        workflow_id: &str,
    ) -> Result<BTreeMap<String, WorkflowStorageEntry>> {
        validate_flow_id(workflow_id)?;
        let envelope = match load_envelope(&self.flow_root, workflow_id) {
            Ok(envelope) => envelope,
            Err(error) => {
                tracing::warn!("degrading workflow storage {workflow_id} to empty: {error:#}");
                return Ok(BTreeMap::new());
            }
        };
        Ok(envelope
            .map(|envelope| envelope.entries)
            .unwrap_or_default())
    }

    /// Read one key: `None` when the file or the key does not exist; a
    /// corrupt envelope degrades to `None` with a warning (same policy as
    /// [`FlowStore::workflow_storage_entries`]).
    pub fn workflow_storage_get(
        &self,
        workflow_id: &str,
        key: &str,
    ) -> Result<Option<WorkflowStorageEntry>> {
        let entries = self.workflow_storage_entries(workflow_id)?;
        Ok(entries.get(key).cloned())
    }

    /// Upsert one key with an arbitrary JSON value, persisting immediately
    /// (put = durable). Concurrent writes serialize on [`WRITE_LOCK`] and
    /// merge exactly this key, so different-key puts never clobber each
    /// other; same-key writes resolve last-write-wins. A corrupt or
    /// unsupported existing envelope refuses the write (never silently
    /// wiped). Quota violations (value bytes, total bytes, entry count) are
    /// rejected as [`Error::InvalidArgument`].
    ///
    /// Returns the stored entry (including the fresh `updatedAt`).
    pub fn workflow_storage_put(
        &self,
        workflow_id: &str,
        key: &str,
        value: &Value,
    ) -> Result<WorkflowStorageEntry> {
        validate_flow_id(workflow_id)?;
        validate_storage_key(key)?;
        let value_size = entry_size(key, value)?;
        if value_size > WORKFLOW_STORAGE_VALUE_MAX_BYTES {
            bail!(Error::InvalidArgument(format!(
                "workflow storage value for key {key:?} is too large ({value_size} bytes, max {WORKFLOW_STORAGE_VALUE_MAX_BYTES})"
            )));
        }
        let entry = WorkflowStorageEntry {
            value: value.clone(),
            updated_at: now_millis(),
        };
        let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
        let mut envelope =
            load_envelope(&self.flow_root, workflow_id)?.unwrap_or(WorkflowStorageEnvelope {
                schema_version: WORKFLOW_STORAGE_SCHEMA_VERSION,
                entries: BTreeMap::new(),
            });
        if !envelope.entries.contains_key(key)
            && envelope.entries.len() >= WORKFLOW_STORAGE_MAX_ENTRIES
        {
            bail!(Error::InvalidArgument(format!(
                "workflow storage {workflow_id} is full (max {WORKFLOW_STORAGE_MAX_ENTRIES} entries)"
            )));
        }
        let total_size: usize = envelope
            .entries
            .iter()
            .filter(|(existing_key, _)| existing_key.as_str() != key)
            .map(|(existing_key, existing)| entry_size(existing_key, &existing.value))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .sum();
        if total_size + value_size > WORKFLOW_STORAGE_TOTAL_MAX_BYTES {
            bail!(Error::InvalidArgument(format!(
                "workflow storage {workflow_id} total size budget exceeded (max {WORKFLOW_STORAGE_TOTAL_MAX_BYTES} bytes)"
            )));
        }
        envelope.entries.insert(key.to_owned(), entry.clone());
        write_envelope(&self.flow_root, workflow_id, &envelope)?;
        Ok(entry)
    }

    /// Delete one key; a missing file or missing key fails with
    /// [`Error::FlowEntityNotFound`] so the management layer surfaces 404. A
    /// corrupt or unsupported envelope refuses the deletion.
    pub fn workflow_storage_delete(&self, workflow_id: &str, key: &str) -> Result<()> {
        validate_flow_id(workflow_id)?;
        validate_storage_key(key)?;
        let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
        let mut envelope = load_envelope(&self.flow_root, workflow_id)?
            .ok_or_else(|| Error::FlowEntityNotFound("workflow storage key", key.to_owned()))?;
        if envelope.entries.remove(key).is_none() {
            return Err(Error::FlowEntityNotFound("workflow storage key", key.to_owned()).into());
        }
        write_envelope(&self.flow_root, workflow_id, &envelope)
    }

    /// Remove every entry of one workflow's storage (the file is deleted
    /// outright, so an empty storage leaves no file behind). Returns the
    /// number of cleared entries; a missing file is `0`. A corrupt or
    /// unsupported envelope refuses the clear.
    pub fn workflow_storage_clear(&self, workflow_id: &str) -> Result<usize> {
        validate_flow_id(workflow_id)?;
        let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
        let Some(envelope) = load_envelope(&self.flow_root, workflow_id)? else {
            return Ok(0);
        };
        let cleared = envelope.entries.len();
        match fs::remove_file(workflow_data_path(&self.flow_root, workflow_id)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .context(format!("failed to clear workflow storage {workflow_id}"));
            }
        }
        Ok(cleared)
    }

    /// Read the plain key -> value snapshot used to seed a run's
    /// `{{ storage.* }}` template namespace at dispatch. Missing file /
    /// corrupt envelope degrade to an empty snapshot with a warning (same
    /// read policy as [`FlowStore::workflow_storage_entries`]); an invalid
    /// workflow id surfaces as [`Error::InvalidArgument`].
    pub fn workflow_storage_snapshot(&self, workflow_id: &str) -> Result<BTreeMap<String, Value>> {
        validate_flow_id(workflow_id)?;
        let entries = self.workflow_storage_entries(workflow_id)?;
        Ok(entries
            .into_iter()
            .map(|(key, entry)| (key, entry.value))
            .collect())
    }

    /// Delete one workflow's whole storage file (best-effort cascade when the
    /// workflow definition is deleted); a missing file succeeds silently.
    pub fn delete_workflow_data(&self, workflow_id: &str) -> Result<()> {
        validate_flow_id(workflow_id)?;
        let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
        match fs::remove_file(workflow_data_path(&self.flow_root, workflow_id)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => {
                Err(error).context(format!("failed to delete workflow storage {workflow_id}"))
            }
        }
    }
}
