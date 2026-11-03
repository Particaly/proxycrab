//! Workspace request library: typed entry model, body blob storage and
//! capture ingestion (plan Task 5; reproduces ReqFlow's request center).
//!
//! An entry keeps a strongly typed HAR 1.2 snapshot narrowed to the fields the
//! workflow engine's replay path consumes (archived `engine/replay.ts`:
//! method / url / headers / queryString / cookies / postData plus a response
//! summary), so the JSON stays human-reviewable (agreed decision 9).
//!
//! Request bodies follow the repo's capture convention: the inline threshold
//! [`REQUEST_BODY_INLINE_LIMIT`] aligns with the 64 KiB capture detail limit
//! (`storage::BODY_DETAIL_LIMIT`). Small UTF-8 text bodies are inlined into
//! `postData.text`; binary or larger bodies are written once to
//! `flow/request-library/bodies/{id}.body` and referenced by `bodyRef`
//! (JSON index and body bytes stay separated, replay resolves the blob).
//!
//! Ingestion normalizes captures into the shape the engine expects: cookie
//! headers are parsed into structured `request.cookies` (port of archived
//! `engine/har-cookies.ts`) and entries default to the `METHOD host+path`
//! naming. Name collisions resolve by appending the first free numeric suffix
//! (` 2`, ` 3`, ...), mirroring ReqFlow's batch `${base} ${n}` style.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hyper::StatusCode;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::{
    model::{CaptureSummary, HeaderValues},
    storage::{BodySource, BodySourceData},
    workspace::{now_millis, write_bytes_atomic},
};

use super::store::{
    REQUEST_LIBRARY_DIRECTORY, WRITE_LOCK, FlowEntity, FlowStore, delete_entity, get_entity,
    list_entities, put_entity, put_entity_locked, validate_flow_id,
};

/// Request bodies at or below this size that decode as UTF-8 text are inlined
/// into the entry JSON; binary or larger bodies go to the blob file referenced
/// by `bodyRef`. Aligned with the 64 KiB capture detail limit
/// (`storage::BODY_DETAIL_LIMIT`) so the library never carries a body the rest
/// of the repo would refuse to render inline.
pub const REQUEST_BODY_INLINE_LIMIT: u64 = 64 * 1024;

/// Subdirectory of `flow/request-library/` holding body blobs, created lazily
/// on first blob write. One blob per entry id (`{id}.body`), so deletes and
/// replacements never need a secondary index.
const BODIES_DIRECTORY: &str = "bodies";

/// HAR format version stamped into every generated snapshot.
pub const HAR_VERSION: &str = "1.2";
/// Creator name stamped into every generated snapshot.
pub const HAR_CREATOR_NAME: &str = "ProxyCrab";

/* ------------------------------------------------------------------ *
 * HAR snapshot model (minimal HAR 1.2, replay.ts consumption subset)
 * ------------------------------------------------------------------ */

/// Full HAR snapshot of one request (`{log: {entries: [...]}}`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HarSnapshot {
    pub log: HarLog,
}

/// HAR log root. Pages are not modeled: the page-origin concept of the
/// upstream extension has no proxy equivalent (entries carry `origin`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HarLog {
    #[serde(default = "default_har_version")]
    pub version: String,
    #[serde(default)]
    pub creator: HarCreator,
    #[serde(default)]
    pub entries: Vec<HarEntry>,
}

/// HAR creator stamp.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct HarCreator {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// HAR entry: one request/response exchange. Timings and byte sizes are not
/// consumed by the replay path and stay unmodeled.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HarEntry {
    /// Exchange start as ISO 8601 UTC string (informational; not consumed by
    /// the replay path).
    #[serde(default)]
    pub started_date_time: String,
    /// Total duration in milliseconds.
    #[serde(default)]
    pub time: u64,
    pub request: HarRequest,
    /// Response summary; absent for captures that never received one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<HarResponse>,
}

