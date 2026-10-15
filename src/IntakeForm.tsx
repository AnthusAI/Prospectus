import { operationId } from "./operation-id";
import { useRef, useState, type FormEvent } from "react";

export function IntakeForm() {
  const hosted = Boolean(import.meta.env.VITE_INTAKE_EVALUATION_URL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const pending = useRef<{ id: string; body: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    const fields = new FormData(event.currentTarget);
    const campaign: Record<string, string> = {};
    const parameters = new URLSearchParams(window.location.search);
    for (const key of ["utm_source", "utm_medium", "utm_campaign"]) {
      const value = parameters.get(key);
      if (value && /^[\w .-]{1,120}$/.test(value)) campaign[key] = value;
    }
    const body = JSON.stringify({ name: String(fields.get("name")), email: String(fields.get("email")), company: String(fields.get("company")), message: String(fields.get("message")), website: String(fields.get("website")), notice_version: "synthetic-demo-v1", marketing_opt_in: fields.get("marketing") === "on", page_path: "/request-demo", campaign });
    if (!pending.current || pending.current.body !== body) pending.current = { id: operationId(), body };
    try {
      const response = await fetch(import.meta.env.VITE_INTAKE_EVALUATION_URL || "/intake/demo", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit", body: JSON.stringify({ ...JSON.parse(body), submission_id: pending.current.id }) });
      const result = await response.json() as { receipt?: string; message?: string };
      if (!response.ok) throw new Error(result.message ?? "The demo request could not be saved. Retry without changing the fields.");
      setReceipt(result.receipt ?? pending.current.id);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <main className="intake-page">
    <p className="eyebrow">Prospectus · Inquiry evaluation</p><h1>Try a demo inquiry</h1>
    <p>See a request become a conversation with an owner and a next step.</p>
    <div className="demo-notice"><strong>Synthetic data only.</strong> Use a made-up name, company, message, and an email ending in <code>.invalid</code>. This saves a demo prospect. It sends no email, creates no account, and grants no workspace access.</div>
    {receipt ? <section role="status" aria-live="polite"><h2>Demo request received</h2><p>Your synthetic inquiry was saved for follow-up in the evaluation workspace.</p><p className="receipt">Receipt: {receipt}</p><button onClick={() => { pending.current = null; setReceipt(""); }}>Try another inquiry</button><p><a href="/">{hosted ? "Open private workspace" : "Open synthetic workspace"}</a></p></section> : <form onSubmit={(event) => void submit(event)}>
      {error && <p role="alert" className="error">{error}</p>}
      <label>Name<input name="name" required maxLength={150} autoComplete="off" placeholder="Alex Example" /></label>
      <label>Email<input name="email" type="email" required maxLength={254} pattern={"[^\\s@]+@(?:[a-zA-Z0-9\\-]+\\.)+[iI][nN][vV][aA][lL][iI][dD]"} title="Use a synthetic address such as alex@example.invalid" autoComplete="off" placeholder="alex@example.invalid" /></label>
      <label>Company <span className="optional">Optional</span><input name="company" maxLength={150} autoComplete="off" placeholder="Example Studio" /></label>
      <label>What would you like to discuss?<textarea name="message" required maxLength={3000} rows={4} placeholder="A made-up demo request" /></label>
      <div className="honeypot" aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
      <label className="checkbox"><input type="checkbox" name="marketing" /><span>Record a simulated marketing opt-in. No messages will be sent.</span></label>
      <p className="privacy-note">Demo notice v1: synthetic details and source tags are saved for inquiry follow-up. {hosted ? "CRM records require authorized workspace access." : "This synthetic review is available only on its configured local network."} Do not enter real personal information.</p>
      <button disabled={busy}>{busy ? "Saving demo request…" : "Send demo inquiry"}</button>
    </form>}
    <footer><a href="/">Synthetic workspace</a></footer>
  </main>;
}
