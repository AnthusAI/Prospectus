import { createHash } from "node:crypto";
import { ControlConflict, type ConditionalControlStore } from "./control-store";

export type InboxStatus = "pending" | "filed" | "review";
/** Everything the visitor submitted, kept under the contact notice until deletion is requested. */
export interface InboxItem<I = unknown> {
  version: 1;
  kind: "intake-inbox";
  workspace: string;
  submission_id: string;
  fingerprint: string;
  status: InboxStatus;
  reason?: string;
  issue_id?: string;
  inquiry: I;
}
export interface StoredInboxItem<I = unknown> {
  item: InboxItem<I>;
  key: string;
  revision: string;
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Formats a hash as a stable RFC 4122 style identifier (version 5 layout). */
export function derivedUuid(seed: string): string {
  const h = sha(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 + (parseInt(h[16], 16) % 4)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Create-first inbox of full inquiries inside the intake role's existing control prefix. Hashed
 * paths only (intake-receipts/<sha256>.json) so the scoped bridge and IAM need no change.
 */
export class IntakeInbox {
  constructor(
    private store: ConditionalControlStore,
    private workspace: string,
  ) {}
  keyFor(submissionId: string, fingerprint?: string) {
    const seed = fingerprint
      ? `${this.workspace}\ninbox\n${submissionId}\n${fingerprint}`
      : `${this.workspace}\ninbox\n${submissionId}`;
    return `intake-receipts/${sha(seed)}.json`;
  }
  decode<I>(bytes: string, revision: string, key: string): StoredInboxItem<I> {
    const item = JSON.parse(bytes) as InboxItem<I>;
    if (item.version !== 1 || item.kind !== "intake-inbox" || item.workspace !== this.workspace)
      throw new Error("Inbox item needs private repair.");
    return { item, key, revision };
  }
  /**
   * Stores the inquiry unless an identical one is already present. Same submission id with other
   * content is a new inquiry under a derived key and identifier; it is never rejected.
   */
  async capture<I extends { id: string }>(
    submissionId: string,
    fingerprint: string,
    build: (id: string) => I,
  ): Promise<StoredInboxItem<I>> {
    const candidates: Array<{ key: string; id: string }> = [
      { key: this.keyFor(submissionId), id: submissionId },
      {
        key: this.keyFor(submissionId, fingerprint),
        id: derivedUuid(`${this.workspace}\nresubmission\n${submissionId}\n${fingerprint}`),
      },
    ];
    for (const candidate of candidates) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const item: InboxItem<I> = {
          version: 1,
          kind: "intake-inbox",
          workspace: this.workspace,
          submission_id: submissionId,
          fingerprint,
          status: "pending",
          inquiry: build(candidate.id),
        };
        try {
          const stored = await this.store.putControl(candidate.key, JSON.stringify(item), { absent: true });
          return { item, key: candidate.key, revision: stored.revision };
        } catch (error) {
          if (!(error instanceof ControlConflict)) throw error;
        }
        const object = await this.store.getControl(candidate.key);
        if (object) {
          const found = this.decode<I>(object.bytes, object.revision, candidate.key);
          if (found.item.fingerprint === fingerprint) return found;
          break; // other content under this key: try the derived key
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt, 64)));
      }
    }
    throw new Error("Inbox is busy.");
  }
  /** Best-effort status change; the pending state is always safe to retry. */
  async mark<I>(
    stored: StoredInboxItem<I>,
    status: InboxStatus,
    detail: { reason?: string; issue_id?: string } = {},
  ): Promise<void> {
    const next = { ...stored.item, status, ...detail };
    const written = await this.store.putControl(stored.key, JSON.stringify(next), {
      revision: stored.revision,
    });
    stored.item = next;
    stored.revision = written.revision;
  }
}
