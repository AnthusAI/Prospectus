import { billingRouteFromPath } from "./billing/routes";
const CALLBACK_PATH = "/auth/callback";
const PLACEHOLDER_ORIGIN = "https://return-target.invalid";
const MAXIMUM_RETURN_TARGET_LENGTH = 300;

/** Every console page that has a path of its own. */
export type PageKey = "today" | "pipeline" | "accounts" | "engagements" | "billing" | "team" | "settings";

export interface RouteLocation {
  page: PageKey;
  account: string | null;
  issueId: string | null;
}

const ID = "([A-Za-z0-9_-]{1,100})";

/** The path of each page itself. */
export const PAGE_PATHS: Record<PageKey, string> = {
  today: "/today",
  pipeline: "/pipeline",
  accounts: "/accounts",
  engagements: "/engagements",
  billing: "/billing",
  team: "/team",
  settings: "/settings",
};

/**
 * The paths that name one item. One row per route, each fully anchored: a new route is one more row, and a
 * longer path such as /accounts/<id>/billing never matches the shorter patterns.
 */
const ITEM_ROUTES: Array<{ pattern: RegExp; locate: (match: RegExpExecArray) => RouteLocation }> = [
  {
    pattern: new RegExp(`^/pipeline/${ID}$`),
    locate: (match) => ({ page: "pipeline", account: null, issueId: match[1] }),
  },
  {
    pattern: new RegExp(`^/accounts/${ID}$`),
    locate: (match) => ({ page: "accounts", account: match[1], issueId: null }),
  },
];

/** The location a pathname names, or null when the console has no such path. A trailing slash is ignored. */
export function routeFromPath(pathname: string): RouteLocation | null {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  for (const page of Object.keys(PAGE_PATHS) as PageKey[])
    if (PAGE_PATHS[page] === path) return { page, account: null, issueId: null };
  for (const { pattern, locate } of ITEM_ROUTES) {
    const match = pattern.exec(path);
    if (match) return locate(match);
  }
  return null;
}

/** The canonical path of a location. */
export function pathFor({ page, account, issueId }: RouteLocation): string {
  if (issueId) return issuePath(issueId);
  if (page === "accounts" && account) return accountPath(account);
  return PAGE_PATHS[page];
}

export function issuePath(issueId: string): string {
  return `/pipeline/${encodeURIComponent(issueId)}`;
}

export function accountPath(accountId: string): string {
  return `/accounts/${encodeURIComponent(accountId)}`;
}

export function issueIdFromPath(pathname: string): string | null {
  return routeFromPath(pathname)?.issueId ?? null;
}

export function issueUrl(issueId: string, origin: string): string {
  return `${origin}${issuePath(issueId)}`;
}

const LEGACY_VIEWS: Record<string, PageKey> = { followups: "today", customers: "pipeline" };
const LEGACY_RETURN_QUERY = /^\?view=[a-z]{1,20}(&account=[A-Za-z0-9_-]{1,100})?$/;

/** The location named by an older `/?view=...&account=...` link; Today when it names nothing. */
export function legacyLocation(search: string): RouteLocation {
  const parameters = new URLSearchParams(search);
  const view = parameters.get("view") ?? "";
  const page = view in PAGE_PATHS ? (view as PageKey) : (LEGACY_VIEWS[view] ?? "today");
  const account = parameters.get("account");
  return {
    page,
    account: page === "accounts" && account && /^[A-Za-z0-9_-]{1,100}$/.test(account) ? account : null,
    issueId: null,
  };
}

/** True for a click the browser should handle itself, such as a new-tab click. */
export function opensElsewhere(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

/**
 * Accepts only a path inside this application that the router understands. Anything that could leave the
 * origin, re-enter the sign-in callback or carry sign-in parameters is rejected so a crafted return target
 * can never become an open redirect.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  if (value.length > MAXIMUM_RETURN_TARGET_LENGTH) return null;
  if (value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return null;
  let target: URL;
  try {
    target = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  if (target.origin !== PLACEHOLDER_ORIGIN || target.pathname === CALLBACK_PATH) return null;
  if (["code", "error", "state"].some((name) => target.searchParams.has(name))) return null;
  // The home page keeps only the older ?view= form, which the console then replaces with a path.
  if (target.pathname === "/") return LEGACY_RETURN_QUERY.test(target.search) ? `/${target.search}` : "/";
  // A billing page keeps only the account a new invoice or payment opens for.
  if (billingRouteFromPath(target.pathname))
    return `${target.pathname}${/^\?account=[A-Za-z0-9_-]{1,100}$/.test(target.search) ? target.search : ""}`;
  // A known path is returned in its canonical form without a query string.
  const route = routeFromPath(target.pathname);
  return route ? pathFor(route) : null;
}
