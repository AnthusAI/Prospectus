import { test } from "node:test";
import assert from "node:assert/strict";
import { safeReturnPath } from "../src/deep-links";
import { readLocation } from "../src/admin/Shell";
import { billingHref, billingRouteFromPath } from "../src/billing/routes";

test("each billing page has its own address that loads directly and survives sign-in", () => {
  const payment = ["5a1b2c3d", "0000", "4000", "8000", "00000000abcd"].join("-");
  const cases: Array<[string, unknown]> = [
    [
      "/invoices/202610-003",
      {
        page: "billing",
        account: null,
        issueId: null,
        billing: { kind: "invoice", reference: "202610-003" },
      },
    ],
    ["/invoices/new", { page: "billing", account: null, issueId: null, billing: { kind: "new-invoice" } }],
    [
      `/payments/${payment}`,
      { page: "billing", account: null, issueId: null, billing: { kind: "payment", id: payment } },
    ],
    ["/payments/new", { page: "billing", account: null, issueId: null, billing: { kind: "new-payment" } }],
    [
      "/accounts/acc_1-2/billing",
      {
        page: "accounts",
        account: "acc_1-2",
        issueId: null,
        billing: { kind: "account-billing", accountId: "acc_1-2" },
      },
    ],
    ["/settings/billing", { page: "settings", account: null, issueId: null, billing: { kind: "settings" } }],
  ];
  for (const [path, expected] of cases) {
    assert.deepEqual(readLocation("", path), expected, path);
    assert.equal(safeReturnPath(path), path, path);
    assert.equal(safeReturnPath(`${path}/`), `${path}/`);
  }
  assert.equal(safeReturnPath("/invoices/new?account=acc_1"), "/invoices/new?account=acc_1");
  assert.equal(billingHref.accountBilling("a b"), "/accounts/a%20b/billing");
  assert.equal(billingHref.invoice("202610-003"), "/invoices/202610-003");
  // The existing ?view= addresses keep working.
  assert.deepEqual(readLocation("?view=billing", "/"), { page: "billing", account: null, issueId: null });
  assert.deepEqual(readLocation("?view=settings", "/"), { page: "settings", account: null, issueId: null });
});

test("billing paths that do not match a strict pattern are neither routes nor return targets", () => {
  for (const bad of [
    "/invoices",
    "/invoices/",
    "/invoices/202610-3",
    "/invoices/2026100-003",
    "/invoices/202610-003/extra",
    "/invoices/new/x",
    "/payments/not-a-uuid",
    `/payments/${payment.slice(0, -1)}`,
    "/accounts//billing",
    "/accounts/a.b/billing",
    "/accounts/a/b/billing",
    "/accounts/" + "a".repeat(101) + "/billing",
    "/settings",
    "/settings/billing/x",
  ]) {
    assert.equal(billingRouteFromPath(bad.split("?")[0]), null, bad);
    assert.equal(safeReturnPath(bad), null, bad);
  }
  // Sign-in parameters never ride along on a return target.
  assert.equal(safeReturnPath("/invoices/202610-003?code=1"), null);
});
