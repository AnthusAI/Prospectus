import type { ConditionalControlStore } from "./control-store";
import type { SubscriptionRecord } from "./newsletter";

export interface ExportRow {
  list_id: string;
  email: string;
  confirmed_at: string;
  notice_version: string;
  requested_at: string;
  source_page: string;
}
export interface ExportSummary {
  /** Counts per list and status; "suppressed" counts active subscribers the SES suppression list blocks. */
  counts: Record<string, Record<string, number>>;
  /** Confirmed, unsuppressed subscribers, ordered by list then confirmation time. */
  rows: ExportRow[];
}

/**
 * Operator export of confirmed subscribers. Reads the newsletter control objects listed with the
 * operator's own credentials; excludes per-list unsubscribes (status) and every address on the SES
 * account suppression list (hard bounces and complaints).
 */
export async function exportSubscribers(options: {
  workspace: string;
  store: ConditionalControlStore;
  paths: string[];
  /** Lower-case addresses on the SES account suppression list. */
  suppressed: ReadonlySet<string>;
  listId?: string;
}): Promise<ExportSummary> {
  const summary: ExportSummary = { counts: {}, rows: [] };
  for (const path of options.paths) {
    if (!/^intake-newsletter\/[a-f0-9]{64}\.json$/.test(path)) continue;
    const object = await options.store.getControl(path);
    if (!object) continue;
    const record = JSON.parse(object.bytes) as SubscriptionRecord;
    if (record.kind !== "newsletter-subscription" || record.workspace !== options.workspace) continue;
    if (options.listId && record.list_id !== options.listId) continue;
    const blocked = record.status === "active" && options.suppressed.has(record.email.toLowerCase());
    const status = blocked ? "suppressed" : record.status;
    const counts = (summary.counts[record.list_id] ??= {});
    counts[status] = (counts[status] ?? 0) + 1;
    if (status === "active" && record.consent)
      summary.rows.push({
        list_id: record.list_id,
        email: record.email,
        confirmed_at: record.consent.confirmed_at,
        notice_version: record.consent.notice_version,
        requested_at: record.consent.requested_at,
        source_page: record.consent.source.page_path,
      });
  }
  summary.rows.sort(
    (left, right) =>
      left.list_id.localeCompare(right.list_id) || left.confirmed_at.localeCompare(right.confirmed_at),
  );
  return summary;
}

const csvField = (value: string) => {
  // Neutralise spreadsheet formulas as well as quoting.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(rows: ExportRow[]): string {
  const header = [
    "list_id",
    "email",
    "confirmed_at",
    "notice_version",
    "requested_at",
    "source_page",
  ] as const;
  return (
    [header.join(","), ...rows.map((row) => header.map((key) => csvField(row[key])).join(","))].join("\n") +
    "\n"
  );
}
