//! Flow domain persistence under `<workspace>/flow/` (workspace schema v4).
//!
//! Layout:
//! - `flow/projects/{id}.json` — projects, one file per project
//! - `flow/request-library/{id}.json` — request library entries, one file per entry
//! - `flow/request-library/bodies/{id}.body` — request body blobs referenced by
//!   `bodyRef` (created lazily; owned by [`super::request_library`])
//! - `flow/workflows/{id}.json` — workflow definitions, one file per workflow
//! - `flow/workflow-data/{id}.json` — workflow-scoped persistent key/value
//!   storage, one file per workflow (owned by [`crate::flow::workflow_data`])
//! - `flow/env-sets.json` — versioned envelope of environment variable sets
//! - `flow/mcp-tools.json` — versioned envelope of the MCP exposure tiers
//!   (plan Task 25 Step 2; owned by [`crate::flow::mcp_tiers`])
//! - `flow/mcp-audit.json` — versioned envelope of the MCP tool call audit log
//!   (plan Task 25 Step 4; owned by [`crate::flow::mcp_audit`])
//! - `flow/runs.db` — run record database; created by the run record storage on
//!   first use, never pre-created as an empty file
//!
//! Definitions stay as human-reviewable JSON (agreed decision 9). Reads validate
//! shapes and degrade without panicking: list calls skip corrupt files with a
//! warning, single-record reads surface readable errors. Writes reuse the
//! workspace atomic file replacement and are serialized process-wide so
//! read-modify-write sequences (env sets) cannot interleave.
//!
//! Workflow documents carry `schemaVersion` (see
//! [`crate::flow::model::WORKFLOW_SCHEMA_VERSION`]): writes always persist the
//! current version, reads of older documents migrate in place first (refId
//! backfill, mirroring the archived ReqFlow `WorkflowRepo.get` semantics) and
//! write the migrated document back without touching timestamps.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    flow::{
        env_sets::{EnvGlobalVariables, validate_variables_table},
        model::{Project, WORKFLOW_SCHEMA_VERSION, Workflow, WorkflowNode, migrate_workflow},
    },
    workspace::write_json_atomic,
};

/// Workspace flow directory root.
pub const FLOW_DIRECTORY: &str = "flow";
pub(crate) const REQUEST_LIBRARY_DIRECTORY: &str = "request-library";
const PROJECTS_DIRECTORY: &str = "projects";
const WORKFLOWS_DIRECTORY: &str = "workflows";
/// Run record database location under `flow/`; the SQLite schema is owned by
/// the run record storage tasks and the file is created on first use only.
pub const RUNS_DATABASE_FILE: &str = "runs.db";
/// Current envelope schema version of `env-sets.json`; bump together with a
/// migration registered in [`crate::flow::env_sets`] when the layout evolves.
pub const ENV_SETS_SCHEMA_VERSION: u32 = 1;

/// Request library model: lives in [`crate::flow::request_library`] (typed HAR
/// snapshot, body blobs, capture ingestion); re-exported here so existing
/// `flow::store` import paths keep working.
pub use crate::flow::request_library::{RequestLibraryEntry, RequestSource};

/// Directories of the flow family under a workspace root. Shared by workspace
/// initialization and the v3 to v4 migration; creation is idempotent. The
/// workflow-data directory (workflow-scoped storage) is additive: existing v4
/// workspaces self-heal it on the next `FlowStore::open` / workspace open.
pub(crate) fn flow_directories(workspace_root: &Path) -> [PathBuf; 5] {
    let flow = workspace_root.join(FLOW_DIRECTORY);
    [
        flow.clone(),
        flow.join(PROJECTS_DIRECTORY),
        flow.join(REQUEST_LIBRARY_DIRECTORY),
        flow.join(WORKFLOWS_DIRECTORY),
        flow.join(super::workflow_data::WORKFLOW_STORAGE_DIRECTORY),
    ]
}

/// Serializes every flow write in this process, independent of how many
/// `FlowStore` handles exist, so read-modify-write sequences cannot interleave.
pub(crate) static WRITE_LOCK: Mutex<()> = Mutex::new(());

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

