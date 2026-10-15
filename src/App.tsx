import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Card, IssueCollection, Tabs, TabsContent, TabsList, TabsTrigger, type KanbanIssue } from "@kanbus/ui";
import { ApiError, KanbusClient, type Configuration, type IssueRecord, type Query } from "./client";
import { finishSignIn, getAccessToken, setLocalToken, signIn, signOut, type AuthenticationConfiguration } from "./auth";

const authentication: AuthenticationConfiguration | null = import.meta.env.VITE_COGNITO_CLIENT_ID ? {
  domain: import.meta.env.VITE_COGNITO_DOMAIN_URL,
  clientId: import.meta.env.VITE_COGNITO_CLIENT_ID,
  redirectUri: import.meta.env.VITE_COGNITO_REDIRECT_URI,
  logoutUri: import.meta.env.VITE_COGNITO_LOGOUT_URI,
} : null;
const api = new KanbusClient(`${(import.meta.env.VITE_KANBUS_API_URL ?? "").replace(/\/$/, "")}/api`, getAccessToken);
type View = "pipeline" | "followups" | "customers";

export function App() {
  const [signedIn, setSignedIn] = useState(Boolean(getAccessToken()));
  const [accessDenied, setAccessDenied] = useState(false);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [records, setRecords] = useState<IssueRecord[]>([]);
  const [selected, setSelected] = useState<IssueRecord | null>(null);
  const [view, setView] = useState<View>("pipeline");
  const [layout, setLayout] = useState<"board" | "list">("board");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestSequence = useRef(0);

  useEffect(() => {
    if (authentication) void finishSignIn(authentication).then(() => setSignedIn(Boolean(getAccessToken()))).catch((cause: Error) => setError(cause.message));
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
      setRecords((previous) => next ? [...previous, ...result.issues] : result.issues);
      setCursor(result.next_cursor);
    } catch (cause) { if (requestSequence.current === sequence) setError((cause as Error).message); }
  }, [query]);

  useEffect(() => { if (configuration) void refresh(); }, [configuration, refresh]);

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
    void write(() => api.create({ title: String(fields.get("title")), type: "prospect", assignee: String(fields.get("assignee")), description: String(fields.get("description")), custom: { company: String(fields.get("company")), contact_email: String(fields.get("email")), next_follow_up_at: String(fields.get("followup")) || null } }));
  }

  function saveProspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const fields = new FormData(event.currentTarget);
    void write(() => api.update(selected.issue.id, selected.revision, { status: String(fields.get("status")), assignee: String(fields.get("assignee")), custom: { ...selected.issue.custom, next_follow_up_at: String(fields.get("followup")) || null } }));
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

  if (accessDenied) return <main className="sign-in">
    <p className="eyebrow">Anthus · Prospectus</p><h1>Workspace access pending</h1>
    <p>You are signed in. An administrator must assign workspace access before you can view prospects.</p>
    <p>If access was just assigned, refresh your sign-in to load the new permissions.</p>
    {authentication && <button onClick={() => void signIn(authentication).catch((cause: Error) => setError(cause.message))}>Refresh access</button>}
    <button className="quiet" onClick={() => signOut(authentication)}>Sign out</button>
  </main>;

  return <Tabs value={view} onValueChange={(value) => { setView(value as View); setSelected(null); }} className="application">
    <header><div><p className="eyebrow">Anthus</p><h1>Prospectus</h1></div><div className="header-actions"><button className="quiet" onClick={() => signOut(authentication)}>Sign out</button><button onClick={() => { setCreating(true); setSelected(null); }}>New prospect</button></div></header>
    <div className="toolbar"><TabsList aria-label="Workspace views">{([['pipeline', 'Pipeline'], ['followups', 'My due follow-ups'], ['customers', 'Customers']] as const).map(([key, label]) => <TabsTrigger key={key} value={key}>{label}</TabsTrigger>)}</TabsList><div className="filters"><input type="search" aria-label="Search prospects" placeholder="Search conversations" value={search} onChange={(event) => setSearch(event.target.value)} /><select aria-label="Layout" value={layout} onChange={(event) => setLayout(event.target.value as "board" | "list")}><option value="board">Board</option><option value="list">List</option></select><button className="quiet" onClick={() => void refresh()}>Refresh</button></div></div>
    {error && <div role="alert" className="error">{error}{selected && <button className="quiet" onClick={() => void api.issue(selected.issue.id).then((record) => { setSelected(record); setError(""); })}>Reload latest record</button>}</div>}
    {notice && <p role="status" className="notice">{notice}</p>}
    <TabsContent value={view} asChild><main className="workspace"><section className="collection" aria-label="Prospect workspace">{configuration ? <IssueCollection issues={records.map((record) => record.issue)} config={configuration} query={query} view={layout} selectedIssueId={selected?.issue.id} onSelectIssue={(issue: KanbanIssue) => { setSelected(records.find((record) => record.issue.id === issue.id) ?? null); setCreating(false); }} motion={{ mode: "static" }} /> : <p>Loading workspace…</p>}{configuration && records.length === 0 && <p className="empty">No prospects match this view.</p>}{cursor && <button onClick={() => void refresh(cursor)}>Load more</button>}</section>
      {creating && <aside><Card className="prospect-panel"><div className="panel-heading"><h2>New prospect</h2><button className="quiet" onClick={() => setCreating(false)}>Close</button></div><form onSubmit={createProspect}><label>Name<input name="title" required maxLength={250} /></label><label>Company<input name="company" /></label><label>Email<input name="email" type="email" /></label><label>Owner<input name="assignee" defaultValue={configuration?.actor_id} required /></label><label>Next follow-up<input name="followup" type="date" /></label><label>Conversation<textarea name="description" rows={4} /></label><button disabled={busy}>{busy ? "Saving…" : "Create prospect"}</button></form></Card></aside>}
      {selected && configuration && <aside key={`${selected.issue.id}-${selected.revision}`}><Card className="prospect-panel"><div className="panel-heading"><div><p className="eyebrow">{selected.issue.id}</p><h2>{selected.issue.title}</h2></div><button className="quiet" onClick={() => setSelected(null)}>Close</button></div><p>{String(selected.issue.custom?.company ?? "")}</p><p>{String(selected.issue.custom?.contact_email ?? "")}</p><p className="description">{selected.issue.description}</p><form onSubmit={saveProspect}><label>Stage<select name="status" defaultValue={selected.issue.status}>{configuration.statuses.filter((status) => status.key === selected.issue.status || (configuration.workflows?.prospect ?? configuration.workflows?.default)?.[selected.issue.status]?.includes(status.key)).map((status) => <option key={status.key} value={status.key}>{status.name}</option>)}</select></label><label>Owner<input name="assignee" defaultValue={selected.issue.assignee} required /></label><label>Next follow-up<input name="followup" type="date" defaultValue={String(selected.issue.custom?.next_follow_up_at ?? "")} /></label><button disabled={busy}>Save changes</button></form><h3>Conversation</h3><ol className="notes">{selected.issue.comments?.map((comment, index) => <li key={comment.id ?? index}><p>{comment.text}</p><small>{comment.author} · {new Date(comment.created_at).toLocaleString()}</small></li>)}</ol><form onSubmit={addNote}><label>Add a note<textarea name="note" rows={3} required /></label><button disabled={busy}>Add note</button></form></Card></aside>}
    </main></TabsContent><footer>Prospectus · Powered by Kanbus</footer>
  </Tabs>;
}
