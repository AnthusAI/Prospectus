import type { OperatorQuotaView, QuotaView } from "../../packages/accounts-client/src/quota";
import { appForProduct } from "../apps";
import { Unavailable } from "./ui";

type SetQuota = Extract<QuotaView, { state: "set" }>;
type SetOperatorQuota = Extract<OperatorQuotaView, { state: "set" }>;

/** An older central service sends no quota at all; that reads as unavailable, never as an empty or unlimited quota. */
export const quotaOf = <T extends QuotaView | OperatorQuotaView>(
  view: T | undefined,
): T | { state: "unavailable" } => view ?? { state: "unavailable" };

/** When the week's quota resets, for people: the instant shown in the viewer's own time zone, with the zone named so
 * nobody has to guess (the reset is one fixed moment for every Account, Saturday noon New York time). */
export function formatReset(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "soon"
    : date.toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      });
}

export const NO_ALLOWANCE_TEXT =
  "No weekly quota has been set for this account yet. Until it is, apps on the account cannot start paid cloud work.";
export const UNREADABLE_TEXT =
  "The quota could not be read right now. Apps are not allowed to spend while it is unreadable.";
export const FULL_TEXT = "The quota is used up. New work is paused until it resets.";

/** One bar with the number beside it: the text carries the meaning, so nothing depends on colour. */
export function QuotaMeter({ percent }: { percent: number }) {
  return (
    <div className="quota-meter" role="img" aria-label={`${percent} percent of this week's quota used`}>
      <span className="quota-meter-track" aria-hidden="true">
        <span className="quota-meter-fill" style={{ width: `${percent}%` }} />
      </span>
      <strong>{percent}% used</strong>
    </div>
  );
}

/** Each app's contribution to the number, in whole percent of the quota. */
export function QuotaByApp({ quota }: { quota: SetQuota | SetOperatorQuota }) {
  if (quota.byProduct.length === 0) return <p className="one-empty">No app has used quota this week.</p>;
  return (
    <div className="one-table-wrap">
      <table className="one-table" style={{ minWidth: 0 }}>
        <thead>
          <tr>
            <th scope="col">App</th>
            <th scope="col">Share of the quota</th>
          </tr>
        </thead>
        <tbody>
          {quota.byProduct.map((row) => (
            <tr key={row.product}>
              <th scope="row">{appForProduct(row.product).name}</th>
              <td>{row.percentOfQuota}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Staff only: Prospectus's internal usage units, the plan and the table versions. Never the rate table itself. */
export function OperatorQuotaDetail({ quota }: { quota: SetOperatorQuota }) {
  return (
    <dl className="one-dl" aria-label="Internal usage">
      <dt>Plan</dt>
      <dd>{quota.planId ?? "None chosen"}</dd>
      <dt>Allowance override</dt>
      <dd>{quota.allowanceOverrideUnits === null ? "None" : `${quota.allowanceOverrideUnits} units`}</dd>
      <dt>Weekly allowance</dt>
      <dd>{quota.allowanceUnits} units</dd>
      <dt>Used</dt>
      <dd>{quota.usedUnits} units</dd>
      <dt>Held for running work</dt>
      <dd>{quota.heldUnits} units</dd>
      {quota.overshootUnits > 0 && (
        <>
          <dt>Over the allowance</dt>
          <dd>{quota.overshootUnits} units</dd>
        </>
      )}
      <dt>Week started</dt>
      <dd>{formatReset(quota.startedAt)}</dd>
      <dt>Table versions</dt>
      <dd>{quota.tableVersions.length ? quota.tableVersions.join(", ") : "None charged yet"}</dd>
    </dl>
  );
}

/** The quota card body: the percentage and reset time, an empty state, or an unavailable note. */
export function QuotaPanel({ view }: { view: QuotaView | OperatorQuotaView }) {
  if (view.state === "set")
    return (
      <>
        <QuotaMeter percent={view.percentUsed} />
        <p className="one-muted" style={{ margin: 0 }}>
          Resets {formatReset(view.resetsAt)}
          {view.percentUsed >= 100 ? `. ${FULL_TEXT}` : ""}
        </p>
        <QuotaByApp quota={view} />
        {"allowanceUnits" in view && <OperatorQuotaDetail quota={view} />}
      </>
    );
  if (view.state === "none")
    return (
      <div className="one-empty" role="note">
        <strong>No weekly quota</strong>
        <p>{NO_ALLOWANCE_TEXT}</p>
        {"planId" in view && <p className="one-muted">Plan: {view.planId ?? "none chosen"}</p>}
      </div>
    );
  return (
    <Unavailable title="Quota unavailable">
      <span>{UNREADABLE_TEXT}</span>
    </Unavailable>
  );
}
