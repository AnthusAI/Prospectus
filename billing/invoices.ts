import { hasOnlyKeys, isPlainRecord, isProductName } from "../accounts/validation-rules";
import { deriveInvoice, isOpenInvoice, withDerivedFigures } from "./balances";
import { addDays, isDate, isMonth } from "./dates";
import {
  creditPath,
  deterministicId,
  invoicePath,
  numberPath,
  sequencePath,
  type LedgerHandler,
  type LedgerOperation,
  type LedgerReader,
} from "./ledger-engine";
import { isCents, lineTotalCents, MAXIMUM_QUANTITY, sumCents } from "./money";
import {
  BILLING_CURRENCY,
  fail,
  type InvoiceLineItem,
  type IssuerBlock,
  type AcceptedPaymentMethod,
  type InvoiceSequence,
  type LedgerCredit,
  type LedgerInvoice,
  type NumberClaim,
  type VersionedRecord,
} from "./model";
import { effectiveDefaultNetTerms } from "./issuer";
import { MAXIMUM_INDEXED_RECORDS } from "./ledger-engine";

export const MAXIMUM_LINE_ITEMS = 50;
const NUMBER_PATTERN = /^(\d{4})(0[1-9]|1[0-2])-(\d{3})$/;
const text = (value: unknown, maximum: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;

/** Messages name the field only, never the submitted value. */
const refuse = (message: string): never => fail(400, "invalid_invoice", `Invoice refused: ${message}`);

export const bare = <T extends VersionedRecord>(record: T): Omit<T, "revision" | "creation" | "audit"> => {
  const { revision: _revision, creation: _creation, audit: _audit, ...rest } = record;
  return rest;
};

export function normalizeLineItems(value: unknown): InvoiceLineItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAXIMUM_LINE_ITEMS)
    refuse(`1 to ${MAXIMUM_LINE_ITEMS} line items are required.`);
  const items = (value as unknown[]).map((entry): InvoiceLineItem => {
    if (
      !isPlainRecord(entry) ||
      !hasOnlyKeys(entry, ["description", "quantity", "unitAmountCents", "billingLine", "product", "period"])
    )
      return refuse("a line item must have only the reviewed fields.");
    if (!text(entry.description, 200)) refuse("a line item description must be 1 to 200 characters.");
    if (!Number.isSafeInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > MAXIMUM_QUANTITY)
      refuse("a line item quantity must be a whole number from 1 to 1000000.");
    if (!isCents(entry.unitAmountCents))
      refuse("a line item unit amount must be a whole number of cents, not negative.");
    if (entry.billingLine !== undefined && !text(entry.billingLine, 100))
      refuse("a line item billing line must be absent or 1 to 100 characters.");
    if (entry.product !== undefined && !isProductName(entry.product))
      refuse("a line item product must be a registered product name.");
    if (entry.period !== undefined && !text(entry.period, 100))
      refuse("a line item period must be absent or 1 to 100 characters.");
    lineTotalCents(entry.quantity, entry.unitAmountCents);
    return {
      description: entry.description,
      quantity: entry.quantity,
      unitAmountCents: entry.unitAmountCents,
      ...(entry.billingLine !== undefined ? { billingLine: entry.billingLine } : {}),
      ...(entry.product !== undefined ? { product: entry.product } : {}),
      ...(entry.period !== undefined ? { period: entry.period } : {}),
    };
  });
  const total = sumCents(items.map((item) => lineTotalCents(item.quantity, item.unitAmountCents)));
  if (total <= 0) refuse("the total must be more than zero.");
  return items;
}

export function normalizePeriod(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isMonth(value)) refuse("a period must be a month, YYYY-MM.");
  return value as string;
}
export function normalizeReason(value: unknown): string {
  if (!text(value, 500)) fail(400, "invalid_reason", "A reason of 1 to 500 characters is required.");
  return value as string;
}
export function normalizeNetTerms(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 365)
    refuse("net terms must be a whole number of days from 1 to 365.");
  return value as number;
}
export function normalizeIssueDate(value: unknown, today: string): string {
  if (value === undefined) return today;
  if (!isDate(value)) refuse("the issue date must be YYYY-MM-DD.");
  return value as string;
}
export function normalizeInvoiceNumber(value: unknown, issueDate: string): string {
  if (typeof value !== "string" || !NUMBER_PATTERN.test(value) || value.endsWith("-000"))
    return refuse("the number must look like 202610-001.");
  if (value.slice(0, 6) !== issueDate.slice(0, 4) + issueDate.slice(5, 7))
    return refuse("the number's month must match the issue date's month.");
  return value;
}