/// Versioned envelope persisted as `flow/env-sets.json` (file layout is owned
/// by [`crate::flow::env_sets`]: migration, globals and the activation
/// preference live there).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvSetsEnvelope {
    pub schema_version: u32,
    pub sets: Vec<EnvVariableSet>,
    /// Currently activated set id (preference); absent = no active env.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_set_id: Option<String>,
    /// Global variables table (normal + secret values).
    #[serde(default)]
    pub globals: EnvGlobalVariables,
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
    /// business rules (graph validation lives in `flow::validate` and gates
    /// runs, not saves).
    fn validate(&self) -> Result<()>;
}

impl FlowEntity for Project {
    const DIRECTORY: &'static str = PROJECTS_DIRECTORY;
    const LABEL: &'static str = "project";

    fn flow_id(&self) -> &str {
        &self.id
    }

    fn sort_key(&self) -> (u64, &str) {
        (self.created_at, &self.id)
    }

    fn validate(&self) -> Result<()> {
        validate_flow_id(&self.id)?;
        if self.name.trim().is_empty() {
            bail!("project {} requires a non-empty name", self.id);
        }
        Ok(())
    }
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

impl FlowEntity for Workflow {
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
        if self.project_id.trim().is_empty() {
            bail!("workflow {} requires a non-empty projectId", self.id);
        }
        // Newer schema versions are refused (forward incompatibility, mirroring
        // the env-sets envelope and the archived import semantics): silently
        // dropping unknown future fields would corrupt definitions.
        if self.schema_version > WORKFLOW_SCHEMA_VERSION {
            bail!(
                "workflow {} schema version {} is not supported (expected <= {})",
                self.id,
                self.schema_version,
                WORKFLOW_SCHEMA_VERSION
            );
        }
        for node in &self.nodes {
            validate_node(node)?;
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

/// Minimal per-node shape check: id presence, finite position. The typed
/// [`WorkflowNode`] already guarantees node type / config shape via serde.
fn validate_node(node: &WorkflowNode) -> Result<()> {
    if node.id.is_empty() {
        bail!("workflow contains a node without an id");
    }
    if !node.position.x.is_finite() || !node.position.y.is_finite() {
        bail!("workflow node {} has a non-finite position", node.id);
    }
    Ok(())
}

impl EnvVariableSet {
    pub(crate) fn validate(&self) -> Result<()> {
        validate_flow_id(&self.id)?;
        if self.name.trim().is_empty() {
            bail!(
                "environment variable set {} requires a non-empty name",
                self.id
            );
        }
        validate_variables_table(&self.values)?;
        validate_variables_table(&self.secret_values)?;
        Ok(())
    }
}

/// Flow entity ids double as file names and later API path segments: restrict
/// them to a single safe component (same character policy as script names).
/// Typed as [`crate::error::Error::InvalidArgument`] so the management layer
/// maps a malformed API id to 400 instead of an internal error.
pub(crate) fn validate_flow_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || matches!(id, "." | "..")
        || !id
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        bail!(crate::error::Error::InvalidArgument(format!(
            "invalid flow id {id:?}"
        )));
    }
    Ok(())
}

/// Fresh flow entity id (`{prefix}-{base64url(12 random bytes)}`), safe as a
/// file name and API path segment (same policy as request library entry ids).
/// Callers pick a stable prefix per entity family (`proj`, `wf`, …).
pub fn generate_flow_id(prefix: &str) -> Result<String> {
    let mut bytes = [0_u8; 12];
    getrandom::fill(&mut bytes).map_err(|error| anyhow!("generate flow id: {error}"))?;
    Ok(format!("{prefix}-{}", URL_SAFE_NO_PAD.encode(bytes)))
}

fn entity_path(flow_root: &Path, directory: &str, id: &str) -> PathBuf {
    flow_root.join(directory).join(format!("{id}.json"))
}

pub(crate) fn put_entity<T: FlowEntity>(flow_root: &Path, value: &T) -> Result<()> {
    let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
    put_entity_locked(flow_root, value)
}

/// Write one entity while the flow write lock is already held, so callers can
/// extend the critical section around a read-modify-write sequence (capture
/// ingestion holds it across name dedup, blob write and entry write).
pub(crate) fn put_entity_locked<T: FlowEntity>(flow_root: &Path, value: &T) -> Result<()> {
    value.validate()?;
    write_json_atomic(
        &entity_path(flow_root, T::DIRECTORY, value.flow_id()),
        value,
    )
    .with_context(|| format!("failed to save {} {}", T::LABEL, value.flow_id()))
}

pub(crate) fn get_entity<T: FlowEntity>(flow_root: &Path, id: &str) -> Result<Option<T>> {
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
    for entry in
        fs::read_dir(&directory).with_context(|| format!("failed to list flow {}", T::DIRECTORY))?
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
            Err(crate::error::Error::FlowEntityNotFound(T::LABEL, id.to_owned()).into())
        }
        Err(error) => Err(error).with_context(|| format!("failed to delete {} {id}", T::LABEL)),
    }
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

    /// Atomically insert or replace a project.
    pub fn put_project(&self, project: &Project) -> Result<()> {
        put_entity(&self.flow_root, project)
    }

    /// Read one project: `None` when absent, a readable error when the file
    /// exists but is corrupt.
    pub fn get_project(&self, id: &str) -> Result<Option<Project>> {
        get_entity(&self.flow_root, id)
    }

    /// List projects sorted by (createdAt, id); corrupt files are skipped with
    /// a warning.
    pub fn list_projects(&self) -> Result<Vec<Project>> {
        list_entities(&self.flow_root)
    }

    /// Delete one project (workflows referencing it are not cascaded; the
    /// caller decides the policy).
    pub fn delete_project(&self, id: &str) -> Result<()> {
        delete_entity::<Project>(&self.flow_root, id)
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

    /// Atomically insert or replace a workflow definition. The document is
    /// always persisted at the current [`WORKFLOW_SCHEMA_VERSION`].
    pub fn put_workflow(&self, workflow: &Workflow) -> Result<()> {
        let mut workflow = workflow.clone();
        workflow.schema_version = WORKFLOW_SCHEMA_VERSION;
        put_entity(&self.flow_root, &workflow)
    }

    /// Read one workflow definition: `None` when absent, a readable error when
    /// the file exists but is corrupt.
    ///
    /// Mirrors the archived ReqFlow `WorkflowRepo.get`: documents below the
    /// current schema version migrate first (refId backfill, idempotent) and
    /// the migrated document is written back with unchanged timestamps, so
    /// later reads and runs observe the same short codes.
    pub fn get_workflow(&self, id: &str) -> Result<Option<Workflow>> {
        let Some(mut workflow) = get_entity::<Workflow>(&self.flow_root, id)? else {
            return Ok(None);
        };
        if migrate_workflow(&mut workflow) {
            let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
            write_json_atomic(
                &entity_path(&self.flow_root, Workflow::DIRECTORY, id),
                &workflow,
            )
            .with_context(|| format!("failed to save migrated workflow {id}"))?;
        }
        Ok(Some(workflow))
    }

    /// List workflow definitions sorted by (createdAt, id); corrupt files are
    /// skipped with a warning. Documents are returned as stored — migration to
    /// the current schema version happens on [`FlowStore::get_workflow`],
    /// mirroring the archived repository (list never mutates).
    pub fn list_workflows(&self) -> Result<Vec<Workflow>> {
        list_entities(&self.flow_root)
    }

    /// Delete one workflow definition.
    pub fn delete_workflow(&self, id: &str) -> Result<()> {
        delete_entity::<Workflow>(&self.flow_root, id)
    }

    // Environment variable sets, global variables and the script env
    // write-back queue live in `env_sets.rs`; workflow-scoped key/value
    // storage lives in `workflow_data.rs` (same `FlowStore` impl).
}
