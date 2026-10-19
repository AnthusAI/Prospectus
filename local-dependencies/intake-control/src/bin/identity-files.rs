//! Private identity-file bridge using pinned Virtuus conditional journals.
//! Filesystem by default; explicit AWS feature/configuration enables S3. No HTTP route.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{BufRead, Read, Write},
    sync::Arc,
    time::Instant,
};
use virtuus_store::{
    FileStore, JournaledStore, MemoryCatalog, Mutation, ObjectPage, ObjectStore, Scope, StoreError,
    StoredObject, WriteCondition,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    action: String,
    path: String,
    #[serde(default)]
    operation_id: String,
    #[serde(default)]
    request_hash: String,
    #[serde(default)]
    revision: Option<String>,
    #[serde(default)]
    value: Value,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    fault: Option<String>,
}

fn timing(phase: &str, operation: &str, started: Instant, success: bool) {
    if std::env::var("PROSPECTUS_IDENTITY_TIMINGS").as_deref() == Ok("1") {
        eprintln!(
            "{}",
            json!({"phase":phase,"operation":operation,"durationMs":started.elapsed().as_millis(),"success":success})
        );
    }
}

struct ObservedObjects(Arc<dyn ObjectStore>);
#[async_trait::async_trait]
impl ObjectStore for ObservedObjects {
    async fn get(&self, scope: &Scope, path: &str) -> virtuus_store::Result<Option<StoredObject>> {
        let started = Instant::now();
        let outcome = self.0.get(scope, path).await;
        timing("storage", "get", started, outcome.is_ok());
        outcome
    }
    async fn get_bounded(
        &self,
        scope: &Scope,
        path: &str,
        max_bytes: usize,
    ) -> virtuus_store::Result<Option<StoredObject>> {
        let started = Instant::now();
        let outcome = self.0.get_bounded(scope, path, max_bytes).await;
        timing("storage", "get_bounded", started, outcome.is_ok());
        outcome
    }
    async fn list(
        &self,
        scope: &Scope,
        prefix: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> virtuus_store::Result<ObjectPage> {
        let started = Instant::now();
        let outcome = self.0.list(scope, prefix, cursor, limit).await;
        timing("storage", "list", started, outcome.is_ok());
        outcome
    }
    async fn put(
        &self,
        scope: &Scope,
        path: &str,
        bytes: &[u8],
        content_type: &str,
        condition: WriteCondition,
        operation_id: Option<&str>,
    ) -> virtuus_store::Result<StoredObject> {
        let started = Instant::now();
        let outcome = self
            .0
            .put(scope, path, bytes, content_type, condition, operation_id)
            .await;
        timing("storage", "put", started, outcome.is_ok());
        outcome
    }
    async fn delete(
        &self,
        scope: &Scope,
        path: &str,
        expected_revision: &str,
    ) -> virtuus_store::Result<()> {
        let started = Instant::now();
        let outcome = self.0.delete(scope, path, expected_revision).await;
        timing("storage", "delete", started, outcome.is_ok());
        outcome
    }
    async fn get_control(
        &self,
        scope: &Scope,
        path: &str,
    ) -> virtuus_store::Result<Option<StoredObject>> {
        let started = Instant::now();
        let outcome = self.0.get_control(scope, path).await;
        timing("storage", "get_control", started, outcome.is_ok());
        outcome
    }
    async fn put_control(
        &self,
        scope: &Scope,
        path: &str,
        bytes: &[u8],
        condition: WriteCondition,
    ) -> virtuus_store::Result<StoredObject> {
        let started = Instant::now();
        let outcome = self.0.put_control(scope, path, bytes, condition).await;
        timing("storage", "put_control", started, outcome.is_ok());
        outcome
    }
}

/// Test-only interruption inside the real journal's canonical publication call.
/// This executable has only a local FileStore; no cloud fault switch is added.
struct InterruptibleFiles {
    inner: FileStore,
    fault: Option<String>,
}
#[async_trait::async_trait]
impl ObjectStore for InterruptibleFiles {
    async fn get(&self, scope: &Scope, path: &str) -> virtuus_store::Result<Option<StoredObject>> {
        self.inner.get(scope, path).await
    }
    async fn get_bounded(
        &self,
        scope: &Scope,
        path: &str,
        max_bytes: usize,
    ) -> virtuus_store::Result<Option<StoredObject>> {
        self.inner.get_bounded(scope, path, max_bytes).await
    }
    async fn list(
        &self,
        scope: &Scope,
        prefix: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> virtuus_store::Result<ObjectPage> {
        self.inner.list(scope, prefix, cursor, limit).await
    }
    async fn put(
        &self,
        scope: &Scope,
        path: &str,
        bytes: &[u8],
        content_type: &str,
        condition: WriteCondition,
        operation_id: Option<&str>,
    ) -> virtuus_store::Result<StoredObject> {
        if self.fault.as_deref() == Some("before_publication") {
            std::process::exit(86);
        }
        let stored = self
            .inner
            .put(scope, path, bytes, content_type, condition, operation_id)
            .await?;
        if self.fault.as_deref() == Some("after_publication") {
            std::process::exit(86);
        }
        Ok(stored)
    }
    async fn delete(
        &self,
        scope: &Scope,
        path: &str,
        expected_revision: &str,
    ) -> virtuus_store::Result<()> {
        self.inner.delete(scope, path, expected_revision).await
    }
    async fn get_control(
        &self,
        scope: &Scope,
        path: &str,
    ) -> virtuus_store::Result<Option<StoredObject>> {
        self.inner.get_control(scope, path).await
    }
    async fn put_control(
        &self,
        scope: &Scope,
        path: &str,
        bytes: &[u8],
        condition: WriteCondition,
    ) -> virtuus_store::Result<StoredObject> {
        self.inner.put_control(scope, path, bytes, condition).await
    }
}

fn path_belongs_to_project(kind: &str, project: &str) -> bool {
    match project {
        "accounts" => ["accounts", "members"].contains(&kind),
        "identities" => ["google", "aliases", "people", "logins", "sessions"].contains(&kind),
        _ => true,
    }
}

fn path_segment_is_canonical(part: &str) -> bool {
    let segment = part.strip_suffix(".json").unwrap_or(part);
    !segment.is_empty()
        && segment.len() <= 128
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn valid_path(path: &str, prefix: bool, project: &str) -> bool {
    let Some((kind, rest)) = path.split_once('/') else {
        return false;
    };
    if !path_belongs_to_project(kind, project) {
        return false;
    }
    if prefix && rest.is_empty() {
        return true;
    }
    rest.split('/')
        .filter(|part| !part.is_empty())
        .all(path_segment_is_canonical)
        && !rest.contains("//")
        && (prefix || rest.ends_with(".json"))
}

fn validate_request(request: &Request) -> Result<(), StoreError> {
    let project =
        std::env::var("PROSPECTUS_IDENTITY_PROJECT").unwrap_or_else(|_| "identities".into());
    if !["identities", "accounts"].contains(&project.as_str())
        || !valid_path(&request.path, request.action == "list", &project)
    {
        return Err(StoreError::Invalid("identity path required".into()));
    }
    Ok(())
}

async fn observed_store(request: &Request) -> Result<(Arc<dyn ObjectStore>, Scope), StoreError> {
    let started = Instant::now();
    let result = configured_store(request).await;
    timing("initialize", "configure", started, result.is_ok());
    let (objects, scope) = result?;
    Ok((Arc::new(ObservedObjects(objects)), scope))
}

async fn dispatch(request: Request) -> Result<Value, StoreError> {
    validate_request(&request)?;
    let (objects, scope) = observed_store(&request).await?;
    dispatch_with_store(request, objects, scope).await
}

async fn dispatch_with_store(
    request: Request,
    objects: Arc<dyn ObjectStore>,
    scope: Scope,
) -> Result<Value, StoreError> {
    let store = JournaledStore::new(objects, Arc::new(MemoryCatalog::default()))
        .with_canonical_read_limit(65536)?;
    match request.action.as_str() {
        "get" => Ok(match store.get(&scope, &request.path).await? {
            Some(stored) => {
                json!({"value":serde_json::from_slice::<Value>(&stored.bytes)?,"revision":stored.revision})
            }
            None => Value::Null,
        }),
        "list" => {
            let page = store
                .list(&scope, &request.path, request.cursor.as_deref(), 100)
                .await?;
            Ok(json!({"paths":page.paths,"nextCursor":page.next_cursor}))
        }
        "commit" => {
            if let Some(result) = store
                .operation(&scope, &request.operation_id, &request.request_hash)
                .await?
            {
                return Ok(
                    json!({"value":serde_json::from_slice::<Value>(&result.stored.bytes)?,"revision":result.stored.revision}),
                );
            }
            let bytes = serde_json::to_vec(&request.value)?;
            if bytes.len() > 65536 {
                return Err(StoreError::Invalid("identity object exceeds budget".into()));
            }
            let mutation = Mutation {
                path: request.path,
                bytes,
                content_type: "application/json".into(),
                condition: request
                    .revision
                    .map(WriteCondition::Revision)
                    .unwrap_or(WriteCondition::Absent),
                operation_id: request.operation_id,
                request_hash: request.request_hash,
                event_objects: vec![],
                fields: BTreeMap::new(),
            };
            let result = store.commit(&scope, &mutation).await?;
            Ok(
                json!({"value":serde_json::from_slice::<Value>(&result.stored.bytes)?,"revision":result.stored.revision}),
            )
        }
        _ => Err(StoreError::Invalid("identity action required".into())),
    }
}

async fn configured_store(request: &Request) -> Result<(Arc<dyn ObjectStore>, Scope), StoreError> {
    match std::env::var("PROSPECTUS_IDENTITY_BACKEND")
        .as_deref()
        .unwrap_or("filesystem")
    {
        "filesystem" => {
            if request
                .fault
                .as_deref()
                .is_some_and(|fault| !["before_publication", "after_publication"].contains(&fault))
            {
                return Err(StoreError::Invalid("invalid local fault".into()));
            }
            let root = std::env::var("PROSPECTUS_IDENTITY_FILES_ROOT")
                .map_err(|_| StoreError::Invalid("fixed local root required".into()))?;
            Ok((
                Arc::new(InterruptibleFiles {
                    inner: FileStore::new(root)?,
                    fault: request.fault.clone(),
                }),
                Scope::new(
                    "local",
                    std::env::var("PROSPECTUS_IDENTITY_PROJECT")
                        .unwrap_or_else(|_| "identities".into()),
                )?,
            ))
        }
        "s3" => {
            if request.fault.is_some() {
                return Err(StoreError::Invalid("local fault forbidden for S3".into()));
            }
            s3_store().await
        }
        _ => Err(StoreError::Invalid("unknown identity backend".into())),
    }
}

#[cfg(not(feature = "aws"))]
async fn s3_store() -> Result<(Arc<dyn ObjectStore>, Scope), StoreError> {
    Err(StoreError::Invalid("AWS build required".into()))
}
#[cfg(feature = "aws")]
const EXPECTED_BUCKET_OWNER_HEADER: &str = "x-amz-expected-bucket-owner";

#[cfg(feature = "aws")]
#[derive(Debug)]
struct ExpectedBucketOwnerInterceptor {
    owner: String,
}

#[cfg(feature = "aws")]
impl ExpectedBucketOwnerInterceptor {
    fn new(owner: String) -> Self {
        Self { owner }
    }
}

#[cfg(feature = "aws")]
impl aws_sdk_s3::config::Intercept for ExpectedBucketOwnerInterceptor {
    fn name(&self) -> &'static str {
        "ExpectedBucketOwnerInterceptor"
    }

    fn modify_before_signing(
        &self,
        context: &mut aws_sdk_s3::config::interceptors::BeforeTransmitInterceptorContextMut<'_>,
        _runtime_components: &aws_sdk_s3::config::RuntimeComponents,
        _config_bag: &mut aws_sdk_s3::config::ConfigBag,
    ) -> Result<(), aws_sdk_s3::error::BoxError> {
        context
            .request_mut()
            .headers_mut()
            .insert(EXPECTED_BUCKET_OWNER_HEADER, self.owner.clone());
        Ok(())
    }
}

#[cfg(feature = "aws")]
fn bucket_name_is_valid(bucket: &str) -> bool {
    (3..=63).contains(&bucket.len())
        && bucket.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'.'
        })
}

