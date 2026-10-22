import { createHash, randomUUID } from "node:crypto";
import type { IssueRecord } from "../src/client";
import { ControlConflict, type ConditionalControlStore } from "./control-store";
import { IdentityClaims } from "./identity";
import { REAL_CONTACT_POLICY, type IntakeContactPolicy } from "./intake-contact-policy";
import {
  IntakeError,
  RECEIPT_UUID,
  readCampaign,
  readElapsed,
  readPagePath,
  readText,
  type FormSignals,
  type IntakeOptions,
} from "./intake";
import { newsletterPagePath, senderAddress, type IntakeFormConfig } from "./intake-forms";
import { SPAM_RULES, safeScore, scoreInquiry, type SpamInput, type SpamResult } from "./intake-spam";
import type { ListMailer } from "./newsletter-mailer";
import type { NewsletterPage } from "./newsletter-pages";
import { CONFIRM_TOKEN_SECONDS, signToken, verifyToken, type TokenSecret } from "./newsletter-token";

/** Real addresses; the notice version comes from the list's registry entry. */
export const NEWSLETTER_CONTACT_POLICY: IntakeContactPolicy = {
  ...REAL_CONTACT_POLICY,
  emailRejectionMessage: "Enter a valid email address.",
  staleNoticeMessage: "Reload the page to read the current privacy notice.",
};
/** The one answer to every accepted signup, whatever state the address is in (no enumeration). */
export const NEWSLETTER_SIGNUP_MESSAGE = "Check your inbox to confirm your subscription.";
/** At most one confirmation email per address and list in this window. */
export const CONFIRMATION_RESEND_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS_KEPT = 20;

export interface NewsletterSubmission {
  submission_id: string;
  email: string;
  website: string;
  notice_version: string;
  page_path: string;
  campaign: Record<string, string>;
  elapsed_ms?: number;
}

export type SubscriptionStatus = "pending" | "active" | "unsubscribed";
/** Why a signup did or did not send a confirmation email. Codes only. */
export type ConfirmationOutcome =
  | "sent"
  | "send_failed"
  | "likely_spam"
  | "suppressed"
  | "already_active"
  | "resend_limit"
  | "replay";

/** One signup request, kept as consent evidence. Never an IP address or user agent. */
export interface SubscriptionRequest {
  submission_id: string;
  received_at: string;
  notice_version: string;
  page_path: string;
  campaign: Record<string, string>;
  form_signals?: FormSignals;
  spam_verdict: SpamResult["verdict"];
  spam_score: number;
  spam_reasons: string[];
  spam_rules_version: string;
  confirmation: ConfirmationOutcome;
}

/** The consent a confirmation recorded: what was asked for, under which notice, and when it was confirmed. */
export interface SubscriptionConsent {
  notice_version: string;
  requested_at: string;
  confirmed_at: string;
  source: { site_id: string; form_id: string; page_path: string; campaign: Record<string, string> };
}

/** One subscription per list and normalized email, under intake-newsletter/<subscription hash>.json. */
export interface SubscriptionRecord {
  version: 1;
  kind: "newsletter-subscription";
  workspace: string;
  list_id: string;
  site_id: string;
  email: string;
  status: SubscriptionStatus;
  created_at: string;
  updated_at: string;
  /** The first and the most recent signups (at most 20 kept). */
  requests: SubscriptionRequest[];
  confirmation: { sends: number; last_sent_at?: string; last_failed_at?: string };
  consent?: SubscriptionConsent;
  unsubscribed_at?: string;
  unsubscribe_method?: "one-click" | "page";
}

/**
 * A permanent per-list suppression. It names the subscription only by its hash, so it survives (and
 * keeps being honoured after) deletion of the subscription record and its email address.
 */
export interface SuppressionRecord {
  version: 1;
  kind: "newsletter-suppression";
  workspace: string;
  list_id: string;
  subscription: string;
  reason: "unsubscribed";
  method: "one-click" | "page";
  at: string;
}

/** What the CRM shows on an existing prospect, under custom.newsletters.<listId>. */
export interface NewsletterSummary {
  list: string;
  status: SubscriptionStatus;
  requested_at: string;
  notice_version: string;
  source_page: string;
  confirmed_at?: string;
  unsubscribed_at?: string;
}

