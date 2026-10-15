//! Private identity-file bridge using pinned Virtuus conditional journals.
//! Filesystem by default; explicit AWS feature/configuration enables S3. No HTTP route.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, io::Read, sync::Arc};
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

/// Test-only interruption inside the real journal's canonical publication call.
/// This executable has only a local FileStore; no cloud fault switch is added.
struct InterruptibleFiles {
    inner: FileStore,
    fault: Option<String>,
}
#[async_trait::async_trait]
impl ObjectStore for InterruptibleFiles {
    async fn get(&self, s: &Scope, p: &str) -> virtuus_store::Result<Option<StoredObject>> {
        self.inner.get(s, p).await
    }
    async fn get_bounded(
        &self,
        s: &Scope,
        p: &str,
        n: usize,
    ) -> virtuus_store::Result<Option<StoredObject>> {
        self.inner.get_bounded(s, p, n).await
    }
    async fn list(
        &self,
        s: &Scope,
        p: &str,
        c: Option<&str>,
        n: usize,
    ) -> virtuus_store::Result<ObjectPage> {
        self.inner.list(s, p, c, n).await
    }
    async fn put(
        &self,
        s: &Scope,
        p: &str,
        b: &[u8],
        t: &str,
        c: WriteCondition,
        o: Option<&str>,
    ) -> virtuus_store::Result<StoredObject> {
        if self.fault.as_deref() == Some("before_publication") {
            std::process::exit(86);
        }
        let stored = self.inner.put(s, p, b, t, c, o).await?;
        if self.fault.as_deref() == Some("after_publication") {
            std::process::exit(86);
        }
        Ok(stored)
    }
    async fn delete(&self, s: &Scope, p: &str, r: &str) -> virtuus_store::Result<()> {
        self.inner.delete(s, p, r).await
    }
    async fn get_control(&self, s: &Scope, p: &str) -> virtuus_store::Result<Option<StoredObject>> {
        self.inner.get_control(s, p).await
    }
    async fn put_control(
        &self,
        s: &Scope,
        p: &str,
        b: &[u8],
        c: WriteCondition,
    ) -> virtuus_store::Result<StoredObject> {
        self.inner.put_control(s, p, b, c).await
    }
}

fn valid_path(path: &str, prefix: bool, project: &str) -> bool {
    let Some((kind, rest)) = path.split_once('/') else {
        return false;
    };
    if (project == "accounts" && kind != "accounts")
        || (project == "identities"
            && !["google", "aliases", "people", "logins", "sessions"].contains(&kind))
    {
        return false;
    }
    if prefix && rest.is_empty() {
        return true;
    }
    rest.split('/').filter(|part| !part.is_empty()).all(|part| {
        let segment = part.strip_suffix(".json").unwrap_or(part);
        !segment.is_empty()
            && segment.len() <= 128
            && segment.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
    }) && !rest.contains("//")
        && (prefix || rest.ends_with(".json"))
}

async fn dispatch(request: Request) -> Result<Value, StoreError> {
    let project =
        std::env::var("PROSPECTUS_IDENTITY_PROJECT").unwrap_or_else(|_| "identities".into());
    if !["identities", "accounts"].contains(&project.as_str())
        || !valid_path(&request.path, request.action == "list", &project)
    {
        return Err(StoreError::Invalid("identity path required".into()));
    }
    let (objects, scope) = configured_store(&request).await?;
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
    if bucket.len() < 3
        || bucket.len() > 63
        || !bucket
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
        || region != "us-east-1"
        || owner.len() != 12
        || !owner.bytes().all(|b| b.is_ascii_digit())
        || !["identities", "accounts"].contains(&project.as_str())
    {
        return Err(StoreError::Invalid("invalid fixed S3 configuration".into()));
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
            .build(),
    );
    client
        .head_bucket()
        .bucket(&bucket)
        .expected_bucket_owner(owner)
        .send()
        .await
        .map_err(|_| StoreError::Unavailable("expected private bucket unavailable".into()))?;
    Ok((
        Arc::new(virtuus_store::aws::S3Store::new(client, bucket)),
        scope,
    ))
}

#[tokio::main]
async fn main() {
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
                Err(error) => {
                    json!({"error":match error {StoreError::Conflict=>"conflict",StoreError::OperationMismatch=>"operation_mismatch",StoreError::Uncertain(_)=>"uncertain",StoreError::Invalid(_)=>"invalid",_=>"unavailable"}})
                }
            },
            Err(_) => json!({"error":"invalid"}),
        }
    };
    println!("{output}");
}

#[cfg(all(test, feature = "aws"))]
#[path = "../identity_s3_tests.rs"]
mod s3_tests;
