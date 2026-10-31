import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BillingError, type BillingProfile, type JournalEvent } from "./model";
import { effectiveNetTermsDays } from "./profile";
import { hexSegment, profilePath } from "./store";
import { logRefusal } from "../accounts/refusal-log";
import { billingFixture, CONTACT_MARKER, operator, owner, profileInput } from "./testing/billing-fixture";

const ada = operator("ada"),
  grace = operator("grace");
const refusedWith = (status: number, code: string) => (error: any) =>
  error instanceof BillingError && error.status === status && error.code === code;
const journal = (files: { objects: Map<string, any> }) =>
  [...files.objects.entries()]
    .filter(([path]) => path.startsWith("journal/"))
    .map(([, stored]) => stored.value as JournalEvent);

test("an admin sets a profile: revision 1, the creation operation, one audit entry and one journal event", async () => {
  const { files, profiles, accountId } = billingFixture();
  const operationId = randomUUID();
  const { profile, replayed } = await profiles.set(ada, accountId, profileInput(), operationId);
  assert.equal(replayed, false);
  assert.equal(profile.revision, 1);
  assert.equal(profile.mode, "invoiced");
  assert.equal(profile.currency, "usd");
  assert.deepEqual(profile.creation, { operationId, at: "2030-03-17T17:46:40.000Z" });
  assert.equal(profile.audit.length, 1);
  assert.equal(profile.audit[0].operationId, operationId);
  assert.equal(profile.audit[0].actor, "synthetic-ada-billing");
  assert.deepEqual(await profiles.get(accountId), profile);
  const events = journal(files);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "profile.set");
  assert.equal(events[0].beforeRevision, null);
  assert.equal(events[0].afterRevision, 1);
  assert.equal(events[0].recordPath, `profiles/${accountId}.json`);
  assert.ok(!JSON.stringify(events[0]).includes(CONTACT_MARKER), "the journal carries no contact data");
  // Billing writes only billing files: the account document is never touched.
  assert.deepEqual(
    files.commits.sort(),
    [`journal/${events[0].eventId}.json`, profilePath(accountId)].sort(),
  );
});

test("net terms default to 30 days and take a per-account override", async () => {
  const { profiles, accountId } = billingFixture();
  const first = (await profiles.set(ada, accountId, profileInput(), randomUUID())).profile;
  assert.equal(first.netTermsDays, undefined);
  assert.equal(effectiveNetTermsDays(first), 30);
  const second = (await profiles.set(ada, accountId, profileInput({ netTermsDays: 45 }), randomUUID()))
    .profile;
  assert.equal(effectiveNetTermsDays(second), 45);
  assert.equal(second.revision, 2);
  await assert.rejects(
    profiles.set(ada, accountId, profileInput({ netTermsDays: 0 }), randomUUID()),
    refusedWith(400, "invalid_billing_profile"),
  );
});

test("only US dollars are accepted, and nothing is written for a refusal", async () => {
  const { files, profiles, accountId } = billingFixture();
  await assert.rejects(
    profiles.set(ada, accountId, profileInput({ currency: "eur" }), randomUUID()),
    (error: any) =>
      refusedWith(400, "invalid_billing_profile")(error) && /currency must be usd/.test(error.message),
  );
  assert.equal(files.objects.size, 0);
});

test("unknown fields are refused in the profile, the contact and the address", async () => {
  const { files, profiles, accountId } = billingFixture();
  const contact = profileInput().billingContact;
  for (const input of [
    profileInput({ stripeCustomerId: "cus_synthetic" }),
    profileInput({ billingContact: { ...contact, phone: "synthetic" } }),
    profileInput({ billingContact: { ...contact, address: { ...contact.address, county: "synthetic" } } }),
    profileInput({ mode: "monthly" }),
    profileInput({ paymentMethods: ["venmo", "venmo"] }),
    profileInput({ paymentMethods: ["paypal"] }),
  ])
    await assert.rejects(
      profiles.set(ada, accountId, input, randomUUID()),
      refusedWith(400, "invalid_billing_profile"),
    );
  assert.equal(files.objects.size, 0);
});

test("a payment-method override and an absent mode are kept as set", async () => {
  const { profiles, accountId } = billingFixture();
  const { profile } = await profiles.set(
    ada,
    accountId,
    {
      currency: "usd",
      billingContact: profileInput().billingContact,
      paymentMethods: ["bank_transfer", "venmo"],
    },
    randomUUID(),
  );
  assert.equal(profile.mode, undefined);
  assert.deepEqual(profile.paymentMethods, ["bank_transfer", "venmo"]);
});

