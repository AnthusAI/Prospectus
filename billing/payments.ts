import { paymentRemainder } from "./balances";
import { checkAllocations, withAllocations, writeAllocations, type AllocationRequest } from "./allocations";
import { bare, checkExpectedRevision } from "./invoices";
import {
  allocationPath,
  deterministicId,
  invoicePath,
  MAXIMUM_INDEXED_RECORDS,
  paymentPath,
  type LedgerHandler,
  type LedgerOperation,
  type LedgerReader,
} from "./ledger-engine";
import { sumCents } from "./money";
import {
  BILLING_CURRENCY,
  fail,
  type AllocationRef,
  type LedgerAllocation,
  type LedgerInvoice,
  type LedgerPayment,
  type PaymentMethodKind,
} from "./model";

/** Methods an admin may record by hand. Card and bank payments through Stripe arrive only by the webhook mirror. */
export const externalPaymentMethods = ["bank_transfer", "check", "venmo", "melio", "cash", "other"] as const;
export const isExternalMethod = (method: unknown): method is PaymentMethodKind =>
  (externalPaymentMethods as readonly unknown[]).includes(method);

async function requirePayment(read: LedgerReader, operation: LedgerOperation, paymentId: unknown) {
  const payment = typeof paymentId === "string" ? await read.payment(paymentId) : null;
  if (!payment || payment.accountId !== operation.accountId)
    return fail(404, "payment_missing", "Payment not found.");
  checkExpectedRevision(operation, payment.revision);
  return payment;
}

/** The payment that reversed this one, if any. A reversal is found by its `reversal_of`, so the original stays untouched. */
export async function reversalOf(read: LedgerReader, payment: LedgerPayment) {
  return (await read.payments(payment.accountId)).find((other) => other.reversal_of === payment.id) ?? null;
}

async function requireLive(read: LedgerReader, payment: LedgerPayment) {
  if (payment.reversal_of) fail(409, "payment_is_reversal", "A reversing payment cannot be changed.");
  if (await reversalOf(read, payment)) fail(409, "payment_reversed", "The payment has been reversed.");
}

export const recordPaymentHandler: LedgerHandler = {
  recordKind: "payment",
  async validate(read, operation) {
    const request = operation.request as { amountCents: number; allocations: AllocationRequest[] };
    const profile = await read.profile(operation.accountId);
    if (!profile?.mode)
      fail(409, "not_yet_billable", "Account has no billing mode, so it is not yet billable.");
    if ((await read.head(operation.accountId)).payments.length >= MAXIMUM_INDEXED_RECORDS)
      fail(409, "billing_capacity", "The account has reached its payment capacity.");
    if (sumCents(request.allocations.map((allocation) => allocation.amountCents)) > request.amountCents)
      fail(409, "over_allocation", "The allocations exceed the payment amount.");
    await checkAllocations(read, operation.accountId, request.allocations);
  },
  async execute(scope, operation) {
    const request = operation.request as {
      paymentId: string;
      amountCents: number;
      method: PaymentMethodKind;
      receivedAt: string;
      reference?: string;
      note?: string;
      allocations: AllocationRequest[];
    };
    const { refs, invoices } = await writeAllocations(
      scope,
      request.paymentId,
      request.allocations,
      "record",
    );
    const step = await scope.create<LedgerPayment>(paymentPath(request.paymentId), "payment.recorded", {
      version: 1,
      kind: "billing-payment",
      id: request.paymentId,
      accountId: operation.accountId,
      amountCents: request.amountCents,
      currency: BILLING_CURRENCY,
      method: request.method,
      receivedAt: request.receivedAt,
      ...(request.reference != null ? { reference: request.reference } : {}),
      ...(request.note != null ? { note: request.note } : {}),
      recordedBy: operation.actor,
      unallocatedCents: request.amountCents - sumCents(refs.map((ref) => ref.amountCents)),
      allocations: refs,
    });
    return {
      action: "payment.recorded",
      primary: step,
      detail: {
        paymentId: request.paymentId,
        amountCents: request.amountCents,
        method: request.method,
        allocations: refs.map((ref) => ({
          allocationId: ref.id,
          invoiceId: ref.invoiceId,
          invoiceNumber: invoices.get(ref.invoiceId)?.record.number,
          amountCents: ref.amountCents,
        })),
      },
      index: { payments: [request.paymentId] },
    };
  },
};

