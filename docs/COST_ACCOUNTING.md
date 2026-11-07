# Cost accounting

Prospectus keeps a private ledger of what each customer actually costs Anthus, in US dollars, broken down by Account, app and day. The weekly quota is drawn against that real cost. Customers never see dollars: they see the percent of this week's quota used, and each app's share of it in percent (see [QUOTA.md](QUOTA.md)). Anthus sets the price of each plan and so engineers the margin.

This is the model Ryan agreed on 2026-11-05. It is not built yet. Where it changes what [QUOTA.md](QUOTA.md) describes, this document wins, and the quota code changes to match (see [Changes to the built quota](#changes-to-the-built-quota)).

## Principles

- **Real dollars, kept private.** Every cost is recorded in US dollars as an integer number of microdollars (millionths of a dollar). No floating point. Dollar amounts never appear in a customer-facing page, an API response to a product, or this repository's fixtures (tests use made-up prices).
- **Attribute everything that can be attributed.** Model calls, Lambda, containers, AppSync, DynamoDB, Amplify hosting and any other cost that can be tied to a customer is charged to that customer, including costs that accrue while nobody is using the app.
- **Never slow an app down.** Recording a cost is never on a request's critical path. Apps tally usage in memory and hand it off in batches.
- **Infrastructure as code, built into every app.** Tags, queues, permissions, the daily import and the cost tag activation are all created by code. No console steps, no per-app manual configuration. The only manual inputs are secret values and the private price list.
- **Daily is fine.** Bill-derived costs are imported once a day. Live usage reports keep the quota roughly current between imports.

## Attribution

Every cost is attributed to:

| Field      | Value                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account    | The Prospectus central Account UUID                                                                                                                                                              |
| App        | The product's ID in the Prospectus product registry (`papyrus`, `cyclotron`, `babulus`, `chatticus`, ...). A registry ID, never free text, so a breakdown cannot split into near-duplicate rows. |
| Deployment | Optional. Distinguishes several deployments of one app on one Account, for example two Papyrus sites.                                                                                            |
| Category   | What was consumed, for example `openai.tokens.input`, `jev.tokens`, `aws.lambda`, `aws.appsync`, `aws.dynamodb`, `aws.amplify`. The same namespaced kinds as quota items.                        |
| Day        | The UTC day the cost was incurred.                                                                                                                                                               |

The customer's cost breakdown is by app (and deployment where there is more than one), shown only as each app's percent of the quota.

## The tagging standard

Every AWS resource every app creates carries these tags. Prospectus reads costs by them.

| Tag key             | Value                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `anthus:app`        | The app's registry ID. Always present.                                                             |
| `anthus:account`    | The Account UUID, on a resource that serves one customer. `shared` on a resource that serves many. |
| `anthus:deployment` | The deployment ID, where an app can have several per Account.                                      |

The existing `anthus:project` and `anthus:surface` tags stay.

Apps do not tag by hand. A shared infrastructure helper (a CDK Aspect for CDK apps, and the equivalent for any app still on raw CloudFormation or Amplify Gen 2) applies the tags to every resource in a stack from the stack's own configuration. Each app's CI fails a synthesized stack that has a taggable resource without `anthus:app` and `anthus:account`.

Activating these keys as cost allocation tags is also code: a stack in the AWS Organizations management account calls Cost Explorer's `UpdateCostAllocationTagsStatus`. AWS counts tags from the day they are activated.

## Where costs come from

There are three sources, all landing in the same ledger.

**1. Per-customer resources, from Cost Explorer.** An app that gives each customer its own stack (each Papyrus site has its own AppSync API, DynamoDB tables and Amplify app) tags that stack with the customer's Account. A daily job queries the Cost Explorer API for the previous day's cost grouped by `anthus:account` and `anthus:app` (and `anthus:deployment`), split by service. Cost Explorer covers every linked AWS account only from the Organizations management account, so the job runs there, or under a role that account provides. Each query costs about one cent, so the job costs well under a dollar a month.

**2. Shared resources, split by measured usage.** A resource that serves many customers (a shared Lambda function, the central accounts API, a shared table) is tagged `anthus:account=shared` and its app. Cost Explorer gives that app's daily shared cost. The app reports each customer's measured usage of it (for a Lambda function, duration times memory; otherwise requests), and the daily job splits the shared cost across customers in proportion. Shared cost with no usage reported that day is recorded as unattributed overhead for that app.

**3. Model calls, priced from token counts.** OpenAI, Jev from TypeSafe and other model bills do not know our customers. The app reports token counts per Account with every batch, and Prospectus prices them from the private price list. The providers' own usage reports serve as a check on the per-app totals.

**Costs billed per month.** Most AWS charges, including Amplify hosting (storage, data served, build minutes, server-side rendering), are metered and reported per day, so the daily import picks them up as they accrue. A charge AWS bills once a month, such as a DNS hosted zone, is spread evenly over the days of its month.

**Estimates and actuals.** For usage an app reports live (tokens, container jobs, Lambda time), the live report is an estimate until that day's real cost arrives from the import. The real figure then replaces the estimate for that Account, app, category and day; it is never added on top. Costs that only come from the import (AppSync, DynamoDB, hosting) appear when the import runs, about a day after they are incurred.

## How apps send usage

Apps send usage to an Amazon SQS queue that Prospectus owns.

1. The app keeps a running tally in memory, per Account, app, deployment and category.
2. About once a minute it sends one message with the tally to the queue: one fast call that never waits on Prospectus. A failed send is retried with the same message.
3. A Prospectus consumer function reads messages up to ten at a time and writes them to the ledger and the quota.
4. If Prospectus is down or busy, messages wait in the queue (retention up to 14 days). Messages that keep failing go to a dead-letter queue, with an alarm.

Each message carries a client-generated operation ID, so a message delivered twice is counted once.

Cost: SQS is about $0.40 per million requests after the first million a month, which are free. At one message per app instance per minute this is pennies a month. EventBridge (about $1 per million events) and the existing signed HTTP route were considered: they cost more and make the app depend on Prospectus being up.

The queue, its dead-letter queue, the consumer and the queue policy are Prospectus infrastructure code. The queue policy lets each registered product's role send, and nothing else, generated from the product registry. Each app's role gains `sqs:SendMessage` on that one queue in its own infrastructure code. Both are new persistent permissions and need the owner's approval when they are built.

The library apps use for this (batching, retries, operation IDs) lives in `packages/accounts-client`, with a Python equivalent for Python apps, so no app writes its own.

**The quota check stays a direct call.** Before starting work an app asks whether the Account is under 100% (`check` in [QUOTA.md](QUOTA.md)). That is a cheap signed read, which the app may cache for a few seconds. Usage reaches the quota about a minute after it happens; the small overshoot that allows is already accepted.

## The quota on real cost

- **Units are microdollars of real cost.** The private price list holds Anthus's actual cost per item (per token, per GB-second, per job), not a marked-up rate.
- **Weekly budget = monthly amount ÷ 4.** A plan names a monthly cost budget, for example $40, and each quota week allows a quarter of it, $10. The monthly amount is a parameter of the plan in the private table and changes without code. The worst case is 52 weeks a year, about $43 a month on average, which the plan's price covers.
- **The week** is unchanged: it starts Saturday at 12:00 noon America/New_York for every Account, and unused budget does not carry over.
- **Costs that accrue without use count.** The daily import charges each Account's attributed costs to the quota week they fall in, so the percentage drops a little each day even when nobody uses the app.
- **Refusal** is unchanged: at 100% new work is refused until the week resets.

## Changes to the built quota

The quota service in `quota/` is built and deployed. These changes bring it to this model:

- Units become microdollars; the rate table's `rates` become cost prices, and a plan's allowance becomes `monthlyBudgetMicrodollars`, with the weekly allowance computed as a quarter of it.
- A new private cost ledger records estimated and actual costs per Account, app, deployment, category and day, separate from the quota week records, and replaces estimates with actuals.
- The quota accepts charges from the daily import and from the queue consumer, in addition to the existing routes.
- `usage` (pay-after recording) moves to the queue. `check` and the reservation routes stay as they are.

## What needs the owner

- Approval of the new permissions when they are built: the queue policy, each app's send permission, and the role the daily import uses in the management account.
- Which AWS account is the Organizations management account, and access for the infrastructure stack that activates the cost tags and runs the import.
- The monthly budget of each plan, and the cost prices in the private table. Neither is ever in this repository.
