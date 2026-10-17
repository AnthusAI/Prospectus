import { Code } from "aws-cdk-lib/aws-lambda";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { accountsDeployment } from "../accounts/deployment";
import { createProspectusBackend } from "./create-backend";
const evaluation = JSON.parse(readFileSync(resolve("evaluation-deployment.json"), "utf8"));
const intakeContactMode = evaluation.mode === "real-contacts" ? "real-contacts" : "synthetic-only";
if (evaluation.mode !== intakeContactMode)
  throw new Error(`Unknown evaluation-deployment.json mode ${evaluation.mode}`);
const artifact = resolve(".artifacts/backend/bootstrap.zip");
if (!existsSync(artifact))
  throw new Error("Build the reviewed source-locked Rust Lambda before Amplify deployment");
const intakeArtifact = resolve(".artifacts/intake-evaluation");
if (evaluation.enabled && !existsSync(resolve(intakeArtifact, "prospectus-s3-controls")))
  throw new Error("Build the reviewed evaluation runtime before enabling intake");
const accounts = accountsDeployment();
if (
  accounts &&
  ![
    ".artifacts/canonical-accounts/index.js",
    ".artifacts/canonical-accounts/identity-files",
    ".artifacts/accounts-bff/index.js",
  ].every((path) => existsSync(resolve(path)))
)
  throw new Error("Build and verify the reviewed Linux Accounts assets before Amplify deployment");
createProspectusBackend(
  () => Code.fromAsset(artifact),
  evaluation.enabled ? () => Code.fromAsset(intakeArtifact) : undefined,
  accounts
    ? {
        ...accounts,
        code: Code.fromAsset(resolve(".artifacts/canonical-accounts")),
        bffCode: Code.fromAsset(resolve(".artifacts/accounts-bff")),
      }
    : undefined,
  intakeContactMode,
);
