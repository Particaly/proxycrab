//! MCP 工具调用审计持久化（plan Task 25 Step 4）：记录 MCP 工具的每次调用
//! （调用者身份、入参摘要、结果与权限判定），落盘为 `flow/mcp-audit.json`，
//! 供管理 API（`GET /api/mcp-audit`）查询。
//!
//! 存储形态跟随 flow 域惯例（`mcp-tiers.json`）：带 `schemaVersion` 的版本化
//! 信封，缺文件即空列表。与 `mcp_tiers` 的「写拒绝」策略刻意不同：审计是
//! append-only 的辅助数据，不处于关键路径——追加时遇到损坏信封直接降级为空
//! 信封重写（宁可丢历史也不让工具调用被审计故障阻断），读取损坏降级为空列表
//! 并告警；调用侧（proxy-crab-mgr）对追加失败同样只告警不阻断。

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::workspace::write_json_atomic;

use super::store::{FlowStore, WRITE_LOCK};

/// 当前 `mcp-audit.json` 信封版本；布局演进时递增并在此登记迁移。
pub const MCP_AUDIT_SCHEMA_VERSION: u32 = 1;

const MCP_AUDIT_FILE: &str = "mcp-audit.json";

/// 审计条目上限：超出丢弃最旧记录，避免文件无限增长。
pub const MCP_AUDIT_MAX_ENTRIES: usize = 500;

/// 入参摘要的最大字符数。
const ARGUMENTS_SUMMARY_LIMIT: usize = 500;

/// 一条 MCP 工具调用审计记录（serde 字段为 camelCase）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpAuditEntry {
    /// 单调递增序号，由存储层追加时分配（工作区内唯一）。
    pub seq: u64,
    /// 调用时间（Unix 毫秒）。
    pub timestamp_ms: u64,
    /// 工具名。
    pub tool: String,
    /// 调用者身份：`local`（本地直连）/ `unresolved`（解析失败）/ 脱敏身份 id。
    pub identity: String,
    /// 入参 JSON 摘要（截断到 [`ARGUMENTS_SUMMARY_LIMIT`] 字符，截断标记 "…"）；
    /// 只存摘要不存结果体，避免审计文件携带完整数据。
    pub arguments_summary: String,
    /// 执行结果：`ok` / `denied` / `error`。
    pub outcome: String,
    /// 权限判定：`allowed` / `denied`。
    pub decision: String,
    /// 补充说明（denied 时为拒绝理由，error 时为稳定错误码）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl McpAuditEntry {
    /// 构造审计记录：seq 置 0（由 [`FlowStore::append_mcp_audit`] 覆写），
    /// timestampMs 取当前 Unix 毫秒，入参 JSON 截断为摘要。
    pub fn new(
        tool: impl Into<String>,
        identity: impl Into<String>,
        arguments_json: &str,
        outcome: impl Into<String>,
        decision: impl Into<String>,
        reason: Option<String>,
    ) -> Self {
        Self {
            seq: 0,
            timestamp_ms: unix_ms(),
            tool: tool.into(),
            identity: identity.into(),
            arguments_summary: truncate_arguments_summary(arguments_json),
            outcome: outcome.into(),
            decision: decision.into(),
            reason,
        }
    }
}

