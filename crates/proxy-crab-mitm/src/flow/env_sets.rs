//! Environment variable sets, global variables and the script env write-back
//! channel over `<workspace>/flow/env-sets.json` (mirrors the archived ReqFlow
//! `storage/env-sets.ts` / `storage/global-variables.ts` /
//! `background/env-write-back.ts` semantics).
//!
//! Layout (one versioned envelope for the whole env family):
//! - `sets` — named environment variable sets (dev / staging / prod style),
//!   each holding a normal `values` table and a `secretValues` table;
//! - `activeSetId` — activation preference, at most one set at a time
//!   (`None` = no active environment). Deleting the active set clears the
//!   preference in the same write ([FlowStore::delete_env_set]);
//! - `globals` — global variables table (lowest variable scope, shared across
//!   projects) with the same normal/secret split.
//!
//! Envelope evolution follows the archived "versioned envelope + migration
//! registry" pattern: reads walk the registered per-version migrations up to
//! [`ENV_SETS_SCHEMA_VERSION`]; a missing step or a newer version is treated
//! as corrupt data (reads degrade to empty with a warning, writes refuse).
//!
//! Secret handling (ported from `flow-engine/src/secret-mask.ts`):
//! - reads handed to the UI mask every secret value with
//!   [`SECRET_MASK_PLACEHOLDER`]; writes restore the stored plaintext for
//!   values the caller left masked ([restore_masked_secret_values]), so a
//!   masked round trip never corrupts secrets;
//! - export paths must exclude secret values entirely
//!   ([strip_secrets_for_export] / [strip_globals_secrets_for_export]);
//! - [mask_secrets_in_text] / [mask_secrets_deep] are the record-side masking
//!   primitives for run records and broadcasts.
//!
//! Script env write-back semantics (disclosed per plan Task 17 Step 4; the
//! run chain itself is wired by Task 19):
//! - double write: the run snapshot is updated immediately by the run chain,
//!   while persistence goes through [FlowStore::submit_env_write_back] (enqueue;
//!   the batch counts as **committed**) and [FlowStore::flush_env_write_backs]
//!   (serial persistence in submission order, last write wins per key);
//! - the persistence target is the set id captured at dispatch time (the
//!   activation snapshot), so switching the active set during a run never
//!   redirects write-backs;
//! - a committed write-back is never rolled back: script failure, node
//!   failure, run cancellation and hard timeouts do not withdraw batches
//!   already submitted. A batch that never reaches submission (sandbox
//!   destroyed before returning) is "not submitted", not "rolled back";
//! - a batch whose target set was deleted before flush is dropped with a
//!   warning (never resurrects the deleted set); persistence failures warn
//!   and never block the caller — environment data is a side enhancement.

use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    flow::store::{
        ENV_SETS_SCHEMA_VERSION, EnvSetsEnvelope, EnvVariableSet, FlowStore, WRITE_LOCK,
        validate_flow_id,
    },
    workspace::write_json_atomic,
};

const ENV_SETS_FILE: &str = "env-sets.json";

/// Global variables table (values + secret values), the lowest variable scope
/// shared across projects. Same shape as a set's own tables.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvGlobalVariables {
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    #[serde(default)]
    pub secret_values: BTreeMap<String, String>,
}

/// Masking placeholder for secret values on read paths (record-side contract
/// ported from `flow-engine/src/secret-mask.ts`).
pub const SECRET_MASK_PLACEHOLDER: &str = "******";

/// Minimum secret value length for substring masking: shorter values would
/// corrupt unrelated text, so they are skipped (see the archived contract).
pub const SECRET_MASK_MIN_LENGTH: usize = 4;

