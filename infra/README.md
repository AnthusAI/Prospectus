# Prospectus Amplify delivery

Target: `prospectus.anth.us`, account `712236451410`, region `us-east-1`, Amplify app `d15sc1sptohtqb`, branch `main`. The deployment guard rejects another target. Cyclotron lab consumes this central service; it does not require its own Prospectus deployment.

The existing Amplify service role and standard CDKToolkit bootstrap deploy the backend and static frontend. Keep the reviewed pinned Debian Node build image and `infra/hosting-settings.json`, including the SPA rewrite and disabled legacy CLI overrides. The repository's `amplify.yml` packages the pinned Linux API, synthesizes/deploys the backend and builds frontend configuration from Amplify outputs.

The Kanbus API remains pinned independently from the shared UI package. Canonical data stays in the existing versioned, private S3 bucket and ordinary namespace; DynamoDB remains a supplemental catalog. Do not rewrite canonical paths or delete data during a UI release.

`npm run check --prefix infra` and `npm run check:amplify --prefix infra` validate templates and the actual standard Gen2 assembly. Tests protect JWT/member authorization, Google-first federation, CORS write headers, private storage and existing runtime access. [Synthetic evaluation](EVALUATION_INTAKE_REVIEW.md) is an additive disabled proposal until its exact new role/runtime scope is approved.

The old dedicated Cyclotron app is retired through reversible hosting/DNS operations. Its old backend resources remain intact, with private rollback evidence maintained outside this public repository. Do not use old proof-branch or DNS setup artifacts to recreate a second CRM.