/// 截断入参 JSON 为摘要：超过 [`ARGUMENTS_SUMMARY_LIMIT`] 字符时保留前 500
/// 字符并追加截断标记 "…"。按字符（而非字节）截断，避免劈开多字节字符。
pub fn truncate_arguments_summary(arguments_json: &str) -> String {
    if arguments_json.chars().count() <= ARGUMENTS_SUMMARY_LIMIT {
        return arguments_json.to_owned();
    }
    let mut summary: String = arguments_json.chars().take(ARGUMENTS_SUMMARY_LIMIT).collect();
    summary.push('…');
    summary
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Versioned envelope persisted as `flow/mcp-audit.json`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpAuditEnvelope {
    schema_version: u32,
    /// 下一条审计记录的 seq（只增不减，即使最旧记录被裁剪）。
    #[serde(default)]
    next_seq: u64,
    #[serde(default)]
    entries: Vec<McpAuditEntry>,
}

impl Default for McpAuditEnvelope {
    fn default() -> Self {
        Self {
            schema_version: MCP_AUDIT_SCHEMA_VERSION,
            next_seq: 0,
            entries: Vec::new(),
        }
    }
}

fn mcp_audit_path(flow_root: &Path) -> PathBuf {
    flow_root.join(MCP_AUDIT_FILE)
}

/// Parse and check one raw envelope (pure function). Unknown future versions
/// are refused (forward incompatibility, mirroring the env-sets envelope).
fn parse_envelope(raw: Value) -> Result<McpAuditEnvelope> {
    let object = raw
        .as_object()
        .ok_or_else(|| anyhow!("flow {MCP_AUDIT_FILE} is corrupt"))?;
    let version = object
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("flow {MCP_AUDIT_FILE} is corrupt"))? as u32;
    if version > MCP_AUDIT_SCHEMA_VERSION {
        bail!(
            "flow {MCP_AUDIT_FILE} schema version {version} is not supported (expected <= {MCP_AUDIT_SCHEMA_VERSION})"
        );
    }
    let envelope: McpAuditEnvelope = serde_json::from_value(raw)
        .context("flow mcp-audit.json is corrupt")?;
    Ok(envelope)
}

/// Load the stored audit envelope: `None` when the file does not exist yet. A
/// corrupt or unsupported envelope errors so callers pick their policy (audit
/// callers always degrade, see the module docs).
fn load_envelope(flow_root: &Path) -> Result<Option<McpAuditEnvelope>> {
    let bytes = match std::fs::read(mcp_audit_path(flow_root)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("failed to read flow mcp-audit.json"),
    };
    let raw: Value =
        serde_json::from_slice(&bytes).context("flow mcp-audit.json is corrupt")?;
    parse_envelope(raw).map(Some)
}

impl FlowStore {
    /// Append one MCP tool call audit entry, assigning the next seq and
    /// trimming the oldest entries beyond [`MCP_AUDIT_MAX_ENTRIES`]. A corrupt
    /// envelope degrades to an empty one (append-only best-effort, see module
    /// docs) instead of blocking callers.
    pub fn append_mcp_audit(&self, entry: &McpAuditEntry) -> Result<()> {
        let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
        let mut envelope = match load_envelope(&self.flow_root) {
            Ok(Some(envelope)) => envelope,
            Ok(None) => McpAuditEnvelope::default(),
            Err(error) => {
                tracing::warn!("degrading corrupt MCP audit log to empty: {error:#}");
                McpAuditEnvelope::default()
            }
        };
        let mut entry = entry.clone();
        entry.seq = envelope.next_seq;
        envelope.next_seq = entry.seq + 1;
        envelope.entries.push(entry);
        if envelope.entries.len() > MCP_AUDIT_MAX_ENTRIES {
            let excess = envelope.entries.len() - MCP_AUDIT_MAX_ENTRIES;
            envelope.entries.drain(0..excess);
        }
        write_json_atomic(&mcp_audit_path(&self.flow_root), &envelope)
            .context("failed to save flow mcp-audit.json")
    }