/// Replace every occurrence of the given secret values inside `text` with the
/// masking placeholder (pure function). Secrets below
/// [`SECRET_MASK_MIN_LENGTH`] and the placeholder itself never participate;
/// earlier replacements win (the placeholder is never re-masked).
pub fn mask_secrets_in_text(text: &str, secrets: &[String]) -> String {
    if text.is_empty() || secrets.is_empty() {
        return text.to_owned();
    }
    let mut result = text.to_owned();
    for secret in secrets {
        if secret.chars().count() < SECRET_MASK_MIN_LENGTH {
            continue;
        }
        if secret == SECRET_MASK_PLACEHOLDER || !result.contains(secret.as_str()) {
            continue;
        }
        result = result.replace(secret.as_str(), SECRET_MASK_PLACEHOLDER);
    }
    result
}

/// Deeply mask every string inside an arbitrary JSON value (pure function).
/// Object keys are structure, not data, and are left untouched.
pub fn mask_secrets_deep(value: &Value, secrets: &[String]) -> Value {
    if secrets.is_empty() {
        return value.clone();
    }
    match value {
        Value::String(text) => Value::String(mask_secrets_in_text(text, secrets)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| mask_secrets_deep(item, secrets))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), mask_secrets_deep(item, secrets)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Copy of one environment variable set with every secret value replaced by
/// the masking placeholder (read path handed to the UI).
pub fn mask_env_set(set: &EnvVariableSet) -> EnvVariableSet {
    let mut masked = set.clone();
    for value in masked.secret_values.values_mut() {
        *value = SECRET_MASK_PLACEHOLDER.to_owned();
    }
    masked
}

/// Copy of the global variables table with masked secret values (read path).
pub fn mask_globals(globals: &EnvGlobalVariables) -> EnvGlobalVariables {
    let mut masked = globals.clone();
    for value in masked.secret_values.values_mut() {
        *value = SECRET_MASK_PLACEHOLDER.to_owned();
    }
    masked
}

/// Restore stored plaintext for masked values the caller did not overwrite:
/// every incoming value equal to the placeholder that exists in `existing`
/// keeps the stored value, so a masked read/write round trip never destroys
/// secrets while an explicit new value overrides them.
pub fn restore_masked_secret_values(
    incoming: &mut BTreeMap<String, String>,
    existing: &BTreeMap<String, String>,
) {
    for (key, value) in incoming.iter_mut() {
        if value == SECRET_MASK_PLACEHOLDER
            && let Some(original) = existing.get(key)
        {
            *value = original.clone();
        }
    }
}

/// Export copy of one set with the secret table removed entirely (export
/// exclusion contract: secrets never leave the workspace through exports).
pub fn strip_secrets_for_export(set: &EnvVariableSet) -> EnvVariableSet {
    let mut stripped = set.clone();
    stripped.secret_values = BTreeMap::new();
    stripped
}

/// Export copy of the global variables table without secret values.
pub fn strip_globals_secrets_for_export(globals: &EnvGlobalVariables) -> EnvGlobalVariables {
    let mut stripped = globals.clone();
    stripped.secret_values = BTreeMap::new();
    stripped
}

/// Merged runtime view of the currently activated environment: the input of
/// the run chain (Task 19) and the masking source for record redaction.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EnvSnapshot {
    /// `env` namespace key-value table; same-name secret values override the
    /// normal ones (same-level secret precedence, mirroring the archive).
    pub values: BTreeMap<String, String>,
    /// Values of the secret subset (substitution list for record masking).
    pub secret_values: Vec<String>,
}

/// Resolve the runtime snapshot of one active set (pure function): `None` id
/// or an id that matches no set yields an empty snapshot.
pub fn resolve_active_env_snapshot(
    sets: &[EnvVariableSet],
    active_id: Option<&str>,
) -> EnvSnapshot {
    let Some(active_id) = active_id else {
        return EnvSnapshot::default();
    };
    let Some(active) = sets.iter().find(|set| set.id == active_id) else {
        return EnvSnapshot::default();
    };
    let mut values = active.values.clone();
    for (key, value) in &active.secret_values {
        values.insert(key.clone(), value.clone());
    }
    EnvSnapshot {
        values,
        secret_values: active.secret_values.values().cloned().collect(),
    }
}

