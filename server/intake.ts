import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { IssueRecord } from "../src/client";
import type { ConditionalControlStore } from "./control-store";
import { IdentityClaims, SharedReceiptConflict } from "./identity";

export const NOTICE_VERSION = "synthetic-demo-v1";
export class IntakeError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
export interface Submission {
  submission_id: string; name: string; email: string; company: string; message: string;
  website: string; notice_version: string; marketing_opt_in: boolean;
  page_path: string; campaign: Record<string, string>;
}
export interface Inquiry {
  id: string; kind: "demo"; name: string; email: string; company: string; message: string;
  received_at: string; source: { site_id: string; form_id: string; page_path: string; campaign: Record<string, string> };
  notice_version: string; marketing_opt_in: boolean;
  fingerprint?: string;
}
interface WriteIntent { method: "POST" | "PATCH"; path: string; operation: string; revision?: string; body: Record<string, unknown> }
interface Receipt { fingerprint: string; inquiry: Inquiry; complete: boolean; write?: WriteIntent }
interface Ledger { version: 1; workspace: string; contacts: Record<string, string>; receipts: Record<string, Receipt> }
export interface IntakeOptions {
  directory: string; workspace: string; owner: string; siteId: string; formId: string;
  request: (path: string, init?: RequestInit) => Promise<IssueRecord | { issues: IssueRecord[] }>;
  now?: () => Date;
  identityStore: ConditionalControlStore;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const campaignKeys = ["utm_source", "utm_medium", "utm_campaign"];

export function validateSubmission(raw: unknown): Submission {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new IntakeError(400, "Invalid request.");
  const fields = raw as Record<string, unknown>;
  const allowed = ["submission_id", "name", "email", "company", "message", "website", "notice_version", "marketing_opt_in", "page_path", "campaign"];
  if (Object.keys(fields).some((key) => !allowed.includes(key))) throw new IntakeError(400, "Unknown form field.");
  function text(key: string, max: number, required = false) {
    const value = fields[key] ?? "";
    if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new IntakeError(400, `Invalid ${key}.`);
    const cleaned = value.trim();
    if (required && !cleaned) throw new IntakeError(400, `${key} is required.`);
    return cleaned;
  }
  const submission_id = text("submission_id", 36, true);
  if (!uuid.test(submission_id)) throw new IntakeError(400, "Invalid submission receipt.");
  const email = text("email", 254, true).toLowerCase();
  if (!/^[^\s@]+@(?:[a-z0-9-]+\.)+invalid$/.test(email)) throw new IntakeError(400, "Use a synthetic email ending in .invalid for this local demo.");
  const notice_version = text("notice_version", 50, true);
  if (notice_version !== NOTICE_VERSION) throw new IntakeError(400, "Reload the form to read the current demo notice.");
  if (fields.marketing_opt_in !== undefined && typeof fields.marketing_opt_in !== "boolean") throw new IntakeError(400, "Invalid marketing preference.");
  const campaign = fields.campaign ?? {};
  if (!campaign || typeof campaign !== "object" || Array.isArray(campaign)) throw new IntakeError(400, "Invalid campaign.");
  const attribution: Record<string, string> = {};
  for (const [key, value] of Object.entries(campaign)) {
    if (!campaignKeys.includes(key) || typeof value !== "string" || value.length > 120 || !/^[\w .-]*$/.test(value)) throw new IntakeError(400, "Invalid campaign.");
  }
  for (const key of campaignKeys) if (key in campaign) attribution[key] = (campaign as Record<string, string>)[key].trim();
  const page_path = text("page_path", 200) || "/request-demo";
  if (!/^\/[a-z0-9/_-]*$/i.test(page_path)) throw new IntakeError(400, "Invalid page path.");
  return { submission_id, name: text("name", 150, true), email, company: text("company", 150), message: text("message", 3000, true), website: text("website", 200), notice_version, marketing_opt_in: fields.marketing_opt_in === true, page_path, campaign: attribution };
}

export function nextBusinessDay(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  do { date.setUTCDate(date.getUTCDate() + 1); } while ([0, 6].includes(date.getUTCDay()));
  return date.toISOString().slice(0, 10);
}

export class IntakeService {
  private ledger!: Ledger;
  private queue: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private persistenceFailed = false;
  private locked = false;
  private identities: IdentityClaims;
  private constructor(private options: IntakeOptions) {
    this.identities = new IdentityClaims(options.identityStore, options.workspace);
  }