export const allocatePaymentHandler: LedgerHandler = {
  recordKind: "payment",
  async validate(read, operation) {
    const request = operation.request as { paymentId: string; allocations: AllocationRequest[] };
    const payment = await requirePayment(read, operation, request.paymentId);
    await requireLive(read, payment);
    const total = sumCents(request.allocations.map((allocation) => allocation.amountCents));
    if (total > paymentRemainder(payment))
      fail(
        409,
        "over_allocation",
        `The allocations of ${total} cents exceed the payment's unallocated ${paymentRemainder(payment)} cents.`,
      );
    await checkAllocations(read, operation.accountId, request.allocations);
  },
  async execute(scope, operation) {
    const request = operation.request as { paymentId: string; allocations: AllocationRequest[] };
    const { refs, invoices } = await writeAllocations(
      scope,
      request.paymentId,
      request.allocations,
      "allocate",
    );
    const step = await scope.step<LedgerPayment>(
      paymentPath(request.paymentId),
      "payment.allocated",
      (current) => {
        if (!current) return fail(404, "payment_missing", "Payment not found.");
        const allocations = [
          ...current.allocations,
          ...refs.filter((ref) => !current.allocations.some((own) => own.id === ref.id)),
        ];
        return bare({
          ...current,
          allocations,
          unallocatedCents: paymentRemainder({ amountCents: current.amountCents, allocations }),
        });
      },
    );
    return {
      action: "payment.allocated",
      primary: step,
      detail: {
        paymentId: request.paymentId,
        allocations: refs.map((ref) => ({
          allocationId: ref.id,
          invoiceId: ref.invoiceId,
          invoiceNumber: invoices.get(ref.invoiceId)?.record.number,
          amountCents: ref.amountCents,
        })),
      },
    };
  },
};

export const reversePaymentHandler: LedgerHandler = {
  recordKind: "payment",
  async validate(read, operation) {
    const payment = await requirePayment(read, operation, operation.request.paymentId);
    await requireLive(read, payment);
    if ((await read.head(operation.accountId)).payments.length >= MAXIMUM_INDEXED_RECORDS)
      fail(409, "billing_capacity", "The account has reached its payment capacity.");
  },
  async execute(scope, operation) {
    const { paymentId, reversalId, reason } = operation.request as {
      paymentId: string;
      reversalId: string;
      reason: string;
    };
    const original = await scope.read.payment(paymentId);
    if (!original) return fail(404, "payment_missing", "Payment not found.");
    const refs: AllocationRef[] = [];
    const reversed: Record<string, unknown>[] = [];
    for (const [index, allocation] of original.allocations.entries()) {
      const id = deterministicId(operation.operationId, `reverse:allocation:${index}`);
      const ref: AllocationRef = {
        id,
        paymentId: reversalId,
        invoiceId: allocation.invoiceId,
        amountCents: -allocation.amountCents,
        at: operation.at,
        by: operation.actor,
        reversal_of: allocation.id,
      };
      refs.push(ref);
      await scope.create<LedgerAllocation>(allocationPath(id), "payment.reversed", {
        version: 1,
        kind: "billing-allocation",
        id,
        accountId: operation.accountId,
        paymentId: reversalId,
        invoiceId: allocation.invoiceId,
        amountCents: ref.amountCents,
        at: operation.at,
        by: operation.actor,
        reversal_of: allocation.id,
      });
      reversed.push({
        allocationId: id,
        invoiceId: allocation.invoiceId,
        amountCents: ref.amountCents,
      });
    }
    // One write per invoice, however many allocations it received: a record takes an operation once.
    const numbers = new Map<string, string | null>();
    for (const invoiceId of new Set(refs.map((ref) => ref.invoiceId))) {
      const step = await scope.step<LedgerInvoice>(invoicePath(invoiceId), "payment.reversed", (current) => {
        if (!current) return fail(404, "invoice_missing", "Invoice not found.");
        return bare(
          withAllocations(
            current,
            refs.filter((ref) => ref.invoiceId === invoiceId),
          ),
        );
      });
      numbers.set(invoiceId, step.record.number);
    }
    for (const entry of reversed) entry.invoiceNumber = numbers.get(entry.invoiceId as string);
    const amountCents = -original.amountCents;
    const step = await scope.create<LedgerPayment>(paymentPath(reversalId), "payment.reversed", {
      version: 1,
      kind: "billing-payment",
      id: reversalId,
      accountId: operation.accountId,
      amountCents,
      currency: BILLING_CURRENCY,
      method: original.method,
      receivedAt: operation.at.slice(0, 10),
      ...(original.reference !== undefined ? { reference: original.reference } : {}),
      recordedBy: operation.actor,
      unallocatedCents: paymentRemainder({ amountCents, allocations: refs }),
      allocations: refs,
      reversal_of: paymentId,
      reversalReason: reason,
    });
    return {
      action: "payment.reversed",
      primary: step,
      detail: {
        paymentId,
        reversalPaymentId: reversalId,
        amountCents,
        reason,
        allocations: reversed,
      },
      index: { payments: [reversalId] },
    };
  },
};