/// Variable tables only carry non-empty string keys (values are enforced as
/// strings by the typed map).
pub fn validate_variables_table(table: &BTreeMap<String, String>) -> Result<()> {
    for key in table.keys() {
        if key.trim().is_empty() {
            bail!("variable keys must be non-empty");
        }
    }
    Ok(())
}

/// Deterministic id for a new set: `env-{millis}` plus a numeric suffix while
/// the candidate collides with an existing id (same convention as presets).
pub fn next_env_set_id(existing: &[EnvVariableSet]) -> String {
    let base = format!("env-{}", now_millis());
    let mut suffix = 0_u64;
    loop {
        let candidate = if suffix == 0 {
            base.clone()
        } else {
            format!("{base}-{suffix}")
        };
        if !existing.iter().any(|set| set.id == candidate) {
            return candidate;
        }
        suffix += 1;
    }
}

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn env_sets_path(flow_root: &Path) -> PathBuf {
    flow_root.join(ENV_SETS_FILE)
}

/// Envelope migration registry: target version -> in-place migration applied
/// to the previous shape. Version 1 is the initial layout, so the registry is
/// empty; register `(current + 1, migration)` here when the layout evolves
/// (same mechanism as the archived `ENV_SETS_ENVELOPE_MIGRATIONS`).
type EnvSetsMigration = fn(&mut Value);

fn env_sets_envelope_migrations() -> &'static [(u32, EnvSetsMigration)] {
    &[]
}

/// Migrate and sanitize one raw envelope (pure function). Envelope-level
/// damage (bad shape, unknown or un-migratable version) errors so callers can
/// apply their read/write policy; per-entry damage is dropped with a warning
/// so one corrupt set never hides the others. Globals and the activation
/// preference degrade to their defaults when individually corrupt.
pub(crate) fn migrate_envelope(raw: Value) -> Result<EnvSetsEnvelope> {
    let object = raw
        .as_object()
        .ok_or_else(|| anyhow!("flow env-sets.json is corrupt"))?;
    let version = object
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("flow env-sets.json is corrupt"))? as u32;
    if version > ENV_SETS_SCHEMA_VERSION {
        bail!(
            "flow env-sets.json schema version {version} is not supported (expected <= {ENV_SETS_SCHEMA_VERSION})"
        );
    }
    let mut current = raw;
    for step in (version + 1)..=ENV_SETS_SCHEMA_VERSION {
        let migration = env_sets_envelope_migrations()
            .iter()
            .find(|(target, _)| *target == step)
            .map(|(_, migration)| migration)
            .ok_or_else(|| anyhow!("env-sets envelope migration registry misses v{step}"))?;
        migration(&mut current);
    }
    let mut sets = Vec::new();
    for entry in current
        .get("sets")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("flow env-sets.json is corrupt"))?
        .clone()
    {
        match serde_json::from_value::<EnvVariableSet>(entry) {
            Ok(set) => sets.push(set),
            Err(error) => {
                tracing::warn!("ignoring corrupt environment variable set: {error}")
            }
        }
    }
    let active_set_id = match current.get("activeSetId") {
        Some(Value::String(id)) => match validate_flow_id(id) {
            Ok(()) => Some(id.clone()),
            Err(error) => {
                tracing::warn!("ignoring corrupt environment activation preference: {error:#}");
                None
            }
        },
        _ => None,
    };
    let globals = match current.get("globals") {
        Some(value) => match serde_json::from_value::<EnvGlobalVariables>(value.clone()) {
            Ok(globals) => globals,
            Err(error) => {
                tracing::warn!("ignoring corrupt global variables table: {error}");
                EnvGlobalVariables::default()
            }
        },
        None => EnvGlobalVariables::default(),
    };
    Ok(EnvSetsEnvelope {
        schema_version: ENV_SETS_SCHEMA_VERSION,
        sets,
        active_set_id,
        globals,
    })
}

