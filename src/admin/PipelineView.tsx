import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { IssueCollection, IssueDetailPanel, type KanbanIssue } from "@kanbus/ui";
import { ANTHUS_APPS } from "../apps";
import { issueUrl } from "../deep-links";
import type { Configuration, IssueRecord, KanbusClient, Query } from "../client";
import {
  addDays,
  contactChanges,
  interestChanges,
  isActiveStage,
  localDate,
  prospectInterests,
  validateFollowUp,
  websiteInquiries,
} from "../prospect";
import { Eyebrow } from "../shared/ui";
import { SubmissionDetails } from "./SubmissionDetails";
import { mailtoHref, submissionDetails } from "./submissions";

export type Write = (action: () => Promise<IssueRecord>) => Promise<boolean>;

export function PipelineView({
  api,
  configuration,
  version,
  search,
  selected,
  onSelect,
  creating,
  onCreating,
  busy,
  write,
  onError,
  onOpenIssue,
  focusNextAction,
}: {
  api: KanbusClient;
  configuration: Configuration;
  version: number;
  search: string;
  selected: IssueRecord | null;
  onSelect: (record: IssueRecord | null) => void;
  creating: boolean;
  onCreating: (creating: boolean) => void;
  busy: boolean;
  write: Write;
  onError: (message: string) => void;
  onOpenIssue: (issueId: string) => void;
  focusNextAction: boolean;
}) {
  const [records, setRecords] = useState<IssueRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [owner, setOwner] = useState<"everyone" | "mine">("everyone");
  const [interest, setInterest] = useState("");
  const [layout, setLayout] = useState<"board" | "list">("board");
  const requestSequence = useRef(0);

  const query = useMemo<Query>(
    () => ({
      type: "prospect",
      search,
      limit: 100,
      ...(owner === "mine" ? { assignee: configuration.actor_id } : {}),
    }),
    [search, owner, configuration.actor_id],
  );

  const refresh = useCallback(
    async (next?: string) => {
      const sequence = ++requestSequence.current;
      try {
        const result = await api.issues({ ...query, ...(next ? { cursor: next } : {}) });
        if (requestSequence.current !== sequence) return;
        setRecords((previous) => (next ? [...previous, ...result.issues] : result.issues));
        setCursor(result.next_cursor);
        setLoaded(true);
      } catch (cause) {
        if (requestSequence.current === sequence) onError((cause as Error).message);
      }
    },
    [api, query, onError],
  );
  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  // A saved record replaces the listed copy at once, even while the shared catalog catches up.
  const visible = useMemo(() => {
    const merged =
      selected && records.some((record) => record.issue.id === selected.issue.id)
        ? records.map((record) => (record.issue.id === selected.issue.id ? selected : record))
        : records;
    return interest ? merged.filter((record) => prospectInterests(record.issue).includes(interest)) : merged;
  }, [records, selected, interest]);
  const owners = useMemo(
    () =>
      [...new Set([configuration.actor_id, ...records.map((record) => record.issue.assignee ?? "")])].filter(
        Boolean,
      ),
    [records, configuration.actor_id],
  );

  return (
    <main className="one-main wide" aria-label="Pipeline">
      <div className="one-pagehead">
        <div>
          <Eyebrow>•••••• Sell / Pipeline</Eyebrow>
          <h1>Pipeline</h1>
        </div>
        <div className="one-toolbar">
          <div className="one-segmented" role="group" aria-label="Whose prospects">
            {(
              [
                ["everyone", "Everyone"],
                ["mine", "Mine"],
              ] as const
            ).map(([key, label]) => (
              <button key={key} type="button" aria-pressed={owner === key} onClick={() => setOwner(key)}>
                {label}
              </button>
            ))}
          </div>
          <label className="one-inline-label">
            Interested in
            <select value={interest} onChange={(event) => setInterest(event.target.value)}>
              <option value="">Any app</option>
              {ANTHUS_APPS.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name}
                </option>
              ))}
            </select>
          </label>
          <div className="one-segmented" role="group" aria-label="Layout">
            {(["board", "list"] as const).map((key) => (
              <button key={key} type="button" aria-pressed={layout === key} onClick={() => setLayout(key)}>
                {key === "board" ? "Board" : "List"}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="one-pipeline">
        <section className="one-board" aria-label="Prospect board">
          {loaded ? (
            <IssueCollection
              issues={visible.map((record) => record.issue)}
              config={configuration}
              query={query}
              view={layout}
              selectedIssueId={selected?.issue.id}
              onSelectIssue={(issue: KanbanIssue) => {
                onSelect(visible.find((record) => record.issue.id === issue.id) ?? null);
                onCreating(false);
              }}
              initialScroll="start"
              detailOpen={Boolean(selected || creating)}
              columnStateKey={`prospectus:anthus:${configuration.actor_id}:pipeline`}
              emptyMessage="No prospects match this view."
            />
          ) : (
            <p role="status">Loading workspace…</p>
          )}
          {cursor && (
            <button type="button" className="one-button one-loadmore" onClick={() => void refresh(cursor)}>
              Load more
            </button>
          )}
        </section>
        {creating && (
          <NewProspect
            configuration={configuration}
            owners={owners}
            busy={busy}
            write={write}
            api={api}
            onError={onError}
            onClose={() => onCreating(false)}
          />
        )}
        {selected && !creating && (
          <ProspectDrawer
            key={`${selected.issue.id}-${selected.revision}`}
            record={selected}
            configuration={configuration}
            owners={owners}
            busy={busy}
            write={write}
            api={api}
            onError={onError}
            onClose={() => onSelect(null)}
            onOpenIssue={onOpenIssue}
            focusNextAction={focusNextAction}
          />
        )}
      </div>
    </main>
  );
}

function InterestPicker({ selected }: { selected: string[] }) {
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
            <span className="one-swatch" style={{ background: app.swatch }} aria-hidden="true" />
            {app.name}
          </label>
        ))}
      </span>
    </fieldset>
  );
}

