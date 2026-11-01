use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};
fn call(root: &std::path::Path, project: &str, request: Value) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_prospectus-identity-files"))
        .env_clear()
        .env("PROSPECTUS_IDENTITY_FILES_ROOT", root)
        .env("PROSPECTUS_IDENTITY_PROJECT", project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
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
fn commit(path: &str) -> Value {
    json!({"action":"commit","path":path,"operation_id":format!("op:{path}"),"request_hash":"h","value":{"v":1},"revision":null})
}
const ACCOUNT: &str = "00000000-0000-4000-8000-000000000001";
#[test]
fn billing_project_accepts_only_its_own_kinds_and_canonical_segments() {
    let root = tempfile::tempdir().unwrap();
    for path in [
        format!("profiles/{ACCOUNT}.json"),
        format!("lines/{ACCOUNT}/7061707972757300.json"),
        format!("journal/{}.json", "a".repeat(64)),
    ] {
        assert_eq!(
            call(root.path(), "billing", commit(&path))["result"]["value"]["v"],
            1
        );
        assert_eq!(
            call(root.path(), "billing", json!({"action":"get","path":path}))["result"]["value"]
                ["v"],
            1
        );
    }
    assert_eq!(
        call(
            root.path(),
            "billing",
            json!({"action":"list","path":format!("lines/{ACCOUNT}/"),"cursor":null})
        )["result"]["paths"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    for path in [
        format!("accounts/{ACCOUNT}.json"),
        format!("lines/{ACCOUNT}/papyrus-site.json"),
        "invoices/0a.json".to_owned(),
    ] {
        assert_eq!(
            call(root.path(), "billing", commit(&path))["error"],
            "invalid"
        );
    }
    assert_eq!(
        call(
            root.path(),
            "accounts",
            commit(&format!("profiles/{ACCOUNT}.json"))
        )["error"],
        "invalid"
    );
    assert_eq!(
        call(
            root.path(),
            "invoicing",
            commit(&format!("profiles/{ACCOUNT}.json"))
        )["error"],
        "invalid"
    );
}
