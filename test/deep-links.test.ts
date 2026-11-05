import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PAGE_PATHS,
  accountPath,
  issueIdFromPath,
  issuePath,
  issueUrl,
  legacyLocation,
  opensElsewhere,
  pathFor,
  routeFromPath,
  safeReturnPath,
} from "../src/deep-links";
import { pageHref, readLocation } from "../src/admin/Shell";

const ACCOUNT = "acct-synthetic-1";

test("an issue address round-trips and opens the lead page", () => {
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
});

test("every console page has a path that loads directly", () => {
  assert.deepEqual(PAGE_PATHS, {
    today: "/today",
    pipeline: "/pipeline",
    accounts: "/accounts",
    engagements: "/engagements",
    billing: "/billing",
    team: "/team",
    settings: "/settings",
  });
  for (const [page, path] of Object.entries(PAGE_PATHS)) {
    assert.deepEqual(readLocation("", path), { page, account: null, issueId: null }, path);
    assert.deepEqual(readLocation("", `${path}/`), { page, account: null, issueId: null }, `${path}/`);
    assert.equal(pageHref(page as keyof typeof PAGE_PATHS), path);
  }
});

test("an account has its own path", () => {
  assert.equal(accountPath(ACCOUNT), `/accounts/${ACCOUNT}`);
  assert.equal(pageHref("accounts", ACCOUNT), `/accounts/${ACCOUNT}`);
  assert.deepEqual(readLocation("", `/accounts/${ACCOUNT}`), {
    page: "accounts",
    account: ACCOUNT,
    issueId: null,
  });
  assert.equal(pathFor({ page: "accounts", account: ACCOUNT, issueId: null }), `/accounts/${ACCOUNT}`);
  assert.equal(pathFor({ page: "pipeline", account: null, issueId: "prsp-1" }), "/pipeline/prsp-1");
  assert.equal(pathFor({ page: "today", account: null, issueId: null }), "/today");
});

test("older ?view= links resolve to the same locations and unknown paths fall back to Today", () => {
  assert.deepEqual(readLocation("?view=accounts&account=a1", "/"), {
    page: "accounts",
    account: "a1",
    issueId: null,
  });
  assert.deepEqual(readLocation("?view=pipeline", "/"), { page: "pipeline", account: null, issueId: null });
  assert.deepEqual(readLocation("?view=followups", "/"), { page: "today", account: null, issueId: null });
  assert.deepEqual(readLocation("?view=customers", "/"), { page: "pipeline", account: null, issueId: null });
  assert.deepEqual(readLocation("?view=billing", "/"), { page: "billing", account: null, issueId: null });
  assert.deepEqual(readLocation("", "/"), { page: "today", account: null, issueId: null });
  assert.deepEqual(readLocation("?view=nonsense", "/"), { page: "today", account: null, issueId: null });
  // An account is only kept for the accounts page, and only when it is a plain identifier.
  assert.equal(legacyLocation("?view=pipeline&account=a1").account, null);
  assert.equal(legacyLocation("?view=accounts&account=%3Cscript%3E").account, null);
  // A path the console does not route ignores a ?view= query.
  assert.deepEqual(readLocation("?view=accounts", "/nowhere"), {
    page: "today",
    account: null,
    issueId: null,
  });
});

test("paths that are not a page or one item are not routes", () => {
  for (const path of [
    "/pipeline/a/b",
    "/pipeline/a.b",
    "/pipeline/%2e%2e",
    "/other/prsp-1",
    "/pipeline/<x>",
    "/accounts/a/b",
    "/accounts/a.b",
    "/accounts/%2e%2e",
    "/today/x",
    "/settings/x",
    "/engagements/x",
    "/team/x",
    "/billing/x",
    "/Today",
    "/pipeline//",
    `/pipeline/${"a".repeat(101)}`,
    "/",
    "",
  ])
    assert.equal(routeFromPath(path), null, path);
  for (const path of ["/pipeline", "/pipeline/", "/accounts", "/accounts/"])
    assert.equal(issueIdFromPath(path), null, path);
});