/// Load and migrate the envelope: `None` when the file does not exist yet.
/// A corrupt or unsupported envelope errors so callers pick their policy
/// (reads degrade, read-modify-write refuses).
fn load_envelope(flow_root: &Path) -> Result<Option<EnvSetsEnvelope>> {
    let bytes = match fs::read(env_sets_path(flow_root)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("failed to read flow env-sets.json"),
    };
    let raw: Value = serde_json::from_slice(&bytes).context("flow env-sets.json is corrupt")?;
    migrate_envelope(raw).map(Some)
}

fn write_envelope(flow_root: &Path, envelope: &EnvSetsEnvelope) -> Result<()> {
    write_json_atomic(&env_sets_path(flow_root), envelope)
        .context("failed to save flow env-sets.json")
}

/// Load the envelope inside a caller-held write critical section, defaulting
/// to an empty envelope when the file does not exist yet.
fn load_envelope_locked(flow_root: &Path) -> Result<EnvSetsEnvelope> {
    load_envelope(flow_root).map(|envelope| {
        envelope.unwrap_or(EnvSetsEnvelope {
            schema_version: ENV_SETS_SCHEMA_VERSION,
            sets: Vec::new(),
            active_set_id: None,
            globals: EnvGlobalVariables::default(),
        })
    })
}

impl FlowStore {
    /// Read all environment variable sets. A missing file yields an empty
    /// list; a corrupt or unsupported envelope degrades to empty with a
    /// warning so environment data never blocks callers.
    pub fn list_env_sets(&self) -> Result<Vec<EnvVariableSet>> {
        let envelope = match load_envelope(&self.flow_root) {
            Ok(envelope) => envelope,
            Err(error) => {
                tracing::warn!("degrading flow environment variable sets to empty: {error:#}");
                return Ok(Vec::new());
            }
        };
        Ok(envelope.map(|envelope| envelope.sets).unwrap_or_default())
    }

    /// Insert or replace one environment variable set, preserving the other
    /// sets, their order and the envelope extras (activation preference,
    /// globals). A corrupt or unsupported envelope refuses the save with a
    /// readable error (never silently wiped).
    pub fn save_env_set(&self, set: &EnvVariableSet) -> Result<()> {
        set.validate()?;
        validate_variables_table(&set.values)?;
        validate_variables_table(&set.secret_values)?;
        let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
        let mut envelope = load_envelope_locked(&self.flow_root)?;
        match envelope
            .sets
            .iter()
            .position(|existing| existing.id == set.id)
        {
            Some(index) => envelope.sets[index] = set.clone(),
            None => envelope.sets.push(set.clone()),
        }
        write_envelope(&self.flow_root, &envelope)
    }

    /// Delete one environment variable set by id; a missing id succeeds
    /// silently. Deleting the currently activated set clears the activation
    /// preference in the same write. A corrupt or unsupported envelope
    /// refuses the deletion with a readable error.
    pub fn delete_env_set(&self, id: &str) -> Result<()> {
        validate_flow_id(id)?;
        let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
        let Some(mut envelope) = load_envelope(&self.flow_root)? else {
            return Ok(());
        };
        envelope.sets.retain(|existing| existing.id != id);
        if envelope.active_set_id.as_deref() == Some(id) {
            envelope.active_set_id = None;
        }
        write_envelope(&self.flow_root, &envelope)
    }

    /// Read the global variables table. A missing file or corrupt envelope
    /// degrades to the empty table with a warning (globals are a side
    /// enhancement and never block callers).
    pub fn env_globals(&self) -> Result<EnvGlobalVariables> {
        let envelope = match load_envelope(&self.flow_root) {
            Ok(envelope) => envelope,
            Err(error) => {
                tracing::warn!("degrading flow global variables to empty: {error:#}");
                return Ok(EnvGlobalVariables::default());
            }
        };
        Ok(envelope
            .map(|envelope| envelope.globals)
            .unwrap_or_default())
    }

    /// Replace the global variables table, preserving sets and the activation
    /// preference. A corrupt or unsupported envelope refuses the save.
    pub fn save_env_globals(&self, globals: &EnvGlobalVariables) -> Result<()> {
        validate_variables_table(&globals.values)?;
        validate_variables_table(&globals.secret_values)?;
        let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
        let mut envelope = load_envelope_locked(&self.flow_root)?;
        envelope.globals = globals.clone();
        write_envelope(&self.flow_root, &envelope)
    }