/// HAR request side: exactly the fields the replay rebuild consumes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HarRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub http_version: String,
    #[serde(default)]
    pub headers: Vec<HarHeader>,
    #[serde(default)]
    pub query_string: Vec<HarQueryString>,
    /// Structured request cookies; empty entries are omitted on disk.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cookies: Vec<HarCookie>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_data: Option<HarPostData>,
}

/// HAR response summary (no response body: replay requests are rebuilt from
/// the request side; consumers needing response bytes read the capture).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HarResponse {
    pub status: u16,
    #[serde(default)]
    pub status_text: String,
    #[serde(default)]
    pub http_version: String,
    #[serde(default)]
    pub headers: Vec<HarHeader>,
    pub content: HarContent,
    #[serde(default, rename = "redirectURL")]
    pub redirect_url: String,
}

/// HAR response content summary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HarContent {
    /// Body size in bytes; -1 when unknown.
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub mime_type: String,
}

/// HAR name/value pair (headers, query string, form params).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HarHeader {
    pub name: String,
    pub value: String,
}

/// HAR query parameter (`?name=value`); values are percent-decoded.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HarQueryString {
    pub name: String,
    pub value: String,
}

/// HAR cookie (request side; capture parsing only ever fills name/value).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HarCookie {
    pub name: String,
    pub value: String,
}

/// HAR request body. `text` is the raw body (UTF-8 text, or base64 with
/// `encoding = "base64"`); entries whose body went to a blob carry only
/// `mimeType` and resolve their bytes through `bodyRef`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HarPostData {
    #[serde(default)]
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<HarHeader>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}

fn default_har_version() -> String {
    HAR_VERSION.to_string()
}

impl HarEntry {
    /// Minimal entry for one request line, with HAR-style defaults for
    /// everything else.
    pub fn new(method: &str, url: &str) -> Self {
        Self {
            started_date_time: String::new(),
            time: 0,
            request: HarRequest {
                method: method.to_string(),
                url: url.to_string(),
                http_version: String::new(),
                headers: Vec::new(),
                query_string: Vec::new(),
                cookies: Vec::new(),
                post_data: None,
            },
            response: None,
        }
    }
}

impl HarSnapshot {
    /// Wrap one entry into the full snapshot shape (port of archived
    /// `commit-payload.ts` `buildHarSnapshot`).
    pub fn single(entry: HarEntry) -> Self {
        Self {
            log: HarLog {
                version: HAR_VERSION.to_string(),
                creator: HarCreator {
                    name: HAR_CREATOR_NAME.to_string(),
                    version: None,
                },
                entries: vec![entry],
            },
        }
    }
}

/* ------------------------------------------------------------------ *
 * Entry model
 * ------------------------------------------------------------------ */

/// One entry of the workspace-level request library.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestLibraryEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub source: RequestSource,
    /// Capture page origin equivalent (Origin/Referer header origin for
    /// captures, empty when unknown; ReqFlow allows an empty origin).
    #[serde(default)]
    pub origin: String,
    pub har: HarSnapshot,
    /// Blob reference when the request body is not inlined in `har`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_ref: Option<RequestBodyRef>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Where a request library entry came from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RequestSource {
    Capture,
    Import,
    Manual,
}

/// Reference from an entry to its request body blob under
/// `flow/request-library/bodies/`. `path` is relative to the flow root and
/// always generated by this module (`request-library/bodies/{id}.body`); the
/// read path re-validates it so hand-edited entries cannot escape the
/// directory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestBodyRef {
    pub path: String,
    /// Stored size in bytes.
    pub size: u64,
}

/// Shape rules beyond deserialization (aligned with the archived ReqFlow
/// `storage/validate.ts` minimal validation): the snapshot must carry at least
/// one entry because the replay path consumes the first one.
pub(crate) fn validate_entry(entry: &RequestLibraryEntry) -> Result<()> {
    validate_flow_id(&entry.id)?;
    if entry.har.log.entries.is_empty() {
        bail!(
            "request library entry {} requires a HAR snapshot with at least one entry",
            entry.id
        );
    }
    Ok(())
}