#[cfg(feature = "aws")]
fn bucket_owner_is_valid(owner: &str) -> bool {
    owner.len() == 12 && owner.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(feature = "aws")]
fn project_is_supported(project: &str) -> bool {
    ["identities", "accounts"].contains(&project)
}

#[cfg(feature = "aws")]
async fn s3_store() -> Result<(Arc<dyn ObjectStore>, Scope), StoreError> {
    use aws_sdk_s3::config::ProvideCredentials;
    let setting = |name: &str| {
        std::env::var(name)
            .map_err(|_| StoreError::Invalid("fixed S3 configuration required".into()))
    };
    if setting("PROSPECTUS_IDENTITY_S3_ENABLED")? != "true" {
        return Err(StoreError::Invalid(
            "explicit S3 enablement required".into(),
        ));
    }
    let bucket = setting("PROSPECTUS_IDENTITY_BUCKET")?;
    let region = setting("PROSPECTUS_IDENTITY_REGION")?;
    let owner = setting("PROSPECTUS_IDENTITY_EXPECTED_OWNER")?;
    let tenant = setting("PROSPECTUS_IDENTITY_TENANT")?;
    let project = setting("PROSPECTUS_IDENTITY_PROJECT")?;
    let invalid =
        |reason: &str| StoreError::Invalid(format!("invalid fixed S3 configuration: {reason}"));
    if !bucket_name_is_valid(&bucket) {
        return Err(invalid("bucket name"));
    }
    if region != "us-east-1" {
        return Err(invalid("region"));
    }
    if !bucket_owner_is_valid(&owner) {
        return Err(invalid("expected bucket owner"));
    }
    if !project_is_supported(&project) {
        return Err(invalid("project"));
    }
    let scope = Scope::new(tenant, project)?;
    let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region(aws_config::Region::new(region))
        .load()
        .await;
    let credentials = config
        .credentials_provider()
        .ok_or_else(|| StoreError::Unavailable("temporary credential provider required".into()))?
        .provide_credentials()
        .await
        .map_err(|_| StoreError::Unavailable("temporary credentials unavailable".into()))?;
    if credentials
        .session_token()
        .is_none_or(|token| token.is_empty())
    {
        return Err(StoreError::Unavailable(
            "temporary credentials required".into(),
        ));
    }
    // Fixed regional endpoint overrides profile/environment endpoint settings.
    let client = aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::config::Builder::from(&config)
            .endpoint_url("https://s3.us-east-1.amazonaws.com")
            .interceptor(ExpectedBucketOwnerInterceptor::new(owner))
            .build(),
    );
    Ok((
        Arc::new(virtuus_store::aws::S3Store::new(client, bucket)),
        scope,
    ))
}

