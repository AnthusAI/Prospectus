import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BillingError, type JournalEvent } from "./model";
import { linePath, profilePath } from "./store";
import { BillingLines } from "./lines";
import { reviewedBillingPlans } from "./plans";
import { BillingProfiles } from "./profile";
import { billingFixture, grants, operator, owner, profileInput } from "./testing/billing-fixture";

const ada = operator("ada"),
  grace = operator("grace");
const SITE = "papyrus-example-invalid",
  SECOND = "papyrus-second-invalid";
const monthly = { plan: "papyrus-site-monthly" };
const refusedWith = (status: number, code: string, pattern?: RegExp) => (error: any) =>
  error instanceof BillingError &&
  error.status === status &&
  error.code === code &&
  (!pattern || pattern.test(error.message));
const journal = (files: { objects: Map<string, any> }) =>
  [...files.objects.entries()]
    .filter(([path]) => path.startsWith("journal/"))
    .map(([, stored]) => stored.value as JournalEvent);
async function billable(mode: "direct" | "invoiced" = "invoiced") {
  const fixture = billingFixture();
  await fixture.profiles.set(ada, fixture.accountId, profileInput({ mode }), randomUUID());
  return fixture;
}

test("an admin creates an invoiced line: active, its own file, one journal event", async () => {
  const { files, lines, accountId } = await billable();
  const before = journal(files).length;
  const { line } = await lines.create(
    ada,
    accountId,
    SITE,
    { ...monthly, startDate: "2030-03-01" },
    randomUUID(),
  );
  assert.equal(line.status, "active");
  assert.equal(line.mode, "invoiced");
  assert.equal(line.planId, "papyrus-site-monthly");
  assert.equal(line.family, "papyrus");
  assert.equal(line.interval, "month");
  assert.deepEqual(line.period, { start: "2030-03-01" });
  assert.equal(line.revision, 1);
  assert.ok(files.objects.has(linePath(accountId, SITE)));
  assert.deepEqual(await lines.get(accountId, SITE), line);
  const events = journal(files).slice(before);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "line.created");
  assert.equal(events[0].product, SITE);
});

test("a direct-mode line starts pending until its subscription item is active", async () => {
  const { lines, accountId } = await billable("direct");
  const { line } = await lines.create(ada, accountId, SITE, monthly, randomUUID());
  assert.equal(line.status, "pending");
  assert.equal(line.period.start, "2030-03-17");
});

test("two sites get two lines, and ending one does not touch the other", async () => {
  const { files, lines, accountId } = await billable();
  await lines.create(ada, accountId, SITE, monthly, randomUUID());
  await lines.create(ada, accountId, SECOND, { plan: "papyrus-site-yearly" }, randomUUID());
  const other = files.objects.get(linePath(accountId, SECOND));
  files.commits = [];
  const { line } = await lines.end(ada, accountId, SITE, { endDate: "2030-04-01" }, randomUUID());
  assert.equal(line.status, "ended");
  assert.deepEqual(files.objects.get(linePath(accountId, SECOND)), other);
  // The line ends first, then its reservation is released from the profile; the other line is never written.
  assert.deepEqual(
    files.commits.filter((path) => !path.startsWith("journal/")),
    [linePath(accountId, SITE), profilePath(accountId)],
  );
  const listed = await lines.list(accountId);
  assert.deepEqual(
    listed.map((entry) => [entry.product, entry.status, entry.planId]),
    [
      [SITE, "ended", "papyrus-site-monthly"],
      [SECOND, "active", "papyrus-site-yearly"],
    ].sort(),
  );
});

test("a line without an active entitlement is refused naming the product, and no entitlement is created", async () => {
  const { files, lines, accountId, entitlements } = await billable();
  const before = files.objects.size;
  await assert.rejects(
    lines.create(ada, accountId, "papyrus-unentitled-invalid", monthly, randomUUID()),
    refusedWith(409, "entitlement_required", /papyrus-unentitled-invalid/),
  );
  entitlements[accountId][SECOND] = "disabled";
  await assert.rejects(
    lines.create(ada, accountId, SECOND, monthly, randomUUID()),
    refusedWith(409, "entitlement_required", new RegExp(SECOND)),
  );
  assert.equal(files.objects.size, before);
  assert.equal(entitlements[accountId]["papyrus-unentitled-invalid"], undefined);
});

