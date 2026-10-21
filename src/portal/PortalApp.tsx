import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { accountsBrowser } from "../accounts-client";
import {
  REFRESH_BEFORE_EXPIRY_MS,
  clearPortalSession,
  enrollIfFresh,
  getIdToken,
  requestCredential,
  sessionExpiresAt,
  signOutOfPortal,
} from "./google-auth";
import type { DirectoryDetail, DirectoryList } from "../../packages/accounts-client/src/directory";
import { BrandMark, Eyebrow, Wordmark } from "../shared/ui";
import { PortalShell, PORTAL_PAGES, portalHref, readPortalLocation, type PortalPage } from "./PortalShell";
import { AppsPage, HomePage, PeoplePage, SettingsPage, UnavailablePage } from "./pages";
import { usePortalTheme } from "./theme";

/** The Anthus One Google OAuth client (a public identifier). Without it this copy of the portal cannot sign in. */
const googleClientId: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
const accountsBffUrl: string = import.meta.env.VITE_ACCOUNTS_BFF_URL ?? "";
const directory = accountsBrowser(accountsBffUrl, fetch, getIdToken);

/** The Anthus One customer portal. It reads only the signed-in person's own workspaces. */
export function PortalApp() {
  const [theme, setTheme] = usePortalTheme();
  const [signedIn, setSignedIn] = useState(() => Boolean(getIdToken()));
  const [credentialVersion, setCredentialVersion] = useState(0);
  const refreshing = useRef(false);
  const [location, setLocation] = useState(() => readPortalLocation());
  const [list, setList] = useState<DirectoryList | null>(null);
  const [detail, setDetail] = useState<DirectoryDetail | null>(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [reload, setReload] = useState(0);

  const navigate = useCallback((page: PortalPage, workspace: string | null) => {
    window.history.pushState(null, "", portalHref(page, workspace));
    setLocation({ page, workspace });
  }, []);
  useEffect(() => {
    const restore = () => setLocation(readPortalLocation());
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  const credentialArrived = useCallback(() => {
    setError("");
    setSignedIn(true);
    setCredentialVersion((value) => value + 1);
  }, []);
  const startCredential = useCallback(
    (button: HTMLElement | null, prompt: boolean) =>
      requestCredential({
        clientId: googleClientId,
        loginChallenge: (digest) => directory.loginChallenge(digest),
        onCredential: credentialArrived,
        button,
        prompt,
      }),
    [credentialArrived],
  );

  // A Google ID token lasts about an hour. Ask Google for a new one shortly before it ends; if that needs the person,
  // it simply expires and they are returned to the sign-in page.
  useEffect(() => {
    if (!signedIn) return;
    const timer = window.setInterval(() => {
      const expiresAt = sessionExpiresAt();
      if (!getIdToken() || !expiresAt) {
        clearPortalSession();
        setSignedIn(false);
        setList(null);
        setDetail(null);
        return;
      }
      if (googleClientId && expiresAt - Date.now() < REFRESH_BEFORE_EXPIRY_MS && !refreshing.current) {
        refreshing.current = true;
        void startCredential(null, true)
          .catch(() => undefined)
          .finally(() => window.setTimeout(() => (refreshing.current = false), 60_000));
      }
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [signedIn, startCredential]);

  useEffect(() => {
    if (!signedIn) return;
    let current = true;
    setList(null);
    void directory
      .list()
      .then(async (value) => {
        // A sign-in that has just answered a fresh server challenge confirms itself once: this links the Google
        // account to its Prospectus Person and grants nothing.
        if (
          value.person === null &&
          accountsBffUrl &&
          (await enrollIfFresh(accountsBffUrl).catch(() => false))
        )
          return directory.list();
        return value;
      })
      .then((value) => current && setList(value))
      .catch(
        () =>
          current &&
          setError(
            directory.configured
              ? "Your workspaces could not be loaded. Try again."
              : "The account service has not been configured.",
          ),
      );
    return () => {
      current = false;
    };
  }, [signedIn, reload, credentialVersion]);

  const workspaces = list?.accounts ?? [];
  const workspaceId =
    workspaces.find((account) => account.id === location.workspace)?.id ?? workspaces[0]?.id ?? null;
  useEffect(() => {
    if (!workspaceId) return;
    let current = true;
    setDetail(null);
    setDetailError("");
    void directory
      .detail(workspaceId)
      .then((value) => current && setDetail(value))
      .catch(
        () =>
          current &&
          setDetailError("This workspace could not be loaded, or your access has changed. Try again."),
      );
    return () => {
      current = false;
    };
  }, [workspaceId, reload]);

  useEffect(() => {
    const workspace = workspaces.find((account) => account.id === workspaceId);
    document.title = `${PORTAL_PAGES[location.page].label}${workspace ? ` · ${workspace.name}` : ""} · Anthus One`;
  }, [location.page, workspaceId, workspaces]);

  function signOut() {
    signOutOfPortal();
    setSignedIn(false);
    setList(null);
    setDetail(null);
    setError("");
  }

  if (!signedIn)
    return (
      <SignInPage
        theme={theme}
        error={error}
        start={googleClientId && accountsBffUrl ? (button) => startCredential(button, true) : undefined}
        onError={setError}
      />
    );

  if (!list)
    return (
      <Frame theme={theme}>
        <h1>Anthus One</h1>
        {error ? (
          <p role="alert" className="one-alert">
            {error}
            <button
              type="button"
              className="one-button small"
              onClick={() => setReload((value) => value + 1)}
            >
              Try again
            </button>
          </p>
        ) : (
          <p role="status">Loading your workspaces…</p>
        )}
        <button type="button" className="one-button tall" onClick={signOut}>
          Sign out
        </button>
      </Frame>
    );

  if (!list.person)
    return (
      <Frame theme={theme}>
        <Eyebrow>•••••• One sign-in · every app</Eyebrow>
        <h1>Confirm it’s you</h1>
        <p>
          Confirm this Google sign-in once to load the Anthus workspaces you belong to. This does not create a
          workspace or grant any access.
        </p>
        {error && (
          <p role="alert" className="one-alert">
            {error}
          </p>
        )}
        <GoogleButton start={(button) => startCredential(button, false)} onError={setError} />
        <button type="button" className="one-button tall" onClick={signOut}>
          Sign out
        </button>
      </Frame>
    );

  if (!workspaces.length)
    return (
      <Frame theme={theme}>
        <Eyebrow>•••••• Welcome to Anthus One</Eyebrow>
        <h1>You don’t have a workspace yet</h1>
        <p>
          A workspace holds your apps, your people and one shared quota. Ask the owner of an existing Anthus
          workspace to add you, then sign in again.
        </p>
        <div className="one-unavailable" role="note">
          <strong>Creating a workspace here is not yet available.</strong>
          <span>Until it is, Anthus sets up new workspaces for you.</span>
        </div>
        <button type="button" className="one-button tall" onClick={signOut}>
          Sign out
        </button>
      </Frame>
    );

  const workspace = workspaces.find((account) => account.id === workspaceId)!;
  const page = location.page;
  let content: ReactNode;
  if (detailError)
    content = (
      <main className="one-main narrow">
        <p role="alert" className="one-alert">
          {detailError}
          <button type="button" className="one-button small" onClick={() => setReload((value) => value + 1)}>
            Try again
          </button>
        </p>
      </main>
    );
  else if (page === "home")
    content = (
      <HomePage workspace={workspace} detail={detail} onNavigate={(next) => navigate(next, workspace.id)} />
    );
  else if (page === "apps") content = <AppsPage workspace={workspace} detail={detail} />;
  else if (page === "people") content = <PeoplePage detail={detail} personId={list.person.id} />;
  else if (page === "settings")
    content = <SettingsPage workspace={workspace} detail={detail} theme={theme} onTheme={setTheme} />;
  else content = <UnavailablePage page={page} />;

  return (
    <PortalShell
      theme={theme}
      page={page}
      workspaces={workspaces}
      workspace={workspace}
      personId={list.person.id}
      onNavigate={(next) => navigate(next, workspace.id)}
      onWorkspace={(id) => navigate(page, id)}
      onSignOut={signOut}
    >
      {content}
    </PortalShell>
  );
}

function Frame({ theme, children }: { theme: string; children: ReactNode }) {
  return (
    <div className="one one-signin" data-theme={theme}>
      <div className="one-stripe portal" aria-hidden="true" />
      <header className="one-header">
        <span className="one-brand">
          <BrandMark />
          <Wordmark />
        </span>
      </header>
      <div className="one-signin-body">
        <main className="one-signin-card">{children}</main>
      </div>
    </div>
  );
}

/** Draws Google's own sign-in button; each press of it answers a fresh server challenge. */
function GoogleButton({
  start,
  onError,
}: {
  start: (button: HTMLElement | null) => Promise<void>;
  onError: (message: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    void start(container.current).catch((cause: Error) => {
      if (current)
        onError(
          cause.message.startsWith("Google")
            ? cause.message
            : "Sign-in is not available right now. Please try again.",
        );
    });
    return () => {
      current = false;
    };
    // `start` is stable for the page's lifetime; a retry draws the button again with a new challenge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);
  return (
    <div className="portal-google">
      <div ref={container} />
      <button type="button" className="one-button small" onClick={() => setAttempt((value) => value + 1)}>
        Reload sign-in
      </button>
    </div>
  );
}

function SignInPage({
  theme,
  error,
  start,
  onError,
}: {
  theme: string;
  error: string;
  start?: (button: HTMLElement | null) => Promise<void>;
  onError: (message: string) => void;
}) {
  return (
    <div className="one portal-signin" data-theme={theme}>
      <div className="one-stripe portal" aria-hidden="true" />
      <div className="portal-signin-split">
        <aside className="portal-signin-pitch">
          <span className="one-brand">
            <BrandMark />
            <span className="one-wordmark portal-wordmark">
              Anthus <span>One</span>
            </span>
          </span>
          <div className="portal-signin-copy">
            <Eyebrow>•••••• One sign-in · one quota · every app</Eyebrow>
            <h1>Every Anthus app, in one place.</h1>
            <p>We host the apps; you get one place to open them, see your workspace and manage your team.</p>
          </div>
          <span className="one-muted portal-made-by">
            Made by Anthus AI Solutions · <a href="https://anth.us">anth.us</a>
          </span>
        </aside>
        <main className="portal-signin-main">
          <div className="portal-signin-form">
            <h2>Sign in</h2>
            <p className="one-muted">Use the Google account you use for your Anthus apps.</p>
            {error && (
              <p role="alert" className="one-alert">
                {error}
              </p>
            )}
            {start ? (
              <GoogleButton start={start} onError={onError} />
            ) : (
              <p role="status">Sign-in has not been configured for this copy of the portal.</p>
            )}
            <div className="one-unavailable" role="note">
              <strong>New to Anthus?</strong>
              <span>
                Creating a workspace here is not yet available. Anthus sets up new workspaces for you.
              </span>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
