import { useMemo, useRef, useState } from "react";
import { operationId } from "../operation-id";
import {
  dueLabel,
  METHOD_LABEL,
  oldestFirst,
  paymentLabel,
  shortDate,
  sumAllocations,
  describeEvent,
} from "../billing/derive";
import { centsToInput, formatCents, moneyProblem, parseCents } from "../billing/money";
import { billingHref } from "../billing/routes";
import { localDate } from "../prospect";
import {
  EXTERNAL_METHODS,
  type AllocationInput,
  type ExternalPaymentMethod,
  type Invoice,
  type Payment,
} from "../billing/types";
import {
  BillingLink,
  BillingUnavailable,
  Breadcrumb,
  MoneyField,
  ReadOnlyNote,
  ReasonPanel,
  Timeline,
} from "../shared/billing";
import { Eyebrow } from "../shared/ui";
import { useBilling, useBillingLoad } from "./BillingProvider";

/** The amounts typed against each open invoice, checked before any request. */
function useAllocations(invoices: Invoice[]) {
  const [texts, setTexts] = useState<Record<string, string>>({});
  const rows = invoices.map((invoice) => {
    const text = texts[invoice.id] ?? "";
    const parse = parseCents(text);
    let error = "";
    if (text.trim() !== "") {
      if (!parse.ok) error = moneyProblem(parse);
      else if (parse.cents > invoice.balanceCents)
        error = `This invoice only has ${formatCents(invoice.balanceCents)} open.`;
    }
    return { invoice, text, cents: parse.ok ? parse.cents : 0, error };
  });
  return {
    rows,
    total: rows.reduce((sum, row) => sum + row.cents, 0),
    problem: rows.some((row) => row.error),
    setText: (id: string, value: string) => setTexts((previous) => ({ ...previous, [id]: value })),
    fill: (applied: Map<string, number>) =>
      setTexts(Object.fromEntries([...applied].map(([id, cents]) => [id, centsToInput(cents)]))),
    reset: () => setTexts({}),
    inputs: (): AllocationInput[] =>
      rows
        .filter((row) => row.cents > 0)
        .map((row) => ({ invoiceId: row.invoice.id, amountCents: row.cents })),
  };
}

function AllocationRows({
  allocations,
  today,
  onOldest,
}: {
  allocations: ReturnType<typeof useAllocations>;
  today: string;
  onOldest: () => void;
}) {
  return (
    <section className="one-card strong" aria-labelledby="apply-heading">
      <div className="one-section-head">
        <h2 id="apply-heading" className="small">
          Apply it to invoices
        </h2>
        <button type="button" className="one-button small" onClick={onOldest}>
          Oldest first
        </button>
      </div>
      {allocations.rows.length === 0 && <p className="one-empty">This account has no open invoices.</p>}
      {allocations.rows.map((row) => (
        <div className="billing-apply-row" key={row.invoice.id}>
          <span className="one-cellstack">
            <strong className="one-mono">{row.invoice.number}</strong>
            <small>{dueLabel(row.invoice, today).replace(/^(\w+ \d+)$/, "Due $1")}</small>
          </span>
          <span className="one-cellstack">
            <small>Balance</small>
            <span className="billing-amount">{formatCents(row.invoice.balanceCents)}</span>
          </span>
          <MoneyField
            label={`Amount to apply to invoice ${row.invoice.number}`}
            value={row.text}
            placeholder="0.00"
            error={row.error}
            onChange={(value) => allocations.setText(row.invoice.id, value)}
          />
        </div>
      ))}
    </section>
  );
}

function pickAccount(search: string) {
  return new URLSearchParams(search).get("account") ?? "";
}

