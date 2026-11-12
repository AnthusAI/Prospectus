/**
 * Synthetic review only. A fixture of fictional clients behind the billing client interface, so every billing
 * screen can be reviewed and tested before the ledger exists. It is imported only when the build mode is
 * `synthetic-review`; the production bundle has none of it (test/billing-bundle.test.ts checks). Every name here
 * is made up, every contact uses a reserved example domain, and the issuer is not a real company.
 *
 * It keeps its records in memory for one page load, so the actions can be tried. It is a stand-in for review,
 * not a ledger.
 */
import { addDays } from "../prospect";
import type { AccountsBrowser } from "../accounts-client";
import { METHOD_IN_SENTENCE } from "./derive";
import { BILLING_PERMISSION, BillingError } from "./types";
import type {
  AccountSummary,
  Allocation,
  BillingClient,
  BillingContact,
  BillingLine,
  BillingProfile,
  Engagement,
  Invoice,
  InvoiceLineItem,
  IssuerSettings,
  JournalEvent,
  Payment,
} from "./types";

const OPERATOR = "Sam Rivera";
const AGENT = "Agent for Sam Rivera";

interface Options {
  today: string;
  /** Review the pages as an operator without the billing permission. */
  readOnly?: boolean;
  /** Review the sender choice with Stripe connected. */
  stripeConnected?: boolean;
}

