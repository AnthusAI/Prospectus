# Prospectus

MIT-licensed Anthus CRM built with the same exported Kanbus board used by the standalone console and embedded hosts. Prospects retain one issue identity from sales through customer-success follow-up. The shared application is https://prospectus.anth.us/ in papyrus-production, deployed from `main` through Amplify app `d15sc1sptohtqb`.

The CRM includes configured sales stages, board/list search, owner and dated next actions, contact correction, conversation notes, due follow-ups and customer-success handoff. Google sign-in and explicit workspace membership protect private CRM requests. Signing in alone grants no staff access.

Canonical records remain ordinary Kanbus files in S3 under the existing `cyclotron/prospectus` namespace. DynamoDB contains only rebuildable query metadata. The namespace is retained data identity, not a second Cyclotron application. The old dedicated hosting endpoint is retired; Cyclotron and other products use the central Prospectus service.

## Development and verification

```sh
node infra/scripts/checkout-kanbus.mjs
npm ci --prefix .build/kanbus-ui/packages/ui
npm run build --prefix .build/kanbus-ui/packages/ui
npm ci
npm run build
npm test
```

`source-lock.json` independently pins the shared Kanbus UI and Kanbus API, plus the API's Virtuus dependency. A UI-only release cannot silently replace the deployed API. The checkout helper refuses dirty or mismatched dependency checkouts. Do not substitute a moving branch or modify shared source inside this application.

Build `kanbus-api-local` from the API pin with its declared Rust toolchain. Set `KANBUS_API_BINARY` to that executable, then `npm run preview:local` for a loopback-only synthetic form and workspace. Local credentials and records remain in ignored `local-data/`; never publish them. For an explicitly selected private LAN review, set `PROSPECTUS_LAN_ADDRESS` and use `npm run preview:lan`. Use made-up names/messages and `.invalid` emails only.

`npm run test:intake:integration` uses the actual local API and disposable synthetic data. `npm run test:control-binding` verifies Virtuus conditional control writes and deterministic S3 transport fault cases. Browser acceptance exercises inquiry capture, retries, contact correction, follow-up, customer handoff and shared column collapse. See `features/` for behavior criteria.

## Synthetic inquiry evaluation

The inquiry implementation accepts only `.invalid` contacts. It preserves normalized-email identity, independent receipt IDs, trusted source, separate simulated marketing preference and prior sales state. Repeated deliveries recover the original operation; distinct inquiries append without replacing notes, owner or stage.

Hosted evaluation is additive and disabled until the concrete scope in [the runtime review](infra/EVALUATION_INTAKE_REVIEW.md) is approved. No real-contact intake, outbound email, booking, invitation, account creation, billing or new customer permission follows from submitting a synthetic inquiry. Private records remain accessible only to authorized CRM members.

Shared conditional claims must survive rollback/catalog rebuild. Manual create/import/email-edit paths do not acquire intake claims; this evaluation is not a global uniqueness guarantee across every writer. Real-contact capture requires reviewed privacy/retention, abuse controls, operating ownership and real-cloud failure acceptance.

## Deployment and rollback

Use the existing Amplify main pipeline and standard account bootstrap. No manual content sync or separate branch deployment is needed. Shared-board parity and CRM checks must pass before merging. Prior central checkpoint `13155d7` is a frontend rollback reference; preserve accepted data and intake-control objects when rolling back application code. Full cleanup of the obsolete dedicated deployment is separately scoped to verified old resources; central/shared resources must remain intact.
