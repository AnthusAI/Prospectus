import { IdentityFileError, type IdentityFiles } from "../accounts/identity-files";
import {
  BillingError,
  MAXIMUM_AUDIT_ENTRIES,
  fail,
  type BillingAction,
  type BillingActor,
  type BillingProfile,
  type InvoiceSequence,
  type IssuerRecord,
  type JournalEvent,
  type LedgerAllocation,
  type LedgerEngagement,
  type LedgerInvoice,
  type LedgerPayment,
  type NumberClaim,
  type VersionedRecord,
} from "./model";
import { withDerivedFigures } from "./balances";
import {
  commitWithRetry,
  hash,
  idempotencyConflict,
  journalPath,
  profilePath,
  storageIdentity,
} from "./store";

export const ledgerPath = (accountId: string) => `ledgers/${accountId}.json`;
export const invoicePath = (invoiceId: string) => `invoices/${invoiceId}.json`;
export const paymentPath = (paymentId: string) => `payments/${paymentId}.json`;
export const allocationPath = (allocationId: string) => `allocations/${allocationId}.json`;
export const creditPath = (creditId: string) => `credits/${creditId}.json`;
export const engagementPath = (engagementId: string) => `engagements/${engagementId}.json`;
export const numberPath = (number: string) => `numbers/${number}.json`;
export const sequencePath = (month: string) => `sequences/${month}.json`;
export const ISSUER_FILE = "issuer/0.json";

/** Most invoices or payments one account's index holds. Reaching it is refused, never silently truncated. */
export const MAXIMUM_INDEXED_RECORDS = 300;
const MAXIMUM_INDEXED_EVENTS = 50;
const MAXIMUM_INVOICES_PER_MONTH = 999;

export const ledgerActions = [
  "invoice.draft",
  "invoice.issue",
  "invoice.enter",
  "invoice.void",
  "invoice.write_off",
  "credit.record",
  "payment.record",
  "payment.allocate",
  "payment.reverse",
  "engagement.create",
  "engagement.update",
  "engagement.end",
] as const;
export type LedgerAction = (typeof ledgerActions)[number];

/** A ledger mutation, frozen when it is accepted. Everything a finish needs is in it, so any later caller can finish it. */
export interface LedgerOperation {
  action: LedgerAction;
  accountId: string;
  operationId: string;
  actor: BillingActor;
  at: string;
  /** The normalized client request, hashed to detect an operation ID reused for something else. */
  request: Record<string, unknown>;
  requestHash: string;
  expectedRevision?: number;
  /** Facts read when the operation was accepted (the issuer block copied onto an invoice). Not hashed. */
  snapshot?: Record<string, unknown>;
  /** The invoice number chosen for this operation, recorded before it is claimed so a finish reuses it. */
  number?: string;
}

interface LedgerHead {
  version: 1;
  kind: "billing-ledger-head";
  accountId: string;
  revision: number;
  pending?: LedgerOperation;
  invoices: string[];
  payments: string[];
  /** Absent on heads written before engagements existed. */
  engagements?: string[];
  /** The latest journal events for this account, oldest first. */
  journal: string[];
}

export interface Step<T> {
  path: string;
  record: T;
  beforeRevision: number | null;
  afterRevision: number;
  storageOperationId: string;
  storageRequestHash: string;
}
export interface Execution {
  action: BillingAction;
  primary: Step<any>;
  detail: Record<string, unknown>;
  index?: { invoices?: string[]; payments?: string[]; engagements?: string[] };
}
export interface LedgerHandler {
  recordKind: "invoice" | "payment" | "engagement";
  /** Reads only. Refuses, or returns the snapshot of facts to freeze with the operation. */
  validate(read: LedgerReader, operation: LedgerOperation): Promise<Record<string, unknown> | void>;
  /** Idempotent writes. Safe to run again after any interruption, by this caller or another. */
  execute(scope: LedgerScope, operation: LedgerOperation): Promise<Execution>;
}

export const ledgerEventId = (accountId: string, operationId: string) =>
  hash(["billing-journal-v1", "ledger", accountId, operationId]);
