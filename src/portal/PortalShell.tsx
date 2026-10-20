import { useState, type ReactNode } from "react";
import type { DirectoryAccount } from "../../packages/accounts-client/src/directory";
import { appForProduct, productUrl } from "../apps";
import { initials } from "../shared/initials";
import { BrandMark, Eyebrow, Icon, Wordmark, type IconName } from "../shared/ui";

export type PortalPage = "home" | "apps" | "usage" | "plans" | "people" | "keys" | "settings";

export const PORTAL_PAGES: Record<PortalPage, { label: string; icon: IconName }> = {
  home: { label: "Home", icon: "home" },
  apps: { label: "Apps", icon: "apps" },
  usage: { label: "Usage", icon: "usage" },
  plans: { label: "Plan and billing", icon: "billing" },
  people: { label: "People and bots", icon: "team" },
  keys: { label: "API keys", icon: "keys" },
  settings: { label: "Settings", icon: "settings" },
};

export function readPortalLocation(search = window.location.search): {
  page: PortalPage;
  workspace: string | null;
} {
  const parameters = new URLSearchParams(search);
  const page = parameters.get("page") ?? "";
  return {
    page: page in PORTAL_PAGES ? (page as PortalPage) : "home",
    workspace: parameters.get("workspace"),
  };
}

export function portalHref(page: PortalPage, workspace: string | null): string {
  const parameters = new URLSearchParams();
  if (page !== "home") parameters.set("page", page);
  if (workspace) parameters.set("workspace", workspace);
  const query = parameters.toString();
  return query ? `/?${query}` : "/";
}

export function PortalShell({
  theme,
  page,
  workspaces,
  workspace,
  personId,
  onNavigate,
  onWorkspace,
  onSignOut,
  children,
}: {
  theme: string;
  page: PortalPage;
  workspaces: DirectoryAccount[];
  workspace: DirectoryAccount;
  personId: string;
  onNavigate: (page: PortalPage) => void;
  onWorkspace: (id: string) => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const activeApps = workspace.products.filter((product) => product.status === "active");
  return (
    <div className="one portal" data-theme={theme}>
      <div className="one-stripe portal" aria-hidden="true" />
      <header className="one-header">
        <div className="one-header-brand">
          <a
            className="one-brand"
            href={portalHref("home", workspace.id)}
            onClick={(event) => {
              event.preventDefault();
              onNavigate("home");
            }}
          >
            <BrandMark />
            <Wordmark />
          </a>
          <label className="one-inline-label portal-workspace">
            Workspace
            <select value={workspace.id} onChange={(event) => onWorkspace(event.target.value)}>
              {workspaces.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="one-header-actions">
          <a
            className="portal-quota"
            href={portalHref("usage", workspace.id)}
            onClick={(event) => {
              event.preventDefault();
              onNavigate("usage");
            }}
          >
            <span className="portal-quota-bar" aria-hidden="true" />
            <span>Quota not yet metered</span>
          </a>
          <div className="one-person-menu">
            <button
              type="button"
              className="one-avatar"
              aria-label="Your account"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {initials(personId)}
            </button>
            {menuOpen && (
              <div role="menu" onKeyDown={(event) => event.key === "Escape" && setMenuOpen(false)}>
                <span className="one-muted">
                  Your role in {workspace.name}: {workspace.role}
                </span>
                <button type="button" role="menuitem" className="one-button" onClick={onSignOut}>
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="one-body">
        <nav className="one-nav" aria-label="Portal">
          <div className="one-nav-group">
            {(Object.keys(PORTAL_PAGES) as PortalPage[]).map((key) => (
              <a
                key={key}
                className="one-navlink"
                href={portalHref(key, workspace.id)}
                aria-current={page === key ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(key);
                }}
              >
                <Icon name={PORTAL_PAGES[key].icon} />
                {PORTAL_PAGES[key].label}
              </a>
            ))}
          </div>
          {activeApps.length > 0 && (
            <div className="one-nav-group">
              <Eyebrow>•••• Apps</Eyebrow>
              {activeApps.map((product) => {
                const app = appForProduct(product.product);
                const url = productUrl(product.product);
                return url ? (
                  <a key={product.product} className="one-navlink portal-applink" href={url}>
                    <span
                      className="one-swatch square"
                      style={{ background: app.swatch }}
                      aria-hidden="true"
                    />
                    {app.name}
                  </a>
                ) : null;
              })}
            </div>
          )}
          <div className="one-card portal-help">
            <Eyebrow>•••• Help</Eyebrow>
            <span>Message the people who build these apps. No ticket queue.</span>
            <a href="https://anth.us">Contact Anthus</a>
          </div>
        </nav>
        <div className="portal-content">{children}</div>
      </div>
    </div>
  );
}