/* ------------------------------------------------------------------ *
 * Capture ingestion
 * ------------------------------------------------------------------ */

/// One capture materialized for ingestion. The manager layer (Task 6) fills
/// this from `ProxyCrab::capture` + `capture_body_source`, which already
/// resolves live and archived sessions; the flow layer stays free of session
/// state.
#[derive(Debug, Clone)]
pub struct CapturedRequest {
    pub capture: CaptureSummary,
    pub request_body: Option<BodySource>,
    pub response_body: Option<BodySource>,
}

impl FlowStore {
    /// Ingest one capture as a new request library entry
    /// (`source: capture`). `name` overrides the `METHOD host+path` default
    /// when non-blank; both default and explicit names are deduplicated
    /// against the existing library with a numeric suffix. Returns the stored
    /// entry, including its generated id.
    pub fn ingest_capture(
        &self,
        captured: &CapturedRequest,
        name: Option<&str>,
        tags: &[String],
    ) -> Result<RequestLibraryEntry> {
        let summary = &captured.capture;
        // Inline-vs-blob decision: small UTF-8 bodies stay in the JSON, so
        // they are readable and replayable straight from the snapshot.
        let inline_text = match &captured.request_body {
            Some(source)
                if source.stored_size > 0 && source.stored_size <= REQUEST_BODY_INLINE_LIMIT =>
            {
                String::from_utf8(read_source_bytes(source)?).ok()
            }
            _ => None,
        };
        let needs_blob = inline_text.is_none()
            && captured
                .request_body
                .as_ref()
                .is_some_and(|source| source.stored_size > 0);

        let now = now_millis();
        let mut entry = RequestLibraryEntry {
            id: generate_request_id()?,
            name: String::new(),
            tags: tags.to_vec(),
            source: RequestSource::Capture,
            origin: capture_origin(&summary.request.headers),
            har: HarSnapshot::single(har_entry_from_capture(captured, inline_text)),
            body_ref: None,
            created_at: now,
            updated_at: now,
        };
        let desired = match name.map(str::trim).filter(|value| !value.is_empty()) {
            Some(custom) => custom.to_string(),
            None => build_default_request_name(&summary.request.method, &summary.request.uri),
        };
        // One lock covers name dedup, blob write and the entry write so two
        // concurrent ingests cannot both claim the same name or split the pair.
        let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
        let existing = list_entities::<RequestLibraryEntry>(&self.flow_root)?;
        entry.name = assign_unique_name(&desired, existing.iter().map(|entry| entry.name.as_str()));
        if needs_blob {
            let source = captured
                .request_body
                .as_ref()
                .expect("blob source checked above");
            entry.body_ref = Some(write_body_blob(&self.flow_root, &entry.id, source)?);
        }
        put_entity_locked(&self.flow_root, &entry)?;
        Ok(entry)
    }

    /// Raw request body bytes of one entry: `None` when the body is inlined
    /// in the snapshot or absent; blob bytes when `bodyRef` points at one.
    pub fn read_request_body(&self, entry: &RequestLibraryEntry) -> Result<Option<Vec<u8>>> {
        let Some(body_ref) = &entry.body_ref else {
            return Ok(None);
        };
        let path = blob_path(&self.flow_root, &body_ref.path)?;
        fs::read(&path)
            .map(Some)
            .with_context(|| format!("failed to read request library body {}", body_ref.path))
    }

