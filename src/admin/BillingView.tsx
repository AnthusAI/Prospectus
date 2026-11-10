import { useMemo, useState } from "react";
import {
  aging,
  attention,
  dueLabel,
  isOpen,
  isPastDue,
  METHOD_LABEL,
  owedBy,
  paymentLabel,
  shortDate,
  totals,
} from "../billing/derive";
import { formatCents } from "../billing/money";
import { attentionHref, billingHref } from "../billing/routes";
import type { BillingOverview, Invoice, Payment } from "../billing/types";
import { BillingLink, BillingUnavailable, PdfButton, StatusBadge } from "../shared/billing";
import { Eyebrow, Icon, Stat } from "../shared/ui";
import { useBilling } from "./BillingProvider";

type Tab = "invoices" | "payments" | "accounts";
type Filter = "open" | "late" | "partly" | "paid" | "closed" | "all";

const FILTERS: Array<[Filter, string]> = [
  ["open", "Open"],
  ["late", "Past due"],
  ["partly", "Partly paid"],
  ["paid", "Paid"],
  ["closed", "Void or written off"],
  ["all", "All"],
];

/** Usage and billing: what every client owes, what has come in and what needs a person. */
export function BillingView() {
  const { available, overview, canAct, today } = useBilling();
  if (!available) return <BillingUnavailable label="Usage and billing" />;
  if (overview.status === "loading")
    return (
      <main className="one-main narrow" aria-label="Usage and billing">
        <p role="status">Loading billing…</p>
      </main>
    );
  if (overview.status === "error")
    return (
      <main className="one-main narrow" aria-label="Usage and billing">
        <p role="alert" className="one-alert">
          {overview.message}
        </p>
      </main>
    );
  if (overview.status !== "ready") return null;
  return <BillingPage data={overview.data} canAct={canAct} today={today} />;
}

