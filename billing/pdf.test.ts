import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { renderInvoicePdf } from "./pdf";
import { BillingError } from "./model";
import { billingFixture, issuerFields, lineItems, operator, profileInput } from "./testing/billing-fixture";

const ada = operator("ada");
const PAY_LINK = "https://pay.example.com/placeholder-link";
const methods = [
  { label: "Bank transfer", instructions: "Account 000000 (placeholder)", offered: true },
  { label: "Melio", instructions: `Pay online: ${PAY_LINK}.`, offered: true },
];
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

async function issuedInvoice(overrides: Record<string, unknown> = {}) {
  const fixture = billingFixture();
  await fixture.profiles.set(ada, fixture.accountId, profileInput(), randomUUID());
  await fixture.issuer.set(ada, issuerFields({ paymentMethods: methods, ...overrides }), randomUUID());
  const { invoice } = await fixture.ledger.raise(
    ada,
    fixture.accountId,
    {
      lineItems: lineItems([
        { description: "Example site, November", quantity: 2, unitAmountCents: 25000 },
        { description: "word ".repeat(38), quantity: 1, unitAmountCents: 70000 },
      ]),
      draft: false,
      issueDate: "2026-11-02",
    },
    randomUUID(),
  );
  return { fixture, invoice };
}

test("the PDF is a valid document rendered from the issued record, with a clickable https payment link", async () => {
  const { invoice } = await issuedInvoice();
  const bytes = await renderInvoicePdf(invoice, { name: "Example Client", addressLines: ["1 Example Way"] });
  const raw = text(bytes);
  assert.ok(raw.startsWith("%PDF-"));
  assert.ok(raw.trimEnd().endsWith("%%EOF"));
  assert.match(raw, /\/Subtype \/Link/);
  assert.ok(
    raw.includes(`/URI (${PAY_LINK})`),
    "the link is a URI annotation without the trailing full stop",
  );
  const parsed = await PDFDocument.load(bytes);
  assert.equal(parsed.getTitle(), `Invoice ${invoice.number}`);
  assert.ok(parsed.getPageCount() >= 1);
  // Rendering is deterministic.
  assert.deepEqual(
    Buffer.from(await renderInvoicePdf(invoice, { name: "Example Client", addressLines: ["1 Example Way"] })),
    Buffer.from(bytes),
  );
});

test("a later issuer change leaves the PDF of an issued invoice unchanged", async () => {
  const { fixture, invoice } = await issuedInvoice();
  const before = await renderInvoicePdf(invoice);
  await fixture.issuer.set(
    ada,
    issuerFields({
      issuer: {
        legalName: "Changed LLC",
        billingEmail: "billing@changed.example.invalid",
        addressLines: ["2 Other Road"],
      },
      paymentMethods: [{ label: "Check", instructions: "Mail it", offered: true }],
      expectedRevision: 1,
    }),
    randomUUID(),
  );
  const after = await renderInvoicePdf((await fixture.ledger.invoice(invoice.id))!);
  assert.deepEqual(Buffer.from(after), Buffer.from(before));
  assert.ok(text(after).includes(PAY_LINK));
});

test("a draft has no PDF", async () => {
  const fixture = billingFixture();
  await fixture.profiles.set(ada, fixture.accountId, profileInput(), randomUUID());
  const { invoice } = await fixture.ledger.createDraft(
    ada,
    fixture.accountId,
    { lineItems: lineItems() },
    randomUUID(),
  );
  await assert.rejects(
    renderInvoicePdf(invoice),
    (error: any) => error instanceof BillingError && error.code === "invoice_not_issued",
  );
});

test("a long invoice flows onto further pages, and unusual characters do not break the render", async () => {
  const fixture = billingFixture();
  await fixture.profiles.set(ada, fixture.accountId, profileInput(), randomUUID());
  await fixture.issuer.set(ada, issuerFields(), randomUUID());
  const items = Array.from({ length: 50 }, (_, index) => ({
    description: `Line ${index} ☃ café 中文`,
    quantity: 1,
    unitAmountCents: 100 + index,
  }));
  const { invoice } = await fixture.ledger.raise(
    ada,
    fixture.accountId,
    { lineItems: items, draft: false },
    randomUUID(),
  );
  const parsed = await PDFDocument.load(await renderInvoicePdf(invoice));
  assert.ok(parsed.getPageCount() >= 2);
});

test("issuer payment instructions may hold https links and nothing else", async () => {
  const fixture = billingFixture();
  const set = (instructions: string) =>
    fixture.issuer.set(
      ada,
      issuerFields({ paymentMethods: [{ label: "Pay", instructions, offered: true }] }),
      randomUUID(),
    );
  await set(`Pay at ${PAY_LINK} or by bank transfer. Note: reference the invoice number.`);
  for (const bad of [
    "Pay at http://pay.example.com/x",
    "javascript:alert(1)",
    "Click data:text/html;base64,AAAA",
    "ftp://pay.example.com/x",
    "See https://pay.example.com/ok and http://pay.example.com/no",
    "Mail mailto:billing@example.invalid",
  ])
    await assert.rejects(
      set(bad),
      (error: any) => error instanceof BillingError && error.code === "invalid_issuer",
    );
});

test("melio is a recordable external payment method, and venmo stays valid", async () => {
  const { fixture } = await issuedInvoice();
  for (const method of ["melio", "venmo"]) {
    const { payment } = await fixture.ledger.recordPayment(
      ada,
      fixture.accountId,
      { amountCents: 100, method, receivedAt: "2026-11-03" },
      randomUUID(),
    );
    assert.equal(payment.method, method);
  }
});