#[tokio::main]
async fn main() {
    if std::env::var("PROSPECTUS_IDENTITY_STREAM").as_deref() == Ok("1") {
        let mut reader = std::io::BufReader::new(std::io::stdin());
        let mut configured: Option<(Arc<dyn ObjectStore>, Scope)> = None;
        for _ in 0..2048 {
            let mut bytes = Vec::new();
            if (&mut reader)
                .take(131074)
                .read_until(b'\n', &mut bytes)
                .is_err()
                || bytes.len() > 131073
            {
                println!("{}", json!({"error":"invalid"}));
                break;
            }
            if bytes.is_empty() {
                break;
            }
            let result = async {
                let request: Request = serde_json::from_slice(&bytes)?;
                validate_request(&request)?;
                if request.fault.is_some() {
                    return Err(StoreError::Invalid(
                        "fault not supported in request session".into(),
                    ));
                }
                if configured.is_none() {
                    configured = Some(observed_store(&request).await?);
                }
                let (objects, scope) = configured.as_ref().unwrap();
                dispatch_with_store(request, objects.clone(), scope.clone()).await
            }
            .await;
            let output = match result {
                Ok(value) => json!({"result":value}),
                Err(error) => error_response(error),
            };
            println!("{output}");
            if std::io::stdout().flush().is_err() {
                break;
            }
        }
        return;
    }
    let mut bytes = Vec::new();
    let output = if std::io::stdin()
        .take(131073)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > 131072
    {
        json!({"error":"invalid"})
    } else {
        match serde_json::from_slice::<Request>(&bytes) {
            Ok(request) => match dispatch(request).await {
                Ok(value) => json!({"result":value}),
                Err(error) => error_response(error),
            },
            Err(_) => json!({"error":"invalid"}),
        }
    };
    println!("{output}");
}

fn error_response(error: StoreError) -> Value {
    json!({"error":match error {StoreError::Conflict=>"conflict",StoreError::OperationMismatch=>"operation_mismatch",StoreError::Uncertain(_)=>"uncertain",StoreError::Invalid(_)=>"invalid",_=>"unavailable"}})
}

#[cfg(all(test, feature = "aws"))]
#[path = "../identity_s3_tests.rs"]
mod s3_tests;
