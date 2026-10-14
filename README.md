# Prospectus

MIT-licensed Cyclotron CRM built from Kanbus's configured issue model, shared board/list components, and generic writable API. The deployed workspace is private to invited members. A prospect remains the same issue as it moves through sales stages into customer success. Owners, contact details and follow-up dates are ordinary issue fields and `custom` values.

The canonical cloud project is an ordinary Kanbus folder in S3: the same relative paths and bytes for `.kanbus.yml`, issues, events and attachments. DynamoDB is a supplemental card catalog containing query metadata and references. It never contains canonical issue or history payloads. Copying a project into S3 requires an explicit catalog rebuild; exporting copies the canonical project prefix back to a folder. The filesystem adapter remains available locally and on EFS.

## Local proof

The current development checkout has the Kanbus repository alongside this one. Prepare its shared package, then start the app:

```sh
mkdir -p .build
ln -s ../../kanbus .build/kanbus
npm ci --prefix .build/kanbus/packages/ui
npm run build --prefix .build/kanbus/packages/ui
npm ci
npm run dev
```

Create a separate local data folder and copy `config/prospectus.kanbus.yml` into it as `.kanbus.yml`. Run the generic API from the pinned Kanbus checkout with `KANBUS_BACKEND=file`, `KANBUS_ROOT` set to that folder, `KANBUS_NAMESPACE=cyclotron/prospectus`, `KANBUS_PORT=5418` and a fresh `KANBUS_LOCAL_TOKEN`. The API binds loopback. Enter that token in the local sign-in form at http://127.0.0.1:5417. Local token sign-in is excluded from production builds.

`npm test` exercises the client contract. `npm run build` checks types and produces the static app. For real backend browser verification, set `PROSPECTUS_TEST_TOKEN` to the same local token and run `npm run test:e2e`; the writable test deliberately skips when the real API credentials are absent. No fixture data is bundled into the app.

## Deployment and access

The authorized destination is a separate Amplify app at `prospectus.cyclotron.anth.us` in `cyclotron-production`, AWS account `682849160744`, region `us-east-1`. The new deployment is separate from Cyclotron marketing. Amplify owns backend resources through custom CDK configuration; the application transport remains generic REST. See [infra/README.md](infra/README.md) for the Gen2 build and deployment contract. Source revisions must be pinned before a release build; build success is not deployment verification. Final acceptance requires creating and moving a prospect in the deployed private UI.

Production sign-in uses a dedicated Cognito client with authorization code and PKCE. API Gateway verifies the JWT; the backend additionally requires membership in the configured group. Self-signup and public issue reads are not provided. No shared Cognito arrangement with Papyrus is assumed. Public intake is a separately tracked milestone; the application does not expose an unauthenticated CRM endpoint.

## Tracking and scope

Kanbus initiative `kbs-3df9cc` and [board draft PR #398](https://github.com/AnthusAI/Kanbus/pull/398) contain the cross-project milestones and BDD stories. This repository's `.kanbus.yml` tracks development work; `config/prospectus.kanbus.yml` is the operational CRM configuration. Never use the development issue board as customer data.

Multi-project selection is a future shared Kanbus UI capability. The first Prospectus deployment is scoped to one authorized project. Billing, subscriptions, broad Salesforce parity and Papyrus plugins are outside this milestone.

See [LICENSE](LICENSE) for the MIT license. Customer records and credentials are never part of this public source repository.
