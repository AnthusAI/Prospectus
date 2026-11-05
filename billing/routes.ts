import { randomUUID } from "node:crypto";
import type { RestEvent } from "../accounts/auth";
import type { IdentityFiles } from "../accounts/identity-files";
import { fail, UUID_PATTERN, type Context } from "../accounts/model";
import {
  hasOperatorPermission,
  type OperatorGrant,
  type OperatorPermission,
} from "../accounts/operator-policy";
import { jsonResponse, parseJsonRequest } from "../accounts/request";
import { BILLING_MAXIMUM_BODY_BYTES, MAXIMUM_PDF_BYTES, OPERATOR_PREFIX, isBillingPath } from "./paths";
import { matchesStringPattern } from "../accounts/validation-rules";
import { isOpenInvoice } from "./balances";
import type { BillingIssuer } from "./issuer";
import { effectiveDefaultNetTerms } from "./issuer";
import type { BillingLedger } from "./ledger";
import type { BillingLines } from "./lines";
import type { BillingProfiles } from "./profile";
import { requireBillingAdministrator } from "./profile";
import type { BillingPlanCatalog } from "./plans";
import { renderInvoicePdf } from "./pdf";
import { reversalOf } from "./payments";
import { commitWithRetry, hash, journalPath, requireOperationId } from "./store";
import { accountSummary, invoiceView, journalView, lineView, paymentView, profileView } from "./views";
import type { InvoiceSequence, JournalEvent, LedgerPayment } from "./model";
import { sequencePath } from "./ledger-engine";

const PREFIX = OPERATOR_PREFIX;
const OPERATOR = `^${PREFIX}`;
const ID = "([a-f0-9-]{36})";
const REFERENCE = "(\\d{6}-\\d{3}|[a-f0-9-]{36})";
export { isBillingPath };

export interface BillingRouteDependencies {
  ledger: BillingLedger;
  profiles: BillingProfiles;
  lines: BillingLines;
  issuer: BillingIssuer;
  plans: BillingPlanCatalog;
  grants: readonly OperatorGrant[];
  accounts: {
    all(): Promise<{ id: string; name: string }[]>;
    get(accountId: string): Promise<{ id: string; name: string } | null>;
  };
  /** Appends the one journal event of an audited contact reveal. */
  files: IdentityFiles;
  now: () => string;
  /** Lower than the default only in tests. */
  maximumPdfBytes?: number;
}

/** The ledger's entry for an already-sent invoice: its number and issue date, then the raised invoice's fields. */
function sentInvoice(alreadySent: unknown, rest: Record<string, unknown>) {
  const sent = alreadySent as { number?: unknown; issueDate?: unknown } | null;
  if (
    !sent ||
    typeof sent !== "object" ||
    Object.keys(sent).some((key) => key !== "number" && key !== "issueDate")
  )
    fail(
      400,
      "invalid_invoice",
      "Invoice refused: an already-sent invoice needs only its number and issue date.",
    );
  return { ...rest, number: sent.number, issueDate: sent.issueDate };
}

const accountRoute = (suffix: string) => new RegExp(`${OPERATOR}/accounts/${ID}/${suffix}$`);

/**
 * The operator billing routes under `/v1/account-directory/operator`, matching src/billing/client.ts. Reads need
 * `accounts:admin:read` or `accounts:admin:billing`; every write needs `accounts:admin:billing`, enforced by the
 * domain call itself, so no route can forget it. Returns null for a path that is not a billing route.
 */
