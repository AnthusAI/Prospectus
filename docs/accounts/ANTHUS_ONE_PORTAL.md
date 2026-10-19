# Anthus One: the customer account portal

Status: proposal for review. No code or infrastructure is changed by this document.

## What it is

Anthus One is one place, at `1.anth.us`, where a customer has one account for every Anthus system: Papyrus sites, Cyclotron Lab and whatever comes next. Customers sign up, sign in, create and manage accounts, manage members, and launch into the products their account has. It is a customer-facing application, separate from the Prospectus CRM, which is for Anthus staff.

## What exists today

The CRM web app (`src/`) carries a first, partial customer view that should not live there:

- `src/AccountsView.tsx`: the "My memberships" list and account detail, shown on the CRM's Accounts tab.
- `src/accounts-client.ts`: the browser client for the `/api/saas` backend-for-frontend.
- The "View SaaS accounts" button on the CRM's "Workspace access pending" screen and the `?view=accounts` entry in `src/App.tsx`.
- `docs/accounts/ACCOUNTS_UI_SLICE.md`, which describes that slice.

`src/OperatorAccountsView.tsx` (all organizations, entitlements, memberships for an approved operator) is staff tooling and stays in the CRM.

The backend that Anthus One needs mostly exists: `accounts/` implements people keyed on Google subject, accounts, memberships with roles owner, admin, member and viewer, per-product entitlements, the read directory, the BFF (`accounts/bff.ts`, routes under `/api/saas`), the membership index (PR 18) and Papyrus site registration (`accounts/papyrus-sites.json`). `packages/accounts-client` already offers browser and server clients, including `create(name, requestKey)`.

## Decisions already made that this design follows

- Prospectus is the single account service. Anthus One has no account or membership tables of its own.
- Prospectus owns membership and role. Each product owns permissions on its own objects, never exceeding the Prospectus role.
- Only reviewed operators turn products on or off for an account. Account owners cannot self-grant.
- Each site keeps its own Google project and OAuth client for sign-in. Cloud threads get no AWS access; AWS work runs on Ryan's Mac.

## Proposed design

### Where it lives

A new repository, `AnthusAI/Anthus-One` (name to be confirmed), deployed as its own Amplify app in papyrus-production with `1.anth.us` as its domain. It is not a route inside Prospectus and shares no build with it. Same stack as the CRM (Vite, React, TypeScript) so `@anthus/prospectus-accounts-client` and the Kanbus UI components are reusable. Public repository question: the CRM is MIT and public; the portal can be too, since it holds no secrets.

### Sign-in

Google only, through its own Cognito user pool and its own Google OAuth client, following the pattern already used for `p.apyr.us`. The portal registers with Prospectus as a product (`anthus-one`) through reviewed configuration, the same way Papyrus sites do in `accounts/papyrus-sites.json`, so the canonical person is the same across the portal, Papyrus sites, Cyclotron Lab and the CRM. Creating the pool, the Google client and the registration needs AWS work on Ryan's Mac.

### Backend

The portal is a static single-page app that talks to a small BFF for customers, the customer counterpart of `accounts/bff.ts`. It lives in the Prospectus repository next to the staff routes, authorizes only the signed-in person's own accounts, and forwards to the existing IAM-protected account service. Operator routes are not exposed to the portal.

New customer-facing capabilities, all added to Prospectus and not to the portal:

1. Self-service organization creation (`create(name, requestKey)` exists; needs a customer BFF route).
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

After the portal covers the same ground: delete `AccountsView.tsx`, the customer half of `accounts-client.ts`, the "View SaaS accounts" button and the `?view=accounts` handling; keep `OperatorAccountsView` under an Accounts tab shown only to operators. Link the pending-access screen to `1.anth.us`.

## Sequence

1. Create the repo and a deployed shell at `1.anth.us` with Google sign-in (needs Ryan's Mac for AWS and DNS).
2. Customer BFF read routes plus the account list, switcher and detail views (feature parity with what the CRM tab does now).
3. Self-service account creation.
4. Member management.
5. Product registry and launch links, starting with Cyclotron Lab and the p.apyr.us site.
6. Invitations, after contact intake works end to end (existing priority order).
7. Product access requests into CRM intake.
8. Remove the customer Accounts view from the CRM.

## Decisions for Ryan

1. Repository name. Recommendation: `AnthusAI/Anthus-One`.
2. Own Cognito pool and Google OAuth client for the portal. Recommendation: yes, matching the per-site rule.
3. Operator-only Accounts tab stays in the CRM. Recommendation: yes.
4. Public repository. Recommendation: public and MIT like the CRM.
5. Who may create a new organization: anyone with a Google sign-in, or only after an operator approves. Recommendation: anyone may create an empty organization with no products; products stay operator-granted.
