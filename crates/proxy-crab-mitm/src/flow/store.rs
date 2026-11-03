//! Flow domain persistence under `<workspace>/flow/` (workspace schema v4).
//!
//! Layout:
//! - `flow/request-library/{id}.json` — request library entries, one file per entry
//! - `flow/request-library/bodies/{id}.body` — request body blobs referenced by
//!   `bodyRef` (created lazily; owned by [`super::request_library`])
//! - `flow/workflows/{id}.json` — workflow definitions, one file per workflow
//! - `flow/env-sets.json` — versioned envelope of environment variable sets
//! - `flow/runs.db` — run record database; created by the run record storage on
//!   first use, never pre-created as an empty file
//!
//! Definitions stay as human-reviewable JSON (agreed decision 9). Reads validate
//! shapes and degrade without panicking: list calls skip corrupt files with a
//! warning, single-record reads surface readable errors. Writes reuse the
//! workspace atomic file replacement and are serialized process-wide so
//! read-modify-write sequences (env sets) cannot interleave.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::workspace::write_json_atomic;

/// Workspace flow directory root.
pub const FLOW_DIRECTORY: &str = "flow";
pub(crate) const REQUEST_LIBRARY_DIRECTORY: &str = "request-library";
const WORKFLOWS_DIRECTORY: &str = "workflows";
const ENV_SETS_FILE: &str = "env-sets.json";
/// Run record database location under `flow/`; the SQLite schema is owned by
/// the run record storage tasks and the file is created on first use only.
pub const RUNS_DATABASE_FILE: &str = "runs.db";
/// Current envelope schema version of `env-sets.json`; bump together with a
/// migration when the envelope layout evolves.
pub const ENV_SETS_SCHEMA_VERSION: u32 = 1;

/// Request library model: lives in [`crate::flow::request_library`] (typed HAR
/// snapshot, body blobs, capture ingestion); re-exported here so existing
/// `flow::store` import paths keep working.
pub use crate::flow::request_library::{RequestLibraryEntry, RequestSource};

/// Directories of the flow family under a workspace root. Shared by workspace
/// initialization and the v3 to v4 migration; creation is idempotent.
pub(crate) fn flow_directories(workspace_root: &Path) -> [PathBuf; 3] {
    let flow = workspace_root.join(FLOW_DIRECTORY);
    [
        flow.clone(),
        flow.join(REQUEST_LIBRARY_DIRECTORY),
        flow.join(WORKFLOWS_DIRECTORY),
    ]
}

/// Serializes every flow write in this process, independent of how many
/// `FlowStore` handles exist, so read-modify-write sequences cannot interleave.
pub(crate) static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// A workflow definition (canvas orchestration). Node configs stay as raw JSON
/// at this skeleton stage; the workflow model task aligns them field by field
/// with the ReqFlow engine payload.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefinition {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
    #[serde(default)]
    pub secret_variables: BTreeMap<String, String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: WorkflowNodeType,
    pub position: Position,
    pub config: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

/// Node types mirrored from the ReqFlow engine payload.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowNodeType {
    Start,
    HttpReplay,
    Condition,
    Loop,
    Delay,
    SetVariable,
    Assert,
    Transform,
    StickyNote,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    /// Branch handle of a condition node out-edge (`true` / `false`); kept as a
    /// plain string until the workflow model task tightens it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_handle: Option<String>,
}

