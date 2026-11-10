import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalAccountsHandler } from "../accounts/canonical-handler";
import { VirtuusAccountFiles, VirtuusBillingFiles, VirtuusIdentityFiles } from "../accounts/identity-files";
import { operatorGrants, operatorSubjectHash, type OperatorPermission } from "../accounts/operator-policy";
import { directoryFixture } from "../accounts/testing/directory-fixture";
import { billingDeployment } from "./deployment";
import { CONTACT_MARKER, contact, issuerFields } from "./testing/billing-fixture";
import reviewedDeployment from "./deployment.json";

const BASE = "/v1/account-directory/operator";
const PAY_LINK = "https://pay.example.com/placeholder-link";

/** The real central handler over pinned Virtuus files, with the given reviewed grants and billing storage (or none). */
async function central(permissions: OperatorPermission[], enabled: boolean) {
  const environment = await directoryFixture();
  const handler = canonicalAccountsHandler(
    new VirtuusIdentityFiles(environment.root),
    new VirtuusAccountFiles(environment.root),
    environment.products,
    environment.identityFixture.keys,
    () => environment.identityFixture.now,
    operatorGrants(
      permissions.map((permission) => ({
        product: environment.outsider.context.product,
        issuer: environment.outsider.context.human.issuer,
        subjectHash: operatorSubjectHash(environment.outsider.context.human.subject),
        permission,
        reviewedGrantId: `synthetic-${permission.split(":").pop()}-v1`,
      })),
    ),
    "scan",
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    enabled ? new VirtuusBillingFiles(environment.root) : undefined,
  );
  const call = async (
    actor: { proof: { access: string; id: string } },
    method: string,
    path: string,
    body: unknown = {},
    headers: Record<string, string> = {},
  ) => {
    const event = environment.identityFixture.event(0, `${BASE}${path}`, body, actor.proof, method);
    Object.assign(event.headers!, headers);
    if (method === "GET") event.body = null;
    const response = await handler(event);
    return {
      status: response.statusCode,
      body: response.body && !(response as any).isBase64Encoded ? JSON.parse(response.body) : response.body,
      raw: response as any,
    };
  };
  return {
    environment,
    call,
    operator: environment.outsider,
    stranger: environment.ownerDirectory,
    accountId: environment.account.id,
  };
}
const lines = [{ description: "Example site, November", quantity: 1, unitAmountCents: 120000 }];

test("the committed deployment flag is on by Ryan's approval, and only its exact shape is accepted", () => {
  assert.deepEqual(reviewedDeployment, { ledger: { enabled: true } });
  assert.equal(billingDeployment(reviewedDeployment).ledgerEnabled, true);
  assert.equal(billingDeployment({ ledger: { enabled: false } }).ledgerEnabled, false);
  assert.equal(billingDeployment({ ledger: { enabled: true } }).ledgerEnabled, true);
  for (const bad of [
    null,
    {},
    { ledger: {} },
    { ledger: { enabled: "yes" } },
    { ledger: { enabled: true, extra: 1 } },
    { ledger: { enabled: true }, stripe: {} },
  ])
    assert.throws(() => billingDeployment(bad));
});

test("with the flag off every operator billing route answers 404, even for a billing admin", async () => {
  const { call, operator, accountId } = await central(
    ["accounts:admin:read", "accounts:admin:billing"],
    false,
  );
  for (const [method, path] of [
    ["GET", "/billing/access"],
    ["GET", "/billing/invoices"],
    ["GET", "/billing/issuer"],
    ["PUT", "/billing/issuer"],
    ["GET", `/accounts/${accountId}/invoices`],
    ["POST", `/accounts/${accountId}/payments`],
    ["GET", `/accounts/${accountId}/billing-profile`],
  ])
    assert.equal((await call(operator, method, path)).status, 404, `${method} ${path}`);
  // The rest of the operator directory is untouched.
  assert.equal((await call(operator, "GET", "/accounts")).status, 200);
});