test("a longer path is never taken for a shorter route, so later routes can be added beside these", () => {
  // /accounts/<id>/billing, /settings/billing and the like must not resolve to an account or a settings page.
  for (const path of [
    `/accounts/${ACCOUNT}/billing`,
    "/settings/billing",
    "/invoices/INV-1",
    "/payments/new",
  ])
    assert.equal(routeFromPath(path), null, path);
});

test("modified and non-primary clicks are left to the browser", () => {
  const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  assert.equal(opensElsewhere(plain), false);
  assert.equal(opensElsewhere({ ...plain, metaKey: true }), true);
  assert.equal(opensElsewhere({ ...plain, ctrlKey: true }), true);
  assert.equal(opensElsewhere({ ...plain, shiftKey: true }), true);
  assert.equal(opensElsewhere({ ...plain, altKey: true }), true);
  assert.equal(opensElsewhere({ ...plain, button: 1 }), true);
});

test("only known console paths are accepted as sign-in return targets", () => {
  assert.equal(safeReturnPath("/pipeline/prsp-2241529c"), "/pipeline/prsp-2241529c");
  assert.equal(safeReturnPath("/pipeline/prsp-2241529c/"), "/pipeline/prsp-2241529c");
  assert.equal(safeReturnPath(`/accounts/${ACCOUNT}`), `/accounts/${ACCOUNT}`);
  for (const path of Object.values(PAGE_PATHS)) assert.equal(safeReturnPath(path), path, path);
  assert.equal(safeReturnPath("/"), "/");
  // Older links are still accepted, in their strict form only.
  assert.equal(safeReturnPath("/?view=pipeline"), "/?view=pipeline");
  assert.equal(safeReturnPath(`/?view=accounts&account=${ACCOUNT}`), `/?view=accounts&account=${ACCOUNT}`);
  assert.equal(safeReturnPath("/?view=pipeline&extra=1"), "/");
  assert.equal(safeReturnPath("/?view=pipeline&account=%3Cx%3E"), "/");
  // A query on a console path is dropped rather than carried through sign-in.
  assert.equal(safeReturnPath("/pipeline?search=anything"), "/pipeline");
  assert.equal(safeReturnPath("/pipeline/prsp-1?utm_source=email"), "/pipeline/prsp-1");
  for (const bad of [
    "https://evil.example.com/pipeline/x",
    "//evil.example.com",
    "//evil.example.com/pipeline",
    "/\\evil.example.com",
    "\\\\evil.example.com",
    "/pipeline/..%2f..%2fevil",
    "/pipeline/%2e%2e/evil",
    "/accounts/../evil",
    "/accounts/a%2fb",
    "/accounts/a/b",
    "/pipeline/user@host",
    "javascript:alert(1)",
    "pipeline/prsp-1",
    "/auth/callback",
    "/auth/callback?code=1",
    "/pipeline/prsp-1?code=abc",
    "/accounts/a1?state=abc",
    "/today?error=access_denied",
    "/?error=access_denied",
    "/?code=1",
    "/anything-else",
    "/api/issues",
    "/pipeline/prsp-1\n",
    "/pipeline/prsp-1\t",
    "/pipeline/" + "a".repeat(400),
    "/pipeline/" + "a".repeat(101),
    "",
    null,
    undefined,
    42,
    {},
  ])
    assert.equal(safeReturnPath(bad), null, String(bad));
});

test("the hosting rewrite serves every console path as the application and leaves assets alone", () => {
  const { customRules } = JSON.parse(readFileSync("infra/hosting-settings.json", "utf8"));
  const rule = customRules.find((candidate: { target: string }) => candidate.target === "/index.html");
  assert.equal(rule.status, "200");
  const pattern = new RegExp(rule.source.slice(2, -2));
  for (const path of [...Object.values(PAGE_PATHS), `/accounts/${ACCOUNT}`, "/pipeline/prsp-2241529c"])
    assert.ok(pattern.test(path), path);
  for (const asset of ["/assets/index-abc123.js", "/assets/index-abc123.css", "/favicon.ico"])
    assert.ok(!pattern.test(asset), asset);
});
