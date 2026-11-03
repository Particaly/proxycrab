//! Request library acceptance (plan Task 5): capture ingestion into the typed
//! HAR snapshot with cookie normalization, the inline/blob body policy at the
//! 64 KiB threshold, naming defaults with dedup, tags, and delete semantics.

use std::{fs, sync::Arc};

use proxy_crab_mitm::flow::request_library::{
    CapturedRequest, HarCookie, HarQueryString, RequestSource,
};
use proxy_crab_mitm::flow::store::FlowStore;
use proxy_crab_mitm::model::{BodySourceType, CaptureError, ErrorStage, HeaderValues, RequestData, ResponseData};
use proxy_crab_mitm::storage::{BodySide, CaptureStore};
use tempfile::tempdir;

/// Materialize one capture the way the manager layer (Task 6) will: detail
/// summary plus both body sources.
fn captured(store: &CaptureStore, id: u64) -> CapturedRequest {
    let detail = store.get(id).unwrap().expect("capture exists");
    CapturedRequest {
        capture: detail.summary,
        request_body: store.body_source(id, BodySide::Request).unwrap(),
        response_body: store.body_source(id, BodySide::Response).unwrap(),
    }
}

fn begin(
    store: &CaptureStore,
    method: &str,
    uri: &str,
    version: &str,
    headers: HeaderValues,
) -> u64 {
    store
        .begin(
            "127.0.0.1",
            &RequestData {
                method: method.into(),
                uri: uri.into(),
                version: version.into(),
                headers,
                tags: Default::default(),
            },
            "request",
        )
        .unwrap()
}

fn complete_ok(store: &CaptureStore, id: u64, headers: HeaderValues) {
    store
        .complete(
            id,
            &ResponseData {
                status: 200,
                version: "HTTP/1.1".into(),
                headers,
            },
            &BodySourceType::Original,
        )
        .unwrap();
}