    /// Read the activation preference: `None` when no environment is active.
    /// A corrupt envelope degrades to `None` with a warning.
    pub fn active_env_set_id(&self) -> Result<Option<String>> {
        let envelope = match load_envelope(&self.flow_root) {
            Ok(envelope) => envelope,
            Err(error) => {
                tracing::warn!("degrading environment activation preference: {error:#}");
                return Ok(None);
            }
        };
        Ok(envelope.and_then(|envelope| envelope.active_set_id))
    }

    /// Switch the activated set (`None` clears the preference). Activating a
    /// set that does not exist is refused. A corrupt envelope refuses the
    /// switch.
    pub fn set_active_env_set(&self, id: Option<&str>) -> Result<Option<String>> {
        if let Some(id) = id {
            validate_flow_id(id)?;
        }
        let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
        let mut envelope = load_envelope_locked(&self.flow_root)?;
        if let Some(id) = id
            && !envelope.sets.iter().any(|set| set.id == id)
        {
            bail!("environment variable set {id} not found");
        }
        envelope.active_set_id = id.map(str::to_owned);
        write_envelope(&self.flow_root, &envelope)?;
        Ok(envelope.active_set_id)
    }

    /// Read the runtime snapshot of the currently activated environment
    /// (normal values overlaid by same-name secret values plus the secret
    /// value list for record masking). The run chain (Task 19) captures this
    /// at dispatch time.
    pub fn active_env_snapshot(&self) -> Result<EnvSnapshot> {
        let sets = self.list_env_sets()?;
        let active_set_id = self.active_env_set_id()?;
        Ok(resolve_active_env_snapshot(&sets, active_set_id.as_deref()))
    }

    /// Submit (commit) one script env write-back batch. The batch is queued
    /// process-wide and counts as committed: it is never withdrawn by later
    /// script/node/run failures or hard timeouts (disclosed semantics, see
    /// the module docs). Persistence happens on
    /// [`FlowStore::flush_env_write_backs`].
    pub fn submit_env_write_back(
        &self,
        set_id: impl Into<String>,
        writes: BTreeMap<String, Value>,
    ) -> Result<()> {
        let set_id = set_id.into();
        validate_flow_id(&set_id)?;
        if writes.is_empty() {
            bail!("env write-back requires at least one entry");
        }
        let mut queue = ENV_WRITE_BACK_QUEUE
            .lock()
            .expect("env write-back queue poisoned");
        queue.push_back(EnvWriteBack { set_id, writes });
        Ok(())
    }

    /// Persist every queued write-back batch in submission order (serial
    /// queue): each batch is merged into the latest envelope of its target
    /// set, so same-key writes end last-write-wins while different keys merge
    /// without loss. Keys already present in the target's secret table keep
    /// their secret marking; dynamic new keys land in the normal table.
    /// Returns how many batches were applied and how many were dropped
    /// (target deleted). Persistence failures warn and count as dropped —
    /// they never block the caller.
    pub fn flush_env_write_backs(&self) -> Result<EnvWriteBackFlush> {
        let mut queue = ENV_WRITE_BACK_QUEUE
            .lock()
            .expect("env write-back queue poisoned");
        let mut flush = EnvWriteBackFlush::default();
        while let Some(batch) = queue.pop_front() {
            match self.apply_env_write_back(&batch) {
                Ok(true) => flush.applied += 1,
                Ok(false) => flush.dropped += 1,
                Err(error) => {
                    tracing::warn!("env write-back dropped: {error:#}");
                    flush.dropped += 1;
                }
            }
        }
        Ok(flush)
    }

