import type { Configuration, Issue } from "./client";

export function isActiveStage(stage: string, configuration: Configuration): boolean {
  return configuration.statuses.find((status) => status.key === stage)?.semantic_category !== "done";
}

export function validateFollowUp(
  status: string,
  owner: string,
  action: string,
  date: string,
  configuration: Configuration,
): string | null {
  const active = isActiveStage(status, configuration);
  if (!owner.trim()) return "Choose an owner for this prospect.";
  if (active && (!action.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date)))
    return "Active prospects need a next action and follow-up date.";
  return null;
}

export function contactChanges(
  fields: FormData,
  issue?: Issue,
): Record<string, unknown> & {
  company: string;
  contact_email: string;
  next_action: string;
  next_follow_up_at: string | null;
} {
  return {
    ...issue?.custom,
    company: String(fields.get("company") ?? "").trim(),
    contact_email: String(fields.get("email") ?? "")
      .trim()
      .toLowerCase(),
    next_action: String(fields.get("next_action") ?? "").trim(),
    next_follow_up_at: String(fields.get("followup") ?? "") || null,
  };
}

/** Interests are app ids from the Anthus app catalog, stored on the prospect as `custom.interests`. */
export function prospectInterests(issue: Issue): string[] {
  const value = issue.custom?.interests;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function interestChanges(fields: FormData): { interests?: string[] } {
  if (!fields.has("interests_field")) return {};
  return { interests: [...new Set(fields.getAll("interests").map(String))] };
}

export function websiteInquiries(issue: Issue): Array<Record<string, unknown>> {
  const value = issue.custom?.inquiries;
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
}

export type FollowUpBucket = "overdue" | "today" | "week" | "later";

/** Buckets a `YYYY-MM-DD` follow-up date against today; "week" is the next six days. */
export function followUpBucket(date: string, today: string): FollowUpBucket | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (date < today) return "overdue";
  if (date === today) return "today";
  const days = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  return days <= 6 ? "week" : "later";
}

export function localDate(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function initials(name: string): string {
  const words = name
    .replace(/@.*/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase() || "?"
  );
}
