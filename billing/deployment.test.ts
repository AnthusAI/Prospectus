import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { billingDeployment, consoleBillingDefine } from "./deployment";
import { accountsDeployment } from "../accounts/deployment";
import viteConfig from "../vite.config";

const committed = JSON.parse(readFileSync(new URL("./deployment.json", import.meta.url), "utf8"));

test("the committed flag is on by Ryan's approval, and the infrastructure and console builds follow it", () => {
  assert.deepEqual(committed, { ledger: { enabled: true } });
  assert.equal(accountsDeployment()!.billingLedger, true, "the infrastructure options carry it");
  assert.deepEqual((viteConfig as any).define, { "import.meta.env.VITE_BILLING_ROUTES": '"1"' });
});

test("the console define follows the flag, and an environment value cannot turn billing on by itself", () => {
  assert.deepEqual(consoleBillingDefine(billingDeployment({ ledger: { enabled: true } })), {
    "import.meta.env.VITE_BILLING_ROUTES": '"1"',
  });
  assert.deepEqual(consoleBillingDefine(billingDeployment({ ledger: { enabled: false } })), {
    "import.meta.env.VITE_BILLING_ROUTES": "undefined",
  });
});