export const ledgerRequestHash = (
  action: LedgerAction,
  accountId: string,
  actor: BillingActor,
  request: unknown,
) => hash(["billing-ledger-request-v1", action, accountId, actor, request]);

const isConflict = (error: unknown) =>
  error instanceof IdentityFileError && ["conflict", "operation_mismatch"].includes(error.code);

/** A UUID derived from an operation ID and a label, so a retried operation finds the records it already wrote. */
export function deterministicId(operationId: string, label: string): string {
  const digest = hash(["billing-id-v1", operationId, label]);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Read-only views of the ledger, with every invoice's figures recomputed from its references. */
export class LedgerReader {
  constructor(readonly files: IdentityFiles) {}
  async head(accountId: string): Promise<LedgerHead> {
    return (await this.files.get<LedgerHead>(ledgerPath(accountId)))?.value ?? emptyHead(accountId);
  }
  async invoice(invoiceId: string): Promise<LedgerInvoice | null> {
    const stored = await this.files.get<LedgerInvoice>(invoicePath(invoiceId));
    return stored ? withDerivedFigures(stored.value) : null;
  }
  async payment(paymentId: string): Promise<LedgerPayment | null> {
    return (await this.files.get<LedgerPayment>(paymentPath(paymentId)))?.value ?? null;
  }
  async invoices(accountId: string): Promise<LedgerInvoice[]> {
    const head = await this.head(accountId);
    const found = await Promise.all(head.invoices.map((id) => this.invoice(id)));
    return found.filter((invoice): invoice is LedgerInvoice => invoice !== null);
  }
  async payments(accountId: string): Promise<LedgerPayment[]> {
    const head = await this.head(accountId);
    const found = await Promise.all(head.payments.map((id) => this.payment(id)));
    return found.filter((payment): payment is LedgerPayment => payment !== null);
  }
  async engagement(engagementId: string): Promise<LedgerEngagement | null> {
    return (await this.files.get<LedgerEngagement>(engagementPath(engagementId)))?.value ?? null;
  }
  async engagements(accountId: string): Promise<LedgerEngagement[]> {
    const head = await this.head(accountId);
    const found = await Promise.all((head.engagements ?? []).map((id) => this.engagement(id)));
    return found.filter((engagement): engagement is LedgerEngagement => engagement !== null);
  }
  async profile(accountId: string): Promise<BillingProfile | null> {
    return (await this.files.get<BillingProfile>(profilePath(accountId)))?.value ?? null;
  }
  async issuer(): Promise<IssuerRecord | null> {
    return (await this.files.get<IssuerRecord>(ISSUER_FILE))?.value ?? null;
  }
  async event(accountId: string, operationId: string): Promise<JournalEvent | null> {
    return (
      (await this.files.get<JournalEvent>(journalPath(ledgerEventId(accountId, operationId))))?.value ?? null
    );
  }
}
const emptyHead = (accountId: string): LedgerHead => ({
  version: 1,
  kind: "billing-ledger-head",
  accountId,
  revision: 0,
  invoices: [],
  payments: [],
  journal: [],
});

/** What one operation may do while it executes. Every write is idempotent by the operation ID. */
export class LedgerScope {
  readonly steps: Step<any>[] = [];
  /** True once anything was written, after which the operation can no longer be abandoned. */
  wrote = false;
  readonly read: LedgerReader;
  constructor(
    readonly files: IdentityFiles,
    readonly operation: LedgerOperation,
    private eventId: string,
    private setNumber: (number: string) => Promise<void>,
  ) {
    this.read = new LedgerReader(files);
  }

  /**
   * One compare-and-set write of one record for this operation. A record that already carries this operation in its
   * audit was written by an earlier run, and is returned as it was; a lost race re-reads and re-evaluates.
   */
  async step<T extends VersionedRecord>(
    path: string,
    action: BillingAction,
    build: (current: T | null) => Omit<T, "revision" | "creation" | "audit">,
  ): Promise<Step<T>> {
    const { operation } = this;
    for (let attempt = 0; attempt < 12; attempt++) {
      const stored = await this.files.get<T>(path),
        current = stored?.value ?? null;
      const applied = current?.audit.find((entry) => entry.operationId === operation.operationId);
      const identity = (base: number) =>
        storageIdentity(this.eventId + hash(path), operation.requestHash, base);
      if (current && applied) {
        const result = this.remember({
          path,
          record: current,
          beforeRevision: applied.revision > 1 ? applied.revision - 1 : null,
          afterRevision: applied.revision,
          ...identity(applied.revision - 1),
        });
        return result;
      }
      const base = current?.revision ?? 0;
      const next = {
        ...build(current),
        revision: base + 1,
        creation: current?.creation ?? { operationId: operation.operationId, at: operation.at },
        audit: [
          ...(current?.audit ?? []),
          {
            revision: base + 1,
            action,
            operationId: operation.operationId,
            requestHash: operation.requestHash,
            actor: operation.actor,
            at: operation.at,
          },
        ].slice(-MAXIMUM_AUDIT_ENTRIES),
      } as unknown as T;
      if (Buffer.byteLength(JSON.stringify(next)) > 65536)
        fail(409, "billing_capacity", "Billing record byte capacity reached.");
      const storage = identity(base);
      try {
        const committed = await commitWithRetry(
          this.files,
          path,
          storage.storageOperationId,
          storage.storageRequestHash,
          next,
          stored?.revision ?? null,
        );
        this.wrote = true;
        return this.remember({
          path,
          record: committed.value,
          beforeRevision: current ? base : null,
          afterRevision: base + 1,
          ...storage,
        });
      } catch (error) {
        if (isConflict(error)) continue;
        throw error;
      }
    }
    return fail(409, "busy", "Concurrent billing change; retry.");
  }
  private remember<T>(step: Step<T>): Step<T> {
    this.steps.push(step);
    return step;
  }

  /** Writes a record that must not exist yet (an allocation or a credit). */
  create<T extends VersionedRecord>(
    path: string,
    action: BillingAction,
    value: Omit<T, "revision" | "creation" | "audit">,
  ) {
    return this.step<T>(path, action, (current) => {
      if (current) fail(409, "busy", "Concurrent billing change; retry.");
      return value;
    });
  }

  /** The next free number of the month, claimed with a conditional write, so two issues can never share one. */
  async claimNumber(month: string, invoiceId: string): Promise<string> {
    const { operation } = this;
    let candidate = operation.number
      ? Number(operation.number.slice(7))
      : ((await this.files.get<InvoiceSequence>(sequencePath(month)))?.value.next ?? 1);
    for (let guard = 0; guard < MAXIMUM_INVOICES_PER_MONTH + 5; guard++) {
      if (candidate > MAXIMUM_INVOICES_PER_MONTH)
        fail(409, "invoice_numbers_exhausted", "The month has no invoice numbers left.");
      const number = `${month}-${String(candidate).padStart(3, "0")}`;
      if (operation.number !== number) {
        await this.setNumber(number);
        operation.number = number;
      }
      if (await this.claim(number, invoiceId)) return number;
      candidate += 1;
    }
    return fail(409, "busy", "Concurrent billing change; retry.");
  }
  /** Claims one specific number for the invoice; false when another invoice holds it. */
  async claim(number: string, invoiceId: string): Promise<boolean> {
    const claim: NumberClaim = {
      version: 1,
      kind: "billing-number",
      number,
      invoiceId,
      accountId: this.operation.accountId,
      operationId: this.operation.operationId,
    };
    try {
      await commitWithRetry(
        this.files,
        numberPath(number),
        `billing:number:${number}:${invoiceId}`,
        hash(["billing-number-v1", number, invoiceId]),
        claim,
        null,
      );
      this.wrote = true;
      return true;
    } catch (error) {
      if (!isConflict(error)) throw error;
      return (await this.files.get<NumberClaim>(numberPath(number)))?.value.invoiceId === invoiceId;
    }
  }
  /** Moves the month's counter past a number. Only ever forward, and only a hint: claims decide uniqueness. */
  async advanceCounter(month: string, atLeast: number): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const stored = await this.files.get<InvoiceSequence>(sequencePath(month));
      if ((stored?.value.next ?? 1) >= atLeast) return;
      try {
        await commitWithRetry(
          this.files,
          sequencePath(month),
          `billing:sequence:${month}:${atLeast}:${stored?.revision ?? "new"}`,
          hash(["billing-sequence-v1", month, atLeast, stored?.revision ?? null]),
          { version: 1, kind: "billing-sequence", month, next: atLeast } satisfies InvoiceSequence,
          stored?.revision ?? null,
        );
        return;
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
  }
}

/**
 * Serializes every ledger mutation for one account and finishes it, whoever is running. The account's head record
 * (`ledgers/<accountId>.json`) has a revision that moves with every accepted operation. An operation is read and
 * validated at one head revision, then accepted by a compare-and-set of the head that records it as pending; a lost
 * race re-reads and re-validates. The accepted operation then writes its records (each idempotent by the operation
 * ID), writes its one journal event and releases the head. If anything stops part-way, the pending operation sits in
 * the head, and the next operation on the account, or a replay of the same one, finishes it first. Over-allocation
 * and a second period invoice are refused under this serialization, never raced.
 */
export class LedgerEngine {
  readonly reader: LedgerReader;
  constructor(
    private files: IdentityFiles,
    private handlers: Record<LedgerAction, LedgerHandler>,
  ) {
    this.reader = new LedgerReader(files);
  }

  async run(operation: LedgerOperation): Promise<{ event: JournalEvent; replayed: boolean }> {
    const { accountId, operationId } = operation;
    for (let attempt = 0; attempt < 30; attempt++) {
      const journaled = await this.reader.event(accountId, operationId);
      if (journaled) {
        if (journaled.requestHash !== operation.requestHash) idempotencyConflict();
        await this.release(accountId, operationId, journaled);
        return { event: journaled, replayed: true };
      }
      const stored = await this.files.get<LedgerHead>(ledgerPath(accountId));
      const head = stored?.value ?? emptyHead(accountId);
      if (head.pending) {
        if (head.pending.operationId === operationId && head.pending.requestHash !== operation.requestHash)
          idempotencyConflict();
        // Whoever is pending finishes first, whether it is another operation or this one resumed.
        const own = head.pending.operationId === operationId;
        try {
          const finished = await this.drive(head.pending);
          if (own) return { event: finished, replayed: true };
        } catch (error) {
          // Another operation's refusal belongs to its caller, not to this one.
          if (own || !(error instanceof BillingError)) throw error;
        }
        continue;
      }
      let snapshot: Record<string, unknown> | void;
      try {
        snapshot = await this.handlers[operation.action].validate(this.reader, operation);
      } catch (error) {
        // A refusal counts only if nothing moved while it was being worked out; otherwise look again.
        const now = await this.files.get<LedgerHead>(ledgerPath(accountId));
        if (now?.revision !== stored?.revision) continue;
        throw error;
      }
      const accepted: LedgerOperation = { ...operation, ...(snapshot ? { snapshot } : {}) };
      try {
        await commitWithRetry(
          this.files,
          ledgerPath(accountId),
          `billing:ledger:${hash([accountId, operationId, "accept", head.revision])}`,
          hash(["billing-ledger-v1", operation.requestHash, "accept", head.revision]),
          { ...head, revision: head.revision + 1, pending: accepted } satisfies LedgerHead,
          stored?.revision ?? null,
        );
      } catch (error) {
        if (isConflict(error)) continue;
        throw error;
      }
      return { event: await this.drive(accepted), replayed: false };
    }
    return fail(409, "busy", "Concurrent billing change; retry.");
  }

  /** Runs a pending operation to its journal event and releases the head. Safe to repeat. */
  private async drive(pending: LedgerOperation): Promise<JournalEvent> {
    const { accountId, operationId } = pending;
    const existing = await this.reader.event(accountId, operationId);
    if (existing) {
      await this.release(accountId, operationId, existing);
      return existing;
    }
    const eventId = ledgerEventId(accountId, operationId);
    const handler = this.handlers[pending.action];
    const scope = new LedgerScope(this.files, pending, eventId, (number) =>
      this.recordNumber(accountId, operationId, number),
    );
    let execution: Execution;
    try {
      execution = await handler.execute(scope, pending);
    } catch (error) {
      // A refusal before anything was written (a number already taken) abandons the operation and frees the account.
      if (error instanceof BillingError && !scope.wrote) await this.abandon(accountId, operationId);
      throw error;
    }
    const { primary } = execution;
    const event: JournalEvent = {
      version: 1,
      kind: "billing-journal-event",
      eventId,
      action: execution.action,
      recordKind: handler.recordKind,
      recordPath: primary.path,
      accountId,
      operationId,
      requestHash: pending.requestHash,
      actor: pending.actor,
      beforeRevision: primary.beforeRevision,
      afterRevision: primary.afterRevision,
      storageOperationId: primary.storageOperationId,
      storageRequestHash: primary.storageRequestHash,
      at: pending.at,
      records: scope.steps.map((step) => ({
        path: step.path,
        beforeRevision: step.beforeRevision,
        afterRevision: step.afterRevision,
      })),
      detail: execution.detail,
      ...(execution.index ? { index: execution.index } : {}),
    };
    try {
      await commitWithRetry(
        this.files,
        journalPath(eventId),
        `billing:journal:${eventId}`,
        pending.requestHash,
        event,
        null,
      );
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
    const written = (await this.reader.event(accountId, operationId)) ?? event;
    await this.release(accountId, operationId, written);
    return written;
  }

  /** Records the invoice number chosen for the pending operation on the head, before the number is claimed. */
  private async recordNumber(accountId: string, operationId: string, number: string) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const stored = await this.files.get<LedgerHead>(ledgerPath(accountId));
      const head = stored?.value;
      if (!stored || !head?.pending || head.pending.operationId !== operationId) return;
      try {
        await commitWithRetry(
          this.files,
          ledgerPath(accountId),
          `billing:ledger:${hash([accountId, operationId, "number", head.revision, number])}`,
          hash(["billing-ledger-v1", "number", number, head.revision]),
          { ...head, revision: head.revision + 1, pending: { ...head.pending, number } } satisfies LedgerHead,
          stored.revision,
        );
        return;
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
    fail(409, "busy", "Concurrent billing change; retry.");
  }

  private async abandon(accountId: string, operationId: string) {
    await this.update(accountId, operationId, "abandon", (head) => {
      const { pending: _pending, ...rest } = head;
      return { ...rest, revision: head.revision + 1 };
    });
  }

  /** Clears the pending operation and adds what it created to the account's index. Does nothing once cleared. */
  private async release(accountId: string, operationId: string, event: JournalEvent) {
    await this.update(accountId, operationId, "release", (head) => {
      const { pending: _pending, ...rest } = head;
      const union = (list: string[], more: string[] = []) => [
        ...list,
        ...more.filter((id) => !list.includes(id)),
      ];
      return {
        ...rest,
        revision: head.revision + 1,
        invoices: union(head.invoices, event.index?.invoices),
        payments: union(head.payments, event.index?.payments),
        ...(head.engagements || event.index?.engagements
          ? { engagements: union(head.engagements ?? [], event.index?.engagements) }
          : {}),
        journal: union(head.journal, [event.eventId]).slice(-MAXIMUM_INDEXED_EVENTS),
      };
    });
  }

  private async update(
    accountId: string,
    operationId: string,
    phase: string,
    next: (head: LedgerHead) => LedgerHead,
  ) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const stored = await this.files.get<LedgerHead>(ledgerPath(accountId));
      if (!stored || stored.value.pending?.operationId !== operationId) return;
      try {
        await commitWithRetry(
          this.files,
          ledgerPath(accountId),
          `billing:ledger:${hash([accountId, operationId, phase, stored.value.revision])}`,
          hash(["billing-ledger-v1", phase, operationId, stored.value.revision]),
          next(stored.value),
          stored.revision,
        );
        return;
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
    fail(409, "busy", "Concurrent billing change; retry.");
  }
}

/** All allocation documents are only ever created; this reads one back (for audits and rebuilds). */
export async function readAllocation(files: IdentityFiles, allocationId: string) {
  return (await files.get<LedgerAllocation>(allocationPath(allocationId)))?.value ?? null;
}