test("changing mode with open lines is refused naming both lines, then succeeds once each line is ended", async () => {
  const { profiles, lines, accountId } = billingFixture();
  await profiles.set(ada, accountId, profileInput(), randomUUID());
  for (const product of ["papyrus-example-invalid", "papyrus-second-invalid"])
    await lines.create(ada, accountId, product, { plan: "papyrus-site-monthly" }, randomUUID());
  await lines.pause(ada, accountId, "papyrus-second-invalid", {}, randomUUID());
  await assert.rejects(
    profiles.set(ada, accountId, profileInput({ mode: "direct" }), randomUUID()),
    (error: any) =>
      refusedWith(409, "open_billing_lines")(error) &&
      error.message.includes("papyrus-example-invalid") &&
      error.message.includes("papyrus-second-invalid"),
  );
  assert.equal((await profiles.get(accountId))!.mode, "invoiced");
  // Editing the contact without a mode change stays possible.
  assert.equal(
    (await profiles.set(ada, accountId, profileInput({ netTermsDays: 60 }), randomUUID())).profile.revision,
    2,
  );
  for (const product of ["papyrus-example-invalid", "papyrus-second-invalid"])
    await lines.end(ada, accountId, product, { endDate: "2030-03-31" }, randomUUID());
  const switched = await profiles.set(ada, accountId, profileInput({ mode: "direct" }), randomUUID());
  assert.equal(switched.profile.mode, "direct");
});

test("an operator with only accounts:admin:read, or an account owner, gets 403 and nothing is written", async () => {
  const { files, profiles, accountId } = billingFixture();
  for (const context of [operator("reader"), owner, operator("stranger")])
    await assert.rejects(
      profiles.set(context, accountId, profileInput(), randomUUID()),
      refusedWith(403, "forbidden"),
    );
  // The permission is checked before the input, so malformed input from a non-admin is still 403.
  await assert.rejects(
    profiles.set(owner, "not-an-account", { junk: true }, "x"),
    refusedWith(403, "forbidden"),
  );
  assert.equal(files.objects.size, 0);
  assert.equal(files.operations.size, 0);
});

test("a replayed write returns the original result and writes no second revision or event", async () => {
  const { files, profiles, accountId } = billingFixture();
  const operationId = randomUUID();
  const first = await profiles.set(ada, accountId, profileInput(), operationId);
  const replay = await profiles.set(ada, accountId, profileInput(), operationId);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.profile, first.profile);
  assert.equal((await profiles.get(accountId))!.revision, 1);
  assert.equal(journal(files).length, 1);
  // A later change does not alter what the earlier operation's replay returns.
  await profiles.set(ada, accountId, profileInput({ netTermsDays: 45 }), randomUUID());
  assert.deepEqual((await profiles.set(ada, accountId, profileInput(), operationId)).profile, first.profile);
  assert.equal((await profiles.get(accountId))!.revision, 2);
});

test("the same operation ID with a different request is an idempotency conflict", async () => {
  const { profiles, accountId } = billingFixture();
  const operationId = randomUUID();
  await profiles.set(ada, accountId, profileInput(), operationId);
  await assert.rejects(
    profiles.set(ada, accountId, profileInput({ netTermsDays: 45 }), operationId),
    refusedWith(409, "idempotency_conflict"),
  );
  await assert.rejects(
    profiles.set(grace, accountId, profileInput(), operationId),
    refusedWith(409, "idempotency_conflict"),
  );
});

test("a write committed before its journal event finishes the event on retry without a second revision", async () => {
  const { files, profiles, accountId } = billingFixture();
  const operationId = randomUUID();
  files.beforeCommit = (path) => {
    if (path.startsWith("journal/")) throw new Error("synthetic crash after the record commit");
  };
  await assert.rejects(profiles.set(ada, accountId, profileInput(), operationId), /synthetic crash/);
  assert.equal((await profiles.get(accountId))!.revision, 1);
  assert.equal(journal(files).length, 0);
  files.beforeCommit = undefined;
  const retry = await profiles.set(ada, accountId, profileInput(), operationId);
  assert.equal(retry.replayed, true);
  assert.equal(retry.profile.revision, 1);
  assert.equal(journal(files).length, 1);
  assert.equal(journal(files)[0].afterRevision, 1);
});

test("two admins editing from revision 3: one saves revision 4, the other is a revision conflict", async () => {
  const { files, profiles, accountId } = billingFixture();
  for (const days of [31, 32, 33])
    await profiles.set(ada, accountId, profileInput({ netTermsDays: days }), randomUUID());
  assert.equal((await profiles.get(accountId))!.revision, 3);
  // Grace's save lands between Ada's read and Ada's commit.
  let interleaved = false;
  files.beforeCommit = async (path) => {
    if (interleaved || path !== profilePath(accountId)) return;
    interleaved = true;
    await profiles.set(
      grace,
      accountId,
      profileInput({ netTermsDays: 40, expectedRevision: 3 }),
      randomUUID(),
    );
  };
  await assert.rejects(
    profiles.set(ada, accountId, profileInput({ netTermsDays: 50, expectedRevision: 3 }), randomUUID()),
    refusedWith(409, "revision_conflict"),
  );
  const stored = (await profiles.get(accountId))!;
  assert.equal(stored.revision, 4);
  assert.equal(stored.netTermsDays, 40);
  assert.equal(stored.audit.at(-1)!.actor, "synthetic-grace-billing");
});

