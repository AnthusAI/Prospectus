import type { Configuration, IssueRecord, KanbusClient } from "../client";
import { spamReviewChanges, spamSummary, type SpamReviewLabel } from "../spam-review";
import type { Write } from "./PipelineView";

const ACTIONS: Array<{ label: SpamReviewLabel; text: string }> = [
  { label: "not_spam", text: "Not spam" },
  { label: "spam", text: "Spam" },
  { label: "vendor", text: "Vendor" },
];

const LABEL_TEXT: Record<string, string> = {
  "likely-spam": "Labelled likely spam",
  spam: "Marked spam",
  vendor: "Marked vendor",
};

const REVIEW_TEXT: Record<string, string> = {
  not_spam: "Not spam",
  spam: "Spam",
  vendor: "Vendor",
};

/**
 * The intake spam check for one prospect, with a person's Not spam / Spam / Vendor decision.
 * Each decision is one revisioned update; a revision conflict is shown, never overwritten.
 */
export function SpamReview({
  record,
  configuration,
  api,
  busy,
  write,
}: {
  record: IssueRecord;
  configuration: Configuration;
  api: KanbusClient;
  busy: boolean;
  write: Write;
}) {
  const issue = record.issue;
  const summary = spamSummary(issue);
  if (!summary.verdict && !summary.label && !summary.review) return null;
  const flagged = Boolean(summary.label) || (summary.verdict !== null && summary.verdict !== "clean");
  const decide = (label: SpamReviewLabel) =>
    void write(() => api.update(issue.id, record.revision, spamReviewChanges(issue, label, configuration)));
  const body = (
    <>
      <p className="one-spam-head">
        <span className={`one-spam-badge ${summary.verdict ?? "unscored"}`}>{summary.verdictText}</span>
        {summary.score !== null && <span className="one-mono"> score {summary.score.toFixed(2)}</span>}
        {summary.label && <span className="one-muted"> · {LABEL_TEXT[summary.label]}</span>}
      </p>
      {summary.reasons.length > 0 && (
        <ul className="one-spam-reasons" aria-label="Spam reasons">
          {summary.reasons.map((reason) => (
            <li key={reason.code}>{reason.text}</li>
          ))}
        </ul>
      )}
      {summary.hints.map((hint) => (
        <p key={hint.code} className="one-muted">
          Hint: {hint.text}. Use Vendor if this is someone selling services.
        </p>
      ))}
      {summary.protected && (
        <p className="one-muted">Not labelled: the visitor wrote a real note of 40 or more letters.</p>
      )}
      <p className="one-muted one-mono">
        {summary.rulesVersion ?? "No rules version"}
        {summary.mode === "shadow" ? " · shadow mode (scored only, no label applied)" : ""}
      </p>
      {summary.review && (
        <p className="one-muted">
          Reviewed as {REVIEW_TEXT[summary.review.label] ?? summary.review.label} by {summary.review.reviewer}
        </p>
      )}
      <div className="one-spam-actions" role="group" aria-label="Spam decision">
        {ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            className="one-button small"
            disabled={busy || summary.review?.label === action.label}
            onClick={() => decide(action.label)}
          >
            {action.text}
          </button>
        ))}
      </div>
    </>
  );
  return flagged ? (
    <section className="one-spam flagged" aria-label="Spam check">
      <span className="one-field-label">Spam check</span>
      {body}
    </section>
  ) : (
    <details className="one-spam" aria-label="Spam check">
      <summary className="one-field-label">Spam check: {summary.verdictText}</summary>
      {body}
    </details>
  );
}
