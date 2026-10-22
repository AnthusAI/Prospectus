import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConditionalControlStore } from "./control-store";
import { IntakeInbox, type StoredInboxItem } from "./inbox";
import { IntakeService, type Inquiry, type IntakeOptions } from "./intake";
import { formContactPolicy, type IntakeFormConfig } from "./intake-forms";
import type { IntakeContactPolicy } from "./intake-contact-policy";
import type { SpamLabelling } from "./intake-spam-mode";

export interface RefileOptions {
  workspace: string;
  store: ConditionalControlStore;
  /** Control paths such as intake-receipts/<sha256>.json, listed with the operator's credentials. */
  paths: string[];
  request: IntakeOptions["request"];
  forms: IntakeFormConfig[];
  demoPolicy: IntakeContactPolicy;
  demoOwner?: string;
  /** Without apply nothing is written to the CRM or the inbox. */
  apply: boolean;
  /** The deployed spam labelling mode, so a refile files exactly as live intake would. */
  spamLabelling?: SpamLabelling;
}
export interface RefileSummary {
  inboxItems: number;
  pending: number;
  filed: number;
  review: number;
  stillPending: number;
  unroutable: number;
}

/** Operator-side retry of pending inbox items. Reports counts only, never contact data. */
export async function refileInbox(options: RefileOptions): Promise<RefileSummary> {
  const inbox = new IntakeInbox(options.store, options.workspace);
  const summary: RefileSummary = {
    inboxItems: 0,
    pending: 0,
    filed: 0,
    review: 0,
    stillPending: 0,
    unroutable: 0,
  };
  const groups = new Map<string, { form?: IntakeFormConfig; items: StoredInboxItem<Inquiry>[] }>();
  for (const path of options.paths) {
    if (!/^intake-receipts\/[a-f0-9]{64}\.json$/.test(path)) continue;
    const object = await options.store.getControl(path);
    if (!object) continue;
    let stored: StoredInboxItem<Inquiry>;
    try {
      if (JSON.parse(object.bytes).kind !== "intake-inbox") continue;
      stored = inbox.decode<Inquiry>(object.bytes, object.revision, path);
    } catch {
      continue;
    }
    summary.inboxItems++;
    if (stored.item.status !== "pending") continue;
    summary.pending++;
    const source = stored.item.inquiry.source;
    const fromRegistry = stored.item.inquiry.kind !== "demo";
    const form = fromRegistry
      ? options.forms.find(
          (item) =>
            item.siteId === source.site_id &&
            item.formId === source.form_id &&
            item.kind === stored.item.inquiry.kind,
        )
      : undefined;
    if (fromRegistry && !form) {
      summary.unroutable++;
      continue;
    }
    const name = `${source.site_id}/${source.form_id}`;
    if (!groups.has(name)) groups.set(name, { form, items: [] });
    groups.get(name)!.items.push(stored);
  }
  if (!options.apply) return summary;
  for (const { form, items } of groups.values()) {
    const directory = await mkdtemp(join(tmpdir(), "prospectus-refile-"));
    try {
      const policy = form ? formContactPolicy(form) : options.demoPolicy;
      const service = await IntakeService.open({
        directory,
        workspace: options.workspace,
        owner: form?.owner ?? options.demoOwner ?? "intake-queue",
        siteId: policy.siteId,
        formId: policy.formId,
        contactPolicy: policy,
        identityStore: options.store,
        request: options.request,
        form,
        log: () => undefined,
        ...(options.spamLabelling ? { spamLabelling: options.spamLabelling } : {}),
      });
      try {
        const totals = await service.refile(items);
        summary.filed += totals.filed;
        summary.review += totals.review;
        summary.stillPending += totals.pending;
      } finally {
        await service.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return summary;
}