test("without an expected revision, the loser of a race re-reads and applies on the new revision", async () => {
  const { files, profiles, accountId } = billingFixture();
  await profiles.set(ada, accountId, profileInput(), randomUUID());
  let interleaved = false;
  files.beforeCommit = async (path) => {
    if (interleaved || path !== profilePath(accountId)) return;
    interleaved = true;
    await profiles.set(grace, accountId, profileInput({ netTermsDays: 40 }), randomUUID());
  };
  const { profile } = await profiles.set(ada, accountId, profileInput({ netTermsDays: 50 }), randomUUID());
  assert.equal(profile.revision, 3);
  assert.deepEqual(
    profile.audit.map((entry) => [entry.revision, entry.actor]),
    [
      [1, "synthetic-ada-billing"],
      [2, "synthetic-grace-billing"],
      [3, "synthetic-ada-billing"],
    ],
  );
  assert.equal(journal(files).length, 3);
});

test("billing contact data never appears in refusals or refusal logs", async () => {
  const { profiles, lines, accountId } = billingFixture();
  const logged: string[] = [];
  const info = mock.method(console, "info", (line: string) => logged.push(line));
  try {
    const errors: unknown[] = [];
    const attempt = async (write: Promise<unknown>) => {
      try {
        await write;
      } catch (error) {
        errors.push(error);
        logRefusal(
          { httpMethod: "PUT", path: `/v1/account-directory/operator/accounts/${accountId}/billing-profile` },
          error,
        );
      }
    };
    const contact = profileInput().billingContact;
    await attempt(profiles.set(owner, accountId, profileInput(), randomUUID()));
    await attempt(profiles.set(ada, accountId, profileInput({ currency: "eur" }), randomUUID()));
    await attempt(
      profiles.set(
        ada,
        accountId,
        profileInput({ billingContact: { ...contact, email: `x ${CONTACT_MARKER}` } }),
        randomUUID(),
      ),
    );
    await attempt(
      profiles.set(
        ada,
        accountId,
        profileInput({ billingContact: { ...contact, [CONTACT_MARKER]: 1 } }),
        randomUUID(),
      ),
    );
    await attempt(
      profiles.set(
        ada,
        accountId,
        profileInput({
          billingContact: { ...contact, address: { ...contact.address, country: CONTACT_MARKER } },
        }),
        randomUUID(),
      ),
    );
    const operationId = randomUUID();
    await profiles.set(ada, accountId, profileInput(), operationId);
    await attempt(profiles.set(ada, accountId, profileInput({ netTermsDays: 9 }), operationId));
    await attempt(profiles.set(ada, accountId, profileInput({ expectedRevision: 0 }), randomUUID()));
    await lines.create(
      ada,
      accountId,
      "papyrus-example-invalid",
      { plan: "papyrus-site-monthly" },
      randomUUID(),
    );
    await attempt(profiles.set(ada, accountId, profileInput({ mode: "direct" }), randomUUID()));
    assert.equal(errors.length, 8);
    assert.equal(logged.length, 8);
    for (const output of [
      ...errors.map((error: any) => `${error.message} ${JSON.stringify(error)}`),
      ...logged,
    ]) {
      assert.ok(!output.includes(CONTACT_MARKER), output);
      assert.ok(!output.includes("example.invalid"), output);
    }
    for (const line of logged)
      assert.deepEqual(Object.keys(JSON.parse(line)), ["event", "route", "status", "code", "message"]);
  } finally {
    info.mock.restore();
  }
});

test("line files are named by the hex-encoded product", async () => {
  const { files, profiles, lines, accountId } = billingFixture();
  await profiles.set(ada, accountId, profileInput(), randomUUID());
  await lines.create(
    ada,
    accountId,
    "papyrus-example-invalid",
    { plan: "papyrus-site-monthly" },
    randomUUID(),
  );
  assert.ok(files.objects.has(`lines/${accountId}/${hexSegment("papyrus-example-invalid")}.json`));
  assert.match(hexSegment("papyrus-example-invalid"), /^[0-9a-f]+$/);
  const stored: BillingProfile = (await profiles.get(accountId))!;
  assert.equal(stored.accountId, accountId);
});
