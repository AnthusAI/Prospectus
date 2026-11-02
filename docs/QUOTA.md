# Quota

Quota is the cloud spend an account may cause through its apps. One allowance per account is shared by every app: a product reserves quota before it starts paid cloud work, settles against the real cost when the work ends, and releases what it did not use. This document is the reviewed model. The behavior specifications are `features/quota-*.feature`; the code is in `quota/`, the client in `packages/accounts-client` (`/server`), and the epic is kanbus-05fc67.

Billing is separate. Quota says how much an account may spend; billing (see [BILLING.md](BILLING.md), not built) may later sell more of it. Quota writes no billing record and billing writes no quota record. Stripe is out of scope.

## Principles

- **Whole US cents of cloud cost.** The unit is `usd-cents`, an integer. Nothing is fractional, negative where it should not be, or beyond what an integer sum holds exactly. This is the recommended default and is pending the owner's confirmation.
- **Fail closed.** The only way to learn that spending is allowed is a successful reserve. An unknown account, a product the account is not entitled to, no allowance, too little remaining quota, an unreadable store and a failed write are all refusals or errors, never success. The server client throws on every one of them and on any response it does not recognize.
- **One conditional write decides.** Each account's money is one document written with a revision compare-and-set, so concurrent reservations cannot together exceed the allowance: the loser re-reads and is checked against what the winner held.
- **Retries are safe.** Every call carries a client-generated UUID operation ID. Repeating an operation returns its original result and writes nothing again; the same ID with a different request is `409 idempotency_conflict`.
- **Every mutation is journaled.** One append-only file per mutation records the actor, the revisions and the result.

## Storage

Quota is its own Virtuus project (`quota`) in the Rust bridge, beside `accounts` and `billing`, so it can write only quota paths. Files are ordinary JSON under `prospectus-central/quota/`, with control files under `_virtuus/prospectus-central/quota/`.

| Record | Path under `prospectus-central/quota/` | Written by |
| --- | --- | --- |
| Allowance and everything charged against it | `allowances/<accountUUID>.json` | Operator grants; product reserve, settle and release |
| Journal event | `journal/<eventId>.json` | Every mutation |

The allowance document holds `allowanceCents` (the total granted), `usedCents` (settled actual costs), `overageCents`, `usedByProduct`, the active `holds` keyed by reservation ID, a revision and a bounded audit of the last 32 operations with their results. The document is capped at 64 KiB like the account document; a full record of active reservations refuses a new one with `409 quota_capacity` rather than dropping a live hold. A journal event ID is the SHA-256 of the account, action and operation ID, and the event carries the result a repeat returns.

Remaining quota is `allowanceCents - usedCents - held`, where held is the sum of the maximums of holds that have not expired. It can be negative after an acknowledged overage or a lowered allowance, and then every new reservation is refused.

## Routes

All three are `POST`, reached with SigV4 from a registered product's server role and carrying a JSON body. Only a product registered with `quota: true` (and not a reader site, google-direct product or execution role) may call them. The central service selects the product from the verified API Gateway caller, so a product is never named in a request.

| Route | Body | Result |
| --- | --- | --- |
| `/v1/quota/accounts/{account}/reservations` | `operationId`, `maxCents` (at least 1), `expiresInSeconds` (at least 1) | `{reservationId, accountId, status:"reserved", maxCents, expiresAt}` |
| `/v1/quota/accounts/{account}/reservations/{reservation}/settle` | `operationId`, `actualCents` (0 or more), optional `allowOverage` | `{reservationId, accountId, status:"settled"\|"settled_late", chargedCents, releasedCents, overageCents}` |
| `/v1/quota/accounts/{account}/reservations/{reservation}/release` | `operationId` | `{reservationId, accountId, status:"released", releasedCents}` |

The reserve `operationId` is the reservation ID. Settle and release carry their own operation IDs. Results contain nothing that changes with time, so a repeat is byte-identical.

### Reserve

Succeeds only if all of these hold, checked in this order:

1. the account exists (`404 account_missing`);
2. it holds an active entitlement for the calling product (`403 product_not_entitled`);
3. it has an allowance record (`403 no_allowance`);
4. `maxCents` is at most the remaining quota (`402 quota_insufficient`).

An allowance of zero is an allowance that covers nothing. The requested lifetime may not exceed the service's maximum hold, 24 hours by default and configurable per deployment (owner decision below).

### Settle

Charges the actual cost and releases the rest of the reservation. A cost above the reservation is refused (`409 exceeds_reservation`) unless the caller sends `allowOverage: true`, and then the whole cost is charged and the difference is recorded as overage in the document, the response and the journal. Settle is never silently capped, because a cap would lose the cost.

