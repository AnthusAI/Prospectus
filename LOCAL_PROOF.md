# Local persistence proof

On 2026-10-14, two Playwright tests passed against the running filesystem-backed Kanbus REST API, using the actual compiled shared Kanbus UI package. The tests made real requests and verified:

- Anonymous visitors make no CRM record requests; unauthenticated API reads return 401.
- A synthetic prospect is created with company, contact email and follow-up date.
- The same record appears in the salesperson's due follow-ups.
- The prospect advances through new, contacted, qualified, proposal and customer.
- Ownership changes to customer success and a note is saved.
- Reloading and reopening from the customer list retains the issue ID, owner, email and note.
- A direct authenticated API read confirms the final stored values.

`test/browser/prospectus.spec.ts` is the executable proof. Run it with a real local API and `PROSPECTUS_TEST_TOKEN`; no credentials, browser traces or local CRM files are committed. The local screenshot is generated at `test-results/prospectus-local-proof.png`.

TypeScript checking and the production frontend build pass. This local result does not establish deployed Cognito or hosted application acceptance.
