# Papyrus site registrations

Prospectus is the single account service for the hosted Papyrus newsroom, Cyclotron Lab and the Papyrus site cutovers (Ryan, 2026-10-17). Each Papyrus site keeps its own Google project and OAuth client, signs editors in through a Google-only Cognito client, and asks Prospectus which accounts a person belongs to and with which role. No site keeps account or membership tables. Membership in a cyclotron account is Cyclotron Lab access.

Tracking: Kanbus `kanbus-2755969c` here, Papyrus `PPY-58f107`.

## Adding a site

Add one reviewed entry to `accounts/papyrus-sites.json`:

```json
{
  "product": "papyrus-<site>",
  "roleArn": "arn:aws:iam::<account>:role/<site server runtime role>",
  "issuer": "https://cognito-idp.us-east-1.amazonaws.com/<Google-only pool>",
  "clientId": "<Cognito app client>",
  "federationReviewId": "<reviewed Google-only, unlinked policy ID>",
  "siteReviewId": "<reviewed site registration ID>"
}
```

Unknown fields, missing reviews, non-`papyrus-` product names and roles shared with any other registration are refused at synthesis and at runtime. The central Lambda reads the same bundled file, so the registry does not grow its environment. The registry holds at most 40 sites, but the API Gateway access policy limit (8192 characters) is reached sooner with the real Amplify role names (about 95 characters each): with the other registrations and the lab verifier enabled, twenty deployed-length sites fit and twenty-four do not. `infra/test/accounts-plane.test.ts` checks that size.

### Public-reader sites

A site whose readers are the general public (no account membership) adds `"audience": "public-reader"` to its entry. The only other value is absence. A public reader signs in with Google through the site's Google-only client and gets a pairwise site subject (never the Person ID; see below) that the site uses for a public handle, votes, ratings, comments and karma; Prospectus never gives the site a name or email to publish. The registration has no capabilities and no account directory, so the site can run the identity challenge, resolve and `/v1/identities/me` and nothing about accounts: the account list is empty, account detail, authorize and directory calls are refused, and the lab verifier does not trust its tokens. Shipped (`papyrus-shipped`) is the first, registered 2026-10-21 on Ryan's decision ("yes, Prospectus for public readers; you do the registration"), who also approved its reviews (`papyrus-shipped-google-only-unlinked-v1-2026-10-21`, `papyrus-shipped-site-v1-2026-10-21`).

### What a reader site receives

A reader site never receives the Prospectus Person ID. It receives `siteSubject`, a stable identifier for that person on that site only: `ss1_` followed by 43 base64url characters (`^ss1_[A-Za-z0-9_-]{43}$`). The same person gets an unrelated subject on every other site. Use it as the reader's key; do not try to decode it. See [SECURITY.md](../SECURITY.md#public-reader-site-subjects) for the derivation and the secret.

| Call | Editor sites (unchanged) | Reader sites |
| --- | --- | --- |
| `POST /v1/identities/google/resolve` | `{"person": {"id", "createdAt"}}` | `{"person": {"siteSubject"}}` |
| `GET /v1/identities/me` | `{"person": {"id", "createdAt"} or null}` | `{"person": {"siteSubject"} or null}` |
| `GET /v1/accounts` | `{"person": {"id", "createdAt"} or null, "accounts": [...]}` | `{"person": {"siteSubject"} or null, "accounts": []}` |
| `POST /v1/identities/google/challenge` | unchanged | unchanged (no person) |
| `GET /v1/accounts/site-subjects/retired` | `403 reader_route_forbidden` | see below |

`siteSubject` is the only person field. `createdAt` is withheld because it is the same on every site and would link the subjects, and Prospectus has no display name or email to give. Errors carry only `error` and `message`. If the central secret is unavailable every reader call returns `503 identity_unavailable`; retry later, and never fall back to anything else.

Before this change (PR #79) a reader site received the editor shape, `{"person": {"id", "createdAt"}}`. Anything a reader site stored under a Person ID must be re-keyed: sign the reader in again and store the new `siteSubject`.

#### Retired subjects

When Prospectus deletes or merges a Person, each reader site the person used gets a retirement record. Poll:

```
GET /v1/accounts/site-subjects/retired?since=<cursor>
```

`since` is optional (omit it the first time). The response lists only the calling site's own records, oldest first, at most 100:

```json
{
  "retired": [
    { "siteSubject": "ss1_...", "reason": "deleted", "retiredAt": "2026-10-21T14:00:00Z" },
    { "siteSubject": "ss1_...", "reason": "merged", "survivingSiteSubject": "ss1_...", "retiredAt": "2026-10-21T14:00:00Z" }
  ],
  "cursor": "<opaque>",
  "more": false
}
```

Store `cursor` and send it as `since` next time; while `more` is true, call again at once. On `deleted`, drop the data held for that subject. On `merged`, move it to `survivingSiteSubject`, the surviving person's subject on your site (whether or not they have signed in there yet). The same subject may appear twice, so apply each record as "ensure dropped" or "ensure remapped". `retiredAt` is the start of the hour the retirement was recorded, and an hour is listed only once it has ended, so a record can take a little over an hour to appear. Only `since` is accepted; any other query parameter or a malformed cursor returns `400`.

The site's existing `execute-api:Invoke` grant on `GET/v1/accounts/*` already covers this route. Prospectus does not delete or merge Persons yet, so the list stays empty until it does.

## What a site may call

Identity challenge, resolve and `/v1/identities/me`; account list, detail and authorize; and the account directory, which lists every product on each of the person's own accounts. Reader sites also call `GET /v1/accounts/site-subjects/retired`. It falls under the existing `GET/v1/accounts/*` entry, so neither the API access policy nor the site's own `execute-api:Invoke` grant changes, and the central handler refuses it to everyone but reader sites. Sites cannot create accounts or change memberships. Each site's own runtime role also needs `execute-api:Invoke` on these routes in its own account.

## Cyclotron lab verification

Cyclotron Lab accepts a Papyrus editor's token because Prospectus verifies it for the lab. Each Papyrus site's Next server forwards the editor's Cognito access token to the lab BFF (`cyclotron-console-bff`). The lab assumes `arn:aws:iam::682849160744:role/cyclotron-lab-verifier` and calls `GET /v1/identities/me` and then `POST /v1/accounts/{account}/authorize` with that token in `X-Prospectus-Human-Token`. Prospectus accepts the token only when its `iss` and `client_id` equal a site in `accounts/papyrus-sites.json`; adding a site here is all it takes for the lab to accept that site, and removing one stops the lab accepting it, with no list in the lab.

- **Who the person is.** The person the site enrolled (the site must have completed its identity challenge for that login). A person the site never enrolled gets `{"person": null}` and nothing else.
- **What authorize decides.** Whether the account has the `cyclotron` product active and the person is an active member. The Papyrus site's own entitlement is irrelevant; a Papyrus editor has exactly the Cyclotron capabilities their Prospectus membership role gives: `console:read` for viewers, `console:read` and `console:write` for members, admins and owners. `members:read` and `members:write` are refused for every role.
- **What the lab gets.** `{allowed, accountId, personId, product: "cyclotron", role, operation, revision}` for an allowed operation, and one identical `403 forbidden` for anything else. The lab must require `accountId` to equal its `X-Cyclotron-Account` pin and re-check immediately before each effect.
- **What it cannot do.** Everything else: challenge, resolve, account list, detail and creation, memberships, the directory and operator routes. It cannot look up another person or account.

## Deployment

Cloud threads have no AWS access. Deploy from Ryan's M1 Mac through the normal Prospectus pipeline after review.