  static async open(options: IntakeOptions): Promise<IntakeService> {
    if (!options.owner.trim() || !options.workspace.trim() || !options.siteId || !options.formId) throw new Error("Intake requires an owner, workspace and trusted form source.");
    if (!options.identityStore) throw new Error("Intake requires an explicitly configured shared conditional identity store.");
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const lock = join(options.directory, "worker.lock");
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(join(lock, "pid"), "utf8").catch(() => ""));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Intake lock has no valid owner; inspect it before recovery.");
      try { process.kill(pid, 0); throw new Error("Another intake worker owns this ledger."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      throw new Error("Stale intake worker lock. Verify the previous worker exited before manually removing worker.lock and restarting.");
    }
    const service = new IntakeService(options);
    service.locked = true;
    try {
      await service.durableWrite(join(lock, "pid"), String(process.pid));
      try { service.ledger = JSON.parse(await readFile(join(options.directory, "receipts.json"), "utf8")) as Ledger; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        service.ledger = { version: 1, workspace: options.workspace, contacts: {}, receipts: {} };
      }
      if (service.ledger.version !== 1 || service.ledger.workspace !== options.workspace) throw new Error("Receipt ledger does not match this workspace.");
      return service;
    } catch (error) { await service.close(); throw error; }
  }

  private async durableWrite(path: string, value: string) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(this.options.directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private async save() {
    try { await this.durableWrite(join(this.options.directory, "receipts.json"), JSON.stringify(this.ledger)); }
    catch (error) { this.persistenceFailed = true; throw error; }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      await this.queue.catch(() => undefined);
      if (this.locked) { this.locked = false; await rm(join(this.options.directory, "worker.lock"), { recursive: true, force: true }); }
    })();
  }

