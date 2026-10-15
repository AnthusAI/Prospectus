//! One-request private stdio bridge. This is not an HTTP or Lambda intake endpoint.
use prospectus_intake_control_binding::{
    transport::{dispatch, ControlRequest},
    IntakeControls,
};
use std::{
    io::{Read, Write},
    sync::Arc,
};
use virtuus_store::{aws::S3Store, Scope};

#[tokio::main]
async fn main() {
    if run().await.is_err() {
        eprintln!("Scoped S3 control bridge could not complete the request.");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = std::env::var("PROSPECTUS_CONTROL_WORKSPACE")?;
    let (tenant, project) = workspace
        .split_once('/')
        .ok_or("A fixed workspace is required")?;
    let scope = Scope::new(tenant, project)?;
    let mut bytes = Vec::new();
    std::io::stdin().take(65_537).read_to_end(&mut bytes)?;
    if bytes.len() > 65_536 {
        return Err("Control transport exceeds 64 KiB".into());
    }
    let request: ControlRequest = serde_json::from_slice(&bytes)?;
    if let Err(status) = request.validate(&workspace) {
        serde_json::to_writer(std::io::stdout(), &request.response(status))?;
        return Ok(());
    }
    if std::env::var("PROSPECTUS_CONTROL_S3_ENABLED")?.as_str() != "true" {
        return Err("S3 control transport is not explicitly enabled".into());
    }
    let bucket = std::env::var("PROSPECTUS_CONTROL_BUCKET")?;
    let region = std::env::var("PROSPECTUS_CONTROL_REGION")?;
    if bucket.is_empty() || region.is_empty() {
        return Err("A fixed bucket and region are required".into());
    }
    // Existing server credential chain only; no profile/resource or permission writes.
    let configuration = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region(aws_config::Region::new(region))
        .load()
        .await;
    let controls = IntakeControls::new(
        Arc::new(S3Store::new(
            aws_sdk_s3::Client::new(&configuration),
            bucket,
        )),
        scope,
    );
    let response = dispatch(&request, &workspace, &controls).await;
    serde_json::to_writer(std::io::stdout(), &response)?;
    std::io::stdout().flush()?;
    Ok(())
}
