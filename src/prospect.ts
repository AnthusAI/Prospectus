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
