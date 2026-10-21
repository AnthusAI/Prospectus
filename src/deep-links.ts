const ISSUE_PATH = /^\/pipeline\/([A-Za-z0-9_-]{1,100})\/?$/;
const CALLBACK_PATH = "/auth/callback";
const PLACEHOLDER_ORIGIN = "https://return-target.invalid";
const MAXIMUM_RETURN_TARGET_LENGTH = 300;

export function issuePath(issueId: string): string {
  return `/pipeline/${encodeURIComponent(issueId)}`;
}

export function issueIdFromPath(pathname: string): string | null {
  return ISSUE_PATH.exec(pathname)?.[1] ?? null;
}

export function issueUrl(issueId: string, origin: string): string {
  return `${origin}${issuePath(issueId)}`;
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
  if (target.pathname !== "/" && !issueIdFromPath(target.pathname)) return null;
  if (["code", "error", "state"].some((name) => target.searchParams.has(name))) return null;
  return `${target.pathname}${target.search}`;
}
