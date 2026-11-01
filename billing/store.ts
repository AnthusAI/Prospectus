import { createHash } from "node:crypto";
import { IdentityFileError, type IdentityFiles, type IdentityObject } from "../accounts/identity-files";
import { UUID_PATTERN } from "../accounts/model";
import { isProductName, matchesStringPattern } from "../accounts/validation-rules";
import {
  fail,
  MAXIMUM_AUDIT_ENTRIES,
  type BillingAction,
  isOpenLine,
  RESERVATION_TIMEOUT_MS,
  type BillingActor,
  type BillingLine,
  type BillingProfile,
  type JournalEvent,
  type OpenLineReservation,
  type VersionedRecord,
} from "./model";

export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Every segment after the kind must be hex digits or hyphens, so the product name is stored hex-encoded. */
export const hexSegment = (value: string) => Buffer.from(value, "utf8").toString("hex");
export const profilePath = (accountId: string) => `profiles/${accountId}.json`;
export const lineDirectory = (accountId: string) => `lines/${accountId}/`;
export const linePath = (accountId: string, product: string) =>
  `${lineDirectory(accountId)}${hexSegment(product)}.json`;
export const journalPath = (eventId: string) => `journal/${eventId}.json`;

export function requireAccountId(accountId: unknown): string {
  if (!matchesStringPattern(accountId, UUID_PATTERN)) fail(400, "invalid_account", "Account UUID required.");
  return accountId.toLowerCase();
}
export function requireProduct(product: unknown): string {
  if (!isProductName(product)) fail(400, "invalid_product", "Registered product name required.");
  return product;
}
export function requireOperationId(operationId: unknown): string {
  if (!matchesStringPattern(operationId, UUID_PATTERN))
    fail(400, "invalid_operation_id", "UUID operation ID required.");
  return operationId.toLowerCase();
}
export function requireExpectedRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail(400, "invalid_revision", "Expected revision must be a whole number.");
  return value as number;
}

async function commitWithRetry<T>(
  files: IdentityFiles,
  path: string,
  operationId: string,
  requestHash: string,
  value: T,
  revision: string | null,
): Promise<IdentityObject<T>> {
  // Retry only the same frozen intent; never invent a replacement operation while publication may be in flight.
  for (let attempt = 0; ; attempt++)
    try {
      return await files.commit(path, operationId, requestHash, value, revision);
    } catch (error) {
      if (
        !(error instanceof IdentityFileError && ["uncertain", "unavailable"].includes(error.code)) ||
        attempt >= 3
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
}

/** Open lines on an account, read from its own line files. */
export async function readLines(files: IdentityFiles, accountId: string): Promise<BillingLine[]> {
  const lines: BillingLine[] = [];
  for (const path of await files.list(lineDirectory(accountId))) {
    const stored = await files.get<BillingLine>(path);
    if (stored) lines.push(stored.value);
  }
  return lines.sort((left, right) => left.product.localeCompare(right.product));
}

/**
 * The profile's open-line reservations that still hold: the line is open, or its file has not appeared yet and the
 * reservation is younger than the timeout (a create in flight). A reservation whose line ended is a release that did
 * not finish, and one whose line never appeared is a create that failed; neither blocks.
 */
export async function liveReservations(
  files: IdentityFiles,
  profile: Pick<BillingProfile, "accountId" | "openLines"> | null,
  now: string,
): Promise<Record<string, OpenLineReservation>> {
  const live: Record<string, OpenLineReservation> = {};
  for (const [product, reservation] of Object.entries(profile?.openLines ?? {})) {
    const line = (await files.get<BillingLine>(linePath(profile!.accountId, product)))?.value;
    const opened = line?.openedBy === reservation.operationId;
    const inFlight = !opened && Date.parse(now) - Date.parse(reservation.reservedAt) < RESERVATION_TIMEOUT_MS;
    if ((line && isOpenLine(line)) || inFlight) live[product] = reservation;
  }
  return live;
}

/**
 * Rewrites the profile's open-line reservations with compare-and-set, re-reading on a lost race. This is the one
 * record that both opening a line and switching mode write, which is what keeps them from passing each other. It
 * advances the profile revision and writes no journal event; the line operation it belongs to writes that. `change`
 * returns the next reservations, or null when nothing needs writing.
 */
export async function updateOpenLines(
  files: IdentityFiles,
  accountId: string,
  intent: string,
  change: (
    profile: BillingProfile | null,
  ) => Promise<Record<string, OpenLineReservation> | null> | Record<string, OpenLineReservation> | null,
): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const stored = await files.get<BillingProfile>(profilePath(accountId)),
      profile = stored?.value ?? null;
    const openLines = await change(profile);
    if (!openLines) return;
    if (!stored || !profile) fail(409, "not_yet_billable", "Account has no billing profile.");
    const { openLines: _previous, ...rest } = profile;
    const next: BillingProfile = {
      ...rest,
      ...(Object.keys(openLines).length ? { openLines } : {}),
      revision: profile.revision + 1,
    };
    try {
      await commitWithRetry(
        files,
        profilePath(accountId),
        `billing:open-lines:${hash([intent, profile.revision])}`,
        hash(["billing-open-lines-v1", intent, profile.revision]),
        next,
        stored.revision,
      );
      return;
    } catch (error) {
      if (error instanceof IdentityFileError && ["conflict", "operation_mismatch"].includes(error.code))
        continue;
      throw error;
    }
  }
  fail(409, "busy", "Concurrent billing change; retry.");
}