test("a public-reader product is refused", async () => {
  const { files, lines, accountId } = await billable();
  const before = files.objects.size;
  await assert.rejects(
    lines.create(ada, accountId, "papyrus-reader-invalid", monthly, randomUUID()),
    refusedWith(400, "public_reader_product"),
  );
  assert.equal(files.objects.size, before);
});

test("a plan must exist and belong to the product's family", async () => {
  const { lines, accountId } = await billable();
  await assert.rejects(
    lines.create(ada, accountId, SITE, { plan: "papyrus-site-weekly" }, randomUUID()),
    refusedWith(400, "unknown_plan"),
  );
  await assert.rejects(
    lines.create(ada, accountId, SITE, { plan: "cyclotron-lab-monthly" }, randomUUID()),
    refusedWith(400, "plan_family_mismatch"),
  );
  assert.equal(
    (await lines.create(ada, accountId, "cyclotron", { plan: "cyclotron-lab-monthly" }, randomUUID())).line
      .family,
    "cyclotron-lab",
  );
  await assert.rejects(
    lines.create(ada, accountId, SITE, { ...monthly, amountCents: 1 }, randomUUID()),
    refusedWith(400, "invalid_billing_line"),
  );
});

test("an account with no profile, or a profile with no mode, is not yet billable", async () => {
  const fixture = billingFixture();
  await assert.rejects(
    fixture.lines.create(ada, fixture.accountId, SITE, monthly, randomUUID()),
    refusedWith(409, "not_yet_billable"),
  );
  await fixture.profiles.set(ada, fixture.accountId, profileInput({ mode: undefined }), randomUUID());
  await assert.rejects(
    fixture.lines.create(ada, fixture.accountId, SITE, monthly, randomUUID()),
    refusedWith(409, "not_yet_billable"),
  );
  assert.equal(await fixture.lines.get(fixture.accountId, SITE), null);
});

test("pausing and resuming an invoiced line leaves the entitlement unchanged", async () => {
  const { lines, accountId, entitlements } = await billable();
  await lines.create(ada, accountId, SITE, monthly, randomUUID());
  const before = structuredClone(entitlements);
  assert.equal((await lines.pause(ada, accountId, SITE, {}, randomUUID())).line.status, "paused");
  await assert.rejects(
    lines.pause(ada, accountId, SITE, {}, randomUUID()),
    refusedWith(409, "invalid_transition"),
  );
  const resumed = (await lines.resume(ada, accountId, SITE, {}, randomUUID())).line;
  assert.equal(resumed.status, "active");
  assert.deepEqual(
    resumed.audit.map((entry) => entry.action),
    ["line.created", "line.paused", "line.resumed"],
  );
  await assert.rejects(
    lines.resume(ada, accountId, SITE, {}, randomUUID()),
    refusedWith(409, "invalid_transition"),
  );
  assert.deepEqual(entitlements, before);
});

test("ending a line keeps the entitlement and returns a follow-up about disabling the product", async () => {
  const { lines, accountId, entitlements } = await billable();
  await lines.create(ada, accountId, SITE, { ...monthly, startDate: "2030-03-01" }, randomUUID());
  const operationId = randomUUID();
  const ended = await lines.end(ada, accountId, SITE, { endDate: "2030-03-31" }, operationId);
  assert.equal(ended.line.status, "ended");
  assert.deepEqual(ended.line.period, { start: "2030-03-01", end: "2030-03-31" });
  assert.deepEqual(ended.followUp, {
    type: "consider-disabling-product",
    accountId,
    product: SITE,
    disableProduct: true,
    entitlementStatus: "active",
  });
  assert.equal(entitlements[accountId][SITE], "active");
  // A replay returns the same follow-up even after the entitlement changes.
  entitlements[accountId][SITE] = "disabled";
  const replay = await lines.end(ada, accountId, SITE, { endDate: "2030-03-31" }, operationId);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.followUp, ended.followUp);
  await assert.rejects(
    lines.end(ada, accountId, SITE, {}, randomUUID()),
    refusedWith(409, "invalid_transition"),
  );
  await assert.rejects(lines.end(ada, accountId, SECOND, {}, randomUUID()), refusedWith(404, "line_missing"));
});

