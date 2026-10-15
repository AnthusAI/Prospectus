import { createHash } from "node:crypto";
import { ControlConflict, type ConditionalControlStore, type ControlObject } from "./control-store";

export interface CreateIntent { method: "POST"; path: "/issues"; operation: string; body: Record<string, unknown> }
export interface IdentityClaim { version: 1; workspace: string; email: string; issueId?: string; create?: CreateIntent }
export class SharedReceiptConflict extends Error {}
export class IdentityClaims {
  constructor(private store: ConditionalControlStore, private workspace: string) {}
  private key(email: string) { return `intake-identities/${createHash("sha256").update(`${this.workspace}\n${email}`).digest("hex")}.json`; }
  private decode(object: ControlObject, email: string): IdentityClaim {
    const claim = JSON.parse(object.bytes) as IdentityClaim;
    if (claim.version !== 1 || claim.workspace !== this.workspace || claim.email !== email || (!claim.issueId && !claim.create)) throw new Error("Identity claim needs private repair.");
    return claim;
  }
  async claimReceipt(id: string, fingerprint: string, email: string): Promise<void> {
    const key = `intake-receipts/${createHash("sha256").update(`${this.workspace}\n${id}`).digest("hex")}.json`;
    for (let attempt = 0; attempt < 10; attempt++) {
      const object = await this.store.getControl(key);
      if (object) {
        const prior = JSON.parse(object.bytes) as { version: number; workspace: string; id: string; fingerprint: string; email: string };
        if (prior.version !== 1 || prior.workspace !== this.workspace || prior.id !== id || prior.fingerprint !== fingerprint || prior.email !== email) throw new SharedReceiptConflict("Shared receipt belongs to another submission.");
        return;
      }
      try { await this.store.putControl(key, JSON.stringify({ version: 1, workspace: this.workspace, id, fingerprint, email }), { absent: true }); return; }
      catch (error) {
        if (!(error instanceof ControlConflict)) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt, 64)));
      }
    }
    throw new Error("Shared receipt is busy; retry the submission.");
  }
  async getOrCreate(email: string, proposal: () => Promise<IdentityClaim>): Promise<IdentityClaim> {
    const key = this.key(email);
    for (let attempt = 0; attempt < 10; attempt++) {
      const object = await this.store.getControl(key);
      if (object) return this.decode(object, email);
      const claim = await proposal();
      try { return this.decode(await this.store.putControl(key, JSON.stringify(claim), { absent: true }), email); }
      catch (error) {
        if (!(error instanceof ControlConflict)) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt, 64)));
      }
    }
    throw new Error("Identity claim is busy; retry the receipt.");
  }
  async publishIssue(email: string, issueId: string): Promise<void> {
    const key = this.key(email);
    for (let attempt = 0; attempt < 10; attempt++) {
      const object = await this.store.getControl(key);
      if (!object) throw new Error("Identity claim disappeared; do not recreate it while intake is active.");
      const claim = this.decode(object, email);
      if (claim.issueId) {
        if (claim.issueId !== issueId) throw new Error("Identity claim points to another canonical issue.");
        return;
      }
      try { await this.store.putControl(key, JSON.stringify({ ...claim, issueId }), { revision: object.revision }); return; }
      catch (error) {
        if (!(error instanceof ControlConflict)) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt, 64)));
      }
    }
    throw new Error("Identity completion is busy; retry the receipt.");
  }
}