export interface NewsletterOptions {
  workspace: string;
  store: ConditionalControlStore;
  /** Enabled newsletter registry entries. */
  forms: readonly IntakeFormConfig[];
  contactPolicy: IntakeContactPolicy;
  tokenSecret: TokenSecret;
  mailer: ListMailer;
  /** The canonical CRM, used only to show subscriptions on an existing prospect. */
  request?: IntakeOptions["request"];
  now?: () => Date;
  /** Data-free diagnostics only. */
  log?: (entry: { event: string; reason: string }) => void;
  /** Test seam: replaces the shipped scorer. Its failures are treated as clean. */
  spamScorer?: (input: SpamInput) => SpamResult;
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const reason = (cause: unknown) => {
  if (cause instanceof IntakeError) return cause.code ?? `http_${cause.status}`;
  const name = (cause as Error)?.name;
  return typeof name === "string" && /^[A-Za-z]{1,40}$/.test(name) ? name : "error";
};

export function validateNewsletterSubmission(
  raw: unknown,
  form: IntakeFormConfig,
  contactPolicy: IntakeContactPolicy,
): NewsletterSubmission {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new IntakeError(400, "Invalid request.");
  const fields = raw as Record<string, unknown>;
  const allowed = [
    "submission_id",
    "email",
    "website",
    "notice_version",
    "page_path",
    "campaign",
    "elapsed_ms",
  ];
  if (Object.keys(fields).some((key) => !allowed.includes(key)))
    throw new IntakeError(400, "Unknown form field.");
  const submission_id = readText(fields, "submission_id", 36, true);
  if (!RECEIPT_UUID.test(submission_id)) throw new IntakeError(400, "Invalid submission receipt.");
  const email = readText(fields, "email", 254, true).toLowerCase();
  if (!contactPolicy.emailPattern.test(email))
    throw new IntakeError(400, contactPolicy.emailRejectionMessage);
  const notice_version = readText(fields, "notice_version", 50, true);
  if (notice_version !== form.noticeVersion) throw new IntakeError(400, contactPolicy.staleNoticeMessage);
  return {
    submission_id,
    email,
    website: readText(fields, "website", 200),
    notice_version,
    page_path: readPagePath(fields, form.defaultPagePath),
    campaign: readCampaign(fields.campaign),
    ...readElapsed(fields),
  };
}

/** Pages for confirm and unsubscribe links. Plain words; nothing reveals an address. */
const pages = {
  invalid: (list?: IntakeFormConfig["list"]): NewsletterPage => ({
    status: 400,
    title: "This link is not valid",
    paragraphs: [
      "The link may be incomplete or out of date. Confirmation links work for 7 days.",
      "To subscribe, sign up again on the site and use the link in the newest email.",
    ],
    list,
  }),
  unavailable: (list?: IntakeFormConfig["list"]): NewsletterPage => ({
    status: 503,
    title: "Please try again in a moment",
    paragraphs: [
      "We could not complete this just now. Nothing has changed. Please try the link again shortly.",
    ],
    list,
  }),
  confirmPrompt: (list: IntakeFormConfig["list"]): NewsletterPage => ({
    status: 200,
    title: "Confirm your subscription",
    paragraphs: [`Press the button to start getting ${list!.name} news by email.`],
    button: "Confirm subscription",
    list,
  }),
  confirmed: (list: IntakeFormConfig["list"]): NewsletterPage => ({
    status: 200,
    title: "You're subscribed",
    paragraphs: [
      `Thanks for confirming. You'll get ${list!.name} news by email.`,
      "Every email has a link to unsubscribe with one click.",
    ],
    list,
  }),
  unsubscribePrompt: (list?: IntakeFormConfig["list"]): NewsletterPage => ({
    status: 200,
    title: "Unsubscribe",
    paragraphs: [`Press the button to stop getting ${list?.name ?? "these"} emails.`],
    button: "Unsubscribe",
    list,
  }),
  unsubscribed: (list?: IntakeFormConfig["list"]): NewsletterPage => ({
    status: 200,
    title: "You're unsubscribed",
    paragraphs: [`You won't get any more ${list?.name ?? "newsletter"} emails at this address.`],
    list,
  }),
};

/**
 * Newsletter signup, double opt-in and unsubscribe. Store first: the subscription record is written
 * before any email is sent or the CRM is touched, and nothing after that write can change the reply.
 */
export class NewsletterService {
  private identities: IdentityClaims;
  constructor(private options: NewsletterOptions) {
    if (options.forms.some((form) => form.kind !== "newsletter" || !form.list))
      throw new Error("The newsletter service serves newsletter registry entries only.");
    this.identities = new IdentityClaims(options.store, options.workspace);
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }
  private report(event: string, cause: unknown) {
    try {
      const entry = { event, reason: typeof cause === "string" ? cause : reason(cause) };
      if (this.options.log) this.options.log(entry);
      else console.warn(JSON.stringify(entry));
    } catch {
      // Diagnostics never change an outcome.
    }
  }

