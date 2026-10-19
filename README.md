# Prospectus

MIT-licensed Anthus AI Solutions CRM and central account service. The CRM is built on the same exported Kanbus board used by the standalone console and embedded hosts, so a prospect keeps one issue identity from sales through customer-success follow-up. The shared application runs at https://prospectus.anth.us/ in the papyrus-production AWS account, deployed from `main` through Amplify.

Prospectus does two jobs:

- **CRM.** Configured sales stages, board and list search, owners and dated next actions, contact correction, conversation notes, due follow-ups, customer-success handoff, and a public inquiry intake endpoint. Google sign-in plus explicit workspace membership protect private CRM requests; signing in alone grants no staff access.
- **Account service.** One central service holds people, organization accounts, memberships with roles, and per-product entitlements for the hosted Papyrus newsroom sites and Cyclotron Lab. Products sign people in with their own Google clients and then ask Prospectus which accounts the person belongs to.

Canonical records are ordinary Kanbus and JSON files in a private S3 bucket. DynamoDB holds only rebuildable query metadata and is never authority.

## Documents

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data model, the account model decision, identity and account APIs, storage, intake |
| [docs/SECURITY.md](docs/SECURITY.md) | Authentication and authorization rules, the Google sign-in secret, operator grants, data handling, known limits |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Deployment, activation flags, verification, rollback, tracking, dated proof history |
| [docs/accounts/PAPYRUS_SITES.md](docs/accounts/PAPYRUS_SITES.md) | Registering a Papyrus site with the account service |
| [packages/accounts-client/README.md](packages/accounts-client/README.md) | The browser, React and server SDK for hosts |
| [AGENTS.md](AGENTS.md) | Rules for people and agents changing this repository |

Behavior specifications live in `features/` and `accounts/*.feature`.

## Development

```sh
node infra/scripts/checkout-kanbus.mjs
npm ci --prefix .build/kanbus-ui/packages/ui
npm run build --prefix .build/kanbus-ui/packages/ui
npm ci
npm ci --prefix packages/accounts-client
npm run lint
npm run typecheck
npm test
npm run build
```

`source-lock.json` pins the shared Kanbus UI, the Kanbus API and the API's Virtuus dependency independently. The checkout helper refuses dirty or mismatched checkouts. Do not substitute a moving branch or edit shared source inside this application.

Tests that exercise the native identity and account files need the Rust bridge: `npm run build:identity-files` (requires the Rust toolchain named in `scripts/build-identity-files.sh`). Infrastructure checks: `npm ci --prefix infra && npm run check --prefix infra`. See [OPERATIONS.md](docs/OPERATIONS.md#verification) for the full list.

### Local preview

Build `kanbus-api-local` from the API pin, set `KANBUS_API_BINARY` to that executable, then run `npm run preview:local` for a loopback-only synthetic form and workspace. Local credentials and records stay in the ignored `local-data/` directory. For an explicitly chosen private LAN review set `PROSPECTUS_LAN_ADDRESS` and run `npm run preview:lan`. Use made-up names and messages and `.invalid` addresses only.

## Tracking

Development work is tracked in Kanbus under `project/`, configured by the root `.kanbus.yml`. Change issue state with Kanbus commands, never by editing issue JSON. The operational CRM board configuration is `config/prospectus.kanbus.yml`.
