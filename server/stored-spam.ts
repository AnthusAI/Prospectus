import { derivedUuid } from "./inbox";
import { LIKELY_SPAM_LABEL, spamInputFor, type Inquiry } from "./intake";
import { safeScore, scoreInquiry } from "./intake-spam";

interface StoredProspect {
  id: string;
  type?: string;
  status?: string;
  labels?: unknown;
  custom?: Record<string, unknown>;
}

const PERSON_LABELS = ["spam", "vendor"];

/**
 * The change that labels one stored prospect with the current rules, or null when it must be left
 * alone: a person has decided, it has moved on, it is already labelled, or any of its inquiries
 * does not score likely_spam. Inquiries are never changed.
 */
export function storedSpamChanges(
  issue: StoredProspect,
  initialStatus: string,
): { labels: string[]; custom: Record<string, unknown> } | null {
  const labels = Array.isArray(issue.labels) ? (issue.labels as string[]) : [];
  const custom = issue.custom ?? {};
  const inquiries = Array.isArray(custom.inquiries) ? (custom.inquiries as Inquiry[]) : [];
  if (issue.type !== "prospect" || issue.status !== initialStatus || inquiries.length === 0) return null;
  if (labels.includes(LIKELY_SPAM_LABEL) || labels.some((label) => PERSON_LABELS.includes(label)))
    return null;
  if (custom.spam_review || custom.spam_corrections) return null;
  const allSpam = inquiries.every(
    (inquiry) => safeScore(spamInputFor(inquiry), scoreInquiry).verdict === "likely_spam",
  );
  if (!allSpam) return null;
  return {
    labels: [...labels, LIKELY_SPAM_LABEL],
    custom: { next_action: null, next_follow_up_at: null, spam_status: "likely_spam" },
  };
}

type Request = (path: string, init?: RequestInit) => Promise<unknown>;
interface Record_ {
  issue: StoredProspect;
  revision: string;
}

/** Labels every stored prospect that qualifies. Without `apply` it writes nothing. Returns ids only. */
export async function labelStoredSpam(options: {
  request: Request;
  workspace: string;
  initialStatus: string;
  apply: boolean;
}): Promise<{ scanned: number; labelled: string[] }> {
  const issues: Record_[] = [];
  let cursor: string | null = null;
  do {
    const page = (await options.request(
      `/issues?type=prospect&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    )) as { issues?: Record_[]; next_cursor?: string | null };
    issues.push(...(page.issues ?? []));
    cursor = page.next_cursor ?? null;
  } while (cursor);
  const labelled: string[] = [];
  for (const hit of issues) {
    const path = `/issues/${encodeURIComponent(hit.issue.id)}`;
    const record = (await options.request(path)) as Record_;
    const changes = storedSpamChanges(record.issue, options.initialStatus);
    if (!changes) continue;
    labelled.push(record.issue.id);
    if (!options.apply) continue;
    await options.request(path, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "If-Match": record.revision,
        "X-Operation-Id": derivedUuid(
          `${options.workspace}\nstored-spam\n${record.issue.id}\n${record.revision}`,
        ),
      },
      body: JSON.stringify(changes),
    });
  }
  return { scanned: issues.length, labelled };
}