  /** The hash that names a subscription; also the subject of its tokens. */
  subscriptionHash(listId: string, email: string) {
    return sha(`${this.options.workspace}\nnewsletter-subscription\n${listId}\n${email}`);
  }
  subscriptionPath(hash: string) {
    return `intake-newsletter/${hash}.json`;
  }
  suppressionPath(listId: string, hash: string) {
    return `intake-newsletter/${sha(`${this.options.workspace}\nnewsletter-suppression\n${listId}\n${hash}`)}.json`;
  }

  private decode(bytes: string, listId: string): SubscriptionRecord {
    const record = JSON.parse(bytes) as SubscriptionRecord;
    if (
      record.version !== 1 ||
      record.kind !== "newsletter-subscription" ||
      record.workspace !== this.options.workspace ||
      record.list_id !== listId
    )
      throw new Error("Subscription record needs private repair.");
    return record;
  }

  private async suppressed(listId: string, hash: string): Promise<boolean> {
    return (await this.options.store.getControl(this.suppressionPath(listId, hash))) !== null;
  }

  private score(submission: NewsletterSubmission): SpamResult {
    const scorer = this.options.spamScorer ?? scoreInquiry;
    return safeScore(
      {
        kind: "newsletter",
        name: "",
        email: submission.email,
        company: "",
        message: "",
        honeypot_filled: submission.website !== "",
        ...(submission.elapsed_ms !== undefined ? { elapsed_ms: submission.elapsed_ms } : {}),
      } satisfies SpamInput,
      scorer,
    );
  }

  /**
   * Stores the signup and, when allowed, sends one confirmation email. Always the same reply for a
   * valid signup; a 400 for invalid fields; a 503 only when nothing could be stored.
   */
  async subscribe(
    form: IntakeFormConfig,
    raw: unknown,
    linkBase: string,
  ): Promise<{ receipt: string; message: string }> {
    if (!this.options.forms.includes(form)) throw new IntakeError(404, "Not found.");
    const submission = validateNewsletterSubmission(raw, form, this.options.contactPolicy);
    const reply = { receipt: submission.submission_id, message: NEWSLETTER_SIGNUP_MESSAGE };
    const listId = form.formId;
    const hash = this.subscriptionHash(listId, submission.email);
    const path = this.subscriptionPath(hash);
    const spam = this.score(submission);
    let stored: { record: SubscriptionRecord; revision: string; send: boolean; created: boolean } | undefined;
    try {
      stored = await this.record(form, submission, spam, hash);
    } catch (error) {
      this.report("newsletter_store_failed", error);
      throw new IntakeError(503, "The signup could not be confirmed. Retry the same receipt.");
    }
    if (stored.send) {
      try {
        await this.sendConfirmation(form, submission.email, hash, linkBase);
      } catch (error) {
        this.report("newsletter_send_failed", error);
        await this.releaseReservation(path, listId, submission.submission_id).catch((cause) =>
          this.report("newsletter_release_failed", cause),
        );
      }
    }
    if (stored.created) await this.syncCrm(form, stored.record);
    return reply;
  }

