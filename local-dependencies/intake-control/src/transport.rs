//! Bounded private control transport. Routing is checked before storage is called.
use crate::{validate_path, IntakeControls};
use serde::{Deserialize, Serialize};
use virtuus_store::{StoreError, WriteCondition};

/// Exact operation schema passed over private stdio, never from a visitor route.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlRequest {
    pub version: u8,
    pub workspace: String,
    pub operation: Operation,
    pub path: String,
    pub bytes: Option<String>,
    pub condition: Option<Condition>,
}

/// Two supported operations; there is no delete, list, IAM or user management.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Get,
    Put,
}

/// The same absent/revision preconditions as Virtuus; unconditional put is absent.
#[derive(Debug, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum Condition {
    Absent { absent: bool },
    Revision { revision: String },
}

/// Exact UTF-8 control bytes and opaque backend ETag/revision.
#[derive(Debug, Serialize)]
pub struct ControlValue {
    pub bytes: String,
    pub revision: String,
}

/// Sanitized response; underlying service diagnostics/credentials are not returned.
#[derive(Debug, Serialize)]
pub struct ControlResponse {
    pub version: u8,
    pub workspace: String,
    pub path: String,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object: Option<ControlValue>,
}

impl ControlRequest {
    /// Refuse workspace/path/schema changes before opening the credential provider.
    pub fn validate(&self, authorized_workspace: &str) -> Result<(), &'static str> {
        if self.workspace != authorized_workspace {
            return Err("unauthorized");
        }
        if self.version != 1 || validate_path(&self.path).is_err() {
            return Err("invalid");
        }
        match self.operation {
            Operation::Get => {
                if self.bytes.is_some() || self.condition.is_some() {
                    return Err("invalid");
                }
            }
            Operation::Put => {
                if !self
                    .bytes
                    .as_ref()
                    .is_some_and(|value| value.len() <= 32_768)
                {
                    return Err("invalid");
                }
                match &self.condition {
                    Some(Condition::Absent { absent: true }) => {}
                    Some(Condition::Revision { revision })
                        if !revision.is_empty() && revision.len() <= 256 => {}
                    _ => return Err("invalid"),
                }
            }
        }
        Ok(())
    }
    /// Construct a correlation-preserving response without private service messages.
    pub fn response(&self, status: &'static str) -> ControlResponse {
        ControlResponse {
            version: 1,
            workspace: self.workspace.clone(),
            path: self.path.clone(),
            status,
            object: None,
        }
    }
}

/// Dispatch into the established binding after server-selected workspace validation.
pub async fn dispatch(
    request: &ControlRequest,
    authorized_workspace: &str,
    controls: &IntakeControls,
) -> ControlResponse {
    if let Err(status) = request.validate(authorized_workspace) {
        return request.response(status);
    }
    let result = match request.operation {
        Operation::Get => controls.get_control(&request.path).await,
        Operation::Put => {
            let condition = match request.condition.as_ref().unwrap() {
                Condition::Absent { .. } => WriteCondition::Absent,
                Condition::Revision { revision } => WriteCondition::Revision(revision.clone()),
            };
            controls
                .put_control(
                    &request.path,
                    request.bytes.as_ref().unwrap().as_bytes(),
                    condition,
                )
                .await
                .map(Some)
        }
    };
    match result {
        Ok(None) => request.response("missing"),
        Ok(Some(object)) => match String::from_utf8(object.bytes) {
            Ok(bytes) => {
                let mut response = request.response("ok");
                response.object = Some(ControlValue {
                    bytes,
                    revision: object.revision,
                });
                response
            }
            Err(_) => request.response("invalid"),
        },
        Err(StoreError::Conflict) => request.response("conflict"),
        Err(StoreError::Invalid(_) | StoreError::TooLarge { .. }) => request.response("invalid"),
        Err(StoreError::Unavailable(_)) => request.response("unavailable"),
        Err(_) => request.response("uncertain"),
    }
}