/** True once a mutation's journal event exists, so a replay is answered without repeating any side step. */
export async function isJournaled(
  files: IdentityFiles,
  recordKind: "profile" | "line",
  accountId: string,
  product: string | undefined,
  operationId: string,
) {
  return !!(await files.get(journalPath(journalEventId(recordKind, accountId, product, operationId))));
}
const journalEventId = (
  recordKind: "profile" | "line",
  accountId: string,
  product: string | undefined,
  operationId: string,
) => hash(["billing-journal-v1", recordKind, accountId, product ?? null, operationId]);

export interface Mutation<T extends VersionedRecord> {
  action: BillingAction;
  recordKind: "profile" | "line";
  path: string;
  accountId: string;
  product?: string;
  operationId: string;
  actor: BillingActor;
  /** The normalized client request. Same operation ID with a different request is an idempotency conflict. */
  request: unknown;
  expectedRevision?: number;
  at: string;
  /** Builds the next record from the current one, or refuses. Revision, creation and audit are set here. */
  apply: (current: T | null) => Promise<Omit<T, "revision" | "creation" | "audit">>;
}

const storageIdentity = (eventId: string, requestHash: string, baseRevision: number) => ({
  storageOperationId: `billing:${eventId}:${baseRevision}`,
  storageRequestHash: hash(["billing-storage-v1", requestHash, baseRevision]),
});

/**
 * One billing mutation: a revision compare-and-set on its own record, then exactly one journal event. The event ID
 * is derived from the record and the client operation ID, so a replay finds the event and returns the original
 * committed result through Virtuus without writing a second revision. A lost race re-reads and re-evaluates; a
 * stated expected revision then refuses as a revision conflict.
 */