export function checkExpectedRevision(operation: LedgerOperation, actual: number) {
  if (operation.expectedRevision !== undefined && operation.expectedRevision !== actual)
    fail(409, "revision_conflict", "The billing record changed since it was read; read it again.");
}

export const newInvoice = (input: {
  id: string;
  accountId: string;
  lineItems: InvoiceLineItem[];
  period?: string;
  netTermsDays: number;
}): Omit<LedgerInvoice, "revision" | "creation" | "audit"> => {
  const subtotalCents = sumCents(
    input.lineItems.map((item) => lineTotalCents(item.quantity, item.unitAmountCents)),
  );
  return withDerivedFigures({
    version: 1,
    kind: "billing-invoice",
    id: input.id,
    accountId: input.accountId,
    number: null,
    currency: BILLING_CURRENCY,
    lineItems: input.lineItems,
    ...(input.period ? { period: input.period } : {}),
    subtotalCents,
    totalCents: subtotalCents,
    issuedVia: "manual",
    netTermsDays: input.netTermsDays,
    lifecycle: "draft",
    status: "draft",
    balanceCents: subtotalCents,
    allocatedCents: 0,
    creditsCents: 0,
    allocations: [],
    credits: [],
  } as unknown as LedgerInvoice);
};

/** An invoiced profile, the only kind that takes manual invoices. */
async function requireInvoicedProfile(read: LedgerReader, accountId: string) {
  const profile = await read.profile(accountId);
  if (!profile?.mode)
    return fail(409, "not_yet_billable", "Account has no billing mode, so it is not yet billable.");
  if (profile.mode !== "invoiced")
    return fail(409, "not_invoiced", "Only invoiced accounts take manual invoices.");
  return profile;
}

async function requirePeriodFree(read: LedgerReader, accountId: string, period: string | undefined) {
  const invoices = await read.invoices(accountId);
  if (invoices.length >= MAXIMUM_INDEXED_RECORDS)
    fail(409, "billing_capacity", "The account has reached its invoice capacity.");
  if (period && invoices.some((invoice) => invoice.period === period && invoice.lifecycle !== "void"))
    fail(409, "period_invoiced", "The account already has an invoice for that period.");
}

async function requireInvoice(read: LedgerReader, operation: LedgerOperation, invoiceId: unknown) {
  const invoice = typeof invoiceId === "string" ? await read.invoice(invoiceId) : null;
  if (!invoice || invoice.accountId !== operation.accountId)
    return fail(404, "invoice_missing", "Invoice not found.");
  checkExpectedRevision(operation, invoice.revision);
  return invoice;
}

/** The invoice's own net terms if the request named them, else the account's override, else the issuer's default. */
async function resolvedNetTerms(
  read: LedgerReader,
  profile: { netTermsDays?: number },
  operation: LedgerOperation,
): Promise<number> {
  return (
    (operation.request.netTermsDays as number | undefined) ??
    profile.netTermsDays ??
    effectiveDefaultNetTerms(await read.issuer())
  );
}

interface IssuerSnapshot extends Record<string, unknown> {
  issuer: IssuerBlock;
  paymentMethods: AcceptedPaymentMethod[];
}
async function issuerSnapshot(read: LedgerReader): Promise<IssuerSnapshot> {
  const record = await read.issuer();
  if (!record) return fail(409, "issuer_missing", "Set the issuer details before issuing an invoice.");
  return { issuer: record.issuer, paymentMethods: record.paymentMethods };
}

export const draftHandler: LedgerHandler = {
  recordKind: "invoice",
  async validate(read, operation) {
    const profile = await requireInvoicedProfile(read, operation.accountId);
    await requirePeriodFree(read, operation.accountId, operation.request.period as string | undefined);
    return { netTermsDays: await resolvedNetTerms(read, profile, operation) };
  },
  async execute(scope, operation) {
    const request = operation.request as {
      invoiceId: string;
      lineItems: InvoiceLineItem[];
      period?: string;
      netTermsDays?: number;
    };
    const netTermsDays = (operation.snapshot as { netTermsDays: number }).netTermsDays;
    const step = await scope.create<LedgerInvoice>(
      invoicePath(request.invoiceId),
      "invoice.drafted",
      newInvoice({
        id: request.invoiceId,
        accountId: operation.accountId,
        lineItems: request.lineItems,
        period: request.period,
        netTermsDays,
      }),
    );
    return {
      action: "invoice.drafted",
      primary: step,
      detail: {
        invoiceId: request.invoiceId,
        totalCents: step.record.totalCents,
        ...(request.period ? { period: request.period } : {}),
      },
      index: { invoices: [request.invoiceId] },
    };
  },
};

