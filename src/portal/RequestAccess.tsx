import type { ReactNode } from "react";

/**
 * Where a visitor who cannot create a workspace here asks Anthus to set one up. The destination is the Anth.us
 * contact page with the solution and the call-to-action location already named, so the request is attributed.
 */
export const REQUEST_ACCESS_URL = "https://anth.us/engage/?solution=Anthus%20One&cta=portal";

/** A plain link (never a script-opened window) so it works with popups blocked and is readable by assistive tech. */
export function RequestAccessLink() {
  return (
    <a className="one-button primary tall portal-request-access" href={REQUEST_ACCESS_URL} rel="noopener">
      Request access
    </a>
  );
}

/** The "creating a workspace is not yet available" state, with the way to ask Anthus for access. */
export function WorkspaceUnavailableNote({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="one-unavailable" role="note">
      <strong>{heading}</strong>
      <span>{children}</span>
      <RequestAccessLink />
    </div>
  );
}
