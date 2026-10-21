import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { IssueRecord } from "../src/client";
import type { ConditionalControlStore } from "./control-store";
import { IdentityClaims, SharedReceiptConflict } from "./identity";
import { IntakeInbox, derivedUuid, type StoredInboxItem } from "./inbox";
import { SYNTHETIC_CONTACT_POLICY, type IntakeContactPolicy } from "./intake-contact-policy";
import { matchesAttributePattern, waitlistLabels, type IntakeFormConfig } from "./intake-forms";

export const NOTICE_VERSION = SYNTHETIC_CONTACT_POLICY.noticeVersion;
export class IntakeError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
/** A well-formed inquiry that cannot be merged automatically; never shown to the visitor. */
export class ReviewRequired extends IntakeError {
  constructor(
    public reason: string,
    public related?: string,
  ) {
    super(409, "This inquiry needs private review.", reason);
  }
}
export interface Submission {
  submission_id: string;
  name: string;
  email: string;
  company: string;
  message: string;
  website: string;
  notice_version: string;
  marketing_opt_in: boolean;
  page_path: string;
  campaign: Record<string, string>;
}
export interface WaitlistSubmission {
  submission_id: string;
  name: string;
  email: string;
  website: string;
  notice_version: string;
  marketing_opt_in: boolean;
  page_path: string;
  campaign: Record<string, string>;
  attributes: Record<string, string>;
}
export interface Inquiry {
  id: string;
  kind: "demo" | "waitlist";
  name: string;
  email: string;
  company: string;
  message: string;
  received_at: string;
  source: { site_id: string; form_id: string; page_path: string; campaign: Record<string, string> };
  notice_version: string;
  marketing_opt_in: boolean;
  attributes?: Record<string, string>;
  fingerprint?: string;
}
interface WriteIntent {
  method: "POST" | "PATCH";
  path: string;
  operation: string;
  revision?: string;
  body: Record<string, unknown>;
}
interface Receipt {
  fingerprint: string;
  inquiry: Inquiry;
  complete: boolean;
  write?: WriteIntent;
}
interface Ledger {
  version: 1;
  workspace: string;
  contacts: Record<string, string>;
  receipts: Record<string, Receipt>;
}
export interface IntakeOptions {
  directory: string;
  workspace: string;
  owner: string;
  siteId: string;
  formId: string;
  request: (path: string, init?: RequestInit) => Promise<IssueRecord | { issues: IssueRecord[] }>;
  now?: () => Date;
  identityStore: ConditionalControlStore;
  contactPolicy?: IntakeContactPolicy;
  form?: IntakeFormConfig;
  /** Data-free diagnostics only: a reason code, never contact data. */
  log?: (entry: { event: string; reason: string }) => void;
}
/** A short, data-free code for logs and the inbox; never the message text. */
function reasonCode(cause: unknown): string {
  if (cause === undefined) return "none";
  if (cause instanceof IntakeError) return cause.code ?? `http_${cause.status}`;
  const name = (cause as Error)?.name;
  return typeof name === "string" && /^[A-Za-z]{1,40}$/.test(name) ? `unconfirmed_${name}` : "unconfirmed";
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const campaignKeys = ["utm_source", "utm_medium", "utm_campaign"];

function readText(fields: Record<string, unknown>, key: string, max: number, required = false) {
  const value = fields[key] ?? "";
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw new IntakeError(400, `Invalid ${key}.`);
  const cleaned = value.trim();
  if (required && !cleaned) throw new IntakeError(400, `${key} is required.`);
  return cleaned;
}

function readCampaign(rawCampaign: unknown): Record<string, string> {
  const campaign = rawCampaign ?? {};
  if (!campaign || typeof campaign !== "object" || Array.isArray(campaign))
    throw new IntakeError(400, "Invalid campaign.");
  const attribution: Record<string, string> = {};
  for (const [key, value] of Object.entries(campaign)) {
    if (
      !campaignKeys.includes(key) ||
      typeof value !== "string" ||
      value.length > 120 ||
      !/^[\w .-]*$/.test(value)
    )
      throw new IntakeError(400, "Invalid campaign.");
  }
  for (const key of campaignKeys)
    if (key in campaign) attribution[key] = (campaign as Record<string, string>)[key].trim();
  return attribution;
}

function readPagePath(fields: Record<string, unknown>, fallback: string) {
  const page_path = readText(fields, "page_path", 200) || fallback;
  if (!/^\/[a-z0-9/_-]*$/i.test(page_path)) throw new IntakeError(400, "Invalid page path.");
  return page_path;
}

export function validateSubmission(
  raw: unknown,
  contactPolicy: IntakeContactPolicy = SYNTHETIC_CONTACT_POLICY,
): Submission {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new IntakeError(400, "Invalid request.");
  const fields = raw as Record<string, unknown>;
  const allowed = [
    "submission_id",
    "name",
    "email",
    "company",
    "message",
    "website",
    "notice_version",
    "marketing_opt_in",
    "page_path",
    "campaign",
  ];
  if (Object.keys(fields).some((key) => !allowed.includes(key)))
    throw new IntakeError(400, "Unknown form field.");
  const text = (key: string, max: number, required = false) => readText(fields, key, max, required);
  const submission_id = text("submission_id", 36, true);
  if (!uuid.test(submission_id)) throw new IntakeError(400, "Invalid submission receipt.");
  const email = text("email", 254, true).toLowerCase();
  if (!contactPolicy.emailPattern.test(email))
    throw new IntakeError(400, contactPolicy.emailRejectionMessage);
  const notice_version = text("notice_version", 50, true);
  if (notice_version !== contactPolicy.noticeVersion)
    throw new IntakeError(400, contactPolicy.staleNoticeMessage);
  if (fields.marketing_opt_in !== undefined && typeof fields.marketing_opt_in !== "boolean")
    throw new IntakeError(400, "Invalid marketing preference.");
  const attribution = readCampaign(fields.campaign);
  const page_path = readPagePath(fields, "/request-demo");
  return {
    submission_id,
    name: text("name", 150, true),
    email,
    company: text("company", 150),
    message: text("message", 3000, true),
    website: text("website", 200),
    notice_version,
    marketing_opt_in: fields.marketing_opt_in === true,
    page_path,
    campaign: attribution,
  };
}

export function validateWaitlistSubmission(
  raw: unknown,
  form: IntakeFormConfig,
  contactPolicy: IntakeContactPolicy,
): WaitlistSubmission {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new IntakeError(400, "Invalid request.");
  const fields = raw as Record<string, unknown>;
  const allowed = [
    "submission_id",
    "name",
    "email",
    "website",
    "notice_version",
    "marketing_opt_in",
    "page_path",
    "campaign",
    "attributes",
  ];
  if (Object.keys(fields).some((key) => !allowed.includes(key)))
    throw new IntakeError(400, "Unknown form field.");
  const text = (key: string, max: number, required = false) => readText(fields, key, max, required);
  const submission_id = text("submission_id", 36, true);
  if (!uuid.test(submission_id)) throw new IntakeError(400, "Invalid submission receipt.");
  const email = text("email", 254, true).toLowerCase();
  if (!contactPolicy.emailPattern.test(email))
    throw new IntakeError(400, contactPolicy.emailRejectionMessage);
  const notice_version = text("notice_version", 50, true);
  if (notice_version !== form.noticeVersion) throw new IntakeError(400, contactPolicy.staleNoticeMessage);
  if (fields.marketing_opt_in !== undefined && typeof fields.marketing_opt_in !== "boolean")
    throw new IntakeError(400, "Invalid marketing preference.");
  const declared = fields.attributes ?? {};
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    throw new IntakeError(400, "Invalid attributes.");
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(declared)) {
    const rule = form.attributes[name];
    if (!rule) throw new IntakeError(400, "Unknown attribute.");
    if (typeof value !== "string" || value.length > 80) throw new IntakeError(400, `Invalid ${name}.`);
    const matches = rule.values ? rule.values.includes(value) : matchesAttributePattern(rule.pattern!, value);
    if (!matches) throw new IntakeError(400, `Invalid ${name}.`);
    attributes[name] = value;
  }
  return {
    submission_id,
    name: text("name", 150),
    email,
    website: text("website", 200),
    notice_version,
    marketing_opt_in: fields.marketing_opt_in === true,
    page_path: readPagePath(fields, form.defaultPagePath),
    campaign: readCampaign(fields.campaign),
    attributes: Object.fromEntries(
      Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

export function nextBusinessDay(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  do {
    date.setUTCDate(date.getUTCDate() + 1);
  } while ([0, 6].includes(date.getUTCDay()));
  return date.toISOString().slice(0, 10);
}

export class IntakeService {
  private ledger!: Ledger;
  private queue: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private persistenceFailed = false;
  private locked = false;
  private identities: IdentityClaims;
  private inbox: IntakeInbox;
  private stored = new Map<string, StoredInboxItem<Inquiry>>();
  private constructor(private options: IntakeOptions) {
    this.identities = new IdentityClaims(options.identityStore, options.workspace);
    this.inbox = new IntakeInbox(options.identityStore, options.workspace);
  }

  static async open(options: IntakeOptions): Promise<IntakeService> {
    if (!options.owner.trim() || !options.workspace.trim() || !options.siteId || !options.formId)
      throw new Error("Intake requires an owner, workspace and trusted form source.");
    if (!options.identityStore)
      throw new Error("Intake requires an explicitly configured shared conditional identity store.");
    if (
      options.form &&
      (options.form.siteId !== options.siteId ||
        options.form.formId !== options.formId ||
        options.form.owner !== options.owner ||
        !options.contactPolicy)
    )
      throw new Error("Intake form source must come from its registry entry.");
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const lock = join(options.directory, "worker.lock");
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(join(lock, "pid"), "utf8").catch(() => ""));
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new Error("Intake lock has no valid owner; inspect it before recovery.");
      try {
        process.kill(pid, 0);
        throw new Error("Another intake worker owns this ledger.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      throw new Error(
        "Stale intake worker lock. Verify the previous worker exited before manually removing worker.lock and restarting.",
      );
    }
    const service = new IntakeService(options);
    service.locked = true;
    try {
      await service.durableWrite(join(lock, "pid"), String(process.pid));
      try {
        service.ledger = JSON.parse(
          await readFile(join(options.directory, "receipts.json"), "utf8"),
        ) as Ledger;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        service.ledger = { version: 1, workspace: options.workspace, contacts: {}, receipts: {} };
      }
      if (service.ledger.version !== 1 || service.ledger.workspace !== options.workspace)
        throw new Error("Receipt ledger does not match this workspace.");
      return service;
    } catch (error) {
      await service.close();
      throw error;
    }
  }

  private async durableWrite(path: string, value: string) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(this.options.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private async save() {
    try {
      await this.durableWrite(join(this.options.directory, "receipts.json"), JSON.stringify(this.ledger));
    } catch (error) {
      this.persistenceFailed = true;
      throw error;
    }
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      await this.queue.catch(() => undefined);
      if (this.locked) {
        this.locked = false;
        await rm(join(this.options.directory, "worker.lock"), { recursive: true, force: true });
      }
    })());
  }

  submit(raw: unknown): Promise<{ receipt: string; message: string }> {
    if (this.closing)
      return Promise.reject(
        new IntakeError(503, "Intake is unavailable. Restart after repairing local receipt storage."),
      );
    const form = this.options.form;
    const submission: Submission | WaitlistSubmission = form
      ? validateWaitlistSubmission(raw, form, this.options.contactPolicy!)
      : validateSubmission(raw, this.options.contactPolicy);
    const message = form ? "Waitlist signup received." : "Demo request received.";
    const run = this.queue.then(async () => {
      if (!this.locked) throw new IntakeError(503, "Intake is unavailable.");
      if (submission.website) return { receipt: submission.submission_id, message };
      const fingerprint = hash(
        JSON.stringify({ submission, siteId: this.options.siteId, formId: this.options.formId }),
      );
      const received_at = (this.options.now?.() ?? new Date()).toISOString();
      const build = (id: string) => this.buildInquiry(submission, fingerprint, id, received_at);
      // Store first: once the full inquiry is durable the visitor's message cannot be lost.
      let captured: StoredInboxItem<Inquiry> | undefined;
      try {
        captured = await this.inbox.capture(submission.submission_id, fingerprint, build);
        this.stored.set(captured.item.inquiry.id, captured);
      } catch (error) {
        this.diagnose("inbox_unavailable", error);
      }
      const inquiry = captured?.item.inquiry ?? build(submission.submission_id);
      const reply = { receipt: submission.submission_id, message };
      if (this.persistenceFailed) {
        // Never write to the CRM without a journal, but the stored inquiry is still safe.
        if (!captured) throw new IntakeError(503, "Intake is unavailable.");
        this.diagnose("ledger_unavailable", undefined);
        return reply;
      }
      if (!this.ledger.receipts[inquiry.id]) {
        if (Object.keys(this.ledger.receipts).length >= 10000) {
          if (!captured) throw new IntakeError(503, "Local demo capacity reached.");
          this.diagnose("local_capacity", undefined);
          return reply;
        }
        this.ledger.receipts[inquiry.id] = { fingerprint, complete: false, inquiry };
        try {
          await this.save();
        } catch (error) {
          if (!captured) throw error;
          this.diagnose("ledger_unavailable", error);
          return reply;
        }
      }
      for (const receipt of Object.values(this.ledger.receipts)) {
        if (receipt.complete || receipt.inquiry.email !== submission.email) continue;
        const outcome = await this.file(receipt);
        const item = this.stored.get(receipt.inquiry.id);
        if (item) {
          if (outcome.status !== "pending" || outcome.reason !== item.item.reason)
            await this.inbox
              .mark(item, outcome.status, { reason: outcome.reason, issue_id: outcome.issueId })
              .catch((error) => this.diagnose("inbox_mark_failed", error));
        } else if (outcome.status === "pending" && receipt.inquiry.id === inquiry.id) throw outcome.error;
      }
      return reply;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Operator retry of inbox items left pending: files each stored inquiry exactly as a live
   * submission would, with the same idempotency, and updates the inbox status.
   */
  refile(items: StoredInboxItem<Inquiry>[]): Promise<{ filed: number; review: number; pending: number }> {
    const run = this.queue.then(async () => {
      if (!this.locked || this.persistenceFailed) throw new IntakeError(503, "Intake is unavailable.");
      const totals = { filed: 0, review: 0, pending: 0 };
      for (const stored of items) {
        if (stored.item.status !== "pending") continue;
        const inquiry = stored.item.inquiry;
        this.stored.set(inquiry.id, stored);
        const receipt = (this.ledger.receipts[inquiry.id] ??= {
          fingerprint: stored.item.fingerprint,
          complete: false,
          inquiry,
        });
        await this.save();
        const outcome = await this.file(receipt);
        totals[outcome.status]++;
        if (outcome.status !== "pending")
          await this.inbox.mark(stored, outcome.status, {
            reason: outcome.reason,
            issue_id: outcome.issueId,
          });
      }
      return totals;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private buildInquiry(
    submission: Submission | WaitlistSubmission,
    fingerprint: string,
    id: string,
    received_at: string,
  ): Inquiry {
    const form = this.options.form;
    const { submission_id: _id, website: _website, campaign, page_path, ...contact } = submission;
    return {
      ...(form ? { company: "", message: "" } : {}),
      ...contact,
      fingerprint,
      id,
      kind: form ? "waitlist" : "demo",
      received_at,
      source: { site_id: this.options.siteId, form_id: this.options.formId, page_path, campaign },
    } as Inquiry;
  }

  private diagnose(event: string, cause: unknown) {
    const reason = reasonCode(cause);
    const entry = { event, reason };
    if (this.options.log) this.options.log(entry);
    else console.warn(JSON.stringify(entry));
  }

  /** Files one stored inquiry. Never throws: failures leave the inbox item pending. */
  private async file(
    receipt: Receipt,
  ): Promise<{ status: "filed" | "review" | "pending"; reason?: string; issueId?: string; error?: unknown }> {
    try {
      await this.process(receipt);
      return {
        status: "filed",
        issueId: this.ledger.contacts[hash(`${this.options.workspace}\n${receipt.inquiry.email}`)],
      };
    } catch (error) {
      const reason = reasonCode(error);
      this.diagnose("intake_deferred", error);
      if (!(error instanceof ReviewRequired)) return { status: "pending", reason, error };
      try {
        const issueId = await this.fileForReview(receipt, reason, error.related);
        receipt.complete = true;
        delete receipt.write;
        await this.save();
        return { status: "review", reason, issueId };
      } catch (reviewFailure) {
        this.diagnose("review_deferred", reviewFailure);
        return { status: "pending", reason, error: reviewFailure };
      }
    }
  }

  /**
   * A separate, labelled prospect carries the inquiry for the operator to merge. It deliberately has
   * no contact_email (so it never joins the identity search) and no follow-up date.
   */
  private async fileForReview(receipt: Receipt, reason: string, related?: string): Promise<string> {
    const inquiry = receipt.inquiry;
    const record = (await this.options.request("/issues", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Operation-Id": derivedUuid(`${this.options.workspace}\nreview\n${inquiry.id}`),
      },
      body: JSON.stringify({
        title: `Needs review: ${inquiry.name || inquiry.email}`,
        type: "prospect",
        assignee: this.options.owner,
        description: `Filed for review (${reason}). Merge this inquiry into the matching prospect.\n\n${inquiry.message}`,
        labels: ["needs-review"],
        custom: {
          company: inquiry.company,
          review_contact_email: inquiry.email,
          review_reason: reason,
          ...(related ? { review_related_issue: related } : {}),
          first_source: inquiry.source,
          latest_source: inquiry.source,
          latest_inquiry_at: inquiry.received_at,
          inquiries: [inquiry],
        },
      }),
    })) as IssueRecord;
    return record.issue.id;
  }

  private demoCreateBody(inquiry: Inquiry) {
    return {
      title: inquiry.name,
      type: "prospect",
      assignee: this.options.owner,
      description: inquiry.message,
      custom: {
        company: inquiry.company,
        contact_email: inquiry.email,
        next_action: "Respond to demo request",
        next_follow_up_at: nextBusinessDay(new Date(inquiry.received_at)),
        first_source: inquiry.source,
        latest_source: inquiry.source,
        latest_inquiry_at: inquiry.received_at,
        inquiries: [inquiry],
      },
    };
  }

  private waitlistCreateBody(inquiry: Inquiry) {
    return {
      title: inquiry.name || inquiry.email,
      type: "prospect",
      assignee: this.options.owner,
      description: `Joined the ${inquiry.source.site_id} waitlist.`,
      labels: waitlistLabels(this.options.form!),
      custom: {
        company: "",
        contact_email: inquiry.email,
        first_source: inquiry.source,
        latest_source: inquiry.source,
        latest_inquiry_at: inquiry.received_at,
        inquiries: [inquiry],
      },
    };
  }

  private async process(receipt: Receipt): Promise<void> {
    if (receipt.write?.method === "POST")
      throw new IntakeError(
        409,
        "An older pending creation needs offline identity reconciliation.",
        "legacy_identity_pending",
      );
    try {
      await this.identities.claimReceipt(receipt.inquiry.id, receipt.fingerprint, receipt.inquiry.email);
    } catch (error) {
      if (error instanceof SharedReceiptConflict) throw new ReviewRequired("receipt_conflict");
      throw error;
    }
    const key = hash(`${this.options.workspace}\n${receipt.inquiry.email}`);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!receipt.write) {
        const claim = await this.identities.getOrCreate(receipt.inquiry.email, async () => {
          const fields = JSON.stringify([
            { field: "custom.contact_email", operator: "eq", value: receipt.inquiry.email },
          ]);
          const result = (await this.options.request(
            `/issues?type=prospect&limit=2&fields=${encodeURIComponent(fields)}`,
          )) as { issues: IssueRecord[] };
          // Search hits only nominate candidates. A claim binds only to a prospect whose full
          // canonical record carries exactly this contact email; any other hit is a miss.
          const exact: IssueRecord[] = [];
          for (const hit of result.issues ?? []) {
            const id = hit?.issue?.id;
            if (typeof id !== "string" || !id) continue;
            const full = (await this.options.request(`/issues/${encodeURIComponent(id)}`)) as IssueRecord;
            if (full.issue?.id === id && full.issue.custom?.contact_email === receipt.inquiry.email)
              exact.push(full);
          }
          if (exact.length > 1) throw new ReviewRequired("duplicate_contact");
          const discovered = exact[0];
          if (discovered)
            return {
              version: 1,
              workspace: this.options.workspace,
              email: receipt.inquiry.email,
              issueId: discovered.issue.id,
            };
          const inquiry = receipt.inquiry;
          return {
            version: 1,
            workspace: this.options.workspace,
            email: inquiry.email,
            create: {
              method: "POST",
              path: "/issues",
              operation: randomUUID(),
              body: this.options.form ? this.waitlistCreateBody(inquiry) : this.demoCreateBody(inquiry),
            },
          };
        });
        let record: IssueRecord;
        if (claim.issueId)
          record = (await this.options.request(
            `/issues/${encodeURIComponent(claim.issueId)}`,
          )) as IssueRecord;
        else {
          const create = claim.create!;
          record = (await this.options.request(create.path, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Operation-Id": create.operation },
            body: JSON.stringify(create.body),
          })) as IssueRecord;
          await this.identities.publishIssue(receipt.inquiry.email, record.issue.id);
          record = (await this.options.request(
            `/issues/${encodeURIComponent(record.issue.id)}`,
          )) as IssueRecord;
        }
        this.ledger.contacts[key] = record.issue.id;
        const inquiries = record.issue.custom?.inquiries ?? [];
        if (
          !Array.isArray(inquiries) ||
          inquiries.some((item) => !item || typeof item !== "object" || typeof item.id !== "string")
        )
          throw new ReviewRequired("history_invalid", record.issue.id);
        const duplicate = inquiries.find((item: Inquiry) => item.id === receipt.inquiry.id) as
          | Inquiry
          | undefined;
        if (duplicate) {
          if (duplicate.fingerprint !== receipt.fingerprint)
            throw new ReviewRequired("receipt_conflict", record.issue.id);
          receipt.complete = true;
          await this.save();
          return;
        }
        if (record.issue.custom?.contact_email !== receipt.inquiry.email)
          throw new ReviewRequired("identity_changed", record.issue.id);
        const latestWaitlist =
          receipt.inquiry.kind === "waitlist"
            ? [...inquiries]
                .reverse()
                .find(
                  (item: Inquiry) =>
                    item.kind === "waitlist" && item.source?.site_id === receipt.inquiry.source.site_id,
                )
            : undefined;
        if (
          latestWaitlist &&
          latestWaitlist.marketing_opt_in === receipt.inquiry.marketing_opt_in &&
          latestWaitlist.notice_version === receipt.inquiry.notice_version
        ) {
          receipt.complete = true;
          await this.save();
          return;
        }
        if (inquiries.length >= 100) throw new ReviewRequired("history_full", record.issue.id);
        const existingLabels = Array.isArray(record.issue.labels) ? (record.issue.labels as string[]) : [];
        const missingLabels = this.options.form
          ? waitlistLabels(this.options.form).filter((label) => !existingLabels.includes(label))
          : [];
        receipt.write = {
          method: "PATCH",
          path: `/issues/${encodeURIComponent(record.issue.id)}`,
          operation: randomUUID(),
          revision: record.revision,
          body: {
            ...(missingLabels.length ? { labels: [...existingLabels, ...missingLabels] } : {}),
            custom: {
              inquiries: [...inquiries, receipt.inquiry],
              latest_inquiry_at: receipt.inquiry.received_at,
              latest_source: receipt.inquiry.source,
            },
          },
        };
        await this.save();
      }
      const write = receipt.write;
      try {
        const result = (await this.options.request(write.path, {
          method: write.method,
          headers: {
            "Content-Type": "application/json",
            "X-Operation-Id": write.operation,
            ...(write.revision ? { "If-Match": write.revision } : {}),
          },
          body: JSON.stringify(write.body),
        })) as IssueRecord;
        this.ledger.contacts[key] = result.issue.id;
        receipt.complete = true;
        delete receipt.write;
        await this.save();
        return;
      } catch (error) {
        if (
          error instanceof IntakeError &&
          error.status === 409 &&
          error.code === "revision_conflict" &&
          write.method === "PATCH"
        ) {
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
