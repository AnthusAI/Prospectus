# Billing

Billing charges clients for the products their accounts hold: each Papyrus site deployment, Cyclotron Lab and any later product. Self-serve clients pay through Stripe; larger clients receive invoices from Anthus and may pay in pieces, by any means. This document is the reviewed model that the billing stories implement against. Nothing described here is built or deployed yet. Requirements are Ryan's (2026-10-31); the epic is kanbus-a78bcd and the behavior specifications are `features/billing-*.feature`.

## Principles

- **Billing is separate from access.** The account document stays the authorization record, committed by one conditional write (see [ARCHITECTURE.md](ARCHITECTURE.md#accounts)). Billing never writes it and never grants, disables or suspends an entitlement. An account with no billing profile works normally.
- **Ordinary files.** Every billing record is an ordinary Kanbus/Virtuus JSON file under `prospectus-central/billing/`, with control files under `_virtuus/prospectus-central/billing/`, written through the Rust bridge with conditional writes and deterministic operation ids. DynamoDB may hold a catalog for CRM listing that can be rebuilt from the files; nothing consults it for authority or balances.
- **US dollars, integer cents.** `currency` is always `usd`; any other value is refused. Every amount is an integer in minor units (cents). No floating point is used anywhere in billing.
- **No tax lines.** Invoices carry no tax in the MVP, so total equals subtotal. Tax is revisited before any live mode.
- **Corrections by reversal.** Issued invoices, payments and allocations are never edited. A correction is a new record that names the original in `reversal_of`.
- **Specs before Stripe.** Every spec runs against an in-memory fake processor, so billing is built before any Stripe account exists.

## Storage

| Record                  | Path under `prospectus-central/billing/` | Written by                           |
| ----------------------- | ---------------------------------------- | ------------------------------------ |
| Billing profile         | `profiles/<accountUUID>.json`            | Admins                               |
| Billing line            | `lines/<accountUUID>/<hex(product)>.json` | Admins; Stripe mirror for status    |
| Invoice                 | `invoices/<invoiceUUID>.json`            | Admins; Stripe mirror                |
| Payment                 | `payments/<paymentUUID>.json`            | Admins (external); Stripe mirror     |
| Allocation              | `allocations/<allocationUUID>.json`      | Admins; Stripe mirror                |
| Credit                  | `credits/<creditUUID>.json`              | Admins                               |
| Invoice number sequence | `sequences/invoice-number.json`          | The invoice issue operation          |
| Journal event           | `journal/<eventId>.json`                 | Every mutation, including the mirror |

The plan catalog is a reviewed repository file, `accounts/billing-plans.json`, not stored data.

Billing is its own Virtuus project (`billing`) in the Rust bridge, beside `accounts`, so it writes only billing paths. The bridge accepts only hex digits and hyphens after the kind, so a line's product name is stored hex-encoded (`papyrus-example-invalid` is `7061707972...`), as retired site subjects are. A journal `<eventId>` is the SHA-256 of the record and the client operation id.

## Billing profile

One profile per account at `billing/profiles/<accountUUID>.json`. It references the account UUID; the account document gains nothing.

| Field                 | Meaning                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `mode`                | `direct` or `invoiced`; absent means not yet billable                                            |
| `currency`            | Always `usd`                                                                                     |
| `stripeCustomerId`    | The account's one Stripe Customer (`cus_...`), when one exists                                   |
| `billingContact`      | Name, email, postal address and tax id as the client supplied them                               |
| `netTermsDays`        | Optional per-account override of the default 30 days                                             |
| `paymentMethods`      | Optional override of the issuer's accepted payment methods for this client |
| `openLines`           | The account's open and opening lines by product: the create operation, the plan interval and when it was reserved |
| `status`, `revision`  | Lifecycle state and the compare-and-set revision                                                 |
| `audit`               | Bounded audit of who changed what, by operation id                                               |

Only admins set a profile. The billing contact is billing data, not identity: it is never used to find, match or authorize a Person, and it never appears in logs. Switching mode is refused while the account has open billing lines; each line is first re-homed by its own explicit operation, and the refusal names the lines. Opening a line first reserves its product in `openLines` with a compare-and-set on the profile, and ending a line removes the reservation afterwards. Because a mode switch writes the same record, the two cannot pass each other: either the switch lands first and the line opens under the new mode, or the switch sees the reservation and is refused. The direct-mode interval rule is checked against the same reservations. A reservation whose line ended, or whose line never appeared within ten minutes, is a step that did not finish and no longer blocks; sending the create or end again with its operation id finishes it. These writes advance the profile revision but write no journal event of their own.

Customers read their own profile through `GET /accounts/{id}/billing` on the portal BFF, which returns the mode and a masked contact.

## Plan catalog

`accounts/billing-plans.json` is a reviewed file in the style of `accounts/papyrus-sites.json`. Each entry has a plan id, display name, product family, interval and a Stripe price id per Stripe mode (`test`, `live`). The product family uses the family names from kanbus-db57cb (`papyrus` for Papyrus sites, plus `cyclotron-lab`); product display names come from that site metadata, not from the catalog.

Pricing is out of scope for this work. The catalog is built with its structure and test-mode placeholder plans and prices only; real plans and prices are a separate decision. Live price ids come later in a separate reviewed change.

The catalog is validated at synthesis and at service start. An unknown field, a duplicate plan id, or one price id shared by two plans stops the service before it serves.

## Billing lines

A billing line is the billable unit, keyed by account and product: `billing/lines/<accountUUID>/<hex(product)>.json`, with a plan from the catalog, a status (`pending`, `active`, `paused`, `ended`), a period and, in direct mode, the Stripe subscription item id. Only an `active` line pauses, and resuming returns it to `active`; there is no `resumed` status, only a `line.resumed` journal action. Every line that is not `ended` counts as open, for the mode-switch refusal and the direct-mode interval rule. An ended line may be created again with a new period. Papyrus site products bill under family `papyrus`; the `cyclotron` product bills under `cyclotron-lab`. Each Papyrus site is its own product (`papyrus-<site>`), so a client with three sites has three lines. Each line is added, paused and ended on its own and never touches another; opening and ending a line also update the profile's `openLines`.

The entitlement is access; the line is money. They are changed by different operations:

- A line can be created only for a product the account is entitled to. Otherwise it is refused with a message naming the missing entitlement. Billing never grants access.
- A line for a public-reader product is refused.
- An admin may grant a product with no line (free, trial or internal use).
- A line may outlive a disabled entitlement until an admin ends it.
- Ending a line leaves the entitlement unchanged and creates a follow-up asking whether to disable the product through the entitlement route (see [OPERATIONS.md](OPERATIONS.md#product-access)).

Account lifecycle events from kanbus-6efecd (`entitlement.changed`) are prompts: a grant with no line creates an operator follow-up to attach a plan, and a disabled product creates a follow-up to end the line. Whether a grant should ever create a line automatically is open.

## Billing modes

Each client gets **one combined invoice per period** covering all of its products. Each billing line appears as its own line item on that invoice.

### Direct

Stripe charges a stored payment method and is the system of record for subscription invoices; Prospectus mirrors them into the ledger from webhooks.

- The account has one Stripe Customer, created on first need with the account UUID in metadata. Its id is stored on the profile, and a retry reuses it.
- The account has **one Stripe Subscription**, with **one subscription item per billing line**. Adding, pausing or ending a deployment adds, changes or removes its item, and Stripe produces one invoice per client per period.
- A line is `pending` until its subscription item is part of an active subscription. When the client has no subscription yet, the owner chooses Set up billing in the portal and the portal BFF creates a Stripe Checkout session in subscription mode, with success and cancel URLs on `one.anth.us`.
- Stripe requires every item on one subscription to share a billing interval, so a direct-mode line whose plan interval differs from the client's subscription is refused.
- The owner manages the payment method in the Stripe customer portal (Manage billing).

### Invoiced

Prospectus is the system of record. Admins raise invoices.

- Each period's invoice covers all of the client's active lines, one line item per line. There is one period invoice per client per period; a second one for the same period is refused.
- Admins may also raise an invoice for anything else (one-off work, a correction).
- An invoice is issued either `issuedVia: "stripe"` (a Stripe Invoice with `collection_method: send_invoice`, which gives the client a hosted page with card or bank payment, reconciled by webhook) or `issuedVia: "manual"` (Anthus sends it; payments arrive by bank transfer, check or other means and an admin records them).
- Due date is the issue date plus the profile's net terms: 30 days by default, or the account's override. There are no late fees.

## Invoice ledger

### Invoices

`billing/invoices/<invoiceUUID>.json`: account, invoice number, currency, line items (description, quantity, unit amount in cents, optional billing line and product, period), subtotal, total, `issuedVia`, external references (Stripe invoice id and number), issue date, due date, status, and the allocations applied to it.

- Status is one of `draft`, `issued`, `partially_paid`, `paid`, `void` or `uncollectible`.
- An issued invoice is immutable. Its lines cannot be edited; corrections are a new invoice or a credit that references it.
- Invoice numbers follow `YYYYMM-NNN`: the year and month of the issue date, then a three-digit counter that starts at `001` each month (`202610-001`, `202610-002`, `202611-001`). Numbers come from one counter file per month (`billing/sequences/invoice-number-<YYYYMM>.json`) advanced by conditional write. A number is assigned at issue and never reused, including after a void. More than 999 invoices in a month is refused. The first invoice, to Data Parade in October 2026, was issued outside Prospectus as `202610-001` and is entered as a manual invoice once the ledger exists.
- Only an issued invoice with no allocations can be voided. Its balance becomes zero.
- Only admins may write off an invoice by marking it `uncollectible`. The invoice and its journal entries stay on record. Whether a written-off balance still counts toward what the client owes is open.
- An invoice whose due date has passed with a balance above zero is past due. Past due is derived from the due date and balance, not stored as a status.
- Every invoice has a PDF, manual invoices included. Prospectus renders it from the issued record; a Stripe-issued invoice also keeps Stripe's own PDF link. The legal entity name and address printed on it are open.
- **Issuer details are data, not code.** The seller block (legal name, address, billing email) and the accepted payment methods with their instructions (for example bank transfer, check, Venmo) live in one admin-set issuer record, `billing/issuer.json`, written like every other billing record and never committed to this public repository. An issued invoice copies the issuer block and payment methods into its own record, so a later change to the issuer never alters an issued invoice or its PDF.

### Payments

`billing/payments/<paymentUUID>.json`: account, amount, currency, `method` (`stripe_card`, `stripe_bank`, `bank_transfer`, `check`, `venmo`, `cash`, `other`), received date, external reference (check number, transfer reference or Stripe payment intent), who recorded it (the admin's operator grant id, or `stripe-webhook`), notes and the unallocated remainder.

Only admins record external payments (`bank_transfer`, `check`, `venmo`, `cash`, `other`). There is no second-operator confirmation. `stripe_card` and `stripe_bank` payments enter the ledger only through the webhook mirror; recording one by hand is refused.

### Allocations

`billing/allocations/<allocationUUID>.json`: payment, invoice, amount. One payment may be split across several invoices, and one invoice may receive many payments.

- Balance = total − sum of allocations − credits. It is derived from the records and recomputed on every write, never trusted from a stored value alone.
- An invoice becomes `partially_paid` at its first allocation and `paid` when its balance reaches zero, with the paid date set.
- An allocation that exceeds the invoice balance or the payment's unallocated remainder is refused and nothing is written.
- Only admins allocate.

### Credits and reversals

- A credit (`billing/credits/`) reduces an issued invoice's balance and names the invoice it corrects.
- A reversal is a new record with `reversal_of` naming the original. Reversing a payment (for example a bounced check) writes a reversing payment and reversing allocations; the invoices return to their previous balance and status, and the originals stay untouched.
- Stripe refunds in direct mode (`charge.refunded`) are mirrored as reversal records. Whether refunds of external payments are ever recorded, and by whom, is open.

### Journal

`billing/journal/` is an append-only event stream, one file per event, with a deterministic id from the operation. Each event records the actor, operation id, record kind and before and after revisions. Every billing mutation produces exactly one event. The journal is the audit trail, the reconciliation source and the record from which every balance can be rebuilt. Stripe webhook events are journaled by Stripe event id, which is how duplicates are detected.

### Concurrency and replay

Every write carries a client-generated operation id and uses revision compare-and-set. A replay of the same operation returns the original result and writes no second revision: the journal event names the storage commit, and Virtuus answers that commit with its original result. A write may carry an `expectedRevision`; a stale one is refused as `409 revision_conflict`, and without one the loser of a race re-reads and is re-evaluated. The record's bounded audit keeps the last 32 entries; the journal keeps every event. Two admins allocating the same payment at once cannot together exceed its remainder: the loser's write fails its revision check and is re-evaluated.

## Stripe boundary

Everything that talks to Stripe goes through one `PaymentProcessor` interface (`billing/processor.ts`), with a thin Stripe implementation (`billing/stripe-processor.ts`) and an in-memory fake (`billing/testing/fake-stripe.ts`). The fake mirrors Stripe's documented shapes: `cus_`, `sub_`, `si_`, `in_`, `pi_` and `evt_` ids, integer minor-unit amounts, and Stripe's subscription and invoice lifecycles. The fake does not import the Stripe SDK; the SDK is pinned.

- **No network in specs.** Billing specs make no HTTPS call and read no Stripe key.
- **Flag.** `billing/deployment.json` holds `stripe: { enabled, mode }`, committed as `{ enabled: false, mode: "test" }`. Live mode is a separate reviewed change after the security review (kanbus-d7ec0e) and Ryan's go-ahead.
- **Parameters.** The restricted API key and the webhook signing secret are SSM SecureString parameters `/prospectus/billing/stripe/secret-key/v1` and `/prospectus/billing/stripe/webhook-secret/v1`, created by Ryan by hand (kanbus-c49243), never by CDK or the repository. A missing or short parameter fails closed with `503 billing_unavailable`.
- **Webhook.** `POST /billing/stripe/webhook` has no authorizer. It verifies Stripe's v1 signature with a 300-second tolerance, rejects bodies over the limit, unsigned, tampered or stale events and unknown event types with `400` and writes nothing, deduplicates by event id in the journal, and applies events idempotently and in any delivery order. An event for an unknown account is refused and logged with a reason code only.
- **Events consumed:** `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `checkout.session.completed`, `charge.refunded`.
- **No automatic suspension.** A failed payment marks the invoice past due and creates a billing follow-up. Nothing in billing changes an entitlement; suspension is only ever an operator action through the entitlement route.

## Permission

A new reviewed operator permission, `accounts:admin:billing`, in `accounts/operator-grants.json`, with the same shape as `accounts:admin:read`. Only its holders (admins) may set a profile, create, pause or end lines, raise, issue and void invoices, record external payments, allocate, reverse and write off. The server enforces this on every route, so the same rule covers the CRM pages and the CLI. An operator with `accounts:admin:read` only sees billing read-only.

Customers in the portal may only read their own lines and invoices, start Stripe Checkout and open the Stripe customer portal. Who holds the grant is Ryan's decision; the first grant follows the same private profile confirmation as `accounts:admin:read` (see [SECURITY.md](SECURITY.md#operator-access)).

## Events and follow-ups

Billing produces follow-ups in the CRM Serve queue, made from the account id and invoice number with no contact data, under a fixed billing actor:

- an invoice becomes past due (a Stripe `invoice.payment_failed`, or a manual invoice past its due date at the daily check), with the balance and days overdue;
- a subscription is cancelled or a line ended, asking whether to disable the product;
- an entitlement is granted with no line, or disabled with a line still open.

`scripts/reconcile-billing.ts` runs with the operator's own credentials, dry run by default, and lists ledger records that differ from Stripe, Stripe objects with no ledger record and payments with unallocated remainders, printing counts and ids only. The daily due-date check runs inside that script unless Ryan approves a scheduled rule and role.

## Surfaces

- **CRM, "Usage and billing" under Serve.** Per account: the profile, each line with plan, status and period, open invoices with balances and PDF download, recent payments and the journal timeline. Admin actions (raise and issue an invoice, record and allocate a payment, reverse, write off) are buttons shown only to admins; read-only operators see the same view without them. Billing contact fields are masked until revealed. Lucide icons, no emoji.
- **Anthus One portal, "Plan and billing".** Owners see each deployment with its plan and next charge, invoices with status, balance and PDF, Set up billing for a pending line, Manage billing, and Pay now on an open Stripe-issued invoice (Stripe's hosted invoice page). Invoiced accounts also see the accepted payment methods and their instructions from the invoice. Members and viewers see that billing is managed by the account's owners, and no amounts. The portal collects no card or bank details and loads no Stripe script; every payment action leaves for Stripe and returns to `one.anth.us`.

## CLI for agents

Ryan wants agents to record payments for him (kanbus-2c3397). An agent signs in with `prospectus login --remote` as an admin, and the server checks `accounts:admin:billing` on every call.

| Command                                                                                                                                                            | Effect                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `prospectus billing invoices [--account ID] [--status open\|partially_paid\|paid\|uncollectible]`                                                                  | List invoices with balances                                       |
| `prospectus billing invoice show NUMBER`                                                                                                                           | Show one invoice with its allocations                             |
| `prospectus billing invoice pdf NUMBER [-o FILE]`                                                                                                                  | Download the invoice PDF                                          |
| `prospectus billing payment record --account ID --amount 1234.56 --method M --received YYYY-MM-DD [--reference TEXT] [--note TEXT] [--allocate NUMBER=AMOUNT ...]` | Record one external payment, optionally allocated across invoices |
| `prospectus billing payment allocate PAYMENT_ID NUMBER=AMOUNT ...`                                                                                                 | Allocate an unallocated remainder later                           |
| `prospectus billing invoice write-off NUMBER --reason TEXT`                                                                                                        | Mark an invoice `uncollectible`                                   |

Amounts are US dollars parsed into integer cents; more than two decimal places is refused. `--method` accepts only the external methods. Every write sends a client-generated operation id, so a retried command never records a payment twice. Before writing, the CLI prints what it will record and asks for confirmation; `--yes` skips the prompt for agents. Refusals (not an admin, over-allocation, wrong account) come back as clear messages. Specs use a fake API with no network.

## New infrastructure

None of this exists. Each item needs Ryan's concrete approval before deployment:

- A billing runtime (a billing Lambda, or routes on the central service) whose role has `s3:GetObject` and `s3:PutObject` on `prospectus-central/billing/*` and `_virtuus/prospectus-central/billing/*` only, `s3:ListBucket` limited by prefix to those scopes, and `ssm:GetParameter` on the two Stripe parameters. It cannot read identities, accounts or intake prefixes, and the accounts runtime cannot write billing. Entitlement and operator checks go through the central accounts service.
- The unauthenticated webhook route `POST /billing/stripe/webhook`, with a route throttle and body limit.
- Operator billing routes under `/v1/account-directory/operator/accounts/{id}/` (`billing-profile`, `billing-lines`, `invoices`, `payments`) and the directory BFF policy change to reach them.
- Customer routes on the Anthus One BFF: `GET /accounts/{id}/billing`, `GET /accounts/{id}/billing/invoices`, and owner-only, origin-checked, throttled `POST /accounts/{id}/billing/checkout` and `POST /accounts/{id}/billing/portal-session`.
- The `accounts:admin:billing` permission and its first grant.
- The Stripe account, its restricted keys, webhook endpoint and SSM parameters, which only Ryan can create (kanbus-c49243).
- A scheduled rule for the daily due-date check, only if approved; otherwise the check runs in the reconcile script.
- Any DynamoDB catalog rows for billing, if the CRM listing needs them.

## Decisions and open questions

Ryan's decisions were recorded on 2026-10-31 on kanbus-a78bcd.

| #   | Question                       | Status  | Decision                                                                                                                                               |
| --- | ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Tax                            | Decided | Not now. No tax lines; total = subtotal. Revisit before any live mode                                                                                  |
| 2   | Currencies                     | Decided | USD only; any other currency is refused                                                                                                                |
| 3   | Net terms and due dates        | Decided | Net 30 by default, optional per-account override, no late fees                                                                                         |
| 4   | Who records and allocates      | Decided | Admins only (`accounts:admin:billing`), no second-operator confirmation; the CLI supports it for agents                                                |
| 5   | Write-offs                     | Partly  | Admins only mark `uncollectible`; the invoice and journal stay on record. **Open:** whether a written-off balance counts toward what is owed           |
| 6   | Automatic suspension           | Decided | Never automatic; operators only. Billing events create follow-ups                                                                                      |
| 7   | Numbering and documents        | Decided | Numbers are `YYYYMM-NNN`, sequential within each month (Ryan, 2026-10-31); every invoice has a PDF, manual ones included. the issuer block and payment methods are admin-set data (`billing/issuer.json`), not code (Ryan, 2026-10-31)         |
| 8   | One invoice per site or client | Decided | One combined invoice per client per period across all products; each line is its own line item. Direct: one subscription per client, one item per line |
| 9   | Pricing and plans              | Decided | Out of scope; catalog structure with test-mode placeholder prices                                                                                      |
| 10  | Trials and free tiers          | Open    | Is a product granted without a billing line ever client-facing, or always internal?                                                                    |
| 11  | Refunds of external payments   | Open    | Are they ever recorded, and by whom? (Stripe refunds are mirrored as reversals)                                                                        |
| 12  | Accounting export              | Open    | Export invoices and payments to accounting software, and which one?                                                                                    |
| 13  | Lines from entitlement events  | Open    | Should a grant ever create a billing line automatically?                                                                                               |
| 14  | Retention of billing records   | Open    | How long billing contact data and invoices are kept as financial records (kanbus-d7ec0e)                                                               |

Raised while writing this document and not yet put to Ryan:

| #   | Question                          | Status | Notes                                                                                                               |
| --- | --------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| 15  | Proration                         | Open   | When a line is added, paused or ended mid-period, is the change prorated or does it take effect at the next period? |
| 16  | Owner confirmation for a new item | Open   | In direct mode, does adding a line to an existing subscription need the owner's confirmation in the portal?         |
| 17  | Mixed intervals                   | Open   | One subscription cannot mix intervals; are monthly and annual plans ever needed on one client?                      |
| 18  | Number on Stripe-issued invoices  | Open   | Whether the client sees the Prospectus number or Stripe's own number on Stripe-hosted invoices                      |
