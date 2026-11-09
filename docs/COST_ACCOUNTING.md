# Cost accounting

Prospectus keeps a private ledger of what each customer actually costs Anthus, in US dollars, broken down by Account, app and day. The weekly quota is drawn against that real cost. Customers never see dollars: they see the percent of this week's quota used, and each app's share of it in percent (see [QUOTA.md](QUOTA.md)). Anthus sets the price of each plan and so engineers the margin.

This is the model Ryan agreed on 2026-11-05. Ryan asked for it to be built on 2026-11-08, tested first on the Papyrus sites Anthus operates and then on a design partner's three new sites, which launch directly on the shared multi-tenant Papyrus tier at Papyrus milestone M7 and are never dedicated sites (Ryan, 2026-11-09; their costs follow the shared-tier path, kanbus-f45f7f); the epic is kanbus-bb0b6c and the behavior specifications are `features/cost-*.feature`. Where it changes what [QUOTA.md](QUOTA.md) describes, this document wins, and the quota code changes to match (see [Changes to the built quota](#changes-to-the-built-quota)).

## Principles

- **Real dollars, kept private.** Every cost is recorded in US dollars as an integer number of microdollars (millionths of a dollar). No floating point. Dollar amounts never appear in a customer-facing page, an API response to a product, or this repository's fixtures (tests use made-up prices).
- **Attribute everything that can be attributed.** Model calls, Lambda, containers, AppSync, DynamoDB, Amplify hosting and any other cost that can be tied to a customer is charged to that customer, including costs that accrue while nobody is using the app.
- **Never slow an app down.** Recording a cost is never on a request's critical path. Apps tally usage in memory and hand it off in batches.
- **Infrastructure as code, built into every app.** Tags, queues, permissions, the daily import and the cost tag activation are all created by code. No console steps, no per-app manual configuration. The only manual inputs are secret values and the private price list.
- **Daily is fine.** Bill-derived costs are imported once a day. Live usage reports keep the quota roughly current between imports.

## Attribution

Every cost is attributed to:

| Field      | Value                                                                                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account    | The Prospectus central Account UUID                                                                                                                                                                                                                                                                          |
| App        | The product family (`papyrus`, `cyclotron`, `babulus`, `chatticus`, ...), from a fixed list in the registry, never free text, so a breakdown cannot split into near-duplicate rows. Every Papyrus site is app `papyrus` (agreed with the Papyrus session on 2026-11-08), whatever its registry product name. |
| Deployment | Optional. Distinguishes several deployments of one app on one Account. For Papyrus it is the site ID (`dataparade`, `p-apyr-us`).                                                                                                                                                                            |
| Category   | What was consumed, for example `openai.tokens.input`, `jev.tokens`, `aws.lambda`, `aws.appsync`, `aws.dynamodb`, `aws.amplify`. The same namespaced kinds as quota items.                                                                                                                                    |
| Day        | The UTC day the cost was incurred.                                                                                                                                                                                                                                                                           |

The customer's cost breakdown is by app (and deployment where there is more than one), shown only as each app's percent of the quota.

## The tagging standard

Every AWS resource every app creates carries these tags. Prospectus reads costs by them.

| Tag key             | Value                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `anthus:app`        | The app's registry ID. Always present.                                                                      |
| `anthus:account`    | The Account UUID, on a resource that serves one customer. `shared` on a resource that serves many.          |
| `anthus:deployment` | The deployment ID, where an app can have several per Account.                                               |
| `anthus:cost-key`   | `<account>/<app>/<deployment>` (deployment empty when absent), set by the helper from the three tags above. |

Cost Explorer groups by at most two dimensions per query, so the daily import groups by `anthus:cost-key` and service in one query and splits the key back into its parts. The three separate tags stay for people reading the bill.

The existing `anthus:project` and `anthus:surface` tags stay.

Apps do not tag by hand. A shared infrastructure helper (a CDK Aspect for CDK apps, and the equivalent for any app still on raw CloudFormation or Amplify Gen 2) applies the tags to every resource in a stack from the stack's own configuration. Each app's CI fails a synthesized stack that has a taggable resource without `anthus:app` and `anthus:account`.

Activating these keys as cost allocation tags is also code: a stack in the AWS Organizations management account calls Cost Explorer's `UpdateCostAllocationTagsStatus`. AWS counts tags from the day they are activated.

