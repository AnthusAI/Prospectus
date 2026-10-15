use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};
fn call(settings: &[(&str, &str)], fault: bool) -> Value {
    let mut command = Command::new(env!("CARGO_BIN_EXE_prospectus-identity-files"));
    command.env_clear().env("PROSPECTUS_IDENTITY_BACKEND", "s3");
    for (key, value) in settings {
        command.env(key, value);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut request = json!({"action":"get","path":format!("google/{}.json","a".repeat(64))});
    if fault {
        request["fault"] = json!("after_publication");
    }
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&request).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn invalid_s3_configuration_and_local_fault_fail_before_credential_loading() {
    assert_eq!(call(&[], false)["error"], "invalid");
    assert_eq!(call(&[], true)["error"], "invalid");
    assert_eq!(
        call(
            &[
                ("PROSPECTUS_IDENTITY_S3_ENABLED", "true"),
                ("PROSPECTUS_IDENTITY_BUCKET", "fixture-bucket"),
                ("PROSPECTUS_IDENTITY_REGION", "wrong"),
                ("PROSPECTUS_IDENTITY_EXPECTED_OWNER", "111111111111"),
                ("PROSPECTUS_IDENTITY_TENANT", "synthetic"),
                ("PROSPECTUS_IDENTITY_PROJECT", "identities")
            ],
            false
        )["error"],
        "invalid"
    );
}
#[cfg(feature = "aws")]
#[test]
fn long_lived_static_credentials_are_refused_before_s3_network_access() {
    assert_eq!(
        call(
            &[
                ("PROSPECTUS_IDENTITY_S3_ENABLED", "true"),
                ("PROSPECTUS_IDENTITY_BUCKET", "fixture-bucket"),
                ("PROSPECTUS_IDENTITY_REGION", "us-east-1"),
                ("PROSPECTUS_IDENTITY_EXPECTED_OWNER", "111111111111"),
                ("PROSPECTUS_IDENTITY_TENANT", "synthetic"),
                ("PROSPECTUS_IDENTITY_PROJECT", "identities"),
                ("AWS_ACCESS_KEY_ID", "synthetic-only"),
                ("AWS_SECRET_ACCESS_KEY", "synthetic-only"),
                ("AWS_EC2_METADATA_DISABLED", "true")
            ],
            false
        )["error"],
        "unavailable"
    );
}