    /// Merge one batch into its target set (`false` = target missing, batch
    /// dropped without resurrecting the deleted set).
    fn apply_env_write_back(&self, batch: &EnvWriteBack) -> Result<bool> {
        let sets = self.list_env_sets()?;
        let Some(target) = sets.iter().find(|set| set.id == batch.set_id) else {
            tracing::warn!(
                "env write-back target set {} no longer exists; batch dropped",
                batch.set_id
            );
            return Ok(false);
        };
        let mut next = target.clone();
        for (key, value) in &batch.writes {
            let Some(text) = stringify_env_write_value(value) else {
                continue;
            };
            if key.trim().is_empty() {
                continue;
            }
            if next.secret_values.contains_key(key) {
                next.secret_values.insert(key.clone(), text);
            } else {
                next.values.insert(key.clone(), text);
            }
        }
        next.updated_at = now_millis();
        self.save_env_set(&next)?;
        Ok(true)
    }
}

/// Outcome of one flush: applied vs dropped batch counts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EnvWriteBackFlush {
    pub applied: usize,
    pub dropped: usize,
}

/// One committed write-back batch awaiting persistence.
struct EnvWriteBack {
    set_id: String,
    writes: BTreeMap<String, Value>,
}

/// Process-wide serial write-back queue: every `FlowStore` handle in this
/// process shares it, mirroring the archived module-scope promise chain.
static ENV_WRITE_BACK_QUEUE: Mutex<VecDeque<EnvWriteBack>> = Mutex::new(VecDeque::new());