    /// Insert one caller-built entry (manual creation today, import flows
    /// later): assigns the id and timestamps, applies the naming policy —
    /// `METHOD host+path` default with numeric-suffix dedup — and persists the
    /// entry. The snapshot must carry at least one entry.
    pub fn add_request(
        &self,
        har: HarSnapshot,
        source: RequestSource,
        name: Option<&str>,
        tags: &[String],
        origin: String,
    ) -> Result<RequestLibraryEntry> {
        let desired = match name.map(str::trim).filter(|value| !value.is_empty()) {
            Some(custom) => custom.to_string(),
            None => {
                let request = har
                    .log
                    .entries
                    .first()
                    .ok_or_else(|| {
                        crate::error::Error::InvalidArgument(
                            "request library entry requires a HAR snapshot with at least one entry"
                                .to_owned(),
                        )
                    })?
                    .request
                    .clone();
                build_default_request_name(&request.method, &request.url)
            }
        };
        let now = now_millis();
        let mut entry = RequestLibraryEntry {
            id: generate_request_id()?,
            name: String::new(),
            tags: tags.to_vec(),
            source,
            origin,
            har,
            body_ref: None,
            created_at: now,
            updated_at: now,
        };
        // Same critical section as ingestion: name dedup and the entry write
        // cannot interleave with a concurrent insert.
        let _guard = WRITE_LOCK.lock().expect("flow write lock poisoned");
        let existing = list_entities::<RequestLibraryEntry>(&self.flow_root)?;
        entry.name = assign_unique_name(&desired, existing.iter().map(|entry| entry.name.as_str()));
        put_entity_locked(&self.flow_root, &entry)?;
        Ok(entry)
    }

    /// Update the editable fields of one entry (`None` keeps the stored
    /// value). `id`, `source` and `createdAt` are never editable; `updatedAt`
    /// is refreshed. When the replacement snapshot embeds an inline request
    /// body while the stored entry referenced a blob, the stale blob is
    /// deleted and the reference cleared; otherwise an existing blob reference
    /// is preserved (clients round-trip snapshots that never contain blob
    /// bytes).
    pub fn update_request(
        &self,
        id: &str,
        name: Option<&str>,
        tags: Option<&[String]>,
        origin: Option<&str>,
        har: Option<HarSnapshot>,
    ) -> Result<RequestLibraryEntry> {
        let mut entry = get_entity::<RequestLibraryEntry>(&self.flow_root, id)?
            .ok_or_else(|| {
                crate::error::Error::FlowEntityNotFound(
                    <RequestLibraryEntry as FlowEntity>::LABEL,
                    id.to_owned(),
                )
            })?;
        if let Some(name) = name {
            entry.name = name.trim().to_owned();
        }
        if let Some(tags) = tags {
            entry.tags = tags.to_vec();
        }
        if let Some(origin) = origin {
            entry.origin = origin.to_owned();
        }
        if let Some(har) = har {
            if har.log.entries.is_empty() {
                bail!(crate::error::Error::InvalidArgument(format!(
                    "request library entry {id} requires a HAR snapshot with at least one entry"
                )));
            }
            let embeds_body = har.log.entries[0]
                .request
                .post_data
                .as_ref()
                .and_then(|post_data| post_data.text.as_ref())
                .is_some();
            let stale_blob = embeds_body.then(|| entry.id.clone());
            entry.har = har;
            if let Some(id) = stale_blob {
                entry.body_ref = None;
                delete_body_blob(&self.flow_root, &id)?;
            }
        }
        entry.updated_at = now_millis();
        put_entity(&self.flow_root, &entry)?;
        Ok(entry)
    }

    /// Delete one request library entry together with its body blob when one
    /// is referenced.
    pub fn delete_request(&self, id: &str) -> Result<()> {
        delete_entity::<RequestLibraryEntry>(&self.flow_root, id)?;
        delete_body_blob(&self.flow_root, id)
    }
}

/// Remove the body blob of one entry; a missing blob file is not an error
/// (entries without blobs and already-removed blobs share the path).
fn delete_body_blob(flow_root: &Path, id: &str) -> Result<()> {
    let path = flow_root
        .join(REQUEST_LIBRARY_DIRECTORY)
        .join(BODIES_DIRECTORY)
        .join(format!("{id}.body"));
    if let Err(error) = fs::remove_file(&path)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        return Err(error).with_context(|| format!("failed to delete request library body {id}"));
    }
    Ok(())
}

