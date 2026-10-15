# Synthetic inquiry evaluation runtime

This additive slice is disabled in `evaluation-deployment.json` until the exact new runtime/access scope is approved. The existing CRM and Google authentication do not change.

The proposal deploys through the existing Amplify main pipeline in account `712236451410`, `us-east-1`:

- Node 22 Lambda `prospectus-intake-evaluation`, its retained seven-day log group, and its Lambda-only runtime role of the same name.
- One HTTP API with only `POST /intake/demo`, allowed browser origin `https://prospectus.anth.us`, one request/second with burst two, and Lambda concurrency two.
- The runtime can invoke only `arn:aws:lambda:us-east-1:712236451410:function:prospectus-api`. Its application adapter fixes the intake actor and exposes only the issue operations needed to create/recover a synthetic inquiry. This is a trusted server capability to invoke the existing private API, not an IAM restriction on individual JSON methods.
- S3 `GetObject`/`PutObject` only on `prospectus-records-712236451410/_virtuus/cyclotron/prospectus/intake-identities/*` and `intake-receipts/*`; no listing, deletion, unrelated canonical prefix, or catalog access.
- Log stream creation and event writes only to `/aws/lambda/prospectus-intake-evaluation`. Request bodies, contact data and credentials are not logged.

No Cognito, OAuth, Secrets Manager, IAM administration, invitations, email, billing, new bucket or new table privileges are added. No persistent access keys are created. Runtime credentials come from the normal Lambda role.

The form accepts only made-up `.invalid` contacts. It returns a receipt without private record data. Visitors cannot select a workspace, owner, status, actor or existing issue ID. All accepted inquiries go to the configured existing project and owner `intake-queue`. They remain ordinary Kanbus records visible to authorized CRM staff. Existing member routes still require their JWT and membership.

The Rust sidecar uses the existing pinned Virtuus conditional control-object binding. Per-invocation temporary receipt files are disposable caches; immutable shared claims and canonical inquiry fingerprints provide restart/retry continuity. These controls must be retained across rollback and catalog rebuild. Manual creation/import/email correction do not acquire intake identity claims; this evaluation does not claim global contact uniqueness across all possible writers.

Approval of this scope enables synthetic evaluation, not real-contact acquisition. Real capture still needs an operating owner, privacy/retention and abuse policy, writer reconciliation, and real-cloud failure acceptance. No booking, notifications, account provisioning or financial service is implied.

Rollback disables this additive intake route/output and restores the prior frontend. Accepted records and shared controls are preserved; they are not purged automatically.