  /** Create-or-append under a conditional write, deciding and reserving any send in the same write. */
  private async record(
    form: IntakeFormConfig,
    submission: NewsletterSubmission,
    spam: SpamResult,
    hash: string,
  ) {
    const listId = form.formId;
    const path = this.subscriptionPath(hash);
    const isSuppressed = await this.suppressed(listId, hash);
    for (let attempt = 0; attempt < 10; attempt++) {
      const now = this.now();
      const at = now.toISOString();
      const object = await this.options.store.getControl(path);
      const existing = object ? this.decode(object.bytes, listId) : undefined;
      const replay = existing?.requests.some((item) => item.submission_id === submission.submission_id);
      if (existing && replay)
        return { record: existing, revision: object!.revision, send: false, created: false };
      const last = existing?.confirmation.last_sent_at ? Date.parse(existing.confirmation.last_sent_at) : NaN;
      const outcome: ConfirmationOutcome =
        isSuppressed || existing?.status === "unsubscribed"
          ? "suppressed"
          : existing?.status === "active"
            ? "already_active"
            : spam.verdict === "likely_spam"
              ? "likely_spam"
              : now.getTime() - last < CONFIRMATION_RESEND_MS
                ? "resend_limit"
                : "sent";
      const form_signals: FormSignals = {
        ...(submission.website ? { honeypot_filled: true as const } : {}),
        ...(submission.elapsed_ms !== undefined ? { elapsed_ms: submission.elapsed_ms } : {}),
      };
      const request: SubscriptionRequest = {
        submission_id: submission.submission_id,
        received_at: at,
        notice_version: submission.notice_version,
        page_path: submission.page_path,
        campaign: submission.campaign,
        ...(Object.keys(form_signals).length ? { form_signals } : {}),
        spam_verdict: spam.verdict,
        spam_score: spam.score,
        spam_reasons: spam.reasons,
        spam_rules_version: SPAM_RULES.rules_version,
        confirmation: outcome,
      };
      const prior = existing?.requests ?? [];
      const requests =
        prior.length >= MAX_REQUESTS_KEPT
          ? [prior[0], ...prior.slice(prior.length - MAX_REQUESTS_KEPT + 2), request]
          : [...prior, request];
      const send = outcome === "sent";
      const record: SubscriptionRecord = {
        version: 1,
        kind: "newsletter-subscription",
        workspace: this.options.workspace,
        list_id: listId,
        site_id: form.siteId,
        email: submission.email,
        created_at: at,
        ...existing,
        status:
          existing?.status === "active"
            ? "active"
            : isSuppressed
              ? "unsubscribed"
              : (existing?.status ?? "pending"),
        updated_at: at,
        requests,
        confirmation: {
          ...(existing?.confirmation ?? { sends: 0 }),
          ...(send ? { sends: (existing?.confirmation.sends ?? 0) + 1, last_sent_at: at } : {}),
        },
      };
      try {
        const written = await this.options.store.putControl(
          path,
          JSON.stringify(record),
          object ? { revision: object.revision } : { absent: true },
        );
        return { record, revision: written.revision, send, created: !existing };
      } catch (error) {
        if (!(error instanceof ControlConflict)) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt, 64)));
      }
    }
    throw new Error("Subscription record is busy.");
  }

  /** After a failed send, frees the 24-hour reservation so the next signup can try again. */
  private async releaseReservation(path: string, listId: string, submissionId: string) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const object = await this.options.store.getControl(path);
      if (!object) return;
      const record = this.decode(object.bytes, listId);
      const at = this.now().toISOString();
      const requests = record.requests.map((item) =>
        item.submission_id === submissionId && item.confirmation === "sent"
          ? { ...item, confirmation: "send_failed" as const }
          : item,
      );
      const { last_sent_at: _released, ...confirmation } = record.confirmation;
      const lastGood = [...requests].reverse().find((item) => item.confirmation === "sent")?.received_at;
      const next: SubscriptionRecord = {
        ...record,
        requests,
        updated_at: at,
        confirmation: {
          ...confirmation,
          sends: Math.max(0, record.confirmation.sends - 1),
          last_failed_at: at,
          ...(lastGood ? { last_sent_at: lastGood } : {}),
        },
      };
      try {
        await this.options.store.putControl(path, JSON.stringify(next), { revision: object.revision });
        return;
      } catch (error) {
        if (!(error instanceof ControlConflict)) throw error;
      }
    }
  }

  private async sendConfirmation(form: IntakeFormConfig, email: string, hash: string, linkBase: string) {
    const list = form.list!;
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    const confirmToken = await signToken(this.options.tokenSecret, {
      purpose: "confirm",
      listId: form.formId,
      subscription: hash,
      expires: nowSeconds + CONFIRM_TOKEN_SECONDS,
    });
    const unsubscribeUrl = await this.unsubscribeUrl(form.formId, hash, linkBase);
    const confirmUrl = `${linkBase}${newsletterPagePath("confirm")}?token=${confirmToken}`;
    const escape = (value: string) =>
      value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
    const text = [
      `Please confirm that you want ${list.name} news by email.`,
      "",
      "Confirm your subscription:",
      confirmUrl,
      "",
      "This link works for 7 days. If you didn't ask for this, ignore this email and you won't be subscribed.",
      "",
      `Unsubscribe: ${unsubscribeUrl}`,
      `${list.name}: ${list.siteUrl}`,
      `Privacy: ${list.privacyUrl}`,
      "",
    ].join("\n");
    const html = `<!doctype html><html lang="en"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1d1d1f">
<p>Please confirm that you want ${escape(list.name)} news by email.</p>
<p><a href="${escape(confirmUrl)}" style="display:inline-block;padding:10px 18px;background:#1f4fd6;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">Confirm subscription</a></p>
<p>This link works for 7 days. If you didn't ask for this, ignore this email and you won't be subscribed.</p>
<p style="color:#5b5b60;font-size:14px"><a href="${escape(unsubscribeUrl)}">Unsubscribe</a> · <a href="${escape(list.siteUrl)}">${escape(list.name)}</a> · <a href="${escape(list.privacyUrl)}">Privacy</a></p>
</body></html>`;
    await this.options.mailer({
      to: email,
      from: `${list.name} <${senderAddress(list)}>`,
      subject: `Confirm your ${list.name} newsletter subscription`,
      text,
      html,
      unsubscribeUrl,
      listId: `${list.name} <${form.formId}.${list.senderDomain}>`,
    });
  }

  /** The permanent one-click unsubscribe URL for a subscription (also for future campaign emails). */
  async unsubscribeUrl(listId: string, hash: string, linkBase: string) {
    const token = await signToken(this.options.tokenSecret, {
      purpose: "unsubscribe",
      listId,
      subscription: hash,
      expires: 0,
    });
    return `${linkBase}${newsletterPagePath("unsubscribe")}?token=${token}`;
  }

  private list(listId: string) {
    return this.options.forms.find((form) => form.formId === listId);
  }

  /** GET shows a button and changes nothing (mail scanners fetch links); POST confirms. */
  async confirm(token: unknown, method: "GET" | "POST"): Promise<NewsletterPage> {
    let claims;
    try {
      claims = await verifyToken(this.options.tokenSecret, token, "confirm", this.now().getTime() / 1000);
    } catch (error) {
      this.report("newsletter_token_unavailable", error);
      return pages.unavailable();
    }
    const form = claims ? this.list(claims.listId) : undefined;
    if (!claims || !form) return pages.invalid(form?.list);
    if (method === "GET") return pages.confirmPrompt(form.list);
    try {
      if (await this.suppressed(form.formId, claims.subscription)) return pages.unsubscribed(form.list);
      const path = this.subscriptionPath(claims.subscription);
      for (let attempt = 0; attempt < 10; attempt++) {
        const object = await this.options.store.getControl(path);
        if (!object) return pages.invalid(form.list);
        const record = this.decode(object.bytes, form.formId);
        if (record.status === "unsubscribed") return pages.unsubscribed(form.list);
        if (record.status === "active") return pages.confirmed(form.list);
        const at = this.now().toISOString();
        const latest = [...record.requests].reverse()[0];
        const next: SubscriptionRecord = {
          ...record,
          status: "active",
          updated_at: at,
          consent: {
            notice_version: latest.notice_version,
            requested_at: latest.received_at,
            confirmed_at: at,
            source: {
              site_id: form.siteId,
              form_id: form.formId,
              page_path: latest.page_path,
              campaign: latest.campaign,
            },
          },
        };
        try {
          await this.options.store.putControl(path, JSON.stringify(next), { revision: object.revision });
          await this.syncCrm(form, next);
          return pages.confirmed(form.list);
        } catch (error) {
          if (!(error instanceof ControlConflict)) throw error;
        }
      }
      return pages.unavailable(form.list);
    } catch (error) {
      this.report("newsletter_confirm_failed", error);
      return pages.unavailable(form.list);
    }
  }

  /**
   * GET shows a button and changes nothing; POST (the page's button, or a mail client's RFC 8058
   * one-click request) writes the permanent suppression and marks the subscription. Idempotent. An
   * unsubscribe is honoured even for a list that is no longer enabled.
   */
  async unsubscribe(token: unknown, method: "GET" | "POST"): Promise<NewsletterPage> {
    let claims;
    try {
      claims = await verifyToken(this.options.tokenSecret, token, "unsubscribe", this.now().getTime() / 1000);
    } catch (error) {
      this.report("newsletter_token_unavailable", error);
      return pages.unavailable();
    }
    if (!claims) return pages.invalid();
    const form = this.list(claims.listId);
    if (method === "GET") return pages.unsubscribePrompt(form?.list);
    const methodName: SuppressionRecord["method"] = "one-click";
    try {
      const at = this.now().toISOString();
      const suppression: SuppressionRecord = {
        version: 1,
        kind: "newsletter-suppression",
        workspace: this.options.workspace,
        list_id: claims.listId,
        subscription: claims.subscription,
        reason: "unsubscribed",
        method: methodName,
        at,
      };
      try {
        await this.options.store.putControl(
          this.suppressionPath(claims.listId, claims.subscription),
          JSON.stringify(suppression),
          { absent: true },
        );
      } catch (error) {
        if (!(error instanceof ControlConflict)) throw error; // already suppressed: idempotent
      }
      const path = this.subscriptionPath(claims.subscription);
      for (let attempt = 0; attempt < 10; attempt++) {
        const object = await this.options.store.getControl(path);
        if (!object) break;
        const record = this.decode(object.bytes, claims.listId);
        if (record.status === "unsubscribed") break;
        const next: SubscriptionRecord = {
          ...record,
          status: "unsubscribed",
          updated_at: at,
          unsubscribed_at: at,
          unsubscribe_method: methodName,
        };
        try {
          await this.options.store.putControl(path, JSON.stringify(next), { revision: object.revision });
          if (form) await this.syncCrm(form, next);
          break;
        } catch (error) {
          if (!(error instanceof ControlConflict)) throw error;
        }
      }
      return pages.unsubscribed(form?.list);
    } catch (error) {
      this.report("newsletter_unsubscribe_failed", error);
      return pages.unavailable(form?.list);
    }
  }

  /**
   * Shows the subscription on the person's existing prospect (custom.newsletters.<listId>). Never
   * creates a prospect and never throws: the subscription record stays the source of truth.
   */
  private async syncCrm(form: IntakeFormConfig, record: SubscriptionRecord): Promise<void> {
    const request = this.options.request;
    if (!request) return;
    try {
      let issueId = await this.identities.findIssue(record.email);
      if (!issueId) {
        const fields = JSON.stringify([
          { field: "custom.contact_email", operator: "eq", value: record.email },
        ]);
        const found = (await request(
          `/issues?type=prospect&limit=2&fields=${encodeURIComponent(fields)}`,
        )) as {
          issues: IssueRecord[];
        };
        const ids = (found.issues ?? []).map((hit) => hit?.issue?.id).filter((id) => typeof id === "string");
        if (ids.length !== 1) return;
        issueId = ids[0];
      }
      const first = record.requests[0];
      const summary: NewsletterSummary = {
        list: form.list!.name,
        status: record.status,
        requested_at: record.consent?.requested_at ?? first.received_at,
        notice_version: record.consent?.notice_version ?? first.notice_version,
        source_page: record.consent?.source.page_path ?? first.page_path,
        ...(record.consent ? { confirmed_at: record.consent.confirmed_at } : {}),
        ...(record.unsubscribed_at ? { unsubscribed_at: record.unsubscribed_at } : {}),
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = (await request(`/issues/${encodeURIComponent(issueId)}`)) as IssueRecord;
        // The update is built from the record itself, and only for the prospect with this exact email.
        if (current.issue?.id !== issueId || current.issue.custom?.contact_email !== record.email) return;
        const existing = current.issue.custom?.newsletters;
        const newsletters =
          existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
        try {
          await request(`/issues/${encodeURIComponent(issueId)}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "X-Operation-Id": randomUUID(),
              "If-Match": current.revision,
            },
            body: JSON.stringify({ custom: { newsletters: { ...newsletters, [form.formId]: summary } } }),
          });
          return;
        } catch (error) {
          if (!(error instanceof IntakeError && error.status === 409)) throw error;
        }
      }
    } catch (error) {
      this.report("newsletter_crm_deferred", error);
    }
  }
}
