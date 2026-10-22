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

A site whose readers are the general public (no account membership) adds `"audience": "public-reader"` to its entry. The only other value is absence. A public reader signs in with Google through the site's Google-only client and gets a Prospectus person identity that the site uses for a public handle, votes, ratings, comments and karma; Prospectus never gives the site a name or email to publish. The registration has no capabilities and no account directory, so the site can run the identity challenge, resolve and `/v1/identities/me` and nothing about accounts: the account list is empty, account detail, authorize and directory calls are refused, and the lab verifier does not trust its tokens. Shipped (`papyrus-shipped`) is the first, registered 2026-10-21 on Ryan's decision ("yes, Prospectus for public readers; you do the registration"), who also approved its reviews (`papyrus-shipped-google-only-unlinked-v1-2026-10-21`, `papyrus-shipped-site-v1-2026-10-21`).

## What a site may call

Identity challenge, resolve and `/v1/identities/me`; account list, detail and authorize; and the account directory, which lists every product on each of the person's own accounts. Sites cannot create accounts or change memberships. Each site's own runtime role also needs `execute-api:Invoke` on these routes in its own account.

## Cyclotron lab verification

Cyclotron Lab accepts a Papyrus editor's token because Prospectus verifies it for the lab. Each Papyrus site's Next server forwards the editor's Cognito access token to the lab BFF (`cyclotron-console-bff`). The lab assumes `arn:aws:iam::682849160744:role/cyclotron-lab-verifier` and calls `GET /v1/identities/me` and then `POST /v1/accounts/{account}/authorize` with that token in `X-Prospectus-Human-Token`. Prospectus accepts the token only when its `iss` and `client_id` equal a site in `accounts/papyrus-sites.json`; adding a site here is all it takes for the lab to accept that site, and removing one stops the lab accepting it, with no list in the lab.

- **Who the person is.** The person the site enrolled (the site must have completed its identity challenge for that login). A person the site never enrolled gets `{"person": null}` and nothing else.
- **What authorize decides.** Whether the account has the `cyclotron` product active and the person is an active member. The Papyrus site's own entitlement is irrelevant; a Papyrus editor has exactly the Cyclotron capabilities their Prospectus membership role gives: `console:read` for viewers, `console:read` and `console:write` for members, admins and owners. `members:read` and `members:write` are refused for every role.
- **What the lab gets.** `{allowed, accountId, personId, product: "cyclotron", role, operation, revision}` for an allowed operation, and one identical `403 forbidden` for anything else. The lab must require `accountId` to equal its `X-Cyclotron-Account` pin and re-check immediately before each effect.
- **What it cannot do.** Everything else: challenge, resolve, account list, detail and creation, memberships, the directory and operator routes. It cannot look up another person or account.

## Deployment

Cloud threads have no AWS access. Deploy from Ryan's M1 Mac through the normal Prospectus pipeline after review.
