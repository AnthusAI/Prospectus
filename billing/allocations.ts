import { UUID_PATTERN } from "../accounts/model";
import { hasOnlyKeys, isPlainRecord, matchesStringPattern } from "../accounts/validation-rules";
import { deriveInvoice, isOpenInvoice, withDerivedFigures } from "./balances";
import {
  allocationPath,
  deterministicId,
  invoicePath,
  type LedgerReader,
  type LedgerScope,
  type Step,
} from "./ledger-engine";
import { isCents } from "./money";
import { fail, type AllocationRef, type LedgerAllocation, type LedgerInvoice } from "./model";

export interface AllocationRequest {
  invoiceId: string;
  amountCents: number;
}
const MAXIMUM_ALLOCATIONS = 20;

/** Allocations as a client sends them: invoice and a positive whole number of cents, each invoice at most once. */
export function normalizeAllocations(value: unknown, allowEmpty: boolean): AllocationRequest[] {
  const refuse = (message: string) => fail(400, "invalid_allocation", `Allocation refused: ${message}`);
  if (!Array.isArray(value) || value.length > MAXIMUM_ALLOCATIONS || (!allowEmpty && value.length === 0))
    refuse(
      allowEmpty
        ? `at most ${MAXIMUM_ALLOCATIONS} allocations.`
        : `1 to ${MAXIMUM_ALLOCATIONS} allocations are required.`,
    );
  const seen = new Set<string>();
  return (value as unknown[]).map((entry) => {
    if (
      !isPlainRecord(entry) ||
      !hasOnlyKeys(entry, ["invoiceId", "amountCents"]) ||
      !matchesStringPattern(entry.invoiceId, UUID_PATTERN) ||
      !isCents(entry.amountCents) ||
      entry.amountCents === 0
    )
      return refuse("each allocation needs an invoice ID and a positive whole number of cents.");
    const invoiceId = entry.invoiceId.toLowerCase();
    if (seen.has(invoiceId)) return refuse("an invoice may appear only once.");
    seen.add(invoiceId);
    return { invoiceId, amountCents: entry.amountCents };
  });
}

/**
 * The invoices an allocation would reduce, each checked against its own balance: the same account, open (issued or
 * partly paid, never void, written off or paid) and with room for the amount. Nothing is written here.
 */
export async function checkAllocations(
  read: LedgerReader,
  accountId: string,
  allocations: readonly AllocationRequest[],
): Promise<Map<string, LedgerInvoice>> {
  const invoices = new Map<string, LedgerInvoice>();
  for (const { invoiceId, amountCents } of allocations) {
    const invoice = await read.invoice(invoiceId);
    if (!invoice) fail(404, "invoice_missing", "An allocation names an invoice that does not exist.");
    if (invoice.accountId !== accountId)
      fail(409, "wrong_account", "An allocation names an invoice of another account.");
    if (!isOpenInvoice(invoice))
      fail(409, "invoice_not_open", "An allocation names an invoice that is not open for payment.");
    if (amountCents > invoice.balanceCents)
      fail(
        409,
        "over_allocation",
        `An allocation of ${amountCents} cents exceeds the invoice balance of ${invoice.balanceCents} cents.`,
      );
    invoices.set(invoiceId, invoice);
  }
  return invoices;
}

/** Appends references to an invoice and recomputes its figures from them. */
export function withAllocations(invoice: LedgerInvoice, refs: readonly AllocationRef[]): LedgerInvoice {
  return withDerivedFigures({
    ...invoice,
    allocations: [
      ...invoice.allocations,
      ...refs.filter((ref) => !invoice.allocations.some((own) => own.id === ref.id)),
    ],
  });
}

/**
 * Writes one allocation file and applies it to its invoice, for each requested allocation. The allocation ids are
 * derived from the operation ID, so a finish after an interruption finds what was already written.
 */
export async function writeAllocations(
  scope: LedgerScope,
  paymentId: string,
  allocations: readonly AllocationRequest[],
  label: string,
): Promise<{ refs: AllocationRef[]; invoices: Map<string, Step<LedgerInvoice>> }> {
  const { operation } = scope;
  const refs: AllocationRef[] = [];
  const invoices = new Map<string, Step<LedgerInvoice>>();
  for (const [index, { invoiceId, amountCents }] of allocations.entries()) {
    const id = deterministicId(operation.operationId, `${label}:allocation:${index}`);
    const ref: AllocationRef = {
      id,
      paymentId,
      invoiceId,
      amountCents,
      at: operation.at,
      by: operation.actor,
    };
    refs.push(ref);
    await scope.create<LedgerAllocation>(allocationPath(id), "payment.allocated", {
      version: 1,
      kind: "billing-allocation",
      id,
      accountId: operation.accountId,
      paymentId,
      invoiceId,
      amountCents,
      at: operation.at,
      by: operation.actor,
    });
    invoices.set(
      invoiceId,
      await scope.step<LedgerInvoice>(invoicePath(invoiceId), "payment.allocated", (current) => {
        if (!current) fail(404, "invoice_missing", "An allocation names an invoice that does not exist.");
        const { revision: _r, creation: _c, audit: _a, ...rest } = withAllocations(current, [ref]);
        return rest;
      }),
    );
  }
  return { refs, invoices };
}

export const invoiceFigures = (invoice: LedgerInvoice) => deriveInvoice(invoice);