function OwnerField({ owners, value }: { owners: string[]; value?: string }) {
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

function NewProspect({
  configuration,
  owners,
  busy,
  write,
  api,
  onError,
  onClose,
}: {
  configuration: Configuration;
  owners: string[];
  busy: boolean;
  write: Write;
  api: KanbusClient;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  const initialName =
    configuration.statuses.find((status) => status.key === configuration.initial_status)?.name ?? "New";
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const custom = { ...contactChanges(fields), ...interestChanges(fields) };
    const problem = validateFollowUp(
      configuration.initial_status,
      String(fields.get("assignee")),
      custom.next_action,
      custom.next_follow_up_at ?? "",
      configuration,
    );
    if (problem) return onError(problem);
    void write(() =>
      api.create({
        title: String(fields.get("title")),
        type: "prospect",
        assignee: String(fields.get("assignee")).trim(),
        description: String(fields.get("description")),
        custom,
      }),
    );
  }
  return (
    <aside className="one-drawer" aria-label="New prospect">
      <div className="one-drawer-panel">
        <div className="one-drawer-head">
          <h2>New prospect</h2>
          <button type="button" className="one-button small" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <form className="one-drawer-body" onSubmit={create}>
          <fieldset disabled={busy}>
            <label>
              Company
              <input name="company" placeholder="Company name" maxLength={150} />
            </label>
            <div className="one-pair">
              <label>
                Contact name
                <input name="title" placeholder="Full name" required maxLength={250} />
              </label>
              <label>
                Email
                <input name="email" type="email" placeholder="name@company.com" maxLength={254} />
              </label>
            </div>
            <InterestPicker selected={[]} />
            <div className="one-pair">
              <OwnerField owners={owners} value={configuration.actor_id} />
              <label>
                Follow up on
                <input name="followup" type="date" defaultValue={addDays(localDate(), 1)} required />
              </label>
            </div>
            <label>
              Next action
              <input
                name="next_action"
                defaultValue="Reply and book an intro call"
                required
                maxLength={250}
              />
            </label>
            <label>
              First note
              <textarea name="description" rows={3} placeholder="What they asked for, in their words" />
            </label>
            <button className="one-button primary tall" disabled={busy}>
              {busy ? "Saving…" : `Add to ${initialName}`}
            </button>
          </fieldset>
        </form>
      </div>
    </aside>
  );
}

interface TimelineEntry {
  key: string;
  at: string;
  who: string;
  text: string;
  kind: "inquiry" | "note" | "first";
}

function timeline(record: IssueRecord): TimelineEntry[] {
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

function when(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function ProspectDrawer({
  record,
  configuration,
  owners,
  busy,
  write,
  api,
  onError,
  onClose,
  onOpenIssue,
  focusNextAction,
}: {
  record: IssueRecord;
  configuration: Configuration;
  owners: string[];
  busy: boolean;
  write: Write;
  api: KanbusClient;
  onError: (message: string) => void;
  onClose: () => void;
  onOpenIssue: (issueId: string) => void;
  focusNextAction: boolean;
}) {
  const issue = record.issue;
  const submission = submissionDetails(issue);
  const [linkCopied, setLinkCopied] = useState(false);
  const custom = issue.custom ?? {};
  const nextAction = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusNextAction) nextAction.current?.focus();
  }, [focusNextAction]);
  const workflow = configuration.workflows?.prospect ?? configuration.workflows?.default ?? {};
  const allowed = new Set([issue.status, ...(workflow[issue.status] ?? [])]);
  const order = configuration.statuses.map((status) => status.key);
  const currentIndex = order.indexOf(issue.status);
  const lostKey = configuration.statuses.find((status) => status.semantic_category === "done")?.key;
  const forward = (workflow[issue.status] ?? []).find(
    (key) => key !== lostKey && order.indexOf(key) > currentIndex,
  );
  const labels = (
    configuration as { transition_labels?: Record<string, Record<string, Record<string, string>>> }
  ).transition_labels;
  const transitionLabel = (target: string) =>
    labels?.prospect?.[issue.status]?.[target] ??
    labels?.default?.[issue.status]?.[target] ??
    `Move to ${configuration.statuses.find((status) => status.key === target)?.name ?? target}`;
  const inquiries = websiteInquiries(issue);
  const source = inquiries.length
    ? "From " +
      String(
        ((inquiries[0].source as Record<string, unknown> | undefined) ?? {}).site_id ?? "a website inquiry",
      )
    : "Added in Prospectus";
  const company = String(custom.company ?? "");
  const email = String(custom.contact_email ?? "");
  const shownEmail = submission.contactEmail;
  const shownEmailHref = mailtoHref(shownEmail);

  function copyLink() {
    const link = issueUrl(issue.id, window.location.origin);
    navigator.clipboard.writeText(link).then(
      () => setLinkCopied(true),
      () => onError(`Copy this link: ${link}`),
    );
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const fields = new FormData(event.currentTarget);
    const status = submitter?.name === "transition" ? submitter.value : String(fields.get("status"));
    const changes = { ...contactChanges(fields, issue), ...interestChanges(fields) };
    const problem = validateFollowUp(
      status,
      String(fields.get("assignee")),
      changes.next_action,
      changes.next_follow_up_at ?? "",
      configuration,
    );
    if (problem) return onError(problem);
    void write(() =>
      api.update(issue.id, record.revision, {
        status,
        assignee: String(fields.get("assignee")).trim(),
        custom: {
          ...changes,
          ...(status === "customer" && issue.status !== "customer" && !custom.converted_at
            ? { converted_at: new Date().toISOString() }
            : {}),
        },
      }),
    );
  }

  function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const text = String(new FormData(form).get("note"));
    void write(() => api.comment(issue.id, record.revision, text)).then((saved) => {
      if (saved) form.reset();
    });
  }

  return (
    <aside className="one-drawer" aria-label="Prospect details">
      <IssueDetailPanel
        issue={{ ...issue, title: company || issue.title, description: undefined }}
        onClose={onClose}
        className="prospect-panel"
      >
        <div className="one-drawer-body">
          <p className="one-contact">
            <span className="one-muted one-mono">{source}</span>
            <br />
            {issue.title}
            {shownEmail && (
              <>
                {" · "}
                {shownEmailHref ? <a href={shownEmailHref}>{shownEmail}</a> : shownEmail}
              </>
            )}
          </p>
          <div className="one-linkbar">
            <button type="button" className="one-button small" onClick={copyLink}>
              Copy link
            </button>
            <span role="status" className="one-muted">
              {linkCopied ? "Link copied" : ""}
            </span>
          </div>
          <SubmissionDetails details={submission} onOpenIssue={onOpenIssue} />
          <form id={`prospect-${issue.id}`} onSubmit={save}>
            <fieldset disabled={busy}>
              <fieldset className="one-stagebar-wrap">
                <legend className="one-field-label">Stage</legend>
                <div className="one-stagebar">
                  {configuration.statuses.map((status, index) => (
                    <label
                      key={status.key}
                      title={status.name}
                      className={
                        status.key === lostKey && issue.status === lostKey
                          ? "lost"
                          : issue.status !== lostKey && index <= currentIndex
                            ? "reached"
                            : ""
                      }
                    >
                      <input
                        type="radio"
                        name="status"
                        value={status.key}
                        defaultChecked={status.key === issue.status}
                        disabled={!allowed.has(status.key)}
                      />
                      <span aria-hidden="true" />
                      <span>{status.name}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="one-pair">
                <OwnerField owners={owners} value={issue.assignee} />
                <label>
                  Follow up on
                  <input name="followup" type="date" defaultValue={String(custom.next_follow_up_at ?? "")} />
                </label>
              </div>
              <label>
                Next action
                <input
                  ref={nextAction}
                  name="next_action"
                  defaultValue={String(custom.next_action ?? "")}
                  maxLength={250}
                />
              </label>
              <InterestPicker selected={prospectInterests(issue)} />
              <details>
                <summary className="one-field-label">Contact details</summary>
                <div className="one-pair" style={{ marginTop: 12 }}>
                  <label>
                    Company
                    <input name="company" defaultValue={company} maxLength={150} />
                  </label>
                  <label>
                    Email
                    <input name="email" type="email" defaultValue={email} maxLength={254} />
                  </label>
                </div>
              </details>
              <button className="one-button tall" disabled={busy}>
                Save changes
              </button>
            </fieldset>
          </form>
          <section aria-label="Conversation">
            <span className="one-field-label">Conversation</span>
            <ol className="one-timeline" style={{ marginTop: 8 }}>
              {timeline(record).map((entry) => (
                <li key={entry.key}>
                  <span className={`dot ${entry.kind}`} aria-hidden="true" />
                  <span>
                    <span className="when">
                      {when(entry.at)} · {entry.who}
                    </span>
                    <br />
                    <span className="text">{entry.text}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
          <form onSubmit={addNote}>
            <label>
              Add a note
              <textarea name="note" rows={2} required placeholder="Call notes, an email you sent…" />
            </label>
            <button className="one-button" disabled={busy}>
              Add note
            </button>
          </form>
          {isActiveStage(issue.status, configuration) && (
            <div className="one-drawer-actions">
              {forward && (
                <button
                  className="one-button primary tall"
                  form={`prospect-${issue.id}`}
                  name="transition"
                  value={forward}
                  disabled={busy}
                >
                  {transitionLabel(forward)}
                </button>
              )}
              {lostKey && allowed.has(lostKey) && (
                <button
                  className="one-button tall"
                  form={`prospect-${issue.id}`}
                  name="transition"
                  value={lostKey}
                  disabled={busy}
                >
                  Mark lost
                </button>
              )}
            </div>
          )}
        </div>
      </IssueDetailPanel>
    </aside>
  );
}
