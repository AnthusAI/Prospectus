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

Unknown fields, missing reviews, non-`papyrus-` product names and roles shared with any other registration are refused at synthesis and at runtime. The central Lambda reads the same bundled file, so the registry does not grow its environment. At most 40 sites fit inside the API Gateway access policy limit; `infra/test/accounts-plane.test.ts` checks the deployed size.

## What a site may call

Identity challenge, resolve and `/v1/identities/me`; account list, detail and authorize; and the account directory, which lists every product on each of the person's own accounts. Sites cannot create accounts or change memberships. Each site's own runtime role also needs `execute-api:Invoke` on these routes in its own account.

## Deployment

Cloud threads have no AWS access. Deploy from Ryan's M1 Mac through the normal Prospectus pipeline after review.
