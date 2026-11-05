import { ANTHUS_APPS } from "../apps";
import type { IssueRecord } from "../client";
import { websiteInquiries } from "../prospect";
import { AppMark } from "../shared/ui";

export function InterestPicker({ selected }: { selected: string[] }) {
  return (
    <fieldset className="one-interests">
      <legend className="one-field-label">Interested in</legend>
      <input type="hidden" name="interests_field" value="1" />
      <span className="one-chips">
        {ANTHUS_APPS.map((app) => (
          <label key={app.id} className="one-chip selectable">
            <input
              type="checkbox"
              name="interests"
              value={app.id}
              defaultChecked={selected.includes(app.id)}
            />
            <AppMark app={app} />
            {app.name}
          </label>
        ))}
      </span>
    </fieldset>
  );
}

export function OwnerField({ owners, value }: { owners: string[]; value?: string }) {
  return (
    <label>
      Owner
      <input name="assignee" list="prospect-owners" defaultValue={value} required autoComplete="off" />
      <datalist id="prospect-owners">
        {owners.map((owner) => (
          <option key={owner} value={owner} />
        ))}
      </datalist>
    </label>
  );
}

export interface TimelineEntry {
  key: string;
  at: string;
  who: string;
  text: string;
  kind: "inquiry" | "note" | "first";
}

export function timeline(record: IssueRecord): TimelineEntry[] {
  const issue = record.issue;
  const entries: TimelineEntry[] = websiteInquiries(issue).map((inquiry, index) => {
    const source =
      inquiry.source && typeof inquiry.source === "object" ? (inquiry.source as Record<string, unknown>) : {};
    const campaign =
      source.campaign && typeof source.campaign === "object"
        ? (source.campaign as Record<string, unknown>)
        : {};
    const details = [
      `Source: ${String(source.site_id ?? "Unknown")} / ${String(source.form_id ?? "")}`,
      Object.entries(campaign)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(" · "),
      `Marketing opt-in: ${inquiry.marketing_opt_in === true ? "Recorded" : "Not recorded"}`,
    ].filter(Boolean);
    return {
      key: `inquiry-${String(inquiry.id ?? index)}`,
      at: String(inquiry.received_at ?? ""),
      who: `${String(inquiry.name ?? "Website")} · website inquiry`,
      text: `${String(inquiry.message ?? "")}\n${details.join("\n")}`,
      kind: "inquiry",
    };
  });
  if (issue.description && !entries.length)
    entries.push({
      key: "first",
      at: String((issue as { created_at?: string }).created_at ?? ""),
      who: "First note",
      text: issue.description,
      kind: "first",
    });
  for (const [index, comment] of (issue.comments ?? []).entries())
    entries.push({
      key: comment.id ?? `comment-${index}`,
      at: comment.created_at ?? "",
      who: comment.author ?? "",
      text: comment.text ?? "",
      kind: "note",
    });
  return entries.sort((left, right) => left.at.localeCompare(right.at));
}

export function when(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
