import { useEffect, useMemo, useState } from "react";
import type { Configuration, IssueRecord, KanbusClient } from "../client";
import {
  addDays,
  followUpBucket,
  isActiveStage,
  localDate,
  prospectInterests,
  websiteInquiries,
  type FollowUpBucket,
} from "../prospect";
import type { Write } from "./PipelineView";
import { AppChip, Eyebrow, Stat, Unavailable } from "../shared/ui";

const GROUPS: Array<{ key: Exclude<FollowUpBucket, "later">; label: string; tone: string }> = [
  { key: "overdue", label: "Overdue", tone: "hot" },
  { key: "today", label: "Today", tone: "" },
  { key: "week", label: "This week", tone: "quiet" },
];

export interface TodaySummary {
  due: number;
  overdue: number;
}

export function TodayView({
  api,
  configuration,
  version,
  write,
  busy,
  onOpen,
  onComplete,
  onNavigatePipeline,
  onNavigateAccounts,
  onSummary,
  onError,
}: {
  api: KanbusClient;
  configuration: Configuration;
  version: number;
  write: Write;
  busy: boolean;
  onOpen: (record: IssueRecord) => void;
  onComplete: (record: IssueRecord) => void;
  onNavigatePipeline: () => void;
  onNavigateAccounts: () => void;
  onSummary: (summary: TodaySummary) => void;
  onError: (message: string) => void;
}) {
  const today = localDate();
  const [followUps, setFollowUps] = useState<IssueRecord[] | null>(null);
  const [leads, setLeads] = useState<IssueRecord[] | null>(null);
  const [open, setOpen] = useState<{ count: number; more: boolean } | null>(null);

  useEffect(() => {
    let current = true;
    const actor = configuration.actor_id;
    void Promise.all([
      api.issues({
        type: "prospect",
        assignee: actor,
        limit: 100,
        fields: [{ field: "custom.next_follow_up_at", operator: "lte", value: addDays(today, 6) }],
      }),
      api.issues({ type: "prospect", status: configuration.initial_status, limit: 100 }),
      api.issues({ type: "prospect", limit: 100 }),
    ])
      .then(([mine, fresh, all]) => {
        if (!current) return;
        setFollowUps(mine.issues.filter((record) => isActiveStage(record.issue.status, configuration)));
        setLeads(fresh.issues.filter((record) => websiteInquiries(record.issue).length > 0));
        setOpen({
          count: all.issues.filter((record) => isActiveStage(record.issue.status, configuration)).length,
          more: Boolean(all.next_cursor),
        });
      })
      .catch((cause: Error) => current && onError(cause.message));
    return () => {
      current = false;
    };
  }, [api, configuration, version, today, onError]);

  const grouped = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        items: (followUps ?? [])
          .filter(
            (record) =>
              followUpBucket(String(record.issue.custom?.next_follow_up_at ?? ""), today) === group.key,
          )
          .sort((left, right) =>
            String(left.issue.custom?.next_follow_up_at).localeCompare(
              String(right.issue.custom?.next_follow_up_at),
            ),
          ),
      })),
    [followUps, today],
  );
  const overdue = grouped[0].items.length;
  const due = overdue + grouped[1].items.length;
  const remaining = grouped.reduce((sum, group) => sum + group.items.length, 0);
  useEffect(() => {
    if (followUps) onSummary({ due, overdue });
  }, [followUps, due, overdue, onSummary]);

  const sortedLeads = useMemo(
    () =>
      [...(leads ?? [])]
        .sort((left, right) => latestInquiryAt(right).localeCompare(latestInquiryAt(left)))
        .slice(0, 5),
    [leads],
  );
  const stageName = (key: string) => configuration.statuses.find((status) => status.key === key)?.name ?? key;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <main className="one-main narrow" aria-label="Today">
      <section className="one-hero">
        <div className="one-hero-title">
          <Eyebrow>
            ••••••{" "}
            {new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
          </Eyebrow>
          <h1 className="greeting">
            {greeting}, {displayName(configuration.actor_id)}
          </h1>
        </div>
        <div className="one-stats">
          <Stat
            value={followUps ? String(due) : "…"}
            label="FOLLOW-UPS DUE"
            note={overdue ? `${overdue} overdue` : "Nothing overdue"}
            hot={overdue > 0}
            href="#follow-ups"
          />
          <Stat
            value={leads ? String(leads.length) : "…"}
            label="NEW INQUIRIES"
            note="From website forms"
            href="#inquiries"
          />
          <Stat
            value={open ? `${open.count}${open.more ? "+" : ""}` : "…"}
            label="OPEN PROSPECTS"
            note="Pipeline value not yet available"
            href="?view=pipeline"
            onClick={onNavigatePipeline}
          />
          <Stat
            value={null}
            label="ACCOUNTS TO WATCH"
            note="Needs quota, trial and payment data"
            href="?view=accounts"
            onClick={onNavigateAccounts}
          />
        </div>
      </section>
      <div className="one-columns">
        <section className="primary" id="follow-ups" aria-labelledby="follow-ups-heading">
          <div className="one-section-head">
            <h2 id="follow-ups-heading">Your follow-ups</h2>
            <span>
              {followUps === null
                ? "Loading…"
                : remaining === 0
                  ? "All done for this week"
                  : `${remaining} to go`}
            </span>
          </div>
          {grouped.map((group) => (
            <div key={group.key} className={`one-group ${group.tone}`}>
              <div className="one-group-head">
                <span className="label">{group.label.toUpperCase()}</span>
                <span className="count">{group.items.length}</span>
              </div>
              {group.items.length === 0 && <p className="one-empty">Nothing {group.label.toLowerCase()}.</p>}
              {group.items.map((record) => (
                <div key={record.issue.id} className="one-row">
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() => onComplete(record)}
                    aria-label={`Mark done: ${String(record.issue.custom?.next_action ?? record.issue.title)}`}
                  />
                  <span className="one-row-main">
                    <span className="one-row-title">
                      {String(record.issue.custom?.next_action || "Follow up")}
                    </span>
                    <span className="one-row-sub">
                      <a
                        href={`?view=pipeline`}
                        onClick={(event) => {
                          event.preventDefault();
                          onOpen(record);
                        }}
                      >
                        {String(record.issue.custom?.company || record.issue.title)}
                      </a>
                      {record.issue.custom?.company ? ` · ${record.issue.title}` : ""}
                    </span>
                  </span>
                  <span className="one-pill">{stageName(record.issue.status)}</span>
                  <span className={`one-due${group.key === "overdue" ? " hot" : ""}`}>
                    {dueLabel(String(record.issue.custom?.next_follow_up_at), group.key)}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </section>
        <div className="secondary">
          <section className="one-card hot" id="inquiries" aria-label="New inquiries">
            <div className="one-section-head">
              <Eyebrow>•••• New inquiries</Eyebrow>
              <span>In {stageName(configuration.initial_status)}</span>
            </div>
            {leads === null && <p role="status">Loading…</p>}
            {leads?.length === 0 && <p className="one-empty">No new website inquiries.</p>}
            {sortedLeads.map((record) => {
              const latest = websiteInquiries(record.issue).at(-1) ?? {};
              const mine = record.issue.assignee === configuration.actor_id;
              return (
                <div className="one-lead" key={record.issue.id}>
                  <span className="one-lead-head">
                    <strong>{String(record.issue.custom?.company || record.issue.title)}</strong>
                    <span>{relative(String(latest.received_at ?? ""))}</span>
                  </span>
                  <p>“{truncate(String(latest.message ?? ""), 140)}”</p>
                  <span className="one-lead-foot">
                    {prospectInterests(record.issue).map((id) => (
                      <AppChip key={id} id={id} />
                    ))}
                    {mine ? (
                      <button type="button" className="one-button small" onClick={() => onOpen(record)}>
                        Open
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="one-button small primary"
                        disabled={busy}
                        aria-label={`Take ${String(record.issue.custom?.company || record.issue.title)}`}
                        onClick={() =>
                          void write(() =>
                            api.update(record.issue.id, record.revision, {
                              assignee: configuration.actor_id,
                            }),
                          )
                        }
                      >
                        Take it
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </section>
          <section className="one-card" aria-label="Accounts to watch">
            <Eyebrow>•••• Accounts to watch</Eyebrow>
            <Unavailable title="Not yet available">
              <span>
                Accounts nearing their quota, ending a trial or with a failed payment will show here once
                usage and billing are recorded.
              </span>
            </Unavailable>
          </section>
        </div>
      </div>
    </main>
  );
}

function latestInquiryAt(record: IssueRecord): string {
  return String(websiteInquiries(record.issue).at(-1)?.received_at ?? "");
}

function displayName(actor: string): string {
  const local = actor.replace(/@.*/, "");
  if (/^[0-9a-f-]{20,}$/i.test(local)) return "there";
  const first = local.split(/[\s._-]+/)[0] ?? local;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function dueLabel(date: string, bucket: FollowUpBucket): string {
  if (bucket === "today") return "Today";
  const value = new Date(`${date}T12:00:00`);
  return bucket === "week"
    ? value.toLocaleDateString(undefined, { weekday: "short" })
    : value.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function relative(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "";
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  if (minutes < 60 * 48) return "Yesterday";
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}
