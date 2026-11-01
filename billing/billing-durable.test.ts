import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { VirtuusBillingFiles } from "../accounts/identity-files";
import { BillingError } from "./model";
import { hexSegment } from "./store";
import { billingFixture, operator, profileInput } from "./testing/billing-fixture";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function durable() {
  const root = await mkdtemp(join(tmpdir(), "prospectus-billing-files-"));
  roots.push(root);
  return { root, ...billingFixture(new VirtuusBillingFiles(root)) };
}
async function canonicalFiles(root: string) {
  return (await readdir(root, { recursive: true }))
    .map((path) => path.split("\\").join("/"))
    .filter((path) => path.endsWith(".json") && !path.includes("_virtuus"));
}
const ada = operator("ada"),
  grace = operator("grace");
const refusedWith = (status: number, code: string) => (error: any) =>
  error instanceof BillingError && error.status === status && error.code === code;

test("profiles, lines and journal events persist as ordinary billing files through the Rust bridge", async () => {
  const { root, profiles, lines, accountId } = await durable();
  const profileOperation = randomUUID();
  const first = await profiles.set(ada, accountId, profileInput(), profileOperation);
  assert.equal(first.profile.revision, 1);
  await lines.create(
    ada,
    accountId,
    "papyrus-example-invalid",
    { plan: "papyrus-site-monthly" },
    randomUUID(),
  );
  await lines.create(ada, accountId, "papyrus-second-invalid", { plan: "papyrus-site-yearly" }, randomUUID());
  const ended = await lines.end(
    ada,
    accountId,
    "papyrus-example-invalid",
    { endDate: "2030-04-01" },
    randomUUID(),
  );
  assert.equal(ended.followUp.disableProduct, true);
  assert.deepEqual(
    (await lines.list(accountId)).map((line) => [line.product, line.status]),
    [
      ["papyrus-example-invalid", "ended"],
      ["papyrus-second-invalid", "active"],
    ],
  );
  const files = await canonicalFiles(root);
  assert.ok(files.some((path) => path.endsWith(`billing/profiles/${accountId}.json`)));
  assert.ok(
    files.some((path) =>
      path.endsWith(`billing/lines/${accountId}/${hexSegment("papyrus-second-invalid")}.json`),
    ),
  );
  assert.equal(files.filter((path) => /billing\/journal\/[a-f0-9]{64}\.json$/.test(path)).length, 4);
  assert.ok(
    files.every((path) => path.includes("billing/")),
    "nothing lands outside the billing project",
  );
  const stored = JSON.parse(
    await readFile(join(root, files.find((path) => path.includes("/profiles/"))!), "utf8"),
  );
  // Two lines reserved and one released: each advanced the profile revision, and only the open line stays reserved.
  assert.equal(stored.revision, 4);
  assert.deepEqual(Object.keys(stored.openLines), ["papyrus-second-invalid"]);
  assert.equal(stored.currency, "usd");

  // A replay after a later change still returns the original committed result, through the Virtuus receipt.
  await profiles.set(ada, accountId, profileInput({ netTermsDays: 45 }), randomUUID());
  const replay = await profiles.set(ada, accountId, profileInput(), profileOperation);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.profile, first.profile);
  assert.equal((await profiles.get(accountId))!.revision, 5);
  assert.equal((await canonicalFiles(root)).filter((path) => path.includes("/journal/")).length, 5);
});

test("a stale writer through the Rust bridge is refused as a revision conflict and the winner's revision stands", async () => {
  const { profiles, accountId } = await durable();
  await profiles.set(ada, accountId, profileInput(), randomUUID());
  const [left, right] = await Promise.allSettled([
    profiles.set(ada, accountId, profileInput({ netTermsDays: 40, expectedRevision: 1 }), randomUUID()),
    profiles.set(grace, accountId, profileInput({ netTermsDays: 50, expectedRevision: 1 }), randomUUID()),
  ]);
  const outcomes = [left, right];
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const loser = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
  assert.ok(refusedWith(409, "revision_conflict")(loser.reason), String(loser.reason));
  const stored = (await profiles.get(accountId))!;
  assert.equal(stored.revision, 2);
  assert.ok([40, 50].includes(stored.netTermsDays!));
});

test("mode changes with open lines are refused through the bridge, naming the lines", async () => {
  const { profiles, lines, accountId } = await durable();
  await profiles.set(ada, accountId, profileInput(), randomUUID());
  await lines.create(
    ada,
    accountId,
    "papyrus-example-invalid",
    { plan: "papyrus-site-monthly" },
    randomUUID(),
  );
  await assert.rejects(
    profiles.set(ada, accountId, profileInput({ mode: "direct" }), randomUUID()),
    (error: any) =>
      refusedWith(409, "open_billing_lines")(error) && error.message.includes("papyrus-example-invalid"),
  );
  await lines.end(ada, accountId, "papyrus-example-invalid", {}, randomUUID());
  assert.equal(
    (await profiles.set(ada, accountId, profileInput({ mode: "direct" }), randomUUID())).profile.mode,
    "direct",
  );
});
