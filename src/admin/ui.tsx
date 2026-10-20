import type { ReactNode } from "react";
import { appById, appForProduct } from "../apps";

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
        if (!onClick) return;
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

export function AppChip({ id }: { id: string }) {
  const app = appById(id) ?? { name: id, swatch: "var(--panel-2)" };
  return (
    <span className="one-chip">
      <span className="one-swatch" style={{ background: app.swatch }} aria-hidden="true" />
      {app.name}
    </span>
  );
}

export function ProductSwatch({ product, status }: { product: string; status: string }) {
  const app = appForProduct(product);
  const label = `${app.name}${status === "active" ? "" : ` (${status})`}`;
  return (
    <span
      className="one-swatch square"
      title={label}
      style={{ background: status === "active" ? app.swatch : "var(--surface)" }}
    >
      <span className="sr-only">{label}</span>
    </span>
  );
}
