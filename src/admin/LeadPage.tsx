import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Configuration, IssueRecord, KanbusClient } from "../client";
import { issueUrl, PAGE_PATHS } from "../deep-links";
import {
  contactChanges,
  interestChanges,
  isActiveStage,
  prospectInterests,
  validateFollowUp,
  websiteInquiries,
} from "../prospect";
import { Eyebrow } from "../shared/ui";
import { AppLink } from "./AppLink";
import type { Write } from "./PipelineView";
import { InterestPicker, OwnerField, timeline, when } from "./ProspectFields";
import { SpamReview } from "./SpamReview";
import { SubmissionDetails } from "./SubmissionDetails";
import { mailtoHref, submissionDetails } from "./submissions";

/** What a lead's page shows in place of the lead while it loads or when no such lead exists. */
export function LeadPlaceholder({
  message,
  missing,
  onNavigatePipeline,
}: {
  message: string;
  missing: boolean;
  onNavigatePipeline: () => void;
}) {
  return (
    <main className="one-main narrow lead-page" aria-label="Lead">
      <nav className="one-breadcrumb" aria-label="Breadcrumb">
        <AppLink href={PAGE_PATHS.pipeline} onNavigate={onNavigatePipeline}>
          Pipeline
        </AppLink>
        <span aria-hidden="true">/</span>
        <span>{missing ? "Not found" : "Lead"}</span>
      </nav>
      {missing ? (
        <section className="one-card" aria-label="Not found">
          <h1>Lead not found</h1>
          <p role="alert">{message}</p>
          <p>
            <AppLink href={PAGE_PATHS.pipeline} onNavigate={onNavigatePipeline}>
              Back to the pipeline
            </AppLink>
          </p>
        </section>
      ) : (
        <p role="status">{message}</p>
      )}
    </main>
  );
}

/**
 * One lead as a full page at /pipeline/<id>: its contact and company, every inquiry, the Spam check,
 * ownership, stage, next action and follow-up, notes and history. Every change is one revisioned write, so a
 * competing edit is reported as a conflict and never overwritten.
 */
export function LeadPage({
  record,
  configuration,
  busy,
  write,
  api,
  onError,
  onNavigatePipeline,
  onOpenIssue,
  focusNextAction,
}: {
  record: IssueRecord;
  configuration: Configuration;
  busy: boolean;
  write: Write;
  api: KanbusClient;
  onError: (message: string) => void;
  onNavigatePipeline: () => void;
  onOpenIssue: (issueId: string) => void;
  focusNextAction: boolean;
}) {
  const issue = record.issue;
  const submission = submissionDetails(issue);
  const [linkCopied, setLinkCopied] = useState(false);
  const custom = issue.custom ?? {};
  const nextAction = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // A page opens with focus on its title; finishing a follow-up puts it on the next action instead.
  useEffect(() => {
    (focusNextAction ? nextAction : heading).current?.focus();
  }, [focusNextAction]);
  const owners = [...new Set([configuration.actor_id, issue.assignee ?? ""])].filter(Boolean);
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
  const stageName =
    configuration.statuses.find((status) => status.key === issue.status)?.name ?? issue.status;
  const mine = issue.assignee === configuration.actor_id;

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
    <main className="one-main wide lead-page" aria-label="Lead">
      <nav className="one-breadcrumb" aria-label="Breadcrumb">
        <AppLink href={PAGE_PATHS.pipeline} onNavigate={onNavigatePipeline}>
          Pipeline
        </AppLink>
        <span aria-hidden="true">/</span>
        <span>{company || issue.title}</span>
      </nav>
      <header className="one-pagehead lead-head">
        <div>
          <Eyebrow>•••••• Sell / Pipeline / Lead</Eyebrow>
          <h1 ref={heading} tabIndex={-1}>
            {company || issue.title}
          </h1>
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
        </div>
        <div className="one-toolbar">
          <span className="one-pill">{stageName}</span>
          <code className="one-mono lead-id">{issue.id}</code>
          <button type="button" className="one-button small" onClick={copyLink}>
            Copy link
          </button>
          <span role="status" className="one-muted">
            {linkCopied ? "Link copied" : ""}
          </span>
        </div>
      </header>
      <div className="one-columns lead-columns">
        <div className="primary">
          <SpamReview record={record} configuration={configuration} api={api} busy={busy} write={write} />
          <SubmissionDetails details={submission} onOpenIssue={onOpenIssue} />
          <section aria-label="Conversation" className="one-card">
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
            <form onSubmit={addNote}>
              <label>
                Add a note
                <textarea name="note" rows={2} required placeholder="Call notes, an email you sent…" />
              </label>
              <button className="one-button" disabled={busy}>
                Add note
              </button>
            </form>
          </section>
        </div>
        {/* Further actions and reminders for the lead go here as more sections. */}
        <div className="secondary">
          <section className="one-card" aria-label="Manage lead">
            <span className="one-field-label">Assigned to</span>
            <p className="lead-owner">
              {issue.assignee ? (
                <>
                  <strong>{issue.assignee}</strong>
                  {mine ? " (you)" : ""}
                </>
              ) : (
                <span className="one-muted">Nobody owns this lead yet.</span>
              )}
              {!mine && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="one-button small primary"
                    disabled={busy}
                    aria-label={`Take ${company || issue.title}`}
                    onClick={() =>
                      void write(() =>
                        api.update(issue.id, record.revision, { assignee: configuration.actor_id }),
                      )
                    }
                  >
                    Take it
                  </button>
                </>
              )}
            </p>
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
                    <input
                      name="followup"
                      type="date"
                      defaultValue={String(custom.next_follow_up_at ?? "")}
                    />
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
          </section>
        </div>
      </div>
    </main>
  );
}