export function billingOperatorRoutes(deps: BillingRouteDependencies) {
  const { ledger } = deps;
  const canRead = (context: Context) =>
    (["accounts:admin:read", "accounts:admin:billing"] as OperatorPermission[]).some((permission) =>
      hasOperatorPermission(context, deps.grants, permission),
    );
  const body = (event: RestEvent) => parseJsonRequest(event, BILLING_MAXIMUM_BODY_BYTES).body;
  /** Splits the operation ID from the rest of a write body. */
  const write = (event: RestEvent, drop: readonly string[] = []) => {
    const { operationId, ...rest } = body(event);
    for (const key of drop) delete rest[key];
    return { operationId: requireOperationId(operationId), input: rest };
  };

  async function summary(accountId: string) {
    const account = await deps.accounts.get(accountId);
    if (!account) fail(404, "account_missing", "Account not found.");
    return accountSummary(account, await deps.profiles.get(accountId));
  }
  async function paymentFor(payment: LedgerPayment) {
    return paymentView(ledger.reader, payment, await reversalOf(ledger.reader, payment));
  }
  /** Payments as listed: originals only, since a reversal shows on the payment it undoes. */
  const listable = (payments: LedgerPayment[]) => payments.filter((payment) => !payment.reversal_of);
  async function paymentViews(payments: LedgerPayment[]) {
    const reversals = new Map(
      payments.filter((payment) => payment.reversal_of).map((payment) => [payment.reversal_of!, payment]),
    );
    return Promise.all(
      listable(payments).map((payment) =>
        paymentView(ledger.reader, payment, reversals.get(payment.id) ?? null),
      ),
    );
  }
  async function invoiceFor(reference: string) {
    const invoice = /^\d{6}-\d{3}$/.test(reference)
      ? await ledger.invoiceByNumber(reference)
      : await ledger.invoice(reference);
    if (!invoice) fail(404, "invoice_missing", "Invoice not found.");
    return invoice;
  }
  const timeline = async (accountId: string) =>
    (await ledger.journal(accountId))
      .map(journalView)
      .filter((entry): entry is NonNullable<typeof entry> => !!entry);

  async function issuerSettings() {
    const record = await deps.issuer.get();
    const month = deps.now().slice(0, 4) + deps.now().slice(5, 7);
    const sequence = (await deps.ledger.reader.files.get<InvoiceSequence>(sequencePath(month)))?.value;
    return {
      issuer: record?.issuer ?? { legalName: "", billingEmail: "", addressLines: [] },
      paymentMethods: record?.paymentMethods ?? [],
      defaultNetTermsDays: effectiveDefaultNetTerms(record),
      nextInvoiceNumber: `${month}-${String(sequence?.next ?? 1).padStart(3, "0")}`,
      stripe: { connected: false },
      revision: record?.revision ?? 0,
    };
  }

  return async function handle(event: RestEvent, context: Context) {
    const path = event.path,
      method = event.httpMethod;
    if (!isBillingPath(path)) return null;
    if (!canRead(context))
      fail(403, "operator_forbidden", "Explicit central billing permission is required.");
    const get = method === "GET";
    const save = method === "PUT" || method === "POST";
    let match: RegExpExecArray | null;

    if (get && path === `${PREFIX}/billing/access`) {
      const held = (["accounts:admin:read", "accounts:admin:billing"] as OperatorPermission[]).filter(
        (permission) => hasOperatorPermission(context, deps.grants, permission),
      );
      return jsonResponse(200, { permissions: held });
    }
    if (get && new RegExp(`${OPERATOR}/billing/accounts$`).test(path)) {
      const accounts = await deps.accounts.all();
      return jsonResponse(200, {
        accounts: await Promise.all(
          accounts.map(async (account) => accountSummary(account, await deps.profiles.get(account.id))),
        ),
      });
    }
    if (get && (match = new RegExp(`${OPERATOR}/billing/accounts/${ID}$`).exec(path)))
      return jsonResponse(200, { account: await summary(match[1]) });
    if (get && new RegExp(`${OPERATOR}/billing/invoices$`).test(path))
      return jsonResponse(200, {
        invoices: (await ledger.allInvoices()).map((invoice) => invoiceView(invoice)),
      });
    if (get && new RegExp(`${OPERATOR}/billing/payments$`).test(path))
      return jsonResponse(200, { payments: await paymentViews(await ledger.allPayments()) });

    if ((match = new RegExp(`${OPERATOR}/billing/invoices/${REFERENCE}$`).exec(path)) && get) {
      const invoice = await invoiceFor(match[1]);
      const payments = (await ledger.payments(invoice.accountId)).filter((payment) =>
        payment.allocations.some((allocation) => allocation.invoiceId === invoice.id),
      );
      return jsonResponse(200, {
        invoice: invoiceView(invoice, await deps.profiles.get(invoice.accountId)),
        account: await summary(invoice.accountId),
        journal: (await timeline(invoice.accountId)).filter(
          (entry) => entry.invoiceNumber === invoice.number,
        ),
        payments: await paymentViews(payments),
      });
    }
    if (get && (match = new RegExp(`${OPERATOR}/billing/invoices/${REFERENCE}/pdf$`).exec(path))) {
      const invoice = await invoiceFor(match[1]);
      const contact = (await deps.profiles.get(invoice.accountId))?.billingContact;
      const bytes = await renderInvoicePdf(
        invoice,
        contact
          ? {
              name: contact.name,
              addressLines: contact.address
                ? [
                    contact.address.line1,
                    ...(contact.address.line2 ? [contact.address.line2] : []),
                    `${contact.address.city}${contact.address.region ? `, ${contact.address.region}` : ""} ${contact.address.postalCode}`,
                    contact.address.country,
                  ]
                : [],
            }
          : undefined,
      );
      if (bytes.length > (deps.maximumPdfBytes ?? MAXIMUM_PDF_BYTES))
        fail(413, "pdf_too_large", "The invoice PDF is too large to return.");
      const accept = event.headers?.accept ?? event.headers?.Accept ?? "";
      if (accept.includes("application/pdf"))
        return {
          statusCode: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="invoice-${invoice.number}.pdf"`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
          isBase64Encoded: true,
          body: Buffer.from(bytes).toString("base64"),
        };
      return jsonResponse(200, {
        filename: `invoice-${invoice.number}.pdf`,
        contentType: "application/pdf",
        base64: Buffer.from(bytes).toString("base64"),
      });
    }
    if (get && (match = new RegExp(`${OPERATOR}/billing/payments/${ID}$`).exec(path))) {
      const payment = await ledger.payment(match[1]);
      if (!payment || payment.reversal_of) fail(404, "payment_missing", "Payment not found.");
      const open = (await ledger.invoices(payment.accountId)).filter(isOpenInvoice);
      return jsonResponse(200, {
        payment: await paymentFor(payment),
        account: await summary(payment.accountId),
        openInvoices: open.map((invoice) => invoiceView(invoice)),
        journal: (await timeline(payment.accountId)).filter(
          (entry) => !!entry.paymentLabel || entry.action.startsWith("payment"),
        ),
      });
    }
    if (
      save &&
      (match = new RegExp(`${OPERATOR}/billing/payments/${ID}/allocations$`).exec(path)) &&
      method === "POST"
    ) {
      const { operationId, input } = write(event);
      const result = await ledger.allocate(context, match[1], input, operationId);
      return jsonResponse(200, { payment: await paymentFor((await ledger.payment(result.payment.id))!) });
    }
    if (
      (match = new RegExp(`${OPERATOR}/billing/payments/${ID}/reversal$`).exec(path)) &&
      method === "POST"
    ) {
      const { operationId, input } = write(event);
      await ledger.reverse(context, match[1], input, operationId);
      return jsonResponse(200, { payment: await paymentFor((await ledger.payment(match[1]))!) });
    }
    if (
      (match = new RegExp(`${OPERATOR}/billing/invoices/${ID}/(void|write-off|credit)$`).exec(path)) &&
      method === "POST"
    ) {
      const { operationId, input } = write(event);
      const action = { void: "void", "write-off": "writeOff", credit: "credit" }[
        match[2] as "void" | "write-off" | "credit"
      ] as "void" | "writeOff" | "credit";
      const result = await ledger[action](context, match[1], input, operationId);
      return jsonResponse(200, { invoice: invoiceView((await ledger.invoice(result.invoice.id))!) });
    }
    if (path === `${PREFIX}/billing/issuer`) {
      if (get) return jsonResponse(200, await issuerSettings());
      if (save) {
        const { operationId, input } = write(event);
        await deps.issuer.set(context, input, operationId);
        return jsonResponse(200, await issuerSettings());
      }
    }

    // ---- Per account ----------------------------------------------------------------------------------------
    if ((match = accountRoute("billing-profile").exec(path))) {
      const accountId = match[1];
      if (get) {
        const profile = await deps.profiles.get(accountId);
        return jsonResponse(200, { profile: profile ? profileView(profile) : null });
      }
      if (save) {
        const { operationId, input } = write(event);
        requireBillingAdministrator(context, deps.grants);
        const current = await deps.profiles.get(accountId);
        const { billingContact, ...rest } = input as Record<string, any>;
        if (!current && !billingContact)
          fail(400, "billing_contact_required", "A billing contact is required to start a billing profile.");
        const merged = {
          mode: current?.mode,
          currency: "usd",
          billingContact: billingContact ?? current!.billingContact,
          ...(current?.netTermsDays !== undefined ? { netTermsDays: current.netTermsDays } : {}),
          ...(current?.paymentMethods ? { paymentMethods: current.paymentMethods } : {}),
          ...rest,
        };
        const { profile } = await deps.profiles.set(context, accountId, merged, operationId);
        return jsonResponse(200, { profile: profileView(profile) });
      }
    }
    if (get && (match = accountRoute("billing-lines").exec(path)))
      return jsonResponse(200, {
        lines: (await deps.lines.list(match[1])).map((line) => lineView(line, deps.plans)),
      });
    if ((match = accountRoute("invoices").exec(path))) {
      const accountId = match[1];
      if (get) {
        const profile = await deps.profiles.get(accountId);
        return jsonResponse(200, {
          invoices: (await ledger.invoices(accountId)).map((invoice) => invoiceView(invoice, profile)),
        });
      }
      if (method === "POST") {
        await summary(accountId);
        const { operationId, input } = write(event, ["accountId"]);
        const { alreadySent, draft, ...rest } = input as Record<string, unknown>;
        // An invoice already sent outside Prospectus keeps the number and issue date it was sent with.
        const { invoice } =
          alreadySent === undefined
            ? await ledger.raise(context, accountId, { ...rest, draft }, operationId)
            : await ledger.enterIssued(context, accountId, sentInvoice(alreadySent, rest), operationId);
        return jsonResponse(200, { invoice: invoiceView((await ledger.invoice(invoice.id))!) });
      }
    }
    if ((match = accountRoute("payments").exec(path))) {
      const accountId = match[1];
      if (get) return jsonResponse(200, { payments: await paymentViews(await ledger.payments(accountId)) });
      if (method === "POST") {
        await summary(accountId);
        const { operationId, input } = write(event, ["accountId"]);
        const { payment } = await ledger.recordPayment(context, accountId, input, operationId);
        return jsonResponse(200, { payment: await paymentFor((await ledger.payment(payment.id))!) });
      }
    }
    if (get && (match = accountRoute("billing-journal").exec(path)))
      return jsonResponse(200, { events: await timeline(match[1]) });
    if (method === "POST" && (match = accountRoute("billing-profile/reveal-contact").exec(path))) {
      // Showing the full contact is a recorded act: it needs the billing permission and leaves a journal event.
      const actor = requireBillingAdministrator(context, deps.grants);
      const accountId = match[1];
      const profile = await deps.profiles.get(accountId);
      if (!profile) fail(404, "profile_missing", "Account has no billing profile.");
      const revealId = requireIdOrRandom(event);
      const eventId = hash(["billing-journal-v1", "contact", accountId, revealId]);
      const entry: JournalEvent = {
        version: 1,
        kind: "billing-journal-event",
        eventId,
        action: "profile.contact_revealed",
        recordKind: "contact",
        recordPath: `profiles/${accountId}.json`,
        accountId,
        operationId: revealId,
        requestHash: hash(["reveal", accountId, actor]),
        actor,
        beforeRevision: profile.revision,
        afterRevision: profile.revision,
        storageOperationId: `billing:reveal:${eventId}`,
        storageRequestHash: hash(["reveal", eventId]),
        at: deps.now(),
      };
      await commitWithRetry(
        deps.files,
        journalPath(eventId),
        `billing:journal:${eventId}`,
        entry.requestHash,
        entry,
        null,
      );
      const { name, email, address } = profile.billingContact;
      return jsonResponse(200, {
        contact: {
          name,
          email,
          address: address
            ? [
                address.line1,
                address.line2,
                `${address.city}${address.region ? `, ${address.region}` : ""} ${address.postalCode}`,
                address.country,
              ]
                .filter(Boolean)
                .join(", ")
            : "",
        },
      });
    }
    return fail(404, "route", "Billing route not found.");
  };
}

/** A reveal takes an optional operation ID so a retry is recorded once; otherwise each reveal is its own event. */
function requireIdOrRandom(event: RestEvent): string {
  const supplied = (event.body ? safeParse(event.body)?.operationId : undefined) as unknown;
  return matchesStringPattern(supplied, UUID_PATTERN) ? supplied.toLowerCase() : randomUUID();
}
function safeParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
