import { randomUUID } from "node:crypto";
import { COST_APPS, DEPLOYMENT_PATTERN, type CostApp } from "./tags.js";

/**
 * The batched usage sender (Prospectus docs/COST_ACCOUNTING.md, "How apps send usage"). An app records what each
 * customer used (model tokens, Lambda time on shared resources, container jobs) as it happens; the sender tallies it
 * in memory and sends one message per Account, deployment and UTC day to the app's own Prospectus usage queue.
 * Recording never waits on the network. Prices are Prospectus's business: send quantities, never dollars.
 *
 * Long-running process: `sender.start()` flushes about once a minute; call `await sender.stop()` on shutdown.
 * Short-lived runtime (Lambda, Amplify compute): `await sender.flush()` before the invocation ends, because a frozen
 * process can lose what is only in memory.
 */

export interface UsageItem {
  /** A namespaced kind the Prospectus price list knows, for example `openai.tokens.input` or `jev.tokens`. */
  itemKind: string;
  /** A whole, non-negative quantity in the kind's own unit. */
  quantity: number;
}

export interface UsageMessage {
  version: 1;
  operationId: string;
  accountId: string;
  app: CostApp;
  deployment?: string;
  day: number;
  items: UsageItem[];
}

export const PROSPECTUS_REGION = "us-east-1";
/**
 * A product's own queue in the Prospectus account. Only that product's roles may send to it, which is how
 * Prospectus knows the sender. The app's infrastructure, which also grants its role `sqs:SendMessage` on this queue,
 * passes the account in and sets the URL as `PROSPECTUS_USAGE_QUEUE_URL`.
 */
export const usageQueueUrl = (product: string, prospectusAccount: string, region = PROSPECTUS_REGION) => {
  if (!/^\d{12}$/.test(prospectusAccount))
    throw new Error("Usage sender: the Prospectus AWS account is 12 digits.");
  return `https://sqs.${region}.amazonaws.com/${prospectusAccount}/prospectus-usage-${product}`;
};
const QUEUE_URL = /^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/\d{12}\/prospectus-usage-([a-z0-9-]+)$/;

const ITEM_KIND = /^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9_:-]*)+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface UsageSenderOptions {
  /** The product's registered name in Prospectus, for example `papyrus-dataparade` or `cyclotron`. */
  product: string;
  app: CostApp;
  /** Default deployment for every record. For a Papyrus site product it must be the site ID. */
  deployment?: string;
  /** The product's usage queue URL. Defaults to the `PROSPECTUS_USAGE_QUEUE_URL` environment variable, which the
   * app's infrastructure sets. It must be this product's own queue. */
  queueUrl?: string;
  /** Sends one message body. Defaults to SQS SendMessage with the runtime's own credentials. */
  send?: (queueUrl: string, body: string) => Promise<void>;
  now?: () => number;
  /** Called with a reason code when a send fails; the message is kept and retried on the next flush. */
  onError?: (reason: string) => void;
}

export class UsageSender {
  private tally = new Map<
    string,
    { accountId: string; deployment?: string; day: number; items: Map<string, number> }
  >();
  /** Messages built but not yet sent: retried with the same operation ID, so Prospectus counts each once. */
  private pending: UsageMessage[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private flushing?: Promise<void>;
  private readonly queueUrl: string;

  constructor(private options: UsageSenderOptions) {
    if (!(COST_APPS as readonly string[]).includes(options.app))
      throw new Error("Usage sender: unknown app.");
    if (options.deployment !== undefined && !DEPLOYMENT_PATTERN.test(options.deployment))
      throw new Error("Usage sender: deployment must be lower-case letters, digits and hyphens.");
    if (options.app === "papyrus" && options.product !== `papyrus-${options.deployment}`)
      throw new Error(
        "Usage sender: a Papyrus site sends as papyrus-<site> with its site ID as the deployment.",
      );
    const queueUrl = options.queueUrl ?? process.env.PROSPECTUS_USAGE_QUEUE_URL;
    if (!queueUrl || QUEUE_URL.exec(queueUrl)?.[1] !== options.product)
      throw new Error(
        "Usage sender: PROSPECTUS_USAGE_QUEUE_URL must be this product's Prospectus usage queue.",
      );
    this.queueUrl = queueUrl;
  }

  /** Adds usage to the in-memory tally. Synchronous and network-free; invalid input throws at once. */
  record(accountId: string, items: readonly UsageItem[], deployment = this.options.deployment): void {
    if (!UUID.test(accountId)) throw new Error("Usage sender: accountId must be a lower-case Account UUID.");
    if (deployment !== undefined && !DEPLOYMENT_PATTERN.test(deployment))
      throw new Error("Usage sender: deployment must be lower-case letters, digits and hyphens.");
    for (const item of items) {
      if (typeof item.itemKind !== "string" || item.itemKind.length > 96 || !ITEM_KIND.test(item.itemKind))
        throw new Error("Usage sender: itemKind must be a namespaced kind such as openai.tokens.input.");
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 0)
        throw new Error("Usage sender: quantity must be a whole, non-negative number.");
    }
    const day = Number(
      new Date((this.options.now ?? Date.now)()).toISOString().slice(0, 10).replaceAll("-", ""),
    );
    const key = `${accountId}|${deployment ?? ""}|${day}`;
    const group = this.tally.get(key) ?? { accountId, deployment, day, items: new Map<string, number>() };
    for (const item of items) {
      const total = (group.items.get(item.itemKind) ?? 0) + item.quantity;
      if (!Number.isSafeInteger(total)) throw new Error("Usage sender: quantity overflow.");
      group.items.set(item.itemKind, total);
    }
    this.tally.set(key, group);
  }

  /** Sends everything tallied so far, plus anything a previous flush could not send. Never throws. */
  flush(): Promise<void> {
    this.flushing ??= this.flushOnce().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  /** Flushes about once a minute until `stop`. The timer does not keep a process alive. */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  /** Messages waiting to be sent, for health checks and tests. */
  get backlog(): number {
    return this.pending.length + this.tally.size;
  }

  private async flushOnce() {
    for (const group of this.tally.values()) {
      const items = [...group.items].filter(([, quantity]) => quantity > 0);
      if (!items.length) continue;
      this.pending.push({
        version: 1,
        operationId: randomUUID(),
        accountId: group.accountId,
        app: this.options.app,
        ...(group.deployment !== undefined ? { deployment: group.deployment } : {}),
        day: group.day,
        items: items.map(([itemKind, quantity]) => ({ itemKind, quantity })),
      });
    }
    this.tally.clear();
    const send = this.options.send ?? sqsSend;
    const unsent: UsageMessage[] = [];
    for (const message of this.pending)
      try {
        await send(this.queueUrl, JSON.stringify(message));
      } catch {
        unsent.push(message);
        this.options.onError?.("send_failed");
      }
    this.pending = unsent;
  }
}

let sqsClient: Promise<{ send: (command: unknown) => Promise<unknown> }> | undefined;
async function sqsSend(queueUrl: string, body: string) {
  const sqs = await import("@aws-sdk/client-sqs");
  sqsClient ??= Promise.resolve(new sqs.SQSClient({ region: PROSPECTUS_REGION }) as never);
  await (await sqsClient).send(new sqs.SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
}
