import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { accountsDeployment } from "./deployment";
import { ParameterStoreRateTable, rateTableConfiguration } from "../quota/rate-table";
import { QUOTA_RATE_TABLE_INITIALIZER_SOURCE } from "../infra/lib/site-subject-secret";

const PRODUCTION_PARAMETER = "/prospectus/central-accounts/quota-rate-table/v1";

test("the production deployment configures the reviewed quota rate table parameter", () => {
  assert.deepEqual(accountsDeployment()!.quotaRateTable, {
    version: "v1",
    parameterName: PRODUCTION_PARAMETER,
  });
});

test("the deployment configuration holds the parameter name and no rates, allowances or amounts", () => {
  const config = JSON.parse(readFileSync(new URL("./deployment.json", import.meta.url), "utf8"));
  assert.deepEqual(config.quotaRateTable, { version: "v1", parameterName: PRODUCTION_PARAMETER });
  assert.doesNotMatch(JSON.stringify(config.quotaRateTable), /plans|rates|allowance|units|\$/i);
});

test("a malformed quota parameter name or extra field is refused", () => {
  for (const bad of [
    { version: "v1", parameterName: "no-slash/v1" },
    { version: "v1", parameterName: "/prospectus/quota" },
    { version: "v2", parameterName: PRODUCTION_PARAMETER },
    { version: "v1", parameterName: PRODUCTION_PARAMETER, units: 1 },
    null,
  ])
    assert.throws(() => rateTableConfiguration(bad));
});

test("the placeholder the initializer writes is refused: quota is unavailable until a real table is written", async () => {
  assert.ok(
    QUOTA_RATE_TABLE_INITIALIZER_SOURCE.includes("unset"),
    "the initializer writes the refusing placeholder",
  );
  let value = '{"version":"unset"}';
  const client = { send: async () => ({ Parameter: { Value: value } }) } as never;
  const source = new ParameterStoreRateTable(
    rateTableConfiguration({ version: "v1", parameterName: PRODUCTION_PARAMETER }),
    client,
    0,
  );
  await assert.rejects(
    source.current(),
    (error: any) => error.status === 503 && error.code === "quota_unavailable",
  );
  // A synthetic table with a default plan applies to an Account that has no plan of its own.
  value = JSON.stringify({
    version: "example-1",
    defaultPlan: "example-default",
    plans: { "example-default": { weeklyAllowanceUnits: 1 } },
    rates: { "example.item": { units: 1, per: 1 } },
  });
  const table = await source.current();
  assert.equal(table.defaultPlan, "example-default");
});
