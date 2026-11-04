//! MCP 暴露档位持久化（plan Task 25 Step 2）：工作区级三档开关，落盘为
//! `flow/mcp-tools.json`，与权限目录协同（更严者生效；门控本身在
//! proxy-crab-mgr 的 MCP 工具链里）。
//!
//! 存储形态跟随 flow 域惯例（`env-sets.json`）：带 `schemaVersion` 的版本化
//! 信封，缺文件即缺省值；损坏信封读取时降级为缺省值并告警（缺省 posture
//! 最收敛：读开 / 写关 / 执行关），写入时拒绝（绝不静默清空既有设置）。

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::workspace::write_json_atomic;

use super::store::{FlowStore, WRITE_LOCK};

/// 当前 `mcp-tools.json` 信封版本；布局演进时递增并在此登记迁移。
pub const MCP_TIERS_SCHEMA_VERSION: u32 = 1;

const MCP_TIERS_FILE: &str = "mcp-tools.json";

/// MCP 暴露三档开关（plan Task 25 Step 2）：读 / 写 / 执行。
/// 缺省：读开 / 写关 / 执行关（serde 缺字段同样落到该缺省）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpTiers {
    #[serde(default = "default_true")]
    pub read: bool,
    #[serde(default)]
    pub write: bool,
    #[serde(default)]
    pub execute: bool,
}

impl Default for McpTiers {
    fn default() -> Self {
        Self {
            read: true,
            write: false,
            execute: false,
        }
    }
}

fn default_true() -> bool {
    true
}

/// Versioned envelope persisted as `flow/mcp-tools.json`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpTiersEnvelope {
    schema_version: u32,
    #[serde(default)]
    tiers: McpTiers,
}

fn mcp_tiers_path(flow_root: &Path) -> PathBuf {
    flow_root.join(MCP_TIERS_FILE)
}

/// Parse and check one raw envelope (pure function). Unknown future versions
/// are refused (forward incompatibility, mirroring the env-sets envelope);
/// field-level damage degrades to the per-field serde defaults.
fn parse_envelope(raw: Value) -> Result<McpTiers> {
    let object = raw
        .as_object()
        .ok_or_else(|| anyhow!("flow {MCP_TIERS_FILE} is corrupt"))?;
    let version = object
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("flow {MCP_TIERS_FILE} is corrupt"))? as u32;
    if version > MCP_TIERS_SCHEMA_VERSION {
        bail!(
            "flow {MCP_TIERS_FILE} schema version {version} is not supported (expected <= {MCP_TIERS_SCHEMA_VERSION})"
        );
    }
    let envelope: McpTiersEnvelope =
        serde_json::from_value(raw).context("flow mcp-tools.json is corrupt")?;
    Ok(envelope.tiers)
}

/// Load the stored tiers: `None` when the file does not exist yet. A corrupt
/// or unsupported envelope errors so callers pick their policy (reads degrade,
/// writes refuse).
fn load_envelope(flow_root: &Path) -> Result<Option<McpTiers>> {
    let bytes = match std::fs::read(mcp_tiers_path(flow_root)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("failed to read flow mcp-tools.json"),
    };
    let raw: Value = serde_json::from_slice(&bytes).context("flow mcp-tools.json is corrupt")?;
    parse_envelope(raw).map(Some)
}

impl FlowStore {
    /// Read the MCP exposure tiers. A missing file yields the defaults; a
    /// corrupt or unsupported envelope degrades to the defaults with a warning
    /// so tier data never blocks callers (the defaults keep write/execute
    /// closed, the safer posture).
    pub fn mcp_tiers(&self) -> Result<McpTiers> {
        match load_envelope(&self.flow_root) {
            Ok(tiers) => Ok(tiers.unwrap_or_default()),
            Err(error) => {
                tracing::warn!("degrading MCP exposure tiers to defaults: {error:#}");
                Ok(McpTiers::default())
            }
        }
    }

    /// Replace the MCP exposure tiers. A corrupt or unsupported envelope
    /// refuses the save with a readable error (never silently wiped).
    pub fn save_mcp_tiers(&self, tiers: &McpTiers) -> Result<()> {
        let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
        // Refuse to overwrite an unreadable envelope (env-sets convention).
        load_envelope(&self.flow_root)?;
        let envelope = McpTiersEnvelope {
            schema_version: MCP_TIERS_SCHEMA_VERSION,
            tiers: tiers.clone(),
        };
        write_json_atomic(&mcp_tiers_path(&self.flow_root), &envelope)
            .context("failed to save flow mcp-tools.json")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_file_yields_the_default_posture() {
        let root = tempdir().unwrap();
        let store = FlowStore::open(root.path()).unwrap();
        assert_eq!(
            store.mcp_tiers().unwrap(),
            McpTiers {
                read: true,
                write: false,
                execute: false
            }
        );
    }

    #[test]
    fn tiers_round_trip_through_the_workspace() {
        let root = tempdir().unwrap();
        let store = FlowStore::open(root.path()).unwrap();
        let tiers = McpTiers {
            read: true,
            write: true,
            execute: true,
        };
        store.save_mcp_tiers(&tiers).unwrap();
        // 重开一个新句柄验证持久化往返（保存 → 重开读取一致）。
        let reopened = FlowStore::open(root.path()).unwrap();
        assert_eq!(reopened.mcp_tiers().unwrap(), tiers);
    }

    #[test]
    fn corrupt_envelope_degrades_reads_and_refuses_writes() {
        let root = tempdir().unwrap();
        let store = FlowStore::open(root.path()).unwrap();
        std::fs::write(mcp_tiers_path(&store.flow_root), b"{not json").unwrap();
        assert_eq!(store.mcp_tiers().unwrap(), McpTiers::default());
        // 写入拒绝损坏信封（绝不静默清空），修复后可写。
        assert!(store.save_mcp_tiers(&McpTiers::default()).is_err());
        std::fs::write(mcp_tiers_path(&store.flow_root), b"{not json").unwrap();
        std::fs::remove_file(mcp_tiers_path(&store.flow_root)).unwrap();
        store.save_mcp_tiers(&McpTiers::default()).unwrap();
        assert_eq!(store.mcp_tiers().unwrap(), McpTiers::default());
    }

    #[test]
    fn future_schema_versions_are_refused_on_write_and_degraded_on_read() {
        let root = tempdir().unwrap();
        let store = FlowStore::open(root.path()).unwrap();
        std::fs::write(
            mcp_tiers_path(&store.flow_root),
            br#"{"schemaVersion":99,"tiers":{"read":false,"write":true,"execute":true}}"#,
        )
        .unwrap();
        assert_eq!(store.mcp_tiers().unwrap(), McpTiers::default());
        assert!(store.save_mcp_tiers(&McpTiers::default()).is_err());
    }

    #[test]
    fn partial_documents_fill_missing_fields_with_defaults() {
        let root = tempdir().unwrap();
        let store = FlowStore::open(root.path()).unwrap();
        std::fs::write(
            mcp_tiers_path(&store.flow_root),
            br#"{"schemaVersion":1,"tiers":{"write":true}}"#,
        )
        .unwrap();
        assert_eq!(
            store.mcp_tiers().unwrap(),
            McpTiers {
                read: true,
                write: true,
                execute: false
            }
        );
    }
}