test("a line may outlive a disabled entitlement; its follow-up then does not ask to disable", async () => {
  const { lines, accountId, entitlements } = await billable();
  await lines.create(ada, accountId, SITE, monthly, randomUUID());
  entitlements[accountId][SITE] = "disabled";
  assert.equal((await lines.get(accountId, SITE))!.status, "active");
  assert.equal((await lines.pause(ada, accountId, SITE, {}, randomUUID())).line.status, "paused");
  const { followUp } = await lines.end(ada, accountId, SITE, {}, randomUUID());
  assert.equal(followUp.disableProduct, false);
  assert.equal(followUp.entitlementStatus, "disabled");
});

test("an ended line can be billed again with a new period", async () => {
  const { lines, accountId } = await billable();
  await lines.create(ada, accountId, SITE, monthly, randomUUID());
  await assert.rejects(
    lines.create(ada, accountId, SITE, monthly, randomUUID()),
    refusedWith(409, "line_exists"),
  );
  await lines.end(ada, accountId, SITE, { endDate: "2030-03-20" }, randomUUID());
  const again = (
    await lines.create(ada, accountId, SITE, { ...monthly, startDate: "2030-05-01" }, randomUUID())
  ).line;
  assert.equal(again.status, "active");
  assert.deepEqual(again.period, { start: "2030-05-01" });
  assert.equal(again.revision, 3);
  assert.equal(again.endFollowUp, undefined);
});

test("direct-mode lines must share one interval, since the client has one subscription", async () => {
  const { lines, accountId } = await billable("direct");
  await lines.create(ada, accountId, SITE, monthly, randomUUID());
  await assert.rejects(
    lines.create(ada, accountId, SECOND, { plan: "papyrus-site-yearly" }, randomUUID()),
    refusedWith(409, "interval_mismatch", /year/),
  );
  assert.equal((await lines.create(ada, accountId, SECOND, monthly, randomUUID())).line.status, "pending");
});

test("invoiced lines may mix intervals", async () => {
  const { lines, accountId } = await billable();
  await lines.create(ada, accountId, SITE, monthly, randomUUID());
  assert.equal(
    (await lines.create(ada, accountId, SECOND, { plan: "papyrus-site-yearly" }, randomUUID())).line.interval,
    "year",
  );
});

test("only billing admins change lines: a reader operator or an owner gets 403 and nothing is written", async () => {
  const { files, lines, accountId } = await billable();
  await lines.create(ada, accountId, SITE, monthly, randomUUID());
  const objects = structuredClone([...files.objects.entries()]);
  for (const context of [operator("reader"), owner]) {
    await assert.rejects(
      lines.create(context, accountId, SECOND, monthly, randomUUID()),
      refusedWith(403, "forbidden"),
    );
    await assert.rejects(
      lines.pause(context, accountId, SITE, {}, randomUUID()),
      refusedWith(403, "forbidden"),
    );
    await assert.rejects(
      lines.resume(context, accountId, SITE, {}, randomUUID()),
      refusedWith(403, "forbidden"),
    );
    await assert.rejects(
      lines.end(context, accountId, SITE, {}, randomUUID()),
      refusedWith(403, "forbidden"),
    );
  }
  assert.deepEqual([...files.objects.entries()], objects);
});