## Where costs come from

There are three sources, all landing in the same ledger.

**1. Per-customer resources, from Cost Explorer.** An app that gives each customer its own stack (each Papyrus site has its own AppSync API, DynamoDB tables and Amplify app) tags that stack with the customer's Account. A daily job queries the Cost Explorer API for the previous day's cost grouped by `anthus:account` and `anthus:app` (and `anthus:deployment`), split by service. Cost Explorer covers every linked AWS account only from the Organizations management account, so the job runs there, or under a role that account provides. Each query costs about one cent, so the job costs well under a dollar a month.

**2. Shared resources, split by measured usage.** A resource that serves many customers (a shared Lambda function, the central accounts API, a shared table) is tagged `anthus:account=shared` and its app. Cost Explorer gives that app's daily shared cost. The app reports each customer's measured usage of it (for a Lambda function, duration times memory; otherwise requests), and the daily job splits the shared cost across customers in proportion. Shared cost with no usage reported that day is recorded as unattributed overhead for that app.

**3. Model calls, priced from token counts.** OpenAI, Jev from TypeSafe and other model bills do not know our customers. The app reports token counts per Account with every batch, and Prospectus prices them from the private price list. The providers' own usage reports serve as a check on the per-app totals.

**How the daily import runs** (`quota/cost-import.ts`; `costImport: true` in `accounts/deployment.json` since 2026-11-09, live once develop is promoted). Every day at 07:15 UTC the central runtime re-imports the last three complete UTC days, because Cost Explorer revises a day's figures for a day or two. It finds the management account with Organizations `DescribeOrganization`, so no account ID is configured, and assumes the read-only role `prospectus-cost-import` there (`infra/lib/cost-management.ts`, trusted by the central runtime role only). One `GetCostAndUsage` query per day groups by `anthus:cost-key` and service; each service becomes a category such as `aws.appsync` or `aws.dynamodb`.

- A per-customer key becomes that Account's actual for the app, deployment and service.
- A `shared/<app>/` key is split across Accounts by the usage each reported that day for the same service (for `aws.lambda`, the quantities of `aws.lambda.*` kinds such as GB-seconds). If nobody reported usage for that service, the split uses each Account's total reported usage of the app that day. If nobody used the app, the cost is unattributed overhead.
- An actual for `aws.<service>` replaces the app's live estimates under `aws.<service>.<unit>` for the same Account, app and deployment, so real figures are never added on top.
- Untagged cost (by service), cost whose key names an Account that does not exist, unattributed shared cost and credits (negative amounts) are overhead: recorded in a day document under the nil UUID (all zeros: `costs/<nil UUID>/<YYYYMMDD>.json`) and charged to no Account.
- Every write is idempotent; a re-run with the same figures changes nothing. A Cost Explorer failure records nothing, logs a reason code (never provider text) and is retried on the next run.

**Costs billed per month.** Most AWS charges, including Amplify hosting (storage, data served, build minutes, server-side rendering), are metered and reported per day, so the daily import picks them up as they accrue. A charge AWS bills once a month, such as a DNS hosted zone, is meant to be spread evenly over the days of its month (`spreadMonthly` exists); the import does not do this yet, so such a charge currently lands on the day Cost Explorer reports it, usually the first of the month.

**Estimates and actuals.** For usage an app reports live (tokens, container jobs, Lambda time), the live report is an estimate until that day's real cost arrives from the import. The real figure then replaces the estimate for that Account, app, category and day; it is never added on top. Costs that only come from the import (AppSync, DynamoDB, hosting) appear when the import runs, about a day after they are incurred.

## How apps send usage

Apps send usage to Amazon SQS queues that Prospectus owns, **one queue per registered product**.

1. The app keeps a running tally in memory, per Account, app, deployment and category.
2. About once a minute it sends one message with the tally to its queue: one fast call that never waits on Prospectus. A failed send is retried with the same message. In a short-lived runtime (Lambda, Amplify compute), where a frozen process can lose memory, the sender sends before the invocation ends, one message per invocation that recorded anything.
3. A scheduled Prospectus consumer runs once a minute, drains every product queue up to a bounded number of messages, and writes them to the ledger and the quota.
4. If Prospectus is down or busy, messages wait in the queue (retention up to 14 days). Messages that keep failing go to the product's dead-letter queue, with an alarm.

