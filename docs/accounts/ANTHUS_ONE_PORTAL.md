# Anthus One: the customer account portal

Status: the application exists; hosting is infrastructure as code and committed disabled (see "Hosting").

## What it is

Anthus One is one place, at `one.anth.us`, where a customer has one account for every Anthus system: Papyrus sites, Cyclotron Lab and whatever comes next. Customers sign up, sign in, create and manage accounts, manage members, and launch into the products their account has. It is a customer-facing application, separate from the Prospectus CRM, which is for Anthus staff.

## What exists today

The CRM web app (`src/`) carries a first, partial customer view that should not live there:

- `src/AccountsView.tsx`: the "My memberships" list and account detail, shown on the CRM's Accounts tab.
- `src/accounts-client.ts`: the browser client for the `/api/saas` backend-for-frontend.
- The "View SaaS accounts" button on the CRM's "Workspace access pending" screen and the `?view=accounts` entry in `src/App.tsx`.
- `docs/accounts/ACCOUNTS_UI_SLICE.md`, which describes that slice.

The operator directory in `src/AccountsView.tsx` (all accounts, entitlements, memberships for an approved operator, shown under Account administration) is staff tooling and stays in the CRM.

The backend that Anthus One needs mostly exists: `accounts/` implements people keyed on Google subject, accounts, memberships with roles owner, admin, member and viewer, per-product entitlements, the read directory, the BFF (`accounts/bff.ts`, routes under `/api/saas`), the membership index (PR 18) and Papyrus site registration (`accounts/papyrus-sites.json`). `packages/accounts-client` already offers browser and server clients, including `create(name, requestKey)`.

## Decisions already made that this design follows

- Prospectus is the single account service. Anthus One has no account or membership tables of its own.
- Prospectus owns membership and role. Each product owns permissions on its own objects, never exceeding the Prospectus role.
- Only reviewed operators turn products on or off for an account. Account owners cannot self-grant.
- Each site keeps its own Google project and OAuth client for sign-in. Cloud threads get no AWS access; AWS work runs on Ryan's Mac.

## Proposed design

### Where it lives

Decided 2026-10-19: the portal lives in the Prospectus repository as a separate application, not in a separate repository. It has its own entry page (`portal/index.html`), its own code (`src/portal/`), its own Vite config (`vite.portal.config.ts`) and its own bundle (`dist-portal/`), and it is served at `one.anth.us`, never inside the staff console at prospectus.anth.us. It shares only the account service, the sign-in helpers and the Anthus One design tokens (`src/shared/`, `src/styles.css`). `test/portal-separation.test.ts` fails if portal code reaches staff console code or the reverse. The earlier `AnthusAI/Anthus-One` repository and its shell pull request are superseded.

Local development: `npm run dev:portal` serves it at http://localhost:5421 against the deployed backend with real Google sign-in. Hosting is infrastructure as code in the Prospectus CDK backend, not a second Amplify app and not a manual setup (see "Hosting" below). It is committed dark: `infra/portal-hosting.json` is `{"enabled": false}` until a reviewed change turns it on. Sign-in no longer shares the CRM's Cognito client (kanbus-73f7b2, see Sign-in). `npm run verify:bundles` (CI, after `npm run build`) fails if either bundle contains the other application's modules.

### Hosting

Decided 2026-10-20 (Ryan: nothing is manually configured, everything is infrastructure as code). `one.anth.us` is served by the same `ampx pipeline-deploy` that deploys the backend. `infra/lib/portal-hosting.ts` (construct `PortalHosting`, instantiated by `ProspectusBackend` when the flag is on) creates:

- a private S3 bucket `anthus-one-portal-712236451410` (block public access, S3-managed encryption, TLS only, versioning, retained, 90-day noncurrent expiry);
- a CloudFront distribution that reads it through Origin Access Control, redirects HTTP to HTTPS, requires TLS 1.2 or later and serves HTTP/2 and HTTP/3, over IPv4 and IPv6;
- single-page-app fallback by a viewer-request CloudFront Function: paths under `/assets/` and files with a known static extension pass through, everything else (`/auth/callback`, `/workspaces/acme`, `/people/ada.lovelace`) serves `index.html` with 200. A missing asset is a real 404 (S3's 403 for a missing key is presented as 404 with a `404.html` page);
- caching: `assets/*` (hashed names) is `public, max-age=31536000, immutable`; `index.html` and other unhashed files are `no-cache` and the distribution revalidates them on every request, and a deploy also invalidates `/index.html` and `/`;
- the response headers policy below;
- an ACM certificate for `one.anth.us` in us-east-1, DNS-validated in the existing `anth.us` hosted zone `Z04979341DPRV5BDQNZMG` (imported by ID and name; the zone is never created or modified apart from records);
- Route 53 `A` and `AAAA` alias records `one.anth.us` pointing at the distribution.

Publishing is part of the same deployment: the build step `infra/scripts/build-portal-if-enabled.mjs` builds `dist-portal` in the backend phase, and two CDK `BucketDeployment`s upload hashed assets first and `index.html` last, then invalidate `/index.html` and `/`. They use one Lambda with a named role `anthus-one-portal-publish` that can read the CDK asset bucket, write the portal bucket and create CloudFront invalidations (CDK cannot narrow `cloudfront:CreateInvalidation` below `*`). Nothing is uploaded by hand and no GitHub connection or second Amplify app exists. Old hashed assets are kept (`prune` off) so that open tabs keep working; they are tiny.

The portal's runtime configuration is supplied at build time. `infra/scripts/write-portal-env.mjs` turns `infra/portal-app.json` into `VITE_*` variables; `build-portal-if-enabled.mjs` moves them to `.env.portal.local` and builds with `--mode portal`, so the portal bundle never reads the CRM's `.env.production.local`. Which values are in `portal-app.json` (Cognito client or Google client ID, BFF URL) is the sign-in change's business, not the hosting's. The content security policy takes the accounts API origin from the stack itself.

Response headers (`anthus-one-portal-security`): a content security policy with `default-src 'none'`, `script-src 'self' https://accounts.google.com/gsi/client`, `style-src 'self' https://accounts.google.com/gsi/style`, `frame-src https://accounts.google.com/gsi/`, `connect-src 'self'`, the accounts API origin and `https://accounts.google.com/gsi/`, `img-src 'self' data:`, `font-src 'self'`, `form-action 'self'`, `base-uri 'none'`, `object-src 'none'`, `frame-ancestors 'none'`, no `unsafe-inline` or `unsafe-eval`; HSTS for one year with subdomains; `X-Content-Type-Options: nosniff`; `X-Frame-Options: DENY`; `Referrer-Policy: strict-origin-when-cross-origin`; `Permissions-Policy` denying camera, microphone, geolocation, payment and usb; `Cross-Origin-Opener-Policy: same-origin-allow-popups` (Google Identity Services opens its sign-in in a popup). The policy allows Google Identity Services, not the Cognito hosted-UI token exchange; a sign-in method that needs another origin adds it through `extraConnectSources`. The portal's own sign-in is implemented (see Sign-in), so the flag may be turned on once the portal API's `AnthusOneBffUrl` is recorded in `infra/portal-app.json`; the policy's `connect-src` takes that API's origin, not the CRM's.

Turning it on is a separate reviewed change: set `infra/portal-hosting.json` to `{"enabled": true}`. The first deploy after that creates the certificate (validation takes a few minutes), the distribution (about 5 to 15 minutes) and the DNS names. Check `npm run synth:portal:review --prefix infra` first.

### Sign-in

Decided 2026-10-20 (Ryan, kanbus-73f7b2): the portal signs in with Google directly, using Google Identity Services and its own Google OAuth client (`712526614578-dp3o0ofrukf7h2qcjst345t033mi990c`). It has no Cognito pool, domain or app client (the earlier interim, a shared CRM client, and the earlier recommendation, its own pool, are both superseded). The browser holds a Google ID token whose nonce is a server-issued challenge and sends it to the portal's own accounts API, which verifies it against Google's published keys and serves only customer routes. The portal registers with Prospectus as the `anthus-one` product (`google-direct-v1` policy, reviewed ID `anthus-one-google-direct-v1-20261020`), so the Person is the same one the CRM, Papyrus sites and Cyclotron Lab resolve: a Person is keyed by the Google subject, not by any pool's `sub`. There is no server-issued session; the Google ID token (about an hour, renewed through GIS) is the session. Design, invariants that changed and Google console settings: [ARCHITECTURE.md](../ARCHITECTURE.md#anthus-one-sign-in-google-directly), [SECURITY.md](../SECURITY.md#anthus-one-google-directly-no-cognito) and [OPERATIONS.md](../OPERATIONS.md#anthus-one-portal-sign-in). Origins `https://one.anth.us` and `http://localhost:5421` are no longer CRM origins.

### Backend

The portal is a static single-page app that talks to a small BFF for customers, the customer counterpart of `accounts/bff.ts`. It lives in the Prospectus repository next to the staff routes, authorizes only the signed-in person's own accounts, and forwards to the existing IAM-protected account service. Operator routes are not exposed to the portal.

New customer-facing capabilities, all added to Prospectus and not to the portal:

1. Self-service account creation (`create(name, requestKey)` exists; needs a customer BFF route).
2. Member management: list, change role, remove, for owners and admins (`members:read` and `members:write` exist; needs routes and last-owner protection).
3. Invitations by email, accepted by signing in with the invited Google identity, granting only the invited role (builds on kanbus-b2ddb42a, no implied product permissions).
4. A product registry with launch URLs and display names, so the portal can show "open Cyclotron Lab" or "open this Papyrus site" only for products the account has.
5. Product access requests: an owner of an account without a product asks for it, and the request lands in the CRM intake for an operator to review and grant. Owners never self-grant.

### What the portal shows

- Signed out: a short landing page explaining Anthus One, with "Continue with Google".
- First sign-in, no accounts: "Create your account" or "Wait for an invitation".
- Account switcher (the `AccountSwitcher` from the accounts client package).
- Per account: products available with launch links, members and roles, invitations, and account settings.
- Account closure and billing stay out until their policy issues (kanbus-d5f5f570, kanbus-05fc671e) are decided.

### What moves out of the CRM

After the portal covers the same ground: delete `AccountsView.tsx`, the customer half of `accounts-client.ts`, the "View SaaS accounts" button and the `?view=accounts` handling; keep the operator directory on the admin Accounts page, shown only to operators. Link the pending-access screen to `one.anth.us`.

## Sequence

1. Create the repo and a deployed shell at `one.anth.us` with Google sign-in (needs Ryan's Mac for AWS and DNS).
2. Customer BFF read routes plus the account list, switcher and detail views (feature parity with what the CRM tab does now).
3. Self-service account creation.
4. Member management.
5. Product registry and launch links, starting with Cyclotron Lab and the p.apyr.us site.
6. Invitations, after contact intake works end to end (existing priority order).
7. Product access requests into CRM intake.
8. Remove the customer Accounts view from the CRM.

## Decisions for Ryan

1. Repository. Decided 2026-10-19: the Prospectus repository, as a separate application.
2. Sign-in. Decided 2026-10-20: its own Google OAuth client, signing in with Google directly and no Cognito pool (see Sign-in).
3. Operator-only Accounts tab stays in the CRM. Recommendation: yes.
4. Public repository. Recommendation: public and MIT like the CRM.
5. Who may create a new account: anyone with a Google sign-in, or only after an operator approves. Recommendation: anyone may create an empty account with no products; products stay operator-granted.
