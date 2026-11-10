import { useRef, useState } from "react";
import { accountPath } from "../deep-links";
import { engagementAmount, periodLabel, setupProgress, shortDate } from "../billing/derive";
import { moneyProblem, parseCents } from "../billing/money";
import { billingHref } from "../billing/routes";
import {
  SETUP_STAGES,
  type AccountSummary,
  type Engagement,
  type EngagementType,
  type SetupStage,
} from "../billing/types";
import { operationId } from "../operation-id";
import { BillingLink, BillingUnavailable, MoneyField } from "../shared/billing";
import { Eyebrow, Icon, Stat } from "../shared/ui";
import { useBilling } from "./BillingProvider";

type Filter = "active" | "ongoing" | "setup" | "proposed";
const FILTERS: Record<Filter, { label: string; test: (engagement: Engagement) => boolean }> = {
  active: { label: "Active", test: (engagement) => engagement.status === "active" },
  ongoing: {
    label: "Ongoing",
    test: (engagement) => engagement.status === "active" && engagement.type === "ongoing",
  },
  setup: {
    label: "Setup packages",
    test: (engagement) => engagement.status === "active" && engagement.type === "setup",
  },
  proposed: { label: "Proposed", test: (engagement) => engagement.status === "proposed" },
};

/** Engagements that are running now: started and not ended. */
export const runningEngagements = (engagements: readonly Engagement[]) =>
  engagements.filter((engagement) => engagement.status === "active");

const kindLabel = (engagement: Engagement) =>
  engagement.status === "proposed" ? "Proposed" : engagement.type === "ongoing" ? "Ongoing" : "Setup package";

function dates(engagement: Engagement, today: string) {
  if (engagement.status === "proposed") return `Would start ${shortDate(engagement.startDate, today)}`;
  if (engagement.status === "ended")
    return `${shortDate(engagement.startDate, today)} to ${shortDate(engagement.endDate, today)}, ended`;
  if (engagement.type === "setup")
    return `${shortDate(engagement.startDate, today)} to ${shortDate(engagement.endDate, today)}`;
  return `Since ${shortDate(engagement.startDate, today)}`;
}

function standing(engagement: Engagement, today: string) {
  if (engagement.uninvoicedMonth) return `${periodLabel(engagement.uninvoicedMonth)} not invoiced yet`;
  if (engagement.type === "setup" && engagement.status === "active") return setupProgress(engagement, today);
  if (engagement.lastInvoiced) return `Last invoiced ${shortDate(engagement.lastInvoiced.issueDate, today)}`;
  return engagement.status === "proposed" ? "Not started" : "Not invoiced yet";
}

