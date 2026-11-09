import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageSender, usageQueueUrl, type UsageMessage } from "../src/usage";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const NOW = Date.parse("2026-11-09T15:00:00Z");
const SYNTHETIC_ACCOUNT = "111122223333";
const queueUrl = (product: string) => usageQueueUrl(product, SYNTHETIC_ACCOUNT);

function sender(send: (url: string, body: string) => Promise<void>) {
  return new UsageSender({
    product: "papyrus-example",
    app: "papyrus",
    deployment: "example",
    queueUrl: queueUrl("papyrus-example"),
    send,
    now: () => NOW,
  });
}

test("usage is tallied per Account and day and sent as one message each, with quantities only", async () => {
  const sent: Array<[string, UsageMessage]> = [];
  const usage = sender(async (url, body) => void sent.push([url, JSON.parse(body)]));
  usage.record(ACCOUNT, [{ itemKind: "openai.tokens.input", quantity: 100 }]);
  usage.record(ACCOUNT, [
    { itemKind: "openai.tokens.input", quantity: 50 },
    { itemKind: "jev.tokens", quantity: 7 },
  ]);
  usage.record(OTHER, [{ itemKind: "jev.tokens", quantity: 1 }]);
  assert.equal(sent.length, 0, "recording never sends");
  await usage.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[0][0], queueUrl("papyrus-example"));
  assert.equal(
    sent[0][0],
    "https://sqs.us-east-1.amazonaws.com/111122223333/prospectus-usage-papyrus-example",
  );
  const first = sent.find(([, message]) => message.accountId === ACCOUNT)![1];
  assert.deepEqual(
    { ...first, operationId: "x" },
    {
      version: 1,
      operationId: "x",
      accountId: ACCOUNT,
      app: "papyrus",
      deployment: "example",
      day: 20261109,
      items: [
        { itemKind: "openai.tokens.input", quantity: 150 },
        { itemKind: "jev.tokens", quantity: 7 },
      ],
    },
  );
  assert.equal(usage.backlog, 0);
  await usage.flush();
  assert.equal(sent.length, 2, "nothing new to send");
});

test("a failed send is kept and retried with the same operation ID", async () => {
  const bodies: string[] = [];
  let fail = true;
  const errors: string[] = [];
  const usage = new UsageSender({
    product: "cyclotron",
    app: "cyclotron",
    queueUrl: queueUrl("cyclotron"),
    now: () => NOW,
    onError: (reason) => errors.push(reason),
    send: async (_url, body) => {
      bodies.push(body);
      if (fail) throw new Error("network");
    },
  });
  usage.record(ACCOUNT, [{ itemKind: "jev.tokens", quantity: 3 }]);
  await usage.flush();
  assert.equal(usage.backlog, 1);
  assert.deepEqual(errors, ["send_failed"]);
  fail = false;
  usage.record(ACCOUNT, [{ itemKind: "jev.tokens", quantity: 2 }]);
  await usage.flush();
  assert.equal(usage.backlog, 0);
  const [failed, retried, fresh] = bodies.map((body) => JSON.parse(body));
  assert.equal(retried.operationId, failed.operationId);
  assert.notEqual(fresh.operationId, failed.operationId);
  assert.equal(fresh.items[0].quantity, 2);
});

test("bad input throws at once and a Papyrus site must send as its own product", () => {
  const usage = sender(async () => {});
  assert.throws(() => usage.record("not-a-uuid", []), /accountId/);
  assert.doesNotThrow(() => usage.record("owner", [{ itemKind: "jev.tokens", quantity: 1 }]));
  const noDeployment = new UsageSender({
    product: "cyclotron",
    app: "cyclotron",
    queueUrl: queueUrl("cyclotron"),
  });
  assert.throws(() => noDeployment.record("owner", []), /needs a deployment/);
  assert.throws(() => usage.record(ACCOUNT, [{ itemKind: "Tokens", quantity: 1 }]), /itemKind/);
  assert.throws(() => usage.record(ACCOUNT, [{ itemKind: "jev.tokens", quantity: 1.5 }]), /quantity/);
  assert.throws(() => usage.record(ACCOUNT, [{ itemKind: "jev.tokens", quantity: -1 }]), /quantity/);
  assert.throws(
    () => new UsageSender({ product: "papyrus-example", app: "papyrus", deployment: "other" }),
    /papyrus-<site>/,
  );
  assert.throws(() => new UsageSender({ product: "x", app: "unknown" as any }), /app/);
  assert.throws(
    () => new UsageSender({ product: "cyclotron", app: "cyclotron", queueUrl: queueUrl("babulus") }),
    /PROSPECTUS_USAGE_QUEUE_URL/,
    "a product may only send to its own queue",
  );
  assert.throws(
    () => new UsageSender({ product: "cyclotron", app: "cyclotron" }),
    /PROSPECTUS_USAGE_QUEUE_URL/,
  );
  assert.throws(() => usageQueueUrl("cyclotron", "123"), /12 digits/);
});

test("start flushes on an interval that does not hold the process open, and stop flushes the rest", async () => {
  const sent: string[] = [];
  const usage = sender(async (_url, body) => void sent.push(body));
  usage.start(5);
  usage.record(ACCOUNT, [{ itemKind: "jev.tokens", quantity: 1 }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 1);
  usage.record(ACCOUNT, [{ itemKind: "jev.tokens", quantity: 1 }]);
  await usage.stop();
  assert.equal(sent.length, 2);
});
