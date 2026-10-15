# First Accounts UI deployment slice

Base: deployed Prospectus main13155d7. This frontend increment adds an Accounts tab distinct from prospects/contacts, own-role/product/membership detail rendering, and explicit loading/empty/error/identity-connect/unconfigured states. It grants no access and includes no production demo data.

The existing Amplify outputs currently have no AccountsBffUrl. Until the additive canonical directory/BFF backend is reviewed and activated, the production UI honestly says "The Accounts service has not been configured." It must not pretend an empty backend is a populated organization directory. No IAM/OAuth or data mutation is necessary for this first frontend deployment.

Expected optional frontend setting: VITE_ACCOUNTS_BFF_URL pointing to the JWT-protected /api/saas BFF base. Routes: GET /accounts, GET /accounts/:id; fresh identity confirmation uses POST /identity/challenge and POST /identity/resolve through the BFF. ID evidence is transient and is never persisted in browser session storage. The later backend commit defines membership filtering and only lets account owners/admins see other memberships; a CRM admin group does not imply all-organizations access.

The CRM deployment owner remains the sole integration/deployment writer. Cherry-pick this increment into the reviewed Prospectus main source; do not deploy the older Cyclotron-scoped accounts branch. Current prospect functionality and callback remain in place. No account creation, membership grant, speculative billing or console provisioning UI is included.