test("billing runs end to end through the central handler over real files, with grants enforced on every route", async () => {
  const { call, operator, stranger, accountId } = await central(
    ["accounts:admin:read", "accounts:admin:billing"],
    true,
  );
  const operation = () => ({ operationId: randomUUID() });

  assert.deepEqual((await call(operator, "GET", "/billing/access")).body.permissions.sort(), [
    "accounts:admin:billing",
    "accounts:admin:read",
  ]);
  // Nothing without an operator grant.
  for (const [method, path] of [
    ["GET", "/billing/invoices"],
    ["GET", `/accounts/${accountId}/invoices`],
    ["GET", "/billing/issuer"],
  ])
    assert.equal((await call(stranger, method, path)).status, 403);
  assert.equal(
    (await call(stranger, "POST", `/accounts/${accountId}/payments`, { ...operation(), amountCents: 1 }))
      .status,
    403,
  );

  // Issuer and profile.
  const issuer = await call(operator, "PUT", "/billing/issuer", {
    ...operation(),
    ...issuerFields({
      paymentMethods: [{ label: "Melio", instructions: `Pay at ${PAY_LINK}`, offered: true }],
      expectedRevision: 0,
    }),
  });
  assert.equal(issuer.status, 200, JSON.stringify(issuer.body));
  assert.equal(issuer.body.revision, 1);
  assert.equal(
    (
      await call(operator, "PUT", "/billing/issuer", {
        ...operation(),
        ...issuerFields({
          paymentMethods: [{ label: "x", instructions: "http://pay.example.com", offered: true }],
          expectedRevision: 1,
        }),
      })
    ).status,
    400,
  );
  const noContact = await call(operator, "PUT", `/accounts/${accountId}/billing-profile`, {
    ...operation(),
    mode: "invoiced",
  });
  assert.equal(noContact.body.error, "billing_contact_required");
  const profile = await call(operator, "PUT", `/accounts/${accountId}/billing-profile`, {
    ...operation(),
    mode: "invoiced",
    billingContact: contact(),
  });
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  assert.ok(!JSON.stringify(profile.body).includes(CONTACT_MARKER), "the contact is masked");

  // Raise an invoice the way the console does.
  const raise = operation();
  const raised = await call(operator, "POST", `/accounts/${accountId}/invoices`, {
    ...raise,
    accountId,
    period: "2026-11",
    lineItems: lines,
    netTermsDays: 30,
    issuedVia: "manual",
    draft: false,
  });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  const invoice = raised.body.invoice;
  assert.match(invoice.number, /^\d{6}-001$/);
  assert.equal(invoice.status, "issued");
  assert.equal(invoice.balanceCents, 120000);
  const again = await call(operator, "POST", `/accounts/${accountId}/invoices`, {
    ...raise,
    accountId,
    period: "2026-11",
    lineItems: lines,
    netTermsDays: 30,
    issuedVia: "manual",
    draft: false,
  });
  assert.equal(again.body.invoice.id, invoice.id, "a replay returns the same invoice");
  // An invoice already sent outside Prospectus keeps its number and issue date, through the same route.
  const sent = await call(operator, "POST", `/accounts/${accountId}/invoices`, {
    ...operation(),
    accountId,
    lineItems: lines,
    netTermsDays: 30,
    issuedVia: "manual",
    draft: false,
    alreadySent: { number: "202610-001", issueDate: "2026-10-31" },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.invoice.number, "202610-001");
  assert.equal(sent.body.invoice.status, "issued");
  assert.equal(sent.body.invoice.issuedAt, "2026-10-31");
  assert.equal(sent.body.invoice.dueAt, "2026-11-30");
  for (const alreadySent of [
    { number: "202611-002", issueDate: "2026-10-31" },
    { number: "202610-001", issueDate: "2026-10-31" },
    { number: "202610-009", issueDate: "2026-10-31", extra: 1 },
  ])
    assert.equal(
      (
        await call(operator, "POST", `/accounts/${accountId}/invoices`, {
          ...operation(),
          accountId,
          lineItems: lines,
          issuedVia: "manual",
          draft: false,
          alreadySent,
        })
      ).status,
      alreadySent.number === "202610-001" ? 409 : 400,
      JSON.stringify(alreadySent),
    );
  assert.equal(
    (
      await call(operator, "POST", `/accounts/${accountId}/invoices`, {
        ...operation(),
        accountId,
        period: "2026-11",
        lineItems: lines,
        issuedVia: "manual",
        draft: true,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(operator, "POST", `/accounts/${accountId}/invoices`, {
        ...operation(),
        accountId,
        lineItems: lines,
        issuedVia: "stripe",
        draft: true,
      })
    ).body.error,
    "stripe_unavailable",
  );

  const detail = await call(operator, "GET", `/billing/invoices/${invoice.number}`);
  assert.equal(detail.body.invoice.id, invoice.id);
  assert.equal(detail.body.account.billable, true);
  assert.ok(!JSON.stringify(detail.body).includes(CONTACT_MARKER));
  assert.equal((await call(operator, "GET", `/billing/invoices/${invoice.id}`)).status, 200);

  // The PDF, as a binary response and as the JSON the BFF can relay.
  const pdf = await call(
    operator,
    "GET",
    `/billing/invoices/${invoice.number}/pdf`,
    {},
    { accept: "application/pdf" },
  );
  assert.equal(pdf.status, 200);
  assert.equal(pdf.raw.isBase64Encoded, true);
  assert.equal(pdf.raw.headers["Content-Type"], "application/pdf");
  assert.ok(Buffer.from(pdf.raw.body, "base64").subarray(0, 5).toString() === "%PDF-");
  assert.ok(Buffer.from(pdf.raw.body, "base64").toString("latin1").includes(`/URI (${PAY_LINK})`));
  assert.equal(
    (await call(operator, "GET", `/billing/invoices/${invoice.number}/pdf`)).body.contentType,
    "application/pdf",
  );

  // Record a payment split across the invoice, then allocate the rest, then reverse.
  const recorded = await call(operator, "POST", `/accounts/${accountId}/payments`, {
    ...operation(),
    accountId,
    amountCents: 100000,
    method: "melio",
    receivedAt: "2026-11-03",
    reference: "EX-1",
    allocations: [{ invoiceId: invoice.id, amountCents: 50000 }],
  });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  const payment = recorded.body.payment;
  assert.equal(payment.unallocatedCents, 50000);
  assert.equal(payment.allocations[0].invoiceNumber, invoice.number);
  assert.equal(payment.allocations[0].paymentLabel, "Melio EX-1");
  assert.equal(
    (
      await call(operator, "POST", `/accounts/${accountId}/payments`, {
        ...operation(),
        accountId,
        amountCents: 5,
        method: "stripe_card",
        receivedAt: "2026-11-03",
      })
    ).body.error,
    "stripe_payments_by_webhook",
  );
  assert.equal(
    (
      await call(operator, "POST", `/billing/payments/${payment.id}/allocations`, {
        ...operation(),
        allocations: [{ invoiceId: invoice.id, amountCents: 70001 }],
        expectedRevision: payment.revision,
      })
    ).body.error,
    "over_allocation",
  );
  assert.equal(
    (
      await call(operator, "POST", `/billing/payments/${payment.id}/allocations`, {
        ...operation(),
        allocations: [{ invoiceId: invoice.id, amountCents: 100 }],
        expectedRevision: 99,
      })
    ).body.error,
    "revision_conflict",
  );
  const allocated = await call(operator, "POST", `/billing/payments/${payment.id}/allocations`, {
    ...operation(),
    allocations: [{ invoiceId: invoice.id, amountCents: 50000 }],
    expectedRevision: payment.revision,
  });
  assert.equal(allocated.body.payment.unallocatedCents, 0);
  assert.equal(
    (await call(operator, "GET", `/billing/invoices/${invoice.number}`)).body.invoice.balanceCents,
    20000,
  );

  const listed = await call(operator, "GET", "/billing/payments");
  assert.equal(listed.body.payments.length, 1);
  // The November invoice and the already-sent October one are both open.
  assert.equal((await call(operator, "GET", `/billing/payments/${payment.id}`)).body.openInvoices.length, 2);

  const reversed = await call(operator, "POST", `/billing/payments/${payment.id}/reversal`, {
    ...operation(),
    reason: "Payment failed",
    expectedRevision: allocated.body.payment.revision,
  });
  assert.equal(reversed.status, 200, JSON.stringify(reversed.body));
  assert.equal(reversed.body.payment.reversal.reason, "Payment failed");
  assert.equal(reversed.body.payment.unallocatedCents, 0);
  assert.ok(reversed.body.payment.allocations.some((allocation: any) => allocation.reversal_of));
  assert.equal(
    (await call(operator, "GET", "/billing/payments")).body.payments.length,
    1,
    "a reversal is not a payment of its own",
  );
  assert.equal(
    (await call(operator, "GET", `/billing/invoices/${invoice.number}`)).body.invoice.balanceCents,
    120000,
  );

  // Write-off keeps the invoice on record, apart from outstanding.
  const written = await call(operator, "POST", `/billing/invoices/${invoice.id}/write-off`, {
    ...operation(),
    reason: "Client closed",
  });
  assert.equal(written.body.invoice.status, "uncollectible");

  // Listings and the journal.
  assert.deepEqual(
    (await call(operator, "GET", "/billing/invoices")).body.invoices.map((entry: any) => entry.number).sort(),
    ["202610-001", invoice.number].sort(),
  );
  assert.equal(
    (await call(operator, "GET", "/billing/accounts")).body.accounts.find(
      (entry: any) => entry.id === accountId,
    ).mode,
    "invoiced",
  );
  assert.equal((await call(operator, "GET", `/billing/accounts/${accountId}`)).body.account.id, accountId);
  assert.equal((await call(operator, "GET", `/accounts/${accountId}/billing-lines`)).body.lines.length, 0);
  const actions = (await call(operator, "GET", `/accounts/${accountId}/billing-journal`)).body.events.map(
    (event: any) => event.action,
  );
  for (const action of [
    "invoice.drafted",
    "invoice.issued",
    "payment.recorded",
    "payment.allocated",
    "payment.reversed",
    "invoice.written_off",
  ])
    assert.ok(actions.includes(action), action);

  // The reveal is a recorded write.
  const reveal = await call(operator, "POST", `/accounts/${accountId}/billing-profile/reveal-contact`, {});
  assert.equal(reveal.status, 200);
  assert.ok(JSON.stringify(reveal.body).includes(CONTACT_MARKER));
  assert.equal(
    (await call(operator, "GET", `/accounts/${accountId}/billing-profile`)).body.profile.revision,
    1,
  );
});

test("an operator with only accounts:admin:read sees billing read-only and masked; every write is 403", async () => {
  const { call, operator, accountId, environment } = await central(["accounts:admin:billing"], true);
  const seeded = await call(operator, "PUT", `/accounts/${accountId}/billing-profile`, {
    operationId: randomUUID(),
    mode: "invoiced",
    billingContact: contact(),
  });
  assert.equal(seeded.status, 200);
  // A second central over the same files, where the operator holds only the read permission.
  const readOnly = canonicalAccountsHandler(
    new VirtuusIdentityFiles(environment.root),
    new VirtuusAccountFiles(environment.root),
    environment.products,
    environment.identityFixture.keys,
    () => environment.identityFixture.now,
    operatorGrants([
      {
        product: operator.context.product,
        issuer: operator.context.human.issuer,
        subjectHash: operatorSubjectHash(operator.context.human.subject),
        permission: "accounts:admin:read",
        reviewedGrantId: "synthetic-read-v1",
      },
    ]),
    "scan",
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    new VirtuusBillingFiles(environment.root),
  );
  const send = async (method: string, path: string, body: unknown = {}) => {
    const event = environment.identityFixture.event(0, `${BASE}${path}`, body, operator.proof, method);
    if (method === "GET") event.body = null;
    const response = await handler(event);
    return { status: response.statusCode, body: JSON.parse(response.body) };
    function handler(value: typeof event) {
      return readOnly(value);
    }
  };
  const profile = await send("GET", `/accounts/${accountId}/billing-profile`);
  assert.equal(profile.status, 200);
  assert.ok(!JSON.stringify(profile.body).includes(CONTACT_MARKER));
  assert.equal((await send("GET", "/billing/invoices")).status, 200);
  assert.deepEqual((await send("GET", "/billing/access")).body.permissions, ["accounts:admin:read"]);
  for (const [method, path, body] of [
    ["PUT", "/billing/issuer", { operationId: randomUUID(), ...issuerFields({ expectedRevision: 0 }) }],
    ["PUT", `/accounts/${accountId}/billing-profile`, { operationId: randomUUID(), mode: "invoiced" }],
    ["POST", `/accounts/${accountId}/invoices`, { operationId: randomUUID(), lineItems: lines, draft: true }],
    [
      "POST",
      `/accounts/${accountId}/payments`,
      { operationId: randomUUID(), amountCents: 1, method: "cash", receivedAt: "2026-11-03" },
    ],
    ["POST", `/accounts/${accountId}/billing-profile/reveal-contact`, {}],
    ["POST", `/billing/payments/${randomUUID()}/reversal`, { operationId: randomUUID(), reason: "x" }],
    ["POST", `/billing/invoices/${randomUUID()}/write-off`, { operationId: randomUUID(), reason: "x" }],
  ] as const) {
    const refused = await send(method, path, body);
    assert.equal(refused.status, 403, `${method} ${path}`);
  }
});

test("engagements start, change, end and are billed through the central handler over real files", async () => {
  const { call, operator, stranger, accountId } = await central(
    ["accounts:admin:read", "accounts:admin:billing"],
    true,
  );
  const operation = () => ({ operationId: randomUUID() });
  await call(operator, "PUT", "/billing/issuer", {
    ...operation(),
    ...issuerFields({ expectedRevision: 0 }),
  });
  await call(operator, "PUT", `/accounts/${accountId}/billing-profile`, {
    ...operation(),
    mode: "invoiced",
    billingContact: contact(),
  });
  const start = operation();
  const body = {
    ...start,
    accountId,
    name: "Reporting desk support",
    type: "ongoing",
    lead: "Example Lead",
    startDate: "2026-10-01",
    monthlyAmountCents: 1000000,
  };
  assert.equal((await call(stranger, "POST", `/accounts/${accountId}/engagements`, body)).status, 403);
  const created = await call(operator, "POST", `/accounts/${accountId}/engagements`, body);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const engagement = created.body.engagement;
  assert.equal(engagement.status, "active");
  assert.equal(engagement.monthlyAmountCents, 1000000);
  const replay = await call(operator, "POST", `/accounts/${accountId}/engagements`, body);
  assert.equal(replay.body.engagement.id, engagement.id, "a replay returns the same engagement");
  assert.equal(
    (await call(operator, "POST", `/accounts/${accountId}/engagements`, { ...operation(), type: "ongoing" }))
      .body.error,
    "invalid_engagement",
  );

  // Already sent outside Prospectus, with its line naming the engagement.
  const sent = await call(operator, "POST", `/accounts/${accountId}/invoices`, {
    ...operation(),
    accountId,
    lineItems: [
      {
        description: "Reporting desk support, monthly retainer",
        quantity: 1,
        unitAmountCents: 1000000,
        period: "October 1–31, 2026",
        engagementId: engagement.id,
      },
    ],
    netTermsDays: 30,
    issuedVia: "manual",
    draft: false,
    alreadySent: { number: "202610-001", issueDate: "2026-10-31" },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.invoice.lineItems[0].engagementId, engagement.id);

  const listed = await call(operator, "GET", `/accounts/${accountId}/engagements`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.engagements.length, 1);
  assert.equal(listed.body.engagements[0].lastInvoiced.invoiceNumber, "202610-001");
  const all = await call(operator, "GET", "/billing/engagements");
  assert.deepEqual(
    all.body.engagements.map((entry: { id: string }) => entry.id),
    [engagement.id],
  );
  assert.equal((await call(stranger, "GET", "/billing/engagements")).status, 403);
  assert.equal((await call(operator, "GET", `/billing/engagements/${engagement.id}`)).status, 200);

  const stale = await call(operator, "POST", `/billing/engagements/${engagement.id}`, {
    ...operation(),
    lead: "Someone else",
    expectedRevision: engagement.revision + 5,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "revision_conflict");
  const ended = await call(operator, "POST", `/billing/engagements/${engagement.id}`, {
    ...operation(),
    status: "ended",
    endDate: "2026-12-31",
    expectedRevision: engagement.revision,
  });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.equal(ended.body.engagement.status, "ended");
  assert.equal(ended.body.engagement.endDate, "2026-12-31");
  const journal = await call(operator, "GET", `/accounts/${accountId}/billing-journal`);
  assert.deepEqual(
    journal.body.events
      .map((event: { action: string }) => event.action)
      .filter((action: string) => action.startsWith("engagement.")),
    ["engagement.ended", "engagement.created"],
  );
});