test("a replayed create returns the original line with no second revision or event", async () => {
  const { files, lines, accountId } = await billable();
  const operationId = randomUUID();
  const first = await lines.create(ada, accountId, SITE, monthly, operationId);
  const events = journal(files).length;
  const replay = await lines.create(ada, accountId, SITE, monthly, operationId);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.line, first.line);
  assert.equal(journal(files).length, events);
  assert.equal((await lines.get(accountId, SITE))!.revision, 1);
  await assert.rejects(
    lines.create(ada, accountId, SITE, { plan: "papyrus-site-yearly" }, operationId),
    refusedWith(409, "idempotency_conflict"),
  );
});

test("two admins pausing and ending the same line from one revision: one wins, the loser re-reads", async () => {
  const { files, lines, accountId } = await billable();
  const { line } = await lines.create(ada, accountId, SITE, monthly, randomUUID());
  let interleaved = false;
  files.beforeCommit = async (path) => {
    if (interleaved || path !== linePath(accountId, SITE)) return;
    interleaved = true;
    await lines.pause(grace, accountId, SITE, { expectedRevision: line.revision }, randomUUID());
  };
  await assert.rejects(
    lines.end(ada, accountId, SITE, { expectedRevision: line.revision }, randomUUID()),
    refusedWith(409, "revision_conflict"),
  );
  assert.equal((await lines.get(accountId, SITE))!.status, "paused");
  // Without an expected revision the loser re-reads and re-evaluates against the new state.
  interleaved = false;
  files.beforeCommit = async (path) => {
    if (interleaved || path !== linePath(accountId, SITE)) return;
    interleaved = true;
    await lines.resume(grace, accountId, SITE, {}, randomUUID());
  };
  await assert.rejects(
    lines.resume(ada, accountId, SITE, {}, randomUUID()),
    refusedWith(409, "invalid_transition"),
  );
  assert.equal((await lines.get(accountId, SITE))!.revision, 3);
});