/// Normalize a script write-back value into the string form stored in
/// variable tables: strings as-is, numbers/booleans via `Display`, `null` as
/// `"null"`, objects/arrays as JSON text (mirrors the archived
/// `stringifyEnvWriteValue`; the run snapshot keeps the raw value so both
/// sides observe the same stringified rendering).
pub(crate) fn stringify_env_write_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => Some("null".to_owned()),
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Object(_) | Value::Array(_) => serde_json::to_string(value).ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn secrets(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn mask_secrets_in_text_follows_the_archived_contract() {
        // Empty inputs short-circuit.
        assert_eq!(mask_secrets_in_text("", &secrets(&["token"])), "");
        assert_eq!(mask_secrets_in_text("Bearer x", &[]), "Bearer x");
        // Substring replacement covers embedded occurrences.
        assert_eq!(
            mask_secrets_in_text("Bearer super-token!", &secrets(&["super-token"])),
            "Bearer ******!"
        );
        // Every occurrence is replaced.
        assert_eq!(
            mask_secrets_in_text("abcd abcd", &secrets(&["abcd"])),
            "****** ******"
        );
        // Values below the minimum length are skipped.
        assert_eq!(
            mask_secrets_in_text("abc abc", &secrets(&["abc"])),
            "abc abc"
        );
        // The placeholder never participates.
        assert_eq!(
            mask_secrets_in_text("****** ok", &secrets(&[SECRET_MASK_PLACEHOLDER, "ok"])),
            "****** ok"
        );
        // Earlier secrets win.
        assert_eq!(
            mask_secrets_in_text("abcd", &secrets(&["abcd", "bc"])),
            "******"
        );
    }

    #[test]
    fn mask_secrets_deep_walks_strings_and_keeps_keys() {
        let value = json!({"Authorization": "Bearer super-token", "list": ["super-token", 7, null, true], "n": 1});
        let masked = mask_secrets_deep(&value, &secrets(&["super-token"]));
        assert_eq!(
            masked,
            json!({"Authorization": "Bearer ******", "list": ["******", 7, null, true], "n": 1})
        );
        // Without secrets the value is returned unchanged.
        assert_eq!(mask_secrets_deep(&value, &[]), value);
    }

    #[test]
    fn masked_round_trip_restores_untouched_secrets() {
        let existing: BTreeMap<String, String> = BTreeMap::from([
            ("password".to_owned(), "hunter2".to_owned()),
            ("token".to_owned(), "super-token".to_owned()),
        ]);
        let mut incoming: BTreeMap<String, String> = BTreeMap::from([
            ("password".to_owned(), SECRET_MASK_PLACEHOLDER.to_owned()),
            ("token".to_owned(), "new-token".to_owned()),
            ("added".to_owned(), "fresh".to_owned()),
        ]);
        restore_masked_secret_values(&mut incoming, &existing);
        assert_eq!(
            incoming.get("password").map(String::as_str),
            Some("hunter2")
        );
        assert_eq!(incoming.get("token").map(String::as_str), Some("new-token"));
        assert_eq!(incoming.get("added").map(String::as_str), Some("fresh"));
    }

    #[test]
    fn active_snapshot_merges_secret_precedence() {
        let set = EnvVariableSet {
            id: "env-dev".to_owned(),
            name: "dev".to_owned(),
            values: BTreeMap::from([("baseUrl".to_owned(), "http://localhost".to_owned())]),
            secret_values: BTreeMap::from([
                ("baseUrl".to_owned(), "http://secret".to_owned()),
                ("password".to_owned(), "hunter2".to_owned()),
            ]),
            created_at: 1,
            updated_at: 1,
        };
        let snapshot = resolve_active_env_snapshot(std::slice::from_ref(&set), Some("env-dev"));
        assert_eq!(
            snapshot.values.get("baseUrl").map(String::as_str),
            Some("http://secret")
        );
        assert_eq!(
            snapshot.values.get("password").map(String::as_str),
            Some("hunter2")
        );
        assert_eq!(snapshot.secret_values, vec!["http://secret", "hunter2"]);
        // Missing id or unknown set yields the empty snapshot.
        assert_eq!(
            resolve_active_env_snapshot(&[], Some("env-dev")),
            EnvSnapshot::default()
        );
        assert_eq!(
            resolve_active_env_snapshot(&[set], None),
            EnvSnapshot::default()
        );
    }

    #[test]
    fn export_strip_removes_secret_tables() {
        let set = EnvVariableSet {
            id: "env-dev".to_owned(),
            name: "dev".to_owned(),
            values: BTreeMap::from([("baseUrl".to_owned(), "http://localhost".to_owned())]),
            secret_values: BTreeMap::from([("password".to_owned(), "hunter2".to_owned())]),
            created_at: 1,
            updated_at: 1,
        };
        let stripped = strip_secrets_for_export(&set);
        assert!(stripped.secret_values.is_empty());
        assert_eq!(
            stripped.values.get("baseUrl").map(String::as_str),
            Some("http://localhost")
        );
        let globals = EnvGlobalVariables {
            values: BTreeMap::from([("region".to_owned(), "cn".to_owned())]),
            secret_values: BTreeMap::from([("key".to_owned(), "k-1234".to_owned())]),
        };
        assert!(
            strip_globals_secrets_for_export(&globals)
                .secret_values
                .is_empty()
        );
    }

    #[test]
    fn write_values_are_stringified_like_the_archived_contract() {
        assert_eq!(
            stringify_env_write_value(&json!("text")),
            Some("text".to_owned())
        );
        assert_eq!(stringify_env_write_value(&json!(12)), Some("12".to_owned()));
        assert_eq!(
            stringify_env_write_value(&json!(true)),
            Some("true".to_owned())
        );
        assert_eq!(
            stringify_env_write_value(&Value::Null),
            Some("null".to_owned())
        );
        assert_eq!(
            stringify_env_write_value(&json!({"a": 1})),
            Some(r#"{"a":1}"#.to_owned())
        );
    }

    #[test]
    fn migration_registry_covers_every_version_step() {
        // The registry must stay contiguous from v2 so a stored envelope
        // never skips a version silently; vacuous for the initial empty
        // registry (v1 is the initial layout).
        let steps: Vec<u32> = env_sets_envelope_migrations()
            .iter()
            .map(|(target, _)| *target)
            .collect();
        for (index, step) in steps.iter().enumerate() {
            assert_eq!(
                *step,
                index as u32 + 2,
                "env-sets envelope migrations must be contiguous starting at v2"
            );
            assert!(
                *step <= ENV_SETS_SCHEMA_VERSION,
                "env-sets envelope migration v{step} exceeds the current version"
            );
        }
    }
}
