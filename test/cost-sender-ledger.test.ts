import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageSender, usageQueueUrl } from "../packages/cost-accounting/src/usage";
import { CostLedger, utcDay } from "../quota/costs";
import { quotaFixture } from "../quota/testing/quota-fixture";

// The sender's message is exactly what the ledger accepts, so the two sides cannot drift apart.
test("a message from the usage sender is recorded by the cost ledger", async () => {
  const fixture = quotaFixture();
  fixture.entitlements[fixture.accountId]["papyrus-example"] = { status: "active" };
  (fixture.table.table as any).rates["openai.tokens.input"] = { units: 2, per: 1 };
  const now = () => new Date(fixture.clock.ms).toISOString();
  const ledger = new CostLedger(
    fixture.store,
    async (id) =>
      fixture.entitlements[id] ? { entitlements: structuredClone(fixture.entitlements[id]) } : null,
    fixture.quota,
    fixture.table,
    now,
  );
  const bodies: string[] = [];
  const sender = new UsageSender({
    product: "papyrus-example",
    app: "papyrus",
    deployment: "example",
    queueUrl: usageQueueUrl("papyrus-example", "111122223333"),
    now: () => fixture.clock.ms,
    send: async (_url, body) => void bodies.push(body),
  });
  sender.record(fixture.accountId, [{ itemKind: "openai.tokens.input", quantity: 250 }]);
  await sender.flush();
  assert.equal(bodies.length, 1);
  await ledger.recordUsage("papyrus-example", JSON.parse(bodies[0]));
  const day = await ledger.day(fixture.accountId, utcDay(fixture.clock.ms));
  assert.equal(day?.entries["papyrus|example|openai.tokens.input"].estimatedMicros, 500);
});
