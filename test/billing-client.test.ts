import { test } from "node:test";
import assert from "node:assert/strict";
import { billingBrowser, unavailableBilling } from "../src/billing/client";
import { BillingError } from "../src/billing/types";
import { syntheticBilling } from "../src/billing/synthetic";

test("a deployment with no billing routes reports itself unavailable and refuses without a request", async () => {
  assert.equal(unavailableBilling.available, false);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}");
  }) as typeof fetch;
  try {
    await assert.rejects(unavailableBilling.overview(), BillingError);
    await assert.rejects(unavailableBilling.recordPayment({} as never), BillingError);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("the HTTP client uses the operator routes, sends integer cents and carries the operation id", async () => {
  const seen: Array<{ url: string; method: string; body: any; authorization: string }> = [];
  const client = billingBrowser(
    "https://directory.example/v1/account-directory/",
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: (init?.headers as Record<string, string>).authorization,
      });
      return new Response(JSON.stringify({ payment: { id: "p1" } }), { status: 200 });
    }) as typeof fetch,
    () => "token",
  );
  assert.equal(client.available, true);
  const payment = await client.recordPayment({
    operationId: "op-1",
    accountId: "acc 1",
    amountCents: 123456,
    method: "check",
    receivedAt: "2026-11-05",
    allocations: [{ invoiceId: "i1", amountCents: 123456 }],
  });
  assert.equal(payment.id, "p1");
  assert.equal(
    seen[0].url,
    "https://directory.example/v1/account-directory/operator/accounts/acc%201/payments",
  );
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].body.operationId, "op-1");
  assert.equal(seen[0].body.amountCents, 123456);
  assert.ok(Number.isInteger(seen[0].body.allocations[0].amountCents));
  assert.equal(seen[0].authorization, "Bearer token");
});

test("a refusal keeps the server's words and a missing sign-in is a 401 with no request", async () => {
  const refused = billingBrowser(
    "https://directory.example",
    (async () =>
      new Response(
        JSON.stringify({ message: "202611-002 already bills that period.", code: "period_taken" }),
        {
          status: 409,
        },
      )) as typeof fetch,
    () => "token",
  );
  await assert.rejects(refused.raiseInvoice({} as never), (error: BillingError) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "period_taken");
    assert.match(error.message, /202611-002/);
    return true;
  });
  let calls = 0;
  const signedOut = billingBrowser(
    "https://directory.example",
    (async () => (calls++, new Response("{}"))) as typeof fetch,
    () => null,
  );
  await assert.rejects(signedOut.overview(), (error: BillingError) => error.status === 401);
  assert.equal(calls, 0);
});

test("the synthetic ledger enforces the same rules the form shows", async () => {
  const client = syntheticBilling({ today: "2026-11-05" });
  const { accounts, invoices } = await client.overview();
  const harbor = accounts[0].id;
  const open = invoices.filter((invoice) => invoice.accountId === harbor && invoice.balanceCents > 0);
  const [late, current] = [...open].sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
  // A second November invoice names the first.
  await assert.rejects(
    client.raiseInvoice({
      operationId: "op-a",
      accountId: harbor,
      period: "2026-11",
      lineItems: [{ description: "x", quantity: 1, unitAmountCents: 100 }],
      netTermsDays: 30,
      issuedVia: "manual",
      draft: false,
    }),
    (error: BillingError) => error.code === "period_taken" && /202611-002/.test(error.message),
  );
  // Over-allocation writes nothing.
  await assert.rejects(
    client.recordPayment({
      operationId: "op-b",
      accountId: harbor,
      amountCents: 100000,
      method: "check",
      receivedAt: "2026-11-05",
      allocations: [{ invoiceId: late.id, amountCents: 100001 }],
    }),
    (error: BillingError) => error.code === "over_allocation",
  );
  assert.equal((await client.invoice(late.number!)).invoice.balanceCents, 400000);
  // A check split across two invoices updates both balances and leaves no remainder; a retry records nothing twice.
  const input = {
    operationId: "op-c",
    accountId: harbor,
    amountCents: 500000,
    method: "check" as const,
    receivedAt: "2026-11-05",
    allocations: [
      { invoiceId: late.id, amountCents: 400000 },
      { invoiceId: current.id, amountCents: 100000 },
    ],
  };
  const payment = await client.recordPayment(input);
  await client.recordPayment(input);
  assert.equal(payment.unallocatedCents, 0);
  assert.equal((await client.invoice(late.number!)).invoice.status, "paid");
  assert.equal((await client.invoice(current.number!)).invoice.balanceCents, 550000);
  assert.equal((await client.overview()).payments.filter((entry) => entry.id === payment.id).length, 1);
});

test("a read-only operator's writes are refused", async () => {
  const client = syntheticBilling({ today: "2026-11-05", readOnly: true });
  assert.ok(!(await client.access()).permissions.includes("accounts:admin:billing"));
  await assert.rejects(client.saveIssuer({} as never), (error: BillingError) => error.status === 403);
});
