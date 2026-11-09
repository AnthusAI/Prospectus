# @anthus/cost-accounting

Cost accounting for every Anthus app. The model is Prospectus `docs/COST_ACCOUNTING.md`. This package gives each app two things, so no app writes its own and nobody configures anything by hand.

## Tag every resource

```ts
import { applyCostTags, assertCostTags } from "@anthus/cost-accounting/cdk";

// In the stack: one Papyrus site. Prospectus finds the owning Account itself, so no customer ID goes in code.
applyCostTags(stack, { account: "owner", app: "papyrus", deployment: config.siteId });

// A stack that serves many customers. Its cost is split by the usage the app reports.
applyCostTags(sharedStack, { account: "shared", app: "cyclotron" });

// In CI, on the synthesized template: fails on any costed resource without the tags.
assertCostTags(Template.fromStack(stack).toJSON());
```

This adds `anthus:account`, `anthus:app`, `anthus:deployment` (when given) and `anthus:cost-key` to every taggable resource in the scope. Prospectus imports each day's cost from Cost Explorer by `anthus:cost-key`.

## Send usage

Record what each customer used as it happens. Send quantities only, never dollars: Prospectus prices them privately.

```ts
import { UsageSender } from "@anthus/cost-accounting/usage";

// PROSPECTUS_USAGE_QUEUE_URL is set by the app's own infrastructure (see below).
const usage = new UsageSender({ product: "papyrus-dataparade", app: "papyrus", deployment: "dataparade" });

usage.record(accountId, [
  { itemKind: "openai.tokens.input", quantity: response.usage.input_tokens },
  { itemKind: "openai.tokens.output", quantity: response.usage.output_tokens },
]);
```

- **Long-running process:** call `usage.start()` once. It sends about once a minute. Call `await usage.stop()` on shutdown.
- **Lambda or Amplify compute:** call `await usage.flush()` before the invocation ends. A frozen process loses whatever is only in memory.

`record` is synchronous and never touches the network. A failed send is kept and retried with the same operation ID, so Prospectus counts it once. Each product sends only to its own queue, `prospectus-usage-<product>`, in the Prospectus account. The app's own infrastructure code grants its runtime role `sqs:SendMessage` on that one queue and sets `PROSPECTUS_USAGE_QUEUE_URL` to it (`usageQueueUrl(product, prospectusAccount)` builds it). The sender refuses a URL for any other product's queue. No account ID is built into this package.

Item kinds are namespaced and must exist in the Prospectus price list (for example `openai.tokens.input`, `openai.tokens.output`, `jev.tokens`, `aws.lambda.gb_seconds`). An unknown kind is refused and shows up in the Prospectus refusal log; it is never free.

## Distribution

Build with `npm run build` and vendor the packed tarball (`npm pack`), as apps do with `@anthus/prospectus-accounts-client`. `aws-cdk-lib`, `constructs` and `@aws-sdk/client-sqs` are optional peer dependencies: install only what the entry point you use needs.