### Release

Returns everything the reservation held and charges nothing.

### Wrong product, closed and unknown reservations

Settling or releasing a reservation that belongs to another product is `403 wrong_product` and changes nothing. A reservation that is unknown, already settled or released, or reclaimed is `409 reservation_not_open`; the same operation ID repeated still returns its original result.

## Expiry rule

A reservation carries the lifetime its product asked for. Expiry is a fact of time, not an action: from `expiresAt` onward the hold no longer counts against the account, so an abandoned or crashed job's quota comes back without anyone running anything. There is no sweeper and no scheduled rule.

The expired hold's entry stays in the document, so the product can still record what the job cost:

- Settling after expiry charges the whole actual cost as overage, and only when the caller sends `allowOverage: true` (otherwise `409 reservation_expired`). The result status is `settled_late`. An expired hold covers nothing, so nothing is released.
- Releasing after expiry succeeds and charges nothing.

An expired entry is dropped, and a `reservation.expired` journal event written first, only when the record needs room (the document is near its byte budget). Active holds are never dropped. After that, settling the reclaimed reservation is `409 reservation_not_open`; the journal still records what it held.

## Operator grant

`POST /v1/account-directory/operator/accounts/{account}/quota` with `{operationId, allowanceCents}` sets the account's total allowance. It requires the reviewed operator permission `accounts:admin:quota` in `accounts/operator-grants.json`; read access and `accounts:admin:entitlements` are not enough, and account owners cannot grant themselves quota. The journal records the operator's reviewed grant ID as the actor. Lowering the allowance below what is used and held keeps existing holds and refuses new reservations until it is raised. No grant of this permission exists yet, and who holds it is the owner's decision.

Like the entitlement route, this route is reachable only once the directory BFF's API Gateway policy allows operator writes, which is held for approval (see [OPERATIONS.md](OPERATIONS.md#product-access)).

## What the CRM and portal show

The account directory detail (operator and customer) carries a `quota` view: `{state:"set", ...numbers}`, `{state:"none"}` for an account with no allowance, or `{state:"unavailable"}` when the store cannot be read or is not configured. Unavailable is never shown as zero or as unlimited. The CRM account page shows the numbers and the split by app; the Anthus One portal shows the remaining quota in its header, a quota card on Home and a Usage page.

## Calling it from a product

```ts
import { serverQuotaClient } from "@anthus/prospectus-accounts-client/server";
const quota = serverQuotaClient({ endpoint: process.env.PROSPECTUS_ACCOUNTS_URL!, region: "us-east-1" });
const reservation = await quota.reserve(accountId, { operationId, maxCents, expiresInSeconds });
// start paid work only after reserve returns; any throw means do not spend
await quota.settle(accountId, reservation.reservationId, { operationId: settleId, actualCents });
// or, when the work never ran:
await quota.release(accountId, reservation.reservationId, { operationId: releaseId });
```

Keep the operation IDs. After a timeout or an unknown outcome, repeat the same call with the same ID and body: it either returns the original result or performs the operation once.

## New infrastructure

Nothing is deployed by this change. Each item needs the owner's concrete approval before a deployment includes it:

- The central accounts runtime role gains `s3:GetObject` and `s3:PutObject` on `prospectus-central/quota/*` and `_virtuus/prospectus-central/quota/*`, and the `s3:ListBucket` prefix condition gains the same two prefixes (`infra/lib/accounts-plane.ts`). It gains no other permission.
- A third warm bridge process in the central Lambda for the `quota` project. The Rust binary accepts the new project name.
- `AccountsPlaneOptions.quotaProducts`: reviewed registrations carrying `quota: true`. Each is registered with the central service, its role is added to the API's resource policy for exactly the three routes above and to the policy's permitted principals. Nothing passes any product today, so the synthesized template gains no principal.
- The new operator permission `accounts:admin:quota` and its first grant.
- For the operator grant route to be callable: the held directory BFF policy change for operator writes.

Registering a product (for example Babulus) is a separate reviewed change that supplies its role to `quotaProducts` and grants the calling role `execute-api:Invoke` on the three routes from its own side.

## Decisions for the owner

- Unit: integer US cents of cloud cost per account (recommended default, applied here).
- Maximum hold lifetime: 24 hours by default, set per deployment. A product states its own lifetime, normally just above its job timeout.
- Allowance is a running total set by operators. There are no periods or monthly reset yet; a monthly allowance needs billing or a scheduled change and is a follow-up.
- Who holds `accounts:admin:quota`.
