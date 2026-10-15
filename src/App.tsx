import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Card, IssueCollection, IssueDetailPanel, Tabs, TabsContent, TabsList, TabsTrigger, type KanbanIssue } from "@kanbus/ui";
import { AccountsView } from "./AccountsView";
import { accountsBrowser } from "./accounts-client";
import { ApiError, KanbusClient, type Configuration, type IssueRecord, type Query } from "./client";
import { finishSignIn, getAccessToken, setLocalToken, signIn, signOut, type AuthenticationConfiguration } from "./auth";

const syntheticReview = import.meta.env.MODE === "synthetic-review";
const authentication: AuthenticationConfiguration | null = !syntheticReview && import.meta.env.VITE_COGNITO_CLIENT_ID ? {
  domain: import.meta.env.VITE_COGNITO_DOMAIN_URL,
  clientId: import.meta.env.VITE_COGNITO_CLIENT_ID,
  redirectUri: import.meta.env.VITE_COGNITO_REDIRECT_URI,
  logoutUri: import.meta.env.VITE_COGNITO_LOGOUT_URI,
  accountsBffUrl: import.meta.env.VITE_ACCOUNTS_BFF_URL,
} : null;
const api = new KanbusClient(`${(import.meta.env.VITE_KANBUS_API_URL ?? "").replace(/\/$/, "")}/api`, syntheticReview ? () => null : getAccessToken, undefined, syntheticReview);
import { isActiveStage, contactChanges, validateFollowUp } from "./prospect";
const directory = accountsBrowser(import.meta.env.VITE_ACCOUNTS_BFF_URL);
type View = "pipeline" | "followups" | "customers" | "accounts";

