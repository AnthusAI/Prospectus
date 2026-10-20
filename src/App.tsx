import { useCallback, useEffect, useState } from "react";
import { AccountsView } from "./AccountsView";
import { accountsBrowser } from "./accounts-client";
import { ApiError, KanbusClient, type Configuration, type IssueRecord } from "./client";
import {
  AccountsConfirmationError,
  finishSignIn,
  hasAttemptedAccountsConfirmation,
  getAccessToken,
  setLocalToken,
  signIn,
  signOut,
  type AuthenticationConfiguration,
} from "./auth";
import { AdminShell, PAGES, pageHref, readLocation, type Page } from "./admin/Shell";
import { PipelineView } from "./admin/PipelineView";
import { TodayView, type TodaySummary } from "./admin/TodayView";
import { BrandMark, Eyebrow, Unavailable, Wordmark } from "./admin/ui";

const syntheticReview = import.meta.env.MODE === "synthetic-review";
const authentication: AuthenticationConfiguration | null =
  !syntheticReview && import.meta.env.VITE_COGNITO_CLIENT_ID
    ? {
        domain: import.meta.env.VITE_COGNITO_DOMAIN_URL,
        clientId: import.meta.env.VITE_COGNITO_CLIENT_ID,
        redirectUri: import.meta.env.VITE_COGNITO_REDIRECT_URI,
        logoutUri: import.meta.env.VITE_COGNITO_LOGOUT_URI,
        accountsBffUrl: import.meta.env.VITE_ACCOUNTS_BFF_URL,
      }
    : null;
const api = new KanbusClient(
  `${(import.meta.env.VITE_KANBUS_API_URL ?? "").replace(/\/$/, "")}/api`,
  syntheticReview ? () => null : getAccessToken,
  undefined,
  syntheticReview,
);
const directory = accountsBrowser(import.meta.env.VITE_ACCOUNTS_BFF_URL);

const UNAVAILABLE_PAGES: Partial<Record<Page, string>> = {
  engagements: "Services engagements will be tracked here, inside the account each one is for.",
  billing:
    "Plans, quota use and invoices for every account will appear here once Anthus One records billing.",
  team: "Anthus staff and their CRM roles will be managed here. Roles are assigned in the identity service for now.",
  settings: "Workspace settings for Prospectus will live here.",
};

