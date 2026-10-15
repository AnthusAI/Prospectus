# Current deployment boundary

The shared CRM runs at https://prospectus.anth.us/ through Amplify app `d15sc1sptohtqb/main` in account `712236451410`, us-east-1. Google authentication, app administrator/workspace membership continuity and actual user access are accepted. Source `13155d7` is the previous verified rollback checkpoint.

The current release reconciles the inquiry MVP, contact/next-action improvements and shared board parity. The separately owned Accounts integration is not assumed active. Generic private API routes retain verified JWT/member access; no Cognito/OAuth/secret changes are needed by the CRM UI.

Hosted synthetic intake has its own exact additive proposal in [EVALUATION_INTAKE_REVIEW.md](EVALUATION_INTAKE_REVIEW.md). Its flag is disabled pending that approval. This is normal repository-owned IaC; it does not require a new account bootstrap or manual role setup in the console.

The old Cyclotron custom hostname is retired and default hosting redirects to central Prospectus. Full removal of its verified exclusive resources is requested separately. Exact deletion targets await action-time confirmation; central/shared resources and credentials are excluded.