export function App() {
  const [signedIn, setSignedIn] = useState(syntheticReview || (!/[?&](code|error)=/.test(window.location.search) && Boolean(getAccessToken())));
  const [accessDenied, setAccessDenied] = useState(false);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [records, setRecords] = useState<IssueRecord[]>([]);
  const [selected, setSelected] = useState<IssueRecord | null>(null);
  const [view, setView] = useState<View>(new URLSearchParams(window.location.search).get("view") === "accounts" ? "accounts" : "pipeline");
  const [layout, setLayout] = useState<"board" | "list">("board");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestSequence = useRef(0);

  useEffect(() => {
    if (authentication) void finishSignIn(authentication).then(() => { setSignedIn(Boolean(getAccessToken())); if (new URLSearchParams(window.location.search).get("view") === "accounts") setView("accounts"); }).catch((cause: Error) => setError(cause.message));
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    void api.config().then(setConfiguration).catch((cause: Error) => {
      setAccessDenied(cause instanceof ApiError && cause.status === 403);
      setError(cause.message);
    });
  }, [signedIn]);

  const query = useMemo<Query>(() => ({
    type: "prospect", search, limit: 100,
    ...(view === "customers" ? { status: "customer" } : {}),
    ...(view === "followups" && configuration ? { assignee: configuration.actor_id, fields: [{ field: "custom.next_follow_up_at", operator: "lte" as const, value: new Date().toISOString().slice(0, 10) }] } : {}),
  }), [view, search, configuration]);

  const refresh = useCallback(async (next?: string) => {
    const sequence = ++requestSequence.current;
    try {
      const result = await api.issues({ ...query, ...(next ? { cursor: next } : {}) });
      if (requestSequence.current !== sequence) return;
      const issues = view === "followups" && configuration ? result.issues.filter((record) => isActiveStage(record.issue.status, configuration)) : result.issues;
      setRecords((previous) => next ? [...previous, ...issues] : issues);
      setCursor(result.next_cursor);
    } catch (cause) { if (requestSequence.current === sequence) setError((cause as Error).message); }
  }, [query, view, configuration]);

  useEffect(() => { if (configuration && view !== "accounts") void refresh(); }, [configuration, refresh, view]);

  async function write(action: () => Promise<IssueRecord>) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await action();
      requestSequence.current += 1;
      setSelected(result); setCreating(false);
      setRecords((previous) => [...previous.filter((record) => record.issue.id !== result.issue.id), result]);
      if (result.catalog_pending) setNotice("Saved. The shared view is catching up; this record contains your latest changes.");
      else { setNotice("Saved."); await refresh(); }
      return true;
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409
        ? "Someone changed this prospect. Reload the latest record before saving again."
        : (cause as Error).message);
      return false;
    } finally { setBusy(false); }
  }

  function createProspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    if (!configuration) return;
    const custom = contactChanges(fields);
    const problem = validateFollowUp(configuration.initial_status, String(fields.get("assignee")), custom.next_action, custom.next_follow_up_at ?? "", configuration);
    if (problem) { setError(problem); return; }
    void write(() => api.create({ title: String(fields.get("title")), type: "prospect", assignee: String(fields.get("assignee")).trim(), description: String(fields.get("description")), custom }));
  }

  function saveProspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !configuration) return;
    const fields = new FormData(event.currentTarget);
    const status = String(fields.get("status"));
    const custom = contactChanges(fields, selected.issue);
    const problem = validateFollowUp(status, String(fields.get("assignee")), custom.next_action, custom.next_follow_up_at ?? "", configuration);
    if (problem) { setError(problem); return; }
    void write(() => api.update(selected.issue.id, selected.revision, { status, assignee: String(fields.get("assignee")).trim(), custom: { ...custom, ...(status === "customer" && selected.issue.status !== "customer" && !selected.issue.custom?.converted_at ? { converted_at: new Date().toISOString() } : {}) } }));
  }

  function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const text = String(new FormData(form).get("note"));
    void write(() => api.comment(selected.issue.id, selected.revision, text)).then((saved) => { if (saved) form.reset(); });
  }

  if (!signedIn) return <main className="sign-in">
    <p className="eyebrow">Anthus</p><h1>Prospectus</h1><p>Your sales conversations, with a clear next step.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {authentication ? <button onClick={() => void signIn(authentication).catch((cause: Error) => setError(cause.message))}>Sign in with Google</button>
      : import.meta.env.DEV ? <form onSubmit={(event) => { event.preventDefault(); setLocalToken(String(new FormData(event.currentTarget).get("token"))); setSignedIn(true); }}><label>Local access token<input name="token" type="password" required autoComplete="off" /></label><button>Open local workspace</button></form>
      : <p>Workspace sign-in has not been configured.</p>}
    <small>Private workspace · Sign in with Google, then request workspace access.</small>
  </main>;

  if (accessDenied && view !== "accounts") return <main className="sign-in">
    <p className="eyebrow">Anthus · Prospectus</p><h1>Workspace access pending</h1>
    <p>You are signed in. An administrator must assign workspace access before you can view prospects.</p>
    <p>If access was just assigned, refresh your sign-in to load the new permissions.</p>
    {authentication && <button onClick={() => void signIn(authentication).catch((cause: Error) => setError(cause.message))}>Refresh access</button>}
    <button onClick={() => setView("accounts")}>View SaaS accounts</button>
    <button className="quiet" onClick={() => signOut(authentication)}>Sign out</button>
  </main>;

  return <Tabs value={view} onValueChange={(value) => { setView(value as View); setSelected(null); }} className="application kb-theme-organizer">
    {syntheticReview && <p className="demo-notice"><strong>LAN synthetic review only.</strong> Made-up .invalid contacts only. No email, accounts, or production records.</p>}
    <header><div><p className="eyebrow">Anthus</p><h1>Prospectus</h1></div><div className="header-actions">{syntheticReview ? <a href="/request-demo">Synthetic inquiry form</a> : <button className="quiet" onClick={() => signOut(authentication)}>Sign out</button>}{view !== "accounts" && <button onClick={() => { setCreating(true); setSelected(null); }}>New prospect</button>}</div></header>

    <div className="toolbar"><TabsList aria-label="Workspace views">{([['pipeline', 'Pipeline'], ['followups', 'My due follow-ups'], ['customers', 'Customers'], ['accounts', 'Accounts']] as const).map(([key, label]) => <TabsTrigger key={key} value={key}>{label}</TabsTrigger>)}</TabsList>{view !== "accounts" && <div className="filters"><input type="search" aria-label="Search prospects" placeholder="Search conversations" value={search} onChange={(event) => setSearch(event.target.value)} /><select aria-label="Layout" value={layout} onChange={(event) => setLayout(event.target.value as "board" | "list")}><option value="board">Board</option><option value="list">List</option></select><button className="quiet" onClick={() => void refresh()}>Refresh</button></div>}</div>
    {view !== "accounts" && error && <div role="alert" className="error">{error}{selected && <button className="quiet" onClick={() => void api.issue(selected.issue.id).then((record) => { setSelected(record); setError(""); })}>Reload latest record</button>}</div>}
    {view !== "accounts" && notice && <p role="status" className="notice">{notice}</p>}
    {view === "accounts" ? <TabsContent value="accounts"><AccountsView client={directory} onConnect={async () => { if (!authentication) throw new Error("Sign-in is not configured."); await signIn(authentication, await directory.challenge()); }} /></TabsContent> : <TabsContent value={view} asChild><main className="workspace"><section className="collection" aria-label="Prospect workspace">{configuration ? <IssueCollection issues={records.map((record) => record.issue)} config={configuration} query={query} view={layout} selectedIssueId={selected?.issue.id} onSelectIssue={(issue: KanbanIssue) => { setSelected(records.find((record) => record.issue.id === issue.id) ?? null); setCreating(false); }} initialScroll="start" detailOpen={Boolean(selected || creating)} columnStateKey={`prospectus:anthus:${configuration.actor_id}:pipeline`} emptyMessage="No prospects match this view." /> : <p>Loading workspace…</p>}{cursor && <button onClick={() => void refresh(cursor)}>Load more</button>}</section>
      {creating && <aside><Card className="prospect-panel"><div className="panel-heading"><h2>New prospect</h2><button className="quiet" onClick={() => setCreating(false)}>Close</button></div><form onSubmit={createProspect}><fieldset disabled={busy}><label>Name<input name="title" required maxLength={250} /></label><label>Company<input name="company" /></label><label>Email<input name="email" type="email" /></label><label>Owner<input name="assignee" defaultValue={configuration?.actor_id} required /></label><label>Next action<input name="next_action" defaultValue="Follow up" required maxLength={250} /></label><label>Next follow-up<input name="followup" type="date" required /></label><label>Conversation<textarea name="description" rows={4} /></label><button disabled={busy}>{busy ? "Saving…" : "Create prospect"}</button></fieldset></form></Card></aside>}
      {selected && configuration && <aside key={`${selected.issue.id}-${selected.revision}`}><IssueDetailPanel issue={selected.issue} onClose={() => setSelected(null)} className="prospect-panel" fields={[{ label: "Company", value: String(selected.issue.custom?.company ?? "") }, { label: "Contact", value: String(selected.issue.custom?.contact_email ?? "") }]}><form onSubmit={saveProspect}><fieldset disabled={busy}><label>Company<input name="company" defaultValue={String(selected.issue.custom?.company ?? "")} maxLength={150} /></label><label>Email<input name="email" type="email" defaultValue={String(selected.issue.custom?.contact_email ?? "")} maxLength={254} /></label><label>Stage<select name="status" defaultValue={selected.issue.status}>{configuration.statuses.filter((status) => status.key === selected.issue.status || (configuration.workflows?.prospect ?? configuration.workflows?.default)?.[selected.issue.status]?.includes(status.key)).map((status) => <option key={status.key} value={status.key}>{status.name}</option>)}</select></label><label>Owner<input name="assignee" defaultValue={selected.issue.assignee} required /></label><label>Next action<input name="next_action" defaultValue={String(selected.issue.custom?.next_action ?? "")} maxLength={250} /></label><label>Next follow-up<input name="followup" type="date" defaultValue={String(selected.issue.custom?.next_follow_up_at ?? "")} /></label><button disabled={busy}>Save changes</button></fieldset></form><InquiryHistory custom={selected.issue.custom} /><h3>Conversation</h3><ol className="notes">{selected.issue.comments?.map((comment, index) => <li key={comment.id ?? index}><p>{comment.text}</p><small>{comment.author} · {new Date(comment.created_at).toLocaleString()}</small></li>)}</ol><form onSubmit={addNote}><label>Add a note<textarea name="note" rows={3} required /></label><button disabled={busy}>Add note</button></form></IssueDetailPanel></aside>}
    </main></TabsContent>}<footer>Prospectus · Powered by Kanbus</footer>
  </Tabs>;
}

function InquiryHistory({ custom }: { custom?: Record<string, unknown> }) {
  const inquiries = Array.isArray(custom?.inquiries) ? custom.inquiries.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
  if (!inquiries.length) return null;
  return <section aria-label="Website inquiries"><h3>Website inquiries</h3><ol className="notes">{inquiries.map((inquiry, index) => {
    const source = inquiry.source && typeof inquiry.source === "object" ? inquiry.source as Record<string, unknown> : {};
    const campaign = source.campaign && typeof source.campaign === "object" ? source.campaign as Record<string, unknown> : {};
    return <li key={String(inquiry.id ?? index)}><p>{String(inquiry.message ?? "")}</p><small>{String(inquiry.name ?? "")} · {String(inquiry.received_at ?? "")}<br />Source: {String(source.site_id ?? "Unknown")} / {String(source.form_id ?? "")}<br />{Object.entries(campaign).map(([key, value]) => `${key}: ${String(value)}`).join(" · ")}<br />Marketing opt-in: {inquiry.marketing_opt_in === true ? "Recorded" : "Not recorded"}</small></li>;
  })}</ol></section>;
}
