import { useState } from "react";
import { operationId } from "../operation-id";
import {
  dueLabel,
  isPastDue,
  METHOD_LABEL,
  daysPastDue,
  longDate,
  owedBy,
  paymentLabel,
  shortDate,
} from "../billing/derive";
import { formatCents } from "../billing/money";
import { billingHref } from "../billing/routes";
import type { AccountBilling, BillingContact, BillingLine, BillingProfile } from "../billing/types";
import { BillingLink, PdfButton, StatusBadge, Timeline } from "../shared/billing";
import { Eyebrow, Icon, Stat, Unavailable } from "../shared/ui";
import { useBilling, useBillingLoad } from "./BillingProvider";

/** Overview and Billing, the two sections of an account page. Each has its own address. */
export function AccountTabs({
  accountId,
  current,
  onOverview,
}: {
  accountId: string;
  current: "overview" | "billing";
  onOverview: () => void;
}) {
  const { go } = useBilling();
  const overview = `/accounts/${encodeURIComponent(accountId)}`;
  return (
    <div className="billing-sections" role="navigation" aria-label="Account sections">
      <a
        href={overview}
        aria-current={current === "overview" ? "page" : undefined}
        onClick={(event) => {
          event.preventDefault();
          onOverview();
        }}
      >
        Overview
      </a>
      <a
        href={billingHref.accountBilling(accountId)}
        aria-current={current === "billing" ? "page" : undefined}
        onClick={(event) => {
          event.preventDefault();
          go(billingHref.accountBilling(accountId));
        }}
      >
        Billing
      </a>
    </div>
  );
}

/** The billing card on the account Overview. */
export function BillingSummaryCard({ accountId }: { accountId: string }) {
  const { available, overview, today } = useBilling();
  return (
    <section className="one-card" aria-label="Billing summary">
      <Eyebrow>•••• Billing</Eyebrow>
      {!available || overview.status === "unavailable" ? (
        <Unavailable title="Not yet available">
          <span>Invoices and payments are not recorded yet.</span>
        </Unavailable>
      ) : overview.status !== "ready" ? (
        <p role="status">{overview.status === "loading" ? "Loading billing…" : overview.message}</p>
      ) : (
        (() => {
          const owed = owedBy(accountId, overview.data.invoices, overview.data.payments, today);
          return (
            <>
              <dl className="one-dl">
                <dt>Owed</dt>
                <dd>{formatCents(owed.owedCents)}</dd>
                <dt>Past due</dt>
                <dd className={owed.pastDueCents > 0 ? "one-warn" : undefined}>
                  {formatCents(owed.pastDueCents)}
                </dd>
                <dt>Not yet applied</dt>
                <dd>{formatCents(owed.unappliedCents)}</dd>
                <dt>Last payment</dt>
                <dd>{owed.lastPayment ? shortDate(owed.lastPayment.receivedAt, today) : "None"}</dd>
              </dl>
              <BillingLink href={billingHref.accountBilling(accountId)}>Open billing</BillingLink>
            </>
          );
        })()
      )}
    </section>
  );
}

