//! Run record persistence in `<workspace>/flow/runs.db` (SQLite; plan Task 19
//! Step 1/4/5, plan decision 9).
//!
//! Layout: one `flow_runs` row per workflow run (`running` → terminal status)
//! plus one `flow_node_runs` row per node checkpoint (`(run_id, node_id)` upsert
//! — the "last execution wins" semantics of the archived `recordNodeRun`).
//! The graph snapshot captured at run creation is stored with the run row so a
//! run can be rendered even after the workflow definition changes.
//!
//! Volume control (plan W5 / Task 21) is owned by the run record storage task;
//! this module persists what the orchestration hands it. Convergence for orphan
//! `running` rows after a process restart is [`RunStore::converge_interrupted`]
//! (called once when the run manager opens; plan Task 19 Step 5).
//!
//! Access pattern mirrors `storage.rs`: one `rusqlite::Connection` behind a
//! std mutex, `busy_timeout` for cross-handle contention (each active run owns
//! its own writer, so contention only happens between concurrent runs), WAL
//! off (single-file simplicity, same as captures.db).

use std::{path::Path, sync::Mutex, time::Duration};

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::workspace::now_millis;

/// One workflow run (the `flow_runs` row). `trigger` is `manual` or `debug`;
/// `status` is `running | success | failed | cancelled | interrupted` (the
/// archived RunStatus literal set).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowRunRecord {
    pub id: String,
    pub workflow_id: String,
    #[serde(default)]
    pub workflow_name: String,
    pub trigger: String,
    pub status: String,
    /// Target Session the run replays into (`None` when the run was started
    /// before a Session existed — never the case for runs created by
    /// [`super::run`], which prechecks the target).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<u64>,
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Graph snapshot at run creation (nodes without pinned outputs; may be a
    /// skeleton when over the size cap — see `super::run`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_snapshot: Option<JsonValue>,
}

/// One node checkpoint (the `flow_node_runs` row): the last execution snapshot
/// of a node within one run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowNodeRunRecord {
    pub run_id: String,
    pub node_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Loop iteration detail of the node run (`NodeRun.iterations`); loop
    /// semantics land with plan Task 20/21, the column is provisioned here so
    /// checkpoints never drop the payload-provided detail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iterations: Option<JsonValue>,
    pub updated_at: u64,
}

/// Read/write access to `flow/runs.db` of one workspace.
pub struct RunStore {
    connection: Mutex<Connection>,
}

impl RunStore {
    /// Open (creating on first use) the run database of a workspace.
    pub fn open(workspace_root: &Path) -> Result<Self> {
        let path = workspace_root
            .join(super::store::FLOW_DIRECTORY)
            .join(super::store::RUNS_DATABASE_FILE);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(&path)
            .with_context(|| format!("failed to open run database {}", path.display()))?;
        Self::initialize(connection)
    }

    /// Open the run database only when the file already exists (the
    /// convergence scan must not create an empty database in workspaces that
    /// never ran a workflow).
    pub fn open_existing(workspace_root: &Path) -> Result<Option<Self>> {
        let path = workspace_root
            .join(super::store::FLOW_DIRECTORY)
            .join(super::store::RUNS_DATABASE_FILE);
        if !path.exists() {
            return Ok(None);
        }
        let connection = Connection::open(&path)
            .with_context(|| format!("failed to open run database {}", path.display()))?;
        Self::initialize(connection).map(Some)
    }

