import type { QuotaView } from "../../packages/accounts-client/src/quota";
import { appForProduct } from "../apps";
import { Unavailable } from "./ui";

type SetQuota = Extract<QuotaView, { state: "set" }>;

/** Integer cents as dollars, for display only. Every amount in the system stays whole cents. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}$${Math.floor(absolute / 100).toLocaleString("en-US")}.${String(absolute % 100).padStart(2, "0")}`;
}

/** An older central service sends no quota at all; that reads as unavailable, never as an empty or unlimited quota. */
export const quotaOf = (view: QuotaView | undefined): QuotaView => view ?? { state: "unavailable" };

/** Share of the allowance already used or held, 0 to 100. */
export function committedShare(quota: SetQuota): number {
  if (quota.allowanceCents <= 0) return quota.usedCents + quota.heldCents > 0 ? 100 : 0;
  return Math.min(100, Math.round(((quota.usedCents + quota.heldCents) / quota.allowanceCents) * 100));
}

export const NO_ALLOWANCE_TEXT =
  "No quota has been granted to this account yet. Until it is, apps on the account cannot start paid cloud work.";
export const UNREADABLE_TEXT =
  "The quota could not be read right now. Apps are not allowed to spend while it is unreadable.";

/** The allowance, what is used and held, and what remains. Text first: nothing depends on colour. */
export function QuotaFigures({ quota }: { quota: SetQuota }) {
  return (
    <dl className="one-dl" aria-label="Quota figures">
      <dt>Allowance</dt>
      <dd>{formatCents(quota.allowanceCents)}</dd>
      <dt>Used</dt>
      <dd>{formatCents(quota.usedCents)}</dd>
      <dt>Held for running work</dt>
      <dd>{formatCents(quota.heldCents)}</dd>
      <dt>Remaining</dt>
      <dd>
        <strong>{formatCents(quota.remainingCents)}</strong>
        {quota.remainingCents < 0 && <> (over the allowance)</>}
      </dd>
      {quota.overageCents > 0 && (
        <>
          <dt>Recorded overage</dt>
          <dd>{formatCents(quota.overageCents)}</dd>
        </>
      )}
    </dl>
  );
}

/** One allowance shared by every app, split by the app that spent or holds it. */
export function QuotaByApp({ quota }: { quota: SetQuota }) {
  if (quota.byProduct.length === 0) return <p className="one-empty">No app has used quota yet.</p>;
  return (
    <div className="one-table-wrap">
      <table className="one-table" style={{ minWidth: 0 }}>
        <thead>
          <tr>
            <th scope="col">App</th>
            <th scope="col">Used</th>
            <th scope="col">Held</th>
          </tr>
        </thead>
        <tbody>
          {quota.byProduct.map((row) => (
            <tr key={row.product}>
              <th scope="row">{appForProduct(row.product).name}</th>
              <td>{formatCents(row.usedCents)}</td>
              <td>{formatCents(row.heldCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The quota card body: figures and split when set, an explicit empty state or unavailable note otherwise. */
export function QuotaPanel({ view }: { view: QuotaView }) {
  if (view.state === "set")
    return (
      <>
        <QuotaFigures quota={view} />
        <QuotaByApp quota={view} />
      </>
    );
  if (view.state === "none")
    return (
      <div className="one-empty" role="note">
        <strong>No quota allowance</strong>
        <p>{NO_ALLOWANCE_TEXT}</p>
      </div>
    );
  return (
    <Unavailable title="Quota unavailable">
      <span>{UNREADABLE_TEXT}</span>
    </Unavailable>
  );
}
