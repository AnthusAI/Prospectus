import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { IssueRecord } from "../src/client";
import { nextBusinessDay } from "../src/prospect";
export { nextBusinessDay };
import type { ConditionalControlStore } from "./control-store";
import { IdentityClaims, SharedReceiptConflict } from "./identity";
import { IntakeInbox, derivedUuid, type StoredInboxItem } from "./inbox";
import { SYNTHETIC_CONTACT_POLICY, type IntakeContactPolicy } from "./intake-contact-policy";
import { formLabels, matchesAttributePattern, type IntakeFormConfig } from "./intake-forms";
import {
  MAX_ELAPSED_MS,
  SPAM_RULES,
  safeScore,
  scoreInquiry,
  type SpamInput,
  type SpamLabelling,
  type SpamResult,
  type SpamVerdict,
} from "./intake-spam";

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
  /** Optional, unsigned form timing; never part of the fingerprint. */
  elapsed_ms?: number;
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
  elapsed_ms?: number;
}
/** Signals the form reported. Never the honeypot's text. */
export interface FormSignals {
  honeypot_filled?: true;
  elapsed_ms?: number;
}
/** The layer-1 spam result stored on every inquiry (docs/INTAKE_SPAM.md). */
export interface InquirySpamFields {
  spam_score: number;
  spam_verdict: SpamVerdict;
  spam_reasons: string[];
  spam_rules_version: string;
  spam_hints: string[];
  spam_evidence: SpamResult["evidence"];
  spam_protected: boolean;
  spam_mode: SpamLabelling;
  spam_checked_at: string;
}
export interface Inquiry extends Partial<InquirySpamFields> {
  id: string;
  /** "contact" is a message from a registry contact form on another site; "demo" is the anth.us form. */
  kind: "demo" | "contact" | "waitlist";
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
  form_signals?: FormSignals;
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
  /** "shadow" (default) scores and stores only; "label" also labels likely spam. */
  spamLabelling?: SpamLabelling;
  /** Test seam: replaces the shipped scorer. Its failures are always treated as clean. */
  spamScorer?: (input: SpamInput) => SpamResult;
}
export const LIKELY_SPAM_LABEL = "likely-spam";
/** A short, data-free code for logs and the inbox; never the message text. */
function reasonCode(cause: unknown): string {
  if (cause === undefined) return "none";
  if (cause instanceof IntakeError) return cause.code ?? `http_${cause.status}`;
  const name = (cause as Error)?.name;
  return typeof name === "string" && /^[A-Za-z]{1,40}$/.test(name) ? `unconfirmed_${name}` : "unconfirmed";
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const RECEIPT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const campaignKeys = ["utm_source", "utm_medium", "utm_campaign"];

export function readText(fields: Record<string, unknown>, key: string, max: number, required = false) {
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

export function readCampaign(rawCampaign: unknown): Record<string, string> {
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

/** Optional timing: an absent or invalid value is unknown, never a 400 and never a reason. */
export function readElapsed(fields: Record<string, unknown>): { elapsed_ms?: number } {
  const value = fields.elapsed_ms;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_ELAPSED_MS
    ? { elapsed_ms: value }
    : {};
}

export function readPagePath(fields: Record<string, unknown>, fallback: string) {
  const page_path = readText(fields, "page_path", 200) || fallback;
  if (!/^\/[a-z0-9/_-]*$/i.test(page_path)) throw new IntakeError(400, "Invalid page path.");
  return page_path;
}

export function validateSubmission(
  raw: unknown,
  contactPolicy: IntakeContactPolicy = SYNTHETIC_CONTACT_POLICY,
  defaultPagePath = "/request-demo",
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
    "elapsed_ms",
  ];
  if (Object.keys(fields).some((key) => !allowed.includes(key)))
    throw new IntakeError(400, "Unknown form field.");
  const text = (key: string, max: number, required = false) => readText(fields, key, max, required);
  const submission_id = text("submission_id", 36, true);
  if (!RECEIPT_UUID.test(submission_id)) throw new IntakeError(400, "Invalid submission receipt.");
  const email = text("email", 254, true).toLowerCase();
  if (!contactPolicy.emailPattern.test(email))
    throw new IntakeError(400, contactPolicy.emailRejectionMessage);
  const notice_version = text("notice_version", 50, true);
  if (notice_version !== contactPolicy.noticeVersion)
    throw new IntakeError(400, contactPolicy.staleNoticeMessage);
  if (fields.marketing_opt_in !== undefined && typeof fields.marketing_opt_in !== "boolean")
    throw new IntakeError(400, "Invalid marketing preference.");
  const attribution = readCampaign(fields.campaign);
  const page_path = readPagePath(fields, defaultPagePath);
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
    ...readElapsed(fields),
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
    "elapsed_ms",
  ];
  if (Object.keys(fields).some((key) => !allowed.includes(key)))
    throw new IntakeError(400, "Unknown form field.");
  const text = (key: string, max: number, required = false) => readText(fields, key, max, required);
  const submission_id = text("submission_id", 36, true);
  if (!RECEIPT_UUID.test(submission_id)) throw new IntakeError(400, "Invalid submission receipt.");
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
    ...readElapsed(fields),
  };
}

