import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountsBrowser } from "./accounts-client";
import { appForProduct } from "./apps";
import type {
  DirectoryList,
  DirectoryMembership,
  OperatorDetail,
  OperatorList,
} from "../packages/accounts-client/src/directory";
import { initials } from "./shared/initials";
import { Eyebrow, ProductSwatch, Stat, Unavailable } from "./shared/ui";

const UNAVAILABLE_FILTERS = ["Needs attention", "Self-serve", "With services", "Trials"];

/**
 * The staff account directory. It requires the central Accounts administrator permission, which its
 * transport enforces independently. Customers see their own accounts in the Anthus One portal, never here.
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
    [detail, setDetail] = useState<OperatorDetail | null>(null),
    [loading, setLoading] = useState(true),
    [operatorLoading, setOperatorLoading] = useState(false),
    [detailLoading, setDetailLoading] = useState(false),
    [error, setError] = useState(""),
    [operatorError, setOperatorError] = useState(""),
    [detailError, setDetailError] = useState("");
  const request = useRef(0);
  const connectingRef = useRef(false);
  const [connecting, setConnecting] = useState(false);
  const [reload, setReload] = useState(0);
  const [operatorReload, setOperatorReload] = useState(0);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [created, setCreated] = useState("");
  // One request key per distinct submission: a retry of the same name reuses it, so it can never create twice.
  const attempt = useRef<{ name: string; key: string } | null>(null);

  async function createAccount() {
    const name = newName.trim();
    if (creating) return;
    if (name.length < 2 || name.length > 80) {
      setCreateError("Enter an account name of 2 to 80 characters.");
      return;
    }
    if (attempt.current?.name !== name) attempt.current = { name, key: crypto.randomUUID() };
    setCreating(true);
    setCreateError("");
    setCreated("");
    try {
      const account = await client.create(name, attempt.current.key);
      attempt.current = null;
      setNewName("");
      setCreated(`Created ${account.name}.`);
      setReload((value) => value + 1);
      setOperatorReload((value) => value + 1);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "The account could not be created.");
    } finally {
      setCreating(false);
    }
  }

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
        if (current) setData(value);
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
    if (!operatorAllowed) return;
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
  }, [client, operatorAllowed, operatorReload]);

  useEffect(() => {
    if (!account || !operatorAllowed) {
      setDetail(null);
      return;
    }
    const sequence = ++request.current;
    setDetail(null);
    setDetailLoading(true);
    setDetailError("");
    void client
      .operatorDetail(account)
      .then((value) => sequence === request.current && setDetail(value))
      .catch(
        () =>
          sequence === request.current &&
          setDetailError("Account details are unavailable or administrator access has changed."),
      )
      .finally(() => sequence === request.current && setDetailLoading(false));
  }, [account, client, operatorAllowed]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (operator?.accounts ?? [])
      .filter((item) => !term || item.name.toLowerCase().includes(term))
      .map((item) => ({
        id: item.id,
        name: item.name,
        members: `${item.activeMembers} active ${item.activeMembers === 1 ? "member" : "members"}`,
        products: item.products as DirectoryList["accounts"][number]["products"],
        status: item.products.some((product) => product.status === "active") ? "Active" : "No active apps",
      }));
  }, [operator, search]);

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

  const total = operator?.accounts.length;
  return (
    <main className="one-main narrow accounts-workspace" aria-label="Accounts">
      <div className="one-pagehead">
        <div>
          <Eyebrow>•••••• Serve / Accounts</Eyebrow>
          <h1>Accounts</h1>
          <p>
            Customer accounts on Anthus One, with their memberships and app entitlements. These are separate
            from prospects and contacts.
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
          {operatorAllowed && (
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
            You are signed in to Prospectus. Confirm this Google sign-in to check your Accounts administrator
            permission. A new sign-in session requires confirmation again. This does not create an account or
            grant access.
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
        <section className="one-card cool" aria-labelledby="create-account">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createAccount();
            }}
          >
            <h2 id="create-account">Create account</h2>
            <label htmlFor="new-account-name">Account name</label>{" "}
            <input
              id="new-account-name"
              type="text"
              value={newName}
              maxLength={80}
              placeholder="For example, Data Parade"
              autoComplete="off"
              disabled={creating}
              onChange={(event) => setNewName(event.target.value)}
            />{" "}
            <button type="submit" className="one-button primary" disabled={creating}>
              {creating ? "Creating…" : "Create account"}
            </button>
            <p className="one-muted">
              You become the owner. No apps are turned on until an operator grants them.
            </p>
            {createError && (
              <p role="alert" className="one-alert">
                {createError}
              </p>
            )}
            {created && (
              <p role="status" className="one-status">
                {created}
              </p>
            )}
          </form>
        </section>
      )}

      {data?.person && !operatorAllowed && (
        <p role="status" className="one-status">
          An explicitly assigned central Accounts administrator permission is required. CRM administrator
          status does not grant this access.
        </p>
      )}
      {operatorAllowed && (
        <>
          <div className="one-stats">
            <Stat value={total === undefined ? "…" : String(total)} label="ACCOUNTS" />
            <Stat value={null} label="PAYING" note="Needs billing data" />
            <Stat value={null} label="IN TRIAL" note="Needs plan data" />
            <Stat value={null} label="SERVICES ENGAGEMENTS" note="Not yet recorded" hot />
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
          {operatorLoading && <p role="status">Loading account directory…</p>}
          {operatorError && (
            <p role="alert" className="one-alert">
              {operatorError}
            </p>
          )}
          {operator?.accounts.length === 0 && (
            <p role="status">No accounts have been created in the central account directory.</p>
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

function AccountPage({ detail }: { detail: OperatorDetail }) {
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
  return (
    <>
      <section className="one-account-head">
        <div className="one-badges">
          <span className="one-badge">Plan not yet available</span>
          <span className={`one-badge${activeApps ? " ok" : ""}`}>
            {activeApps ? "Active" : "No active apps"}
          </span>
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
                Account memberships
              </h2>
              <span>{activeMembers.length} active</span>
            </div>
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
              <dd>{owner ? <code>{owner.personId}</code> : "None"}</dd>
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
            <p className="one-note">
              You’re viewing as Anthus staff. Administrator access is read-only and does not make you a member
              of this account.
            </p>
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
