import { useEffect, useRef, useState } from "react";
import { operationId } from "../operation-id";
import { BillingUnavailable, Breadcrumb } from "../shared/billing";
import type { AcceptedPaymentMethod, IssuerBlock, IssuerSettings } from "../billing/types";
import { Icon } from "../shared/ui";
import { useBilling, useBillingLoad } from "./BillingProvider";

/** What new invoices say and how clients can pay. Invoices already issued keep the details they were issued with. */
export function BillingSettingsView() {
  const { available, client } = useBilling();
  const loaded = useBillingLoad(() => client.issuer(), [client]);
  if (!available) return <BillingUnavailable label="Settings" group="Admin" />;
  if (loaded.loading)
    return (
      <main className="one-main narrow" aria-label="Billing settings">
        <p role="status">Loading billing settings…</p>
      </main>
    );
  if (loaded.error || !loaded.data)
    return (
      <main className="one-main narrow" aria-label="Billing settings">
        <p role="alert" className="one-alert">
          {loaded.error || "Billing settings could not be loaded."}
        </p>
      </main>
    );
  return <Settings settings={loaded.data} />;
}

function Settings({ settings }: { settings: IssuerSettings }) {
  const { canAct, client, refresh } = useBilling();
  const [issuer, setIssuer] = useState<IssuerBlock>(settings.issuer);
  const [methods, setMethods] = useState<AcceptedPaymentMethod[]>(settings.paymentMethods);
  const [terms, setTerms] = useState(settings.defaultNetTermsDays);
  const [revision, setRevision] = useState(settings.revision);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const attempt = useRef(operationId());
  const [next, setNext] = useState(settings.nextInvoiceNumber);
  useEffect(() => setNext(settings.nextInvoiceNumber), [settings.nextInvoiceNumber]);
  const readOnly = !canAct;
  const touch = () => setNote("Unsaved changes");
  const field = (key: "legalName" | "billingEmail" | "taxId" | "footerNote") => ({
    value: issuer[key] ?? "",
    readOnly,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      setIssuer({ ...issuer, [key]: event.target.value });
      touch();
    },
  });
  const changeMethod = (index: number, patch: Partial<AcceptedPaymentMethod>) => {
    setMethods((previous) => previous.map((method, i) => (i === index ? { ...method, ...patch } : method)));
    touch();
  };
  async function save() {
    setBusy(true);
    setProblem("");
    try {
      const saved = await client.saveIssuer({
        operationId: attempt.current,
        issuer: { ...issuer, addressLines: issuer.addressLines.filter((line) => line.trim() !== "") },
        paymentMethods: methods.filter((method) => method.label.trim() !== ""),
        defaultNetTermsDays: terms,
        expectedRevision: revision,
      });
      attempt.current = operationId();
      setRevision(saved.revision);
      setNext(saved.nextInvoiceNumber);
      setNote("Saved. New invoices will use these details.");
      refresh();
    } catch (cause) {
      setProblem((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="one-main narrow" aria-label="Billing settings">
      <Breadcrumb trail={[]} current="Settings / Billing" />
      <div className="one-pagehead">
        <div>
          <h1>Billing settings</h1>
          <p>
            What new invoices say and how clients can pay. Invoices already issued keep the details they were
            issued with.
          </p>
        </div>
      </div>
      {readOnly && (
        <p role="status" className="one-status">
          You can view these settings. Changing them needs the billing permission.
        </p>
      )}

      <section className="one-card strong" aria-labelledby="issuer-heading">
        <h2 id="issuer-heading" className="small">
          Your company on invoices
        </h2>
        <div className="billing-form-grid">
          <label>
            Legal name
            <input type="text" {...field("legalName")} />
          </label>
          <label>
            Billing email
            <input type="email" {...field("billingEmail")} />
          </label>
          {[0, 1].map((index) => (
            <label key={index}>
              {index === 0 ? "Street address" : "City, state and ZIP"}
              <input
                type="text"
                readOnly={readOnly}
                value={issuer.addressLines[index] ?? ""}
                onChange={(event) => {
                  const lines = [...issuer.addressLines];
                  lines[index] = event.target.value;
                  setIssuer({ ...issuer, addressLines: lines });
                  touch();
                }}
              />
            </label>
          ))}
          <label>
            Tax ID, if you want it shown
            <input type="text" placeholder="Optional" {...field("taxId")} />
          </label>
          <label>
            Footer note
            <input type="text" {...field("footerNote")} />
          </label>
        </div>
      </section>

      <section className="one-card strong" aria-labelledby="methods-heading">
        <div className="one-section-head">
          <div>
            <h2 id="methods-heading" className="small">
              How clients can pay
            </h2>
            <span>Printed on new invoices. One client can have its own list on its billing profile.</span>
          </div>
          {canAct && (
            <button
              type="button"
              className="one-button small"
              onClick={() => {
                setMethods([...methods, { label: "", instructions: "", offered: true }]);
                touch();
              }}
            >
              <Icon name="plus" size={14} />
              Add a payment method
            </button>
          )}
        </div>
        {methods.map((method, index) => (
          <div className="billing-method" key={index}>
            <label>
              Name on the invoice
              <input
                type="text"
                readOnly={readOnly}
                value={method.label}
                onChange={(event) => changeMethod(index, { label: event.target.value })}
              />
            </label>
            <label>
              Instructions
              <input
                type="text"
                readOnly={readOnly}
                value={method.instructions}
                onChange={(event) => changeMethod(index, { instructions: event.target.value })}
              />
            </label>
            <label className="one-checkline">
              <input
                type="checkbox"
                checked={method.offered}
                disabled={readOnly}
                onChange={() => changeMethod(index, { offered: !method.offered })}
              />
              Offer it
            </label>
            {canAct && (
              <button
                type="button"
                className="one-button small"
                aria-label={`Remove ${method.label || "payment method"}`}
                onClick={() => {
                  setMethods(methods.filter((_, i) => i !== index));
                  touch();
                }}
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </section>

      <section className="one-card strong" aria-labelledby="terms-heading">
        <h2 id="terms-heading" className="small">
          Terms and numbering
        </h2>
        <div className="billing-form-grid">
          <label>
            Default terms
            <select
              value={terms}
              disabled={readOnly}
              onChange={(event) => {
                setTerms(Number(event.target.value));
                touch();
              }}
            >
              {[15, 30, 45, 60].map((days) => (
                <option key={days} value={days}>
                  Net {days}
                </option>
              ))}
            </select>
          </label>
          <span className="one-cellstack">
            <small>Currency</small>US dollars, no tax lines
          </span>
          <span className="one-cellstack">
            <small>Invoice numbers</small>
            Year and month, then a counter. Next is <span className="one-mono">{next}</span>
          </span>
        </div>
      </section>

      {canAct && (
        <div className="one-toolbar">
          <button type="button" className="one-button primary" disabled={busy} onClick={() => void save()}>
            Save changes
          </button>
          <span role="status">{note}</span>
          {problem && (
            <span role="alert" className="billing-error">
              {problem}
            </span>
          )}
        </div>
      )}

      <section className="one-card" aria-labelledby="connections-heading">
        <div className="one-section-head">
          <h2 id="connections-heading" className="small">
            Set elsewhere
          </h2>
          <span>Shown here so you can see them. These go through a reviewed change, not this page.</span>
        </div>
        <dl className="one-dl">
          <dt>Stripe</dt>
          <dd>
            {settings.stripe.connected
              ? `Connected in ${settings.stripe.mode ?? "test"} mode. Keys are never entered or shown here.`
              : "Not connected. When it is, this shows test or live mode. Keys are never entered or shown here."}
          </dd>
          <dt>Plans and prices</dt>
          <dd>Test plans only. The list lives in a reviewed file.</dd>
          <dt>Who can change billing</dt>
          <dd>People with the billing permission, granted by review.</dd>
        </dl>
      </section>
    </main>
  );
}
