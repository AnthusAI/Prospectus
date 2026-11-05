import { hiddenAsSpam } from "../spam-review";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { IssueCollection, type KanbanIssue } from "@kanbus/ui";
import { ANTHUS_APPS } from "../apps";
import type { Configuration, IssueRecord, KanbusClient, Query } from "../client";
import {
  addDays,
  contactChanges,
  interestChanges,
  localDate,
  prospectInterests,
  validateFollowUp,
} from "../prospect";
import { Eyebrow } from "../shared/ui";
import { useIssueCardLinks } from "./card-links";
import { InterestPicker, OwnerField } from "./ProspectFields";

export type Write = (action: () => Promise<IssueRecord>) => Promise<boolean>;

export function PipelineView({
  api,
  configuration,
  version,
  search,
  onSelect,
  creating,
  onCreating,
  busy,
  write,
  onError,
}: {
  api: KanbusClient;
  configuration: Configuration;
  version: number;
  search: string;
  onSelect: (record: IssueRecord) => void;
  creating: boolean;
  onCreating: (creating: boolean) => void;
  busy: boolean;
  write: Write;
  onError: (message: string) => void;
}) {
  const [records, setRecords] = useState<IssueRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [owner, setOwner] = useState<"everyone" | "mine">("everyone");
  const [interest, setInterest] = useState("");
  const [layout, setLayout] = useState<"board" | "list">("board");
  const [showSpam, setShowSpam] = useState(false);
  const requestSequence = useRef(0);

  const query = useMemo<Query>(
    () => ({
      type: "prospect",
      search,
      limit: 100,
      ...(owner === "mine" ? { assignee: configuration.actor_id } : {}),
    }),
    [search, owner, configuration.actor_id],
  );

  const refresh = useCallback(
    async (next?: string) => {
      const sequence = ++requestSequence.current;
      try {
        const result = await api.issues({ ...query, ...(next ? { cursor: next } : {}) });
        if (requestSequence.current !== sequence) return;
        setRecords((previous) => (next ? [...previous, ...result.issues] : result.issues));
        setCursor(result.next_cursor);
        setLoaded(true);
      } catch (cause) {
        if (requestSequence.current === sequence) onError((cause as Error).message);
      }
    },
    [api, query, onError],
  );
  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  const visible = useMemo(
    () =>
      interest ? records.filter((record) => prospectInterests(record.issue).includes(interest)) : records,
    [records, interest],
  );
  // Likely spam and spam are hidden by default, behind a visible count that can show them.
  const hiddenSpam = useMemo(() => visible.filter((record) => hiddenAsSpam(record.issue)).length, [visible]);
  const shown = useMemo(
    () => (showSpam ? visible : visible.filter((record) => !hiddenAsSpam(record.issue))),
    [visible, showSpam],
  );
  const collection = useRef<HTMLDivElement>(null);
  const openById = useCallback(
    (id: string) => {
      const record = records.find((candidate) => candidate.issue.id === id);
      if (record) onSelect(record);
    },
    [records, onSelect],
  );
  useIssueCardLinks(collection, loaded, openById);
  const owners = useMemo(
    () =>
      [...new Set([configuration.actor_id, ...records.map((record) => record.issue.assignee ?? "")])].filter(
        Boolean,
      ),
    [records, configuration.actor_id],
  );

  return (
    <main className="one-main wide" aria-label="Pipeline">
      <div className="one-pagehead">
        <div>
          <Eyebrow>•••••• Sell / Pipeline</Eyebrow>
          <h1>Pipeline</h1>
        </div>
        <div className="one-toolbar">
          <div className="one-segmented" role="group" aria-label="Whose prospects">
            {(
              [
                ["everyone", "Everyone"],
                ["mine", "Mine"],
              ] as const
            ).map(([key, label]) => (
              <button key={key} type="button" aria-pressed={owner === key} onClick={() => setOwner(key)}>
                {label}
              </button>
            ))}
          </div>
          <label className="one-inline-label">
            Interested in
            <select value={interest} onChange={(event) => setInterest(event.target.value)}>
              <option value="">Any app</option>
              {ANTHUS_APPS.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name}
                </option>
              ))}
            </select>
          </label>
          <div className="one-segmented" role="group" aria-label="Layout">
            {(["board", "list"] as const).map((key) => (
              <button key={key} type="button" aria-pressed={layout === key} onClick={() => setLayout(key)}>
                {key === "board" ? "Board" : "List"}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="one-pipeline">
        <section className="one-board" aria-label="Prospect board">
          {loaded && (hiddenSpam > 0 || showSpam) && (
            <p className="one-spam-hidden" role="status">
              {showSpam
                ? `Showing ${hiddenSpam} likely spam or spam.`
                : `${hiddenSpam} hidden as likely spam or spam.`}{" "}
              <button
                type="button"
                className="one-button small"
                aria-pressed={showSpam}
                onClick={() => setShowSpam((value) => !value)}
              >
                {showSpam ? "Hide" : "Show"}
              </button>
            </p>
          )}
          {loaded ? (
            <div ref={collection}>
              <IssueCollection
                issues={shown.map((record) => record.issue)}
                config={configuration}
                query={query}
                view={layout}
                onSelectIssue={(issue: KanbanIssue) => {
                  const record = shown.find((candidate) => candidate.issue.id === issue.id);
                  if (record) onSelect(record);
                }}
                initialScroll="start"
                detailOpen={creating}
                columnStateKey={`prospectus:anthus:${configuration.actor_id}:pipeline`}
                emptyMessage="No prospects match this view."
              />
            </div>
          ) : (
            <p role="status">Loading workspace…</p>
          )}
          {cursor && (
            <button type="button" className="one-button one-loadmore" onClick={() => void refresh(cursor)}>
              Load more
            </button>
          )}
        </section>
        {creating && (
          <NewProspect
            configuration={configuration}
            owners={owners}
            busy={busy}
            write={write}
            api={api}
            onError={onError}
            onClose={() => onCreating(false)}
          />
        )}
      </div>
    </main>
  );
}

function NewProspect({
  configuration,
  owners,
  busy,
  write,
  api,
  onError,
  onClose,
}: {
  configuration: Configuration;
  owners: string[];
  busy: boolean;
  write: Write;
  api: KanbusClient;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  const initialName =
    configuration.statuses.find((status) => status.key === configuration.initial_status)?.name ?? "New";
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const custom = { ...contactChanges(fields), ...interestChanges(fields) };
    const problem = validateFollowUp(
      configuration.initial_status,
      String(fields.get("assignee")),
      custom.next_action,
      custom.next_follow_up_at ?? "",
      configuration,
    );
    if (problem) return onError(problem);
    void write(() =>
      api.create({
        title: String(fields.get("title")),
        type: "prospect",
        assignee: String(fields.get("assignee")).trim(),
        description: String(fields.get("description")),
        custom,
      }),
    );
  }
  return (
    <aside className="one-drawer" aria-label="New prospect">
      <div className="one-drawer-panel">
        <div className="one-drawer-head">
          <h2>New prospect</h2>
          <button type="button" className="one-button small" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <form className="one-drawer-body" onSubmit={create}>
          <fieldset disabled={busy}>
            <label>
              Company
              <input name="company" placeholder="Company name" maxLength={150} />
            </label>
            <div className="one-pair">
              <label>
                Contact name
                <input name="title" placeholder="Full name" required maxLength={250} />
              </label>
              <label>
                Email
                <input name="email" type="email" placeholder="name@company.com" maxLength={254} />
              </label>
            </div>
            <InterestPicker selected={[]} />
            <div className="one-pair">
              <OwnerField owners={owners} value={configuration.actor_id} />
              <label>
                Follow up on
                <input name="followup" type="date" defaultValue={addDays(localDate(), 1)} required />
              </label>
            </div>
            <label>
              Next action
              <input
                name="next_action"
                defaultValue="Reply and book an intro call"
                required
                maxLength={250}
              />
            </label>
            <label>
              First note
              <textarea name="description" rows={3} placeholder="What they asked for, in their words" />
            </label>
            <button className="one-button primary tall" disabled={busy}>
              {busy ? "Saving…" : `Add to ${initialName}`}
            </button>
          </fieldset>
        </form>
      </div>
    </aside>
  );
}