/// Build the typed HAR entry for one capture: headers expanded to HAR pairs,
/// query string parsed from the URL, request body placed per the inline/blob
/// policy, cookies normalized, and the response summarized when present.
fn har_entry_from_capture(captured: &CapturedRequest, inline_text: Option<String>) -> HarEntry {
    let summary = &captured.capture;
    let post_data = captured
        .request_body
        .as_ref()
        .filter(|source| source.stored_size > 0)
        .map(|source| HarPostData {
            mime_type: source.content_type.clone().unwrap_or_default(),
            params: Vec::new(),
            text: inline_text,
            encoding: None,
        });
    let mut entry = HarEntry {
        started_date_time: iso8601_from_epoch_ms(summary.created_at),
        time: summary.updated_at.saturating_sub(summary.created_at),
        request: HarRequest {
            method: summary.request.method.clone(),
            url: summary.request.uri.clone(),
            http_version: summary.request.version.clone(),
            headers: expand_headers(&summary.request.headers),
            query_string: query_string_of(&summary.request.uri),
            cookies: Vec::new(),
            post_data,
        },
        response: summary.response.as_ref().map(|response| HarResponse {
            status: response.status,
            status_text: StatusCode::from_u16(response.status)
                .ok()
                .and_then(|status| status.canonical_reason())
                .unwrap_or_default()
                .to_string(),
            http_version: response.version.clone(),
            headers: expand_headers(&response.headers),
            content: match &captured.response_body {
                Some(body) => HarContent {
                    size: body.stored_size as i64,
                    mime_type: body.content_type.clone().unwrap_or_default(),
                },
                None => HarContent {
                    size: -1,
                    mime_type: String::new(),
                },
            },
            redirect_url: first_header_value(&response.headers, "location").unwrap_or_default(),
        }),
    };
    with_normalized_request_cookies(&mut entry);
    entry
}

/// Best-effort equivalent of ReqFlow's capture page origin: the `Origin`
/// request header origin when it parses as an http(s) URL, else the `Referer`
/// origin, else empty (the field legitimately allows empty).
fn capture_origin(headers: &HeaderValues) -> String {
    for name in ["origin", "referer"] {
        for value in header_values(headers, name) {
            if let Some(origin) = url_origin(value.trim()) {
                return origin;
            }
        }
    }
    String::new()
}

/// Origin of an http(s) URL (`scheme://host[:port]`, default ports omitted,
/// mirroring the JS `URL.origin` semantics for special schemes).
fn url_origin(value: &str) -> Option<String> {
    let parsed = Url::parse(value).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str().filter(|host| !host.is_empty())?;
    Some(match parsed.port() {
        Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    })
}

fn header_values<'a>(headers: &'a HeaderValues, name: &str) -> impl Iterator<Item = &'a str> {
    headers
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case(name))
        .flat_map(|(_, values)| values.iter().map(String::as_str))
}

fn first_header_value(headers: &HeaderValues, name: &str) -> Option<String> {
    header_values(headers, name).next().map(str::to_owned)
}

fn expand_headers(headers: &HeaderValues) -> Vec<HarHeader> {
    headers
        .iter()
        .flat_map(|(name, values)| {
            values
                .iter()
                .map(|value| HarHeader {
                    name: name.clone(),
                    value: value.clone(),
                })
        })
        .collect()
}

/// HAR query string decoded from the URL; unparsable URLs yield none (the
/// query then still lives in the `url` field).
fn query_string_of(url: &str) -> Vec<HarQueryString> {
    let Ok(parsed) = Url::parse(url) else {
        return Vec::new();
    };
    parsed
        .query_pairs()
        .map(|(name, value)| HarQueryString {
            name: name.into_owned(),
            value: value.into_owned(),
        })
        .collect()
}

