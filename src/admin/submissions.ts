import type { Issue } from "../client";
import { websiteInquiries } from "../prospect";

const WEBSITE_ORIGIN = "https://anth.us";
const WEBSITE_SITE_ID = "anthus-website";
const PLAIN_EMAIL = /^[^\s@<>"'`,;:()[\]\\]+@[^\s@<>"'`,;:()[\]\\]+\.[^\s@<>"'`,;:()[\]\\]+$/;

export interface InquiryDetails {
  key: string;
  kindLabel: string;
  receivedAt: string;
  receivedAtLabel: string;
  name: string;
  email: string;
  company: string;
  message: string;
  sourceLabel: string;
  pagePath: string;
  pageHref: string | null;
  campaign: Array<[string, string]>;
  marketingOptIn: boolean | null;
  noticeVersion: string;
  attributes: Array<[string, string]>;
}

export interface SubmissionDetails {
  contactEmail: string;
  needsReview: boolean;
  reviewReason: string;
  relatedIssueId: string;
  company: string;
  firstSource: string;
  latestSource: string;
  nextAction: string;
  followUp: string;
  inquiries: InquiryDetails[];
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pairs(value: unknown): Array<[string, string]> {
  return Object.entries(record(value))
    .map(([key, entry]): [string, string] => [key, text(entry)])
    .filter(([, entry]) => entry !== "");
}

export function mailtoHref(email: string): string | null {
  return PLAIN_EMAIL.test(email) ? `mailto:${email}` : null;
}

export function websitePageHref(siteId: string, pagePath: string): string | null {
  if (siteId !== WEBSITE_SITE_ID || !pagePath.startsWith("/") || pagePath.startsWith("//")) return null;
  if (/[\s\\\u0000-\u001f\u007f]/.test(pagePath)) return null;
  try {
    const target = new URL(pagePath, WEBSITE_ORIGIN);
    return target.origin === WEBSITE_ORIGIN ? target.href : null;
  } catch {
    return null;
  }
}

export function describeSource(source: unknown): string {
  const fields = record(source);
  const place = [text(fields.site_id), text(fields.form_id)].filter(Boolean).join(" / ");
  return [place, text(fields.page_path)].filter(Boolean).join(" · ");
}

export function receivedTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function inquiryKindLabel(kind: string): string {
  if (kind === "demo") return "Demo request";
  if (kind === "waitlist") return "Waitlist signup";
  return kind ? `Inquiry (${kind})` : "Inquiry";
}

export function reviewReasonLabel(reason: string): string {
  return reason.replaceAll("_", " ");
}

function inquiryDetails(inquiry: Record<string, unknown>, index: number): InquiryDetails {
  const source = record(inquiry.source);
  const pagePath = text(source.page_path);
  const receivedAt = text(inquiry.received_at);
  return {
    key: `${text(inquiry.id) || "inquiry"}-${index}`,
    kindLabel: inquiryKindLabel(text(inquiry.kind)),
    receivedAt,
    receivedAtLabel: receivedAt ? receivedTime(receivedAt) : "",
    name: text(inquiry.name),
    email: text(inquiry.email),
    company: text(inquiry.company),
    message: text(inquiry.message),
    sourceLabel: [text(source.site_id), text(source.form_id)].filter(Boolean).join(" / "),
    pagePath,
    pageHref: websitePageHref(text(source.site_id), pagePath),
    campaign: pairs(source.campaign),
    marketingOptIn: typeof inquiry.marketing_opt_in === "boolean" ? inquiry.marketing_opt_in : null,
    noticeVersion: text(inquiry.notice_version),
    attributes: pairs(inquiry.attributes),
  };
}

function newestFirst(left: InquiryDetails, right: InquiryDetails): number {
  const leftTime = Date.parse(left.receivedAt);
  const rightTime = Date.parse(right.receivedAt);
  if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return Number.isNaN(leftTime) ? 1 : -1;
  return rightTime - leftTime;
}

export function submissionDetails(issue: Issue): SubmissionDetails {
  const custom = record(issue.custom);
  const labels = (issue as { labels?: string[] }).labels ?? [];
  const reviewReason = text(custom.review_reason);
  return {
    contactEmail: text(custom.contact_email) || text(custom.review_contact_email),
    needsReview: labels.includes("needs-review") || reviewReason !== "",
    reviewReason,
    relatedIssueId: text(custom.review_related_issue),
    company: text(custom.company),
    firstSource: describeSource(custom.first_source),
    latestSource: describeSource(custom.latest_source),
    nextAction: text(custom.next_action),
    followUp: text(custom.next_follow_up_at),
    inquiries: websiteInquiries(issue).map(inquiryDetails).sort(newestFirst),
  };
}