#[test]
fn ingest_builds_typed_har_snapshot_with_normalized_cookies() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    let captures = CaptureStore::open(1, root.path()).unwrap();

    let mut headers = HeaderValues::new();
    headers.insert("host".into(), vec!["api.example.com".into()]);
    headers.insert("cookie".into(), vec!["session=abc; theme=dark".into()]);
    headers.insert("content-type".into(), vec!["application/json".into()]);
    headers.insert(
        "referer".into(),
        vec!["https://app.example.com/checkout".into()],
    );
    let id = begin(
        &captures,
        "POST",
        "https://api.example.com/v1/login?debug=1",
        "HTTP/2",
        headers,
    );
    captures
        .save_body(id, BodySide::Request, br#"{"user":"u"}"#)
        .unwrap();
    let mut response_headers = HeaderValues::new();
    response_headers.insert("content-type".into(), vec!["application/json".into()]);
    complete_ok(&captures, id, response_headers);
    captures
        .save_body(id, BodySide::Response, b"{\"ok\":true}")
        .unwrap();

    let entry = store
        .ingest_capture(
            &captured(&captures, id),
            None,
            &["auth".to_string(), "login".to_string()],
        )
        .unwrap();

    assert_eq!(entry.source, RequestSource::Capture);
    assert_eq!(entry.name, "POST api.example.com/v1/login");
    assert_eq!(entry.tags, vec!["auth", "login"]);
    assert_eq!(entry.origin, "https://app.example.com");
    assert!(entry.body_ref.is_none());
    assert_eq!(entry.har.log.version, "1.2");
    assert_eq!(entry.har.log.creator.name, "ProxyCrab");
    assert_eq!(entry.har.log.entries.len(), 1);

    let har_entry = &entry.har.log.entries[0];
    assert!(har_entry.started_date_time.starts_with("20"));
    assert!(har_entry.time < 60_000);
    assert_eq!(har_entry.request.method, "POST");
    assert_eq!(har_entry.request.url, "https://api.example.com/v1/login?debug=1");
    assert_eq!(har_entry.request.http_version, "HTTP/2");
    assert_eq!(
        har_entry.request.query_string,
        vec![HarQueryString {
            name: "debug".into(),
            value: "1".into()
        }]
    );
    // The merged Cookie header became structured cookies.
    assert_eq!(
        har_entry.request.cookies,
        vec![
            HarCookie {
                name: "session".into(),
                value: "abc".into()
            },
            HarCookie {
                name: "theme".into(),
                value: "dark".into()
            },
        ]
    );
    assert!(
        har_entry
            .request
            .headers
            .iter()
            .any(|header| header.name == "cookie" && header.value == "session=abc; theme=dark")
    );
    let post_data = har_entry.request.post_data.as_ref().unwrap();
    assert_eq!(post_data.mime_type, "application/json");
    assert_eq!(post_data.text.as_deref(), Some(r#"{"user":"u"}"#));
    assert_eq!(post_data.encoding, None);

    let response = har_entry.response.as_ref().unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.status_text, "OK");
    assert_eq!(response.http_version, "HTTP/1.1");
    assert_eq!(response.content.mime_type, "application/json");
    assert_eq!(response.content.size, b"{\"ok\":true}".len() as i64);
    assert_eq!(response.redirect_url, "");

    // Round trip through disk, and the persisted JSON stays camelCase.
    assert_eq!(store.get_request(&entry.id).unwrap(), Some(entry.clone()));
    let raw: serde_json::Value = serde_json::from_slice(
        &fs::read(root.path().join(format!("flow/request-library/{}.json", entry.id))).unwrap(),
    )
    .unwrap();
    assert_eq!(raw["source"], "capture");
    assert_eq!(raw["har"]["log"]["entries"][0]["request"]["queryString"][0]["name"], "debug");
    assert_eq!(raw["har"]["log"]["entries"][0]["request"]["cookies"][0]["name"], "session");
    assert_eq!(raw["har"]["log"]["entries"][0]["response"]["statusText"], "OK");
    assert!(raw.get("bodyRef").is_none());

    // A bodyless request carries no postData at all.
    let bare = begin(&captures, "GET", "https://api.example.com/ping", "HTTP/1.1", HeaderValues::new());
    complete_ok(&captures, bare, HeaderValues::new());
    let entry = store
        .ingest_capture(&captured(&captures, bare), None, &[])
        .unwrap();
    assert!(entry.har.log.entries[0].request.post_data.is_none());
    assert!(entry.body_ref.is_none());
}

#[test]
fn large_text_and_binary_bodies_are_stored_as_blobs() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    let captures = CaptureStore::open(1, root.path()).unwrap();

    // At the 64 KiB limit a UTF-8 body stays inline.
    let inline_id = begin(
        &captures,
        "PUT",
        "https://files.example.com/exactly-64k",
        "HTTP/1.1",
        HeaderValues::new(),
    );
    captures
        .save_body(inline_id, BodySide::Request, &vec![b'a'; 64 * 1024])
        .unwrap();
    complete_ok(&captures, inline_id, HeaderValues::new());
    let inline = store
        .ingest_capture(&captured(&captures, inline_id), None, &[])
        .unwrap();
    assert!(inline.body_ref.is_none());
    assert_eq!(
        inline.har.log.entries[0]
            .request
            .post_data
            .as_ref()
            .unwrap()
            .text
            .as_ref()
            .map(String::len),
        Some(64 * 1024)
    );

    // One byte over the limit goes to the blob file; the JSON index stays small.
    let large_id = begin(
        &captures,
        "PUT",
        "https://files.example.com/over-64k",
        "HTTP/1.1",
        HeaderValues::new(),
    );
    captures
        .save_body(large_id, BodySide::Request, &vec![b'a'; 64 * 1024 + 1])
        .unwrap();
    complete_ok(&captures, large_id, HeaderValues::new());
    let large = store
        .ingest_capture(&captured(&captures, large_id), None, &[])
        .unwrap();
    let body_ref = large.body_ref.as_ref().expect("large body goes to a blob");
    assert_eq!(body_ref.path, format!("request-library/bodies/{}.body", large.id));
    assert_eq!(body_ref.size, 64 * 1024 + 1);
    assert!(
        large.har.log.entries[0]
            .request
            .post_data
            .as_ref()
            .unwrap()
            .text
            .is_none()
    );
    let entry_json = root.path().join(format!("flow/request-library/{}.json", large.id));
    let blob = root.path().join(format!("flow/request-library/bodies/{}.body", large.id));
    assert_eq!(fs::metadata(&blob).unwrap().len(), 64 * 1024 + 1);
    assert!(
        fs::metadata(&entry_json).unwrap().len() < 8 * 1024,
        "JSON index must stay separated from the body bytes"
    );
    assert_eq!(
        store.read_request_body(&large).unwrap().unwrap(),
        vec![b'a'; 64 * 1024 + 1]
    );

    // Small binary bodies go to the blob too, byte-exact.
    let binary_id = begin(
        &captures,
        "POST",
        "https://files.example.com/binary",
        "HTTP/1.1",
        HeaderValues::new(),
    );
    let binary_bytes = vec![0_u8, 159, 146, 150, 7];
    captures
        .save_body(binary_id, BodySide::Request, &binary_bytes)
        .unwrap();
    complete_ok(&captures, binary_id, HeaderValues::new());
    let binary = store
        .ingest_capture(&captured(&captures, binary_id), None, &[])
        .unwrap();
    let binary_ref = binary.body_ref.as_ref().expect("binary body goes to a blob");
    assert_eq!(binary_ref.size, binary_bytes.len() as u64);
    assert_eq!(store.read_request_body(&binary).unwrap().unwrap(), binary_bytes);
    assert!(blob.exists());

    // Deleting the entry removes its blob with it.
    store.delete_request(&large.id).unwrap();
    assert_eq!(store.get_request(&large.id).unwrap(), None);
    assert!(!blob.exists());
    let error = store.delete_request(&large.id).unwrap_err().to_string();
    assert!(error.contains("not found"), "{error}");
}

