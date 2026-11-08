import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { QuotaError } from "./model";
import { drainUsage, usageQueues, type UsageQueueClient } from "./usage-drain";

// features/cost-usage-queue.feature
const URL_A = "https://sqs.us-east-1.amazonaws.com/111122223333/prospectus-usage-papyrus-example";
const URL_B = "https://sqs.us-east-1.amazonaws.com/111122223333/prospectus-usage-cyclotron";

class FakeQueues implements UsageQueueClient {
  queues: Record<string, Array<{ body: string; receiptHandle: string }>> = { [URL_A]: [], [URL_B]: [] };
  deleted: string[] = [];
  released: string[] = [];
  receives = 0;
  push(url: string, body: unknown) {
    this.queues[url].push({
      body: typeof body === "string" ? body : JSON.stringify(body),
      receiptHandle: randomUUID(),
    });
  }
  async receive(url: string, maximum: number) {
    this.receives++;
    return this.queues[url].splice(0, maximum);
  }
  async delete(_url: string, handle: string) {
    this.deleted.push(handle);
  }
  async release(_url: string, handle: string) {
    this.released.push(handle);
  }
}

test("recorded messages are deleted, and the product comes from the queue", async () => {
  const client = new FakeQueues();
  client.push(URL_A, { app: "papyrus" });
  client.push(URL_B, { app: "cyclotron" });
  const seen: Array<[string, unknown]> = [];
  const counts = await drainUsage({
    client,
    queues: { "papyrus-example": URL_A, cyclotron: URL_B },
    ledger: {
      recordUsage: async (product, body) => (seen.push([product, body]), { result: {}, replayed: false }),
    },
  });
  assert.deepEqual(counts, { recorded: 2, refused: 0, deferred: 0 });
  assert.deepEqual(seen, [
    ["papyrus-example", { app: "papyrus" }],
    ["cyclotron", { app: "cyclotron" }],
  ]);
  assert.equal(client.deleted.length, 2);
});

test("permanent refusals are released toward the dead-letter queue; passing failures are left to retry", async () => {
  const client = new FakeQueues();
  client.push(URL_A, "not json");
  client.push(URL_A, { refuse: "wrong_product" });
  client.push(URL_A, { refuse: "quota_unavailable" });
  client.push(URL_A, { refuse: "busy" });
  const logs: Array<Record<string, unknown>> = [];
  const counts = await drainUsage({
    client,
    queues: { "papyrus-example": URL_A },
    log: (entry) => logs.push(entry),
    ledger: {
      recordUsage: async (_product, body: any) => {
        const status = body.refuse === "wrong_product" ? 403 : body.refuse === "busy" ? 409 : 503;
        throw new QuotaError(status, body.refuse, "refused");
      },
    },
  });
  assert.deepEqual(counts, { recorded: 0, refused: 2, deferred: 2 });
  assert.equal(client.released.length, 2);
  assert.equal(client.deleted.length, 0);
  assert.ok(
    logs.every((entry) => !("body" in entry)),
    "logs never carry a message body",
  );
  assert.ok(logs.some((entry) => entry.reason === "invalid_json"));
});

test("runs are bounded per queue and stop when time runs out", async () => {
  const client = new FakeQueues();
  for (let index = 0; index < 100; index++) client.push(URL_A, {});
  const ledger = { recordUsage: async () => ({ result: {}, replayed: false }) };
  const first = await drainUsage({ client, queues: { "papyrus-example": URL_A }, ledger, maximumBatches: 3 });
  assert.equal(first.recorded, 30);
  let calls = 0;
  const second = await drainUsage({
    client,
    queues: { "papyrus-example": URL_A },
    ledger,
    hasTime: () => calls++ < 1,
  });
  assert.equal(second.recorded, 10);
});

test("the queue map accepts only Prospectus usage queues", () => {
  assert.deepEqual(usageQueues({ "papyrus-example": URL_A }), { "papyrus-example": URL_A });
  assert.throws(() => usageQueues({ "papyrus-example": "https://example.com/queue" }));
  assert.throws(() => usageQueues({ "Bad Product": URL_A }));
  assert.throws(() => usageQueues([]));
});
