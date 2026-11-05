import type { ReactNode } from "react";
import { appById, appForProduct, type AnthusApp } from "../apps";

const ICON_PATHS = {
  today: (
    <>
      <rect x="3" y="5" width="18" height="16" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  pipeline: (
    <>
      <rect x="3" y="4" width="5" height="16" />
      <rect x="10" y="4" width="5" height="11" />
      <rect x="17" y="4" width="4" height="7" />
    </>
  ),
  accounts: (
    <>
      <path d="M3 21V8l9-5 9 5v13" />
      <path d="M9 21v-7h6v7" />
    </>
  ),
  engagements: (
    <>
      <rect x="3" y="7" width="18" height="13" />
      <path d="M8 7V4h8v3" />
    </>
  ),
  billing: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  team: (
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2" />
      <path d="M17 4a4 4 0 0 1 0 8" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  home: (
    <>
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h14V10" />
    </>
  ),
  apps: (
    <>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </>
  ),
  usage: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 12V3a9 9 0 0 1 9 9z" />
    </>
  ),
  keys: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M17 6l3 3" />
    </>
  ),
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />,
  // Lucide "power" and "power-off" (ISC license), the Turn on and Turn off buttons on an Account.
  power: (
    <>
      <path d="M12 2v10" />
      <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
    </>
  ),
  "power-off": (
    <>
      <path d="M18.36 6.64A9 9 0 0 1 20.77 15" />
      <path d="M6.16 6.16a9 9 0 1 0 12.68 12.68" />
      <path d="M12 2v4" />
      <path d="m2 2 20 20" />
    </>
  ),
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "plus" ? 2.5 : 2}
      strokeLinecap="square"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

export function BrandMark() {
  return (
    <span className="one-mark" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <span key={index} />
      ))}
    </span>
  );
}

export function Wordmark() {
  return (
    <span className="one-wordmark">
      Anthus <span>One</span>
    </span>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="one-eyebrow">{children}</span>;
}

export function Stat({
  value,
  label,
  note,
  hot,
  href,
  onClick,
}: {
  value: string | null;
  label: string;
  note?: string;
  hot?: boolean;
  href?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className={`one-stat-value${value === null ? " unavailable" : ""}`}>{value ?? "—"}</span>
      <span className="one-stat-label">{label}</span>
      {note && <span className={`one-stat-note${hot ? " hot" : ""}`}>{note}</span>}
    </>
  );
  const className = `one-stat${hot ? " hot" : ""}`;
  return href ? (
    <a
      className={className}
      href={href}
      onClick={(event) => {
        if (!onClick || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onClick();
      }}
    >
      {body}
    </a>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** Marks an area the backend does not support yet, instead of showing invented figures. */
export function Unavailable({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="one-unavailable" role="note">
      <strong>{title}</strong>
      {children ?? (
        <span>Not yet available. This needs billing and usage data that Anthus One does not record yet.</span>
      )}
    </div>
  );
}

/** The product's own logo in the current theme, or a neutral mark (never a product color) when it has none. */
export function AppMark({ app, large, off }: { app: AnthusApp; large?: boolean; off?: boolean }) {
  const size = `one-mark${large ? " lg" : ""}${off ? " off" : ""}${app.logo?.plate ? " plate" : ""}`;
  if (!app.logo)
    return (
      <span className={`${size} neutral`} aria-hidden="true">
        {app.name.charAt(0)}
      </span>
    );
  return (
    <span className={size} aria-hidden="true">
      {app.logo.dark === app.logo.light ? (
        <img src={app.logo.light} alt="" />
      ) : (
        <>
          <img className="light" src={app.logo.light} alt="" />
          <img className="dark" src={app.logo.dark} alt="" />
        </>
      )}
    </span>
  );
}

export function AppChip({ id }: { id: string }) {
  const app = appById(id) ?? { id, name: id };
  return (
    <span className="one-chip">
      <AppMark app={app} />
      {app.name}
    </span>
  );
}

export function ProductSwatch({ product, status }: { product: string; status: string }) {
  const app = appForProduct(product);
  const label = `${app.name}${status === "active" ? "" : ` (${status})`}`;
  return (
    <span className="one-productmark" title={label}>
      <AppMark app={app} off={status !== "active"} />
      <span className="sr-only">{label}</span>
    </span>
  );
}