export async function mutate<T extends VersionedRecord>(
  files: IdentityFiles,
  mutation: Mutation<T>,
): Promise<{ record: T; replayed: boolean }> {
  const requestHash = hash([
    "billing-request-v1",
    mutation.recordKind,
    mutation.action,
    mutation.accountId,
    mutation.product ?? null,
    mutation.actor,
    mutation.request,
  ]);
  const eventId = journalEventId(
    mutation.recordKind,
    mutation.accountId,
    mutation.product,
    mutation.operationId,
  );
  const replay = async (storage: { storageOperationId: string; storageRequestHash: string }) =>
    // The committed intent answers first, so this returns the original stored result and never writes.
    (
      await commitWithRetry(
        files,
        mutation.path,
        storage.storageOperationId,
        storage.storageRequestHash,
        null,
        null,
      )
    ).value as unknown as T;
  const recordJournal = async (event: JournalEvent) => {
    try {
      await commitWithRetry(
        files,
        journalPath(eventId),
        `billing:journal:${eventId}`,
        requestHash,
        event,
        null,
      );
    } catch (error) {
      if (!(error instanceof IdentityFileError && ["conflict", "operation_mismatch"].includes(error.code)))
        throw error;
      const existing = await files.get<JournalEvent>(journalPath(eventId));
      if (existing?.value.requestHash !== requestHash) idempotencyConflict();
    }
  };
  const event = (beforeRevision: number | null, afterRevision: number): JournalEvent => ({
    version: 1,
    kind: "billing-journal-event",
    eventId,
    action: mutation.action,
    recordKind: mutation.recordKind,
    recordPath: mutation.path,
    accountId: mutation.accountId,
    ...(mutation.product ? { product: mutation.product } : {}),
    operationId: mutation.operationId,
    requestHash,
    actor: mutation.actor,
    beforeRevision,
    afterRevision,
    ...storageIdentity(eventId, requestHash, afterRevision - 1),
    at: mutation.at,
  });
  for (let attempt = 0; attempt < 12; attempt++) {
    const journaled = await files.get<JournalEvent>(journalPath(eventId));
    if (journaled) {
      if (journaled.value.requestHash !== requestHash) idempotencyConflict();
      return { record: await replay(journaled.value), replayed: true };
    }
    const stored = await files.get<T>(mutation.path),
      current = stored?.value ?? null;
    const applied = current?.audit.find((entry) => entry.operationId === mutation.operationId);
    if (applied) {
      // Committed before its journal event was written: finish the journal, then answer as a replay.
      if (applied.requestHash !== requestHash) idempotencyConflict();
      await recordJournal(event(applied.revision > 1 ? applied.revision - 1 : null, applied.revision));
      return {
        record: await replay(storageIdentity(eventId, requestHash, applied.revision - 1)),
        replayed: true,
      };
    }
    const baseRevision = current?.revision ?? 0;
    if (mutation.expectedRevision !== undefined && mutation.expectedRevision !== baseRevision)
      fail(409, "revision_conflict", "The billing record changed since it was read; read it again.");
    const next = {
      ...(await mutation.apply(current)),
      revision: baseRevision + 1,
      creation: current?.creation ?? { operationId: mutation.operationId, at: mutation.at },
      audit: [
        ...(current?.audit ?? []),
        {
          revision: baseRevision + 1,
          action: mutation.action,
          operationId: mutation.operationId,
          requestHash,
          actor: mutation.actor,
          at: mutation.at,
        },
      ].slice(-MAXIMUM_AUDIT_ENTRIES),
    } as T;
    if (Buffer.byteLength(JSON.stringify(next)) > 65536)
      fail(409, "billing_capacity", "Billing record byte capacity reached.");
    const storage = storageIdentity(eventId, requestHash, baseRevision);
    let committed: IdentityObject<T>;
    try {
      committed = await commitWithRetry(
        files,
        mutation.path,
        storage.storageOperationId,
        storage.storageRequestHash,
        next,
        stored?.revision ?? null,
      );
    } catch (error) {
      if (error instanceof IdentityFileError && ["conflict", "operation_mismatch"].includes(error.code))
        continue;
      throw error;
    }
    await recordJournal(event(current ? baseRevision : null, baseRevision + 1));
    return { record: committed.value, replayed: false };
  }
  fail(409, "busy", "Concurrent billing change; retry.");
}

function idempotencyConflict(): never {
  fail(409, "idempotency_conflict", "Operation ID belongs to a different billing request.");
}