const ID = (kind: number, index: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

const CLIENTS: Array<{ name: string; mode?: "direct" | "invoiced"; contact?: BillingContact }> = [
  {
    name: "Harbor Lantern Media",
    mode: "invoiced",
    contact: {
      name: "Maya Kline",
      email: "accounts@harborlantern.example",
      address: "1 Harbor Way, Exampleton, EX 00001",
    },
  },
  {
    name: "Marigold Credit Union",
    mode: "invoiced",
    contact: {
      name: "Priya Shah",
      email: "payables@marigold.example",
      address: "2 Marigold Court, Exampleton, EX 00002",
    },
  },
  {
    name: "Ridgeline Supply Co.",
    mode: "invoiced",
    contact: {
      name: "Tess Moreno",
      email: "ap@ridgeline.example",
      address: "3 Ridge Road, Exampleton, EX 00003",
    },
  },
  {
    name: "Nimbus Cloud Systems",
    mode: "direct",
    contact: {
      name: "Dev Patel",
      email: "billing@nimbus.example",
      address: "4 Cloud Lane, Exampleton, EX 00004",
    },
  },
  {
    name: "Northfield Press",
    mode: "invoiced",
    contact: {
      name: "Ben Ito",
      email: "office@northfield.example",
      address: "5 Press Street, Exampleton, EX 00005",
    },
  },
  { name: "Kestrel Logistics" },
];
export const SYNTHETIC_ACCOUNT_IDS = CLIENTS.map((_, index) => ID(1, index + 1));

const mask = (text: string) =>
  text.length <= 1 ? "•" : `${text[0]}${"•".repeat(Math.min(text.length - 1, 8))}`;
function maskContact(contact: BillingContact): BillingContact {
  const [name, ...rest] = contact.name.split(" ");
  const [local, domain] = contact.email.split("@");
  return {
    name: `${mask(name)} ${rest.map((part) => `${part[0]}.`).join(" ")}`.trim(),
    email: `${mask(local)}@${domain}`,
    address: "•••••••••••••••",
  };
}

const ISSUER: IssuerSettings = {
  issuer: {
    legalName: "Example Issuer, Inc.",
    billingEmail: "billing@issuer.example",
    addressLines: ["100 Example Street", "Exampleton, EX 00000"],
    footerNote: "Thank you for your business.",
  },
  paymentMethods: [
    {
      label: "Bank transfer",
      instructions: "Details are on the invoice PDF. This is a review fixture.",
      offered: true,
    },
    {
      label: "Check",
      instructions: "Payable to Example Issuer, Inc., mailed to the address above",
      offered: false,
    },
  ],
  defaultNetTermsDays: 30,
  nextInvoiceNumber: "",
  stripe: { connected: false },
  revision: 1,
};

export function syntheticBilling(options: Options): BillingClient {
  const { today } = options;
  const month = (date: string) => date.slice(0, 7);
  const monthStart = `${month(today)}-01`;
  const previousStart = `${month(addDays(monthStart, -1))}-01`;
  const accounts: AccountSummary[] = CLIENTS.map((client, index) => ({
    id: SYNTHETIC_ACCOUNT_IDS[index],
    name: client.name,
    mode: client.mode,
    billable: Boolean(client.mode),
  }));
  const [harbor, marigold, ridgeline, nimbus, northfield] = SYNTHETIC_ACCOUNT_IDS;
  const issuer: IssuerSettings = structuredClone({
    ...ISSUER,
    stripe: options.stripeConnected ? { connected: true, mode: "test" as const } : { connected: false },
  });
  const profiles = new Map<string, BillingProfile>();
  const contacts = new Map<string, BillingContact>();
  CLIENTS.forEach((client, index) => {
    if (!client.mode || !client.contact) return;
    contacts.set(SYNTHETIC_ACCOUNT_IDS[index], client.contact);
    profiles.set(SYNTHETIC_ACCOUNT_IDS[index], {
      accountId: SYNTHETIC_ACCOUNT_IDS[index],
      mode: client.mode,
      currency: "usd",
      contactMasked: maskContact(client.contact),
      status: "active",
      revision: 1,
    });
  });
  const lines: BillingLine[] = [
    {
      accountId: harbor,
      product: "papyrus-harbor-lantern",
      name: "Papyrus · Harbor Lantern newsroom",
      planId: "test-newsroom",
      planName: "Newsroom (test plan)",
      status: "active",
      periodStart: monthStart,
      periodEnd: addDays(`${month(addDays(monthStart, 32))}-01`, -1),
      unitAmountCents: 500000,
    },
    {
      accountId: harbor,
      product: "cyclotron",
      name: "Cyclotron Lab",
      planId: "test-lab",
      planName: "Lab (test plan)",
      status: "active",
      periodStart: monthStart,
      periodEnd: addDays(`${month(addDays(monthStart, 32))}-01`, -1),
      unitAmountCents: 150000,
    },
    {
      accountId: harbor,
      product: "papyrus-harbor-archive",
      name: "Papyrus · Harbor Lantern archive",
      status: "none",
    },
    {
      accountId: marigold,
      product: "cyclotron",
      name: "Cyclotron Lab",
      planId: "test-lab",
      planName: "Lab (test plan)",
      status: "active",
      periodStart: monthStart,
      unitAmountCents: 240000,
    },
    {
      accountId: ridgeline,
      product: "kanbus",
      name: "Kanbus",
      planId: "test-team",
      planName: "Team (test plan)",
      status: "active",
      periodStart: monthStart,
      unitAmountCents: 1200000,
    },
  ];

  const invoices: Invoice[] = [];
  const payments: Payment[] = [];
  const journal: JournalEvent[] = [];
  let serial = 0;
  const next = () => ++serial;
  const sequence = (date: string) =>
    `${date.slice(0, 4)}${date.slice(5, 7)}-${String(
      invoices.filter((invoice) => invoice.number?.startsWith(`${date.slice(0, 4)}${date.slice(5, 7)}-`))
        .length + 1,
    ).padStart(3, "0")}`;
  const seed = (
    accountId: string,
    issuedAt: string,
    total: number,
    status: Invoice["status"],
    via: Invoice["issuedVia"],
    items: InvoiceLineItem[],
    terms = 30,
  ) => {
    const invoice: Invoice = {
      id: ID(2, next()),
      accountId,
      number: sequence(issuedAt),
      currency: "usd",
      lineItems: items,
      subtotalCents: total,
      totalCents: total,
      issuedVia: via,
      issuedAt,
      dueAt: addDays(issuedAt, terms),
      netTermsDays: terms,
      status,
      period: month(issuedAt),
      creditsCents: 0,
      balanceCents: total,
      issuer: structuredClone(ISSUER.issuer),
      paymentMethods: structuredClone(ISSUER.paymentMethods.filter((method) => method.offered)),
      revision: 1,
    };
    invoices.push(invoice);
    return invoice;
  };
  const item = (description: string, cents: number, period: string): InvoiceLineItem => ({
    description,
    quantity: 1,
    unitAmountCents: cents,
    period,
  });
  const newsroom = (period: string) => item("Papyrus · Harbor Lantern newsroom", 500000, period);
  const lab = (period: string) => item("Cyclotron Lab", 150000, period);
  const label = (start: string) => `${start.slice(0, 7)}`;

  // Oldest first so each month's counter starts at 001.
  seed(marigold, addDays(previousStart, -15), 90000, "uncollectible", "manual", [
    item("Cyclotron Lab", 90000, label(addDays(previousStart, -15))),
  ]);
  const northfieldInvoice = seed(northfield, previousStart, 300000, "issued", "manual", [
    item("Papyrus · Northfield newsroom", 300000, label(previousStart)),
  ]);
  const marigoldInvoice = seed(marigold, previousStart, 240000, "issued", "stripe", [
    item("Cyclotron Lab", 240000, label(previousStart)),
  ]);
  const harborOctober = seed(harbor, previousStart, 650000, "issued", "manual", [
    newsroom(label(previousStart)),
    lab(label(previousStart)),
  ]);
  const ridgelineInvoice = seed(ridgeline, addDays(previousStart, 14), 1200000, "issued", "manual", [
    item("Kanbus", 1200000, label(previousStart)),
  ]);
  const voided = seed(nimbus, addDays(previousStart, 19), 120000, "void", "manual", [
    item("Nimbus Chatticus seats", 120000, label(previousStart)),
  ]);
  voided.balanceCents = 0;
  const nimbusInvoice = seed(nimbus, monthStart, 120000, "issued", "stripe", [
    item("Nimbus Chatticus seats", 120000, label(monthStart)),
  ]);
  const harborNovember = seed(harbor, addDays(monthStart, 1), 650000, "issued", "manual", [
    newsroom(label(monthStart)),
    lab(label(monthStart)),
  ]);

  const event = (partial: Omit<JournalEvent, "id">): void => {
    journal.push({ ...partial, id: ID(3, next()) });
  };
  const method = (payment: Payment) =>
    payment.method === "check"
      ? `check ${payment.reference?.replace(/^No\.?\s*/i, "")}`
      : METHOD_IN_SENTENCE[payment.method];
  const allocate = (payment: Payment, invoice: Invoice, cents: number, at: string, by: string) => {
    const allocation: Allocation = {
      id: ID(4, next()),
      paymentId: payment.id,
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      amountCents: cents,
      at,
      by,
      paymentLabel: method(payment),
    };
    payment.allocations.push(allocation);
    return allocation;
  };
  const settle = (invoice: Invoice, at: string) => {
    if (["void", "uncollectible", "draft"].includes(invoice.status)) return;
    const net = payments
      .flatMap((payment) => payment.allocations)
      .filter((allocation) => allocation.invoiceId === invoice.id)
      .reduce(
        (sum, allocation) =>
          sum + (allocation.reversal_of ? -allocation.amountCents : allocation.amountCents),
        0,
      );
    invoice.balanceCents = invoice.totalCents - net - invoice.creditsCents;
    invoice.status = invoice.balanceCents === 0 ? "paid" : net > 0 ? "partially_paid" : "issued";
    invoice.paidAt = invoice.status === "paid" ? at : null;
    invoice.revision += 1;
  };
  const settleAll = (payment: Payment) => {
    payment.unallocatedCents = payment.reversal
      ? 0
      : payment.amountCents -
        payment.allocations.reduce(
          (sum, allocation) =>
            sum + (allocation.reversal_of ? -allocation.amountCents : allocation.amountCents),
          0,
        );
    payment.revision += 1;
  };
  const addPayment = (
    accountId: string,
    cents: number,
    kind: Payment["method"],
    reference: string,
    daysAgo: number,
    by: string,
    applied: Array<[Invoice, number]>,
  ) => {
    const at = addDays(today, -daysAgo);
    const payment: Payment = {
      id: ID(5, next()),
      accountId,
      amountCents: cents,
      currency: "usd",
      method: kind,
      receivedAt: at,
      reference,
      recordedBy: by,
      unallocatedCents: cents,
      allocations: [],
      revision: 1,
    };
    payments.push(payment);
    for (const [invoice, amount] of applied) {
      allocate(payment, invoice, amount, at, by);
      settle(invoice, at);
    }
    settleAll(payment);
    return payment;
  };

  addPayment(northfield, 300000, "bank_transfer", "TRF-8207", 16, OPERATOR, [[northfieldInvoice, 300000]]);
  const bounced = addPayment(harbor, 50000, "check", "No. 1031", 8, OPERATOR, [[harborOctober, 50000]]);
  const reversedAt = addDays(today, -6);
  bounced.reversal = { at: reversedAt, by: OPERATOR, reason: "Returned by the bank" };
  for (const original of [...bounced.allocations])
    allocate(bounced, harborOctober, original.amountCents, reversedAt, OPERATOR).reversal_of = original.id;
  settleAll(bounced);
  settle(harborOctober, reversedAt);
  addPayment(nimbus, 120000, "stripe_card", "pi_3Q…x7f", 4, "Stripe", [[nimbusInvoice, 120000]]);
  addPayment(harbor, 400000, "check", "No. 1042", 2, AGENT, [[harborOctober, 250000]]);
  addPayment(ridgeline, 500000, "bank_transfer", "TRF-8841", 1, OPERATOR, [[ridgelineInvoice, 500000]]);
  void marigoldInvoice;

  const at = (date: string) => `${date}T15:00:00Z`;
  const harborEvents: Array<Omit<JournalEvent, "id">> = [
    {
      at: at(addDays(today, -2)),
      actor: AGENT,
      action: "payment.recorded",
      accountId: harbor,
      paymentLabel: "check 1042",
      amountCents: 400000,
      appliedCents: 250000,
      invoiceNumber: harborOctober.number!,
    },
    {
      at: at(addDays(monthStart, 1)),
      actor: OPERATOR,
      action: "invoice.issued",
      accountId: harbor,
      invoiceNumber: harborNovember.number!,
      amountCents: 650000,
    },
    {
      at: at(monthStart),
      actor: "Billing",
      action: "invoice.past_due",
      accountId: harbor,
      invoiceNumber: harborOctober.number!,
    },
    {
      at: at(reversedAt),
      actor: OPERATOR,
      action: "payment.reversed",
      accountId: harbor,
      paymentLabel: "check 1031",
      amountCents: 50000,
      reason: "Returned by the bank",
      invoiceNumber: harborOctober.number!,
    },
    {
      at: at(addDays(today, -8)),
      actor: OPERATOR,
      action: "payment.recorded",
      accountId: harbor,
      paymentLabel: "check 1031",
      amountCents: 50000,
      appliedCents: 50000,
      invoiceNumber: harborOctober.number!,
    },
    {
      at: at(previousStart),
      actor: OPERATOR,
      action: "invoice.issued",
      accountId: harbor,
      invoiceNumber: harborOctober.number!,
      amountCents: 650000,
    },
    {
      at: at(addDays(previousStart, -1)),
      actor: OPERATOR,
      action: "profile.saved",
      accountId: harbor,
      detail: "Set the billing profile to invoiced, net 30.",
    },
  ];
  harborEvents.forEach(event);
  for (const invoice of invoices.filter((entry) => entry.accountId !== harbor && entry.number))
    event({
      at: at(invoice.issuedAt!),
      actor: invoice.issuedVia === "stripe" ? "Stripe" : OPERATOR,
      action: "invoice.issued",
      accountId: invoice.accountId,
      invoiceNumber: invoice.number!,
      amountCents: invoice.totalCents,
    });
  for (const invoice of invoices.filter((entry) => entry.status === "uncollectible"))
    event({
      at: at(addDays(invoice.dueAt!, 5)),
      actor: OPERATOR,
      action: "invoice.written_off",
      accountId: invoice.accountId,
      invoiceNumber: invoice.number!,
      reason: "Client closed",
    });
  for (const invoice of invoices.filter((entry) => entry.status === "void"))
    event({
      at: at(addDays(invoice.issuedAt!, 1)),
      actor: OPERATOR,
      action: "invoice.voided",
      accountId: invoice.accountId,
      invoiceNumber: invoice.number!,
      reason: "Issued to the wrong account",
    });

  const sorted = <T extends { at: string }>(list: T[]) => [...list].sort((a, b) => b.at.localeCompare(a.at));
  const accountOf = (id: string) => {
    const found = accounts.find((entry) => entry.id === id);
    if (!found) throw new BillingError(404, "That account was not found.", "not_found");
    return found;
  };
  const allowed = () => {
    if (options.readOnly)
      throw new BillingError(403, "Changing billing needs the billing permission.", "forbidden");
  };
  const copy = <T>(value: T): T => structuredClone(value);
  const done = new Map<string, unknown>();
  const once = <T>(operationId: string, action: () => T): T => {
    allowed();
    if (done.has(operationId)) return copy(done.get(operationId) as T);
    const result = action();
    done.set(operationId, copy(result));
    return result;
  };
  const findInvoice = (reference: string) => {
    const found = invoices.find((entry) => entry.number === reference || entry.id === reference);
    if (!found) throw new BillingError(404, "That invoice was not found.", "not_found");
    return found;
  };
  const findPayment = (id: string) => {
    const found = payments.find((entry) => entry.id === id);
    if (!found) throw new BillingError(404, "That payment was not found.", "not_found");
    return found;
  };
  const stale = (record: { revision: number }, expected: number) => {
    if (record.revision !== expected)
      throw new BillingError(
        409,
        "Someone changed this. Reload the latest record before saving again.",
        "revision_conflict",
      );
  };
  const labelOf = (payment: Payment) => `${method(payment)}`;
  const applyAllocations = (
    payment: Payment,
    requested: Array<{ invoiceId: string; amountCents: number }>,
  ) => {
    const total = requested.reduce((sum, entry) => sum + entry.amountCents, 0);
    if (total > payment.unallocatedCents)
      throw new BillingError(422, "That applies more than the payment has left.", "over_allocation");
    // Check every line first, so a refusal writes nothing.
    for (const entry of requested) {
      const invoice = findInvoice(entry.invoiceId);
      if (invoice.accountId !== payment.accountId)
        throw new BillingError(422, "That invoice belongs to another account.", "wrong_account");
      if (entry.amountCents > invoice.balanceCents)
        throw new BillingError(
          422,
          `Invoice ${invoice.number} only has the balance left to apply.`,
          "over_allocation",
        );
    }
    for (const entry of requested) {
      const invoice = findInvoice(entry.invoiceId);
      allocate(payment, invoice, entry.amountCents, today, OPERATOR);
      settle(invoice, today);
    }
    settleAll(payment);
  };
  // Engagements: each one's last invoice and any month still waiting are worked out from the invoices, as the
  // server does (billing/engagements.ts).
  const engagements: Engagement[] = [
    {
      id: ID(7, 1),
      accountId: harbor,
      name: "Reporting Desk support",
      type: "ongoing",
      status: "active",
      lead: "Diego C.",
      startDate: addDays(previousStart, -30),
      monthlyAmountCents: 800000,
      revision: 1,
    },
    {
      id: ID(7, 2),
      accountId: harbor,
      name: "Newsroom setup",
      type: "setup",
      status: "active",
      lead: OPERATOR,
      startDate: addDays(today, -10),
      endDate: addDays(today, 32),
      packagePriceCents: 1200000,
      lengthWeeks: 6,
      stage: "Training",
      revision: 1,
    },
    {
      id: ID(7, 3),
      accountId: ridgeline,
      name: "Back-office agents",
      type: "ongoing",
      status: "active",
      lead: "Diego C.",
      startDate: addDays(previousStart, 5),
      monthlyAmountCents: 650000,
      revision: 1,
    },
    {
      id: ID(7, 4),
      accountId: marigold,
      name: "Claims triage",
      type: "ongoing",
      status: "proposed",
      lead: OPERATOR,
      startDate: addDays(monthStart, 32),
      monthlyAmountCents: 400000,
      revision: 1,
    },
  ];
  const engagementView = (engagement: Engagement): Engagement => {
    const billed = invoices
      .filter((invoice) => invoice.number && invoice.issuedAt && invoice.status !== "void")
      .filter((invoice) => invoice.lineItems.some((line) => line.engagementId === engagement.id))
      .sort((a, b) => b.issuedAt!.localeCompare(a.issuedAt!));
    const { lastInvoiced: _last, uninvoicedMonth: _month, ...rest } = engagement;
    const last = billed[0];
    const owed =
      engagement.type === "ongoing" &&
      engagement.status === "active" &&
      engagement.startDate < monthStart &&
      !billed.some((invoice) => invoice.issuedAt! >= previousStart);
    return {
      ...rest,
      ...(last
        ? {
            lastInvoiced: {
              invoiceId: last.id,
              invoiceNumber: last.number!,
              issueDate: last.issuedAt!,
              period: last.lineItems.find((line) => line.engagementId === engagement.id)?.period,
            },
          }
        : {}),
      ...(owed ? { uninvoicedMonth: month(previousStart) } : {}),
    };
  };
  const engagementViews = (accountId?: string) =>
    engagements.filter((entry) => !accountId || entry.accountId === accountId).map(engagementView);
  const findEngagement = (id: string) => {
    const found = engagements.find((entry) => entry.id === id);
    if (!found) throw new BillingError(404, "That engagement was not found.", "not_found");
    return found;
  };
  const refreshNext = () => {
    issuer.nextInvoiceNumber = sequence(today);
  };
  refreshNext();

  return {
    available: true,
    access: async () => ({
      permissions: ["accounts:admin:read", ...(options.readOnly ? [] : [BILLING_PERMISSION])],
    }),
    overview: async () => copy({ accounts, invoices, payments, engagements: engagementViews() }),
    account: async (id) =>
      copy({
        account: accountOf(id),
        profile: profiles.get(id) ?? null,
        lines: lines.filter((entry) => entry.accountId === id),
        invoices: invoices.filter(
          (entry) => entry.accountId === id && (entry.number || entry.status === "draft"),
        ),
        payments: payments
          .filter((p) => p.accountId === id)
          .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
        journal: sorted(journal.filter((entry) => entry.accountId === id)),
        engagements: engagementViews(id),
      }),
    invoice: async (reference) => {
      const invoice = findInvoice(reference);
      return copy({
        invoice: { ...invoice, billToContactMasked: profiles.get(invoice.accountId)?.contactMasked.name },
        account: accountOf(invoice.accountId),
        journal: sorted(
          journal.filter(
            (entry) => entry.accountId === invoice.accountId && entry.invoiceNumber === invoice.number,
          ),
        ),
        payments: payments.filter((payment) => payment.allocations.some((a) => a.invoiceId === invoice.id)),
      });
    },
    invoicePdf: async (reference) => {
      const invoice = findInvoice(reference);
      return new Blob([`Synthetic review invoice ${invoice.number ?? "draft"}. Not a real invoice.\n`], {
        type: "text/plain",
      });
    },
    payment: async (id) => {
      const payment = findPayment(id);
      return copy({
        payment,
        account: accountOf(payment.accountId),
        openInvoices: invoices.filter(
          (entry) =>
            entry.accountId === payment.accountId &&
            ["issued", "partially_paid"].includes(entry.status) &&
            entry.balanceCents > 0,
        ),
        journal: sorted(
          journal.filter(
            (entry) => entry.accountId === payment.accountId && entry.paymentLabel === labelOf(payment),
          ),
        ),
      });
    },
    revealContact: async (id) => {
      allowed();
      const contact = contacts.get(id);
      if (!contact) throw new BillingError(404, "This account has no billing contact.", "not_found");
      return copy(contact);
    },
    saveProfile: async (id, input) =>
      once(input.operationId, () => {
        const existing = profiles.get(id);
        if (existing) stale(existing, input.expectedRevision ?? existing.revision);
        if (!existing && !input.billingContact)
          throw new BillingError(
            400,
            "A billing contact is required to start a billing profile.",
            "billing_contact_required",
          );
        if (input.billingContact) {
          const { name, email, address } = input.billingContact;
          contacts.set(id, {
            name,
            email,
            address: address
              ? [
                  address.line1,
                  address.line2,
                  address.city,
                  address.region,
                  address.postalCode,
                  address.country,
                ]
                  .filter(Boolean)
                  .join(", ")
              : "",
          });
        }
        const profile: BillingProfile = {
          accountId: id,
          mode: input.mode,
          currency: "usd",
          netTermsDays: input.netTermsDays,
          contactMasked: maskContact(contacts.get(id)!),
          status: "active",
          revision: (existing?.revision ?? 0) + 1,
        };
        profiles.set(id, profile);
        const account = accountOf(id);
        account.mode = input.mode;
        account.billable = true;
        event({
          at: new Date().toISOString(),
          actor: OPERATOR,
          action: "profile.saved",
          accountId: id,
          detail: `Set the billing profile to ${input.mode}${input.netTermsDays ? `, net ${input.netTermsDays}` : ""}.`,
        });
        return profile;
      }),
    raiseInvoice: async (input) =>
      once(input.operationId, () => {
        accountOf(input.accountId);
        const total = input.lineItems.reduce((sum, entry) => sum + entry.quantity * entry.unitAmountCents, 0);
        if (input.period) {
          const existing = invoices.find(
            (entry) =>
              entry.accountId === input.accountId &&
              entry.period === input.period &&
              entry.number &&
              entry.status !== "void",
          );
          if (existing)
            throw new BillingError(
              409,
              `${existing.number} already bills that period. Each client gets one invoice per period.`,
              "period_taken",
            );
        }
        if (input.issuedVia === "stripe" && !issuer.stripe.connected)
          throw new BillingError(422, "Stripe is not connected yet.", "stripe_unavailable");
        const invoice: Invoice = {
          id: ID(2, next()),
          accountId: input.accountId,
          number: input.alreadySent ? input.alreadySent.number : input.draft ? null : sequence(today),
          currency: "usd",
          lineItems: input.lineItems,
          subtotalCents: total,
          totalCents: total,
          issuedVia: input.issuedVia,
          issuedAt: input.alreadySent ? input.alreadySent.issueDate : input.draft ? null : today,
          dueAt: input.draft
            ? null
            : addDays(input.alreadySent ? input.alreadySent.issueDate : today, input.netTermsDays),
          netTermsDays: input.netTermsDays,
          status: input.draft ? "draft" : "issued",
          period: input.period,
          creditsCents: 0,
          balanceCents: input.draft ? 0 : total,
          issuer: copy(issuer.issuer),
          paymentMethods: copy(issuer.paymentMethods.filter((entry) => entry.offered)),
          revision: 1,
        };
        invoices.push(invoice);
        event({
          at: new Date().toISOString(),
          actor: OPERATOR,
          action: input.draft ? "invoice.drafted" : "invoice.issued",
          accountId: input.accountId,
          invoiceNumber: invoice.number ?? undefined,
          amountCents: total,
        });
        refreshNext();
        return invoice;
      }),
    recordPayment: async (input) =>
      once(input.operationId, () => {
        accountOf(input.accountId);
        if (input.amountCents <= 0)
          throw new BillingError(422, "Enter an amount above zero.", "invalid_amount");
        const payment: Payment = {
          id: ID(5, next()),
          accountId: input.accountId,
          amountCents: input.amountCents,
          currency: "usd",
          method: input.method,
          receivedAt: input.receivedAt,
          reference: input.reference,
          note: input.note,
          recordedBy: OPERATOR,
          unallocatedCents: input.amountCents,
          allocations: [],
          revision: 1,
        };
        payments.push(payment);
        try {
          applyAllocations(payment, input.allocations);
        } catch (cause) {
          payments.pop();
          throw cause;
        }
        const applied = payment.amountCents - payment.unallocatedCents;
        event({
          at: new Date().toISOString(),
          actor: OPERATOR,
          action: "payment.recorded",
          accountId: input.accountId,
          paymentLabel: labelOf(payment),
          amountCents: payment.amountCents,
          appliedCents: applied,
          invoiceNumber:
            payment.allocations.length === 1
              ? (payment.allocations[0].invoiceNumber ?? undefined)
              : undefined,
        });
        return payment;
      }),
    allocate: async (id, input) =>
      once(input.operationId, () => {
        const payment = findPayment(id);
        stale(payment, input.expectedRevision);
        if (payment.reversal)
          throw new BillingError(422, "A reversed payment cannot be applied.", "reversed");
        applyAllocations(payment, input.allocations);
        for (const entry of input.allocations)
          event({
            at: new Date().toISOString(),
            actor: OPERATOR,
            action: "payment.allocated",
            accountId: payment.accountId,
            paymentLabel: labelOf(payment),
            amountCents: entry.amountCents,
            invoiceNumber: findInvoice(entry.invoiceId).number ?? undefined,
          });
        return payment;
      }),
    reversePayment: async (id, input) =>
      once(input.operationId, () => {
        const payment = findPayment(id);
        stale(payment, input.expectedRevision);
        if (payment.reversal) throw new BillingError(422, "This payment was already reversed.", "reversed");
        if (!input.reason.trim()) throw new BillingError(422, "Give a reason.", "reason_required");
        payment.reversal = { at: today, by: OPERATOR, reason: input.reason.trim() };
        for (const original of payment.allocations.filter((entry) => !entry.reversal_of)) {
          const invoice = findInvoice(original.invoiceId);
          allocate(payment, invoice, original.amountCents, today, OPERATOR).reversal_of = original.id;
          settle(invoice, today);
        }
        settleAll(payment);
        event({
          at: new Date().toISOString(),
          actor: OPERATOR,
          action: "payment.reversed",
          accountId: payment.accountId,
          paymentLabel: labelOf(payment),
          amountCents: payment.amountCents,
          reason: input.reason.trim(),
        });
        return payment;
      }),
    writeOff: async (id, input) =>
      once(input.operationId, () => {
        const invoice = findInvoice(id);
        stale(invoice, input.expectedRevision);
        if (!input.reason.trim()) throw new BillingError(422, "Give a reason.", "reason_required");
        invoice.status = "uncollectible";
        invoice.revision += 1;
        event({
          at: new Date().toISOString(),
          actor: OPERATOR,
          action: "invoice.written_off",
          accountId: invoice.accountId,
          invoiceNumber: invoice.number ?? undefined,
          reason: input.reason.trim(),
        });
        return invoice;
      }),
    voidInvoice: async (id, input) =>
      once(input.operationId, () => {
        const invoice = findInvoice(id);
        stale(invoice, input.expectedRevision);
        if (payments.some((payment) => payment.allocations.some((entry) => entry.invoiceId === invoice.id)))
          throw new BillingError(422, "An invoice with payments applied can't be voided.", "has_allocations");
        invoice.status = "void";
        invoice.balanceCents = 0;
        invoice.revision += 1;
        event({
          at: new Date().toISOString(),
          actor: OPERATOR,
          action: "invoice.voided",
          accountId: invoice.accountId,
          invoiceNumber: invoice.number ?? undefined,
          reason: input.reason.trim(),
        });
        return invoice;
      }),
    createEngagement: async ({ operationId, accountId, ...input }) =>
      once(operationId, () => {
        accountOf(accountId);
        if (!input.name.trim())
          throw new BillingError(400, "Give the engagement a name.", "invalid_engagement");
        const engagement: Engagement = {
          id: ID(7, next()),
          accountId,
          name: input.name.trim(),
          type: input.type,
          status: input.status ?? "active",
          lead: input.lead.trim(),
          startDate: input.startDate,
          ...(input.type === "ongoing"
            ? { monthlyAmountCents: input.monthlyAmountCents }
            : {
                packagePriceCents: input.packagePriceCents,
                lengthWeeks: input.lengthWeeks,
                endDate: addDays(input.startDate, (input.lengthWeeks ?? 1) * 7),
                stage: "Installation" as const,
              }),
          revision: 1,
        };
        engagements.push(engagement);
        event({ at: new Date().toISOString(), actor: OPERATOR, action: "engagement.created", accountId });
        return engagementView(engagement);
      }),
    changeEngagement: async (id, { operationId, expectedRevision, status, endDate, ...fields }) =>
      once(operationId, () => {
        const engagement = findEngagement(id);
        stale(engagement, expectedRevision);
        if (engagement.status === "ended")
          throw new BillingError(409, "An ended engagement cannot be changed.", "engagement_ended");
        Object.assign(engagement, fields);
        if (status === "active") engagement.status = "active";
        if (status === "ended") {
          engagement.status = "ended";
          engagement.endDate = endDate ?? today;
        }
        engagement.revision += 1;
        event({
          at: new Date().toISOString(),
          actor: OPERATOR,
          action: status === "ended" ? "engagement.ended" : "engagement.updated",
          accountId: engagement.accountId,
        });
        return engagementView(engagement);
      }),
    issuer: async () => copy(issuer),
    saveIssuer: async (input) =>
      once(input.operationId, () => {
        stale(issuer, input.expectedRevision);
        issuer.issuer = copy(input.issuer);
        issuer.paymentMethods = copy(input.paymentMethods);
        issuer.defaultNetTermsDays = input.defaultNetTermsDays;
        issuer.revision += 1;
        event({ at: new Date().toISOString(), actor: OPERATOR, action: "issuer.saved" });
        return copy(issuer);
      }),
  };
}

/** The account directory for the same fictional clients, so the Accounts pages can be reviewed. */
export function syntheticDirectory(): AccountsBrowser {
  const created = "2026-01-15T12:00:00Z";
  const products = (index: number) =>
    index === 0
      ? [
          { product: "papyrus-harbor-lantern", status: "active" as const },
          { product: "cyclotron", status: "active" as const },
          { product: "papyrus-harbor-archive", status: "active" as const },
        ]
      : index === 5
        ? []
        : [{ product: "cyclotron", status: "active" as const }];
  const list = () =>
    CLIENTS.map((client, index) => ({
      id: SYNTHETIC_ACCOUNT_IDS[index],
      name: client.name,
      createdAt: created,
      revision: 1,
      products: products(index),
      activeMembers: index + 2,
    }));
  const person = { id: "synthetic-operator", createdAt: created };
  return {
    configured: true,
    operatorList: async () => ({ person, accounts: list() }),
    operatorDetail: async (id) => {
      const account = list().find((entry) => entry.id === id);
      if (!account) throw new Error("Not found");
      return {
        ...account,
        entitlements: account.products.map((entry) => ({
          accountId: id,
          product: entry.product,
          status: entry.status,
          capabilities: [],
        })),
        memberships: [
          { accountId: id, personId: `synthetic-owner-${id.slice(-1)}`, role: "owner", status: "active" },
        ],
        quota: { state: "none", planId: null, allowanceOverrideUnits: null },
      };
    },
    setEntitlement: async () => undefined,
    list: async () => ({ person, accounts: [], operatorAccess: true }),
    detail: async () => {
      throw new Error("Not available in synthetic review.");
    },
    create: async () => {
      throw new Error("Not available in synthetic review.");
    },
    challenge: async () => ({ challengeId: "synthetic", nonce: "synthetic" }),
    loginChallenge: async () => ({ challengeId: "synthetic", nonce: "synthetic" }),
    resolve: async () => undefined,
  };
}