fn read_source_bytes(source: &BodySource) -> Result<Vec<u8>> {
    match &source.data {
        BodySourceData::File(path) => Ok(fs::read(path)?),
        BodySourceData::Bytes(bytes) => Ok(bytes.clone()),
    }
}

fn write_body_blob(flow_root: &Path, id: &str, source: &BodySource) -> Result<RequestBodyRef> {
    let directory = flow_root
        .join(REQUEST_LIBRARY_DIRECTORY)
        .join(BODIES_DIRECTORY);
    fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{id}.body"));
    match &source.data {
        BodySourceData::File(origin) => {
            // Stage + rename keeps a failed copy from cutting a previous blob.
            let staged = path.with_extension("tmp");
            fs::copy(origin, &staged)
                .with_context(|| format!("failed to stage request library body {id}"))?;
            fs::rename(&staged, &path)
                .with_context(|| format!("failed to store request library body {id}"))?;
        }
        BodySourceData::Bytes(bytes) => write_bytes_atomic(&path, bytes)
            .with_context(|| format!("failed to store request library body {id}"))?,
    }
    Ok(RequestBodyRef {
        path: blob_relative_path(id),
        size: fs::metadata(&path)?.len(),
    })
}

fn blob_relative_path(id: &str) -> String {
    format!("{REQUEST_LIBRARY_DIRECTORY}/{BODIES_DIRECTORY}/{id}.body")
}

/// Resolve a `bodyRef` path inside the flow root, refusing anything that is
/// not exactly `request-library/bodies/{safe-id}.body` so hand-edited entries
/// cannot traverse out of the blob directory.
fn blob_path(flow_root: &Path, relative: &str) -> Result<PathBuf> {
    let prefix = format!("{REQUEST_LIBRARY_DIRECTORY}/{BODIES_DIRECTORY}/");
    let file = relative
        .strip_prefix(&prefix)
        .filter(|file| file.ends_with(".body"))
        .ok_or_else(|| anyhow!("request library body ref {relative:?} must point into {prefix}"))?;
    validate_flow_id(file.trim_end_matches(".body"))?;
    Ok(flow_root.join(relative))
}

/// Fresh entry id (`req-{base64url(12 random bytes)}`), safe as a file name
/// and API path segment.
fn generate_request_id() -> Result<String> {
    let mut bytes = [0_u8; 12];
    getrandom::fill(&mut bytes).map_err(|error| anyhow!("generate request id: {error}"))?;
    Ok(format!("req-{}", URL_SAFE_NO_PAD.encode(bytes)))
}

/* ------------------------------------------------------------------ *
 * Cookie normalization (port of archived engine/har-cookies.ts)
 * ------------------------------------------------------------------ */

/// Parse a `Cookie` request header value into structured HAR cookies: split on
/// `;`, keep only segments containing `=` with a non-empty name, trim names
/// and values, take the value verbatim after the first `=`. Empty input
/// yields an empty list.
pub fn parse_cookie_header(header_value: &str) -> Vec<HarCookie> {
    let mut cookies = Vec::new();
    for part in header_value.split(';') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(separator) = trimmed.find('=') else {
            continue;
        };
        if separator == 0 {
            continue;
        }
        cookies.push(HarCookie {
            name: trimmed[..separator].trim().to_string(),
            value: trimmed[separator + 1..].trim().to_string(),
        });
    }
    cookies
}

/// Normalize an entry's request-side structured cookies (in place): only when
/// `request.cookies` is empty and a non-empty `Cookie` header exists is the
/// header parsed into `request.cookies`. Entries that already carry
/// structured cookies keep their richer information.
pub fn with_normalized_request_cookies(entry: &mut HarEntry) {
    if !entry.request.cookies.is_empty() {
        return;
    }
    let Some(header) = entry
        .request
        .headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case("cookie"))
    else {
        return;
    };
    if header.value.trim().is_empty() {
        return;
    }
    let cookies = parse_cookie_header(&header.value);
    if !cookies.is_empty() {
        entry.request.cookies = cookies;
    }
}