/** One engagement, with what an admin can do to it in place. */
function EngagementRow({
  engagement,
  accountName,
  showAccount,
}: {
  engagement: Engagement;
  accountName: string;
  showAccount: boolean;
}) {
  const { client, canAct, refresh, today } = useBilling();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [ending, setEnding] = useState(false);
  const attempt = useRef(operationId());
  async function change(input: { stage?: SetupStage; status?: "active" | "ended" }) {
    setBusy(true);
    setProblem("");
    try {
      await client.changeEngagement(engagement.id, {
        operationId: attempt.current,
        expectedRevision: engagement.revision,
        ...input,
      });
      attempt.current = operationId();
      setEnding(false);
      refresh();
    } catch (cause) {
      setProblem((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="one-row engagement-row">
      <span className={`engagement-kind ${engagement.status === "proposed" ? "proposed" : engagement.type}`}>
        {kindLabel(engagement)}
      </span>
      <span className="one-row-main">
        <span className="one-row-title">{engagement.name}</span>
        <span className="one-row-sub">
          {showAccount && (
            <>
              <a href={accountPath(engagement.accountId)}>{accountName}</a> ·{" "}
            </>
          )}
          {engagement.lead} leads · {dates(engagement, today)}
        </span>
        <span className={`one-row-sub${engagement.uninvoicedMonth ? " engagement-waiting" : ""}`}>
          {standing(engagement, today)}
          {engagement.lastInvoiced && (
            <>
              {" · "}
              <BillingLink href={billingHref.invoice(engagement.lastInvoiced.invoiceNumber)}>
                {engagement.lastInvoiced.invoiceNumber}
              </BillingLink>
            </>
          )}
        </span>
        {problem && (
          <span role="alert" className="billing-error">
            {problem}
          </span>
        )}
      </span>
      <span className="engagement-side">
        <span className="engagement-amount">{engagementAmount(engagement)}</span>
        {canAct && engagement.status !== "ended" && (
          <span className="one-toolbar">
            {engagement.status === "proposed" && (
              <button
                type="button"
                className="one-button small"
                disabled={busy}
                onClick={() => void change({ status: "active" })}
              >
                Start
              </button>
            )}
            {engagement.type === "setup" && engagement.status === "active" && (
              <label>
                <span className="sr-only">Stage of {engagement.name}</span>
                <select
                  value={engagement.stage ?? "Installation"}
                  disabled={busy}
                  onChange={(event) => void change({ stage: event.target.value as SetupStage })}
                >
                  {SETUP_STAGES.map((stage) => (
                    <option key={stage} value={stage}>
                      {stage}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {engagement.uninvoicedMonth && (
              <BillingLink href={billingHref.newInvoice(engagement.accountId)}>Raise invoice</BillingLink>
            )}
            {ending ? (
              <>
                <button
                  type="button"
                  className="one-button small"
                  disabled={busy}
                  onClick={() => void change({ status: "ended" })}
                >
                  End today
                </button>
                <button type="button" className="one-button small" onClick={() => setEnding(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button
                type="button"
                className="one-button small"
                aria-label={`End ${engagement.name}`}
                disabled={busy}
                onClick={() => setEnding(true)}
              >
                End
              </button>
            )}
          </span>
        )}
      </span>
    </div>
  );
}

/** Starts an engagement, ongoing or a setup package, for a chosen account or a fixed one. */
function NewEngagementForm({
  accounts,
  accountId: fixedAccount,
  onDone,
}: {
  accounts: AccountSummary[];
  accountId?: string;
  onDone: () => void;
}) {
  const { client, refresh, today } = useBilling();
  const [type, setType] = useState<EngagementType>("ongoing");
  const [accountId, setAccountId] = useState(fixedAccount ?? "");
  const [name, setName] = useState("");
  const [lead, setLead] = useState("");
  const [startDate, setStartDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [weeks, setWeeks] = useState("6");
  const [proposed, setProposed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const attempt = useRef(operationId());
  const money = parseCents(amount);
  const weeksOk = /^\d{1,3}$/.test(weeks.trim()) && Number(weeks) >= 1 && Number(weeks) <= 104;
  const issue = !accountId
    ? "Choose an account."
    : !name.trim()
      ? "Name the engagement."
      : !lead.trim()
        ? "Say who leads it."
        : !/^\d{4}-\d{2}-\d{2}$/.test(startDate)
          ? "Choose the start date."
          : !money.ok || money.cents === 0
            ? type === "ongoing"
              ? "Enter the monthly amount."
              : "Enter the package price."
            : type === "setup" && !weeksOk
              ? "The length is 1 to 104 weeks."
              : "";
  async function submit() {
    if (issue || !money.ok) return;
    setBusy(true);
    setProblem("");
    try {
      await client.createEngagement({
        operationId: attempt.current,
        accountId,
        name: name.trim(),
        type,
        status: proposed ? "proposed" : "active",
        lead: lead.trim(),
        startDate,
        ...(type === "ongoing"
          ? { monthlyAmountCents: money.cents }
          : { packagePriceCents: money.cents, lengthWeeks: Number(weeks) }),
      });
      refresh();
      onDone();
    } catch (cause) {
      setProblem((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="one-card strong" aria-labelledby="new-engagement-heading">
      <h2 id="new-engagement-heading" className="small">
        New engagement
      </h2>
      <fieldset className="one-segmented" aria-label="What kind">
        <legend className="sr-only">What kind</legend>
        <button type="button" aria-pressed={type === "ongoing"} onClick={() => setType("ongoing")}>
          Ongoing
        </button>
        <button type="button" aria-pressed={type === "setup"} onClick={() => setType("setup")}>
          Setup package
        </button>
      </fieldset>
      <p className="one-muted">
        {type === "ongoing"
          ? "Runs until someone ends it. No end date or stages."
          : "Installation, then a few weeks of training and higher-level support."}
      </p>
      <div className="billing-form-grid">
        {!fixedAccount && (
          <label>
            Account
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">Choose an account</option>
              {accounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Name
          <input type="text" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Anthus lead
          <input type="text" value={lead} maxLength={120} onChange={(event) => setLead(event.target.value)} />
        </label>
        <label>
          Starts
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
        </label>
        <MoneyField
          label={type === "ongoing" ? "Monthly amount" : "Package price"}
          value={amount}
          onChange={setAmount}
          error={amount.trim() === "" ? "" : moneyProblem(money)}
        />
        {type === "setup" && (
          <label>
            Length in weeks
            <input
              type="text"
              inputMode="numeric"
              value={weeks}
              onChange={(event) => setWeeks(event.target.value)}
            />
          </label>
        )}
      </div>
      <label className="one-checkline">
        <input type="checkbox" checked={proposed} onChange={(event) => setProposed(event.target.checked)} />
        Proposed, not started yet
      </label>
      {(problem || (issue && name)) && (
        <p role="alert" className="billing-error">
          {problem || issue}
        </p>
      )}
      <div className="one-toolbar">
        <button
          type="button"
          className="one-button primary"
          disabled={busy || Boolean(issue)}
          onClick={() => void submit()}
        >
          {proposed ? "Record proposal" : "Start engagement"}
        </button>
        <button type="button" className="one-button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** The Engagements page: the services work Anthus does for each client. */
export function EngagementsView() {
  const { available, canAct, overview } = useBilling();
  const [filter, setFilter] = useState<Filter>("active");
  const [creating, setCreating] = useState(false);
  if (!available) return <BillingUnavailable label="Engagements" />;
  if (overview.status !== "ready")
    return (
      <main className="one-main narrow" aria-label="Engagements">
        <div className="one-pagehead">
          <div>
            <Eyebrow>•••••• Serve / Engagements</Eyebrow>
            <h1>Engagements</h1>
          </div>
        </div>
        <p role="status">{overview.status === "error" ? overview.message : "Loading engagements…"}</p>
      </main>
    );
  const { engagements, accounts } = overview.data;
  const nameOf = (id: string) => accounts.find((account) => account.id === id)?.name ?? "Account";
  const shown = engagements
    .filter(FILTERS[filter].test)
    .sort((a, b) => nameOf(a.accountId).localeCompare(nameOf(b.accountId)) || a.name.localeCompare(b.name));
  const waiting = engagements.filter((engagement) => engagement.uninvoicedMonth).length;
  const monthly = runningEngagements(engagements)
    .filter((engagement) => engagement.type === "ongoing")
    .reduce((sum, engagement) => sum + (engagement.monthlyAmountCents ?? 0), 0);
  return (
    <main className="one-main narrow" aria-label="Engagements">
      <div className="one-pagehead">
        <div>
          <Eyebrow>•••••• Serve / Engagements</Eyebrow>
          <h1>Engagements</h1>
          <p>The services work we&rsquo;re doing for each client.</p>
        </div>
        {canAct && !creating && (
          <button type="button" className="one-button primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} />
            New engagement
          </button>
        )}
      </div>
      <div className="one-stats">
        <Stat value={String(runningEngagements(engagements).length)} label="ACTIVE" />
        <Stat
          value={engagementAmount({ type: "ongoing", monthlyAmountCents: monthly } as Engagement).replace(
            " / month",
            "",
          )}
          label="ONGOING PER MONTH"
        />
        <Stat
          value={String(waiting)}
          label="TO INVOICE"
          note={waiting ? "A month has no invoice yet" : "Every month is invoiced"}
          hot={waiting > 0}
        />
      </div>
      {creating && <NewEngagementForm accounts={accounts} onDone={() => setCreating(false)} />}
      <div className="one-filters" role="group" aria-label="Show">
        {(Object.keys(FILTERS) as Filter[]).map((key) => (
          <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {FILTERS[key].label} <span>{engagements.filter(FILTERS[key].test).length}</span>
          </button>
        ))}
      </div>
      <section className="one-card strong" aria-label={`${FILTERS[filter].label} engagements`}>
        {shown.length === 0 && <p className="one-empty">No engagements here.</p>}
        {shown.map((engagement) => (
          <EngagementRow
            key={engagement.id}
            engagement={engagement}
            accountName={nameOf(engagement.accountId)}
            showAccount
          />
        ))}
      </section>
    </main>
  );
}

/** The Account page's engagements: this account's, with a way to start one. */
export function AccountEngagements({ accountId, accountName }: { accountId: string; accountName: string }) {
  const { available, canAct, overview } = useBilling();
  const [creating, setCreating] = useState(false);
  if (!available)
    return <p className="one-muted">Engagements appear here once Anthus One records billing.</p>;
  if (overview.status !== "ready")
    return <p role="status">{overview.status === "error" ? overview.message : "Loading engagements…"}</p>;
  const mine = overview.data.engagements
    .filter((engagement) => engagement.accountId === accountId)
    .sort(
      (a, b) => Number(a.status === "ended") - Number(b.status === "ended") || a.name.localeCompare(b.name),
    );
  return (
    <>
      {mine.length === 0 && !creating && <p className="one-empty">No services engagements yet.</p>}
      {mine.map((engagement) => (
        <EngagementRow
          key={engagement.id}
          engagement={engagement}
          accountName={accountName}
          showAccount={false}
        />
      ))}
      {creating ? (
        <NewEngagementForm
          accounts={overview.data.accounts}
          accountId={accountId}
          onDone={() => setCreating(false)}
        />
      ) : (
        canAct && (
          <div className="one-toolbar">
            <button type="button" className="one-button small" onClick={() => setCreating(true)}>
              <Icon name="plus" size={14} />
              New engagement
            </button>
          </div>
        )
      )}
    </>
  );
}

/** The Account page's count of its running engagements. */
export function AccountEngagementStat({ accountId }: { accountId: string }) {
  const { overview } = useBilling();
  if (overview.status !== "ready") return <Stat value={null} label="ENGAGEMENTS" note="Needs billing data" />;
  const running = runningEngagements(
    overview.data.engagements.filter((engagement) => engagement.accountId === accountId),
  );
  const waiting = running.filter((engagement) => engagement.uninvoicedMonth).length;
  return (
    <Stat
      value={String(running.length)}
      label="ENGAGEMENTS"
      note={waiting ? `${waiting} to invoice` : "Active now"}
      hot={waiting > 0}
      href="#engagements-heading"
    />
  );
}
