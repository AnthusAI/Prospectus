# Architecture

Prospectus runs in AWS account `712236451410` (papyrus-production), region `us-east-1`. The scope is pinned in `infra/lib/scope.ts` and the deployment guard rejects any other account, region, domain, repository, Amplify app (`d15sc1sptohtqb`) or branch (`main`).

## Components

| Component | Where | Purpose |
| --- | --- | --- |
| CRM frontend | `src/`, built by Vite, served by Amplify | Shared Kanbus board UI, Accounts views, intake form |
| Anthus One portal | `portal/`, `src/portal/`, built to `dist-portal`; hosting in `infra/lib/portal-hosting.ts` (private S3 bucket, CloudFront with Origin Access Control, ACM certificate, Route 53 aliases for `one.anth.us`), published by CDK `BucketDeployment` inside `ampx pipeline-deploy`; committed disabled in `infra/portal-hosting.json` | Customer account portal, a separate application from the CRM |
| Kanbus API | `prospectus-api` Lambda (`provided.al2023`), HTTP API route `/cyclotron/prospectus/api/{proxy+}` | Multi-board Kanbus issue API (board from the path) over S3 files and a DynamoDB catalog |
| Cognito pool and browser client | `infra/lib/prospectus-backend.ts` | Google-only sign-in for the CRM; groups `prospectus-members` and `admin` |
| Accounts BFF | `prospectus-accounts-directory-bff` Lambda, HTTP API route `/api/saas/{proxy+}` | Browser-facing account routes, JWT protected; signs central requests |
| Central accounts service | `prospectus-central-accounts` Lambda behind the IAM-protected `prospectus-accounts` REST API, stage `api` | Identity, accounts, memberships, entitlements, operator directory |
| Inquiry intake | `prospectus-intake-evaluation` Lambda behind its own HTTP API, route `POST /intake/demo` and one `POST /intake/waitlist/<formId>` route per enabled registry form | Public inquiry and app waitlist capture into the CRM |
| Accounts client SDK | `packages/accounts-client` | Browser, React and server clients for hosts |
| Native bridge | `local-dependencies/intake-control` (Rust, `prospectus-identity-files`) | Conditional file writes through pinned Virtuus for identities, accounts and intake controls |

## Storage

All canonical data lives in one private versioned S3 bucket, `prospectus-records-712236451410`, as ordinary files whose paths and bytes are never rewritten by a release.

| Data | Location |
| --- | --- |
| CRM records | `cyclotron/prospectus/` (the namespace name is retained data identity, not a second Cyclotron application) |
| CRM control metadata | `_virtuus/cyclotron/prospectus/` |
| Intake claims, receipts and inbox | `_virtuus/cyclotron/prospectus/intake-identities/` and `intake-receipts/` (inbox items are hashed objects under `intake-receipts/`, distinguished by `kind: "intake-inbox"`) |
| Identities | `prospectus-central/identities/` and `_virtuus/prospectus-central/identities/` |
| Accounts | `prospectus-central/accounts/` and `_virtuus/prospectus-central/accounts/` |

DynamoDB (`CatalogTableName` output) is a supplemental query catalog for the CRM only. It can be rebuilt from the files; nothing consults it for authorization.

Writes that must be conditional go through the Rust bridge using the pinned Virtuus `FileStore`, `JournaledStore` and S3 store. Application code never substitutes its own filesystem writes for that authority. The bridge sends `x-amz-expected-bucket-owner` on every S3 call instead of a HeadBucket check. The two bridge processes live at module scope and survive warm Lambda invocations, restarting only after a bridge failure, child exit or the per-invocation deadline.

## CRM

The Kanbus API requires a verified Cognito JWT from the Google-only browser client and membership in the `kanbus:cyclotron/prospectus` group, which grants that board (Kanbus multi-board grants; no namespace or required-group environment variables). The `prospectus-members` group remains until it is retired. The `admin` group marks application administrators; workspace access still requires membership. Domain configuration (stages, owners, fields) is `config/prospectus.kanbus.yml`; queries and reusable UI come from Kanbus and Virtuus, and Prospectus supplies configuration and interactions only.

