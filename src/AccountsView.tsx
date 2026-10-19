import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountsBrowser } from "./accounts-client";
import { appForProduct } from "./apps";
import type {
  DirectoryDetail,
  DirectoryList,
  DirectoryMembership,
  OperatorDetail,
  OperatorList,
} from "../packages/accounts-client/src/directory";
import { initials } from "./prospect";
import { Eyebrow, ProductSwatch, Stat, Unavailable } from "./admin/ui";

type Scope = "memberships" | "operator";
type Detail = (DirectoryDetail & { scope: "memberships" }) | (OperatorDetail & { scope: "operator" });
interface Row {
  id: string;
  name: string;
  members: string;
  products: DirectoryList["accounts"][number]["products"];
  status: string;
}

const UNAVAILABLE_FILTERS = ["Needs attention", "Self-serve", "With services", "Trials"];

/**
 * Accounts for Anthus staff. The organization directory requires the central Accounts administrator
 * permission, which its transport enforces independently; everyone else sees only their own memberships.
 */
export function AccountsView({
  client,
  onConnect,
  automaticConfirmationAllowed = () => false,
  search = "",
  account: controlledAccount,
  onAccountChange,
}: {
  client: AccountsBrowser;
  onConnect: () => Promise<void>;
  automaticConfirmationAllowed?: () => boolean;
  search?: string;
  account?: string | null;
  onAccountChange?: (id: string | null) => void;
}) {
  // The open account follows the address when the host routes it, otherwise it is local state.
  const [localAccount, setLocalAccount] = useState<string | null>(null);
  const account = controlledAccount === undefined ? localAccount : controlledAccount;
  const openAccount = onAccountChange ?? setLocalAccount;
  const [data, setData] = useState<DirectoryList | null>(null),
    [operator, setOperator] = useState<OperatorList | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [loading, setLoading] = useState(true),
    [operatorLoading, setOperatorLoading] = useState(false),
    [detailLoading, setDetailLoading] = useState(false),
    [error, setError] = useState(""),
    [operatorError, setOperatorError] = useState(""),
    [detailError, setDetailError] = useState("");
  const [scope, setScope] = useState<Scope>("memberships");
  const scopeChosen = useRef(false);
  const request = useRef(0);
  const connectingRef = useRef(false);
  const [connecting, setConnecting] = useState(false);
  const [reload, setReload] = useState(0);
  const [operatorReload, setOperatorReload] = useState(0);

  async function connect() {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    setError("");
    try {
      await onConnect();
    } catch {
      setError("Google confirmation could not be completed. Please try again.");
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  }

  useEffect(() => {
    let current = true;
    request.current++;
    setData(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError("");
    setLoading(true);
    setError("");
    void client
      .list()
      .then((value) => {
        if (!current) return;
        setData(value);
        if (!scopeChosen.current && value.operatorAccess) setScope("operator");
      })
      .catch(() => {
        if (current)
          setError(
            client.configured
              ? "Accounts could not be loaded. Try again."
              : "The Accounts service has not been configured.",
          );
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      request.current++;
    };
  }, [client, reload]);

  useEffect(() => {
    if (data && !data.person && automaticConfirmationAllowed()) void connect();
  }, [data]);

  const operatorAllowed = data?.operatorAccess === true;
  useEffect(() => {
    let current = true;
    setOperator(null);
    setOperatorError("");
    if (!operatorAllowed || scope !== "operator") return;
    setOperatorLoading(true);
    void client
      .operatorList()
      .then((value) => current && setOperator(value))
      .catch(
        () =>
          current &&
          setOperatorError(
            "Account administration could not be loaded. Your permission may have changed. Refresh to try again.",
          ),
      )
      .finally(() => current && setOperatorLoading(false));
    return () => {
      current = false;
    };
  }, [client, operatorAllowed, scope, operatorReload]);

  useEffect(() => {
    if (!account || !data?.person) {
      setDetail(null);
      return;
    }
    const sequence = ++request.current;
    setDetail(null);
    setDetailLoading(true);
    setDetailError("");
    const load: Promise<Detail> =
      scope === "operator" && operatorAllowed
        ? client.operatorDetail(account).then((value) => ({ ...value, scope: "operator" as const }))
        : client.detail(account).then((value) => ({ ...value, scope: "memberships" as const }));
    void load
      .then((value) => sequence === request.current && setDetail(value))
      .catch(
        () =>
          sequence === request.current &&
          setDetailError(
            scope === "operator"
              ? "Organization details are unavailable or administrator access has changed."
              : "Account details are unavailable or access has changed. Refresh your accounts.",
          ),
      )
      .finally(() => sequence === request.current && setDetailLoading(false));
  }, [account, client, data, scope, operatorAllowed]);

  const rows: Row[] = useMemo(() => {
    const all: Row[] =
      scope === "operator"
        ? (operator?.accounts ?? []).map((item) => ({
            id: item.id,
            name: item.name,
            members: `${item.activeMembers} active ${item.activeMembers === 1 ? "member" : "members"}`,
            products: item.products,
            status: item.products.some((product) => product.status === "active")
              ? "Active"
              : "No active apps",
          }))
        : (data?.accounts ?? []).map((item) => ({
            id: item.id,
            name: item.name,
            members: `Your role: ${item.role}`,
            products: item.products,
            status: item.products.some((product) => product.status === "active")
              ? "Active"
              : "No active apps",
          }));
    const term = search.trim().toLowerCase();
    return term ? all.filter((row) => row.name.toLowerCase().includes(term)) : all;
  }, [scope, operator, data, search]);

  if (account)
    return (
      <main className="one-main narrow" aria-label="Account">
        <nav className="one-breadcrumb" aria-label="Breadcrumb">
          <button type="button" onClick={() => openAccount(null)}>
            Accounts
          </button>
          <span aria-hidden="true">/</span>
          <span>{detail?.name ?? "Account"}</span>
        </nav>
        {(loading || detailLoading) && <p role="status">Loading account details…</p>}
        {detailError && <p role="alert">{detailError}</p>}
        {detail && <AccountPage detail={detail} />}
      </main>
    );

  const total = scope === "operator" ? operator?.accounts.length : data?.accounts.length;
  return (
    <main className="one-main narrow accounts-workspace" aria-label="Accounts">
      <div className="one-pagehead">
        <div>
          <Eyebrow>•••••• Serve / Accounts</Eyebrow>
          <h1>Accounts</h1>
          <p>
            Customer organizations on Anthus One, with their memberships and app entitlements. These are
            separate from prospects and contacts.
          </p>
        </div>
        <div className="one-toolbar">
          <button
            type="button"
            className="one-button"
            disabled={loading || connecting}
            onClick={() => setReload((value) => value + 1)}
          >
            Refresh accounts
          </button>
          {scope === "operator" && operatorAllowed && (
            <button
              type="button"
              className="one-button"
              disabled={operatorLoading}
              onClick={() => setOperatorReload((value) => value + 1)}
            >
              Refresh directory
            </button>
          )}
        </div>
      </div>

      {loading && <p role="status">Loading accounts…</p>}
      {error && (
        <p role="alert" className="one-alert">
          {error}
        </p>
      )}
      {data && !data.person && (
        <section className="one-card cool account-empty">
          <h2>Finish signing in to Accounts</h2>
          <p>
            You are signed in to Prospectus. Confirm this Google sign-in to load your existing account
            memberships. A new sign-in session requires confirmation again. This does not create an
            organization or grant access.
          </p>
          <button
            type="button"
            className="one-button primary tall"
            disabled={connecting}
            onClick={() => void connect()}
          >
            {connecting ? "Opening Google…" : "Continue with Google"}
          </button>
          {connecting && <p role="status">Opening Google to confirm this sign-in…</p>}
        </section>
      )}

      {data?.person && (
        <>
          <div className="one-stats">
            <Stat value={total === undefined ? "…" : String(total)} label="ACCOUNTS" />
            <Stat value={null} label="PAYING" note="Needs billing data" />
            <Stat value={null} label="IN TRIAL" note="Needs plan data" />
            <Stat value={null} label="SERVICES ENGAGEMENTS" note="Not yet recorded" hot />
          </div>
          <div className="one-toolbar" style={{ justifyContent: "space-between" }}>
            <div className="one-segmented" role="group" aria-label="Account views">
              <button
                type="button"
                aria-pressed={scope === "operator"}
                onClick={() => {
                  scopeChosen.current = true;
                  setScope("operator");
                }}
              >
                Account administration
              </button>
              <button
                type="button"
                aria-pressed={scope === "memberships"}
                onClick={() => {
                  scopeChosen.current = true;
                  setScope("memberships");
                }}
              >
                My memberships
              </button>
            </div>
            <div className="one-filters" role="group" aria-label="Show">
              <button type="button" aria-pressed="true">
                All <span>{rows.length}</span>
              </button>
              {UNAVAILABLE_FILTERS.map((label) => (
                <button key={label} type="button" disabled title="Not yet available: needs billing data">
                  {label} <span>—</span>
                </button>
              ))}
            </div>
          </div>

          {scope === "operator" && !operatorAllowed && (
            <p role="status" className="one-status">
              An explicitly assigned central Accounts administrator permission is required. CRM administrator
              status does not grant this access.
            </p>
          )}
          {scope === "operator" && operatorLoading && <p role="status">Loading organization directory…</p>}
          {scope === "operator" && operatorError && (
            <p role="alert" className="one-alert">
              {operatorError}
            </p>
          )}
          {scope === "operator" && operator?.accounts.length === 0 && (
            <p role="status">No organizations have been created in the central account directory.</p>
          )}
          {scope === "memberships" && data.accounts.length === 0 && (
            <p role="status">
              You do not have any SaaS accounts available. Ask an existing account owner for access.
            </p>
          )}
          {rows.length > 0 && (
            <>
              <div className="one-table-wrap">
                <table className="one-table">
                  <thead>
                    <tr>
                      <th scope="col">Account</th>
                      <th scope="col">Plan</th>
                      <th scope="col">Apps</th>
                      <th scope="col">Quota this month</th>
                      <th scope="col">Services</th>
                      <th scope="col">Anthus owner</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <th scope="row">
                          <span className="one-cellstack">
                            <button
                              type="button"
                              className="one-linkbutton"
                              onClick={() => openAccount(row.id)}
                            >
                              {row.name}
                            </button>
                            <small>{row.members}</small>
                          </span>
                        </th>
                        <td>
                          <span className="one-na">Not yet available</span>
                        </td>
                        <td>
                          <span className="one-apps">
                            {row.products.length ? (
                              row.products.map((product) => (
                                <ProductSwatch
                                  key={product.product}
                                  product={product.product}
                                  status={product.status}
                                />
                              ))
                            ) : (
                              <span className="one-muted">None</span>
                            )}
                          </span>
                        </td>
                        <td>
                          <span className="one-na">Not yet available</span>
                        </td>
                        <td>
                          <span className="one-na">Not yet available</span>
                        </td>
                        <td>
                          <span className="one-na">Not yet available</span>
                        </td>
                        <td className={row.status === "Active" ? "one-ok" : "one-muted"}>{row.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <span className="one-muted" style={{ fontSize: 13 }}>
                Showing {rows.length} of {total}.
              </span>
            </>
          )}
        </>
      )}
    </main>
  );
}

function AccountPage({ detail }: { detail: Detail }) {
  const [copied, setCopied] = useState(false);
  const activeApps = detail.entitlements.filter((entitlement) => entitlement.status === "active").length;
  const activeMembers = detail.memberships.filter((member) => member.status === "active");
  const owner = activeMembers.find((member) => member.role === "owner");
  const created = new Date(detail.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const showMemberships = detail.scope === "operator" || detail.membershipsVisible;
  return (
    <>
      <section className="one-account-head">
        <div className="one-badges">
          <span className="one-badge">Plan not yet available</span>
          <span className={`one-badge${activeApps ? " ok" : ""}`}>
            {activeApps ? "Active" : "No active apps"}
          </span>
          {detail.scope === "memberships" && <span className="one-badge">Your role: {detail.role}</span>}
        </div>
        <h1>{detail.name}</h1>
        <span className="one-account-meta">Customer since {created}</span>
        <div className="one-toolbar">
          <button
            type="button"
            className="one-button primary"
            disabled
            title="The Anthus One portal is not live yet"
          >
            View as customer
          </button>
          <button type="button" className="one-button" disabled title="Not yet available: needs billing">
            Change plan
          </button>
          <button
            type="button"
            className="one-button"
            disabled
            title="Not yet available: needs usage metering"
          >
            Add quota
          </button>
        </div>
      </section>
      <div className="one-stats">
        <Stat value={null} label="QUOTA USED" note="Not yet metered" />
        <Stat value={String(activeMembers.length)} label="ACTIVE MEMBERS" />
        <Stat value={String(activeApps)} label="APPS ON" />
        <Stat value={null} label="SERVICES DEALS" note="Not yet recorded" hot />
      </div>
      <div className="one-columns">
        <div className="primary">
          <section className="one-card strong" aria-labelledby="quota-heading">
            <div className="one-section-head">
              <h2 id="quota-heading" className="small">
                Quota this month
              </h2>
            </div>
            <Unavailable title="Not yet available">
              <span>Usage by app appears here once Anthus One meters quota.</span>
            </Unavailable>
          </section>
          <section className="one-card strong" aria-labelledby="apps-heading">
            <div className="one-section-head">
              <h2 id="apps-heading" className="small">
                Apps and access
              </h2>
              <span>What this account is entitled to</span>
            </div>
            {detail.entitlements.length === 0 && <p className="one-empty">No product entitlements.</p>}
            {detail.entitlements.map((entitlement) => {
              const app = appForProduct(entitlement.product);
              const on = entitlement.status === "active";
              return (
                <div className="one-entitlement" key={entitlement.product}>
                  <span className="one-appmark" style={{ background: app.swatch }} aria-hidden="true">
                    {app.name.charAt(0)}
                  </span>
                  <span className="one-cellstack" style={{ minWidth: 140 }}>
                    <strong>{app.name}</strong>
                    <small className="one-mono">{entitlement.product}</small>
                  </span>
                  <span className="one-capabilities">
                    {entitlement.capabilities.length ? (
                      entitlement.capabilities.map((capability) => <code key={capability}>{capability}</code>)
                    ) : (
                      <span className="one-muted">No capabilities</span>
                    )}
                  </span>
                  <span className="one-switch" title="Read-only: staff access does not change entitlements">
                    <span className={`one-switch-track${on ? " on" : ""}`} aria-hidden="true" />
                    {on ? "On" : "Off"}
                  </span>
                </div>
              );
            })}
          </section>
          <section className="one-card strong" aria-labelledby="engagements-heading">
            <div className="one-section-head">
              <h2 id="engagements-heading" className="small">
                Services engagements
              </h2>
            </div>
            <Unavailable title="Not yet available">
              <span>Services deals are not linked to accounts yet.</span>
            </Unavailable>
          </section>
          <section className="one-card strong" aria-labelledby="members-heading">
            <div className="one-section-head">
              <h2 id="members-heading" className="small">
                {detail.scope === "operator"
                  ? "Organization memberships"
                  : showMemberships
                    ? "Memberships"
                    : "Your membership"}
              </h2>
              <span>{activeMembers.length} active</span>
            </div>
            {!showMemberships && (
              <p className="one-note">Only account owners and administrators can view other memberships.</p>
            )}
            {detail.memberships.map((member) => (
              <Member key={member.personId} member={member} />
            ))}
          </section>
        </div>
        <aside className="secondary">
          <section className="one-card">
            <Eyebrow>•••• Relationship</Eyebrow>
            <dl className="one-dl">
              <dt>Anthus owner</dt>
              <dd className="one-na">Not yet available</dd>
              <dt>Account owner</dt>
              <dd>
                {owner ? <code>{owner.personId}</code> : showMemberships ? "None" : "Hidden for your role"}
              </dd>
              <dt>Next follow-up</dt>
              <dd className="one-na">Not yet linked to the CRM</dd>
            </dl>
          </section>
          <section className="one-card">
            <Eyebrow>•••• History</Eyebrow>
            <Unavailable title="Not yet available">
              <span>Account history is not recorded yet.</span>
            </Unavailable>
          </section>
          <section className="one-card">
            <Eyebrow>•••• Record</Eyebrow>
            <dl className="one-dl">
              <dt>Account ID</dt>
              <dd>
                <code className="account-id">{detail.id}</code>{" "}
                <button
                  type="button"
                  className="one-button small"
                  onClick={() =>
                    void navigator.clipboard?.writeText(detail.id).then(
                      () => setCopied(true),
                      () => setCopied(false),
                    )
                  }
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </dd>
              <dt>Created</dt>
              <dd>{created}</dd>
              <dt>Record version</dt>
              <dd>{detail.revision}</dd>
            </dl>
            {detail.scope === "operator" && (
              <p className="one-note">
                You’re viewing as Anthus staff. Administrator access is read-only and does not make you a
                member of this organization.
              </p>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

function Member({ member }: { member: DirectoryMembership }) {
  return (
    <div className="one-member">
      <span className="one-initials" aria-hidden="true">
        {initials(member.personId)}
      </span>
      <span className="one-cellstack" style={{ flex: "1 1 200px", minWidth: 0 }}>
        <code className="account-id one-mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
          {member.personId}
        </code>
      </span>
      <span className="one-pill">{member.role}</span>
      <span className={member.status === "active" ? "one-ok" : "one-muted"}>{member.status}</span>
    </div>
  );
}
