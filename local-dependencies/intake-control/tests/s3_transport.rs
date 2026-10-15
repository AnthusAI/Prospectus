#![cfg(feature = "aws")]
//! Real SDK/Virtuus requests to a deterministic loopback S3 service, not AWS.
use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{Request, Response, StatusCode},
    routing::any,
    Router,
};
use prospectus_intake_control_binding::{
    transport::{dispatch, ControlRequest},
    IntakeControls,
};
use std::{
    collections::BTreeMap,
    io::Write,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};
use virtuus_store::{aws::S3Store, Scope};

#[derive(Default)]
struct Service {
    objects: BTreeMap<String, (Vec<u8>, String)>,
    calls: Vec<(String, String)>,
    lose_put: bool,
    lose_get: bool,
    deny_put: bool,
    sequence: u64,
}

fn reply(status: StatusCode, bytes: Vec<u8>, etag: Option<&str>) -> Response<Body> {
    let mut response = Response::builder().status(status);
    if let Some(etag) = etag {
        response = response.header("etag", etag);
    }
    response.body(Body::from(bytes)).unwrap()
}
fn error(status: StatusCode, code: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/xml")
        .body(Body::from(format!(
            "<Error><Code>{code}</Code><Message>synthetic service response</Message></Error>"
        )))
        .unwrap()
}
async fn handle(
    State(state): State<Arc<Mutex<Service>>>,
    request: Request<Body>,
) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let bytes = to_bytes(body, 65536).await.unwrap().to_vec();
    let path = parts.uri.path().to_owned();
    let mut service = state.lock().unwrap();
    service.calls.push((parts.method.to_string(), path.clone()));
    if parts.method == "GET" {
        let Some((bytes, revision)) = service.objects.get(&path).cloned() else {
            return error(StatusCode::NOT_FOUND, "NoSuchKey");
        };
        if service.lose_get {
            service.lose_get = false;
            return reply(StatusCode::OK, bytes, None);
        }
        return reply(StatusCode::OK, bytes, Some(&revision));
    }
    if parts.method != "PUT" {
        return error(StatusCode::METHOD_NOT_ALLOWED, "InvalidRequest");
    }
    if service.deny_put {
        service.deny_put = false;
        return error(StatusCode::FORBIDDEN, "AccessDenied");
    }
    let absent = parts
        .headers
        .get("if-none-match")
        .and_then(|value| value.to_str().ok());
    let revision = parts
        .headers
        .get("if-match")
        .and_then(|value| value.to_str().ok());
    let current = service.objects.get(&path);
    if absent == Some("*") && current.is_some()
        || revision.is_some() && current.map(|(_, value)| value.as_str()) != revision
    {
        return error(StatusCode::PRECONDITION_FAILED, "PreconditionFailed");
    }
    if absent.is_none() && revision.is_none() {
        return error(StatusCode::BAD_REQUEST, "InvalidRequest");
    }
    service.sequence += 1;
    let etag = format!("\"mock-{}\"", service.sequence);
    service.objects.insert(path, (bytes, etag.clone()));
    if service.lose_put {
        service.lose_put = false;
        return reply(StatusCode::OK, vec![], None);
    }
    reply(StatusCode::OK, vec![], Some(&etag))
}
fn request(
    operation: &str,
    workspace: &str,
    bytes: Option<&str>,
    revision: Option<&str>,
) -> ControlRequest {
    let mut value = serde_json::json!({"version":1,"workspace":workspace,"operation":operation,"path":format!("intake-identities/{}.json", "a".repeat(64))});
    if let Some(bytes) = bytes {
        value["bytes"] = serde_json::json!(bytes);
        value["condition"] = revision.map_or_else(
            || serde_json::json!({"absent":true}),
            |revision| serde_json::json!({"revision":revision}),
        );
    }
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn actual_s3_adapter_to_mock_preserves_conditions_uncertainty_and_scope() {
    let service = Arc::new(Mutex::new(Service::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let state = service.clone();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().fallback(any(handle)).with_state(state),
        )
        .await
        .unwrap();
    });
    // Static mock credentials and loopback endpoint; no default provider chain.
    let configuration = aws_sdk_s3::config::Builder::new()
        .behavior_version_latest()
        .region(aws_sdk_s3::config::Region::new("us-east-1"))
        .credentials_provider(aws_sdk_s3::config::Credentials::new(
            "mock-key",
            "mock-secret",
            None,
            None,
            "loopback-test",
        ))
        .endpoint_url(format!("http://{address}"))
        .force_path_style(true)
        .build();
    let controls = IntakeControls::new(
        Arc::new(S3Store::new(
            aws_sdk_s3::Client::from_conf(configuration),
            "mock-bucket",
        )),
        Scope::new("test", "prospectus").unwrap(),
    );
    assert_eq!(
        dispatch(
            &request("get", "test/prospectus", None, None),
            "test/prospectus",
            &controls
        )
        .await
        .status,
        "missing"
    );
    let first = dispatch(
        &request("put", "test/prospectus", Some("first 世界\n"), None),
        "test/prospectus",
        &controls,
    )
    .await;
    assert_eq!(first.status, "ok");
    let revision = first.object.unwrap().revision;
    assert_eq!(revision, "\"mock-1\"");
    assert_eq!(
        dispatch(
            &request("put", "test/prospectus", Some("duplicate"), None),
            "test/prospectus",
            &controls
        )
        .await
        .status,
        "conflict"
    );
    assert_eq!(
        dispatch(
            &request("put", "test/prospectus", Some("stale"), Some("\"stale\"")),
            "test/prospectus",
            &controls
        )
        .await
        .status,
        "conflict"
    );
    service.lock().unwrap().lose_put = true;
    assert_eq!(
        dispatch(
            &request(
                "put",
                "test/prospectus",
                Some("committed, confirmation lost"),
                Some(&revision)
            ),
            "test/prospectus",
            &controls
        )
        .await
        .status,
        "uncertain"
    );
    let recovered = dispatch(
        &request("get", "test/prospectus", None, None),
        "test/prospectus",
        &controls,
    )
    .await;
    assert_eq!(
        recovered.object.unwrap().bytes,
        "committed, confirmation lost"
    );
    service.lock().unwrap().lose_get = true;
    assert_eq!(
        dispatch(
            &request("get", "test/prospectus", None, None),
            "test/prospectus",
            &controls
        )
        .await
        .status,
        "unavailable"
    );
    let before = service.lock().unwrap().calls.len();
    assert_eq!(
        dispatch(
            &request("get", "other/prospectus", None, None),
            "test/prospectus",
            &controls
        )
        .await
        .status,
        "unauthorized"
    );
    assert_eq!(service.lock().unwrap().calls.len(), before);
    service.lock().unwrap().deny_put = true;
    assert_eq!(
        dispatch(
            &request("put", "test/prospectus", Some("denied"), Some("\"mock-2\"")),
            "test/prospectus",
            &controls
        )
        .await
        .status,
        "unavailable"
    );
    assert!(service
        .lock()
        .unwrap()
        .calls
        .iter()
        .all(|(_, path)| path
            .starts_with("/mock-bucket/_virtuus/test/prospectus/intake-identities/")));
    server.abort();
}

#[test]
fn real_stdio_binary_refuses_other_workspace_before_loading_credentials() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_prospectus-s3-controls"))
        .env_clear()
        .env("PROSPECTUS_CONTROL_WORKSPACE", "test/prospectus")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    serde_json::to_writer(child.stdin.as_mut().unwrap(), &serde_json::json!({"version":1,"workspace":"other/prospectus","operation":"get","path":format!("intake-identities/{}.json", "a".repeat(64))})).unwrap();
    child.stdin.take().unwrap().flush().unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["status"], "unauthorized");
}
