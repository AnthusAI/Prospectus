# Quota

> **Agreed change, not built yet (2026-11-05):** quota is moving to real cost. Units become microdollars of what each Account actually costs, a plan's weekly allowance becomes a quarter of its monthly cost budget, and pay-after usage moves to an SQS queue. See [COST_ACCOUNTING.md](COST_ACCOUNTING.md), which wins where the two differ. The rest of this document describes what is built and deployed today.

Every Account has one weekly quota, shared by every app on it. A customer sees a single number: the percent of this week's quota used, from 0 to 100, and when it resets. Products do not report money. They report billable items (tokens, vCPU seconds, Lambda GB-seconds), and Prospectus converts them into its own internal usage units with a private rate table. This document is the reviewed model. The behavior specifications are `features/quota-*.feature`; the code is in `quota/`, the product client is in `packages/accounts-client` (`/server`), and the epic is kanbus-05fc67.

Billing is separate. Quota says how much an Account may use per week; billing (see [BILLING.md](BILLING.md), not built) may later sell more. Quota writes no billing record and billing writes no quota record. Reconciling recorded usage against real AWS and OpenAI bills is out of scope for now (kanbus card in the epic).

## Principles

- **One number for customers.** Customers and products never see dollars, rates, the formula, units or per-item amounts. The portal shows percent used, the reset time and each app's share of the quota in percent.
- **The formula is private and lives outside Git.** This repository is public and holds only the engine. The rate table (the rates and each plan's weekly allowance) is the value of an SSM SecureString parameter that infrastructure creates once with a placeholder and a deployment then writes from private configuration. Tests, fixtures, specs and docs use a made-up table.
- **Fail closed.** An unknown Account, a product the Account is not entitled to, no allowance, no table, an unparseable table, an unknown item kind, a store that cannot be read or written: all are refusals or errors, never success and never free. The server client throws on all of them and on any response it does not recognize.
- **Integers only.** Usage units are whole numbers. A rate is `units` per `per` of the item's own quantity, rounded up per item, computed without floating point.
- **Conditional writes and retry-safe operation IDs.** Each week's record is one document written with a revision compare-and-set. Every mutating call carries a client-generated UUID; repeating it returns the original result and writes nothing again, and the same ID with a different request is `409 idempotency_conflict`.
- **Every mutation is journaled**, with the actor, revisions, result, and what was charged under which table version.

## The week

Every Account's week starts at the same moment: **Saturday at 12:00 noon in America/New_York**, following daylight saving. Nothing depends on when an Account was created. A week is normally 168 hours, 167 hours when it contains the spring clock change and 169 hours when it contains the autumn one, because the boundary follows New York wall-clock time. The zone, day and hour are named in one place, `quota/week.ts`. A boundary instant belongs to the week it starts: noon exactly is the new week, one millisecond earlier is the old one.

There is nothing to run at a boundary: a new week reads a new record, so usage resets by time alone, the same way a hold expires. Each week's record is keyed by its start, the date of that Saturday as `YYYYMMDD` (`weeks/<account>/20300316.json`). Unused quota does not carry over. Past weeks' records are kept for reporting and are not rewritten after their week ends. The portal and CRM show the reset as that one instant in the viewer's own time zone, with the zone named.

**Holds crossing a boundary.** A hold counts against the week it was taken until it ends, and no longer once that week is over. A charge counts in the week it settles. So work reserved late in one week and settled in the next is charged to the new week, and the old hold simply stops counting at the boundary. Such a reservation is closed once, by a marker in the new week's record, so settling or releasing it again is refused. A settle or release looks in the current week and the one before, so a hold must not be able to reach past the next boundary: its lifetime is capped below the shortest week (167 hours), whatever the deployment configures.

## Allowance

An Account's weekly allowance comes from the private table: the plan an operator chose for the Account, or the table's default plan if it has one, and a per-Account override (whole units) wins over the plan when set. An Account with neither has no allowance and is refused. At 100% (used plus held at or above the allowance) new reservations are refused and `check` answers not allowed.

## Reporting items

An item is `{ "itemKind": "<namespaced name>", "quantity": <whole number> }`. The set of kinds is open and namespaced, for example `openai.tokens.input`, `jev.tokens`, `aws.bedrock.tokens.<model>`, `aws.batch.vcpu_seconds`, `aws.lambda.gb_seconds`. Kinds are lower case, dot separated, up to 96 characters. A kind the table does not know is refused with `422 unknown_item_kind` and nothing is charged. The refusal is visible to operators in the refusal log and as a `usage.refused` journal event naming the kind, so a missing rate is noticed, not silently free. Do not remove a kind from the table while products still send it.

## Two ways to spend

Item costs differ wildly, so there are two paths.

**Reservation, for expensive work (AWS Batch, renders).** Reserve from the estimated maximum items, settle with the actual items, release if nothing ran. Same safety properties as any hold: conditional writes, operation IDs, journal, fail closed.

**Pay after, for high-volume small items (LLM tokens, Lambda).** `check` is a cheap read that answers whether the Account is under 100%. `record` reports actual items after the fact. A product batches many items per `record` call (for example once a second or every N requests) and repeats a failed call unchanged, so a request needs neither a reservation nor two extra writes. Recorded usage can overshoot slightly past 100%: the overshoot is recorded internally, the display caps at 100, and the next `check` or reserve refuses.

## HTTP contract

Every call is `POST`, signed with SigV4 (service `execute-api`) by a product's server role using runtime temporary credentials, with `Content-Type: application/json`. Only a product registered with `quota: true` may call, as its enrollment role or as its optional `quotaCaller` role (a second IAM role, for example a spending gate, that may use these five routes and nothing else: any other route, or another method, is `403 quota_route_forbidden`); execution roles, reader sites, google-direct products and the lab verifier cannot. The product is selected from the verified caller and never named in a body. The base URL is the central accounts API stage URL. Unknown fields are refused with `400 unknown_fields`.

| Route | Body | Success (200) |
| --- | --- | --- |
| `/v1/quota/accounts/{account}/check` | `{}` | `{"allowed": bool, "percentUsed": 0-100, "resetsAt": ISO time}` |
| `/v1/quota/accounts/{account}/usage` | `{"operationId": uuid, "items": [item, ...]}` (at least one) | `{"accountId", "status": "recorded"}` |
| `/v1/quota/accounts/{account}/reservations` | `{"operationId": uuid, "items": [...], "expiresInSeconds": n}` | `{"reservationId", "accountId", "status": "reserved", "expiresAt"}` |
| `/v1/quota/accounts/{account}/reservations/{reservation}/settle` | `{"operationId": uuid, "items": [...]}` (may be empty) | `{"reservationId", "accountId", "status": "settled"}` |
| `/v1/quota/accounts/{account}/reservations/{reservation}/release` | `{"operationId": uuid}` | `{"reservationId", "accountId", "status": "released"}` |

The reserve `operationId` is the reservation ID; settle, release and usage carry their own. Success bodies contain no units, rates or amounts, and nothing that changes with time except `check`. Refusals are `{"error": code, "message": text}`:

| Status and code | Meaning |
| --- | --- |
| 400 `invalid_items`, `invalid_item_kind`, `invalid_quantity`, `invalid_expiry`, `invalid_operation_id`, `unknown_fields` | Malformed request |
| 402 `quota_exhausted` | At 100%: do not start work |
| 402 `quota_insufficient` | The estimate does not fit in what remains this week |
| 403 `quota_forbidden`, `caller_forbidden`, `product_not_entitled`, `no_allowance`, `wrong_product` | Not allowed |
| 404 `account_missing` | Unknown Account |
| 409 `reservation_not_open`, `idempotency_conflict`, `quota_capacity`, `busy` | State conflict. `busy` means retry with the same operation ID |
| 422 `unknown_item_kind` | An item kind is not recognized |
| 503 `quota_unavailable` | The store or table cannot be used. Do not spend; retry with the same operation ID |

Any non-200 response, a network error or an unexpected body means do not spend. After an uncertain outcome, repeat the same call with the same operation ID and body. The TypeScript client (`serverQuotaClient`) implements this; a Python caller implements the table above directly.

Reservation lifetime: the caller states `expiresInSeconds`, at most the service maximum (24 hours by default, never above 167 hours, the shortest week). A hold stops counting at its expiry or at the end of its week, whichever comes first, with no sweeper. A product should choose a lifetime just above its job's attempt timeout. Settling after expiry still records what was really used. Expired entries are dropped, with a `reservation.expired` journal event written first, only when the week's record needs room.

## Storage

Quota is its own Virtuus project (`quota`) in the Rust bridge, beside `accounts` and `billing`, so it can write only quota paths: ordinary JSON files under `prospectus-central/quota/`, with control files under `_virtuus/prospectus-central/quota/`.

| Record | Path under `prospectus-central/quota/` |
| --- | --- |
| Plan and override for an Account | `settings/<accountUUID>.json` |
| One Account's usage for one week | `weeks/<accountUUID>/<week>.json` |
| Journal event, one per mutation | `journal/<eventId>.json` |

**High volume.** The week document holds aggregates only: units used, per-app and per-item-kind totals, units per table version, active holds, and a bounded audit of the last 32 operations. Its size does not grow with the volume of usage (it is bounded by the number of apps, kinds and table versions), so a high token volume cannot reach the 64 KiB document limit. Every individual charge is instead its own immutable journal file, which is the permanent, explainable record: it holds the items, the units, the table version and the result. The cost of this choice is one extra object per `record` call, which is why products batch, and one document per Account-week that serializes concurrent writes through a compare-and-set (a losing writer re-reads and retries). A full document of active reservations refuses a new one with `409 quota_capacity` rather than dropping a live hold.

**Rate-table versions.** Each charge records the table version it was priced under in the journal and in the week's `usedByTableVersion`. Units are computed at charge time and stored, so a later rate change never rewrites past usage. A reservation is priced when it is made; a settle or record is priced when it happens.

## The rate table

The value of the SSM SecureString parameter named by `AccountsPlaneOptions.quotaRateTable` (a reviewed `/…/v1` name). It is a JSON object, at most 8 KB (the parameter uses the Advanced tier):

```json
{
  "version": "<a name for this exact table>",
  "defaultPlan": "<optional plan name>",
  "plans": { "<plan>": { "monthlyBudgetMicrodollars": 0 } },
  "rates": { "<itemKind>": { "units": 0, "per": 1 } }
}
```

Units are microdollars of real cost ([COST_ACCOUNTING.md](COST_ACCOUNTING.md)): a rate is Anthus's actual cost per item, and a plan names `monthlyBudgetMicrodollars`, of which each week allows a quarter, rounded down. A plan names exactly one allowance; a table written before this change may still give `weeklyAllowanceUnits` instead.

Unknown fields, non-integers, a rate with `per` below 1 and a `defaultPlan` that is not a plan all make the table unparseable. Rates and allowances are programmatic: nobody types them in, and there is no screen, route or command for editing them. A deployment writes the table to the parameter from private configuration that lives outside this repository. Infrastructure creates the parameter once with a placeholder that is deliberately unparseable, so an unset table refuses all spending (503) until that deployment has written a valid one, and the infrastructure itself never overwrites it. The service caches the parsed table for a minute, so a change applies within about a minute. The rate table's contents never appear in an API response, in the CRM, in logs or in this repository.

## Operator route

`POST /v1/account-directory/operator/accounts/{account}/quota` with `{operationId, plan?, allowanceOverrideUnits?}` chooses the Account's plan (a name in the table) and/or a per-Account weekly allowance override in units; `null` clears a field. Only admins may set quotas: it needs the reviewed operator permission `accounts:admin:quota` in `accounts/operator-grants.json`; read access and `accounts:admin:entitlements` are not enough, and Account owners cannot change their own quota. The journal records the operator's reviewed grant ID. Like the entitlement route, it is reachable only once the directory BFF's API Gateway policy allows operator writes, which is held for approval (see [OPERATIONS.md](OPERATIONS.md#product-access)).

## What the CRM and portal show

The account directory detail carries a `quota` view. Customers get `{state:"set", percentUsed, resetsAt, byProduct:[{product, percentOfQuota}]}`, `{state:"none"}` for an Account with no allowance, or `{state:"unavailable"}` when the store or table cannot be used; unavailable is never shown as zero or unlimited. Staff in the CRM additionally see the plan, the override, internal units (allowance, used, held, overshoot) and the table versions charged, never the table's contents. The portal shows the percent in its header, a weekly quota card on Home and a Usage page, with no money anywhere. Neither surface has any control for editing quotas, plans, rates or allowances; the CRM has no "Add quota" button. Quota changes are made only through the admin route above.

## New infrastructure

The owner approved these permissions on 2026-11-02. Production's `accounts/deployment.json` now passes `quotaRateTable`, so the next deploy of `main` creates them:

- The central accounts runtime role gains `s3:GetObject` and `s3:PutObject` on `prospectus-central/quota/*` and `_virtuus/prospectus-central/quota/*`, and the `s3:ListBucket` prefix condition gains the same two prefixes (`infra/lib/accounts-plane.ts`).
- One retained SSM SecureString (Advanced tier) named `/prospectus/central-accounts/quota-rate-table/v1`, created once by a create-only custom resource with the placeholder `{"version":"unset"}`, which the service refuses as unparseable. The central runtime role gains `ssm:GetParameter` on that one parameter, and the Lambda environment variable `PROSPECTUS_QUOTA_RATE_TABLE` names it.
- A new initializer Lambda `prospectus-quota-rate-table-init` with its own role (`ssm:PutParameter` on that one parameter, with an explicit deny when `ssm:Overwrite` is true, and its log group), so it can create the parameter and never replace its value.
- A third warm bridge process in the central Lambda for the `quota` project.
- The new operator permission `accounts:admin:quota` (its first grant and the held directory BFF policy change for operator writes are still separate approvals).

A registration may also carry `quotaCaller: { roleArn }`, allowed only with `quota: true` and a role no other principal uses (role names are unique across enrollment, execution, quota caller and verifier roles). The resource policy lists that role in the quota routes statement only. For Babulus the role comes from the optional deployment option `quotaCallerRoleArn`, read from `PROSPECTUS_BABULUS_QUOTA_ROLE_ARN` when set; the other Babulus options are `PROSPECTUS_BABULUS_ENABLED`, `_ROLE_ARN`, `_ISSUER`, `_CLIENT_ID` and `_FEDERATION_REVIEW_ID`.

Not configured: `AccountsPlaneOptions.quotaProducts` (reviewed registrations carrying `quota: true`; nothing passes any today besides the Babulus registration when its options are supplied). Registering a product (for example Babulus) is a separate reviewed change.

Until a real table is written, every quota call answers `503 quota_unavailable` and the Account views show `unavailable`. Once a valid table is written, an Account with no operator-chosen plan uses the table's `defaultPlan`, so the operator route is not needed for the default plan. An Account is refused with `403 no_allowance` only if the table has no `defaultPlan` and the Account has neither a plan nor an override.

## How a real table reaches the parameter

Never by hand, never from Git. The parameter is `/prospectus/central-accounts/quota-rate-table/v1`. A person writes the table JSON to it as a SecureString with overwrite, from private configuration kept outside this repository, using a deployment identity that is separate from the initializer role, which cannot overwrite:

```
AWS_PROFILE=<profile> scripts/write-quota-rate-table.sh --account <12-digit id> --values <file>
```

The script refuses (exit 2) unless the signed-in account matches `--account`, unless the file passes this repository's own rate table parser (`parseRateTable`), and if the file still contains `<` placeholders. Then it writes the parameter with `aws ssm put-parameter --tier Advanced --overwrite` and prints only the new version number, never the values. `scripts/quota-rate-table.example.json` shows the shape with placeholders only; copy it outside the repository and fill it in there. Agents do not run the script unless told to. `test/quota-rate-table-script.test.ts` checks the refusals with a fake `aws` on the path. The service reads the parameter at runtime and caches the parsed table for a minute. Rates, plans and allowances never appear in this repository, its tests (which use made-up tables), logs or API responses.

## Decisions for the owner

- **Week boundary:** Saturday 12:00 noon America/New_York for every Account, following daylight saving (decided; weeks of 167 and 169 hours around the clock changes).
- **What counts toward the percentage:** used plus held. Work in progress is counted so the number reflects what is committed.
- **Per-app share:** each app's contribution to the percentage, in percent of the quota.
- **Maximum reservation lifetime:** 24 hours by default, never above 167 hours.
- **Overshoot:** pay-after usage may overshoot and is recorded; there is no cap beyond refusing new work.
- **Table cache:** one minute, so a rate or allowance change applies within about a minute.
- **Who holds `accounts:admin:quota`,** and which deployment identity runs `scripts/write-quota-rate-table.sh` against the rate-table parameter.