/* ------------------------------------------------------------------ *
 * Naming (port of archived panel/commit-naming.ts)
 * ------------------------------------------------------------------ */

/// Split a URL into `{host, path}` for naming; unparsable URLs (including
/// authority-form targets like `example.com:443`) fall back to the raw text
/// as host with an empty path, mirroring the upstream `splitUrlParts`.
fn split_url_parts(url: &str) -> (String, String) {
    match Url::parse(url) {
        Ok(parsed) if parsed.host_str().is_some() => {
            let mut host = parsed.host_str().unwrap_or_default().to_string();
            if let Some(port) = parsed.port() {
                host.push_str(&format!(":{port}"));
            }
            (host, parsed.path().to_string())
        }
        _ => (url.to_string(), String::new()),
    }
}

/// Default library name for one request: `METHOD host+path` with the root
/// path `/` left out (`GET example.com` beats `GET example.com/`); a blank
/// method keeps only the target part, and unparsable URLs fall back to the
/// raw text.
pub fn build_default_request_name(method: &str, url: &str) -> String {
    let (host, path) = split_url_parts(url);
    let target = if path == "/" || path.is_empty() {
        host
    } else {
        format!("{host}{path}")
    };
    let upper_method = method.trim().to_ascii_uppercase();
    if upper_method.is_empty() {
        target
    } else {
        format!("{upper_method} {target}")
    }
}

/// Name dedup policy: keep the desired name when unused; otherwise append the
/// first free numeric suffix (` 2`, ` 3`, ...), mirroring ReqFlow's batch
/// `${base} ${n}` naming. Comparison is exact full-name match.
fn assign_unique_name<'a>(desired: &str, taken: impl Iterator<Item = &'a str>) -> String {
    let taken: HashSet<&str> = taken.collect();
    if !taken.contains(desired) {
        return desired.to_string();
    }
    for suffix in 2_u64.. {
        let candidate = format!("{desired} {suffix}");
        if !taken.contains(candidate.as_str()) {
            return candidate;
        }
    }
    unreachable!("suffix loop always returns")
}

/* ------------------------------------------------------------------ *
 * Timestamps
 * ------------------------------------------------------------------ */

/// Format epoch milliseconds as an ISO 8601 UTC timestamp
/// (`YYYY-MM-DDTHH:MM:SS.mmmZ`). Civil-date conversion via Howard Hinnant's
/// `civil_from_days` algorithm; no new dependency for one informational field.
fn iso8601_from_epoch_ms(epoch_ms: u64) -> String {
    let seconds = (epoch_ms / 1000) as i64;
    let millis = epoch_ms % 1000;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        seconds_of_day / 3600,
        (seconds_of_day % 3600) / 60,
        seconds_of_day % 60
    )
}