/** The scorer's view of a stored inquiry, so a refile scores exactly like the live submission. */
export function spamInputFor(inquiry: Inquiry): SpamInput {
  return {
    kind: inquiry.kind,
    name: String(inquiry.name ?? ""),
    email: String(inquiry.email ?? ""),
    company: String(inquiry.company ?? ""),
    message: String(inquiry.message ?? ""),
    honeypot_filled: inquiry.form_signals?.honeypot_filled === true,
    ...(inquiry.form_signals?.elapsed_ms !== undefined
      ? { elapsed_ms: inquiry.form_signals.elapsed_ms }
      : {}),
  };
}

/** Validates a registry contact form's message: the demo form's fields under the form's own notice. */
export function validateContactSubmission(
  raw: unknown,
  form: IntakeFormConfig,
  contactPolicy: IntakeContactPolicy,
): Submission {
  return validateSubmission(
    raw,
    { ...contactPolicy, noticeVersion: form.noticeVersion },
    form.defaultPagePath,
  );
}

/** The response intake sets on a message inquiry; Not spam restores the same values. */
function demoFollowUp(inquiry: Inquiry) {
  return {
    next_action: inquiry.kind === "contact" ? "Respond to inquiry" : "Respond to demo request",
    next_follow_up_at: nextBusinessDay(new Date(inquiry.received_at)),
  };
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
    if (options.form?.kind === "newsletter")
      throw new Error("A newsletter is served by the newsletter service, never as a CRM inquiry.");
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
    const submission: Submission | WaitlistSubmission =
      form?.kind === "waitlist"
        ? validateWaitlistSubmission(raw, form, this.options.contactPolicy!)
        : form
          ? validateContactSubmission(raw, form, this.options.contactPolicy!)
          : validateSubmission(raw, this.options.contactPolicy);
    const message =
      form?.kind === "waitlist"
        ? "Waitlist signup received."
        : form
          ? "Message received."
          : "Demo request received.";
    const run = this.queue.then(async () => {
      if (!this.locked) throw new IntakeError(503, "Intake is unavailable.");
      // A filled honeypot is stored and labelled like any likely spam, never dropped (decision 4).
      // Timing is excluded so a retry with another elapsed_ms is the same inquiry.
      const { elapsed_ms: _elapsed, ...fingerprinted } = submission;
      const fingerprint = hash(
        JSON.stringify({
          submission: fingerprinted,
          siteId: this.options.siteId,
          formId: this.options.formId,
        }),
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
      // Scoring runs only after the durable inbox write and can never change the reply.
      const inquiry = this.scored(captured?.item.inquiry ?? build(submission.submission_id));
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
          if (
            outcome.status !== "pending" ||
            outcome.reason !== item.item.reason ||
            item.item.inquiry.spam_verdict !== receipt.inquiry.spam_verdict
          )
            await this.inbox
              .mark(item, outcome.status, {
                reason: outcome.reason,
                issue_id: outcome.issueId,
                inquiry: receipt.inquiry,
              })
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
        const inquiry = this.scored(stored.item.inquiry);
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
            inquiry: receipt.inquiry,
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
    const { submission_id: _id, website, campaign, page_path, elapsed_ms, ...contact } = submission;
    const form_signals: FormSignals = {
      ...(website ? { honeypot_filled: true as const } : {}),
      ...(elapsed_ms !== undefined ? { elapsed_ms } : {}),
    };
    return {
      ...(form?.kind === "waitlist" ? { company: "", message: "" } : {}),
      ...contact,
      ...(Object.keys(form_signals).length ? { form_signals } : {}),
      fingerprint,
      id,
      kind: form ? form.kind : "demo",
      received_at,
      source: { site_id: this.options.siteId, form_id: this.options.formId, page_path, campaign },
    } as Inquiry;
  }

  private diagnose(event: string, cause: unknown) {
    this.report({ event, reason: reasonCode(cause) });
  }

  private report(entry: { event: string; reason: string }) {
    try {
      if (this.options.log) this.options.log(entry);
      else console.warn(JSON.stringify(entry));
    } catch {
      // Diagnostics never change an intake outcome.
    }
  }

  /**
   * The inquiry with its layer-1 spam result. A result already stored (a replay) is kept. Never
   * throws: any failure is stored as "unscored", which files exactly as clean.
   */
  private scored(inquiry: Inquiry): Inquiry {
    try {
      return this.score(inquiry);
    } catch {
      return inquiry;
    }
  }

  private score(inquiry: Inquiry): Inquiry {
    if (inquiry.spam_verdict && inquiry.spam_rules_version) return inquiry;
    const scorer = this.options.spamScorer ?? scoreInquiry;
    const result = safeScore(inquiry, (value) => scorer(spamInputFor(value)));
    const now = this.options.now?.() ?? new Date();
    const fields: InquirySpamFields = {
      spam_score: result.score,
      spam_verdict: result.verdict,
      spam_reasons: result.reasons,
      spam_rules_version: SPAM_RULES.rules_version,
      spam_hints: result.hints,
      spam_evidence: result.evidence,
      spam_protected: result.protected,
      spam_mode: this.options.spamLabelling ?? "shadow",
      spam_checked_at: Number.isNaN(now.getTime()) ? inquiry.received_at : now.toISOString(),
    };
    // Verdict codes only; the scorer never logs input text.
    if (result.verdict !== "clean") this.report({ event: "intake_spam_scored", reason: result.verdict });
    return { ...inquiry, ...fields };
  }

  /** Likely spam is labelled in label mode, and always when the honeypot fired (decision 4). */
  private labelledSpam(inquiry: Inquiry): boolean {
    return (
      inquiry.spam_verdict === "likely_spam" &&
      (inquiry.spam_mode === "label" || (inquiry.spam_reasons ?? []).includes("honeypot"))
    );
  }

  private spamCustom(inquiry: Inquiry): Record<string, unknown> {
    return inquiry.spam_verdict ? { spam_status: inquiry.spam_verdict } : {};
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
        labels: this.labelledSpam(inquiry) ? ["needs-review", LIKELY_SPAM_LABEL] : ["needs-review"],
        custom: {
          ...this.spamCustom(inquiry),
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
    const spam = this.labelledSpam(inquiry);
    return {
      title: inquiry.name,
      type: "prospect",
      assignee: this.options.owner,
      description: inquiry.message,
      // Likely spam: labelled and given no follow-up, so it stays out of Today.
      ...(spam ? { labels: [LIKELY_SPAM_LABEL] } : {}),
      custom: {
        company: inquiry.company,
        contact_email: inquiry.email,
        ...(spam ? {} : demoFollowUp(inquiry)),
        ...this.spamCustom(inquiry),
        first_source: inquiry.source,
        latest_source: inquiry.source,
        latest_inquiry_at: inquiry.received_at,
        inquiries: [inquiry],
      },
    };
  }

  private contactCreateBody(inquiry: Inquiry) {
    const spam = this.labelledSpam(inquiry);
    return {
      title: inquiry.name,
      type: "prospect",
      assignee: this.options.owner,
      description: inquiry.message,
      labels: [...formLabels(this.options.form!), ...(spam ? [LIKELY_SPAM_LABEL] : [])],
      custom: {
        company: inquiry.company,
        contact_email: inquiry.email,
        // Likely spam gets no follow-up, so it stays out of Today.
        ...(spam ? {} : demoFollowUp(inquiry)),
        ...this.spamCustom(inquiry),
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
      labels: [...formLabels(this.options.form!), ...(this.labelledSpam(inquiry) ? [LIKELY_SPAM_LABEL] : [])],
      custom: {
        company: "",
        contact_email: inquiry.email,
        ...this.spamCustom(inquiry),
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
              body:
                this.options.form?.kind === "waitlist"
                  ? this.waitlistCreateBody(inquiry)
                  : this.options.form
                    ? this.contactCreateBody(inquiry)
                    : this.demoCreateBody(inquiry),
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
          ? formLabels(this.options.form).filter((label) => !existingLabels.includes(label))
          : [];
        // A later message is never held back by an old likely-spam label: a demo inquiry that is not
        // itself labelled spam restores the follow-up intake would have set. The label stays for a
        // person to resolve. A likely-spam inquiry never labels an existing prospect.
        const restoreFollowUp =
          receipt.inquiry.kind !== "waitlist" &&
          existingLabels.includes(LIKELY_SPAM_LABEL) &&
          !this.labelledSpam(receipt.inquiry) &&
          !record.issue.custom?.next_follow_up_at;
        receipt.write = {
          method: "PATCH",
          path: `/issues/${encodeURIComponent(record.issue.id)}`,
          operation: randomUUID(),
          revision: record.revision,
          body: {
            ...(missingLabels.length ? { labels: [...existingLabels, ...missingLabels] } : {}),
            custom: {
              ...(restoreFollowUp ? demoFollowUp(receipt.inquiry) : {}),
              ...this.spamCustom(receipt.inquiry),
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
