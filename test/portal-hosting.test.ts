import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PORTAL_DOMAIN, PORTAL_ORIGIN, APP_ORIGINS } from "../infra/lib/scope";

const portal = JSON.parse(readFileSync("infra/portal-app.json", "utf8"));
const pipeline = readFileSync("amplify.yml", "utf8");
const lines = pipeline.split("\n").map((line) => line.trim());

test("the portal is not a second Amplify app: one app, one scope, no portal branches", () => {
  assert.equal("appId" in portal, false);
  assert.equal("branch" in portal, false);
  assert.ok(!existsSync("infra/portal-hosting-settings.json"));
  for (const text of [pipeline, readFileSync("amplify/verify-scope.mjs", "utf8")]) {
    assert.ok(!text.includes("PROSPECTUS_APP"));
    assert.ok(!text.includes("portal-app.json"));
  }
  assert.match(readFileSync("amplify/verify-scope.mjs", "utf8"), /AWS_APP_ID !== "d15sc1sptohtqb"/);
});

test("the CRM frontend build is exactly the plain CRM build", () => {
  const frontend = pipeline.slice(pipeline.indexOf("frontend:"));
  assert.ok(frontend.includes("- node infra/scripts/write-frontend-env.mjs\n"));
  assert.ok(frontend.includes("- npm run build\n"));
  assert.ok(!frontend.includes("portal"));
  assert.ok(!frontend.includes("write-portal-env"));
});

test("the portal bundle is built and published inside the same pipeline-deploy", () => {
  const build = lines.indexOf("- node infra/scripts/build-portal-if-enabled.mjs");
  const deploy = lines.findIndex((line) => line.includes("ampx pipeline-deploy"));
  assert.ok(build > lines.indexOf("- npm test"), "built after the tests that gate the deployment");
  assert.ok(build < deploy, "built before CDK synthesizes the BucketDeployment sources");
  assert.equal(lines.filter((line) => line.includes("ampx pipeline-deploy")).length, 1);
  assert.match(readFileSync("amplify/backend.ts", "utf8"), /portalHostingDeployment\(\)/);
  assert.match(readFileSync("amplify/create-backend.ts", "utf8"), /portal,\n\s*\);/);
});

test("hosting is dark by default and the flag file holds only the flag", () => {
  assert.deepEqual(JSON.parse(readFileSync("infra/portal-hosting.json", "utf8")), { enabled: false });
});

test("a disabled build skips the portal build and leaves environment files alone", () => {
  const directory = mkdtempSync(join(tmpdir(), "portal-build-"));
  try {
    mkdirSync(join(directory, "infra"));
    cpSync("infra/portal-hosting.json", join(directory, "infra/portal-hosting.json"));
    const result = spawnSync(process.execPath, [resolve("infra/scripts/build-portal-if-enabled.mjs")], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not enabled/);
    assert.ok(!existsSync(join(directory, "dist-portal")));
    assert.ok(!existsSync(join(directory, ".env.portal.local")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the portal's public settings are written for one.anth.us", () => {
  assert.equal(portal.domain, PORTAL_DOMAIN);
  assert.ok(APP_ORIGINS.includes(PORTAL_ORIGIN as (typeof APP_ORIGINS)[number]));
  const directory = mkdtempSync(join(tmpdir(), "portal-env-"));
  try {
    mkdirSync(join(directory, "infra"));
    cpSync("infra/portal-app.json", join(directory, "infra/portal-app.json"));
    const result = spawnSync(process.execPath, [resolve("infra/scripts/write-portal-env.mjs")], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const environment = readFileSync(join(directory, ".env.production.local"), "utf8");
    assert.match(environment, /VITE_COGNITO_REDIRECT_URI="https:\/\/one\.anth\.us\/auth\/callback"/);
    assert.match(environment, /VITE_COGNITO_LOGOUT_URI="https:\/\/one\.anth\.us\/"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