#[test]
fn naming_defaults_dedup_and_explicit_overrides() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    let captures = CaptureStore::open(1, root.path()).unwrap();

    let make = |uri: &str| {
        let id = begin(&captures, "GET", uri, "HTTP/1.1", HeaderValues::new());
        complete_ok(&captures, id, HeaderValues::new());
        id
    };

    let first = store
        .ingest_capture(&captured(&captures, make("http://example.com/ping")), None, &[])
        .unwrap();
    let second = store
        .ingest_capture(&captured(&captures, make("http://example.com/ping")), None, &[])
        .unwrap();
    let third = store
        .ingest_capture(&captured(&captures, make("http://example.com/ping")), None, &[])
        .unwrap();
    assert_eq!(first.name, "GET example.com/ping");
    assert_eq!(second.name, "GET example.com/ping 2");
    assert_eq!(third.name, "GET example.com/ping 3");
    assert_ne!(first.id, second.id);

    // Explicit names are honored and deduplicated the same way.
    let custom = store
        .ingest_capture(
            &captured(&captures, make("http://example.com/other")),
            Some("checkout call"),
            &[],
        )
        .unwrap();
    let custom2 = store
        .ingest_capture(
            &captured(&captures, make("http://example.com/other")),
            Some("checkout call"),
            &[],
        )
        .unwrap();
    assert_eq!(custom.name, "checkout call");
    assert_eq!(custom2.name, "checkout call 2");

    // A blank explicit name falls back to the default naming.
    let blank = store
        .ingest_capture(&captured(&captures, make("http://example.com/")), Some("   "), &[])
        .unwrap();
    assert_eq!(blank.name, "GET example.com");

    // Root-path URLs keep the bare host.
    let rooted = store
        .ingest_capture(&captured(&captures, make("http://example.com/")), None, &[])
        .unwrap();
    assert_eq!(rooted.name, "GET example.com 2");
}

#[test]
fn failed_capture_ingests_without_response_summary() {
    let root = tempdir().unwrap();
    let store = FlowStore::open(root.path()).unwrap();
    let captures = CaptureStore::open(1, root.path()).unwrap();

    let id = begin(&captures, "GET", "https://down.example.com/x", "HTTP/1.1", HeaderValues::new());
    captures
        .fail(
            id,
            &CaptureError {
                stage: ErrorStage::Upstream,
                kind: "connect_timeout".into(),
                message: "upstream timed out".into(),
            },
        )
        .unwrap();

    let entry = store
        .ingest_capture(&captured(&captures, id), None, &[])
        .unwrap();
    assert_eq!(entry.name, "GET down.example.com/x");
    assert!(entry.har.log.entries[0].response.is_none());
}

/// The manager layer (plan Task 6) ingests captures through `ProxyCrab`; the
/// archived-session read path must keep that working after a Session moves to
/// `sessions_archived/`.
#[tokio::test]
async fn archived_session_captures_stay_ingestible_through_the_runtime() {
    use proxy_crab_mitm::{ProxyCrab, log_buffer::LogBuffer, model::NewSession};

    let root = tempdir().unwrap();
    let runtime = ProxyCrab::open(root.path(), Arc::new(LogBuffer::default())).unwrap();
    let session = runtime.create_session(NewSession::default()).unwrap();
    let captures = CaptureStore::open(session.id, runtime.workspace().root()).unwrap();
    let id = begin(
        &captures,
        "POST",
        "https://api.example.com/v1/login",
        "HTTP/1.1",
        HeaderValues::new(),
    );
    captures.save_body(id, BodySide::Request, br#"{"user":"u"}"#).unwrap();
    complete_ok(&captures, id, HeaderValues::new());
    drop(captures);

    runtime.archive_session(session.id).await.unwrap();
    assert!(
        runtime.workspace().root().join("sessions_archived").join(session.id.to_string()).exists()
    );

    // The live path refuses archived sessions, the archived path serves them.
    assert!(runtime.capture(session.id, id).is_err());
    let detail = runtime
        .archived_capture(session.id, id)
        .unwrap()
        .expect("archived capture exists");
    let request_body = runtime
        .archived_capture_body_source(session.id, id, BodySide::Request)
        .unwrap()
        .expect("archived request body exists");
    let response_body = runtime
        .archived_capture_body_source(session.id, id, BodySide::Response)
        .unwrap()
        .expect("archived response body exists");

    let store = FlowStore::open(runtime.workspace().root()).unwrap();
    let entry = store
        .ingest_capture(
            &CapturedRequest {
                capture: detail.summary,
                request_body: Some(request_body),
                response_body: Some(response_body),
            },
            None,
            &[],
        )
        .unwrap();
    assert_eq!(entry.name, "POST api.example.com/v1/login");
    assert_eq!(
        entry.har.log.entries[0].request.post_data.as_ref().unwrap().text.as_deref(),
        Some(r#"{"user":"u"}"#)
    );

    // Unknown archived sessions surface the typed error.
    let error = runtime.archived_capture(999, id).unwrap_err().to_string();
    assert!(error.contains("archived session 999 not found"), "{error}");
}
