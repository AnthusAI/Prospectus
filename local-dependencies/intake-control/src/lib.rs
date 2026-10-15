//! Local reference binding for intake identity claims to the pinned Virtuus controls.
//! No HTTP route, AWS resources, credential source or public write authority is added.

use std::sync::Arc;
use virtuus_store::{ObjectStore, Result, Scope, StoreError, StoredObject, WriteCondition};
pub mod transport;

/// A trusted workspace-scoped binding exposing only intake identity/receipt controls.
#[derive(Clone)]
pub struct IntakeControls {
    objects: Arc<dyn ObjectStore>,
    scope: Scope,
}

impl IntakeControls {
    /// Bind an already-authorized object store and a server-selected workspace.
    pub fn new(objects: Arc<dyn ObjectStore>, scope: Scope) -> Self {
        Self { objects, scope }
    }

    /// Strongly read one supplemental identity claim, excluding arbitrary journals.
    pub async fn get_control(&self, path: &str) -> Result<Option<StoredObject>> {
        validate_path(path)?;
        let object = self.objects.get_control(&self.scope, path).await?;
        if object
            .as_ref()
            .is_some_and(|value| value.bytes.len() > 32_768)
        {
            return Err(StoreError::Invalid("identity claim exceeds 32 KiB".into()));
        }
        Ok(object)
    }

    /// Persist an exact frozen claim only under an absent/revision precondition.
    pub async fn put_control(
        &self,
        path: &str,
        bytes: &[u8],
        condition: WriteCondition,
    ) -> Result<StoredObject> {
        validate_path(path)?;
        if bytes.len() > 32_768 {
            return Err(StoreError::Invalid("identity claim exceeds 32 KiB".into()));
        }
        self.objects
            .put_control(&self.scope, path, bytes, condition)
            .await
    }
}

fn validate_path(path: &str) -> Result<()> {
    let key = path
        .strip_prefix("intake-identities/")
        .or_else(|| path.strip_prefix("intake-receipts/"))
        .and_then(|value| value.strip_suffix(".json"));
    if !key.is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }) {
        return Err(StoreError::Invalid(
            "only hashed intake identity and receipt controls are allowed".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use virtuus_store::FileStore;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn independent_virtuus_adapters_claim_once_and_preserve_exact_bytes_outside_exports() {
        let root = tempfile::tempdir().unwrap();
        let scope = Scope::new("test", "prospectus").unwrap();
        let path = format!("intake-identities/{}.json", "a".repeat(64));
        let barrier = Arc::new(tokio::sync::Barrier::new(4));
        let mut workers = Vec::new();
        for _ in 0..4 {
            let binding = IntakeControls::new(
                Arc::new(FileStore::new(root.path()).unwrap()),
                scope.clone(),
            );
            let barrier = barrier.clone();
            let path = path.clone();
            workers.push(tokio::spawn(async move {
                barrier.wait().await;
                binding
                    .put_control(
                        &path,
                        b"{\"immutable\":\"first intent\"}\n",
                        WriteCondition::Absent,
                    )
                    .await
            }));
        }
        let mut winners = 0;
        for worker in workers {
            match worker.await.unwrap() {
                Ok(_) => winners += 1,
                Err(StoreError::Conflict) => {}
                result => panic!("unexpected claim outcome: {result:?}"),
            }
        }
        assert_eq!(winners, 1);
        let objects = Arc::new(FileStore::new(root.path()).unwrap());
        let binding = IntakeControls::new(objects.clone(), scope.clone());
        let claim = binding.get_control(&path).await.unwrap().unwrap();
        assert_eq!(claim.bytes, b"{\"immutable\":\"first intent\"}\n");
        let receipt_path = format!("intake-receipts/{}.json", "b".repeat(64));
        binding
            .put_control(
                &receipt_path,
                b"immutable receipt fingerprint",
                WriteCondition::Absent,
            )
            .await
            .unwrap();
        assert_eq!(
            binding
                .get_control(&receipt_path)
                .await
                .unwrap()
                .unwrap()
                .bytes,
            b"immutable receipt fingerprint"
        );
        assert!(objects
            .list(&scope, "", None, 100)
            .await
            .unwrap()
            .paths
            .is_empty());
        assert!(matches!(
            binding
                .put_control(&path, b"wrong", WriteCondition::Revision("stale".into()))
                .await,
            Err(StoreError::Conflict)
        ));
        binding
            .put_control(
                &path,
                b"completed",
                WriteCondition::Revision(claim.revision),
            )
            .await
            .unwrap();
        assert_eq!(
            binding.get_control(&path).await.unwrap().unwrap().bytes,
            b"completed"
        );
    }

    #[tokio::test]
    async fn binding_refuses_journal_access_and_oversized_claims() {
        let root = tempfile::tempdir().unwrap();
        let binding = IntakeControls::new(
            Arc::new(FileStore::new(root.path()).unwrap()),
            Scope::new("test", "prospectus").unwrap(),
        );
        for path in [
            "intents/secret.json",
            "../issues/record.json",
            "intake-identities/not-a-hash.json",
        ] {
            assert!(matches!(
                binding.get_control(path).await,
                Err(StoreError::Invalid(_))
            ));
        }
        let path = format!("intake-identities/{}.json", "a".repeat(64));
        assert!(matches!(
            binding
                .put_control(&path, &vec![0; 32_769], WriteCondition::Absent)
                .await,
            Err(StoreError::Invalid(_))
        ));
    }
}
