# Prospectus account integration (local prototype)

This package shares account types/client behavior and the optional React selector.
It does not own a product database or authorize product work in the browser. React 18.3.1 and 19 are supported. React and the server SDK modules are optional peers: browser-only installations do not install the AWS credential chain. Hosts using `/react` supply React; Node hosts using `/server` install the pinned server peers:

```sh
npm install @aws-sdk/credential-provider-node@3.972.86 @smithy/signature-v4@5.7.4 @smithy/protocol-http@5.6.2 @aws-crypto/sha256-js@5.2.0
```

```tsx
import { browserAccountsClient } from '@anthus/prospectus-accounts-client';
import { AccountSwitcher } from '@anthus/prospectus-accounts-client/react';
```

The browser client defaults to the host BFF prefix `/api/prospectus`; requests include `/v1/...`. The host must verify its session, protect mutations from CSRF, then invoke the central service. `AccountSwitcher` receives `accounts`, `selectedAccountId`, `onSelect`, optional `disabled` and `error`. Unknown selection resets to the blank option. Selection is only a preference; the backend authorizes each selected account and operation. The selector inherits the host's form styling and can sit inside `.kb-theme-organizer`.

```ts
import { serverAccountsClient } from '@anthus/prospectus-accounts-client/server';
const accounts = serverAccountsClient({
  endpoint: process.env.PROSPECTUS_ACCOUNTS_URL!, // HTTPS REST base including /api stage
  region: 'us-east-1',
  humanToken: () => verifiedSession.accessToken,
});
const visible = await accounts.list();
await accounts.authorize(selectedAccountId, 'console:write');
```

The server entry uses the AWS SDK default credential provider, requiring a temporary session token. It signs for `execute-api`, including the human token and mutation request key in SigV4. No shared API key, manual credentials, IAM user keys or assume-role hop is required. Do not import `/server` into a browser bundle. The central runtime role registry and API Gateway resource policy must explicitly allow the caller role. HTTPS redirects are refused. Never forward an arbitrary browser token as a substitute for your verified session.

`create(name, requestKey)` requires a caller-retained UUID replay key. Keep that key and input unchanged after uncertain responses. Canonical creation replay is persisted with the account document. Fresh canonical identity enrollment uses challenge/resolve with independent access and ID evidence; access-only legacy `resolve()` is not an enrollment shortcut. `list()` can return `{person:null,accounts:[]}` before association; `get(id)` and `authorize(id, operation)` never create memberships. Roles are account-scoped owner/admin/member/viewer; operations are console:read, console:write, members:read, members:write. Product entitlements and runtime scopes further restrict each operation.

Canonical IDs are lowercase UUID-shaped opaque values (Person IDs are random; account creation IDs are deterministic for a replay tuple). A shared Cognito issuer/sub identifies a person across its registered application clients. Email is neither identity nor account authorization. Existing claimed people are never silently merged. Canonical directory-backed legacy linking is denied; cross-authority migration/merging is not implemented.

This client does not bill, charge, send invitations or email, or grant CRM membership. Activation of the central service is controlled by `accounts/deployment.json`; see docs/OPERATIONS.md. See the repository's docs/ARCHITECTURE.md and docs/SECURITY.md. The read-only directory uses directoryList()/directoryDetail(id) and the /directory DTO export; it is available only to explicitly registered directory runtimes and never grants product authorization.
