import { useEffect, useRef, useState, type ReactNode } from "react";
import { initials } from "../prospect";
import { BrandMark, Icon, Wordmark, type IconName } from "./ui";

export type Page = "today" | "pipeline" | "accounts" | "engagements" | "billing" | "team" | "settings";

export const PAGES: Record<Page, { label: string; icon: IconName; group: "Sell" | "Serve" | "Admin" }> = {
  today: { label: "Today", icon: "today", group: "Sell" },
  pipeline: { label: "Pipeline", icon: "pipeline", group: "Sell" },
  accounts: { label: "Accounts", icon: "accounts", group: "Serve" },
  engagements: { label: "Engagements", icon: "engagements", group: "Serve" },
  billing: { label: "Usage and billing", icon: "billing", group: "Serve" },
  team: { label: "Anthus team", icon: "team", group: "Admin" },
  settings: { label: "Settings", icon: "settings", group: "Admin" },
};

const LEGACY_VIEWS: Record<string, Page> = { followups: "today", customers: "pipeline" };

/** Reads the page and open account from the address; `?view=` keeps the links the CRM already issued working. */
export function readLocation(search = window.location.search): { page: Page; account: string | null } {
  const parameters = new URLSearchParams(search);
  const view = parameters.get("view") ?? "";
  const page = view in PAGES ? (view as Page) : (LEGACY_VIEWS[view] ?? "today");
  return { page, account: page === "accounts" ? parameters.get("account") : null };
}

export function pageHref(page: Page, account?: string | null): string {
  const parameters = new URLSearchParams({ view: page });
  if (account) parameters.set("account", account);
  return `?${parameters}`;
}

export function AdminShell({
  page,
  onNavigate,
  counts,
  search,
  onSearch,
  searchPlaceholder,
  onNewProspect,
  person,
  onSignOut,
  banner,
  children,
}: {
  page: Page;
  onNavigate: (page: Page) => void;
  counts: Partial<Record<Page, { value: number | string; alert?: boolean }>>;
  search: string;
  onSearch: (value: string) => void;
  searchPlaceholder: string;
  onNewProspect?: () => void;
  person: string;
  onSignOut?: () => void;
  banner?: ReactNode;
  children: ReactNode;
}) {
  const searchInput = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  const groups = (["Sell", "Serve", "Admin"] as const).map((group) => ({
    group,
    pages: (Object.keys(PAGES) as Page[]).filter((key) => PAGES[key].group === group),
  }));
  return (
    <div className="one kb-theme-organizer">
      <div className="one-stripe" aria-hidden="true" />
      {banner}
      <header className="one-header">
        <div className="one-header-brand">
          <a
            className="one-brand"
            href={pageHref("today")}
            onClick={(event) => {
              event.preventDefault();
              onNavigate("today");
            }}
          >
            <BrandMark />
            <Wordmark />
          </a>
          <span className="one-tag">ADMIN · PROSPECTUS</span>
        </div>
        <label className="one-search">
          <Icon name="search" size={16} />
          <span className="sr-only">Search</span>
          <input
            ref={searchInput}
            type="search"
            aria-label="Search"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(event) => onSearch(event.target.value)}
          />
          <span className="one-kbd" aria-hidden="true">
            ⌘K
          </span>
        </label>
        <div className="one-header-actions">
          {onNewProspect && (
            <button type="button" className="one-button primary" onClick={onNewProspect}>
              <Icon name="plus" size={14} />
              New prospect
            </button>
          )}
          <div className="one-person-menu">
            <button
              type="button"
              className="one-avatar"
              aria-label={`Signed in as ${person}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {initials(person)}
            </button>
            {menuOpen && (
              <div role="menu" onKeyDown={(event) => event.key === "Escape" && setMenuOpen(false)}>
                <span className="one-muted">Signed in as {person}</span>
                {onSignOut && (
                  <button type="button" role="menuitem" className="one-button" onClick={onSignOut}>
                    Sign out
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="one-body">
        <nav className="one-nav" aria-label="Admin">
          {groups.map(({ group, pages }) => (
            <div className="one-nav-group" key={group}>
              <span className="one-eyebrow">•••• {group}</span>
              {pages.map((key) => (
                <a
                  key={key}
                  className="one-navlink"
                  href={pageHref(key)}
                  aria-current={page === key ? "page" : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(key);
                  }}
                >
                  <Icon name={PAGES[key].icon} />
                  {PAGES[key].label}
                  {counts[key] !== undefined && (
                    <span className={`one-navcount${counts[key]!.alert ? " alert" : ""}`}>
                      {counts[key]!.value}
                    </span>
                  )}
                </a>
              ))}
            </div>
          ))}
        </nav>
        {children}
      </div>
    </div>
  );
}
