# Intake spam: classify after capture, never reject

Status: design only. Nothing in this document is implemented or deployed. Tracking issue: kanbus-2e713ce2.

## The rule this design serves

A potential client's valid message is always accepted. The visitor always gets "Thanks, we have your note." Spam handling must add no friction for a real visitor: no CAPTCHA, no challenge, no extra field, no slower response, and no different answer for a submission we suspect.

So spam handling only **classifies and labels after the inquiry is durably stored** (see [Store first, then file](ARCHITECTURE.md#store-first-then-file)). It never rejects, never deletes, and never hides a record where it cannot be found again. A false positive must be one click to find and one click to restore.

The rule covers the anth.us contact form (`engage-contact-v1`) and every app waitlist form in `intake-forms.json`.

## What happened

On 2026-10-20 a bot submitted the anth.us engage form. The record is `prsp-2241529c` (personal data is not copied here). Its features:

| Field | What it looked like |
| --- | --- |
| Name | One 22-character token with no space, mixed case with 6 lower-to-upper switches, an 11-letter run without a vowel, vowel share 0.23 |
| Email | A `gmail.com` address whose 21-character local part has 8 dots, splitting it into nine segments of one or two characters, ending in digits |
| Company | A random six-letter stem followed by a legal suffix (`LLC`) |
| Message | Exactly the four prefilled prompts with nothing typed after any of them, plus the "Came from" line the page adds |
| Links | None |
| Honeypot | Empty: the bot did not fill the hidden `website` field |

It reached the CRM as a `needs-review` prospect with reason `identity_changed`. That reason came from the intake identity bug fixed in #75 (an unfiltered identity lookup bound new emails to an existing prospect), not from anything spam-related. Without that bug it would have been filed as an ordinary prospect with a follow-up date for the next business day.

This is the well-known 2024 to 2026 random-string form-spam campaign seen on WordPress, Webflow, HubSpot and Keap forms: random mixed-case strings in name or company, a real-looking free-mail address (often a Gmail dot variant), and no links. The bots run a real browser, so they skip hidden honeypot fields, and they carry no link, so link filters miss them.

## Design in one paragraph

After the inbox write succeeds, intake runs a pure, local scoring function over the inquiry. It returns a score from 0 to 1, a verdict (`clean`, `uncertain` or `likely_spam`) and named reason codes. The result is stored on the inbox item and on the inquiry inside the prospect. A `likely_spam` inquiry is filed as a normal prospect with the label `likely-spam` and no follow-up date, so it stays out of Today and is hidden by default in the pipeline, behind a visible "N hidden as likely spam" control. Ryan confirms with **Spam** or restores with **Not spam**. Each click is recorded as a correction. Corrections tune the rules through reviewed changes. Optionally, and only after a privacy decision, `uncertain` inquiries can be sent to a Cyclotron (Jev underneath), which learns from the same corrections. The visitor's response never changes.

## Layer 1: deterministic heuristics

All rules are local string checks. They need no network, no paid service and no new AWS resource. They run in microseconds.

Each rule has a code, a weight, and an evaluation on the 2026-10-20 example. The combined score is a noisy-OR, `1 - Π(1 - weight)` over the rules that fire, so it stays between 0 and 1 and no single weak rule can reach the label threshold.

| Code | Fires when | Weight | Strength | False-positive risk | Example |
| --- | --- | --- | --- | --- | --- |
| `gibberish_name` | A Latin-script token of 12 or more characters with no space has 3 or more lower-to-upper switches inside it, and either its vowel share is below 0.25 or it has a run of 6 or more consonants | 0.55 | Strong | Low with these guards. McDonald, DeAndre, O'Neil, Krzysztof, Szczepański, Xu Zhengqi and Nguyen all have at most 1 switch and runs of 4 or less. Non-Latin scripts and tokens under 12 characters never fire | Fires (6 switches, run 11, vowels 0.23) |
| `gibberish_company` | The same test on the company field | 0.35 | Strong | Low, as above. Brand names like "PayPal" have 1 switch | Does not fire (the stem is 6 characters) |
| `template_only_message` | The message, after removing the four prompt labels, the "Came from" line and any solution the page filled in from the link, has fewer than 3 letters left | 0.40 | Strong | Medium on its own: a real person can press send without typing. That is why it is not enough alone | Fires (nothing left) |
| `markup_or_links` | BBCode `[url=`, an HTML `<a href`, or 3 or more URLs in the message | 0.55 | Strong | Low for a B2B form. One URL (often the sender's own site) never fires | Does not fire |
| `seo_solicitation` | Fixed phrases such as "backlinks", "guest post", "rank your website", "SEO services", "increase your traffic" | 0.30 | Medium | Medium: a real client may ask about SEO. Never enough alone | Does not fire |
| `gmail_dot_scatter` | A `gmail.com` or `googlemail.com` local part with 4 or more dots, or a dot share of 0.25 or more, or 3 or more one-character segments | 0.20 | Medium | Medium. Real people write first.m.last (2 dots). Gmail ignores dots, so heavy scattering is a bot signature, but it is only medium alone. Other domains (including Google Workspace) never fire | Fires (8 dots, share 0.38, 6 one-character segments) |
| `random_company_stem` | A company of one short stem plus a legal suffix (LLC, Ltd, Inc, GmbH) where the stem scores below a character-bigram threshold | 0.10 | Weak | High for non-English company names, so the weight is tiny | Likely fires under a bigram model; the simple case and consonant tests do not fire |
| `honeypot` | The hidden `website` field is filled | 0.90 | Strong | Low (`autocomplete="off"`, `tabindex="-1"`, hidden). Not zero: some autofill and accessibility tools fill hidden fields | Does not fire (the bot evaded it) |
| `fast_submit` | The page reports the form was submitted less than 1.5 seconds after the script loaded (needs `elapsed_ms`, below) | 0.20 | Weak | Medium on waitlists, where autofill can complete a one-field form in about a second | Not available (no timing today) |
| `repeat_variant` | The normalized email (lowercase; `googlemail.com` mapped to `gmail.com`; dots and `+tag` removed for Gmail only) was seen in the last 24 hours with a different exact address or a different name | 0.40 | Strong | Low for different names; a person retyping their own address with different dots is possible, so not enough alone | Not evaluated (no stored normalized key today) |
| `disposable_domain` | The domain is on the CC0 `disposable-email-domains` list, vendored into the repo with its version | 0.15 | Weak | Medium: privacy-minded real people use these | Does not fire |

Signals deliberately given **zero weight**: short names (Li, Ng, Bo), non-Latin scripts, all-lowercase or all-uppercase names, digits at the end of an address, free-mail domains, the visitor's country or language, and raw IP repeats (offices share addresses behind NAT).

**Protection for real visitors.** If the message has 40 or more letters of the visitor's own text (after removing the template) and `markup_or_links` and `honeypot` do not fire, the verdict can be at most `uncertain`. A real person with an unusual name who writes a real note is never labelled.

**Thresholds** (to be confirmed in shadow mode):

| Verdict | Score | Also required |
| --- | --- | --- |
| `likely_spam` | 0.70 or more | At least two reasons, at least one of them strong |
| `uncertain` | 0.30 to 0.70, or capped by the protection above | |
| `clean` | below 0.30 | |

**The example:** `gibberish_name` (0.55), `template_only_message` (0.40) and `gmail_dot_scatter` (0.20) fire. Score `1 - 0.45 × 0.60 × 0.80 = 0.78`, three reasons, two strong: `likely_spam`. Any two of the three strong signals would have been enough; Gmail dots alone (0.20) or a template-only message alone (0.40) would not.

The rule table lives in `config/intake-spam-rules.json` with a `rules_version`. Changing a weight or threshold is a reviewed change that bumps the version. Every stored result names the version that produced it.

### Two small input additions

- **Submission timing.** The engage script and app waitlists send an optional integer `elapsed_ms`: the time from script load to submit, capped at one day. Today `submission_id` is generated at the first submit attempt in the engage script, not at render, so it carries no render time. `validateSubmission` rejects unknown fields with a 400, so the server must accept the optional field **before** any form sends it, and an absent or invalid value is "unknown", never a reason. The value is unsigned and a bot can fake it, so it stays weak. A signed server timestamp would need a token endpoint, which is a new request on the visitor's path and is not proposed.
- **Repeat key.** Intake writes one more create-first control object per inquiry, `intake-receipts/<sha256(workspace, "spam-normalized", normalized_email)>.json`, holding only a count, the last `received_at` and a hash of the last exact address and name. It uses the prefix and pattern the intake role already has, so IAM does not change. It feeds `repeat_variant`.

### The honeypot today drops data

`Intake.submit` returns success and stores nothing when `website` is filled. Under the rule above a filled honeypot is a strong signal, not a reason to discard: a real visitor whose browser filled the hidden field loses their message and we never know. This design stores the inquiry in the inbox and files it like any `likely_spam` inquiry with reason `honeypot`. This is a behaviour change for Ryan to approve (decision 4). The visitor's response is unchanged.

## Where it runs

Inside `Intake.submit`, after `inbox.capture` succeeds and before filing:

1. Capture the inbox item exactly as today. The 202 depends only on this.
2. Call `scoreInquiry(inquiry, rules)`. It is a pure function in `server/intake-spam.ts`, wrapped so any exception becomes `{verdict: "unscored", reasons: ["scorer_error"]}` and filing continues as if clean.
3. Store the result on the inbox item with the existing conditional `mark` (best effort, like `status`).
4. File the prospect. `likely_spam` changes only the create or append body: add the `likely-spam` label and leave out `next_action` and `next_follow_up_at`.

There is no new Lambda, queue, schedule, table or IAM statement. The added CPU is negligible. The same function scores existing inbox items and records offline through an operator script, `scripts/score-intake-inbox.ts`, run with the operator's own credentials and printing counts and reason codes only, like `refile-intake-inbox.ts`.

Waitlists use the same scorer. They have no message, so only the name, company, email, honeypot, timing and repeat rules apply. Waitlist signups already have no follow-up date. The label keeps likely spam out of any launch announcement drawn from waitlist opt-ins.

## What is stored

On each inquiry (in the inbox item and in `custom.inquiries[]`):

```json
"spam_check": {
  "version": 1,
  "rules_version": "intake-spam-rules-1",
  "checked_at": "2026-10-21T12:00:00.000Z",
  "mode": "shadow",
  "score": 0.78,
  "verdict": "likely_spam",
  "reasons": ["gibberish_name", "template_only_message", "gmail_dot_scatter"],
  "evidence": {"gibberish_name": {"length": 22, "case_switches": 6, "longest_consonant_run": 11}, "gmail_dot_scatter": {"dots": 8}},
  "model": null
}
```

`evidence` holds counts and lengths only, never the text it measured. When a decision model is used (layer 2), `model` holds `{"provider": "cyclotron", "decision_id", "model_identity", "cyclotron_version", "label", "confidence", "decided_at"}`.

On the prospect, `custom.spam_status` (the latest inquiry's verdict, for list filtering) and, after a correction, `custom.spam_review`:

```json
"spam_review": {"label": "not_spam", "reviewer": "<actor id>", "at": "2026-10-22T09:00:00.000Z", "inquiry_id": "<id>", "rules_version": "intake-spam-rules-1", "note": "Real person, unusual name."}
```

The reason codes and verdict may also go to logs, because they carry no contact data. The scorer never logs input text.

A later inquiry that scores `clean` on a prospect labelled `likely-spam` gets a follow-up date as usual and the prospect's `spam_status` becomes `clean`. The label stays until a person resolves it, so the earlier inquiry is still shown for review. A new message from a real person is never held back by an old label.

## In the CRM

- **Pipeline:** prospects labelled `likely-spam` or `spam` are hidden by default. A visible line, "3 hidden as likely spam. Show", reveals them. This is a filter on labels through the existing Kanbus list query, not a new store.
- **Today:** unchanged. Likely spam has no follow-up date, so it never appears.
- **Prospect detail:** a badge "Likely spam" with the reasons in plain words ("Name looks machine-generated", "Message is only the form's prompts", "Gmail address with scattered dots"), the score and the rules version.
- **Not spam:** removes `likely-spam`, sets `next_action` to "Respond to demo request" and `next_follow_up_at` to the next business day (the values intake would have set), and records `spam_review` with `not_spam`.
- **Spam:** replaces `likely-spam` with `spam`, moves the prospect to Closed (`lost`), and records `spam_review` with `spam`. Nothing is deleted. Deletion stays the existing manual privacy process.
- **Mark as spam** on any clean prospect does the same, so missed spam becomes a correction too.

Each button is one revisioned update through the Kanbus API, and a revision conflict is shown, not overwritten. Prospectus adds these application interactions. The badge and the label filter should be reusable Kanbus/Virtuus UI.

## Learning from corrections

Every **Spam** and **Not spam** click is a label on one inquiry with the rules version that scored it. That is the training and correction data.

**Without a model (recommended first, free).** `scripts/spam-corrections.ts`, an operator script, collects `(evidence, reasons, score, label)` from records with `spam_review`, with no names, addresses or message text. It reports precision and recall per rule and per threshold. When there are enough labels (about 30 of each kind), it fits a logistic regression over the rule features and proposes new weights. A person reviews the proposal and commits it as a new `rules_version`. The rules learn, but only through a reviewed change, and every past result stays explainable by its version.

**With Cyclotron (optional, see below).** The same click also sends the label to the Cyclotron as `feedback`. The Cyclotron refits its ML head on trusted labels and its optimizer can propose a rubric or a supporting question, promoted only when its evaluation accepts it.

## Layer 2 (optional): a Jev decision through Cyclotron

### What Jev and Cyclotron are

- **Jev** is TypeSafe AI's hosted "System One" decision model. One request carries the text and a set of typed questions (choice, yes/no, score), and Jev answers each with a value and a confidence. Endpoint `https://api.typesafe.ai/v1/systemone`, SDK `typesafe-sdk`. Current versions: `jev-1.13.0` (stable, alias `jev-latest`) and `jev-1.14.0` (alias `jev-preview`). The weights are shared by every account. Jev cannot be fine-tuned and TypeSafe says it is not trained on customer requests. (Cyclotron `README.md` and `src/decision_flywheel/adapters/jev.py`; TypeSafe models page; the anth.us article "Fine-tuning Jev". The anth.us "OpenAI Decisions API preview" article calls Jev "Anthus's own decision model"; the code and the other articles say it is TypeSafe's.)
- **Cyclotron** (`AnthusAI/Cyclotron`, Python package `decision_flywheel`) wraps a decision model such as Jev with an evolving rubric, a fixed few-shot example list, supporting questions whose answers become features, and a small ML head that gives a calibrated confidence. Human labels drive the refit and the optimizer. "One AI decision that learns from your team's corrections." The hosted lab is `lab.cyclotron.anth.us` (stack `cyclotron-console`, Cyclotron AWS account 682849160744).

### How Prospectus would call it

The hosted lab already has a service-to-service route (Cyclotron `docs/hosted-publications.md`, "Machine access"):

- `POST /machine/publications/{publication}/operations` and `GET /machine/publications/{publication}/commands/{jobId}`, AWS IAM (SigV4) authorization, contract `cyclotron-publication/v1`.
- `decide`: payload `{bindingRevision, item: {id, values}}`. Returns **202 with a job id**. The caller polls the command until it completes. Only one job may be pending per run (`409 run_busy`).
- `feedback`: payload `{bindingRevision, itemId, itemRevision, output, label, comment?, editor: {site, subject}}`. Synchronous. It records a human label with the machine role and the asserted editor as provenance.
- A machine can only `decide`, `status` and `feedback` for a configured **standing** target. Standing runs register each submitted item in the run's catalog and cap items at `maxItems` (default 500).

The `cyclotron-lab-verifier` role is not involved: it verifies Papyrus editors' bearer tokens for the human curation routes. The machine route needs a different pair of roles:

- In the Cyclotron account, `cyclotron-machine-invoker`, assumable by exactly one caller role ARN (stack parameter `MachineCallerRoleArn`, one value today).
- In papyrus-production (712236451410), a new Prospectus caller role allowed `sts:AssumeRole` on that invoker only.

So layer 2 needs: a new IAM role in this account (new persistent IAM, needs concrete approval), a reviewed Cyclotron stack change to accept a second caller (the parameter is a single ARN), a reviewed publication target for a standing `prospectus-intake-spam` run with `CYCLOTRON_ALLOW_LIVE=true`, and an asynchronous step on our side. The intake Lambda must not wait for a queued job on the visitor's path, and a scheduled retry is new infrastructure. The cheapest first step is an operator script that sends `uncertain` inbox items and polls, run by hand like `refile-intake-inbox.ts`.

Embedding the `decision_flywheel` library inside the intake Lambda instead is not proposed. The intake runtime is TypeScript, the library is Python, it keeps state in SQLite or S3 stores, and it would need the TypeSafe key in this account.

### Cost and latency

- Jev: $0.042 per million input tokens, output free (TypeSafe models page). A request with a few questions averaged about 500 input tokens in the Jev-Flywheel study, so one decision costs about **$0.00002**. Cyclotron's own procedures use "about 0.00005 USD per call". 1,000 uncertain inquiries a month would cost about 2 to 5 cents.
- The optimizer, when learning runs, is the larger cost: about 4 to 11 cents per study run in Cyclotron's setup findings. With a handful of corrections a month it would rarely run.
- Hosted Jev answers in about a quarter of a second ("Distilling Jev into a classifier"). Through the lab it is a queued job, so expect seconds. That is fine because nothing waits on it.
- The real costs are not the calls. They are the new IAM role, the Cyclotron change, the privacy decision, and keeping one more cross-account dependency working.

### What layer 2 adds

The heuristics catch random-string bots. They do not catch fluent, AI-written solicitations ("We offer SEO and web design services…"), which read like a real inquiry. Those need the message's meaning, so layer 2 is only useful if the message text is sent. Sending only the heuristic features would add little over the local logistic regression.

## Privacy

The `contact-v1` notice shown next to the button says details are "used only to reply to you and to keep a record of our conversation", kept until deletion is requested.

- **Layer 1 is consistent with the notice.** It runs inside the intake function on data we already store, sends nothing anywhere, and its stored output is counts and codes. Screening the record we keep is part of keeping it. Adding "and to protect this form from spam" in the next notice version would make it explicit.
- **Layer 2 is not clearly consistent.** It would send the visitor's message, and possibly name and email, to a second AWS account (Cyclotron) and to a third party (TypeSafe), and a standing run **stores the item text in the Cyclotron catalog**. A deletion request would then have to reach the Cyclotron store too, and there is no documented deletion of standing-run items, only retraction of priming examples. The notice does not mention service providers or automated screening. Before layer 2 for `engage-contact-v1`: either publish a new notice version (for example `contact-v2`) that names automated spam screening by a service provider, with the TypeSafe data processing terms reviewed, or keep layer 2 off for the contact form. If it is used, send the message only, with email and name replaced by their measured shapes, and add a deletion path for Cyclotron items.
- Waitlist notices (`babulus-waitlist-v1`) need the same check per form.
- External spam services were considered and are not proposed. StopForumSpam is free only for non-commercial use and needs the email or IP sent out, and an MD5 of an email is easily reversed. Akismet's free tier excludes commercial use and paid plans start at about $10 a month. OOPSpam has 40 free checks a month. Cloudflare Turnstile is free but adds a third-party script to the page and can show a visible challenge, which is friction.

## Rollout

1. **Specification.** `features/intake-spam.feature`: scoring examples (made-up data, `.invalid` and `@example.com` addresses only, for example `casey@example.com`), "a likely-spam inquiry still gets the same 202 and receipt", "a scorer error files as clean", "Not spam restores the follow-up", "a revision conflict on Spam is shown". Tests verify real API persistence and revision conflicts as for intake.
2. **Shadow mode.** Deploy the scorer with `mode: "shadow"`: compute and store `spam_check`, add no label, change no follow-up. Run `scripts/score-intake-inbox.ts` once over existing inbox items to see what would have fired. Ryan reviews the shadow verdicts in the prospect detail for two weeks or 20 `likely_spam` verdicts, whichever is later.
3. **Label.** Move to labelling only if shadow mode had no false positives among `likely_spam`. Turn on the label, the hidden-by-default filter and the two buttons.
4. **Honeypot capture.** If approved, store and file filled-honeypot submissions as `likely_spam` instead of dropping them.
5. **Timing and repeat key.** Server first, then the engage script (AnthusAI/Anth.us-Papyrus) and app waitlists.
6. **Layer 2,** only after the privacy and IAM decisions, starting with the operator script on `uncertain` items.

Each step is reversible with a configuration change (`mode: "off" | "shadow" | "label"`). Turning it off leaves stored results in place and labels untouched.

## Decisions for Ryan

1. **Thresholds.** `likely_spam` at score 0.70 with at least two reasons, one strong; protection for 40+ letters of own text. Keep, or start stricter?
2. **Labels.** `likely-spam` set automatically and `spam` only by a person (recommended), or also an automatic `spam` for the strongest cases?
3. **Spam disposition.** Confirmed spam moves to Closed and is kept until a deletion request (recommended), or is deleted after a retention period?
4. **Honeypot.** Store and file filled-honeypot submissions as likely spam (recommended under the never-reject rule) or keep dropping them?
5. **Timing field.** Add `elapsed_ms` to the engage form and waitlists?
6. **Vendor pitches.** Is a real person selling services "spam", or a third label (`solicitation`)?
7. **Layer 2.** Use Jev through Cyclotron for uncertain cases? It needs a new IAM role in papyrus-production, a Cyclotron stack change, a new contact notice version and a Cyclotron deletion path. Calls cost fractions of a cent.
8. **Notice wording.** Add "and to protect this form from spam" in the next notice version even if layer 2 is never used?

## Sources

Code and documents read for this design:

- Prospectus: `server/intake.ts`, `server/inbox.ts`, `server/intake-contact-policy.ts`, `intake-forms.json`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `src/admin/TodayView.tsx`, `src/admin/PipelineView.tsx`.
- AnthusAI/Anth.us-Papyrus: `web/inquiry_form.py` (honeypot markup, notice), `web/anthus_pages.py` (`FORM_TEMPLATE`), `web/static-root/engage-inquiry.js` (submission id, request body), `web/inquiry-config.json` (`contact-v1` text).
- AnthusAI/Cyclotron: `README.md`, `docs/embedding.md`, `docs/hosted-publications.md` (machine access, standing runs, provider credential), `docs/embedded-execution-authorization.md`, `infra/lab/README.md` (stack, roles, verifier), `docs/using-cyclotron.md` and `docs/experiments/decision-model-comparison-20261009.md` (Jev cost and accuracy), `docs/dev-procedures.md` (per-call cost), `src/decision_flywheel/adapters/jev.py`, `src/decision_flywheel/adapters/hosted_jev.py`.

Web:

- TypeSafe models, pricing and data use: https://docs.typesafe.ai/models
- Fine-tuning Jev: https://anth.us/articles/fine-tuning-jev/
- Distilling Jev into a classifier: https://anth.us/articles/distilling-jev-into-a-classifier/
- Primus classifier lab: https://anth.us/articles/primus-classifier-lab/
- OpenAI Decisions API preview: https://anth.us/articles/openai-decisions-api-preview/
- Gmail dots and duplicate sign-ups: https://www.suped.com/knowledge/email-deliverability/technical/what-causes-gmail-addresses-with-periods-to-appear-as-multiple-sign-ups-and-how-to-handle-them
- Bot sign-up patterns and list bombing: https://www.suped.com/knowledge/email-deliverability/technical/what-are-the-possible-reasons-for-an-increase-in-bot-signups-and-how-to-detectprevent-them
- Dot-count limit on sign-ups: https://railsdesigner.com/limit-spam-rails-signups/
- Random-string form spam reports: https://wordpress.org/support/?p=18699210, https://discourse.webflow.com/t/how-to-best-deal-with-spam-results-from-native-webflow-form/328725, https://community.hubspot.com/t/forms-and-spam-submissions/137937, https://community.keap.com/t/signups-with-random-characters/71778
- Character-bigram gibberish detector (MIT): https://github.com/rrenaud/Gibberish-Detector
- Random-string account names, n-gram and entropy features: https://arxiv.org/pdf/1812.05932
- Falsehoods about names: https://shinesolutions.com/2018/01/08/falsehoods-programmers-believe-about-names-with-examples/
- Submission-time thresholds and HMAC timestamps: https://packagist.org/packages/fischerdigital/contao-form-delay-protection-bundle, https://github.com/modxcms/formprotection, https://www.reform.app/blog/how-time-based-analysis-reduces-form-spam
- Why honeypots are evaded: https://blog.openreplay.com/honeypot-fields-stop-bots/, https://formspree.io/blog/frontend-spam-filtering/
- Link limits: https://wordpress.org/plugins/link-limits/
- Disposable domain list (CC0) and null MX: https://github.com/disposable-email-domains/disposable-email-domains, https://mxtoolbox.com/dmarc/details/what-are-null-mx-records
- Cloudflare Turnstile plans: https://developers.cloudflare.com/turnstile/plans/
- Akismet pricing: https://akismet.com/pricing/
- StopForumSpam terms and usage: https://stopforumspam.com/legal, https://stopforumspam.com/usage
- LLM spam classification accuracy: https://arxiv.org/pdf/2501.04985, https://arxiv.org/pdf/2405.15936v1
