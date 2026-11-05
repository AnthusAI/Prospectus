import type { IdentityFiles } from "../accounts/identity-files";
import { UUID_PATTERN } from "../accounts/model";
import type { Context } from "../accounts/model";
import type { OperatorGrant } from "../accounts/operator-policy";
import { hasOnlyKeys, isPlainRecord, matchesStringPattern } from "../accounts/validation-rules";
import { normalizeAllocations } from "./allocations";
import { isDate } from "./dates";
import {
  creditHandler,
  draftHandler,
  enterHandler,
  issueHandler,
  normalizeInvoiceNumber,
  normalizeIssueDate,
  normalizeLineItems,
  normalizeNetTerms,
  normalizePeriod,
  normalizeReason,
  voidHandler,
  writeOffHandler,
} from "./invoices";
import {
  deterministicId,
  ledgerPath,
  ledgerRequestHash,
  LedgerEngine,
  LedgerReader,
  numberPath,
  type LedgerAction,
  type LedgerOperation,
} from "./ledger-engine";
import { isCents } from "./money";
import {
  fail,
  type JournalEvent,
  type LedgerInvoice,
  type LedgerPayment,
  type NumberClaim,
  type PaymentMethodKind,
} from "./model";
import {
  allocatePaymentHandler,
  isExternalMethod,
  recordPaymentHandler,
  reversePaymentHandler,
} from "./payments";
import { requireBillingAdministrator } from "./profile";
import { journalPath, requireAccountId, requireExpectedRevision, requireOperationId } from "./store";