export const issueHandler: LedgerHandler = {
  recordKind: "invoice",
  async validate(read, operation) {
    const invoice = await requireInvoice(read, operation, operation.request.invoiceId);
    if (invoice.lifecycle !== "draft") fail(409, "invoice_not_draft", "Only a draft invoice can be issued.");
    await requireInvoicedProfile(read, operation.accountId);
    const issueDate = (operation.request.issueDate as string | null) ?? operation.at.slice(0, 10);
    return { ...(await issuerSnapshot(read)), issueDate };
  },
  async execute(scope, operation) {
    const { invoiceId } = operation.request as { invoiceId: string };
    const snapshot = operation.snapshot as IssuerSnapshot & { issueDate: string };
    const { issueDate } = snapshot;
    const month = issueDate.slice(0, 4) + issueDate.slice(5, 7);
    const number = await scope.claimNumber(month, invoiceId);
    const step = await scope.step<LedgerInvoice>(invoicePath(invoiceId), "invoice.issued", (current) => {
      if (!current || current.lifecycle !== "draft")
        return fail(409, "busy", "Concurrent billing change; retry.");
      return bare(
        withDerivedFigures({
          ...current,
          number,
          issueDate,
          dueDate: addDays(issueDate, current.netTermsDays),
          lifecycle: "issued",
          issuer: snapshot.issuer,
          paymentMethods: snapshot.paymentMethods,
        }),
      );
    });
    await scope.advanceCounter(month, Number(number.slice(7)) + 1);
    return {
      action: "invoice.issued",
      primary: step,
      detail: {
        invoiceId,
        invoiceNumber: number,
        totalCents: step.record.totalCents,
        issueDate,
        dueDate: step.record.dueDate,
      },
    };
  },
};

export const enterHandler: LedgerHandler = {
  recordKind: "invoice",
  async validate(read, operation) {
    const profile = await requireInvoicedProfile(read, operation.accountId);
    await requirePeriodFree(read, operation.accountId, operation.request.period as string | undefined);
    const number = operation.request.number as string;
    const claim = (await read.files.get<NumberClaim>(numberPath(number)))?.value;
    if (claim && claim.invoiceId !== operation.request.invoiceId)
      fail(409, "number_taken", "That invoice number is already in use.");
    return {
      ...(await issuerSnapshot(read)),
      netTermsDays: await resolvedNetTerms(read, profile, operation),
    };
  },
  async execute(scope, operation) {
    const request = operation.request as {
      invoiceId: string;
      number: string;
      issueDate: string;
      dueDate?: string;
      lineItems: InvoiceLineItem[];
      period?: string;
      netTermsDays?: number;
    };
    const snapshot = operation.snapshot as IssuerSnapshot & { netTermsDays: number };
    if (!(await scope.claim(request.number, request.invoiceId)))
      fail(409, "number_taken", "That invoice number is already in use.");
    const draft = newInvoice({
      id: request.invoiceId,
      accountId: operation.accountId,
      lineItems: request.lineItems,
      period: request.period,
      netTermsDays: snapshot.netTermsDays,
    });
    const step = await scope.create<LedgerInvoice>(
      invoicePath(request.invoiceId),
      "invoice.entered",
      bare(
        withDerivedFigures({
          ...(draft as LedgerInvoice),
          number: request.number,
          entered: true,
          issueDate: request.issueDate,
          dueDate: request.dueDate ?? addDays(request.issueDate, snapshot.netTermsDays),
          lifecycle: "issued",
          issuer: snapshot.issuer,
          paymentMethods: snapshot.paymentMethods,
        } as LedgerInvoice),
      ),
    );
    // Only a number the counter is waiting on moves it. A number ahead of the counter is skipped by its claim, so
    // the numbers before it are still handed out in order.
    const month = request.number.slice(0, 6),
      entered = Number(request.number.slice(7));
    const sequence = (await scope.files.get<InvoiceSequence>(sequencePath(month)))?.value;
    if ((sequence?.next ?? 1) === entered) await scope.advanceCounter(month, entered + 1);
    return {
      action: "invoice.entered",
      primary: step,
      detail: {
        invoiceId: request.invoiceId,
        invoiceNumber: request.number,
        totalCents: step.record.totalCents,
        issueDate: request.issueDate,
        dueDate: step.record.dueDate,
      },
      index: { invoices: [request.invoiceId] },
    };
  },
};

