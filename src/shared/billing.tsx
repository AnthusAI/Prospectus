import { useId, useState, type ReactNode } from "react";
import { useBilling } from "../admin/BillingProvider";
import { describeEvent, eventTone, shortDate, STATUS_LABEL } from "../billing/derive";
import { moneyProblem, parseCents, type MoneyParse } from "../billing/money";
import type { Invoice, JournalEvent } from "../billing/types";
import { Eyebrow, Icon, Unavailable } from "./ui";

/** A real link that opens inside the console without a page load, and in a new tab when asked. */
export function BillingLink({
  href,
  children,
  className,
  ...rest
}: {
  href: string;
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  const { go } = useBilling();
  return (
    <a
      {...rest}
      href={href}
      className={className}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        go(href);
      }}
    >
      {children}
    </a>
  );
}

export function Breadcrumb({
  trail,
  current,
}: {
  trail: Array<{ label: string; href: string }>;
  current: string;
}) {
  return (
    <nav className="one-breadcrumb" aria-label="Breadcrumb">
      {trail.map((step) => (
        <span key={step.href} className="one-crumb">
          <BillingLink href={step.href}>{step.label}</BillingLink>
          <span aria-hidden="true">/</span>
        </span>
      ))}
      <span aria-current="page">{current}</span>
    </nav>
  );
}

/** What every billing page says while the billing routes are not deployed. It shows no amounts and offers no action. */
export function BillingUnavailable({ label, group = "Serve" }: { label: string; group?: string }) {
  return (
    <main className="one-main narrow" aria-label={label}>
      <div className="one-pagehead">
        <div>
          <Eyebrow>
            •••••• {group} / {label}
          </Eyebrow>
          <h1>{label}</h1>
        </div>
      </div>
      <Unavailable title="Not yet available">
        <span>
          Invoices, payments and balances will appear here once Anthus One records billing. Nothing is shown
          until then, and nothing can be changed here.
        </span>
      </Unavailable>
    </main>
  );
}

const EDGE: Record<string, string> = { good: "good", info: "info", alert: "alert", quiet: "quiet" };

export function Timeline({
  events,
  empty = "Nothing has happened yet.",
}: {
  events: JournalEvent[];
  empty?: string;
}) {
  if (events.length === 0) return <p className="one-empty">{empty}</p>;
  return (
    <ol className="one-timeline">
      {events.map((event) => (
        <li key={event.id}>
          <span className={`dot billing-${EDGE[eventTone(event)]}`} aria-hidden="true" />
          <span>
            <span className="when">
              {shortDate(event.at.slice(0, 10))} · {event.actor}
            </span>
            <span className="text">{describeEvent(event)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function StatusBadge({ invoice, late }: { invoice: Invoice; late?: boolean }) {
  const tone = late
    ? "late"
    : invoice.status === "partially_paid"
      ? "partial"
      : invoice.status === "paid"
        ? "paid"
        : ["void", "uncollectible"].includes(invoice.status)
          ? "closed"
          : "";
  return <span className={`billing-status ${tone}`}>{STATUS_LABEL[invoice.status]}</span>;
}

/** An amount field. The digits typed become integer cents; anything else is named, never rounded. */
export function MoneyField({
  label,
  value,
  onChange,
  parse = parseCents(value),
  error,
  describedBy,
  hideLabel = false,
  placeholder,
  readOnly,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  parse?: MoneyParse;
  error?: string;
  describedBy?: string;
  hideLabel?: boolean;
  placeholder?: string;
  readOnly?: boolean;
}) {
  const id = useId();
  const problem = error ?? (value.trim() === "" ? "" : moneyProblem(parse));
  return (
    <label className="billing-field">
      <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-error` : describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem && !hideLabel && (
        <span id={`${id}-error`} role="alert" className="billing-error">
          {problem}
        </span>
      )}
    </label>
  );
}

/** A confirmation with a required reason, for write-off, void and reverse. */
export function ReasonPanel({
  title,
  body,
  confirm,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirm: string;
  busy: boolean;
  error: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const headingId = useId();
  return (
    <section className="one-card hot billing-reason" aria-labelledby={headingId}>
      <h2 id={headingId} className="small">
        {title}
      </h2>
      <p>{body}</p>
      <label>
        Reason
        <input
          type="text"
          value={reason}
          placeholder="Why"
          autoFocus
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="one-alert">
          {error}
        </p>
      )}
      <div className="one-toolbar">
        <button
          type="button"
          className="one-button primary"
          disabled={busy || reason.trim() === ""}
          onClick={() => onConfirm(reason.trim())}
        >
          {confirm}
        </button>
        <button type="button" className="one-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

export function ReadOnlyNote({ what }: { what: string }) {
  return (
    <p role="status" className="one-status">
      {what} needs the billing permission. You can view this page.
    </p>
  );
}

/** Downloads the invoice PDF the server renders. The file is only held long enough to save it. */
export function PdfButton({
  reference,
  label,
  primary = false,
  iconOnly = false,
}: {
  reference: string;
  label: string;
  primary?: boolean;
  iconOnly?: boolean;
}) {
  const { client } = useBilling();
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  async function download() {
    setState("busy");
    try {
      const file = await client.invoicePdf(reference);
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = `invoice-${reference}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
      setState("idle");
    } catch {
      setState("failed");
    }
  }
  return (
    <>
      <button
        type="button"
        className={`one-button${primary ? " primary" : " small"}`}
        disabled={state === "busy"}
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : undefined}
        onClick={() => void download()}
      >
        <Icon name="download" size={14} />
        {iconOnly ? <span className="sr-only">{label}</span> : label}
      </button>
      {state === "failed" && (
        <span role="alert" className="billing-error">
          The PDF could not be downloaded. Try again.
        </span>
      )}
    </>
  );
}