/** The Billing section of an account: the profile, what they are billed for, invoices, payments and activity. */
export function AccountBillingSection({ accountId }: { accountId: string }) {
  const { available, client, canAct, go, today, refresh } = useBilling();
  const loaded = useBillingLoad(() => client.account(accountId), [accountId, client]);
  if (!available)
    return (
      <Unavailable title="Not yet available">
        <span>
          Billing for this account will appear here once Anthus One records billing. Nothing is shown until
          then.
        </span>
      </Unavailable>
    );
  if (loaded.loading) return <p role="status">Loading billing…</p>;
  if (loaded.error)
    return (
      <p role="alert" className="one-alert">
        {loaded.error}
      </p>
    );
  const data = loaded.data;
  if (!data) return null;
  const changed = () => {
    loaded.reload();
    refresh();
  };
  if (!data.profile) return <NotBillable data={data} canAct={canAct} onSaved={changed} />;
  const owed = owedBy(accountId, data.invoices, data.payments, today);
  const late = data.invoices
    .filter((invoice) => isPastDue(invoice, today) && invoice.number)
    .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""))[0];
  const remainder = data.payments.find((payment) => !payment.reversal && payment.unallocatedCents > 0);
  return (
    <>
      <section className="one-stats" aria-label="Billing totals">
        <Stat
          value={formatCents(owed.owedCents)}
          label="OWED"
          note={`${owed.openCount} open ${owed.openCount === 1 ? "invoice" : "invoices"}`}
        />
        <Stat
          value={formatCents(owed.pastDueCents)}
          label="PAST DUE"
          note={owed.pastDueCents > 0 ? "Needs a follow-up" : "Nothing late"}
          hot={owed.pastDueCents > 0}
        />
        <Stat
          value={formatCents(owed.unappliedCents)}
          label="NOT YET APPLIED"
          note={remainder ? `From ${paymentLabel(remainder)}` : "Nothing waiting"}
        />
        <Stat
          value={owed.lastPayment ? shortDate(owed.lastPayment.receivedAt, today) : "None"}
          label="LAST PAYMENT"
          note={
            owed.lastPayment
              ? `${formatCents(owed.lastPayment.amountCents)} by ${METHOD_LABEL[owed.lastPayment.method].toLowerCase()}`
              : "No payment yet"
          }
        />
      </section>

      {late && (
        <section className="one-card hot" aria-labelledby="followup-heading">
          <div className="one-section-head">
            <h2 id="followup-heading" className="small">
              {late.number} is {daysPastDue(late, today)} {daysPastDue(late, today) === 1 ? "day" : "days"}{" "}
              past due, with {formatCents(late.balanceCents)} open
            </h2>
          </div>
          <p className="one-muted">
            {remainder
              ? `${formatCents(remainder.unallocatedCents)} from ${paymentLabel(remainder)} could go toward it. `
              : ""}
            Access stays on unless someone changes it under Apps and access.
          </p>
          <div className="one-toolbar">
            <BillingLink href={billingHref.invoice(late.number!)}>Open invoice</BillingLink>
            <BillingLink href={`/accounts/${encodeURIComponent(accountId)}#apps-heading`}>
              Apps and access
            </BillingLink>
          </div>
        </section>
      )}

      <div className="one-columns">
        <div className="primary">
          <section className="one-card strong" aria-labelledby="invoices-heading">
            <div className="one-section-head">
              <h2 id="invoices-heading" className="small">
                Invoices
              </h2>
              {canAct && (
                <button
                  type="button"
                  className="one-button small"
                  onClick={() => go(billingHref.newInvoice(accountId))}
                >
                  Raise an invoice
                </button>
              )}
            </div>
            <div className="one-table-wrap" tabIndex={0} role="region" aria-label="Table, scrolls sideways">
              <table className="one-table billing-table">
                <thead>
                  <tr>
                    <th scope="col">Invoice</th>
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
                  {data.invoices
                    .filter((invoice) => invoice.number)
                    .sort((a, b) => b.number!.localeCompare(a.number!))
                    .map((invoice) => (
                      <tr key={invoice.id}>
                        <td>
                          <BillingLink href={billingHref.invoice(invoice.number!)} className="one-mono">
                            {invoice.number}
                          </BillingLink>
                        </td>
                        <td className="nowrap">{shortDate(invoice.issuedAt, today)}</td>
                        <td className="nowrap">{dueLabel(invoice, today)}</td>
                        <td>
                          <StatusBadge invoice={invoice} late={isPastDue(invoice, today)} />
                        </td>
                        <td className="num">{formatCents(invoice.totalCents)}</td>
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
            {data.invoices.every((invoice) => !invoice.number) && (
              <p className="one-empty">No invoices yet.</p>
            )}
          </section>

          <section className="one-card strong" aria-labelledby="payments-heading">
            <div className="one-section-head">
              <h2 id="payments-heading" className="small">
                Payments
              </h2>
              {canAct && (
                <button
                  type="button"
                  className="one-button small primary"
                  onClick={() => go(billingHref.newPayment(accountId))}
                >
                  <Icon name="plus" size={14} />
                  Record a payment
                </button>
              )}
            </div>
            {data.payments.length === 0 && <p className="one-empty">No payments yet.</p>}
            {data.payments.map((payment) => (
              <div className="billing-payment" key={payment.id}>
                <div className="billing-payment-head">
                  <span>
                    <BillingLink href={billingHref.payment(payment.id)}>
                      {METHOD_LABEL[payment.method]}
                      {payment.reference ? ` ${payment.reference}` : ""}
                    </BillingLink>{" "}
                    <span className="one-muted">
                      · received {shortDate(payment.receivedAt, today)} · recorded by {payment.recordedBy}
                    </span>
                  </span>
                  <span className="billing-amount">
                    {payment.reversal ? (
                      <s>{formatCents(payment.amountCents)}</s>
                    ) : (
                      formatCents(payment.amountCents)
                    )}
                  </span>
                </div>
                {payment.reversal ? (
                  <span className="one-muted">
                    Reversed {shortDate(payment.reversal.at, today)} by {payment.reversal.by}:{" "}
                    {payment.reversal.reason.toLowerCase()}. Both records stay on file.
                  </span>
                ) : (
                  <>
                    {payment.allocations
                      .filter((allocation) => !allocation.reversal_of)
                      .map((allocation) => (
                        <div className="billing-applied" key={allocation.id}>
                          <span>
                            Applied to{" "}
                            <BillingLink
                              href={billingHref.invoice(allocation.invoiceNumber ?? allocation.invoiceId)}
                            >
                              {allocation.invoiceNumber}
                            </BillingLink>
                          </span>
                          <span className="billing-amount">{formatCents(allocation.amountCents)}</span>
                        </div>
                      ))}
                    {payment.unallocatedCents > 0 && (
                      <div className="billing-applied">
                        <span className="one-warn">Not yet applied</span>
                        <span className="billing-amount">
                          {formatCents(payment.unallocatedCents)}
                          {canAct && (
                            <>
                              {" "}
                              <BillingLink href={billingHref.payment(payment.id)}>Allocate</BillingLink>
                            </>
                          )}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </section>

          <section className="one-card strong" aria-labelledby="lines-heading">
            <div className="one-section-head">
              <h2 id="lines-heading" className="small">
                What they&rsquo;re billed for
              </h2>
              <span>One line per app. Access is set separately.</span>
            </div>
            {data.lines.length === 0 && <p className="one-empty">No billing lines yet.</p>}
            {data.lines.map((line) => (
              <LineRow key={line.product} line={line} />
            ))}
          </section>
        </div>

        <aside className="secondary">
          <ProfileCard data={data} canAct={canAct} onSaved={changed} />
          <section className="one-card">
            <Eyebrow>•••• Activity</Eyebrow>
            <Timeline events={data.journal} empty="No billing activity yet." />
          </section>
        </aside>
      </div>
    </>
  );
}

function LineRow({ line }: { line: BillingLine }) {
  const period =
    line.status === "none"
      ? "App is on, not billed"
      : line.periodStart
        ? `${longDate(line.periodStart)}${line.periodEnd ? ` – ${longDate(line.periodEnd)}` : ""}`
        : "—";
  return (
    <div className="billing-line">
      <span className="one-cellstack">
        <strong>{line.name}</strong>
        <small className="one-mono">{line.product}</small>
      </span>
      <span>{line.planName ?? "None"}</span>
      <span className="one-muted">{period}</span>
      <span
        className={line.status === "none" ? "one-warn" : line.status === "active" ? "one-ok" : "one-muted"}
      >
        {line.status === "none" ? "No line" : line.status.charAt(0).toUpperCase() + line.status.slice(1)}
      </span>
    </div>
  );
}

function NotBillable({
  data,
  canAct,
  onSaved,
}: {
  data: AccountBilling;
  canAct: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <section className="one-card cool" aria-labelledby="not-billable">
      <h2 id="not-billable">This account isn&rsquo;t billable yet</h2>
      <p>
        It works normally without billing. Its apps stay on, and nothing is charged. Set up a billing profile
        to choose how this client pays, then attach a plan to each app.
      </p>
      {canAct && !editing && (
        <div>
          <button type="button" className="one-button primary" onClick={() => setEditing(true)}>
            Set up billing profile
          </button>
        </div>
      )}
      {canAct && editing && (
        <ProfileForm
          accountId={data.account.id}
          profile={null}
          onCancel={() => setEditing(false)}
          onSaved={onSaved}
        />
      )}
    </section>
  );
}

function ProfileCard({
  data,
  canAct,
  onSaved,
}: {
  data: AccountBilling;
  canAct: boolean;
  onSaved: () => void;
}) {
  const { client } = useBilling();
  const profile = data.profile!;
  const [editing, setEditing] = useState(false);
  const [revealed, setRevealed] = useState<BillingContact | null>(null);
  const [problem, setProblem] = useState("");
  async function toggle() {
    if (revealed) {
      setRevealed(null);
      return;
    }
    setProblem("");
    try {
      setRevealed(await client.revealContact(data.account.id));
    } catch (cause) {
      setProblem((cause as Error).message);
    }
  }
  const contact = revealed ?? profile.contactMasked;
  return (
    <section className="one-card" aria-label="Billing profile">
      <div className="one-section-head">
        <Eyebrow>•••• Billing profile</Eyebrow>
        {canAct && !editing && (
          <button type="button" className="one-button small" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <ProfileForm
          accountId={data.account.id}
          profile={profile}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onSaved();
          }}
        />
      ) : (
        <dl className="one-dl">
          <dt>How they pay</dt>
          <dd>{profile.mode === "direct" ? "Card, through Stripe" : "Invoiced"}</dd>
          <dt>Terms</dt>
          <dd>{profile.netTermsDays ? `Net ${profile.netTermsDays}` : "Net 30 (default)"}</dd>
        </dl>
      )}
      <div className="billing-contact">
        <div className="one-section-head">
          <strong>Billing contact</strong>
          <button
            type="button"
            className="one-button small"
            aria-pressed={revealed !== null}
            onClick={() => void toggle()}
          >
            {revealed ? "Hide" : "Reveal"}
          </button>
        </div>
        <span data-testid="billing-contact">{contact.name}</span>
        <span data-testid="billing-contact">{contact.email}</span>
        <span data-testid="billing-contact">{contact.address}</span>
        {problem && (
          <span role="alert" className="billing-error">
            {problem}
          </span>
        )}
      </div>
      <p className="one-note">
        Printed on new invoices: the payment methods in the company&rsquo;s billing settings.
      </p>
    </section>
  );
}

function ProfileForm({
  accountId,
  profile,
  onCancel,
  onSaved,
}: {
  accountId: string;
  profile: BillingProfile | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { client } = useBilling();
  const [mode, setMode] = useState<"direct" | "invoiced">(profile?.mode ?? "invoiced");
  const [terms, setTerms] = useState(String(profile?.netTermsDays ?? ""));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [attempt] = useState(operationId);
  async function save() {
    setBusy(true);
    setProblem("");
    try {
      await client.saveProfile(accountId, {
        operationId: attempt,
        mode,
        netTermsDays: terms ? Number(terms) : undefined,
        expectedRevision: profile?.revision,
      });
      onSaved();
    } catch (cause) {
      setProblem((cause as Error).message);
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        How they pay
        <select value={mode} onChange={(event) => setMode(event.target.value as "direct" | "invoiced")}>
          <option value="invoiced">Invoiced</option>
          <option value="direct">Card, through Stripe</option>
        </select>
      </label>
      <label>
        Terms
        <select value={terms} onChange={(event) => setTerms(event.target.value)}>
          <option value="">Net 30 (default)</option>
          {[15, 45, 60].map((days) => (
            <option key={days} value={days}>
              Net {days}
            </option>
          ))}
        </select>
      </label>
      {problem && (
        <p role="alert" className="one-alert">
          {problem}
        </p>
      )}
      <div className="one-toolbar">
        <button type="submit" className="one-button primary" disabled={busy}>
          Save profile
        </button>
        <button type="button" className="one-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
