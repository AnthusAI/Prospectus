//! Synthetic loopback S3, actual SDK + pinned journal. No AWS credential chain.
use super::*;
use axum::{
    body::{to_bytes, Body},
    extract::{Query, State},
    http::{Request as HttpRequest, Response, StatusCode},
    routing::any,
    Router,
};
use std::{collections::BTreeMap, sync::Mutex};
#[derive(Default)]
struct Service {
    objects: BTreeMap<String, (Vec<u8>, String, Option<String>)>,
    sequence: u64,
    lose_canonical_ack: bool,
    deny_canonical: bool,
    uncertain_before_publication: bool,
    calls: Vec<String>,
    calls_without_expected_owner: Vec<String>,
}
fn response(
    status: StatusCode,
    bytes: Vec<u8>,
    etag: Option<&str>,
    operation: Option<&str>,
) -> Response<Body> {
    let mut result = Response::builder()
        .status(status)
        .header("content-type", "application/xml");
    if let Some(etag) = etag {
        result = result.header("etag", etag);
    }
    if let Some(operation) = operation {
        result = result.header("x-amz-meta-operation-id", operation);
    }
    result.body(Body::from(bytes)).unwrap()
}
fn error(status: StatusCode, code: &str) -> Response<Body> {
    response(
        status,
        format!("<Error><Code>{code}</Code></Error>").into_bytes(),
        None,
        None,
    )
}
async fn handle(
    State(state): State<Arc<Mutex<Service>>>,
    Query(query): Query<BTreeMap<String, String>>,
    request: HttpRequest<Body>,
) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let bytes = to_bytes(body, 131072).await.unwrap().to_vec();
    let path = parts.uri.path().to_owned();
    let mut service = state.lock().unwrap();
    service.calls.push(path.clone());
    let expected_owner_header = parts
        .headers
        .get("x-amz-expected-bucket-owner")
        .and_then(|value| value.to_str().ok());
    if expected_owner_header != Some("123456789012") {
        service.calls_without_expected_owner.push(path.clone());
    }
    if parts.method == "GET" && query.contains_key("list-type") {
        let prefix = format!("/mock-bucket/{}", query.get("prefix").unwrap());
        let keys = service
            .objects
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .map(|key| {
                format!(
                    "<Contents><Key>{}</Key></Contents>",
                    key.trim_start_matches("/mock-bucket/")
                )
            })
            .collect::<String>();
        return response(
            StatusCode::OK,
            format!("<ListBucketResult><IsTruncated>false</IsTruncated>{keys}</ListBucketResult>")
                .into_bytes(),
            None,
            None,
        );
    }
    if parts.method == "GET" {
        return match service.objects.get(&path) {
            Some((bytes, etag, op)) => {
                response(StatusCode::OK, bytes.clone(), Some(etag), op.as_deref())
            }
            None => error(StatusCode::NOT_FOUND, "NoSuchKey"),
        };
    }
    if parts.method != "PUT" {
        return error(StatusCode::METHOD_NOT_ALLOWED, "InvalidRequest");
    }
    if service.uncertain_before_publication && path.contains("/google/") {
        return response(StatusCode::OK, vec![], None, None);
    }
    if service.deny_canonical && path.contains("/google/") {
        return error(StatusCode::FORBIDDEN, "AccessDenied");
    }
    let absent = parts
        .headers
        .get("if-none-match")
        .and_then(|v| v.to_str().ok());
    let revision = parts.headers.get("if-match").and_then(|v| v.to_str().ok());
    let current = service.objects.get(&path);
    if absent == Some("*") && current.is_some()
        || revision.is_some() && current.map(|(_, etag, _)| etag.as_str()) != revision
    {
        return error(StatusCode::PRECONDITION_FAILED, "PreconditionFailed");
    }
    if absent.is_none() && revision.is_none() {
        return error(StatusCode::BAD_REQUEST, "InvalidRequest");
    }
    service.sequence += 1;
    let etag = format!("\"mock-{}\"", service.sequence);
    let operation = parts
        .headers
        .get("x-amz-meta-operation-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    service
        .objects
        .insert(path.clone(), (bytes, etag.clone(), operation));
    if service.lose_canonical_ack && path.contains("/google/") {
        service.lose_canonical_ack = false;
        return response(StatusCode::OK, vec![], None, None);
    }
    response(StatusCode::OK, vec![], Some(&etag), None)
}
fn request(value: Value) -> Request {
    serde_json::from_value(value).unwrap()
}
#[tokio::test]
async fn s3_identity_journal_preserves_bytes_conditions_replay_and_uncertainty() {
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
    let config = aws_sdk_s3::config::Builder::new()
        .behavior_version_latest()
        .region(aws_sdk_s3::config::Region::new("us-east-1"))
        .credentials_provider(aws_sdk_s3::config::Credentials::new(
            "synthetic",
            "synthetic",
            Some("synthetic-session".into()),
            None,
            "loopback-only",
        ))
        .endpoint_url(format!("http://{address}"))
        .force_path_style(true)
        .interceptor(ExpectedBucketOwnerInterceptor::new("123456789012".into()))
        .build();
    let objects: Arc<dyn ObjectStore> = Arc::new(virtuus_store::aws::S3Store::new(
        aws_sdk_s3::Client::from_conf(config),
        "mock-bucket",
    ));
    let run = |value: Value| {
        dispatch_with_store(
            request(value),
            objects.clone(),
            Scope::new("synthetic", "identities").unwrap(),
        )
    };
    let path = format!("google/{}.json", "a".repeat(64));
    let create = json!({"action":"commit","path":path,"operation_id":"synthetic-operation-1","request_hash":"a".repeat(64),"value":{"name":"synthetic 世界"}});
    service.lock().unwrap().lose_canonical_ack = true;
    // The live journal can reconcile a missing acknowledgment from canonical metadata.
    let recovered = run(create.clone()).await.unwrap();
    assert_eq!(recovered["value"]["name"], "synthetic 世界");
    assert_eq!(run(create.clone()).await.unwrap(), recovered);
    let mut changed = create.clone();
    changed["request_hash"] = json!("b".repeat(64));
    assert!(matches!(
        run(changed).await,
        Err(StoreError::OperationMismatch)
    ));
    let mut collision = create.clone();
    collision["operation_id"] = json!("synthetic-operation-2");
    assert!(matches!(run(collision).await, Err(StoreError::Conflict)));
    let mut stale = create.clone();
    stale["operation_id"] = json!("synthetic-operation-3");
    stale["revision"] = json!("stale");
    assert!(matches!(run(stale).await, Err(StoreError::Conflict)));
    let mut update = create.clone();
    update["operation_id"] = json!("synthetic-operation-4");
    update["revision"] = recovered["revision"].clone();
    update["value"] = json!({"name":"changed"});
    assert_eq!(run(update).await.unwrap()["value"]["name"], "changed");
    assert_eq!(
        run(json!({"action":"list","path":"google/"}))
            .await
            .unwrap()["paths"],
        json!([path])
    );
    service.lock().unwrap().deny_canonical = true;
    let denied = json!({"action":"commit","path":format!("google/{}.json","b".repeat(64)),"operation_id":"synthetic-operation-5","request_hash":"b".repeat(64),"value":{}});
    assert!(matches!(
        run(denied.clone()).await,
        Err(StoreError::Unavailable(_))
    ));
    assert!(matches!(run(denied).await, Err(StoreError::Unavailable(_))));
    {
        let mut state = service.lock().unwrap();
        state.deny_canonical = false;
        state.uncertain_before_publication = true;
    }
    let uncertain = json!({"action":"commit","path":format!("google/{}.json","c".repeat(64)),"operation_id":"synthetic-operation-6","request_hash":"c".repeat(64),"value":{}});
    assert!(matches!(
        run(uncertain.clone()).await,
        Err(StoreError::Uncertain(_))
    ));
    assert!(matches!(
        run(uncertain).await,
        Err(StoreError::Uncertain(_))
    ));
    let service = service.lock().unwrap();
    assert!(!service.calls.is_empty());
    assert_eq!(service.calls_without_expected_owner, Vec::<String>::new());
    assert!(service.calls.iter().all(|path| path == "/mock-bucket/"
        || path.starts_with("/mock-bucket/synthetic/identities/")
        || path.starts_with("/mock-bucket/_virtuus/synthetic/identities/")));
    server.abort();
}
