import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { billingPlans, productFamily, reviewedBillingPlans } from "./plans";
import { papyrusSiteRegistrations } from "../accounts/papyrus-sites";

const committed = () =>
  JSON.parse(readFileSync(new URL("../accounts/billing-plans.json", import.meta.url), "utf8"));
const plan = (overrides: Record<string, unknown> = {}) => ({
  amountCents: 100,
  displayName: "Placeholder plan",
  family: "papyrus",
  interval: "month",
  planId: "papyrus-site-monthly",
  stripePriceIds: { live: null, test: "price_test_placeholder_one" },
  ...overrides,
});

test("the committed catalog is valid and holds test-mode placeholder prices only", () => {
  const plans = reviewedBillingPlans();
  assert.ok(plans.size >= 2);
  assert.ok(plans.has("papyrus-site-monthly"));
  assert.ok(plans.has("cyclotron-lab-monthly"));
  for (const entry of plans.values()) {
    assert.match(entry.stripePriceIds.test, /^price_test_placeholder_/);
    assert.equal(entry.stripePriceIds.live, null);
    assert.ok(Number.isSafeInteger(entry.amountCents));
    assert.match(entry.displayName, /^Placeholder /);
  }
});

test("an unknown field stops the catalog", () => {
  assert.throws(() => billingPlans([plan({ currency: "usd" })]), /exactly the reviewed fields/);
  assert.throws(
    () => billingPlans([plan({ stripePriceIds: { test: "price_a", live: null, sandbox: "price_b" } })]),
    /exactly the test and live modes/,
  );
});

test("a duplicate plan ID stops the catalog", () => {
  assert.throws(
    () => billingPlans([plan(), plan({ stripePriceIds: { live: null, test: "price_test_other" } })]),
    /its own plan ID/,
  );
});

test("one price ID shared by two plans stops the catalog, across modes too", () => {
  assert.throws(
    () => billingPlans([plan(), plan({ planId: "papyrus-site-other" })]),
    /only one billing plan/,
  );
  assert.throws(
    () =>
      billingPlans([
        plan(),
        plan({
          planId: "papyrus-site-other",
          stripePriceIds: { test: "price_test_b", live: "price_test_placeholder_one" },
        }),
      ]),
    /only one billing plan/,
  );
});

test("amounts are whole cents and families and intervals are reviewed values", () => {
  assert.throws(() => billingPlans([plan({ amountCents: 1.5 })]), /whole number of cents/);
  assert.throws(() => billingPlans([plan({ amountCents: "100" })]), /whole number of cents/);
  assert.throws(() => billingPlans([plan({ family: "papyrus-site" })]), /papyrus or cyclotron-lab/);
  assert.throws(() => billingPlans([plan({ interval: "week" })]), /month or year/);
  assert.throws(
    () => billingPlans([plan({ stripePriceIds: { test: null, live: null } })]),
    /test-mode price ID/,
  );
  assert.throws(() => billingPlans({}), /array of plans/);
  assert.throws(() => billingPlans([plan({ planId: "Papyrus" })]), /plan ID/);
});

test("Papyrus plans use the papyrus family; product display names stay with site metadata", () => {
  for (const site of papyrusSiteRegistrations(
    JSON.parse(readFileSync(new URL("../accounts/papyrus-sites.json", import.meta.url), "utf8")),
  ))
    assert.equal(productFamily(site.product), "papyrus");
  assert.equal(productFamily("cyclotron"), "cyclotron-lab");
  assert.equal(productFamily("anthus-one"), undefined);
  for (const entry of committed()) assert.ok(!("product" in entry) && !("productName" in entry));
});