/// Days since 1970-01-01 to (year, month, day) in the proleptic Gregorian
/// calendar (Howard Hinnant, `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cookie_headers_like_the_archived_engine() {
        assert_eq!(
            parse_cookie_header("a=1; b=2"),
            vec![
                HarCookie {
                    name: "a".into(),
                    value: "1".into()
                },
                HarCookie {
                    name: "b".into(),
                    value: "2".into()
                },
            ]
        );
        // Value is everything after the first `=`, trimmed; empty values stay.
        assert_eq!(
            parse_cookie_header("sid=abc==; theme="),
            vec![
                HarCookie {
                    name: "sid".into(),
                    value: "abc==".into()
                },
                HarCookie {
                    name: "theme".into(),
                    value: String::new()
                },
            ]
        );
        // Segments without `=`, empty segments and empty names are dropped.
        assert!(parse_cookie_header("").is_empty());
        assert!(parse_cookie_header("novalue").is_empty());
        assert!(parse_cookie_header("  ;  =v ; ").is_empty());
        assert_eq!(
            parse_cookie_header(" a = 1 "),
            vec![HarCookie {
                name: "a".into(),
                value: "1".into()
            }]
        );
    }

    #[test]
    fn cookie_normalization_only_fills_missing_structured_cookies() {
        let mut entry = HarEntry::new("GET", "https://example.com/");
        entry.request.headers.push(HarHeader {
            name: "Cookie".into(),
            value: "a=1".into(),
        });
        with_normalized_request_cookies(&mut entry);
        assert_eq!(
            entry.request.cookies,
            vec![HarCookie {
                name: "a".into(),
                value: "1".into()
            }]
        );

        // Existing structured cookies win over the header.
        with_normalized_request_cookies(&mut entry);
        assert_eq!(entry.request.cookies.len(), 1);

        // Blank cookie headers do not produce anything.
        let mut entry = HarEntry::new("GET", "https://example.com/");
        entry.request.headers.push(HarHeader {
            name: "cookie".into(),
            value: "   ".into(),
        });
        with_normalized_request_cookies(&mut entry);
        assert!(entry.request.cookies.is_empty());
    }

    #[test]
    fn default_names_follow_method_host_plus_path() {
        assert_eq!(
            build_default_request_name("GET", "https://api.example.com/v1/users?page=2"),
            "GET api.example.com/v1/users"
        );
        // Root path is not part of the name.
        assert_eq!(
            build_default_request_name("post", "https://example.com/"),
            "POST example.com"
        );
        // Non-default ports stay visible.
        assert_eq!(
            build_default_request_name("get", "http://localhost:3000/x"),
            "GET localhost:3000/x"
        );
        // Unparsable URLs and authority-form targets fall back to raw text.
        assert_eq!(build_default_request_name("GET", "not a url"), "GET not a url");
        assert_eq!(
            build_default_request_name("CONNECT", "example.com:443"),
            "CONNECT example.com:443"
        );
        // Blank methods keep only the target.
        assert_eq!(build_default_request_name("  ", "https://a.com/x"), "a.com/x");
    }

    #[test]
    fn name_dedup_appends_the_first_free_suffix() {
        assert_eq!(assign_unique_name("GET a", [].into_iter()).as_str(), "GET a");
        assert_eq!(
            assign_unique_name("GET a", ["GET b", "GET a"].into_iter()).as_str(),
            "GET a 2"
        );
        assert_eq!(
            assign_unique_name("GET a", ["GET a", "GET a 2", "GET a 4"].into_iter()).as_str(),
            "GET a 3"
        );
    }

    #[test]
    fn epoch_milliseconds_format_as_iso8601_utc() {
        assert_eq!(iso8601_from_epoch_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso8601_from_epoch_ms(1_700_000_000_000),
            "2023-11-14T22:13:20.000Z"
        );
        // Leap day and sub-second precision.
        assert_eq!(
            iso8601_from_epoch_ms(1_709_164_800_123),
            "2024-02-29T00:00:00.123Z"
        );
    }

    #[test]
    fn body_ref_paths_are_confined_to_the_blob_directory() {
        let root = Path::new("/workspace");
        assert_eq!(
            blob_path(root, "request-library/bodies/req-x.body").unwrap(),
            root.join("request-library/bodies/req-x.body")
        );
        for evil in [
            "bodies/req-x.body",
            "request-library/bodies/../req-x.body",
            "request-library/bodies/req-x.json",
            "../../../secrets",
        ] {
            assert!(blob_path(root, evil).is_err(), "{evil}");
        }
    }

    #[test]
    fn url_origins_mirror_the_js_semantics_for_special_schemes() {
        assert_eq!(
            url_origin("https://example.com/a/b").as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            url_origin("http://localhost:3000/x").as_deref(),
            Some("http://localhost:3000")
        );
        // Default ports are omitted.
        assert_eq!(
            url_origin("https://example.com:443/x").as_deref(),
            Some("https://example.com")
        );
        assert_eq!(url_origin("ftp://example.com/"), None);
        assert_eq!(url_origin("not a url"), None);
    }
}