    /// Read up to `limit` audit entries, newest first (seq 倒序). A corrupt or
    /// unsupported envelope degrades to an empty list with a warning so audit
    /// reads never fail.
    pub fn mcp_audit_entries(&self, limit: usize) -> Result<Vec<McpAuditEntry>> {
        let limit = limit.min(MCP_AUDIT_MAX_ENTRIES);
        let mut entries = match load_envelope(&self.flow_root) {
            Ok(Some(envelope)) => envelope.entries,
            Ok(None) => Vec::new(),
            Err(error) => {
                tracing::warn!("degrading MCP audit log to empty: {error:#}");
                Vec::new()
            }
        };
        entries.reverse();
        entries.truncate(limit);
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn entry(outcome: &str) -> McpAuditEntry {
        McpAuditEntry::new(
            "browser_navigate",
            "local",
            r#"{"url":"https://example.com"}"#,
            outcome,
            "allowed",
            None,
        )
    }

    #[test]
    fn append_and_query_round_trip_with_increasing_seq() {
        let root = tempdir().unwrap();
        let store = FlowStore::open(root.path()).unwrap();
        store.append_mcp_audit(&entry("ok")).unwrap();
        store.append_mcp_audit(&entry("denied")).unwrap();
        let entries = store.mcp_audit_entries(100).unwrap();
        assert_eq!(entries.len(), 2);
        // seq 倒序：最新在前。
        assert_eq!(entries[0].seq, 1);
        assert_eq!(entries[1].seq, 0);
        assert_eq!(entries[0].outcome, "denied");
        assert_eq!(entries[1].outcome, "ok");
        // 重开一个新句柄验证持久化往返。
        let reopened = FlowStore::open(root.path()).unwrap();
        assert_eq!(reopened.mcp_audit_entries(100).unwrap(), entries);
    }

    #[test]
    fn limit_caps_the_result() {
        let root = tempdir().unwrap();
        let store = FlowStore::open(root.path()).unwrap();
        store.append_mcp_audit(&entry("ok")).unwrap();
        store.append_mcp_audit(&entry("ok")).unwrap();
        store.append_mcp_audit(&entry("ok")).unwrap();
        let entries = store.mcp_audit_entries(2).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].seq, 2);
        assert_eq!(entries[1].seq, 1);
    }

    #[test]
    fn cap_trims_the_oldest_entries() {
        let root = tempdir().unwrap();
        let store = FlowStore::open(root.path()).unwrap();
        for _ in 0..MCP_AUDIT_MAX_ENTRIES + 5 {
            store.append_mcp_audit(&entry("ok")).unwrap();
        }
        let entries = store.mcp_audit_entries(MCP_AUDIT_MAX_ENTRIES).unwrap();
        assert_eq!(entries.len(), MCP_AUDIT_MAX_ENTRIES);
        // 最旧的 0..5 已被丢弃；next_seq 不回退。
        assert_eq!(entries[0].seq, (MCP_AUDIT_MAX_ENTRIES + 4) as u64);
        assert_eq!(entries.last().unwrap().seq, 5);
    }

    #[test]
    fn corrupt_envelope_degrades_reads_and_appends_to_empty() {
        let root = tempdir().unwrap();
        let store = FlowStore::open(root.path()).unwrap();
        store.append_mcp_audit(&entry("ok")).unwrap();
        std::fs::write(mcp_audit_path(&store.flow_root), b"{not json").unwrap();
        // 读取降级为空并告警（审计不是关键路径）。
        assert!(store.mcp_audit_entries(100).unwrap().is_empty());
        // 追加降级为空信封重写（宁可丢历史也不阻断工具调用）。
        store.append_mcp_audit(&entry("ok")).unwrap();
        let entries = store.mcp_audit_entries(100).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].seq, 0);
    }

    #[test]
    fn concurrent_appends_are_serialized_with_unique_seq() {
        let root = tempdir().unwrap();
        let store = std::sync::Arc::new(FlowStore::open(root.path()).unwrap());
        let mut handles = Vec::new();
        for index in 0..8 {
            let store = store.clone();
            handles.push(std::thread::spawn(move || {
                store
                    .append_mcp_audit(&McpAuditEntry::new(
                        format!("tool_{index}"),
                        "local",
                        "{}",
                        "ok",
                        "allowed",
                        None,
                    ))
                    .unwrap();
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        let entries = store.mcp_audit_entries(MCP_AUDIT_MAX_ENTRIES).unwrap();
        assert_eq!(entries.len(), 8);
        let mut seqs: Vec<u64> = entries.iter().map(|item| item.seq).collect();
        seqs.sort();
        seqs.dedup();
        assert_eq!(seqs.len(), 8, "每条审计记录必须拿到唯一 seq");
    }

    #[test]
    fn arguments_summary_is_truncated_with_marker() {
        let long = "a".repeat(ARGUMENTS_SUMMARY_LIMIT + 10);
        let summary = truncate_arguments_summary(&long);
        assert_eq!(summary.chars().count(), ARGUMENTS_SUMMARY_LIMIT + 1);
        assert!(summary.ends_with('…'));
        let short = truncate_arguments_summary("{\"url\":\"x\"}");
        assert_eq!(short, "{\"url\":\"x\"}");
    }
}
