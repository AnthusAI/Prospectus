# Tracking

Kanbus board changes are visible in [draft PR #398](https://github.com/AnthusAI/Kanbus/pull/398). Virtuus board changes are visible in [draft PR #32](https://github.com/AnthusAI/Virtuus/pull/32). These draft branches have not been merged into the shared develop boards.

| Work item | Issue ID |
| --- | --- |
| initiative | `kbs-3df9cc93-530f-4614-98a0-aa175012c1b5` |
| embedding epic | `kbs-fbfec688-e9dc-4dfd-8670-cfbc5c26ff80` |
| crm epic | `kbs-3e6ec337-13dd-4caa-971d-938db415c2c5` |
| amplify epic | `kbs-b1c5c2c9-9b1f-4801-97f4-8b7afdb3cfdc` |
| embedding story | `kbs-8e5309d6-0491-4ef4-b9ef-2e96d39d12d9` |
| intake story | `kbs-df1fc256-4f03-48fb-a378-96897c4ad6de` |
| handoff story | `kbs-9727655b-ff0c-450c-95d0-2cf829cfce56` |
| amplify story | `kbs-4f00467d-0d85-4915-8e4d-48558ee077d5` |
| persistence epic | `kbs-151d2330-d5f1-4ded-85c5-2e851f46e38e` |
| portability epic | `kbs-2e5a7e1d-e93d-421e-bbd6-e268d1923e97` |
| shared views story | `kbs-3ab411ac-0db4-45ac-b2f5-c590fce36b7d` |
| backend contract story | `kbs-3bf858c6-38d7-462c-9a5a-c400c3709ee6` |
| publication story | `kbs-e048a6ef-1bed-4680-ae45-80000c5c12e2` |
| tenant query story | `kbs-e29acb9d-727d-4224-b3de-6f2fae5f16a3` |
| snapshot story | `kbs-b2276ee6-7a91-4211-a0db-d806e6f6ae7a` |
| catalog rebuild story | `kbs-047ba6ad-2951-482d-8899-79638468a752` |
| private access story | `kbs-fcd104da-76d6-4303-b2d2-645a4764c2b0` |
| future multi project ui story | `kbs-6bd05d74-cd70-4370-b444-e64cff3c144d` |

Virtuus persistence epic: `virt-d762b00f-32f7-4bb1-8c85-5b7ee5fa53b7`.
Virtuus interoperability story: `virt-d1aa5a17-82df-417c-8353-2d8fcb02e4ef`.
Virtuus live AWS verification task: `virt-bbb22448-25d7-4826-a69b-dae4a66d5a88` (visible in board draft PR #32).
Prospectus development epic: `kanbus-4d64f341-9c13-479b-b2fd-edd409a096f9` (this repository).

Stories contain Given/When/Then acceptance criteria. Technical work remains subordinate. Completion is recorded after the change lands. Google OAuth setup is owned by the user and is pending; source integration does not establish deployed authentication.

Product source is reviewable in [Kanbus draft PR #399](https://github.com/AnthusAI/Kanbus/pull/399) and [Virtuus draft PR #33](https://github.com/AnthusAI/Virtuus/pull/33). `source-lock.json` pins their exact tested commits. No product or board PR has been merged.

The Amplify story `kbs-4f00467d-0d85-4915-8e4d-48558ee077d5` tracks the local return to standard Amplify service-role setup and the existing `CDKToolkit` bootstrap (`hnb659fds`, version 32). Preparation was recorded before coding in comment `ec6563c3`. The forced custom qualifier and bespoke deployment stack are removed from the local source; this local preparation makes no IAM changes or deployment. The proposed service-role policy is `arn:aws:iam::aws:policy/service-role/AmplifyBackendDeployFullAccess`; the owner explicitly authorized standard setup and deployment in message `Sentinel0772ada47d38819189f919bc6b35f75c`. Execution had not occurred at this documentation update. The existing marketing-only bootstrap execution policy is a configuration concern; zero proof deployment jobs at inspection means there is no observed deployment error. Additional permission expansion requires separate approval. The owner is creating the Google project and usable client credentials remain unavailable. This local preparation is not yet pushed and does not change draft PR completion state.
