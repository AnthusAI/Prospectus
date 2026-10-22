import type { Configuration, Issue } from "./client";
import { nextBusinessDay, websiteInquiries } from "./prospect";

/** Set automatically by intake for likely spam (label mode, or a filled honeypot). */
export const LIKELY_SPAM_LABEL = "likely-spam";
/** Set only by a person. */
export const SPAM_LABEL = "spam";
/** A real person selling services: set only by a person, never counted as spam. */
export const VENDOR_LABEL = "vendor";
/** Hidden from the pipeline by default, behind a visible "N hidden" control. */
export const HIDDEN_SPAM_LABELS = [LIKELY_SPAM_LABEL, SPAM_LABEL];
const REVIEW_LABELS = [LIKELY_SPAM_LABEL, SPAM_LABEL, VENDOR_LABEL];

export type SpamReviewLabel = "not_spam" | "spam" | "vendor";

export const SPAM_REASON_TEXT: Record<string, string> = {
  gibberish_name: "Name looks machine-generated",
  gibberish_company: "Company looks machine-generated",
  template_only_message: "Message is only the form's prompts",
  markup_or_links: "Message has link markup or several links",
  gmail_dot_scatter: "Gmail address with scattered dots",
  honeypot: "The hidden form field was filled",
  fast_submit: "Sent within 1.5 seconds of opening the form",
  scorer_error: "The spam check failed, so it was treated as clean",
  vendor_pitch: "Reads like a pitch for services",
};

const VERDICT_TEXT: Record<string, string> = {
  likely_spam: "Likely spam",
  uncertain: "Uncertain",
  clean: "Clean",
  unscored: "Not scored",
};

export function issueLabels(issue: Issue): string[] {
  const labels = (issue as { labels?: unknown }).labels;
  return Array.isArray(labels) ? labels.filter((label): label is string => typeof label === "string") : [];
}

export function hiddenAsSpam(issue: Issue): boolean {
  return issueLabels(issue).some((label) => HIDDEN_SPAM_LABELS.includes(label));
}

export interface SpamCorrection {
  label: SpamReviewLabel;
  reviewer: string;
  at: string;
  inquiry_id: string | null;
  rules_version: string | null;
  machine: { score: number | null; verdict: string | null; reasons: string[] };
}

export interface SpamSummary {
  verdict: string | null;
  verdictText: string;
  score: number | null;
  reasons: Array<{ code: string; text: string }>;
  hints: Array<{ code: string; text: string }>;
  rulesVersion: string | null;
  mode: string | null;
  protected: boolean;
  inquiryId: string | null;
  /** The label a person or intake put on the prospect, if any. */
  label: string | null;
  review: SpamCorrection | null;
}

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const described = (codes: string[]) => codes.map((code) => ({ code, text: SPAM_REASON_TEXT[code] ?? code }));

/** The spam check on the latest scored inquiry, with any person's review. */
export function spamSummary(issue: Issue): SpamSummary {
  const scored = [...websiteInquiries(issue)]
    .reverse()
    .find((inquiry) => typeof inquiry.spam_verdict === "string");
  const labels = issueLabels(issue);
  const review = issue.custom?.spam_review;
  const verdict = scored ? String(scored.spam_verdict) : null;
  return {
    verdict,
    verdictText: verdict ? (VERDICT_TEXT[verdict] ?? verdict) : "Not scored",
    score: typeof scored?.spam_score === "number" ? scored.spam_score : null,
    reasons: described(strings(scored?.spam_reasons)),
    hints: described(strings(scored?.spam_hints)),
    rulesVersion: typeof scored?.spam_rules_version === "string" ? scored.spam_rules_version : null,
    mode: typeof scored?.spam_mode === "string" ? scored.spam_mode : null,
    protected: scored?.spam_protected === true,
    inquiryId: typeof scored?.id === "string" ? scored.id : null,
    label: [SPAM_LABEL, VENDOR_LABEL, LIKELY_SPAM_LABEL].find((label) => labels.includes(label)) ?? null,
    review: review && typeof review === "object" ? (review as SpamCorrection) : null,
  };
}

/**
 * One revisioned update for a person's Not spam / Spam / Vendor decision. Nothing is deleted:
 * Spam and Vendor move the prospect to Closed and clear its follow-up; Not spam restores the
 * follow-up intake would have set. Every decision is kept as a correction for weight tuning.
 */
export function spamReviewChanges(
  issue: Issue,
  label: SpamReviewLabel,
  configuration: Configuration,
  now: Date = new Date(),
): Partial<Issue> & { labels: string[]; custom: Record<string, unknown> } {
  const summary = spamSummary(issue);
  const correction: SpamCorrection = {
    label,
    reviewer: configuration.actor_id,
    at: now.toISOString(),
    inquiry_id: summary.inquiryId,
    rules_version: summary.rulesVersion,
    machine: {
      score: summary.score,
      verdict: summary.verdict,
      reasons: summary.reasons.map((reason) => reason.code),
    },
  };
  const custom = issue.custom ?? {};
  const history = Array.isArray(custom.spam_corrections) ? custom.spam_corrections : [];
  const kept = issueLabels(issue).filter((existing) => !REVIEW_LABELS.includes(existing));
  const workflow = configuration.workflows?.prospect ?? configuration.workflows?.default ?? {};
  const closed = configuration.statuses.find((status) => status.semantic_category === "done")?.key;
  const isClosed = issue.status === closed;
  const canMove = (target: string | undefined) =>
    Boolean(target && target !== issue.status && (workflow[issue.status] ?? []).includes(target));
  const recorded = {
    ...custom,
    spam_review: correction,
    spam_corrections: [...history, correction].slice(-50),
  };
  if (label === "not_spam") {
    const messages = websiteInquiries(issue).filter((inquiry) => inquiry.kind !== "waitlist");
    const demo = messages.length > 0;
    const nextAction =
      messages[messages.length - 1]?.kind === "contact" ? "Respond to inquiry" : "Respond to demo request";
    const reopen = isClosed && canMove(configuration.initial_status);
    return {
      labels: kept,
      ...(reopen ? { status: configuration.initial_status } : {}),
      custom: {
        ...recorded,
        ...(demo ? { next_action: nextAction, next_follow_up_at: nextBusinessDay(now) } : {}),
      },
    };
  }
  return {
    labels: [...kept, label === "spam" ? SPAM_LABEL : VENDOR_LABEL],
    ...(canMove(closed) ? { status: closed } : {}),
    custom: { ...recorded, next_follow_up_at: null },
  };
}
