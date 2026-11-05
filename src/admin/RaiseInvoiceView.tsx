import { useEffect, useMemo, useRef, useState } from "react";
import { operationId } from "../operation-id";
import { existingForPeriod, longDate, periodChoices, periodLabel } from "../billing/derive";
import { centsToInput, formatCents, moneyProblem, parseCents } from "../billing/money";
import { billingHref } from "../billing/routes";
import type { Invoice, InvoiceLineItem } from "../billing/types";
import { addDays } from "../prospect";
import {
  BillingLink,
  BillingUnavailable,
  Breadcrumb,
  MoneyField,
  PdfButton,
  ReadOnlyNote,
} from "../shared/billing";
import { Eyebrow, Icon } from "../shared/ui";
import { useBilling, useBillingLoad } from "./BillingProvider";

interface Draft {
  key: number;
  description: string;
  dates: string;
  quantity: string;
  unit: string;
  product?: string;
}

const TERMS = [15, 30, 45, 60];

/** Raise an invoice for a billing period, or for anything else. */
export function RaiseInvoiceView() {
  const { available, canAct, overview, client, today, refresh, go } = useBilling();
  const [accountId, setAccountId] = useState(
    () => new URLSearchParams(window.location.search).get("account") ?? "",
  );
  const [kind, setKind] = useState<"period" | "other">("period");
  const [period, setPeriod] = useState(
    () => periodChoices(today || new Date().toISOString().slice(0, 10))[0],
  );
  const [terms, setTerms] = useState<number | null>(null);
  const [via, setVia] = useState<"manual" | "stripe">("manual");
  // An invoice already sent outside Prospectus: recorded with the number and issue date it went out with.
  const [sent, setSent] = useState(false);
  const [sentNumber, setSentNumber] = useState("");
  const [sentDate, setSentDate] = useState("");
  const [lines, setLines] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [result, setResult] = useState<Invoice | null>(null);
  const serial = useRef(0);
  const attempt = useRef(operationId());
  const account = useBillingLoad(
    () => (accountId ? client.account(accountId) : Promise.resolve(null)),
    [accountId, client],
  );
  const issuer = useBillingLoad(() => client.issuer(), [client]);
  const choices = periodChoices(today || new Date().toISOString().slice(0, 10));

  const periodLines = useMemo(
    () =>
      (account.data?.lines ?? [])
        .filter((line) => line.status === "active")
        .map(
          (line): Draft => ({
            key: 0,
            description: line.name,
            dates: periodLabel(period),
            quantity: "1",
            unit: line.unitAmountCents === undefined ? "" : centsToInput(line.unitAmountCents),
            product: line.product,
          }),
        ),
    [account.data, period],
  );
  // Choosing the kind, the period or the account refills the lines from what the account is billed for.
  useEffect(() => {
    setLines(kind === "period" ? periodLines.map((line) => ({ ...line, key: ++serial.current })) : []);
  }, [kind, periodLines]);

  if (!available) return <BillingUnavailable label="Raise an invoice" />;
  if (overview.status !== "ready")
    return (
      <main className="one-main narrow" aria-label="Raise an invoice">
        <p role="status">{overview.status === "error" ? overview.message : "Loading billing…"}</p>
      </main>
    );
  const accounts = overview.data.accounts.filter((item) => item.mode === "invoiced");
  const selected = accounts.find((item) => item.id === accountId);
  const trail = [{ label: "Usage and billing", href: "/billing" }];
  if (!canAct)
    return (
      <main className="one-main narrow" aria-label="Raise an invoice">
        <Breadcrumb trail={trail} current="Raise an invoice" />
        <div className="one-pagehead">
          <div>
            <h1>Raise an invoice</h1>
          </div>
        </div>
        <ReadOnlyNote what="Raising an invoice" />
      </main>
    );

  const settings = issuer.data;
  const termDays = terms ?? account.data?.profile?.netTermsDays ?? settings?.defaultNetTermsDays ?? 30;
  const termChoices = TERMS.includes(termDays) ? TERMS : [...TERMS, termDays].sort((a, b) => a - b);
  const stripeConnected = settings?.stripe.connected === true;
  const existing =
    selected && kind === "period"
      ? existingForPeriod(selected.id, period, overview.data.invoices)
      : undefined;

  let total = 0;
  let invalid = false;
  const checked = lines.map((line) => {
    const unit = parseCents(line.unit);
    const quantityOk = /^[1-9]\d{0,5}$/.test(line.quantity.trim());
    let error = "";
    if (line.description.trim() === "") error = "Describe this line.";
    else if (!unit.ok)
      error = unit.reason === "empty" ? "Enter the unit price in dollars and cents." : moneyProblem(unit);
    else if (!quantityOk) error = "Quantity is a whole number of at least 1.";
    if (error) invalid = true;
    const amount = unit.ok && quantityOk ? unit.cents * Number(line.quantity) : 0;
    total += amount;
    return { line, unit, amount, error };
  });
  const sentProblem = !sent
    ? ""
    : !/^\d{6}-\d{3}$/.test(sentNumber.trim())
      ? "Enter the number it was sent with, such as 202610-001."
      : !/^\d{4}-\d{2}-\d{2}$/.test(sentDate)
        ? "Enter the date it was issued."
        : sentNumber.slice(0, 6) !== sentDate.slice(0, 4) + sentDate.slice(5, 7)
          ? "The number's year and month must match the issue date."
          : "";
  const blocked =
    busy ||
    !selected ||
    lines.length === 0 ||
    invalid ||
    total === 0 ||
    Boolean(existing) ||
    Boolean(sentProblem);
  const due = addDays(sent && sentDate ? sentDate : today, termDays);
  const change = (key: number, patch: Partial<Draft>) =>
    setLines((previous) => previous.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  async function submit(draft: boolean) {
    setBusy(true);
    setProblem("");
    const lineItems: InvoiceLineItem[] = checked.map(({ line, unit }) => ({
      description: line.description.trim(),
      quantity: Number(line.quantity),
      unitAmountCents: unit.ok ? unit.cents : 0,
      period: line.dates.trim() || undefined,
      product: line.product,
    }));
    try {
      const invoice = await client.raiseInvoice({
        operationId: attempt.current,
        accountId,
        period: kind === "period" ? period : undefined,
        lineItems,
        netTermsDays: termDays,
        issuedVia: sent ? "manual" : via,
        draft: sent ? false : draft,
        ...(sent ? { alreadySent: { number: sentNumber.trim(), issueDate: sentDate } } : {}),
      });
      setResult(invoice);
      refresh();
    } catch (cause) {
      setProblem((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="one-main narrow" aria-label="Raise an invoice">
      <Breadcrumb
        trail={
          selected
            ? [...trail, { label: selected.name, href: billingHref.accountBilling(selected.id) }]
            : trail
        }
        current="Raise an invoice"
      />
      <div className="one-pagehead">
        <div>
          <h1>Raise an invoice</h1>
        </div>
      </div>
      {result && (
        <section role="status" className="one-card hot billing-saved">
          <h2 className="small">{result.number ? `${result.number} issued` : "Draft saved"}</h2>
          <span>
            {formatCents(result.totalCents)} to {selected?.name}
            {result.dueAt ? `, due ${longDate(result.dueAt)}` : ""}.{" "}
            {result.number
              ? result.issuedVia === "stripe"
                ? "Stripe has emailed the client a payment page."
                : sent
                  ? "It is recorded as already sent."
                  : "Download the PDF and send it to the client."
              : "It has no number yet and has not been sent."}
          </span>
          <div className="one-toolbar">
            {result.number && <PdfButton reference={result.number} label="Download PDF" primary />}
            <BillingLink href={billingHref.invoice(result.number ?? result.id)}>Open invoice</BillingLink>
          </div>
        </section>
      )}
      {!result && (
        <div className="one-columns">
          <div className="primary">
            <section className="one-card strong" aria-labelledby="who-heading">
              <h2 id="who-heading" className="small">
                Who and what for
              </h2>
              <div className="billing-form-grid">
                <label>
                  Account
                  <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                    <option value="">Choose an account</option>
                    {accounts.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Kind of invoice
                  <select
                    value={kind}
                    onChange={(event) => setKind(event.target.value as "period" | "other")}
                  >
                    <option value="period">A billing period</option>
                    <option value="other">Anything else</option>
                  </select>
                </label>
                {kind === "period" && (
                  <label>
                    Period
                    <select
                      value={period}
                      onChange={(event) => setPeriod(event.target.value)}
                      aria-invalid={existing ? true : undefined}
                    >
                      {choices.map((choice) => (
                        <option key={choice} value={choice}>
                          {periodLabel(choice)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {existing && (
                <p role="alert" className="billing-error">
                  <BillingLink href={billingHref.invoice(existing.number!)}>{existing.number}</BillingLink>{" "}
                  already bills {periodLabel(period)}. Each client gets one invoice per period. Choose
                  &ldquo;Anything else&rdquo; for an extra charge.
                </p>
              )}
              {kind === "other" && (
                <p className="one-muted">For one-off work, a setup package, a retainer or a correction.</p>
              )}
            </section>

            {selected && (
              <section className="one-card strong" aria-labelledby="lines-heading">
                <div className="one-section-head">
                  <h2 id="lines-heading" className="small">
                    Lines
                  </h2>
                </div>
                {checked.map(({ line, amount, error }) => (
                  <div className="billing-draft-line" key={line.key}>
                    <div className="billing-form-grid">
                      <label>
                        Description
                        <input
                          type="text"
                          value={line.description}
                          onChange={(event) => change(line.key, { description: event.target.value })}
                        />
                      </label>
                      <label>
                        Service dates
                        <input
                          type="text"
                          value={line.dates}
                          placeholder="Optional"
                          onChange={(event) => change(line.key, { dates: event.target.value })}
                        />
                      </label>
                      <label>
                        Qty
                        <input
                          type="text"
                          inputMode="numeric"
                          value={line.quantity}
                          onChange={(event) => change(line.key, { quantity: event.target.value })}
                        />
                      </label>
                      <MoneyField
                        label="Unit price"
                        value={line.unit}
                        onChange={(value) => change(line.key, { unit: value })}
                        error={error.includes("Describe") || error.includes("Quantity") ? "" : error}
                      />
                    </div>
                    <div className="billing-draft-side">
                      <button
                        type="button"
                        className="one-button small"
                        aria-label={`Remove line ${line.description}`}
                        onClick={() =>
                          setLines((previous) => previous.filter((entry) => entry.key !== line.key))
                        }
                      >
                        Remove
                      </button>
                      <span className="billing-amount">{formatCents(amount)}</span>
                    </div>
                    {(error.includes("Describe") || error.includes("Quantity")) && (
                      <p role="alert" className="billing-error">
                        {error}
                      </p>
                    )}
                  </div>
                ))}
                <div>
                  <button
                    type="button"
                    className="one-button small"
                    onClick={() =>
                      setLines((previous) => [
                        ...previous,
                        { key: ++serial.current, description: "", dates: "", quantity: "1", unit: "0.00" },
                      ])
                    }
                  >
                    <Icon name="plus" size={14} />
                    Add a blank line
                  </button>
                </div>
              </section>
            )}
          </div>

          <aside className="secondary">
            <section className="one-card billing-summary" aria-label="Before you issue">
              <Eyebrow>•••• Before you issue</Eyebrow>
              <div>
                <span>Total (USD)</span>
                <b>{formatCents(total)}</b>
              </div>
              <label>
                Terms
                <select value={termDays} onChange={(event) => setTerms(Number(event.target.value))}>
                  {termChoices.map((days) => (
                    <option key={days} value={days}>
                      Net {days}
                    </option>
                  ))}
                </select>
              </label>
              <div>
                <span>Due</span>
                <b>{longDate(due)}</b>
              </div>
              <label className="one-checkline">
                <input type="checkbox" checked={sent} onChange={(event) => setSent(event.target.checked)} />
                Already sent outside Prospectus
              </label>
              {sent && (
                <>
                  <label>
                    Number it was sent with
                    <input
                      type="text"
                      value={sentNumber}
                      placeholder="202610-001"
                      onChange={(event) => setSentNumber(event.target.value)}
                    />
                  </label>
                  <label>
                    Issued
                    <input
                      type="date"
                      value={sentDate}
                      onChange={(event) => setSentDate(event.target.value)}
                    />
                  </label>
                  {sentProblem && (
                    <p role="alert" className="billing-error">
                      {sentProblem}
                    </p>
                  )}
                </>
              )}
              {!sent && (
                <fieldset>
                  <legend>Who sends it</legend>
                  <label className="one-checkline">
                    <input
                      type="radio"
                      name="via"
                      checked={via === "manual"}
                      onChange={() => setVia("manual")}
                    />
                    Anthus, by PDF
                  </label>
                  <label className="one-checkline">
                    <input
                      type="radio"
                      name="via"
                      checked={via === "stripe" && stripeConnected}
                      disabled={!stripeConnected}
                      onChange={() => setVia("stripe")}
                    />
                    {stripeConnected
                      ? "Stripe, with a payment page"
                      : "Stripe, with a payment page (not connected yet)"}
                  </label>
                </fieldset>
              )}
              <div className="one-cellstack">
                <small className="one-eyebrow">Printed on it</small>
                <span>Bill to {selected?.name ?? "the account"}.</span>
                <span>
                  {(settings?.paymentMethods ?? [])
                    .filter((method) => method.offered)
                    .map((method) => method.label)
                    .join(", ") || "No payment method"}{" "}
                  from <BillingLink href={billingHref.settings()}>billing settings</BillingLink>
                </span>
                <span>
                  {sent
                    ? "Recorded with the number it was sent with"
                    : `Number assigned when issued, next is ${settings?.nextInvoiceNumber ?? "—"}`}
                </span>
              </div>
              {problem && (
                <p role="alert" className="one-alert">
                  {problem}
                </p>
              )}
              <button
                type="button"
                className="one-button primary tall"
                disabled={blocked}
                onClick={() => void submit(false)}
              >
                {sent ? `Record ${sentNumber.trim() || "the invoice"}` : `Issue ${formatCents(total)}`}
              </button>
              <span className="one-note">
                An issued invoice can&rsquo;t be edited. Corrections are a credit or a new invoice.
              </span>
              {!sent && (
                <button
                  type="button"
                  className="one-button"
                  disabled={blocked}
                  onClick={() => void submit(true)}
                >
                  Save as draft
                </button>
              )}
              <button
                type="button"
                className="one-button"
                onClick={() => go(selected ? billingHref.accountBilling(selected.id) : "/billing")}
              >
                Cancel
              </button>
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}
