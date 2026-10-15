# Canonical accounts verification

- `npm test`: frontend/client/auth and27 real-RSA Google identity cases; optional browser fixtures are skipped by default.
- `npm run test:accounts:durable`: builds pinned native Virtuus binding and verifies16 durable account cases plus4 persisted directory/BFF authorization cases.
- `node --import tsx --test accounts/durable-google-identities.test.ts`:29 identity crash/concurrency/recovery cases after building the native binding.
- `PROSPECTUS_ACCOUNTS_UI=1 node --import tsx --test test/accounts-directory-ui.test.ts test/accounts-persisted-ui.test.ts`: actual browser loading/empty/error/owner/member states and persisted canonical BFF data. Synthetic identities/private disposable roots only.
- `npm run build:accounts` and `bash scripts/build-accounts-linux.sh`: bundle Node24 handlers and build pinned Linux x86_64 native bridge. No cloud calls are needed for packaging.
- `npm run synth:accounts:review --prefix infra`: enabled Accounts actual Gen2 offline synthesis. Infra tests compare all pre-existing CRM resources before/after and require them to remain identical.

The old transactional DynamoDB deployment prototype is not carried into this main-based change. Accounts use canonical JSON and Virtuus native revision conditions; DDB remains index-only. `AccountsService`/TransactionStore remain memory-fixture compatibility helpers for regressions, not hosted authority. No tests require real customers, provider secrets or deployment permissions.
