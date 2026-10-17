# Architecture

Prospectus runs in AWS account `712236451410` (papyrus-production), region `us-east-1`. The scope is pinned in `infra/lib/scope.ts` and the deployment guard rejects any other account, region, domain, repository, Amplify app (`d15sc1sptohtqb`) or branch (`main`).

## Components

| Component | Where | Purpose |
| --- | --- | --- |
| CRM frontend | `src/`, built by Vite, served by Amplify | Shared Kanbus board UI, Accounts views, intake form |
| Kanbus API | `prospectus-api` Lambda (`provided.al2023`), HTTP API route `/api/{proxy+}` | Generic Kanbus issue API over S3 files and a DynamoDB catalog |
| Cognito pool and browser client | `infra/lib/prospectus-backend.ts` | Google-only sign-in for the CRM; groups `prospectus-members` and `admin` |
| Accounts BFF | `prospectus-accounts-directory-bff` Lambda, HTTP API route `/api/saas/{proxy+}` | Browser-facing account routes, JWT protected; signs central requests |
| Central accounts service | `prospectus-central-accounts` Lambda behind the IAM-protected `prospectus-accounts` REST API, stage `api` | Identity, accounts, memberships, entitlements, operator directory |
| Inquiry intake | `prospectus-intake-evaluation` Lambda behind its own HTTP API, route `POST /intake/demo` | Public inquiry capture into the CRM |
| Accounts client SDK | `packages/accounts-client` | Browser, React and server clients for hosts |
| Native bridge | `local-dependencies/intake-control` (Rust, `prospectus-identity-files`) | Conditional file writes through pinned Virtuus for identities, accounts and intake controls |

## Storage

All canonical data lives in one private versioned S3 bucket, `prospectus-records-712236451410`, as ordinary files whose paths and bytes are never rewritten by a release.

| Data | Location |
| --- | --- |
| CRM records | `cyclotron/prospectus/` (the namespace name is retained data identity, not a second Cyclotron application) |
| CRM control metadata | `_virtuus/cyclotron/prospectus/` |
| Intake claims and receipts | `_virtuus/cyclotron/prospectus/intake-identities/` and `intake-receipts/` |
| Identities | `prospectus-central/identities/` and `_virtuus/prospectus-central/identities/` |
| Accounts | `prospectus-central/accounts/` and `_virtuus/prospectus-central/accounts/` |

DynamoDB (`CatalogTableName` output) is a supplemental query catalog for the CRM only. It can be rebuilt from the files; nothing consults it for authorization.

Writes that must be conditional go through the Rust bridge using the pinned Virtuus `FileStore`, `JournaledStore` and S3 store. Application code never substitutes its own filesystem writes for that authority.

## CRM

The Kanbus API requires a verified Cognito JWT from the Google-only browser client and membership in the `prospectus-members` group (`KANBUS_REQUIRED_GROUP`). The `admin` group marks application administrators; workspace access still requires membership. Domain configuration (stages, owners, fields) is `config/prospectus.kanbus.yml`; queries and reusable UI come from Kanbus and Virtuus, and Prospectus supplies configuration and interactions only.

## Account model

Decisions recorded by Ryan on 2026-10-17:

- **One account, per-product entitlements.** An account is one organization. Its document carries the memberships and a set of product entitlements, so one organization has a single account with a per-product on/off state rather than a separate account per product. An app sees only the accounts entitled to it, and membership in an account entitled to Cyclotron is Cyclotron Lab access.
- **Operators grant products.** Only reviewed operators can turn a product on or off for an account. An account owner cannot self-grant a product. Operator authority comes from `accounts/operator-grants.json` (see [SECURITY.md](SECURITY.md#operator-access)).
- **Roles live in Prospectus.** Each membership has a role of `owner`, `admin`, `member` or `viewer`. Apps own permissions on their own objects, keyed by Prospectus person and account IDs, and never exceed the Prospectus role. A new cross-app role such as editor or publisher is added to Prospectus, not invented in an app.
- **Prospectus is the single account service.** The hosted Papyrus newsroom sites, Cyclotron Lab and Papyrus site cutovers all ask Prospectus for memberships, roles and Lab access. No site keeps its own account or membership tables. Each Papyrus site keeps its own Google project and OAuth client for sign-in only.

### Identity

A Person is keyed by the pair (`https://accounts.google.com`, case-sensitive Google subject), so the same human resolves to one Person across every Cognito pool and Google client that is registered. Cognito `(issuer, sub)` pairs are stored as immutable aliases with their product, IAM principal, app client and reviewed-policy provenance. Email is never an identity key and never an authorization source. Conflicting alias mappings return `409`; people are never merged automatically. Enrollment and sign-in grant no membership, account access or entitlement.

Canonical identity files are under `<scope>/identities/`:

- `google/<tuple-sha256>.json`: the Google key and winning Person, created once so the first writer fixes the Person ID.
- `aliases/<tuple-sha256>.json`: immutable Cognito alias to Google key and Person.
- `people/<UUID>.json`: Person lookup, always verified against the Google file and a completed enrollment.
- `logins/<challengeUUID>.json`: challenge state (pending, prepared, committed, conflicted) with a digest of the evidence. No raw tokens or email are stored.
- `sessions/<GoogleKey>/<AliasKey>/<challengeUUID>.json`: a pointer to a committed login receipt; a pointer alone never authorizes.

Enrollment is a recoverable multi-file protocol, not an atomic S3 transaction: issue challenge, freeze evidence, create the Google file, create the alias, ensure the Person pointer, publish the session pointer, then commit the login. Only the commit makes the Person usable. Every phase has a stable operation ID so a replay after a crash or lost response converges on the original result. A claim interrupted before canonical publication stays denied until an operator reconciles it; there is no automatic or public reset.

### Accounts

One document per account, `<scope>/accounts/<UUID>.json`, holds account metadata, memberships keyed by Person UUID, entitlements keyed by registered product, an immutable creation fingerprint and a bounded append-only audit. A single conditional write on the whole document commits every authorization change, so there is no second copy that could grant access. Account IDs derive deterministically from the creating Person, product and a caller-retained request UUID, so a retried create after a lost response returns the same account and changed input returns `409`.

Every read and write checks the caller's active membership, role, the product's registered capability and the account's entitlement for that product. Concurrent membership changes use revision compare-and-set and recheck the actor on conflict, so the last owner cannot be removed and a revoked actor cannot publish a stale mutation. Identical repeated membership settings are no-ops.

Limits enforced in `accounts/durable-accounts.ts`: 256 account documents per discovery scan (exceeding it is a `503` `account_read_budget`, never a partial result), 100 membership entries per account including revoked ones, 128 retained audit entries, and 64 KiB per account document. A strict cross-account quota per person is not enforced.

### Products and registrations

Callers are products registered with an IAM role, Cognito issuer, client IDs, capabilities and an optional Google federation policy. The central service selects the registration from the verified API Gateway caller identity.

| Product | Registered by | Capabilities |
| --- | --- | --- |
| `prospectus-directory` | `infra/lib/accounts-plane.ts` (the Accounts BFF role) | `console:read`, `members:read`; flagged `accountDirectory` for cross-product reads |
| `cyclotron` | `infra/lib/accounts-plane.ts` when `pairEnabled` in `accounts/console-deployment.json` | `console:read`, `console:write`; enrolling BFF role plus a paired worker role (`executionDelegation`) |
| `papyrus-<site>` | `accounts/papyrus-sites.json` | `console:read`, `console:write`, `members:read`; see [PAPYRUS_SITES.md](accounts/PAPYRUS_SITES.md) |

The execution delegation pair lets a queue worker continue an already-enrolled human session without a new login. The worker may call only `GET /v1/identities/me` and `POST /v1/accounts/{UUID}/authorize`, with the original human access token in `X-Prospectus-Human-Token`. It cannot enroll, create accounts, change memberships or read the directory. The result of `authorize` is a point-in-time decision, not a lease; the consumer must check immediately before each effect.

### Central service routes

All are reached with SigV4 from a registered role and are restricted by both the caller's IAM policy and the REST API resource policy.

| Method and path | Purpose |
| --- | --- |
| `POST /v1/identities/google/challenge` | Start enrollment; returns a challenge ID and nonce (300 second TTL) |
| `POST /v1/identities/google/resolve` | Verify access and ID evidence for the challenge and return the Person |
| `GET /v1/identities/me` | Continue an enrolled session family; returns `{person:null}` for an unknown alias; never enrolls |
| `GET /v1/accounts`, `GET /v1/accounts/{id}` | The caller's accounts and one account |
| `POST /v1/accounts` | Create an account with the creator as owner; the `Idempotency-Key` header carries the replay UUID. Only the Cyclotron registration's IAM policy permits it |
| `POST /v1/accounts/{id}/memberships` | Set a member's role and status; requires account-scoped `members:write`. No registered caller's IAM policy currently permits this route |
| `POST /v1/accounts/{id}/authorize` | Check `console:read`, `console:write`, `members:read` or `members:write` |
| `GET /v1/account-directory`, `GET /v1/account-directory/{id}` | Read-only view of the caller's accounts across all products, with permitted memberships |
| `GET /v1/account-directory/operator/accounts[/{id}]` | Read-only listing of every account for reviewed operators |

### Browser routes

The CRM host exposes JWT-protected routes under `/api/saas`: `GET /accounts`, `GET /accounts/{id}`, `GET /operator/accounts`, `GET /operator/accounts/{id}`, `POST /identity/challenge` and `POST /identity/resolve`. Only the server signs central requests; the browser bundle contains no AWS signing code. POST routes require the configured browser origin. The deployment output `AccountsBffUrl` supplies `VITE_ACCOUNTS_BFF_URL`; without it the Accounts view says the service is not configured instead of showing an empty directory.

The Accounts view exists separately from prospects. Any signed-in person can open it, it never grants CRM access, and it shows distinct states for unknown identity, empty list, loading, unconfigured and failure. There are no demo organizations.

## Sign-in flow

1. The BFF asks the central service for a challenge and puts its nonce in the Cognito authorize request together with state and PKCE.
2. On callback the BFF verifies the Cognito tokens itself, then posts the challenge ID with the access and ID tokens as signed headers.
3. The central service independently verifies both RS256 tokens against the registered issuer (signature, `iss`, expiry, `aud`, `client_id`, `sub`, `auth_time` at most 300 seconds old, nonce) and requires exactly one Google identity in the ID token. A signed-in session is then continued with `GET /v1/identities/me`.
4. Replaying identical evidence inside the challenge lifetime returns the original Person; changed evidence returns `409`.

The CRM browser client and the Cyclotron console client (`cyclotron-console-public`, callback `https://lab.cyclotron.anth.us/auth/callback`) are separate Google-only Cognito clients on the same pool.

## Inquiry intake

`POST /intake/demo` accepts inquiries from allowed browser origins. The handler validates the origin and notice version, normalizes the email, claims it and a receipt through the immutable control objects, and creates or appends to a Kanbus issue through the `prospectus-api` function with a fixed intake actor and the owner `intake-queue`. Visitors cannot choose a workspace, owner, status, actor or issue ID. Repeated deliveries recover the original operation; distinct inquiries append without replacing notes, owner or stage.

Two modes, selected in `evaluation-deployment.json`:

| Mode | Origins | Accepts | Source tagging |
| --- | --- | --- | --- |
| `synthetic-only` | `https://prospectus.anth.us` | `.invalid` addresses and the demo notice | demo records |
| `real-contacts` | `https://prospectus.anth.us`, `https://anth.us`, `https://www.anth.us` | ordinary addresses and privacy notice `contact-v1` | site `anthus-website`, form `engage-contact-v1` |

The route is throttled to one request per second with a burst of two and Lambda concurrency of two. Public anth.us is served by the AnthusAI/Anth.us-Papyrus repository, whose engage page is the real-contact form.

Intake sends no email and creates no accounts, invitations, bookings, billing or permissions. Manual creation, import and email edits do not acquire intake claims, so uniqueness holds only among intake writers.

## Infrastructure layout

- `amplify/` is the Amplify Gen2 entry; `infra/` holds the CDK constructs and checks that Amplify synthesizes. `amplify/verify-scope.mjs` enforces the deployment scope.
- `infra/lib/prospectus-backend.ts`: bucket, catalog table, Cognito, API, optional console client and the Accounts plane.
- `infra/lib/accounts-plane.ts`: additive Accounts resources only; no CRM role, client, namespace or authorizer is changed. Regression tests compare every pre-existing CRM resource before and after enabling Accounts.
- `infra/lib/evaluation-intake.ts`: the intake Lambda, role, API and throttling.
- `accounts/build-deployment.ts` and `scripts/build-accounts-linux.sh` package the Node 24 handlers and the Linux x86_64 native bridge.
