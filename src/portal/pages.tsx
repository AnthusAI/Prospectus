import { useState } from "react";
import type { DirectoryAccount, DirectoryDetail } from "../../packages/accounts-client/src/directory";
import { ANTHUS_APPS, appForProduct, productUrl } from "../apps";
import { initials } from "../shared/initials";
import { Eyebrow, Icon, Stat, Unavailable } from "../shared/ui";
import { PORTAL_PAGES, type PortalPage } from "./PortalShell";
import type { PortalTheme } from "./theme";

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function hostOf(url: string): string {
  return new URL(url).host;
}

function Loading() {
  return <p role="status">Loading this workspace…</p>;
}

export function HomePage({
  workspace,
  detail,
  onNavigate,
}: {
  workspace: DirectoryAccount;
  detail: DirectoryDetail | null;
  onNavigate: (page: PortalPage) => void;
}) {
  const active = workspace.products.filter((product) => product.status === "active");
  return (
    <main className="one-main narrow portal-home" aria-label="Home">
      <section className="one-hero">
        <div className="one-hero-title">
          <Eyebrow>
            •••••• 01 / {workspace.name} · {workspace.role}
          </Eyebrow>
          <h1>{greeting()}</h1>
        </div>
        <div className="one-card cool portal-quota-card">
          <div className="portal-quota-ring" aria-hidden="true" />
          <div className="one-cellstack">
            <strong className="portal-quota-title">This month’s quota</strong>
            <Unavailable title="Not yet available">
              <span>
                One quota shared by every app will show here, split by app, with a heads-up before you run
                out. Anthus One does not meter usage yet.
              </span>
            </Unavailable>
          </div>
        </div>
      </section>

      <section className="portal-section" aria-labelledby="your-apps">
        <div className="one-section-head">
          <div className="one-cellstack">
            <Eyebrow>•••••• 02 / Apps</Eyebrow>
            <h2 id="your-apps">Your apps</h2>
          </div>
          <span>One sign-in for every app in this workspace.</span>
        </div>
        <div className="portal-tiles">
          {active.map((product) => {
            const app = appForProduct(product.product);
            const url = productUrl(product.product);
            return (
              <article className="portal-tile" key={product.product}>
                <span className="one-appmark" style={{ background: app.swatch }} aria-hidden="true">
                  {app.name.charAt(0)}
                </span>
                <h3>{app.name}</h3>
                {url && <span className="one-muted one-mono portal-domain">{hostOf(url)}</span>}
                {app.blurb && <p>{app.blurb}</p>}
                {url ? (
                  <a className="one-button primary portal-open" href={url}>
                    Open {app.name}
                    <Icon name="external" size={14} />
                  </a>
                ) : (
                  <span className="one-na">No public address yet</span>
                )}
              </article>
            );
          })}
          <article className="portal-tile add">
            <h3>Add an app</h3>
            <p>See every Anthus app and which ones this workspace has.</p>
            <a
              href="?page=apps"
              onClick={(event) => {
                event.preventDefault();
                onNavigate("apps");
              }}
            >
              Browse apps
            </a>
          </article>
        </div>
        {!detail && active.length === 0 && <Loading />}
      </section>

      <section className="portal-section" aria-labelledby="activity">
        <div className="one-cellstack">
          <Eyebrow>•••••• 03 / Activity</Eyebrow>
          <h2 id="activity">What your bots have been doing</h2>
        </div>
        <div className="one-columns">
          <div className="primary">
            <Unavailable title="Not yet available">
              <span>Recent work by your bots across apps will appear here.</span>
            </Unavailable>
          </div>
          <div className="secondary">
            <div className="one-card">
              <Eyebrow>•••• Waiting on you</Eyebrow>
              <Unavailable title="Not yet available">
                <span>Approvals your apps are waiting for will be gathered here.</span>
              </Unavailable>
            </div>
            <div className="one-card">
              <Eyebrow>•••• Service status</Eyebrow>
              <Unavailable title="Not yet available">
                <span>Status for every app will be shown here.</span>
              </Unavailable>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

export function AppsPage({
  workspace,
  detail,
}: {
  workspace: DirectoryAccount;
  detail: DirectoryDetail | null;
}) {
  const [filter, setFilter] = useState<"all" | "on" | "off">("all");
  const rows = ANTHUS_APPS.filter((app) => app.id !== "services").map((app) => {
    const products = workspace.products.filter((product) => appForProduct(product.product).id === app.id);
    const on = products.some((product) => product.status === "active");
    const capabilities = (detail?.entitlements ?? [])
      .filter((entitlement) => appForProduct(entitlement.product).id === app.id)
      .flatMap((entitlement) => entitlement.capabilities);
    const url = products.map((product) => productUrl(product.product)).find(Boolean) ?? app.url;
    return { app, on, has: products.length > 0, capabilities, url };
  });
  const visible = rows.filter((row) => filter === "all" || (filter === "on" ? row.on : !row.on));
  return (
    <main className="one-main narrow" aria-label="Apps">
      <div className="one-pagehead">
        <div>
          <Eyebrow>•••••• 01 / Apps</Eyebrow>
          <h1>Apps</h1>
          <p>Every Anthus app, and which ones {workspace.name} has.</p>
        </div>
        <div className="one-filters" role="group" aria-label="Show">
          {(
            [
              ["all", "All"],
              ["on", "On"],
              ["off", "Off"],
            ] as const
          ).map(([key, label]) => (
            <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label}{" "}
              <span>{rows.filter((row) => key === "all" || (key === "on" ? row.on : !row.on)).length}</span>
            </button>
          ))}
        </div>
      </div>
      <section className="portal-applist" aria-label="App list">
        {visible.map(({ app, on, has, capabilities, url }) => (
          <article className="one-entitlement portal-approw" key={app.id}>
            <span className="one-appmark" style={{ background: app.swatch }} aria-hidden="true">
              {app.name.charAt(0)}
            </span>
            <span className="one-cellstack portal-appname">
              <h2>{app.name}</h2>
              {app.blurb && <small>{app.blurb}</small>}
            </span>
            <span className="one-capabilities">
              {capabilities.map((capability) => (
                <code key={capability}>{capability}</code>
              ))}
            </span>
            <span className="one-switch" title="Turning apps on or off is not yet available">
              <span className={`one-switch-track${on ? " on" : ""}`} aria-hidden="true" />
              {on ? "On" : has ? "Off" : "Not in this workspace"}
            </span>
            {on && url && (
              <a className="one-button primary" href={url}>
                Open
                <Icon name="external" size={14} />
              </a>
            )}
          </article>
        ))}
      </section>
      <p className="one-note">
        Turning apps on or off from here is not yet available. Ask Anthus to change which apps this workspace
        has.
      </p>
    </main>
  );
}

const ROLE_NOTES: Record<string, string> = {
  owner: "Everything, including members and billing.",
  admin: "Manage members and apps.",
  member: "Use the workspace’s apps.",
  viewer: "Read-only access to the workspace’s apps.",
};

export function PeoplePage({ detail, personId }: { detail: DirectoryDetail | null; personId: string }) {
  if (!detail)
    return (
      <main className="one-main narrow" aria-label="People and bots">
        <Loading />
      </main>
    );
  const active = detail.memberships.filter((member) => member.status === "active");
  return (
    <main className="one-main narrow" aria-label="People and bots">
      <div className="one-pagehead">
        <div>
          <Eyebrow>•••••• 01 / Team</Eyebrow>
          <h1>People and bots</h1>
          <p>Everyone who can use {detail.name}, and their role.</p>
        </div>
      </div>
      <div className="one-stats">
        <Stat
          value={String(active.length)}
          label="ACTIVE MEMBERS"
          note={detail.membershipsVisible ? undefined : "Visible to admins"}
        />
        <Stat value={null} label="BOTS" note="Not yet recorded" />
        <Stat value={null} label="SEATS" note="Needs plan data" />
      </div>
      {!detail.membershipsVisible && (
        <p className="one-note">
          Only owners and admins can see everyone in this workspace. You can see your own membership.
        </p>
      )}
      <div className="one-table-wrap">
        <table className="one-table portal-people">
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {detail.memberships.map((member) => (
              <tr key={member.personId}>
                <th scope="row">
                  <span className="portal-member">
                    <span className="one-initials" aria-hidden="true">
                      {initials(member.personId)}
                    </span>
                    <code className="one-mono">{member.personId}</code>
                    {member.personId === personId && <span className="one-badge">You</span>}
                  </span>
                </th>
                <td>{member.role}</td>
                <td className={member.status === "active" ? "one-ok" : "one-muted"}>{member.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="one-muted portal-footnote">
        Names and email addresses are not shown here yet; members appear by their Anthus ID.
      </p>
      <div className="one-columns">
        <section className="primary one-card strong" aria-labelledby="invite-heading">
          <Eyebrow>•••• Invite</Eyebrow>
          <h2 id="invite-heading" className="portal-card-title">
            Invite people to {detail.name}
          </h2>
          <Unavailable title="Not yet available">
            <span>Inviting people from the portal is coming. Until then, Anthus adds people for you.</span>
          </Unavailable>
        </section>
        <section className="secondary one-card" aria-labelledby="roles-heading">
          <Eyebrow>•••• Roles</Eyebrow>
          <dl className="one-dl" id="roles-heading">
            {Object.entries(ROLE_NOTES).map(([role, note]) => (
              <div key={role} style={{ display: "contents" }}>
                <dt>{role}</dt>
                <dd>{note}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </main>
  );
}

export function SettingsPage({
  workspace,
  detail,
  theme,
  onTheme,
}: {
  workspace: DirectoryAccount;
  detail: DirectoryDetail | null;
  theme: PortalTheme;
  onTheme: (theme: PortalTheme) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <main className="one-main narrow" aria-label="Settings">
      <div className="one-pagehead">
        <div>
          <Eyebrow>•••••• 01 / Settings</Eyebrow>
          <h1>Settings</h1>
        </div>
      </div>
      <nav className="portal-toc" aria-label="On this page">
        {[
          ["workspace", "Workspace"],
          ["appearance", "Appearance"],
          ["alerts", "Quota alerts"],
          ["keys", "API keys"],
          ["security", "Security"],
          ["delete", "Delete workspace"],
        ].map(([id, label]) => (
          <a key={id} href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>
      <section id="workspace" className="one-card strong" aria-labelledby="workspace-heading">
        <h2 id="workspace-heading" className="portal-card-title">
          Workspace
        </h2>
        <dl className="one-dl">
          <dt>Name</dt>
          <dd>{workspace.name}</dd>
          <dt>Your role</dt>
          <dd>{workspace.role}</dd>
          <dt>Workspace ID</dt>
          <dd>
            <code>{workspace.id}</code>{" "}
            <button
              type="button"
              className="one-button small"
              onClick={() =>
                void navigator.clipboard?.writeText(workspace.id).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </dd>
          <dt>Created</dt>
          <dd>
            {detail
              ? new Date(detail.createdAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  timeZone: "UTC",
                })
              : "…"}
          </dd>
        </dl>
        <p className="one-note">Renaming the workspace and choosing its address are not yet available.</p>
      </section>
      <section id="appearance" className="one-card strong" aria-labelledby="appearance-heading">
        <h2 id="appearance-heading" className="portal-card-title">
          Appearance
        </h2>
        <div className="one-segmented portal-theme" role="radiogroup" aria-label="Theme">
          {(["system", "light", "dark"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={theme === option}
              aria-pressed={theme === option}
              onClick={() => onTheme(option)}
            >
              {option === "system" ? "Match system" : option === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
        <p className="one-muted portal-footnote">Saved in this browser.</p>
      </section>
      {(
        [
          ["alerts", "Quota alerts", "Alerts as your workspace nears its quota will be set here."],
          ["keys", "API keys", "Keys for calling Anthus apps from your own systems will be managed here."],
          ["security", "Security", "Sign-in rules and session controls for this workspace will be set here."],
          ["delete", "Delete workspace", "Deleting a workspace is not offered here. Ask Anthus."],
        ] as const
      ).map(([id, title, text]) => (
        <section key={id} id={id} className="one-card" aria-labelledby={`${id}-heading`}>
          <h2 id={`${id}-heading`} className="portal-card-title">
            {title}
          </h2>
          <Unavailable title="Not yet available">
            <span>{text}</span>
          </Unavailable>
        </section>
      ))}
    </main>
  );
}

const UNAVAILABLE_TEXT: Partial<Record<PortalPage, string>> = {
  usage:
    "Usage by app and by person, against one monthly quota, will appear here once Anthus One meters usage.",
  plans: "Your plan, invoices and extra usage will be managed here once Anthus One records billing.",
  keys: "Keys for calling Anthus apps from your own systems will be managed here.",
};

export function UnavailablePage({ page }: { page: PortalPage }) {
  return (
    <main className="one-main narrow" aria-label={PORTAL_PAGES[page].label}>
      <div className="one-pagehead">
        <div>
          <Eyebrow>•••••• 01 / {PORTAL_PAGES[page].label}</Eyebrow>
          <h1>{PORTAL_PAGES[page].label}</h1>
        </div>
      </div>
      <Unavailable title="Not yet available">
        <span>{UNAVAILABLE_TEXT[page]}</span>
      </Unavailable>
    </main>
  );
}