  submit(raw: unknown): Promise<{ receipt: string; message: string }> {
    if (this.closing || this.persistenceFailed) return Promise.reject(new IntakeError(503, "Intake is unavailable. Restart after repairing local receipt storage."));
    const submission = validateSubmission(raw);
    const run = this.queue.then(async () => {
      if (!this.locked || this.persistenceFailed) throw new IntakeError(503, "Intake is unavailable.");
      if (submission.website) return { receipt: submission.submission_id, message: "Demo request received." };
      const fingerprint = hash(JSON.stringify({ submission, siteId: this.options.siteId, formId: this.options.formId }));
      const existing = this.ledger.receipts[submission.submission_id];
      if (existing && existing.fingerprint !== fingerprint) throw new IntakeError(409, "This receipt belongs to a different submission. Reload the form.");
      if (!existing) {
        if (Object.keys(this.ledger.receipts).length >= 10000) throw new IntakeError(503, "Local demo capacity reached.");
        const { submission_id, website: _website, campaign, page_path, ...contact } = submission;
        this.ledger.receipts[submission_id] = { fingerprint, complete: false, inquiry: { ...contact, fingerprint, id: submission_id, kind: "demo", received_at: (this.options.now?.() ?? new Date()).toISOString(), source: { site_id: this.options.siteId, form_id: this.options.formId, page_path, campaign } } };
        await this.save();
      }
      for (const receipt of Object.values(this.ledger.receipts)) {
        if (!receipt.complete && receipt.inquiry.email === submission.email) await this.process(receipt);
      }
      return { receipt: submission.submission_id, message: "Demo request received." };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async process(receipt: Receipt): Promise<void> {
    if (receipt.write?.method === "POST") throw new IntakeError(409, "An older pending creation needs offline identity reconciliation.", "legacy_identity_pending");
    try { await this.identities.claimReceipt(receipt.inquiry.id, receipt.fingerprint, receipt.inquiry.email); }
    catch (error) {
      if (error instanceof SharedReceiptConflict) throw new IntakeError(409, "This receipt belongs to a different submission. Reload the form.", "receipt_conflict");
      throw error;
    }
    const key = hash(`${this.options.workspace}\n${receipt.inquiry.email}`);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!receipt.write) {
        let discovered: IssueRecord | undefined;
        const claim = await this.identities.getOrCreate(receipt.inquiry.email, async () => {
          const fields = JSON.stringify([{ field: "custom.contact_email", operator: "eq", value: receipt.inquiry.email }]);
          const result = await this.options.request(`/issues?type=prospect&limit=2&fields=${encodeURIComponent(fields)}`) as { issues: IssueRecord[] };
          if (result.issues.length > 1) throw new IntakeError(409, "Contact needs private duplicate review.");
          discovered = result.issues[0];
          if (discovered) return { version: 1, workspace: this.options.workspace, email: receipt.inquiry.email, issueId: discovered.issue.id };
          const inquiry = receipt.inquiry;
          return { version: 1, workspace: this.options.workspace, email: inquiry.email, create: { method: "POST", path: "/issues", operation: randomUUID(), body: { title: inquiry.name, type: "prospect", assignee: this.options.owner, description: inquiry.message, custom: { company: inquiry.company, contact_email: inquiry.email, next_action: "Respond to demo request", next_follow_up_at: nextBusinessDay(new Date(inquiry.received_at)), first_source: inquiry.source, latest_source: inquiry.source, latest_inquiry_at: inquiry.received_at, inquiries: [inquiry] } } } };
        });
        let record: IssueRecord;
        if (claim.issueId) record = discovered?.issue.id === claim.issueId ? discovered : await this.options.request(`/issues/${encodeURIComponent(claim.issueId)}`) as IssueRecord;
        else {
          const create = claim.create!;
          record = await this.options.request(create.path, { method: "POST", headers: { "Content-Type": "application/json", "X-Operation-Id": create.operation }, body: JSON.stringify(create.body) }) as IssueRecord;
          await this.identities.publishIssue(receipt.inquiry.email, record.issue.id);
          record = await this.options.request(`/issues/${encodeURIComponent(record.issue.id)}`) as IssueRecord;
        }
        this.ledger.contacts[key] = record.issue.id;
          const inquiries = record.issue.custom?.inquiries ?? [];
          if (!Array.isArray(inquiries) || inquiries.some((item) => !item || typeof item !== "object" || typeof item.id !== "string")) throw new IntakeError(409, "Contact inquiry history needs private review.");
          const duplicate = inquiries.find((item: Inquiry) => item.id === receipt.inquiry.id) as Inquiry | undefined;
          if (duplicate) {
            if (duplicate.fingerprint !== receipt.fingerprint) throw new IntakeError(409, "This receipt needs private review.", "receipt_conflict");
            receipt.complete = true; await this.save(); return;
          }
          if (String(record.issue.custom?.contact_email ?? "").trim().toLowerCase() !== receipt.inquiry.email) throw new IntakeError(409, "Contact identity changed and needs private review.", "identity_changed");
          if (inquiries.length >= 100) throw new IntakeError(409, "Contact inquiry history needs private review.");
          receipt.write = { method: "PATCH", path: `/issues/${encodeURIComponent(record.issue.id)}`, operation: randomUUID(), revision: record.revision, body: { custom: { inquiries: [...inquiries, receipt.inquiry], latest_inquiry_at: receipt.inquiry.received_at, latest_source: receipt.inquiry.source } } };
        await this.save();
      }
      const write = receipt.write;
      try {
        const result = await this.options.request(write.path, { method: write.method, headers: { "Content-Type": "application/json", "X-Operation-Id": write.operation, ...(write.revision ? { "If-Match": write.revision } : {}) }, body: JSON.stringify(write.body) }) as IssueRecord;
        this.ledger.contacts[key] = result.issue.id;
        receipt.complete = true;
        delete receipt.write;
        await this.save();
        return;
      } catch (error) {
        if (error instanceof IntakeError && error.status === 409 && error.code === "revision_conflict" && write.method === "PATCH") {
          delete receipt.write;
          await this.save();
          continue;
        }
        throw error;
      }
    }
    throw new IntakeError(503, "Contact is being updated. Retry with the same receipt.");
  }
}
