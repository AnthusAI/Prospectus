import type { MouseEvent, ReactNode } from "react";
import { issuePath } from "../deep-links";
import {
  mailtoHref,
  reviewReasonLabel,
  type InquiryDetails,
  type SubmissionDetails as Details,
} from "./submissions";

function EmailValue({ email }: { email: string }) {
  const href = mailtoHref(email);
  return href ? <a href={href}>{email}</a> : <>{email}</>;
}

function Rows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="one-facts">
      {rows
        .filter(([, value]) => value !== "" && value !== null && value !== undefined)
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

function Inquiry({ inquiry }: { inquiry: InquiryDetails }) {
  const campaign = inquiry.campaign.map(([key, value]) => `${key}: ${value}`).join(" · ");
  const attributes = inquiry.attributes.map(([key, value]) => `${key}: ${value}`).join(" · ");
  return (
    <li className="one-inquiry">
      <p className="one-inquiry-head">
        <strong>{inquiry.kindLabel}</strong>
        {inquiry.receivedAtLabel && (
          <>
            {" · "}
            <time dateTime={inquiry.receivedAt}>{inquiry.receivedAtLabel}</time>
          </>
        )}
      </p>
      {inquiry.message && <p className="one-message">{inquiry.message}</p>}
      <Rows
        rows={[
          ["Name", inquiry.name],
          ["Email", inquiry.email && <EmailValue email={inquiry.email} />],
          ["Company", inquiry.company],
          ["Form", inquiry.sourceLabel],
          [
            "Source page",
            inquiry.pagePath &&
              (inquiry.pageHref ? (
                <a href={inquiry.pageHref} target="_blank" rel="noopener noreferrer">
                  {inquiry.pagePath}
                </a>
              ) : (
                inquiry.pagePath
              )),
          ],
          ["Campaign", campaign],
          ["Marketing opt-in", inquiry.marketingOptIn === null ? "" : inquiry.marketingOptIn ? "Yes" : "No"],
          ["Notice version", inquiry.noticeVersion],
          ["Attributes", attributes],
        ]}
      />
    </li>
  );
}

export function SubmissionDetails({
  details,
  onOpenIssue,
}: {
  details: Details;
  onOpenIssue: (issueId: string) => void;
}) {
  const nothingToShow =
    !details.needsReview && !details.inquiries.length && !details.firstSource && !details.latestSource;
  if (nothingToShow) return null;

  function open(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey)
      return;
    event.preventDefault();
    onOpenIssue(details.relatedIssueId);
  }

  return (
    <section aria-label="Submission details" className="one-submission">
      {details.needsReview && (
        <p role="note" className="one-review-banner">
          <strong>
            Needs review{details.reviewReason ? `: ${reviewReasonLabel(details.reviewReason)}` : ""}
          </strong>
          {details.relatedIssueId && (
            <>
              {" · "}
              <a href={issuePath(details.relatedIssueId)} onClick={open}>
                Open related item {details.relatedIssueId}
              </a>
            </>
          )}
        </p>
      )}
      <span className="one-field-label">Submissions</span>
      <Rows
        rows={[
          ["First source", details.firstSource],
          ["Latest source", details.latestSource],
          ["Next action", details.nextAction],
          ["Follow up", details.followUp],
        ]}
      />
      {details.inquiries.length > 0 && (
        <ol className="one-inquiries">
          {details.inquiries.map((inquiry) => (
            <Inquiry key={inquiry.key} inquiry={inquiry} />
          ))}
        </ol>
      )}
    </section>
  );
}
