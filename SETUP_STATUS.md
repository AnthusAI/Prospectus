# Setup status

## Prepared

- Public MIT-licensed repository: https://github.com/AnthusAI/Prospectus.
- Separate Amplify app `dnfou6dg4d6x2` in account `682849160744`, region `us-east-1`.
- `proof` development branch, with automatic builds disabled.
- Only `prospectus.cyclotron.anth.us` associated with this app.
- The existing `anth.us` hosted zone is in Legacy account `335163751677`, zone `Z02552332GG6AM25SFP73`. Legacy is used only for DNS.
- Two CREATE-only DNS records were added from `infra/prospectus-dns-change.json`; Route 53 change `C0694425RZ6YOT33OZSK` is INSYNC. Amplify verified the hostname and is pending deployment.
- Cyclotron marketing A/AAAA records retain their existing target `d3huumeyty33dy.cloudfront.net`.

## Pending

The user will create a Google Cloud project and OAuth client. Register this exact redirect in that client:

```text
https://prospectus-cyclotron-682849160744.auth.us-east-1.amazoncognito.com/oauth2/idpresponse
```

Provider credentials belong in the approved account's Secrets Manager, using the secret name and JSON fields documented in `infra/README.md`. Do not place them in this public repository, Vite configuration, browser storage or chat.

The reviewed deployment roles and Google provider resources still need concrete action-time approval. The Amplify app needs its source connection, source pins, backend deployment, frontend build and explicit invited-member admission. No persistent access grant has been provisioned by the source scaffold.

Local browser and real AWS storage/API proofs pass. Final hosted acceptance still requires real Google sign-in followed by create, stage update, customer-success handoff, note and reload at the requested hostname. The hostname is not yet a working deployed CRM.