function BillingPage({ data, canAct, today }: { data: BillingOverview; canAct: boolean; today: string }) {
  const { go } = useBilling();
  const [tab, setTab] = useState<Tab>("invoices");
  const [filter, setFilter] = useState<Filter>("open");
  const issued = useMemo(() => data.invoices.filter((invoice) => invoice.number), [data.invoices]);
  const sum = totals(issued, data.payments, today);
  const age = aging(issued, today);
  const items = attention(data.accounts, issued, data.payments, today, data.engagements);
  const accountName = (id: string) => data.accounts.find((account) => account.id === id)?.name ?? "Account";
  const tests: Record<Filter, (invoice: Invoice) => boolean> = {
    open: isOpen,
    late: (invoice) => isPastDue(invoice, today),
    partly: (invoice) => invoice.status === "partially_paid",
    paid: (invoice) => invoice.status === "paid",
    closed: (invoice) => invoice.status === "void" || invoice.status === "uncollectible",
    all: () => true,
  };
  const rows = issued.filter(tests[filter]).sort((a, b) => (b.number ?? "").localeCompare(a.number ?? ""));
  const payments = [...data.payments].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const accountRows = data.accounts
    .filter((account) => account.billable)
    .map((account) => ({ account, ...owedBy(account.id, issued, data.payments, today) }))
    .sort((a, b) => b.pastDueCents - a.pastDueCents || b.owedCents - a.owedCents);
  const total = age.notDueCents + age.late1to30Cents + age.late31to60Cents + age.lateOver60Cents;
  const share = (cents: number) => (total === 0 ? 0 : (cents / total) * 100);
  return (
    <main className="one-main narrow" aria-label="Usage and billing">
      <div className="one-pagehead">
        <div>
          <Eyebrow>•••••• Serve / Usage and billing</Eyebrow>
          <h1>Usage and billing</h1>
          <p>What every client owes, what has come in, and what needs a person. In US dollars.</p>
        </div>
        {canAct && (
          <div className="one-toolbar">
            <button type="button" className="one-button primary" onClick={() => go(billingHref.newPayment())}>
              <Icon name="plus" size={14} />
              Record a payment
            </button>
            <button type="button" className="one-button" onClick={() => go(billingHref.newInvoice())}>
              Raise an invoice
            </button>
          </div>
        )}
      </div>

      <section className="one-stats" aria-label="Totals">
        <Stat
          value={formatCents(sum.outstandingCents)}
          label="OUTSTANDING"
          note={`${sum.openCount} open ${sum.openCount === 1 ? "invoice" : "invoices"}`}
        />
        <Stat
          value={formatCents(sum.pastDueCents)}
          label="PAST DUE"
          note={`${sum.pastDueCount} ${sum.pastDueCount === 1 ? "invoice" : "invoices"}, ${sum.pastDueAccounts} ${sum.pastDueAccounts === 1 ? "account" : "accounts"}`}
          hot={sum.pastDueCents > 0}
        />
        <Stat
          value={formatCents(sum.collectedCents)}
          label="COLLECTED THIS MONTH"
          note={`${sum.collectedCount} ${sum.collectedCount === 1 ? "payment" : "payments"}`}
        />
        <Stat
          value={formatCents(sum.unappliedCents)}
          label="NOT YET APPLIED"
          note={`${sum.unappliedCount} ${sum.unappliedCount === 1 ? "payment" : "payments"} to allocate`}
        />
      </section>

      <section className="one-card hot" aria-labelledby="attention-heading">
        <div className="one-section-head">
          <h2 id="attention-heading" className="small">
            Needs attention
          </h2>
          <span>Billing only raises these. It never changes anyone&rsquo;s access.</span>
        </div>
        {items.length === 0 && <p className="one-empty">Nothing needs attention.</p>}
        {items.map((item) => (
          <div className="billing-attention" key={item.key}>
            <span className="billing-kind">{item.kind}</span>
            <span className="billing-attention-text">{item.text}</span>
            <BillingLink href={attentionHref(item.target)}>{item.action}</BillingLink>
          </div>
        ))}
      </section>

      <section className="one-card" aria-labelledby="aging-heading">
        <div className="one-section-head">
          <h2 id="aging-heading" className="small">
            How old the open balance is
          </h2>
          <span className="billing-amount">{formatCents(total)}</span>
        </div>
        <div
          role="img"
          className="billing-aging"
          aria-label={`${formatCents(age.notDueCents)} is not yet due, ${formatCents(age.late1to30Cents)} is 1 to 30 days past due, ${formatCents(age.late31to60Cents)} is 31 to 60 days and ${formatCents(age.lateOver60Cents)} is over 60 days.`}
        >
          <span className="notdue" style={{ width: `${share(age.notDueCents)}%` }} />
          <span
            className="late"
            style={{ width: `${share(age.late1to30Cents + age.late31to60Cents + age.lateOver60Cents)}%` }}
          />
        </div>
        <div className="billing-legend">
          <span>
            <i className="notdue" aria-hidden="true" />
            Not yet due <b>{formatCents(age.notDueCents)}</b>
          </span>
          <span>
            <i className="late" aria-hidden="true" />
            1–30 days late <b>{formatCents(age.late1to30Cents)}</b>
          </span>
          <span>
            31–60 days <b>{formatCents(age.late31to60Cents)}</b>
          </span>
          <span>
            Over 60 days <b>{formatCents(age.lateOver60Cents)}</b>
          </span>
        </div>
      </section>

      <section className="one-card billing-tabs-card" aria-label="Invoices, payments and accounts">
        <div className="billing-tabs" role="group" aria-label="View">
          {(
            [
              ["invoices", "Invoices", issued.length],
              ["payments", "Payments", payments.length],
              ["accounts", "By account", accountRows.length],
            ] as Array<[Tab, string, number]>
          ).map(([key, label, count]) => (
            <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>
              {label} <span>{count}</span>
            </button>
          ))}
        </div>

        {tab === "invoices" && (
          <>
            <div className="one-filters" role="group" aria-label="Filter invoices">
              {FILTERS.map(([key, label]) => (
                <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                  {label} <span>{issued.filter(tests[key]).length}</span>
                </button>
              ))}
            </div>
            <div className="one-table-wrap" tabIndex={0} role="region" aria-label="Table, scrolls sideways">
              <table className="one-table billing-table">
                <thead>
                  <tr>
                    <th scope="col">Invoice</th>
                    <th scope="col">Account</th>
                    <th scope="col">Sent by</th>
                    <th scope="col">Issued</th>
                    <th scope="col">Due</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">
                      Total
                    </th>
                    <th scope="col" className="num">
                      Balance
                    </th>
                    <th scope="col">
                      <span className="sr-only">Download</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((invoice) => (
                    <tr key={invoice.id}>
                      <td>
                        <BillingLink href={billingHref.invoice(invoice.number!)} className="one-mono">
                          {invoice.number}
                        </BillingLink>
                      </td>
                      <td>
                        <BillingLink
                          href={billingHref.accountBilling(invoice.accountId)}
                          className="billing-account"
                        >
                          {accountName(invoice.accountId)}
                        </BillingLink>
                      </td>
                      <td className="one-muted">{invoice.issuedVia === "stripe" ? "Stripe" : "Anthus"}</td>
                      <td className="one-muted nowrap">{shortDate(invoice.issuedAt, today)}</td>
                      <td className="nowrap">{dueLabel(invoice, today)}</td>
                      <td>
                        <StatusBadge invoice={invoice} late={isPastDue(invoice, today)} />
                      </td>
                      <td className="num one-muted">{formatCents(invoice.totalCents)}</td>
                      <td className="num">{formatCents(invoice.balanceCents)}</td>
                      <td>
                        <PdfButton
                          reference={invoice.number!}
                          label={`Download PDF of invoice ${invoice.number}`}
                          iconOnly
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length === 0 && (
              <p role="status" className="one-empty">
                No invoices match this filter.
              </p>
            )}
          </>
        )}

        {tab === "payments" && (
          <div className="one-table-wrap" tabIndex={0} role="region" aria-label="Table, scrolls sideways">
            <table className="one-table billing-table">
              <thead>
                <tr>
                  <th scope="col">Received</th>
                  <th scope="col">Account</th>
                  <th scope="col">Method</th>
                  <th scope="col">Reference</th>
                  <th scope="col">Applied to</th>
                  <th scope="col">Recorded by</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  <th scope="col" className="num">
                    Unallocated
                  </th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <PaymentRow
                    key={payment.id}
                    payment={payment}
                    accountName={accountName(payment.accountId)}
                    today={today}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "accounts" && (
          <div className="one-table-wrap" tabIndex={0} role="region" aria-label="Table, scrolls sideways">
            <table className="one-table billing-table">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">How they pay</th>
                  <th scope="col">Open invoices</th>
                  <th scope="col">Last payment</th>
                  <th scope="col" className="num">
                    Owed
                  </th>
                  <th scope="col" className="num">
                    Past due
                  </th>
                  <th scope="col" className="num">
                    Unallocated
                  </th>
                </tr>
              </thead>
              <tbody>
                {accountRows.map((row) => (
                  <tr key={row.account.id}>
                    <td>
                      <BillingLink
                        href={billingHref.accountBilling(row.account.id)}
                        className="billing-account"
                      >
                        {row.account.name}
                      </BillingLink>
                    </td>
                    <td className="one-muted">
                      {row.account.mode === "direct" ? "Card, through Stripe" : "Invoiced"}
                    </td>
                    <td className="one-mono">{row.openCount}</td>
                    <td className="one-muted nowrap">
                      {row.lastPayment ? shortDate(row.lastPayment.receivedAt, today) : "None"}
                    </td>
                    <td className="num">{formatCents(row.owedCents)}</td>
                    <td className={`num${row.pastDueCents > 0 ? " one-warn" : " one-muted"}`}>
                      {formatCents(row.pastDueCents)}
                    </td>
                    <td className="num">{formatCents(row.unappliedCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function PaymentRow({
  payment,
  accountName,
  today,
}: {
  payment: Payment;
  accountName: string;
  today: string;
}) {
  const applied = payment.allocations.filter((allocation) => !allocation.reversal_of);
  return (
    <tr>
      <td className="nowrap">
        <BillingLink href={billingHref.payment(payment.id)}>
          {shortDate(payment.receivedAt, today)}
        </BillingLink>
      </td>
      <td>
        <BillingLink href={billingHref.accountBilling(payment.accountId)} className="billing-account">
          {accountName}
        </BillingLink>
      </td>
      <td>
        {METHOD_LABEL[payment.method]}
        {payment.reversal ? `, reversed ${shortDate(payment.reversal.at, today)}` : ""}
      </td>
      <td className="one-mono one-muted">{payment.reference ?? "—"}</td>
      <td className="small">
        {payment.reversal
          ? "Returned"
          : applied.length
            ? applied
                .map((allocation) => `${allocation.invoiceNumber} · ${formatCents(allocation.amountCents)}`)
                .join(", ")
            : "Not applied"}
      </td>
      <td className="small one-muted">{payment.recordedBy}</td>
      <td className="num">
        {payment.reversal ? <s>{formatCents(payment.amountCents)}</s> : formatCents(payment.amountCents)}
      </td>
      <td className={`num${payment.unallocatedCents > 0 ? " one-warn" : " one-muted"}`}>
        {formatCents(payment.unallocatedCents)}
      </td>
    </tr>
  );
}
