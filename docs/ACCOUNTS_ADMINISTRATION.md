# Central Accounts administration

Accounts has two independent read surfaces. **My memberships** lists only the signed-in person's active organization memberships. **Account administration** lists central organizations, their product entitlements and memberships for an explicitly approved operator. Operator access does not create a membership, enable a product, authorize CRM use, or allow any mutation.

The deployment-owned `accounts/operator-grants.json` policy ships as an empty array. No operator access is activated by this implementation. A grant must name exactly one registered product, Cognito issuer and verified subject, the permission `accounts:admin:read`, and a reviewed approval ID. Email addresses and generic CRM `admin` groups are never permission sources. Grant records are validated at runtime startup and copied to prevent later mutation. The canonical Person and current nonce-confirmed Google session must still resolve before any operator read.

A synthetic policy entry is:

```json
{
  "product": "prospectus-directory",
  "issuer": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic",
  "subject": "synthetic-operator-subject",
  "permission": "accounts:admin:read",
  "reviewedGrantId": "synthetic-approval-v1"
}
```

Before activation, have the intended operator confirm their exact Google profile and review the verified issuer/subject mapping privately. Obtain explicit approval to read all central organizations, entitlements and memberships. Do not copy real identity details into public documentation or infer the intended identity from an email address or CRM role. The existing Google-only registration, issuer/client/subject, nonce, authentication age and login-family checks remain mandatory. Removal of the policy entry denies subsequent operator requests without editing organization memberships.

The BFF routes are `GET /api/saas/operator/accounts` and `GET /api/saas/operator/accounts/{id}`. They forward to registered IAM-protected paths under `/v1/account-directory/operator/accounts`. Existing approved IAM read paths cover them; no role, resource policy or storage grant is added. Request JSON cannot supply a grant, identity or account role. Both endpoints are read-only and return no-store responses.

List reads retain the existing fail-closed discovery budget of 256 canonical account files. Larger installations require a separately designed pagination/index strategy; exceeding the budget is an error, never a partial success. Production identities and customer data are not used in tests. Persisted and browser tests exercise synthetic organizations through the actual pinned Virtuus adapter and the BFF.
