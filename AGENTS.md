# Prospectus development

This repository is public and MIT licensed. The deployed CRM is private to invited members. Never commit real customer records, credentials, tokens or local data. Keep deployment credentials in the approved platform configuration.

Use Kanbus for development tracking and preserve issue IDs. The operational CRM configuration is `config/prospectus.kanbus.yml`; the root `.kanbus.yml` is the development board. Change issue state with Kanbus commands, not direct JSON edits.

Keep backend queries and reusable UI in Kanbus/Virtuus. Prospectus supplies domain configuration and application interactions. All canonical cloud data remains ordinary Kanbus files in S3 with unchanged paths and bytes; DynamoDB is only a supplemental catalog.

Write behavior specifications before implementation and verify real API persistence, authorization and revision conflicts. Preserve isolated branches and use pull requests for review; merge into `main` only with direction. Pin Kanbus/Virtuus source revisions for CI. Never deploy from a moving dependency branch.

The replacement CRM destination is prospectus.anth.us in papyrus-production account 712236451410, using the main deployment branch. The obsolete dedicated deployment and its exclusive backend/data were removed after accepted central access and explicit deletion confirmation. Preserve the central application and shared resources. New persistent IAM or security resources require concrete approval. No manual site-content sync as the routine publication path.
