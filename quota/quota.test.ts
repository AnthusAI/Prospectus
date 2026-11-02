import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { IdentityFileError } from "../accounts/identity-files";
import { QuotaError } from "./model";
import { NARRATOR, RENDERER, START, operator, quotaFixture } from "./testing/quota-fixture";

const refusedWith = (status: number, code: string) => (error: any) =>
  error instanceof QuotaError && error.status === status && error.code === code;

test("a reservation within the remaining quota succeeds and holds exactly its maximum", async () => {
  const { quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  const { result, replayed } = await reserve(400);
  assert.equal(replayed, false);
  assert.equal(result.status, "reserved");
  assert.equal(result.maxCents, 400);
  const summary = await quota.summary(accountId);
  assert.deepEqual(
    [summary?.allowanceCents, summary?.heldCents, summary?.usedCents, summary?.remainingCents],
    [1000, 400, 0, 600],
  );
});

test("a reservation that does not fit is refused and nothing is written", async () => {
  const { files, quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  await reserve(700);
  const commitsBefore = files.commits.length;
  await assert.rejects(reserve(301), refusedWith(402, "quota_insufficient"));
  assert.equal(files.commits.length, commitsBefore);
  assert.equal((await quota.summary(accountId))?.heldCents, 700);
  // Exactly the remaining amount still fits.
  assert.equal((await reserve(300)).result.status, "reserved");
});

test("concurrent reservations cannot together exceed the allowance", async () => {
  const { quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  const settled = await Promise.allSettled(Array.from({ length: 8 }, () => reserve(300)));
  const granted = settled.filter((outcome) => outcome.status === "fulfilled");
  assert.equal(granted.length, 3, "only three 300-cent reservations fit in 1000");
  for (const outcome of settled)
    if (outcome.status === "rejected")
      assert.ok(["quota_insufficient", "busy"].includes(outcome.reason.code));
  const summary = await quota.summary(accountId);
  assert.ok(summary!.heldCents <= 1000 && summary!.remainingCents >= 0);
});

test("a lost race is re-evaluated against what the winner held", async () => {
  const { files, quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(500);
  let raced = false;
  files.beforeCommit = async (path) => {
    if (raced || !path.startsWith("allowances/")) return;
    raced = true;
    await reserve(400);
  };
  await assert.rejects(reserve(400), refusedWith(402, "quota_insufficient"));
  assert.equal((await quota.summary(accountId))?.heldCents, 400);
});

test("repeating a reserve with the same operation ID returns the same result and holds quota once", async () => {
  const { quota, accountId, grantAllowance } = quotaFixture();
  await grantAllowance(1000);
  const input = { operationId: randomUUID(), maxCents: 250, expiresInSeconds: 600 };
  const first = await quota.reserve(RENDERER, accountId, input);
  const second = await quota.reserve(RENDERER, accountId, input);
  assert.deepEqual(second.result, first.result);
  assert.equal(second.replayed, true);
  assert.equal((await quota.summary(accountId))?.heldCents, 250);
});

test("a retry gets the original answer even after the quota it would now need is gone", async () => {
  const { quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(500);
  const input = { operationId: randomUUID(), maxCents: 400, expiresInSeconds: 600 };
  const first = await quota.reserve(RENDERER, accountId, input);
  await quota.settle(RENDERER, accountId, first.result.reservationId, {
    operationId: randomUUID(),
    actualCents: 400,
  });
  await assert.rejects(reserve(400), refusedWith(402, "quota_insufficient"));
  const again = await quota.reserve(RENDERER, accountId, input);
  assert.deepEqual(again.result, first.result);
});

test("the same operation ID with a different request is an idempotency conflict", async () => {
  const { quota, accountId, grantAllowance } = quotaFixture();
  await grantAllowance(1000);
  const operationId = randomUUID();
  await quota.reserve(RENDERER, accountId, { operationId, maxCents: 100, expiresInSeconds: 600 });
  await assert.rejects(
    quota.reserve(RENDERER, accountId, { operationId, maxCents: 200, expiresInSeconds: 600 }),
    refusedWith(409, "idempotency_conflict"),
  );
  await assert.rejects(
    quota.reserve(NARRATOR, accountId, { operationId, maxCents: 100, expiresInSeconds: 600 }),
    refusedWith(409, "idempotency_conflict"),
  );
});

test("a crash after the document commit but before the journal is finished by the retry", async () => {
  const { files, quota, accountId, grantAllowance } = quotaFixture();
  await grantAllowance(1000);
  const input = { operationId: randomUUID(), maxCents: 100, expiresInSeconds: 600 };
  const real = files.commit.bind(files);
  files.commit = async (path, ...rest) => {
    if (path.startsWith("journal/")) throw new IdentityFileError("unavailable");
    return real(path, ...rest);
  };
  await assert.rejects(quota.reserve(RENDERER, accountId, input));
  files.commit = real;
  const retried = await quota.reserve(RENDERER, accountId, input);
  assert.equal(retried.replayed, true);
  assert.equal((await quota.summary(accountId))?.heldCents, 100, "held once, not twice");
  assert.ok(files.objects.size >= 3, "the journal event now exists");
});

test("settling below the reservation charges the actual cost and releases the rest", async () => {
  const { quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  const { result } = await reserve(400);
  const settled = await quota.settle(RENDERER, accountId, result.reservationId as string, {
    operationId: randomUUID(),
    actualCents: 150,
  });
  assert.deepEqual(settled.result, {
    reservationId: result.reservationId,
    accountId,
    status: "settled",
    chargedCents: 150,
    releasedCents: 250,
    overageCents: 0,
  });
  const summary = await quota.summary(accountId);
  assert.deepEqual([summary?.usedCents, summary?.heldCents, summary?.remainingCents], [150, 0, 850]);
  assert.deepEqual(summary?.byProduct, [{ product: "example-renderer", usedCents: 150, heldCents: 0 }]);
});

test("settling exactly at the reservation charges it all and releases nothing", async () => {
  const { quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  const { result } = await reserve(400);
  const settled = await quota.settle(RENDERER, accountId, result.reservationId as string, {
    operationId: randomUUID(),
    actualCents: 400,
  });
  assert.equal(settled.result.releasedCents, 0);
  assert.equal((await quota.summary(accountId))?.usedCents, 400);
});

test("a cost above the reservation is refused unless the overage is explicitly acknowledged, then recorded", async () => {
  const { quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  const { result } = await reserve(400);
  const id = result.reservationId as string;
  await assert.rejects(
    quota.settle(RENDERER, accountId, id, { operationId: randomUUID(), actualCents: 450 }),
    refusedWith(409, "exceeds_reservation"),
  );
  assert.equal((await quota.summary(accountId))?.heldCents, 400, "the refused settle changed nothing");
  const settled = await quota.settle(RENDERER, accountId, id, {
    operationId: randomUUID(),
    actualCents: 450,
    allowOverage: true,
  });
  assert.equal(settled.result.overageCents, 50);
  const summary = await quota.summary(accountId);
  assert.deepEqual([summary?.usedCents, summary?.overageCents, summary?.remainingCents], [450, 50, 550]);
});

test("an acknowledged overage can leave remaining quota negative, and new reservations are then refused", async () => {
  const { quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(100);
  const { result } = await reserve(100);
  await quota.settle(RENDERER, accountId, result.reservationId as string, {
    operationId: randomUUID(),
    actualCents: 160,
    allowOverage: true,
  });
  assert.equal((await quota.summary(accountId))?.remainingCents, -60);
  await assert.rejects(reserve(1), refusedWith(402, "quota_insufficient"));
});

test("repeating a settle returns the same result and charges once", async () => {
  const { quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  const { result } = await reserve(400);
  const input = { operationId: randomUUID(), actualCents: 100 };
  const first = await quota.settle(RENDERER, accountId, result.reservationId as string, input);
  const second = await quota.settle(RENDERER, accountId, result.reservationId as string, input);
  assert.deepEqual(second.result, first.result);
  assert.equal((await quota.summary(accountId))?.usedCents, 100);
  await assert.rejects(
    quota.settle(RENDERER, accountId, result.reservationId as string, { ...input, actualCents: 101 }),
    refusedWith(409, "idempotency_conflict"),
  );
});

test("a reservation that is already closed cannot be settled or released again under a new operation ID", async () => {
  const { quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  const { result } = await reserve(400);
  const id = result.reservationId as string;
  await quota.settle(RENDERER, accountId, id, { operationId: randomUUID(), actualCents: 100 });
  await assert.rejects(
    quota.settle(RENDERER, accountId, id, { operationId: randomUUID(), actualCents: 100 }),
    refusedWith(409, "reservation_not_open"),
  );
  await assert.rejects(
    quota.release(RENDERER, accountId, id, { operationId: randomUUID() }),
    refusedWith(409, "reservation_not_open"),
  );
  assert.equal((await quota.summary(accountId))?.usedCents, 100);
});

test("releasing returns everything and charges nothing; repeating it returns the same result", async () => {
  const { quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  const { result } = await reserve(400);
  const input = { operationId: randomUUID() };
  const first = await quota.release(RENDERER, accountId, result.reservationId as string, input);
  assert.deepEqual(first.result, {
    reservationId: result.reservationId,
    accountId,
    status: "released",
    releasedCents: 400,
  });
  const second = await quota.release(RENDERER, accountId, result.reservationId as string, input);
  assert.deepEqual(second.result, first.result);
  const summary = await quota.summary(accountId);
  assert.deepEqual([summary?.usedCents, summary?.heldCents, summary?.remainingCents], [0, 0, 1000]);
});

test("an abandoned reservation stops holding quota when it expires, with no action by anyone", async () => {
  const { quota, accountId, clock, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  await reserve(1000, { expiresInSeconds: 600 });
  await assert.rejects(reserve(1), refusedWith(402, "quota_insufficient"));
  clock.ms = START + 599_999;
  await assert.rejects(reserve(1), refusedWith(402, "quota_insufficient"));
  clock.ms = START + 600_000;
  assert.equal((await quota.summary(accountId))?.remainingCents, 1000);
  assert.equal((await reserve(1000)).result.status, "reserved");
});

test("settling after expiry records the real cost only as an acknowledged overage", async () => {
  const { quota, accountId, clock, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  const { result } = await reserve(400, { expiresInSeconds: 600 });
  const id = result.reservationId as string;
  clock.ms = START + 700_000;
  await assert.rejects(
    quota.settle(RENDERER, accountId, id, { operationId: randomUUID(), actualCents: 300 }),
    refusedWith(409, "reservation_expired"),
  );
  const late = await quota.settle(RENDERER, accountId, id, {
    operationId: randomUUID(),
    actualCents: 300,
    allowOverage: true,
  });
  assert.deepEqual(
    [late.result.status, late.result.chargedCents, late.result.releasedCents, late.result.overageCents],
    ["settled_late", 300, 0, 300],
  );
  const summary = await quota.summary(accountId);
  assert.deepEqual([summary?.usedCents, summary?.overageCents, summary?.heldCents], [300, 300, 0]);
});

test("releasing an expired reservation is harmless and leaves no hold", async () => {
  const { quota, accountId, clock, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  const { result } = await reserve(400, { expiresInSeconds: 60 });
  clock.ms = START + 120_000;
  const released = await quota.release(RENDERER, accountId, result.reservationId as string, {
    operationId: randomUUID(),
  });
  assert.equal(released.result.status, "released");
  assert.equal((await quota.summary(accountId))?.remainingCents, 1000);
});

test("expired holds are dropped, and journaled, only when the record needs room; active holds never are", async () => {
  const { files, quota, accountId, clock, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(100_000_000);
  const first = await reserve(1, { expiresInSeconds: 60 });
  // Fill the record with holds that will expire, until it refuses another live one.
  await assert.rejects(
    (async () => {
      for (;;) await reserve(1, { expiresInSeconds: 60 });
    })(),
    refusedWith(409, "quota_capacity"),
  );
  clock.ms = START + 120_000;
  const active = await reserve(1, { expiresInSeconds: 3600 });
  const expiryEvents = [...files.objects.values()].filter(
    (object) => object.value.action === "reservation.expired",
  );
  assert.ok(expiryEvents.length > 0, "some expired holds were dropped and journaled");
  assert.equal((await quota.summary(accountId))?.heldCents, 1);
  await assert.rejects(
    quota.settle(RENDERER, accountId, first.result.reservationId as string, {
      operationId: randomUUID(),
      actualCents: 1,
      allowOverage: true,
    }),
    refusedWith(409, "reservation_not_open"),
    "a reclaimed reservation can no longer be settled",
  );
  assert.equal(
    (
      await quota.release(RENDERER, accountId, active.result.reservationId as string, {
        operationId: randomUUID(),
      })
    ).result.status,
    "released",
  );
});

test("a full record of active reservations refuses a new one instead of dropping a live hold", async () => {
  const { quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(100_000_000);
  let refused: unknown;
  for (let index = 0; index < 600 && !refused; index++)
    await reserve(1, { expiresInSeconds: 3600 }).catch((error) => (refused = error));
  assert.ok(refusedWith(409, "quota_capacity")(refused));
  assert.ok((await quota.summary(accountId))!.heldCents > 100);
});

test("an unknown account is refused, even for an operator grant", async () => {
  const { quota, ada, reserve } = quotaFixture();
  const stranger = randomUUID();
  await assert.rejects(reserve(1, {}, RENDERER, stranger), refusedWith(404, "account_missing"));
  await assert.rejects(
    quota.grant(ada, stranger, { operationId: randomUUID(), allowanceCents: 100 }),
    refusedWith(404, "account_missing"),
  );
});

test("an account with no allowance is refused", async () => {
  const { quota, accountId, reserve } = quotaFixture();
  await assert.rejects(reserve(1), refusedWith(403, "no_allowance"));
  assert.equal(await quota.summary(accountId), null);
});

test("an account with an allowance of zero is refused", async () => {
  const { reserve, grantAllowance } = quotaFixture();
  await grantAllowance(0);
  await assert.rejects(reserve(1), refusedWith(402, "quota_insufficient"));
});

test("a product the account is not entitled to cannot reserve, and a disabled entitlement is refused", async () => {
  const { accountId, entitlements, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  await assert.rejects(
    reserve(1, {}, { product: "example-other" }),
    refusedWith(403, "product_not_entitled"),
  );
  entitlements[accountId]["example-renderer"].status = "disabled";
  await assert.rejects(reserve(1), refusedWith(403, "product_not_entitled"));
});

test("another product cannot settle or release a reservation", async () => {
  const { quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  const { result } = await reserve(400);
  const id = result.reservationId as string;
  await assert.rejects(
    quota.settle(NARRATOR, accountId, id, { operationId: randomUUID(), actualCents: 1 }),
    refusedWith(403, "wrong_product"),
  );
  await assert.rejects(
    quota.release(NARRATOR, accountId, id, { operationId: randomUUID() }),
    refusedWith(403, "wrong_product"),
  );
  assert.equal((await quota.summary(accountId))?.heldCents, 400);
});

test("one allowance is shared by every product, and the summary splits it by product", async () => {
  const { quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  const render = await reserve(600);
  await assert.rejects(reserve(500, {}, NARRATOR), refusedWith(402, "quota_insufficient"));
  await reserve(400, {}, NARRATOR);
  await quota.settle(RENDERER, accountId, render.result.reservationId as string, {
    operationId: randomUUID(),
    actualCents: 200,
  });
  const summary = await quota.summary(accountId);
  assert.deepEqual(summary?.byProduct, [
    { product: "example-narrator", usedCents: 0, heldCents: 400 },
    { product: "example-renderer", usedCents: 200, heldCents: 0 },
  ]);
});

test("amounts must be whole cents, and an unreasonable lifetime is refused", async () => {
  const { quota, accountId, grantAllowance, reserve } = quotaFixture({ quota: { maximumHoldSeconds: 7200 } });
  await grantAllowance(1000);
  for (const maxCents of [0, -1, 1.5, "10", null, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(reserve(maxCents as number), refusedWith(400, "invalid_amount"));
  for (const expiresInSeconds of [0, -5, 1.5, "60", 7201])
    await assert.rejects(reserve(1, { expiresInSeconds }), refusedWith(400, "invalid_expiry"));
  await assert.rejects(
    quota.reserve(RENDERER, accountId, { operationId: "not-a-uuid", maxCents: 1, expiresInSeconds: 60 }),
    refusedWith(400, "invalid_operation_id"),
  );
  assert.equal((await reserve(1, { expiresInSeconds: 7200 })).result.status, "reserved");
});

test("an unavailable store means refusal: no read or write failure ever looks like success", async () => {
  const { files, quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  const { result } = await reserve(100);
  const realGet = files.get.bind(files),
    realCommit = files.commit.bind(files);
  files.get = async () => {
    throw new IdentityFileError("unavailable");
  };
  await assert.rejects(reserve(1), (error: any) => !(error instanceof QuotaError));
  await assert.rejects(
    quota.settle(RENDERER, accountId, result.reservationId as string, {
      operationId: randomUUID(),
      actualCents: 1,
    }),
  );
  assert.deepEqual(await quota.view(accountId), { state: "unavailable" });
  files.get = realGet;
  files.commit = async () => {
    throw new IdentityFileError("unavailable");
  };
  await assert.rejects(reserve(1));
  files.commit = realCommit;
  assert.equal((await quota.summary(accountId))?.heldCents, 100, "the failed reserve held nothing");
});

test("an operator grant sets the account's allowance, is journaled with the reviewed grant, and repeats safely", async () => {
  const { files, quota, accountId, ada } = quotaFixture();
  const input = { operationId: randomUUID(), allowanceCents: 2500 };
  const first = await quota.grant(ada, accountId, input);
  const second = await quota.grant(ada, accountId, input);
  assert.deepEqual(second.result, first.result);
  assert.deepEqual(first.result, { accountId, unit: "usd-cents", allowanceCents: 2500 });
  const events = [...files.objects.values()]
    .map((object) => object.value)
    .filter((value) => value.action === "allowance.granted");
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, "operator:synthetic-ada-quota");
  assert.deepEqual((await quota.view(accountId)).state, "set");
  await assert.rejects(
    quota.grant(ada, accountId, { ...input, allowanceCents: 1 }),
    refusedWith(409, "idempotency_conflict"),
  );
});

test("lowering an allowance below what is used and held keeps holds but refuses new reservations", async () => {
  const { quota, accountId, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(1000);
  await reserve(800);
  await grantAllowance(500);
  const summary = await quota.summary(accountId);
  assert.deepEqual([summary?.heldCents, summary?.remainingCents], [800, -300]);
  await assert.rejects(reserve(1), refusedWith(402, "quota_insufficient"));
});

test("only an operator with the reviewed quota permission may grant", async () => {
  const { quota, accountId } = quotaFixture();
  for (const subject of ["reader", "entitler", "nobody"])
    await assert.rejects(
      quota.grant(operator(subject), accountId, { operationId: randomUUID(), allowanceCents: 1 }),
      refusedWith(403, "operator_forbidden"),
    );
  await assert.rejects(
    quota.grant(operator("ada"), accountId, { operationId: randomUUID(), allowanceCents: -1 }),
    refusedWith(400, "invalid_amount"),
  );
});

test("every mutation writes one journal event and a refusal writes none", async () => {
  const { files, accountId, quota, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(100);
  const { result } = await reserve(50);
  await assert.rejects(reserve(100));
  await quota.settle(RENDERER, accountId, result.reservationId as string, {
    operationId: randomUUID(),
    actualCents: 20,
  });
  const actions = [...files.objects.values()]
    .map((object) => object.value)
    .filter((value) => value.kind === "quota-journal-event")
    .map((value) => value.action)
    .sort();
  assert.deepEqual(actions, ["allowance.granted", "reservation.reserved", "reservation.settled"]);
});

test("allowance and journal files are kept apart from billing and accounts paths", async () => {
  const { files, grantAllowance, reserve } = quotaFixture();
  await grantAllowance(100);
  await reserve(10);
  for (const path of files.objects.keys()) assert.match(path, /^(allowances|journal)\//);
});
