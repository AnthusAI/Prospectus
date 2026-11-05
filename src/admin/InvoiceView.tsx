import { useState } from "react";
import { operationId } from "../operation-id";
import { daysPastDue, isOpen, isPastDue, ledgerRows, longDate, shortDate } from "../billing/derive";
import { formatCents } from "../billing/money";
import { billingHref } from "../billing/routes";
import {
  BillingLink,
  BillingUnavailable,
  Breadcrumb,
  PdfButton,
  ReasonPanel,
  StatusBadge,
  Timeline,
} from "../shared/billing";
import { Eyebrow, Icon } from "../shared/ui";
import { useBilling, useBillingLoad } from "./BillingProvider";

/** One invoice: where its balance came from, the document as it was sent, and the history. */
export function InvoiceView({ reference }: { reference: string }) {
  const { available, client, canAct, today, go, refresh } = useBilling();
  const loaded = useBillingLoad(() => client.invoice(reference), [reference, client]);
  const [panel, setPanel] = useState<"writeoff" | "void" | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  if (!available) return <BillingUnavailable label="Invoice" />;
  if (loaded.loading)
    return (
      <main className="one-main narrow" aria-label="Invoice">
        <p role="status">Loading invoice…</p>
      </main>
    );
  if (loaded.error || !loaded.data)
    return (
      <main className="one-main narrow" aria-label="Invoice">
        <Breadcrumb trail={[{ label: "Usage and billing", href: "/billing" }]} current="Invoice" />
        <p role="alert" className="one-alert">
          {loaded.error || "That invoice was not found."}
        </p>
      </main>
    );
  const { invoice, account, journal, payments } = loaded.data;
  const late = isPastDue(invoice, today);
  const days = daysPastDue(invoice, today);
  const hasPayments = payments.some((payment) =>
    payment.allocations.some((entry) => entry.invoiceId === invoice.id),
  );
  const paid = invoice.totalCents - invoice.balanceCents - invoice.creditsCents;
  const rows = ledgerRows(invoice, journal, payments);
  const closed = invoice.status === "void" || invoice.status === "uncollectible";
  async function act(kind: "writeoff" | "void", reason: string) {
    setBusy(true);
    setProblem("");
    try {
      const input = { operationId: operationId(), reason, expectedRevision: invoice.revision };
      await (kind === "writeoff"
        ? client.writeOff(invoice.id, input)
        : client.voidInvoice(invoice.id, input));
      setPanel(null);
      loaded.reload();
      refresh();
    } catch (cause) {
      setProblem((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title = invoice.number ?? "Draft invoice";
  return (
    <main className="one-main narrow" aria-label="Invoice">
      <Breadcrumb
        trail={[
          { label: "Usage and billing", href: "/billing" },
          { label: account.name, href: billingHref.accountBilling(account.id) },
        ]}
        current={title}
      />
      <section className="one-card strong billing-invoice-head">
        <div className="one-badges">
          <StatusBadge invoice={invoice} late={late} />
          {late && (
            <span className="billing-status late">
              {days} {days === 1 ? "day" : "days"} past due
            </span>
          )}
          <span className="one-badge">Sent by {invoice.issuedVia === "stripe" ? "Stripe" : "Anthus"}</span>
        </div>
        <h1>{title}</h1>
        <span className="one-account-meta">
          <BillingLink href={billingHref.accountBilling(account.id)}>{account.name}</BillingLink>
          {invoice.issuedAt && ` · Issued ${longDate(invoice.issuedAt)}`}
          {invoice.dueAt && ` · Due ${longDate(invoice.dueAt)} · Net ${invoice.netTermsDays}`}
        </span>
        <div className="one-toolbar">
          <PdfButton reference={invoice.number ?? invoice.id} label="Download PDF" primary />
          {canAct && isOpen(invoice) && (
            <button
              type="button"
              className="one-button"
              onClick={() => go(billingHref.newPayment(account.id))}
            >
              Record a payment
            </button>
          )}
          {canAct && isOpen(invoice) && !panel && (
            <button type="button" className="one-button" onClick={() => setPanel("writeoff")}>
              Write off
            </button>
          )}
          {canAct && !closed && invoice.status !== "paid" && (
            <button
              type="button"
              className="one-button"
              disabled={hasPayments}
              aria-describedby={hasPayments ? "void-hint" : undefined}
              onClick={() => setPanel("void")}
            >
              Void
            </button>
          )}
        </div>
        {canAct && hasPayments && !closed && (
          <span id="void-hint" className="one-muted">
            An invoice with payments applied can&rsquo;t be voided.
          </span>
        )}
        <div className="billing-totals" aria-label="Amounts">
          <div>
            <b>{formatCents(invoice.totalCents)}</b>
            <span>TOTAL</span>
          </div>
          <div>
            <b>{formatCents(paid)}</b>
            <span>PAID</span>
          </div>
          <div>
            <b>{formatCents(invoice.creditsCents)}</b>
            <span>CREDITS</span>
          </div>
          <div>
            <b className={late ? "one-warn" : undefined}>{formatCents(invoice.balanceCents)}</b>
            <span>BALANCE</span>
          </div>
        </div>
      </section>

      {canAct && panel === "writeoff" && (
        <ReasonPanel
          title={`Write off the ${formatCents(invoice.balanceCents)} balance?`}
          body="The invoice stays on record as written off, and its history is kept. Access doesn't change."
          confirm={`Write off ${formatCents(invoice.balanceCents)}`}
          busy={busy}
          error={problem}
          onConfirm={(reason) => void act("writeoff", reason)}
          onCancel={() => setPanel(null)}
        />
      )}
      {canAct && panel === "void" && (
        <ReasonPanel
          title="Void this invoice?"
          body="Its balance becomes zero. The number is never reused, and the record stays."
          confirm="Void invoice"
          busy={busy}
          error={problem}
          onConfirm={(reason) => void act("void", reason)}
          onCancel={() => setPanel(null)}
        />
      )}

      <div className="one-columns">
        <div className="primary">
          <section className="one-card strong" aria-labelledby="applied-heading">
            <div className="one-section-head">
              <h2 id="applied-heading" className="small">
                How the balance got here
              </h2>
              <span>Worked out from the records each time</span>
            </div>
            <div className="one-table-wrap" tabIndex={0} role="region" aria-label="Table, scrolls sideways">
              <table className="one-table billing-table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">What happened</th>
                    <th scope="col">By</th>
                    <th scope="col" className="num">
                      Change
                    </th>
                    <th scope="col" className="num">
                      Balance
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={index}>
                      <td className="nowrap">{shortDate(row.when, today)}</td>
                      <td>{row.what}</td>
                      <td className="one-muted">{row.by}</td>
                      <td className="num">{row.change}</td>
                      <td className="num">{formatCents(row.balanceCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="one-card strong" aria-labelledby="document-heading">
            <div className="one-section-head">
              <h2 id="document-heading" className="small">
                The invoice as sent
              </h2>
              <span className="billing-locked">
                <Icon name="lock" size={14} />
                Can&rsquo;t be edited once issued
              </span>
            </div>
            <div className="billing-parties">
              <span>
                <b className="one-eyebrow">FROM</b>
                {invoice.issuer?.legalName ?? "—"}
                {invoice.issuer?.addressLines.map((line) => (
                  <small key={line}>{line}</small>
                ))}
              </span>
              <span>
                <b className="one-eyebrow">BILL TO</b>
                {account.name}
                {invoice.billToContactMasked && <small>Attn: {invoice.billToContactMasked}</small>}
              </span>
              <span>
                <b className="one-eyebrow">HOW TO PAY</b>
                {(invoice.paymentMethods ?? []).map((method) => method.label).join(", ") || "—"}
                <small>Copied here when it was issued</small>
              </span>
            </div>
            <div className="one-table-wrap" tabIndex={0} role="region" aria-label="Table, scrolls sideways">
              <table className="one-table billing-table">
                <thead>
                  <tr>
                    <th scope="col">Description</th>
                    <th scope="col">Period</th>
                    <th scope="col" className="num">
                      Qty
                    </th>
                    <th scope="col" className="num">
                      Unit price
                    </th>
                    <th scope="col" className="num">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.lineItems.map((item, index) => (
                    <tr key={index}>
                      <td>
                        {item.description}
                        {item.product && (
                          <>
                            <br />
                            <small className="one-mono">{item.product}</small>
                          </>
                        )}
                      </td>
                      <td className="nowrap">{item.period ?? "—"}</td>
                      <td className="num">{item.quantity}</td>
                      <td className="num">{formatCents(item.unitAmountCents)}</td>
                      <td className="num">{formatCents(item.quantity * item.unitAmountCents)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={4}>
                      <strong>Total (USD)</strong>
                    </td>
                    <td className="num">
                      <strong>{formatCents(invoice.totalCents)}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="secondary">
          <section className="one-card">
            <Eyebrow>•••• History</Eyebrow>
            <Timeline events={journal} empty="No history yet." />
          </section>
          <section className="one-card">
            <Eyebrow>•••• Record</Eyebrow>
            <dl className="one-dl">
              <dt>Sent by</dt>
              <dd>{invoice.issuedVia === "stripe" ? "Stripe" : "Anthus (manual)"}</dd>
              <dt>Record version</dt>
              <dd>{invoice.revision}</dd>
            </dl>
            <p className="one-note">
              Every change here is logged with who made it. Corrections are new records. Nothing is
              overwritten.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