Each message carries a client-generated operation ID, so a message delivered twice is counted once.

**Why one queue per product.** SQS does not tell the consumer which product sent a message in a form the registry can check (it reports an opaque role ID, not the role ARN the registry holds). A queue whose policy lets exactly one registered role send proves the sender, so the consumer takes the product from the queue and never from the message body. Queues cost nothing to exist.

**Why a scheduled drain.** A Lambda event source mapping keeps long-polling every queue, which costs roughly 650,000 empty receives per queue per month. Draining all queues once a minute costs about 43,000 receives per queue per month and one small invocation a minute, and usage already reaches the quota about a minute late.

Cost: SQS is about $0.40 per million requests after the first million a month, which are free, so this is pennies a month. EventBridge (about $1 per million events) and the existing signed HTTP route were considered: they cost more and make the app depend on Prospectus being up.

The queues, dead-letter queues, alarm, consumer, schedule and queue policies are Prospectus infrastructure code generated from the product registry, behind the `usageQueues` deployment flag, turned on with the owner's approval on 2026-11-09. Each app's role gains `sqs:SendMessage` on its own queue in its own infrastructure code, which each app adopts with its own review.

The library apps use for this (batching, retries, operation IDs) lives in `packages/accounts-client`, with a Python equivalent for Python apps, so no app writes its own.

**The quota check stays a direct call.** Before starting work an app asks whether the Account is under 100% (`check` in [QUOTA.md](QUOTA.md)). That is a cheap signed read, which the app may cache for a few seconds. Usage reaches the quota about a minute after it happens; the small overshoot that allows is already accepted.

## The quota on real cost

- **Units are microdollars of real cost.** The private price list holds Anthus's actual cost per item (per token, per GB-second, per job), not a marked-up rate.
- **Weekly budget = monthly amount ÷ 4.** A plan names a monthly cost budget, for example $40, and each quota week allows a quarter of it, $10. The monthly amount is a parameter of the plan in the private table and changes without code. The worst case is 52 weeks a year, about $43 a month on average, which the plan's price covers.
- **The week** is unchanged: it starts Saturday at 12:00 noon America/New_York for every Account, and unused budget does not carry over.
- **Costs that accrue without use count.** The daily import charges each Account's attributed costs, and any correction of an estimate, to the current quota week, so the percentage drops a little each day even when nobody uses the app. Past weeks are never rewritten, so a cost incurred on a Friday and imported on Sunday counts in the new week.
- **Refusal** is unchanged: at 100% new work is refused until the week resets.

## Changes to the built quota

The quota service in `quota/` is built and deployed. These changes bring it to this model:

- Units become microdollars; the rate table's `rates` become cost prices, and a plan's allowance becomes `monthlyBudgetMicrodollars`, with the weekly allowance computed as a quarter of it.
- A new private cost ledger records estimated and actual costs per Account, app, deployment, category and day, separate from the quota week records, and replaces estimates with actuals. It is stored in the existing `quota` Virtuus project under a new `costs` kind (`prospectus-central/quota/costs/<accountUUID>/<YYYYMMDD>.json`), so it needs no new storage permission: the Rust bridge adds `costs` to the quota project's kinds. Each day's document holds aggregates only (bounded by apps, deployments and categories); every message and import is its own journal file.
- The quota accepts charges from the daily import and from the queue consumer, in addition to the existing routes.
- `usage` (pay-after recording) moves to the queue. `check` and the reservation routes stay as they are.

## What needs the owner

- **Done 2026-11-09 (Ryan's approval):** the queue policies and the daily import's permissions (`usageQueues` and `costImport` on in `accounts/deployment.json`), and the management-account role, deployed with `npx cdk deploy ProspectusCostManagement -c costManagement=true` using the `management` profile, which is the Organizations management account.
- **Still to approve:** each app's send permission on its own queue, in that app's adoption.
- **Tag activation:** redeploy the same stack with `-c activateCostTags=true` once the first app's tagged resources have been billed. AWS refuses to activate a tag key it has not seen.
- The monthly budget of each plan, and the cost prices in the private table. Neither is ever in this repository.