const text = (value: unknown, maximum: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;

function requireId(value: unknown, code: string, message: string): string {
  if (!matchesStringPattern(value, UUID_PATTERN)) fail(400, code, message);
  return value.toLowerCase();
}

function requireFields(input: unknown, allowed: readonly string[], code: string, subject: string) {
  if (!isPlainRecord(input) || !hasOnlyKeys(input, allowed))
    fail(400, code, `${subject} must be an object with only the reviewed fields.`);
  return input as Record<string, any>;
}

/**
 * The invoice and payment ledger. Every write is by a billing administrator (`accounts:admin:billing`), carries a
 * client-generated operation ID and optionally an expected revision, and produces exactly one journal event. The
 * methods are plain domain calls: the operator routes and, later, the CLI call them and add nothing to them.
 */
export class BillingLedger {
  readonly reader: LedgerReader;
  private engine: LedgerEngine;
  constructor(
    private files: IdentityFiles,
    private grants: readonly OperatorGrant[],
    private now: () => string = () => new Date().toISOString(),
  ) {
    this.reader = new LedgerReader(files);
    this.engine = new LedgerEngine(files, {
      "invoice.draft": draftHandler,
      "invoice.issue": issueHandler,
      "invoice.enter": enterHandler,
      "invoice.void": voidHandler,
      "invoice.write_off": writeOffHandler,
      "credit.record": creditHandler,
      "payment.record": recordPaymentHandler,
      "payment.allocate": allocatePaymentHandler,
      "payment.reverse": reversePaymentHandler,
    });
  }

  // ---- Reads -----------------------------------------------------------------------------------------------

  invoice(invoiceId: string) {
    return this.reader.invoice(requireId(invoiceId, "invalid_invoice", "Invoice ID required."));
  }
  /** The invoice with this number, or null. */
  async invoiceByNumber(number: string) {
    if (!/^\d{6}-\d{3}$/.test(number)) return null;
    const claim = (await this.files.get<NumberClaim>(numberPath(number)))?.value;
    return claim ? this.reader.invoice(claim.invoiceId) : null;
  }
  invoices(accountId: string) {
    return this.reader.invoices(requireAccountId(accountId));
  }
  payment(paymentId: string) {
    return this.reader.payment(requireId(paymentId, "invalid_payment", "Payment ID required."));
  }
  payments(accountId: string) {
    return this.reader.payments(requireAccountId(accountId));
  }
  /** Every account that has any ledger activity. Bounded by the bridge's listing budget. */
  async accountIds(): Promise<string[]> {
    return (await this.files.list("ledgers/")).map((path) => path.slice("ledgers/".length, -".json".length));
  }
  async allInvoices(): Promise<LedgerInvoice[]> {
    return (await Promise.all((await this.accountIds()).map((id) => this.reader.invoices(id)))).flat();
  }
  async allPayments(): Promise<LedgerPayment[]> {
    return (await Promise.all((await this.accountIds()).map((id) => this.reader.payments(id)))).flat();
  }
  /** The account's most recent journal events, newest first. */
  async journal(accountId: string): Promise<JournalEvent[]> {
    const head = await this.reader.head(requireAccountId(accountId));
    const events = await Promise.all(
      head.journal.map(async (eventId) => (await this.files.get<JournalEvent>(journalPath(eventId)))?.value),
    );
    return events.filter((event): event is JournalEvent => !!event).reverse();
  }

  // ---- Invoices --------------------------------------------------------------------------------------------

  /** Creates a draft period or one-off invoice. A second invoice for the same period is refused. */
  async createDraft(context: Context, accountId: string, input: unknown, operationId: string) {
    const actor = requireBillingAdministrator(context, this.grants);
    const id = requireAccountId(accountId),
      operation = requireOperationId(operationId);
    const fields = requireFields(
      input,
      ["lineItems", "period", "netTermsDays", "issuedVia"],
      "invalid_invoice",
      "Invoice",
    );
    requireManual(fields.issuedVia);
    const netTermsDays = normalizeNetTerms(fields.netTermsDays),
      period = normalizePeriod(fields.period);
    const request = {
      invoiceId: deterministicId(operation, "invoice"),
      lineItems: normalizeLineItems(fields.lineItems),
      period: period ?? null,
      netTermsDays: netTermsDays ?? null,
    };
    return this.invoiceResult(await this.run(actor, "invoice.draft", id, operation, request));
  }

  /** Issues a draft: copies the issuer, takes the next number of the month and sets the due date. */
  async issue(context: Context, invoiceId: string, input: unknown, operationId: string) {
    const actor = requireBillingAdministrator(context, this.grants);
    const operation = requireOperationId(operationId);
    const fields = requireFields(
      input ?? {},
      ["issueDate", "issuedVia", "expectedRevision"],
      "invalid_invoice",
      "Invoice",
    );
    requireManual(fields.issuedVia);
    if (fields.issueDate !== undefined) normalizeIssueDate(fields.issueDate, "0000-01-01");
    const invoice = await this.requireInvoice(invoiceId);
    return this.invoiceResult(
      await this.run(
        actor,
        "invoice.issue",
        invoice.accountId,
        operation,
        { invoiceId: invoice.id, issueDate: fields.issueDate ?? null },
        requireExpectedRevision(fields.expectedRevision),
      ),
    );
  }

  /** Raises an invoice as the console does: a draft, then issued unless it is to stay a draft. */
  async raise(context: Context, accountId: string, input: unknown, operationId: string) {
    const fields = requireFields(
      input,
      ["lineItems", "period", "netTermsDays", "issuedVia", "draft", "issueDate"],
      "invalid_invoice",
      "Invoice",
    );
    const { draft, issueDate, ...rest } = fields;
    const drafted = await this.createDraft(context, accountId, rest, operationId);
    if (draft === true) return drafted;
    const issued = await this.issue(
      context,
      drafted.invoice.id,
      { ...(issueDate !== undefined ? { issueDate } : {}), issuedVia: rest.issuedVia },
      deterministicId(requireOperationId(operationId), "issue"),
    );
    return { ...issued, replayed: drafted.replayed && issued.replayed };
  }

  /**
   * Records an invoice that was issued outside Prospectus, with the number it already carries. The number is
   * claimed like any other, and the month's counter moves past it so it can never be handed out again.
   */
  async enterIssued(context: Context, accountId: string, input: unknown, operationId: string) {
    const actor = requireBillingAdministrator(context, this.grants);
    const id = requireAccountId(accountId),
      operation = requireOperationId(operationId);
    const fields = requireFields(
      input,
      ["number", "issueDate", "dueDate", "lineItems", "period", "netTermsDays", "issuedVia"],
      "invalid_invoice",
      "Invoice",
    );
    requireManual(fields.issuedVia);
    if (!isDate(fields.issueDate))
      fail(400, "invalid_invoice", "Invoice refused: the issue date must be YYYY-MM-DD.");
    if (fields.dueDate !== undefined && (!isDate(fields.dueDate) || fields.dueDate < fields.issueDate))
      fail(
        400,
        "invalid_invoice",
        "Invoice refused: the due date must be YYYY-MM-DD, not before the issue date.",
      );
    const request = {
      invoiceId: deterministicId(operation, "invoice"),
      number: normalizeInvoiceNumber(fields.number, fields.issueDate),
      issueDate: fields.issueDate,
      dueDate: fields.dueDate ?? null,
      lineItems: normalizeLineItems(fields.lineItems),
      period: normalizePeriod(fields.period) ?? null,
      netTermsDays: normalizeNetTerms(fields.netTermsDays) ?? null,
    };
    return this.invoiceResult(await this.run(actor, "invoice.enter", id, operation, request));
  }

  /** Voids a draft, or an issued invoice with no allocations or credits. The number is not reused. */
  async void(context: Context, invoiceId: string, input: unknown, operationId: string) {
    return this.close(context, invoiceId, input, operationId, "invoice.void");
  }
  /** Marks an invoice `uncollectible`. The invoice and its journal stay on record. */
  async writeOff(context: Context, invoiceId: string, input: unknown, operationId: string) {
    return this.close(context, invoiceId, input, operationId, "invoice.write_off");
  }
  private async close(
    context: Context,
    invoiceId: string,
    input: unknown,
    operationId: string,
    action: "invoice.void" | "invoice.write_off",
  ) {
    const actor = requireBillingAdministrator(context, this.grants);
    const operation = requireOperationId(operationId);
    const fields = requireFields(input, ["reason", "expectedRevision"], "invalid_invoice", "Request");
    const reason = normalizeReason(fields.reason);
    const invoice = await this.requireInvoice(invoiceId);
    return this.invoiceResult(
      await this.run(
        actor,
        action,
        invoice.accountId,
        operation,
        { invoiceId: invoice.id, reason },
        requireExpectedRevision(fields.expectedRevision),
      ),
    );
  }

  /** A credit reduces an issued invoice's balance and names the invoice it corrects. */
  async credit(context: Context, invoiceId: string, input: unknown, operationId: string) {
    const actor = requireBillingAdministrator(context, this.grants);
    const operation = requireOperationId(operationId);
    const fields = requireFields(
      input,
      ["amountCents", "reason", "expectedRevision"],
      "invalid_credit",
      "Credit",
    );
    if (!isCents(fields.amountCents) || fields.amountCents === 0)
      fail(400, "invalid_amount", "Credit must be a positive whole number of cents.");
    const reason = normalizeReason(fields.reason);
    const invoice = await this.requireInvoice(invoiceId);
    return this.invoiceResult(
      await this.run(
        actor,
        "credit.record",
        invoice.accountId,
        operation,
        { invoiceId: invoice.id, amountCents: fields.amountCents, reason },
        requireExpectedRevision(fields.expectedRevision),
      ),
    );
  }

  // ---- Payments --------------------------------------------------------------------------------------------

  /** Records an external payment, optionally allocating it across invoices in the same operation. */
  async recordPayment(context: Context, accountId: string, input: unknown, operationId: string) {
    const actor = requireBillingAdministrator(context, this.grants);
    const id = requireAccountId(accountId),
      operation = requireOperationId(operationId);
    const fields = requireFields(
      input,
      ["amountCents", "method", "receivedAt", "reference", "note", "allocations", "currency"],
      "invalid_payment",
      "Payment",
    );
    if (fields.currency !== undefined && fields.currency !== "usd")
      fail(400, "invalid_currency", "Payment currency must be usd.");
    if (typeof fields.method === "string" && ["stripe_card", "stripe_bank"].includes(fields.method))
      fail(
        400,
        "stripe_payments_by_webhook",
        "Stripe payments arrive by the webhook mirror and cannot be recorded by hand.",
      );
    if (!isExternalMethod(fields.method))
      fail(
        400,
        "invalid_payment",
        "Payment refused: the method must be bank_transfer, check, venmo, cash or other.",
      );
    if (!isCents(fields.amountCents) || fields.amountCents === 0)
      fail(400, "invalid_amount", "Payment amount must be a positive whole number of cents.");
    if (!isDate(fields.receivedAt))
      fail(400, "invalid_payment", "Payment refused: the received date must be YYYY-MM-DD.");
    if (fields.reference !== undefined && !text(fields.reference, 200))
      fail(400, "invalid_payment", "Payment refused: the reference must be absent or 1 to 200 characters.");
    if (fields.note !== undefined && !text(fields.note, 1000))
      fail(400, "invalid_payment", "Payment refused: the note must be absent or 1 to 1000 characters.");
    const request = {
      paymentId: deterministicId(operation, "payment"),
      amountCents: fields.amountCents as number,
      method: fields.method as PaymentMethodKind,
      receivedAt: fields.receivedAt,
      reference: fields.reference ?? null,
      note: fields.note ?? null,
      allocations: normalizeAllocations(fields.allocations ?? [], true),
    };
    return this.paymentResult(await this.run(actor, "payment.record", id, operation, request));
  }

  /** Applies a payment's unallocated remainder to one or more open invoices of the same account. */
  async allocate(context: Context, paymentId: string, input: unknown, operationId: string) {
    const actor = requireBillingAdministrator(context, this.grants);
    const operation = requireOperationId(operationId);
    const fields = requireFields(
      input,
      ["allocations", "expectedRevision"],
      "invalid_allocation",
      "Allocation",
    );
    const allocations = normalizeAllocations(fields.allocations, false);
    const payment = await this.requirePayment(paymentId);
    return this.paymentResult(
      await this.run(
        actor,
        "payment.allocate",
        payment.accountId,
        operation,
        { paymentId: payment.id, allocations },
        requireExpectedRevision(fields.expectedRevision),
      ),
    );
  }

  /** Reverses a payment (a bounced check): a reversing payment and reversing allocations, the originals untouched. */
  async reverse(context: Context, paymentId: string, input: unknown, operationId: string) {
    const actor = requireBillingAdministrator(context, this.grants);
    const operation = requireOperationId(operationId);
    const fields = requireFields(input, ["reason", "expectedRevision"], "invalid_payment", "Request");
    const reason = normalizeReason(fields.reason);
    const payment = await this.requirePayment(paymentId);
    return this.paymentResult(
      await this.run(
        actor,
        "payment.reverse",
        payment.accountId,
        operation,
        { paymentId: payment.id, reversalId: deterministicId(operation, "reversal-payment"), reason },
        requireExpectedRevision(fields.expectedRevision),
      ),
    );
  }

  // ---- Plumbing --------------------------------------------------------------------------------------------

  private async requireInvoice(invoiceId: string) {
    const invoice = await this.invoice(invoiceId);
    if (!invoice) fail(404, "invoice_missing", "Invoice not found.");
    return invoice;
  }
  private async requirePayment(paymentId: string) {
    const payment = await this.payment(paymentId);
    if (!payment) fail(404, "payment_missing", "Payment not found.");
    return payment;
  }

  private async run(
    actor: string,
    action: LedgerAction,
    accountId: string,
    operationId: string,
    request: Record<string, unknown>,
    expectedRevision?: number,
  ) {
    const operation: LedgerOperation = {
      action,
      accountId,
      operationId,
      actor,
      at: this.now(),
      request,
      requestHash: ledgerRequestHash(action, accountId, actor, request),
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    };
    const { event, replayed } = await this.engine.run(operation);
    // The original committed record, answered by storage from the operation's receipt, never rebuilt.
    const original = await this.files.commit(
      event.recordPath,
      event.storageOperationId,
      event.storageRequestHash,
      null,
      null,
    );
    return { record: original.value, event, replayed };
  }
  private invoiceResult(result: { record: any; event: JournalEvent; replayed: boolean }) {
    return { invoice: result.record as LedgerInvoice, event: result.event, replayed: result.replayed };
  }
  private paymentResult(result: { record: any; event: JournalEvent; replayed: boolean }) {
    return { payment: result.record as LedgerPayment, event: result.event, replayed: result.replayed };
  }
}

function requireManual(issuedVia: unknown) {
  if (issuedVia === undefined || issuedVia === "manual") return;
  if (issuedVia === "stripe")
    fail(409, "stripe_unavailable", "Issuing through Stripe is not available; issue the invoice manually.");
  fail(400, "invalid_invoice", "Invoice refused: issued via must be manual.");
}

export { ledgerPath };