/// One named environment variable set (dev / staging / prod style).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvVariableSet {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    #[serde(default)]
    pub secret_values: BTreeMap<String, String>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Versioned envelope persisted as `flow/env-sets.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvSetsEnvelope {
    pub schema_version: u32,
    pub sets: Vec<EnvVariableSet>,
}

/// A flow entity persisted as one JSON document per id inside a flow directory.
pub(crate) trait FlowEntity: Serialize + DeserializeOwned {
    /// Directory name under `flow/`.
    const DIRECTORY: &'static str;
    /// Human-readable label used in error messages.
    const LABEL: &'static str;

    fn flow_id(&self) -> &str;
    /// Deterministic list order: (createdAt, id).
    fn sort_key(&self) -> (u64, &str);
    /// Minimal shape validation aligned with the archived ReqFlow
    /// `storage/validate.ts` intent: field presence, types and enums only, no
    /// business rules.
    fn validate(&self) -> Result<()>;
}

impl FlowEntity for RequestLibraryEntry {
    const DIRECTORY: &'static str = REQUEST_LIBRARY_DIRECTORY;
    const LABEL: &'static str = "request library entry";

    fn flow_id(&self) -> &str {
        &self.id
    }

    fn sort_key(&self) -> (u64, &str) {
        (self.created_at, &self.id)
    }

    fn validate(&self) -> Result<()> {
        super::request_library::validate_entry(self)
    }
}

impl FlowEntity for WorkflowDefinition {
    const DIRECTORY: &'static str = WORKFLOWS_DIRECTORY;
    const LABEL: &'static str = "workflow";

    fn flow_id(&self) -> &str {
        &self.id
    }

    fn sort_key(&self) -> (u64, &str) {
        (self.created_at, &self.id)
    }

    fn validate(&self) -> Result<()> {
        validate_flow_id(&self.id)?;
        for node in &self.nodes {
            if node.id.is_empty() {
                bail!("workflow {} contains a node without an id", self.id);
            }
            if !node.position.x.is_finite() || !node.position.y.is_finite() {
                bail!(
                    "workflow {} node {} has a non-finite position",
                    self.id, node.id
                );
            }
            if !node.config.is_object() {
                bail!("workflow {} node {} config must be an object", self.id, node.id);
            }
        }
        for edge in &self.edges {
            if edge.id.is_empty() || edge.source.is_empty() || edge.target.is_empty() {
                bail!(
                    "workflow {} contains an edge without id/source/target",
                    self.id
                );
            }
        }
        Ok(())
    }
}

impl EnvVariableSet {
    fn validate(&self) -> Result<()> {
        validate_flow_id(&self.id)?;
        if self.name.trim().is_empty() {
            bail!(
                "environment variable set {} requires a non-empty name",
                self.id
            );
        }
        Ok(())
    }
}

/// Flow entity ids double as file names and later API path segments: restrict
/// them to a single safe component (same character policy as script names).
pub(crate) fn validate_flow_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || matches!(id, "." | "..")
        || !id
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        bail!("invalid flow id {id:?}");
    }
    Ok(())
}

fn entity_path(flow_root: &Path, directory: &str, id: &str) -> PathBuf {
    flow_root.join(directory).join(format!("{id}.json"))
}

fn put_entity<T: FlowEntity>(flow_root: &Path, value: &T) -> Result<()> {
    let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
    put_entity_locked(flow_root, value)
}

/// Write one entity while the flow write lock is already held, so callers can
/// extend the critical section around a read-modify-write sequence (capture
/// ingestion holds it across name dedup, blob write and entry write).
pub(crate) fn put_entity_locked<T: FlowEntity>(flow_root: &Path, value: &T) -> Result<()> {
    value.validate()?;
    write_json_atomic(&entity_path(flow_root, T::DIRECTORY, value.flow_id()), value)
        .with_context(|| format!("failed to save {} {}", T::LABEL, value.flow_id()))
}

fn get_entity<T: FlowEntity>(flow_root: &Path, id: &str) -> Result<Option<T>> {
    validate_flow_id(id)?;
    let path = entity_path(flow_root, T::DIRECTORY, id);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {} {id}", T::LABEL));
        }
    };
    parse_entity(&bytes, id).map(Some)
}

/// Parse and validate one entity document, keeping the stored id bound to the
/// file name it was found in.
fn parse_entity<T: FlowEntity>(bytes: &[u8], id: &str) -> Result<T> {
    let value: T = serde_json::from_slice(bytes)
        .with_context(|| format!("flow {} {id} is corrupt", T::LABEL))?;
    value
        .validate()
        .with_context(|| format!("flow {} {id} failed shape validation", T::LABEL))?;
    if value.flow_id() != id {
        bail!(
            "flow {} {id} stores a mismatched id {}",
            T::LABEL,
            value.flow_id()
        );
    }
    Ok(value)
}

pub(crate) fn list_entities<T: FlowEntity>(flow_root: &Path) -> Result<Vec<T>> {
    let directory = flow_root.join(T::DIRECTORY);
    let mut values: Vec<T> = Vec::new();
    for entry in fs::read_dir(&directory)
        .with_context(|| format!("failed to list flow {}", T::DIRECTORY))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let id = entry
            .file_name()
            .to_string_lossy()
            .trim_end_matches(".json")
            .to_owned();
        match fs::read(&path)
            .map_err(anyhow::Error::from)
            .and_then(|bytes| parse_entity(&bytes, &id))
        {
            Ok(value) => values.push(value),
            Err(error) => tracing::warn!(
                "ignoring corrupt flow {} file {}: {error:#}",
                T::DIRECTORY,
                path.display()
            ),
        }
    }
    values.sort_by(|left, right| left.sort_key().cmp(&right.sort_key()));
    Ok(values)
}

pub(crate) fn delete_entity<T: FlowEntity>(flow_root: &Path, id: &str) -> Result<()> {
    validate_flow_id(id)?;
    let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
    let path = entity_path(flow_root, T::DIRECTORY, id);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(anyhow!("{} {id} not found", T::LABEL))
        }
        Err(error) => Err(error).with_context(|| format!("failed to delete {} {id}", T::LABEL)),
    }
}

/// Envelope as read from disk: raw set entries so one corrupt entry does not
/// hide the remaining sets.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEnvSetsEnvelope {
    schema_version: u32,
    sets: Vec<serde_json::Value>,
}

/// Read and validate the envelope structure (version check), returning raw set
/// entries; per-entry sanitization is the caller's policy.
fn read_env_sets_entries(bytes: &[u8]) -> Result<Vec<serde_json::Value>> {
    let raw: RawEnvSetsEnvelope = serde_json::from_slice(bytes)
        .context("flow env-sets.json is corrupt")?;
    if raw.schema_version != ENV_SETS_SCHEMA_VERSION {
        bail!(
            "flow env-sets.json schema version {} is not supported (expected {})",
            raw.schema_version,
            ENV_SETS_SCHEMA_VERSION
        );
    }
    Ok(raw.sets)
}

fn parse_env_set(value: serde_json::Value) -> Result<EnvVariableSet> {
    serde_json::from_value(value).map_err(|error| anyhow!("corrupt environment variable set: {error}"))
}

fn env_sets_path(flow_root: &Path) -> PathBuf {
    flow_root.join(ENV_SETS_FILE)
}

/// Read/write access to the flow directory family of one workspace.
pub struct FlowStore {
    pub(crate) flow_root: PathBuf,
}

impl FlowStore {
    /// Open the flow directory family under a workspace root, creating any
    /// missing directories (idempotent with workspace initialization).
    pub fn open(workspace_root: &Path) -> Result<Self> {
        for directory in flow_directories(workspace_root) {
            fs::create_dir_all(directory)?;
        }
        Ok(Self {
            flow_root: workspace_root.join(FLOW_DIRECTORY),
        })
    }

    /// Atomically insert or replace a request library entry.
    pub fn put_request(&self, entry: &RequestLibraryEntry) -> Result<()> {
        put_entity(&self.flow_root, entry)
    }

    /// Read one request library entry: `None` when absent, a readable error
    /// when the file exists but is corrupt.
    pub fn get_request(&self, id: &str) -> Result<Option<RequestLibraryEntry>> {
        get_entity(&self.flow_root, id)
    }

    /// List request library entries sorted by (createdAt, id); corrupt files
    /// are skipped with a warning.
    pub fn list_requests(&self) -> Result<Vec<RequestLibraryEntry>> {
        list_entities(&self.flow_root)
    }

    // `delete_request` lives in `request_library.rs` together with the body
    // blob cleanup it now owns.

    /// Atomically insert or replace a workflow definition.
    pub fn put_workflow(&self, workflow: &WorkflowDefinition) -> Result<()> {
        put_entity(&self.flow_root, workflow)
    }

    /// Read one workflow definition: `None` when absent, a readable error when
    /// the file exists but is corrupt.
    pub fn get_workflow(&self, id: &str) -> Result<Option<WorkflowDefinition>> {
        get_entity(&self.flow_root, id)
    }

    /// List workflow definitions sorted by (createdAt, id); corrupt files are
    /// skipped with a warning.
    pub fn list_workflows(&self) -> Result<Vec<WorkflowDefinition>> {
        list_entities(&self.flow_root)
    }

    /// Delete one workflow definition.
    pub fn delete_workflow(&self, id: &str) -> Result<()> {
        delete_entity::<WorkflowDefinition>(&self.flow_root, id)
    }

    /// Read all environment variable sets. A missing file yields an empty
    /// list; a corrupt or unsupported envelope degrades to empty with a
    /// warning so environment data never blocks callers.
    pub fn list_env_sets(&self) -> Result<Vec<EnvVariableSet>> {
        let bytes = match fs::read(env_sets_path(&self.flow_root)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error).context("failed to read flow env-sets.json"),
        };
        let entries = match read_env_sets_entries(&bytes) {
            Ok(entries) => entries,
            Err(error) => {
                tracing::warn!("degrading flow environment variable sets to empty: {error:#}");
                return Ok(Vec::new());
            }
        };
        let mut sets = Vec::new();
        for entry in entries {
            match parse_env_set(entry) {
                Ok(set) => sets.push(set),
                Err(error) => {
                    tracing::warn!("ignoring corrupt environment variable set: {error:#}")
                }
            }
        }
        Ok(sets)
    }

    /// Insert or replace one environment variable set, preserving the other
    /// sets and their order. A corrupt or unsupported envelope refuses the
    /// save with a readable error (never silently wiped); corrupt individual
    /// entries are dropped with a warning.
    pub fn save_env_set(&self, set: &EnvVariableSet) -> Result<()> {
        set.validate()?;
        let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
        let path = env_sets_path(&self.flow_root);
        let mut sets = match fs::read(&path) {
            Ok(bytes) => {
                let mut parsed = Vec::new();
                for entry in read_env_sets_entries(&bytes)? {
                    match parse_env_set(entry) {
                        Ok(existing) => parsed.push(existing),
                        Err(error) => tracing::warn!(
                            "dropping corrupt environment variable set during save: {error:#}"
                        ),
                    }
                }
                parsed
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error).context("failed to read flow env-sets.json"),
        };
        match sets.iter().position(|existing| existing.id == set.id) {
            Some(index) => sets[index] = set.clone(),
            None => sets.push(set.clone()),
        }
        write_json_atomic(
            &path,
            &EnvSetsEnvelope {
                schema_version: ENV_SETS_SCHEMA_VERSION,
                sets,
            },
        )
        .context("failed to save flow env-sets.json")
    }

    /// Delete one environment variable set by id; a missing id succeeds
    /// silently. A corrupt or unsupported envelope refuses the deletion with
    /// a readable error.
    pub fn delete_env_set(&self, id: &str) -> Result<()> {
        validate_flow_id(id)?;
        let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
        let path = env_sets_path(&self.flow_root);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error).context("failed to read flow env-sets.json"),
        };
        let mut sets = Vec::new();
        for entry in read_env_sets_entries(&bytes)? {
            match parse_env_set(entry) {
                Ok(existing) if existing.id != id => sets.push(existing),
                Ok(_) => {}
                Err(error) => tracing::warn!(
                    "dropping corrupt environment variable set during delete: {error:#}"
                ),
            }
        }
        write_json_atomic(
            &path,
            &EnvSetsEnvelope {
                schema_version: ENV_SETS_SCHEMA_VERSION,
                sets,
            },
        )
        .context("failed to save flow env-sets.json")
    }
}