    fn initialize(connection: Connection) -> Result<Self> {
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS flow_runs (
                id             TEXT PRIMARY KEY,
                workflow_id    TEXT NOT NULL,
                workflow_name  TEXT NOT NULL DEFAULT '',
                trigger_kind   TEXT NOT NULL DEFAULT 'manual',
                status         TEXT NOT NULL,
                session_id     INTEGER,
                started_at     INTEGER NOT NULL,
                finished_at    INTEGER,
                error          TEXT,
                graph_snapshot TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_flow_runs_workflow_started
                ON flow_runs(workflow_id, started_at);
             CREATE TABLE IF NOT EXISTS flow_node_runs (
                run_id      TEXT NOT NULL,
                node_id     TEXT NOT NULL,
                status      TEXT NOT NULL,
                input       TEXT,
                output      TEXT,
                error       TEXT,
                started_at  INTEGER,
                duration_ms INTEGER,
                iterations  TEXT,
                updated_at  INTEGER NOT NULL,
                PRIMARY KEY (run_id, node_id)
             );",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .expect("run database lock poisoned")
    }

    /// Insert a fresh run row (status `running`).
    pub fn insert_run(&self, run: &FlowRunRecord) -> Result<()> {
        self.connection().execute(
            "INSERT INTO flow_runs (id, workflow_id, workflow_name, trigger_kind, status,
                                    session_id, started_at, finished_at, error, graph_snapshot)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                run.id,
                run.workflow_id,
                run.workflow_name,
                run.trigger,
                run.status,
                run.session_id.map(|id| id as i64),
                run.started_at as i64,
                run.finished_at.map(|value| value as i64),
                run.error,
                run.graph_snapshot
                    .as_ref()
                    .map(JsonValue::to_string),
            ],
        )?;
        Ok(())
    }

    /// Upsert one node checkpoint (last write wins per `(run_id, node_id)`).
    ///
    /// Volume gate (plan Task 21 Step 2 / W5): before the row is written the
    /// record is serialized to its JSON form and passed through
    /// `cap_node_run_object`, so `input` / `output` / `iterations` each stay
    /// within [`SNAPSHOT_MAX_BYTES`]. `None` fields are omitted by
    /// `skip_serializing_if` and skipped by the cap's null filter alike — the
    /// serialize round-trip is shape-stable (covered by tests).
    pub fn upsert_node_run(&self, node: &FlowNodeRunRecord) -> Result<()> {
        let capped = super::run_record::cap_node_run_object(
            &serde_json::to_value(node).context("serialize node run for volume cap")?,
            super::run_record::SNAPSHOT_MAX_BYTES,
            &node.node_id,
        );
        let snapshot = |key: &str| -> Option<String> {
            capped
                .get(key)
                .filter(|value| !value.is_null())
                .map(JsonValue::to_string)
        };
        self.connection().execute(
            "INSERT INTO flow_node_runs (run_id, node_id, status, input, output, error,
                                         started_at, duration_ms, iterations, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(run_id, node_id) DO UPDATE SET
                status = excluded.status,
                input = excluded.input,
                output = excluded.output,
                error = excluded.error,
                started_at = excluded.started_at,
                duration_ms = excluded.duration_ms,
                iterations = excluded.iterations,
                updated_at = excluded.updated_at",
            params![
                node.run_id,
                node.node_id,
                node.status,
                snapshot("input"),
                snapshot("output"),
                node.error,
                node.started_at.map(|value| value as i64),
                node.duration_ms.map(|value| value as i64),
                snapshot("iterations"),
                node.updated_at as i64,
            ],
        )?;
        Ok(())
    }

    /// Finalize one run: terminal status, error, finish timestamp.
    pub fn finish_run(
        &self,
        run_id: &str,
        status: &str,
        error: Option<&str>,
        finished_at: u64,
    ) -> Result<()> {
        self.connection().execute(
            "UPDATE flow_runs SET status = ?2, error = ?3, finished_at = ?4 WHERE id = ?1",
            params![run_id, status, error, finished_at as i64],
        )?;
        Ok(())
    }

    /// Read one run row.
    pub fn get_run(&self, run_id: &str) -> Result<Option<FlowRunRecord>> {
        let row = self
            .connection()
            .query_row(
                "SELECT id, workflow_id, workflow_name, trigger_kind, status, session_id,
                        started_at, finished_at, error, graph_snapshot
                 FROM flow_runs WHERE id = ?1",
                params![run_id],
                run_from_row,
            )
            .optional()?;
        Ok(row)
    }

    /// Read every node checkpoint of one run in insertion-neutral (node id)
    /// order.
    pub fn get_node_runs(&self, run_id: &str) -> Result<Vec<FlowNodeRunRecord>> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT run_id, node_id, status, input, output, error, started_at, duration_ms,
                    iterations, updated_at
             FROM flow_node_runs WHERE run_id = ?1 ORDER BY node_id",
        )?;
        let rows = statement
            .query_map(params![run_id], node_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// List runs newest first with optional workflow/status filters; returns
    /// `(page, total_matching)`.
    pub fn list_runs(
        &self,
        workflow_id: Option<&str>,
        status: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<(Vec<FlowRunRecord>, usize)> {
        let connection = self.connection();
        let total: i64 = connection.query_row(
            "SELECT COUNT(*) FROM flow_runs
             WHERE (?1 IS NULL OR workflow_id = ?1) AND (?2 IS NULL OR status = ?2)",
            params![workflow_id, status],
            |row| row.get(0),
        )?;
        let mut statement = connection.prepare(
            "SELECT id, workflow_id, workflow_name, trigger_kind, status, session_id,
                    started_at, finished_at, error, graph_snapshot
             FROM flow_runs
             WHERE (?1 IS NULL OR workflow_id = ?1) AND (?2 IS NULL OR status = ?2)
             ORDER BY started_at DESC, id DESC
             LIMIT ?3 OFFSET ?4",
        )?;
        let rows = statement
            .query_map(
                params![workflow_id, status, limit as i64, offset as i64],
                run_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((rows, total as usize))
    }

    /// Converge orphan `running` rows left behind by a process restart into the
    /// `interrupted` terminal status (plan Task 19 Step 5; the archived SW
    /// orphan scan equivalent). Node checkpoints are left as-is — nodes that
    /// stayed `running` are rendered neutrally by the run detail. Returns the
    /// number of converged runs.
    pub fn converge_interrupted(&self, error: &str) -> Result<u64> {
        let changed = self.connection().execute(
            "UPDATE flow_runs SET status = 'interrupted', error = ?1, finished_at = ?2
             WHERE status = 'running'",
            params![error, now_millis() as i64],
        )?;
        Ok(changed as u64)
    }
}

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<FlowRunRecord> {
    Ok(FlowRunRecord {
        id: row.get(0)?,
        workflow_id: row.get(1)?,
        workflow_name: row.get(2)?,
        trigger: row.get(3)?,
        status: row.get(4)?,
        session_id: row.get::<_, Option<i64>>(5)?.map(|value| value as u64),
        started_at: row.get::<_, i64>(6)? as u64,
        finished_at: row.get::<_, Option<i64>>(7)?.map(|value| value as u64),
        error: row.get(8)?,
        graph_snapshot: row
            .get::<_, Option<String>>(9)?
            .and_then(|text| serde_json::from_str(&text).ok()),
    })
}

fn node_from_row(row: &Row<'_>) -> rusqlite::Result<FlowNodeRunRecord> {
    let parse = |text: Option<String>| -> Option<JsonValue> {
        text.and_then(|text| serde_json::from_str(&text).ok())
    };
    Ok(FlowNodeRunRecord {
        run_id: row.get(0)?,
        node_id: row.get(1)?,
        status: row.get(2)?,
        input: parse(row.get(3)?),
        output: parse(row.get(4)?),
        error: row.get(5)?,
        started_at: row.get::<_, Option<i64>>(6)?.map(|value| value as u64),
        duration_ms: row.get::<_, Option<i64>>(7)?.map(|value| value as u64),
        iterations: parse(row.get(8)?),
        updated_at: row.get::<_, i64>(9)? as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_run(id: &str) -> FlowRunRecord {
        FlowRunRecord {
            id: id.to_owned(),
            workflow_id: "wf-1".into(),
            workflow_name: "demo".into(),
            trigger: "manual".into(),
            status: "running".into(),
            session_id: Some(7),
            started_at: 1000,
            finished_at: None,
            error: None,
            graph_snapshot: Some(json!({ "nodes": [], "edges": [] })),
        }
    }

    #[test]
    fn open_existing_never_creates_the_database() {
        let root = tempfile::tempdir().unwrap();
        assert!(RunStore::open_existing(root.path()).unwrap().is_none());
        assert!(!root.path().join("flow/runs.db").exists());
        // open() creates it, after which open_existing finds it.
        RunStore::open(root.path()).unwrap();
        assert!(RunStore::open_existing(root.path()).unwrap().is_some());
    }

    #[test]
    fn insert_checkpoint_finish_and_list_roundtrip() {
        let root = tempfile::tempdir().unwrap();
        let store = RunStore::open(root.path()).unwrap();
        store.insert_run(&sample_run("run-1")).unwrap();
        store
            .upsert_node_run(&FlowNodeRunRecord {
                run_id: "run-1".into(),
                node_id: "n1".into(),
                status: "running".into(),
                input: Some(json!({"a": 1})),
                output: None,
                error: None,
                started_at: Some(1001),
                duration_ms: None,
                iterations: None,
                updated_at: 1001,
            })
            .unwrap();
        // Last write wins on the same (run, node) key.
        store
            .upsert_node_run(&FlowNodeRunRecord {
                run_id: "run-1".into(),
                node_id: "n1".into(),
                status: "success".into(),
                input: Some(json!({"a": 1})),
                output: Some(json!({"b": [1, 2]})),
                error: None,
                started_at: Some(1001),
                duration_ms: Some(12),
                iterations: Some(json!({"total": 2})),
                updated_at: 1013,
            })
            .unwrap();

        let run = store.get_run("run-1").unwrap().unwrap();
        assert_eq!(run.status, "running");
        assert_eq!(run.session_id, Some(7));
        let nodes = store.get_node_runs("run-1").unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].status, "success");
        assert_eq!(nodes[0].output, Some(json!({"b": [1, 2]})));
        assert_eq!(nodes[0].iterations, Some(json!({"total": 2})));

        store.finish_run("run-1", "success", None, 1020).unwrap();
        let run = store.get_run("run-1").unwrap().unwrap();
        assert_eq!(run.status, "success");
        assert_eq!(run.finished_at, Some(1020));

        let (page, total) = store.list_runs(Some("wf-1"), Some("success"), 10, 0).unwrap();
        assert_eq!(total, 1);
        assert_eq!(page[0].id, "run-1");
        let (_, total) = store.list_runs(Some("wf-1"), Some("failed"), 10, 0).unwrap();
        assert_eq!(total, 0);
    }

    #[test]
    fn converge_marks_only_running_rows_interrupted_once() {
        let root = tempfile::tempdir().unwrap();
        let store = RunStore::open(root.path()).unwrap();
        store.insert_run(&sample_run("run-1")).unwrap();
        let mut finished = sample_run("run-2");
        finished.status = "success".into();
        store.insert_run(&finished).unwrap();

        let converged = store.converge_interrupted("进程重启：运行中断").unwrap();
        assert_eq!(converged, 1);
        let run = store.get_run("run-1").unwrap().unwrap();
        assert_eq!(run.status, "interrupted");
        assert_eq!(run.error.as_deref(), Some("进程重启：运行中断"));
        assert!(run.finished_at.is_some());
        assert_eq!(store.get_run("run-2").unwrap().unwrap().status, "success");

        // Idempotent: nothing left to converge.
        assert_eq!(store.converge_interrupted("again").unwrap(), 0);
    }
}
