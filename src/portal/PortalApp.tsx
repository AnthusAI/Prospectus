import { useCallback, useEffect, useState, type ReactNode } from "react";
import { accountsBrowser } from "../accounts-client";
import {
  AccountsConfirmationError,
  finishSignIn,
  getAccessToken,
  signIn,
  signOut,
  type AuthenticationConfiguration,
} from "../auth";
import type { DirectoryDetail, DirectoryList } from "../../packages/accounts-client/src/directory";
import { BrandMark, Eyebrow, Wordmark } from "../shared/ui";
import { PortalShell, PORTAL_PAGES, portalHref, readPortalLocation, type PortalPage } from "./PortalShell";
import { AppsPage, HomePage, PeoplePage, SettingsPage, UnavailablePage } from "./pages";
import { usePortalTheme } from "./theme";

const authentication: AuthenticationConfiguration | null = import.meta.env.VITE_COGNITO_CLIENT_ID
  ? {
      domain: import.meta.env.VITE_COGNITO_DOMAIN_URL,
      clientId: import.meta.env.VITE_COGNITO_CLIENT_ID,
      redirectUri: import.meta.env.VITE_COGNITO_REDIRECT_URI,
      logoutUri: import.meta.env.VITE_COGNITO_LOGOUT_URI,
      accountsBffUrl: import.meta.env.VITE_ACCOUNTS_BFF_URL,
    }
  : null;
const directory = accountsBrowser(import.meta.env.VITE_ACCOUNTS_BFF_URL);

/** The Anthus One customer portal. It reads only the signed-in person's own workspaces. */
export function PortalApp() {
  const [theme, setTheme] = usePortalTheme();
  const [signedIn, setSignedIn] = useState(
    () => !/[?&](code|error)=/.test(window.location.search) && Boolean(getAccessToken()),
  );
  const [completingSignIn, setCompletingSignIn] = useState(
    () => Boolean(authentication) && /[?&](code|error)=/.test(window.location.search),
  );
  const [location, setLocation] = useState(() => readPortalLocation());
  const [list, setList] = useState<DirectoryList | null>(null);
  const [detail, setDetail] = useState<DirectoryDetail | null>(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [connecting, setConnecting] = useState(false);
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

  useEffect(() => {
    if (!authentication) return;
    void finishSignIn(authentication, () => setSignedIn(true))
      .then(() => {
        window.history.replaceState(null, "", portalHref("home", null));
        setLocation(readPortalLocation());
      })
      .catch((cause: Error) => {
        if (cause instanceof AccountsConfirmationError) {
          window.history.replaceState(null, "", portalHref("home", null));
          setSignedIn(Boolean(getAccessToken()));
        }
        setError(cause.message);
      })
      .finally(() => setCompletingSignIn(false));
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    let current = true;
    setList(null);
    void directory
      .list()
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
  }, [signedIn, reload]);

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

  async function confirm() {
    if (!authentication) return;
    setConnecting(true);
    setError("");
    try {
      await signIn(authentication, await directory.challenge());
    } catch {
      setConnecting(false);
      setError("Google confirmation could not be started. Please try again.");
    }
  }

  if (!signedIn && completingSignIn && !error)
    return (
      <Frame theme={theme}>
        <h1>Anthus One</h1>
        <p role="status">Signing you in…</p>
      </Frame>
    );

  if (!signedIn)
    return (
      <SignInPage
        theme={theme}
        error={error}
        onSignIn={
          authentication
            ? () => void signIn(authentication).catch((cause: Error) => setError(cause.message))
            : undefined
        }
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
        <button type="button" className="one-button tall" onClick={() => signOut(authentication)}>
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
        <button
          type="button"
          className="one-button primary tall"
          disabled={connecting}
          onClick={() => void confirm()}
        >
          {connecting ? "Opening Google…" : "Continue with Google"}
        </button>
        <button type="button" className="one-button tall" onClick={() => signOut(authentication)}>
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
        <button type="button" className="one-button tall" onClick={() => signOut(authentication)}>
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
      onSignOut={() => signOut(authentication)}
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

function SignInPage({ theme, error, onSignIn }: { theme: string; error: string; onSignIn?: () => void }) {
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
            {onSignIn ? (
              <button type="button" className="one-button primary tall portal-google" onClick={onSignIn}>
                Continue with Google
              </button>
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