export function App() {
  const [signedIn, setSignedIn] = useState(
    syntheticReview || (!/[?&](code|error)=/.test(window.location.search) && Boolean(getAccessToken())),
  );
  // True while returning from Google: show progress, never the sign-in screen again.
  const [completingSignIn, setCompletingSignIn] = useState(
    () => Boolean(authentication) && /[?&](code|error)=/.test(window.location.search),
  );
  const [accessDenied, setAccessDenied] = useState(false);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [{ page, account }, setLocation] = useState(() => readLocation());
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<IssueRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [focusNextAction, setFocusNextAction] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);
  const [today, setToday] = useState<TodaySummary | null>(null);

  const navigate = useCallback((next: Page, nextAccount: string | null = null) => {
    window.history.pushState(null, "", pageHref(next, nextAccount));
    setLocation({ page: next, account: nextAccount });
    setError("");
    setNotice("");
    if (next !== "pipeline") {
      setSelected(null);
      setCreating(false);
    }
  }, []);
  useEffect(() => {
    const restore = () => setLocation(readLocation());
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    document.title = `${PAGES[page].label} · Prospectus · Anthus`;
  }, [page]);

  useEffect(() => {
    if (authentication)
      void finishSignIn(authentication, () => setSignedIn(true))
        .then(() => {
          setSignedIn(Boolean(getAccessToken()));
          setLocation(readLocation());
        })
        .catch((cause: Error) => {
          if (cause instanceof AccountsConfirmationError) {
            setSignedIn(Boolean(getAccessToken()));
            navigate("accounts");
          }
          setError(cause.message);
        })
        .finally(() => setCompletingSignIn(false));
  }, [navigate]);
  useEffect(() => {
    if (!signedIn) return;
    void api
      .config()
      .then(setConfiguration)
      .catch((cause: Error) => {
        setAccessDenied(cause instanceof ApiError && cause.status === 403);
        setError(cause.message);
      });
  }, [signedIn]);

  const reportError = useCallback((message: string) => {
    setNotice("");
    setError(message);
  }, []);

  async function write(action: () => Promise<IssueRecord>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await action();
      setSelected(result);
      setCreating(false);
      setFocusNextAction(false);
      setNotice(
        result.catalog_pending
          ? "Saved. The shared view is catching up; this record contains your latest changes."
          : "Saved.",
      );
      setVersion((value) => value + 1);
      return true;
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 409
          ? "Someone changed this prospect. Reload the latest record before saving again."
          : (cause as Error).message,
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openProspect(record: IssueRecord, nextStep = false) {
    navigate("pipeline");
    setSelected(record);
    setCreating(false);
    setFocusNextAction(nextStep);
    if (nextStep) setNotice("Set the next action and follow-up date, then save changes.");
  }

  if (!signedIn && completingSignIn && !error)
    return (
      <SignInFrame>
        <Eyebrow>•••••• Anthus · Prospectus</Eyebrow>
        <h1>Prospectus</h1>
        <p role="status">Signing you in…</p>
      </SignInFrame>
    );

  if (!signedIn)
    return (
      <SignInFrame>
        <Eyebrow>•••••• Anthus · Prospectus</Eyebrow>
        <h1>Prospectus</h1>
        <p>Your sales conversations and customer accounts, with a clear next step.</p>
        {error && (
          <p role="alert" className="one-alert">
            {error}
          </p>
        )}
        {authentication ? (
          <button
            type="button"
            className="one-button primary tall"
            onClick={() => void signIn(authentication).catch((cause: Error) => setError(cause.message))}
          >
            Sign in with Google
          </button>
        ) : import.meta.env.DEV ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setLocalToken(String(new FormData(event.currentTarget).get("token")));
              setSignedIn(true);
            }}
          >
            <label>
              Local access token
              <input name="token" type="password" required autoComplete="off" />
            </label>
            <button className="one-button primary tall">Open local workspace</button>
          </form>
        ) : (
          <p>Workspace sign-in has not been configured.</p>
        )}
        {!authentication && import.meta.env.DEV ? (
          <small>
            Local preview · Google sign-in is off here. Paste the token that npm run preview:local wrote to
            local-data/review-token.txt.
          </small>
        ) : (
          <small>Private workspace · Sign in with Google, then request workspace access.</small>
        )}
      </SignInFrame>
    );

  // The admin console is for Anthus staff only: without CRM access, nothing of it is shown.
  if (accessDenied)
    return (
      <SignInFrame>
        <Eyebrow>•••••• Anthus · Prospectus</Eyebrow>
        <h1>Workspace access pending</h1>
        <p>
          You are signed in. Prospectus is the Anthus staff console; an administrator must assign workspace
          access before you can use it.
        </p>
        <p>If access was just assigned, refresh your sign-in to load the new permissions.</p>
        {authentication && (
          <button
            type="button"
            className="one-button primary tall"
            onClick={() => void signIn(authentication).catch((cause: Error) => setError(cause.message))}
          >
            Refresh access
          </button>
        )}
        <button type="button" className="one-button tall" onClick={() => signOut(authentication)}>
          Sign out
        </button>
      </SignInFrame>
    );

  if (!configuration)
    return (
      <SignInFrame>
        <Eyebrow>•••••• Anthus · Prospectus</Eyebrow>
        <h1>Prospectus</h1>
        {error ? (
          <p role="alert" className="one-alert">
            {error}
          </p>
        ) : (
          <p role="status">Checking workspace access…</p>
        )}
        <button type="button" className="one-button tall" onClick={() => signOut(authentication)}>
          Sign out
        </button>
      </SignInFrame>
    );

  const person = configuration.actor_id;
  return (
    <AdminShell
      page={page}
      onNavigate={(next) => navigate(next)}
      counts={today ? { today: { value: today.due, alert: today.overdue > 0 } } : {}}
      search={search}
      onSearch={(value) => {
        setSearch(value);
        if (page === "today" || UNAVAILABLE_PAGES[page]) navigate("pipeline");
      }}
      searchPlaceholder={page === "accounts" ? "Search accounts" : "Search prospects"}
      onNewProspect={() => {
        navigate("pipeline");
        setSelected(null);
        setCreating(true);
      }}
      person={person}
      onSignOut={syntheticReview ? undefined : () => signOut(authentication)}
      banner={
        syntheticReview && (
          <p className="one-demo">
            <strong>LAN synthetic review only.</strong> Made-up .invalid contacts only. No email, accounts, or
            production records. <a href="/request-demo">Synthetic inquiry form</a>
          </p>
        )
      }
    >
      <div style={{ flex: "999 1 560px", minWidth: 0, display: "flex", flexDirection: "column" }}>
        {page !== "accounts" && (error || notice) && (
          <div style={{ padding: "16px 28px 0" }}>
            {error ? (
              <div role="alert" className="one-alert">
                <span>{error}</span>
                {selected && (
                  <button
                    type="button"
                    className="one-button small"
                    onClick={() =>
                      void api.issue(selected.issue.id).then((record) => {
                        setSelected(record);
                        setError("");
                      })
                    }
                  >
                    Reload latest record
                  </button>
                )}
              </div>
            ) : (
              <p role="status" className="one-status notice">
                {notice}
              </p>
            )}
          </div>
        )}
        {page === "accounts" ? (
          <AccountsView
            client={directory}
            search={search}
            account={account}
            onAccountChange={(id) => navigate("accounts", id)}
            automaticConfirmationAllowed={() => !hasAttemptedAccountsConfirmation()}
            onConnect={async () => {
              if (!authentication) throw new Error("Sign-in is not configured.");
              await signIn(authentication, await directory.challenge());
            }}
          />
        ) : UNAVAILABLE_PAGES[page] ? (
          <main className="one-main narrow" aria-label={PAGES[page].label}>
            <div className="one-pagehead">
              <div>
                <Eyebrow>
                  •••••• {PAGES[page].group} / {PAGES[page].label}
                </Eyebrow>
                <h1>{PAGES[page].label}</h1>
              </div>
            </div>
            <Unavailable title="Not yet available">
              <span>{UNAVAILABLE_PAGES[page]}</span>
            </Unavailable>
          </main>
        ) : page === "today" ? (
          <TodayView
            api={api}
            configuration={configuration}
            version={version}
            write={write}
            busy={busy}
            onOpen={(record) => openProspect(record)}
            onComplete={(record) => openProspect(record, true)}
            onNavigatePipeline={() => navigate("pipeline")}
            onNavigateAccounts={() => navigate("accounts")}
            onSummary={setToday}
            onError={reportError}
          />
        ) : (
          <PipelineView
            api={api}
            configuration={configuration}
            version={version}
            search={search}
            selected={selected}
            onSelect={(record) => {
              setSelected(record);
              setFocusNextAction(false);
            }}
            creating={creating}
            onCreating={setCreating}
            busy={busy}
            write={write}
            onError={reportError}
            focusNextAction={focusNextAction}
          />
        )}
      </div>
    </AdminShell>
  );
}

function SignInFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="one one-signin">
      <div className="one-stripe" aria-hidden="true" />
      <header className="one-header">
        <span className="one-brand">
          <BrandMark />
          <Wordmark />
        </span>
        <span className="one-tag">ADMIN · PROSPECTUS</span>
      </header>
      <div className="one-signin-body">
        <main className="one-signin-card sign-in">{children}</main>
      </div>
    </div>
  );
}
