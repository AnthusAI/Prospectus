import { test } from "node:test";
import assert from "node:assert/strict";
import { issueIdFromPath, issuePath, issueUrl, safeReturnPath } from "../src/deep-links";
import { pageHref, readLocation } from "../src/admin/Shell";

test("an issue address round-trips and opens the pipeline", () => {
  assert.equal(issuePath("prsp-2241529c"), "/pipeline/prsp-2241529c");
  assert.equal(
    issueUrl("prsp-2241529c", "https://prospectus.anth.us"),
    "https://prospectus.anth.us/pipeline/prsp-2241529c",
  );
  assert.equal(issueIdFromPath("/pipeline/prsp-2241529c"), "prsp-2241529c");
  assert.equal(issueIdFromPath("/pipeline/prsp-2241529c/"), "prsp-2241529c");
  assert.deepEqual(readLocation("", "/pipeline/prsp-2241529c"), {
    page: "pipeline",
    account: null,
    issueId: "prsp-2241529c",
  });
  assert.deepEqual(readLocation("?view=accounts&account=a1", "/"), {
    page: "accounts",
    account: "a1",
    issueId: null,
  });
  assert.deepEqual(readLocation("", "/"), { page: "today", account: null, issueId: null });
  assert.equal(pageHref("pipeline"), "/?view=pipeline");
});

test("paths that are not a single issue ID are not issue addresses", () => {
  for (const path of [
    "/pipeline",
    "/pipeline/",
    "/pipeline/a/b",
    "/pipeline/a.b",
    "/pipeline/%2e%2e",
    "/other/prsp-1",
    "/pipeline/<x>",
  ])
    assert.equal(issueIdFromPath(path), null, path);
});

test("only internal application paths are accepted as sign-in return targets", () => {
  assert.equal(safeReturnPath("/pipeline/prsp-2241529c"), "/pipeline/prsp-2241529c");
  assert.equal(safeReturnPath("/?view=pipeline"), "/?view=pipeline");
  assert.equal(safeReturnPath("/"), "/");
  for (const bad of [
    "https://evil.example.com/pipeline/x",
    "//evil.example.com",
    "/\\evil.example.com",
    "\\\\evil.example.com",
    "javascript:alert(1)",
    "pipeline/prsp-1",
    "/auth/callback",
    "/auth/callback?code=1",
    "/pipeline/prsp-1?code=abc",
    "/?error=access_denied",
    "/anything-else",
    "/pipeline/prsp-1\n",
    "/pipeline/" + "a".repeat(400),
    "",
    null,
    undefined,
    42,
  ])
    assert.equal(safeReturnPath(bad), null, String(bad));
});
