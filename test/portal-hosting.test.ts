import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PORTAL_DOMAIN, PORTAL_ORIGIN, APP_ORIGINS } from "../infra/lib/scope";

const portal = JSON.parse(readFileSync("infra/portal-app.json", "utf8"));

function verifyScope(appId: string, portalAppId: string | null) {
  const directory = mkdtempSync(join(tmpdir(), "portal-scope-"));
  try {
    mkdirSync(join(directory, "infra"));
    mkdirSync(join(directory, "amplify"));
    cpSync("amplify/verify-scope.mjs", join(directory, "amplify/verify-scope.mjs"));
    writeFileSync(
      join(directory, "infra/portal-app.json"),
      JSON.stringify({ ...portal, appId: portalAppId }),
    );
    const result = spawnSync(process.execPath, ["amplify/verify-scope.mjs"], {
      cwd: directory,
      env: {
        ...process.env,
        AWS_REGION: "us-east-1",
        AWS_APP_ID: appId,
        AWS_BRANCH: "main",
        NODE_PATH: resolve("amplify/node_modules"),
      },
      encoding: "utf8",
    });
    const environment =
      result.status === 0 ? readFileSync(join(directory, ".build/deployment.env"), "utf8") : "";
    return { status: result.status, environment };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("only the recorded portal app builds as the frontend-only portal", () => {
  assert.notEqual(verifyScope("dportal", null).status, 0, "an unrecorded app must be refused");
  assert.notEqual(verifyScope("dother", "dportal").status, 0, "an unknown app must be refused");
  const accepted = verifyScope("dportal", "dportal");
  assert.equal(accepted.status, 0);
  assert.equal(accepted.environment, "export PROSPECTUS_APP=portal\n");
});

test("the portal build deploys no backend and signs in at one.anth.us", () => {
  const build = readFileSync("amplify.yml", "utf8");
  for (const step of [
    "build-backend.sh",
    "accounts/build-deployment.ts",
    "npm run check --prefix infra",
    "ampx pipeline-deploy",
  ]) {
    const line = build.split("\n").find((entry) => entry.includes(step));
    assert.ok(line?.includes('[ "$PROSPECTUS_APP" = "prospectus" ]'), `${step} must run only for Prospectus`);
  }
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