## Account model

Decisions recorded by Ryan on 2026-10-17:

- **One account, per-product entitlements.** An account is the one place a customer exists. Its document carries the memberships and a set of product entitlements, so each customer has a single account with a per-product on/off state rather than a separate account per product. An app sees only the accounts entitled to it, and membership in an account entitled to Cyclotron is Cyclotron Lab access.
- **Operators grant products.** Only reviewed operators can turn a product on or off for an account. An account owner cannot self-grant a product. Operator authority comes from `accounts/operator-grants.json` (see [SECURITY.md](SECURITY.md#operator-access)).
- **Roles live in Prospectus.** Each membership has a role of `owner`, `admin`, `member` or `viewer`. Apps own permissions on their own objects, keyed by Prospectus person and account IDs, and never exceed the Prospectus role. A new cross-app role such as editor or publisher is added to Prospectus, not invented in an app.
- **Prospectus is the single account service.** The hosted Papyrus newsroom sites, Cyclotron Lab and Papyrus site cutovers all ask Prospectus for memberships, roles and Lab access. No site keeps its own account or membership tables. Each Papyrus site keeps its own Google project and OAuth client for sign-in only.

### Identity

A Person is keyed by the pair (`https://accounts.google.com`, case-sensitive Google subject), so the same human resolves to one Person across every Cognito pool and Google client that is registered. Cognito `(issuer, sub)` pairs are stored as immutable aliases with their product, IAM principal, app client and reviewed-policy provenance. Email is never an identity key and never an authorization source. Conflicting alias mappings return `409`; people are never merged automatically. Enrollment and sign-in grant no membership, account access or entitlement.

Canonical identity files are under `<scope>/identities/`:

- `google/<tuple-sha256>.json`: the Google key and winning Person, created once so the first writer fixes the Person ID.
- `aliases/<tuple-sha256>.json`: immutable Cognito alias to Google key and Person.
- `people/<UUID>.json`: Person lookup, always verified against the Google file and a completed enrollment.
- `logins/<challengeUUID>.json`: login state (pending for challenges issued before the signed-token rollout, then prepared, committed, conflicted) with a digest of the evidence. A signed challenge creates its file only when first resolved. No raw tokens or email are stored.
- `sessions/<GoogleKey>/<AliasKey>/<challengeUUID>.json`: a pointer to a committed login receipt; a pointer alone never authorizes.

Enrollment is a recoverable multi-file protocol, not an atomic S3 transaction: issue challenge, freeze evidence, create the Google file, create the alias, ensure the Person pointer, publish the session pointer, then commit the login. Only the commit makes the Person usable. Every phase has a stable operation ID so a replay after a crash or lost response converges on the original result. A claim interrupted before canonical publication stays denied until an operator reconciles it; there is no automatic or public reset.

### Accounts

One document per account, `<scope>/accounts/<UUID>.json`, holds account metadata, memberships keyed by Person UUID, entitlements keyed by registered product, an immutable creation fingerprint and a bounded append-only audit. A single conditional write on the whole document commits every authorization change, so there is no second copy that could grant access. Account IDs derive deterministically from the creating Person, product and a caller-retained request UUID, so a retried create after a lost response returns the same account and changed input returns `409`.

Every read and write checks the caller's active membership, role, the product's registered capability and the account's entitlement for that product. Concurrent membership changes use revision compare-and-set and recheck the actor on conflict, so the last owner cannot be removed and a revoked actor cannot publish a stale mutation. Identical repeated membership settings are no-ops.

Limits enforced in `accounts/durable-accounts.ts`: 256 account documents per discovery scan, which `membershipLookup: "indexed"` replaces with per-person membership markers for the person's own listings (exceeding it is a `503` `account_read_budget`, never a partial result), 100 membership entries per account including revoked ones, 128 retained audit entries, and 64 KiB per account document. A strict cross-account quota per person is not enforced.

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

The CRM host exposes JWT-protected routes under `/api/saas`: `GET /accounts`, `GET /accounts/{id}`, `GET /operator/accounts`, `GET /operator/accounts/{id}`, `POST /identity/challenge` and `POST /identity/resolve`. The one exception is `POST /identity/login-challenge`, which has no JWT authorizer because it runs before sign-in (see Sign-in flow). Only the server signs central requests; the browser bundle contains no AWS signing code. POST routes require the configured browser origin. The deployment output `AccountsBffUrl` supplies `VITE_ACCOUNTS_BFF_URL`; without it the Accounts view says the service is not configured instead of showing an empty directory.

The Accounts view exists separately from prospects. Any signed-in person can open it, it never grants CRM access, and it shows distinct states for unknown identity, empty list, loading, unconfigured and failure. There are no demo accounts.

## Sign-in flow

1. The browser generates its login `state` and calls `POST /api/saas/identity/login-challenge` with only `sha256hex(state)`. The BFF forwards the digest to the central service, which returns the challenge ID, the nonce and a signed `challengeToken` that carries the digest. Nothing is stored for the challenge. The nonce goes in the Cognito authorize request together with state, PKCE and `prompt=login`. If this call fails or is throttled the browser starts a plain sign-in with no nonce, and Accounts is confirmed later from the Accounts tab with an authenticated challenge.
2. On callback the BFF verifies the Cognito tokens itself, then posts the challenge token and the raw login `state` with the access and ID tokens as signed headers. The central service hashes the state and rejects a missing or different value with `401 login_state` before the challenge is consumed, so a challenge cannot be used by a browser that did not start it. The authenticated challenge is the same signed token without a digest and rejects any supplied state. Central verifies the token MAC with the signer selected in `accounts/deployment.json` (an HMAC secret in SSM Parameter Store for the Anthus deployment, or a KMS HMAC key), then applies the usual expiry, nonce and binding checks. The first successful resolve creates `logins/<challengeId>.json` with a conditional create, so unresolved challenges never touch S3; stored challenges from before the change still resolve by ID.
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

The route is throttled to one request per second with a burst of two. The Lambda reserves no concurrency, because the account allows 10 concurrent executions in total and AWS keeps them unreserved. Public anth.us is served by the AnthusAI/Anth.us-Papyrus repository, whose engage page is the real-contact form.

### Store first, then file

A visitor's valid message is never lost or rejected because of anything on the CRM side. Only genuine field validation errors (400) reach the visitor. For a valid submission the handler does this:

1. **Store.** It writes the full inquiry (fields, `received_at`, `source`, fingerprint) to an inbox object, `intake-receipts/<sha256(workspace, "inbox", submission_id)>.json`, with the create-first absent-only conditional put, which is the same pattern and the same prefix the intake role already uses. A replay with identical content finds the object and is a no-op. The same `submission_id` with different content (never a visitor action: the form issues a new id whenever content changes) is stored under a second derived key with a derived inquiry id and treated as a new inquiry; it is not rejected. Once the put succeeds the handler answers 202 with the receipt.
2. **File.** It then tries to create or append in the CRM. The identity claim (or the email search) only identifies the prospect: the update is always built from `GET /issues/<id>`, never from a catalog search hit, because a search hit is a catalog result, not the record, and must never be the base of an update. Any failure here (canonical API 409, 500 or timeout, a lost response, claim storage failure, an expired deadline) is swallowed. The inbox item stays `pending` and the log carries only a data-free reason code such as `http_500` or `unconfirmed_Error`.
3. **Review cases.** When the problem is the data, not an outage (`duplicate_contact` catalog matches, `identity_changed`, `history_invalid`, `history_full`, `receipt_conflict`), the handler files a separate prospect labelled `needs-review` carrying the inquiry, `review_reason`, the related prospect when known (`review_related_issue`) and the submitted address in `review_contact_email`. It deliberately has no `contact_email` (so it never joins the identity search or creates a new duplicate) and no `next_action` or `next_follow_up_at` (no follow-up noise). Its create uses an operation id derived from the inquiry id, so retries file it once. The operator merges it into the right prospect and closes it. The inbox item is marked `review` with the issue id.
4. **Reprocess.** `node --import tsx scripts/refile-intake-inbox.ts` (dry run by default; `--apply` files) lists the inbox prefix with the operator's own AWS credentials and retries the `pending` items using the same code, claims and operation ids as live submissions, so it is idempotent. It prints counts only. The intake role has no `s3:ListBucket`, which is why the listing lives in an operator script. A scheduled retry would need new infrastructure and IAM and is not part of this design.

If the inbox itself cannot be written, the handler still tries to file directly and answers 202 only when that succeeds; if both fail it returns 503 so the browser keeps the form and the visitor can retry the same receipt. That is the one case where our side can surface an error, because nothing durable exists.

The inbox object is the durable copy. The Lambda's local ledger remains a disposable per-invocation cache.

Intake sends no email and creates no accounts, invitations, bookings, billing or permissions. Manual creation, import and email edits do not acquire intake claims, so uniqueness holds only among intake writers.

## Integrating an app's waitlist

Other Anthus apps send waitlist signups to Prospectus instead of running their own waitlist backend. A signup is intake: it creates or extends a lead (a `prospect`) and nothing else. It never creates an account, membership, entitlement, invitation, appointment or email, and it is not an Anthus One product access request.

**Registry.** `intake-forms.json` lists the forms. Each entry names its app (`siteId`), `formId`, `kind` (`waitlist`), the `origins` allowed to post it, its own `noticeVersion`, the `owner` queue, a `defaultPagePath`, the `attributes` it accepts (each an enum `values` list or a fully anchored `pattern` that starts with `^` and ends with `$`) and an optional `throttle`. Source identity is decided from the entry that the request path selects and whose `origins` include the request `Origin`; the body can never name a site, form, owner or status. The same file drives the gateway CORS origins, the per-form route and throttle, and the Lambda's origin check, so each origin is accepted only for its own form: a Babulus origin cannot post to `/intake/demo`, and an anth.us origin cannot post a Babulus signup. Origins must be unique across forms and may not be a demo origin. An entry with `"enabled": false` adds no route, origin or configuration. Enabling one needs a recorded `approval` string and the `real-contacts` runtime, and deploys on merge.

**Request.** `POST /intake/waitlist/<formId>` on the intake API (the `IntakeWaitlistBaseUrl` deployment output plus `/<formId>`). Babulus (`babulus-waitlist-v1`) is enabled for `https://babulus.anth.us` only (Ryan's approval is recorded in the entry); other Babulus origins are added by a later reviewed change. Its URL goes live when the change deploys, and real-cloud acceptance is a labelled test signup after that deploy.

```http
POST /intake/waitlist/babulus-waitlist-v1 HTTP/1.1
Host: <IntakeWaitlistBaseUrl host>
Origin: https://babulus.anth.us
Content-Type: application/json

{
  "submission_id": "2f6b7c52-3d1e-4a52-9b0e-6a1a1f0c9d11",
  "email": "casey@example.com",
  "name": "Casey Example",
  "marketing_opt_in": true,
  "notice_version": "babulus-waitlist-v1",
  "page_path": "/waitlist",
  "campaign": { "utm_campaign": "launch" },
  "website": "",
  "attributes": { "persona": "creator", "source": "waitlist-page" }
}
```

Only `submission_id` (a UUID the client generates once per form view and reuses on retry), `email` and `notice_version` are required. `name` is optional (150 characters). `marketing_opt_in` defaults to `false`; Babulus maps its `wantsUpdates` to it. `campaign` accepts `utm_source`, `utm_medium` and `utm_campaign`. `website` is the hidden honeypot field: leave it empty; a filled value gets a success response and nothing is stored. `attributes` accepts only the keys the entry declares. For `babulus-waitlist-v1` they are `persona` (`business`, `agency`, `marketer`, `creator`, `developer` or `other`) and `source` (a lowercase slug of up to 40 characters such as `waitlist-page`). Any other field, or an undeclared or invalid attribute, is a 400. Bodies are JSON, at most 16 KiB.

**Responses.** All are JSON with `cache-control: no-store`. Browsers receive CORS headers from the gateway for the union of enabled form origins.

| Status | Body | Meaning |
| --- | --- | --- |
| `202` | `{"receipt":"2f6b7c52-3d1e-4a52-9b0e-6a1a1f0c9d11","message":"Waitlist signup received."}` | Stored, already on the list, or honeypot. A repeat signup for the same email on the same app returns the same response and stores nothing new, so the response never reveals whether an address was already registered |
| `400` | `{"message":"Invalid persona."}` and similar | Validation: bad email, stale notice (`Reload the page to read the current privacy notice.`), unknown field, invalid attribute, size or JSON |
| `403` | `{"message":"This form origin is not allowed."}` | The Origin is not in this form's `origins` |
| `404` | `{"message":"Not found."}` | Unknown form or method |
| `415` | `{"message":"A JSON submission is required."}` | Content type is not `application/json` |
| `429` | `{"message":"Too Many Requests"}` | The form's own route throttle (default 1 request per second, burst 2) |
| `503` | `{"message":"The inquiry could not be confirmed. Retry the same receipt."}` | Only when neither the inbox nor the CRM could take the inquiry. Retry with the same `submission_id` and body. A `409` is no longer returned: a reused `submission_id` with different content is stored as a new inquiry |

```js
await fetch(`${WAITLIST_BASE_URL}/babulus-waitlist-v1`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ submission_id, email, name, marketing_opt_in: wantsUpdates, notice_version: "babulus-waitlist-v1", attributes: { persona, source: "waitlist-page" }, website: "" }),
});
```

**How it lands.** Identity is the normalized email within the workspace, as for demo intake, so a signup from a person who already exists resolves to the same prospect and appends a `kind: "waitlist"` inquiry with its `source` (`site_id`, `form_id`, `page_path`, `campaign`), `attributes`, `marketing_opt_in` and `received_at`. A new person gets a prospect in the `new` stage, assigned to the form's owner (`intake-queue`), titled with the name or else the email, and labelled `waitlist` and `app-<siteId>`; existing prospects gain missing labels and keep their stage, owner, notes, next action and follow-up. Waitlist signups set no `next_action` or `next_follow_up_at`, so the follow-up queue is not flooded. Deduplication is per email and app: a repeat signup from the same app is dropped when its `marketing_opt_in` and `notice_version` match the latest waitlist inquiry for that app (name and attribute changes alone are not stored). When either differs, the new inquiry is appended, so the latest consent choice is recorded and earlier consent stays in the history; no follow-up is added. Another app may still add its own inquiry. Receipt and identity claims use the existing `intake-receipts/` and `intake-identities/` prefixes and the same create-first pattern, so the intake role gains no permission and still has no `s3:ListBucket`. There is no localhost origin in the registry because it is a public endpoint; develop against the handler and service tests (`test/waitlist-intake.test.ts`).

## Infrastructure layout

- `amplify/` is the Amplify Gen2 entry; `infra/` holds the CDK constructs and checks that Amplify synthesizes. `amplify/verify-scope.mjs` enforces the deployment scope. There is one Amplify app; the portal is part of its CDK deployment, not a second app.
- `infra/lib/prospectus-backend.ts`: bucket, catalog table, Cognito, API, optional console client and the Accounts plane.
- `infra/lib/accounts-plane.ts`: additive Accounts resources only; no CRM role, client, namespace or authorizer is changed. Regression tests compare every pre-existing CRM resource before and after enabling Accounts.
- `infra/lib/evaluation-intake.ts`: the intake Lambda, role, API and throttling.
- `accounts/build-deployment.ts` and `scripts/build-accounts-linux.sh` package the Node 24 handlers and the Linux x86_64 native bridge.