export const voidHandler: LedgerHandler = {
  recordKind: "invoice",
  async validate(read, operation) {
    const invoice = await requireInvoice(read, operation, operation.request.invoiceId);
    if (invoice.lifecycle === "uncollectible" || invoice.lifecycle === "void")
      fail(409, "invoice_closed", "The invoice is already closed.");
    // Allocations that were reversed no longer apply, so only live ones (or any credit) block voiding.
    if (invoice.allocatedCents !== 0 || invoice.creditsCents !== 0)
      fail(409, "invoice_has_allocations", "An invoice with allocations or credits cannot be voided.");
  },
  async execute(scope, operation) {
    const { invoiceId, reason } = operation.request as { invoiceId: string; reason: string };
    const step = await scope.step<LedgerInvoice>(invoicePath(invoiceId), "invoice.voided", (current) => {
      if (!current) return fail(404, "invoice_missing", "Invoice not found.");
      return bare(
        withDerivedFigures({
          ...current,
          lifecycle: "void",
          closedReason: reason,
          closedAt: operation.at.slice(0, 10),
        }),
      );
    });
    return {
      action: "invoice.voided",
      primary: step,
      detail: { invoiceId, ...(step.record.number ? { invoiceNumber: step.record.number } : {}), reason },
    };
  },
};

export const writeOffHandler: LedgerHandler = {
  recordKind: "invoice",
  async validate(read, operation) {
    const invoice = await requireInvoice(read, operation, operation.request.invoiceId);
    if (!isOpenInvoice(invoice))
      fail(409, "invoice_not_open", "Only an issued invoice with an unpaid balance can be written off.");
  },
  async execute(scope, operation) {
    const { invoiceId, reason } = operation.request as { invoiceId: string; reason: string };
    const step = await scope.step<LedgerInvoice>(invoicePath(invoiceId), "invoice.written_off", (current) => {
      if (!current) return fail(404, "invoice_missing", "Invoice not found.");
      return bare(
        withDerivedFigures({
          ...current,
          lifecycle: "uncollectible",
          writtenOffCents: deriveInvoice(current).balanceCents,
          closedReason: reason,
          closedAt: operation.at.slice(0, 10),
        }),
      );
    });
    return {
      action: "invoice.written_off",
      primary: step,
      detail: {
        invoiceId,
        invoiceNumber: step.record.number,
        writtenOffCents: step.record.writtenOffCents,
        reason,
      },
    };
  },
};

export const creditHandler: LedgerHandler = {
  recordKind: "invoice",
  async validate(read, operation) {
    const invoice = await requireInvoice(read, operation, operation.request.invoiceId);
    if (!isOpenInvoice(invoice))
      fail(409, "invoice_not_open", "Only an issued invoice with an unpaid balance can be credited.");
    if ((operation.request.amountCents as number) > invoice.balanceCents)
      fail(
        409,
        "over_credit",
        `A credit of ${operation.request.amountCents} cents exceeds the invoice balance of ${invoice.balanceCents} cents.`,
      );
  },
  async execute(scope, operation) {
    const { invoiceId, amountCents, reason } = operation.request as {
      invoiceId: string;
      amountCents: number;
      reason: string;
    };
    const creditId = deterministicId(operation.operationId, "credit");
    await scope.create<LedgerCredit>(creditPath(creditId), "credit.recorded", {
      version: 1,
      kind: "billing-credit",
      id: creditId,
      accountId: operation.accountId,
      invoiceId,
      amountCents,
      reason,
      at: operation.at,
      by: operation.actor,
    });
    const step = await scope.step<LedgerInvoice>(invoicePath(invoiceId), "credit.recorded", (current) => {
      if (!current) return fail(404, "invoice_missing", "Invoice not found.");
      return bare(
        withDerivedFigures({
          ...current,
          credits: [...current.credits, { id: creditId, amountCents, at: operation.at }],
        }),
      );
    });
    return {
      action: "credit.recorded",
      primary: step,
      detail: { invoiceId, invoiceNumber: step.record.number, creditId, amountCents, reason },
    };
  },
};