test("billing reads entitlements but never writes account files", async () => {
  const { files, lines, accountId, entitlementReads } = await billable();
  await lines.create(ada, accountId, SITE, monthly, randomUUID());
  await lines.end(ada, accountId, SITE, {}, randomUUID());
  assert.ok(entitlementReads.length >= 2);
  for (const path of files.objects.keys()) assert.match(path, /^(profiles|lines|journal)\//);
});

/** Runs `competitor` once, just before the next new storage commit, to land a competing writer mid-operation. */
function interleave(
  files: { beforeCommit?: (path: string) => void | Promise<void> },
  competitor: () => Promise<unknown>,
) {
  let ran = false;
  const outcome: { error?: unknown } = {};
  files.beforeCommit = async () => {
    if (ran) return;
    ran = true;
    await competitor().catch((error) => (outcome.error = error));
  };
  return outcome;
}

test("a mode switch landing while a line opens: the line opens under the new mode", async () => {
  const { files, profiles, lines, accountId } = await billable();
  const competitor = interleave(files, () =>
    profiles.set(grace, accountId, profileInput({ mode: "direct" }), randomUUID()),
  );
  const { line } = await lines.create(ada, accountId, SITE, monthly, randomUUID());
  assert.equal(competitor.error, undefined);
  assert.equal((await profiles.get(accountId))!.mode, "direct");
  assert.equal(line.mode, "direct");
  assert.equal(line.status, "pending");
});

test("a line opening while a mode switch is evaluated: the switch is refused naming it", async () => {
  const { files, profiles, lines, accountId } = await billable();
  const competitor = interleave(files, () => lines.create(grace, accountId, SITE, monthly, randomUUID()));
  await assert.rejects(
    profiles.set(ada, accountId, profileInput({ mode: "direct" }), randomUUID()),
    (error: any) => refusedWith(409, "open_billing_lines")(error) && error.message.includes(SITE),
  );
  assert.equal(competitor.error, undefined);
  assert.equal((await profiles.get(accountId))!.mode, "invoiced");
  assert.equal((await lines.get(accountId, SITE))!.mode, "invoiced");
});

test("two direct-mode lines of different intervals opening at once: one is refused naming the interval", async () => {
  const { files, lines, accountId } = await billable("direct");
  const competitor = interleave(files, () =>
    lines.create(grace, accountId, SECOND, { plan: "papyrus-site-yearly" }, randomUUID()),
  );
  await assert.rejects(
    lines.create(ada, accountId, SITE, monthly, randomUUID()),
    refusedWith(409, "interval_mismatch", /month/),
  );
  assert.equal(competitor.error, undefined);
  assert.deepEqual(
    (await lines.list(accountId)).map((line) => [line.product, line.interval]),
    [[SECOND, "year"]],
  );
});

test("a creation that failed after reserving blocks a switch until it is sent again", async () => {
  const { files, profiles, lines, accountId } = await billable();
  const operationId = randomUUID();
  files.beforeCommit = (path) => {
    if (path === linePath(accountId, SITE)) throw new Error("synthetic crash before the line is written");
  };
  await assert.rejects(lines.create(ada, accountId, SITE, monthly, operationId), /synthetic crash/);
  files.beforeCommit = undefined;
  assert.equal(await lines.get(accountId, SITE), null);
  await assert.rejects(
    profiles.set(ada, accountId, profileInput({ mode: "direct" }), randomUUID()),
    (error: any) => refusedWith(409, "open_billing_lines")(error) && error.message.includes(SITE),
  );
  const { line } = await lines.create(ada, accountId, SITE, monthly, operationId);
  assert.equal(line.openedBy, operationId);
  assert.deepEqual(Object.keys((await profiles.get(accountId))!.openLines!), [SITE]);
});

test("an abandoned reservation stops blocking after the timeout", async () => {
  const { files, accountId } = await billable();
  let now = "2030-03-17T17:46:40.000Z";
  const fixture = billingFixture(files);
  const lines = new BillingLines(files, grants, reviewedBillingPlans(), fixture.ports, () => now);
  const profiles = new BillingProfiles(files, grants, () => now);
  fixture.entitlements[accountId] = { [SITE]: "active" };
  files.beforeCommit = (path) => {
    if (path === linePath(accountId, SITE)) throw new Error("synthetic crash before the line is written");
  };
  await assert.rejects(lines.create(ada, accountId, SITE, monthly, randomUUID()), /synthetic crash/);
  files.beforeCommit = undefined;
  now = "2030-03-17T17:56:39.000Z";
  await assert.rejects(
    profiles.set(ada, accountId, profileInput({ mode: "direct" }), randomUUID()),
    refusedWith(409, "open_billing_lines"),
  );
  now = "2030-03-17T17:56:41.000Z";
  const { profile } = await profiles.set(ada, accountId, profileInput({ mode: "direct" }), randomUUID());
  assert.equal(profile.mode, "direct");
  assert.equal(profile.openLines, undefined);
});

test("an end whose release did not finish no longer blocks a switch, and replaying the end finishes it", async () => {
  const { files, profiles, lines, accountId } = await billable();
  await lines.create(ada, accountId, SITE, monthly, randomUUID());
  const endOperation = randomUUID();
  files.beforeCommit = (path) => {
    if (path.startsWith("profiles/")) throw new Error("synthetic crash before the release");
  };
  await assert.rejects(lines.end(ada, accountId, SITE, {}, endOperation), /synthetic crash/);
  files.beforeCommit = undefined;
  assert.deepEqual(Object.keys((await profiles.get(accountId))!.openLines!), [SITE]);
  const replay = await lines.end(ada, accountId, SITE, {}, endOperation);
  assert.equal(replay.replayed, true);
  assert.equal((await profiles.get(accountId))!.openLines, undefined);
  // A stale reservation left behind also gives way to a switch on its own.
  await lines.create(ada, accountId, SECOND, monthly, randomUUID());
  files.beforeCommit = (path) => {
    if (path.startsWith("profiles/")) throw new Error("synthetic crash before the release");
  };
  await assert.rejects(lines.end(ada, accountId, SECOND, {}, randomUUID()), /synthetic crash/);
  files.beforeCommit = undefined;
  const { profile } = await profiles.set(ada, accountId, profileInput({ mode: "direct" }), randomUUID());
  assert.equal(profile.mode, "direct");
  assert.equal(profile.openLines, undefined);
});