/** Record a payment that arrived outside Stripe, and apply it to invoices. */
export function RecordPaymentView() {
  const { available, canAct, overview, client, today, refresh, go } = useBilling();
  const [accountId, setAccountId] = useState(() => pickAccount(window.location.search));
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<ExternalPaymentMethod>("check");
  const [received, setReceived] = useState(() => localDate());
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [saved, setSaved] = useState<Payment | null>(null);
  const attempt = useRef(operationId());
  const open = useMemo(
    () =>
      overview.status === "ready"
        ? overview.data.invoices.filter(
            (invoice) =>
              invoice.accountId === accountId &&
              invoice.number &&
              ["issued", "partially_paid"].includes(invoice.status) &&
              invoice.balanceCents > 0,
          )
        : [],
    [overview, accountId],
  );
  const allocations = useAllocations(open);
  if (!available) return <BillingUnavailable label="Record a payment" />;
  if (overview.status !== "ready")
    return (
      <main className="one-main narrow" aria-label="Record a payment">
        <p role="status">{overview.status === "error" ? overview.message : "Loading billing…"}</p>
      </main>
    );
  const accounts = overview.data.accounts.filter((account) => account.billable);
  const account = accounts.find((item) => item.id === accountId);
  const trail = [{ label: "Usage and billing", href: "/billing" }];
  if (!canAct)
    return (
      <main className="one-main narrow" aria-label="Record a payment">
        <Breadcrumb trail={trail} current="Record a payment" />
        <div className="one-pagehead">
          <div>
            <h1>Record a payment</h1>
          </div>
        </div>
        <ReadOnlyNote what="Recording a payment" />
      </main>
    );
  const parsed = parseCents(amount);
  const amountCents = parsed.ok ? parsed.cents : 0;
  const amountProblem = amount.trim() !== "" && !parsed.ok ? moneyProblem(parsed) : "";
  const over = parsed.ok && allocations.total > amountCents;
  const left = Math.max(amountCents - allocations.total, 0);
  const blocked =
    busy || !account || !parsed.ok || amountCents === 0 || allocations.problem || over || received === "";

  async function save() {
    setBusy(true);
    setProblem("");
    try {
      const payment = await client.recordPayment({
        operationId: attempt.current,
        accountId,
        amountCents,
        method,
        receivedAt: received,
        reference: reference.trim() || undefined,
        note: note.trim() || undefined,
        allocations: allocations.inputs(),
      });
      setSaved(payment);
      refresh();
    } catch (cause) {
      setProblem((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function another() {
    attempt.current = operationId();
    setSaved(null);
    setAmount("");
    setReference("");
    setNote("");
    allocations.reset();
  }

  return (
    <main className="one-main narrow" aria-label="Record a payment">
      <Breadcrumb
        trail={
          account ? [...trail, { label: account.name, href: billingHref.accountBilling(account.id) }] : trail
        }
        current="Record a payment"
      />
      <div className="one-pagehead">
        <div>
          <h1>Record a payment</h1>
          <p>For money that arrived outside Stripe. Stripe payments appear on their own.</p>
        </div>
      </div>
      {saved && (
        <section role="status" className="one-card hot billing-saved">
          <h2 className="small">Payment recorded</h2>
          {saved.allocations.map((allocation) => (
            <span key={allocation.id}>
              {formatCents(allocation.amountCents)} applied to {allocation.invoiceNumber}.
            </span>
          ))}
          {saved.unallocatedCents > 0 && (
            <span>{formatCents(saved.unallocatedCents)} is not yet applied.</span>
          )}
          <div className="one-toolbar">
            <button
              type="button"
              className="one-button primary"
              onClick={() => go(billingHref.accountBilling(saved.accountId))}
            >
              Back to the account
            </button>
            <BillingLink href={billingHref.payment(saved.id)}>Open payment</BillingLink>
            <button type="button" className="one-button" onClick={another}>
              Record another
            </button>
          </div>
        </section>
      )}
      {!saved && (
        <div className="one-columns">
          <div className="primary">
            <section className="one-card strong" aria-labelledby="details-heading">
              <h2 id="details-heading" className="small">
                What came in
              </h2>
              <div className="billing-form-grid">
                <label>
                  Account
                  <select
                    value={accountId}
                    onChange={(event) => {
                      setAccountId(event.target.value);
                      allocations.reset();
                    }}
                  >
                    <option value="">Choose an account</option>
                    {accounts.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <MoneyField label="Amount (USD)" value={amount} onChange={setAmount} />
                <label>
                  Method
                  <select
                    value={method}
                    onChange={(event) => setMethod(event.target.value as ExternalPaymentMethod)}
                  >
                    {EXTERNAL_METHODS.map((item) => (
                      <option key={item} value={item}>
                        {METHOD_LABEL[item]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Received
                  <input type="date" value={received} onChange={(event) => setReceived(event.target.value)} />
                </label>
                <label>
                  Reference
                  <input
                    type="text"
                    value={reference}
                    placeholder="Check number or transfer ID"
                    onChange={(event) => setReference(event.target.value)}
                  />
                </label>
                <label>
                  Note
                  <input
                    type="text"
                    value={note}
                    placeholder="Optional"
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
              </div>
              {amountProblem && (
                <span className="sr-only" role="status">
                  {amountProblem}
                </span>
              )}
            </section>
            {account && (
              <AllocationRows
                allocations={allocations}
                today={today}
                onOldest={() => allocations.fill(oldestFirst(amountCents, open))}
              />
            )}
          </div>
          <aside className="secondary">
            <section className="one-card billing-summary" aria-label="Summary">
              <Eyebrow>•••• Summary</Eyebrow>
              <div>
                <span>Payment</span>
                <b>{formatCents(amountCents)}</b>
              </div>
              <div>
                <span>Applied</span>
                <b>{formatCents(allocations.total)}</b>
              </div>
              <div>
                <span>Left to apply later</span>
                <b className={left > 0 ? "one-warn" : undefined}>{formatCents(left)}</b>
              </div>
              {over && (
                <p role="alert" className="billing-error">
                  That applies more than the payment. The most you can apply is {formatCents(amountCents)}.
                </p>
              )}
              {left > 0 && !over && allocations.total > 0 && (
                <p className="one-muted">
                  You can record it now and apply the rest later. It will show as not yet applied on the
                  account.
                </p>
              )}
              {problem && (
                <p role="alert" className="one-alert">
                  {problem}
                </p>
              )}
              <button
                type="button"
                className="one-button primary tall"
                disabled={blocked}
                onClick={() => void save()}
              >
                Record {formatCents(amountCents)}
              </button>
              <button
                type="button"
                className="one-button"
                onClick={() => go(account ? billingHref.accountBilling(account.id) : "/billing")}
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

/** One payment: what it was, what it was applied to, and what can still be done with it. */
export function PaymentView({ id }: { id: string }) {
  const { available, client, canAct, today, refresh } = useBilling();
  const loaded = useBillingLoad(() => client.payment(id), [id, client]);
  const [reversing, setReversing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const attempt = useRef(operationId());
  const allocations = useAllocations(loaded.data?.openInvoices ?? []);
  if (!available) return <BillingUnavailable label="Payment" />;
  if (loaded.loading)
    return (
      <main className="one-main narrow" aria-label="Payment">
        <p role="status">Loading payment…</p>
      </main>
    );
  if (loaded.error || !loaded.data)
    return (
      <main className="one-main narrow" aria-label="Payment">
        <Breadcrumb trail={[{ label: "Usage and billing", href: "/billing" }]} current="Payment" />
        <p role="alert" className="one-alert">
          {loaded.error || "That payment was not found."}
        </p>
      </main>
    );
  const { payment, account, journal } = loaded.data;
  const applied = payment.allocations.filter((allocation) => !allocation.reversal_of);
  const over = allocations.total > payment.unallocatedCents;
  const changed = () => {
    attempt.current = operationId();
    allocations.reset();
    loaded.reload();
    refresh();
  };
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setProblem("");
    try {
      await action();
      setReversing(false);
      changed();
    } catch (cause) {
      setProblem((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="one-main narrow" aria-label="Payment">
      <Breadcrumb
        trail={[
          { label: "Usage and billing", href: "/billing" },
          { label: account.name, href: billingHref.accountBilling(account.id) },
        ]}
        current={`Payment, ${paymentLabel(payment)}`}
      />
      <section className="one-card strong billing-invoice-head">
        <div className="one-badges">
          <span className="one-badge">{METHOD_LABEL[payment.method]}</span>
          {payment.reversal && <span className="billing-status late">Reversed</span>}
        </div>
        <h1>
          {payment.reversal ? <s>{formatCents(payment.amountCents)}</s> : formatCents(payment.amountCents)}
        </h1>
        <span className="one-account-meta">
          <BillingLink href={billingHref.accountBilling(account.id)}>{account.name}</BillingLink> · received{" "}
          {shortDate(payment.receivedAt, today)}
          {payment.reference ? ` · ${payment.reference}` : ""} · recorded by {payment.recordedBy}
        </span>
        {payment.note && <span className="one-muted">{payment.note}</span>}
        {payment.reversal && (
          <p>
            Reversed {shortDate(payment.reversal.at, today)} by {payment.reversal.by}:{" "}
            {payment.reversal.reason}. Both records stay on file.
          </p>
        )}
        {canAct && !payment.reversal && !reversing && (
          <div className="one-toolbar">
            <button type="button" className="one-button" onClick={() => setReversing(true)}>
              Reverse this payment
            </button>
          </div>
        )}
      </section>

      {canAct && reversing && (
        <ReasonPanel
          title="Reverse this payment?"
          body="Its applications come off the invoices, which return to their earlier balances. Both records stay on file."
          confirm="Reverse payment"
          busy={busy}
          error={problem}
          onConfirm={(reason) =>
            void run(() =>
              client.reversePayment(payment.id, {
                operationId: attempt.current,
                reason,
                expectedRevision: payment.revision,
              }),
            )
          }
          onCancel={() => setReversing(false)}
        />
      )}

      <div className="one-columns">
        <div className="primary">
          <section className="one-card strong" aria-labelledby="applied-heading">
            <div className="one-section-head">
              <h2 id="applied-heading" className="small">
                What it was applied to
              </h2>
              <span>
                Not yet applied{" "}
                <b className={payment.unallocatedCents > 0 ? "one-warn" : undefined}>
                  {formatCents(payment.unallocatedCents)}
                </b>
              </span>
            </div>
            {applied.length === 0 && <p className="one-empty">Not applied to an invoice.</p>}
            {applied.map((allocation) => (
              <div className="billing-applied" key={allocation.id}>
                <span>
                  <BillingLink href={billingHref.invoice(allocation.invoiceNumber ?? allocation.invoiceId)}>
                    {allocation.invoiceNumber}
                  </BillingLink>{" "}
                  <span className="one-muted">
                    · {shortDate(allocation.at, today)} · {allocation.by}
                  </span>
                </span>
                <span className="billing-amount">{formatCents(allocation.amountCents)}</span>
              </div>
            ))}
          </section>

          {canAct && !payment.reversal && payment.unallocatedCents > 0 && (
            <>
              <AllocationRows
                allocations={allocations}
                today={today}
                onOldest={() =>
                  allocations.fill(oldestFirst(payment.unallocatedCents, loaded.data!.openInvoices))
                }
              />
              {over && (
                <p role="alert" className="billing-error">
                  That applies more than the payment has left. The most you can apply is{" "}
                  {formatCents(payment.unallocatedCents)}.
                </p>
              )}
              {problem && !reversing && (
                <p role="alert" className="one-alert">
                  {problem}
                </p>
              )}
              <div className="one-toolbar">
                <button
                  type="button"
                  className="one-button primary"
                  disabled={busy || allocations.problem || over || allocations.total === 0}
                  onClick={() =>
                    void run(() =>
                      client.allocate(payment.id, {
                        operationId: attempt.current,
                        allocations: allocations.inputs(),
                        expectedRevision: payment.revision,
                      }),
                    )
                  }
                >
                  Apply {formatCents(allocations.total)}
                </button>
              </div>
            </>
          )}
          {!canAct && <ReadOnlyNote what="Applying or reversing a payment" />}
        </div>
        <aside className="secondary">
          <section className="one-card">
            <Eyebrow>•••• History</Eyebrow>
            <Timeline events={journal} empty="No history yet." />
          </section>
        </aside>
      </div>
    </main>
  );
}
