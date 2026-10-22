# Intake spam: classify after capture, never reject

Status: layer 1 implemented (kanbus-2e713ce2), deployed in **shadow** mode. Ryan approved the decisions below on 2026-10-21. Layer 2 (Jev through Cyclotron) stays off.

## The rule this design serves

A potential client's valid message is always accepted. The visitor always gets "Thanks, we have your note." Spam handling must add no friction for a real visitor: no CAPTCHA, no challenge, no extra field, no slower response, and no different answer for a submission we suspect.

So spam handling only **classifies and labels after the inquiry is durably stored** (see [Store first, then file](ARCHITECTURE.md#store-first-then-file)). It never rejects, never deletes, and never hides a record where it cannot be found again. A false positive is one click to find and one click to restore.

The rule covers the anth.us contact form (`engage-contact-v1`) and every app waitlist and contact form in `intake-forms.json`. A registry contact form (`kind: "contact"`, for example `papyrus-contact-v1`) is scored exactly like the demo form, with every message rule; its stored inquiries have `kind: "contact"`, label `contact` and `app-<siteId>`, and Not spam restores "Respond to inquiry" for them ("Respond to demo request" for demo inquiries).

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

## Approved decisions (Ryan, 2026-10-21)

| # | Decision | Where it lives |
| --- | --- | --- |
| 1 | `likely_spam` when the score is 0.70 or more **and** at least two reasons fired, at least one of them strong. 40 or more letters of the visitor's own text cap the verdict at `uncertain` unless `markup_or_links` or `honeypot` fired | `config/intake-spam-rules.json` `thresholds` |
| 2 | `likely-spam` is applied automatically (in label mode). `spam` is applied only by a person | `server/intake.ts`, `src/spam-review.ts` |
| 3 | Confirmed spam moves to Closed and is kept until deletion is requested. Nothing is deleted automatically | `src/spam-review.ts` |
| 4 | A filled honeypot is **stored** in the inbox and filed, labelled `likely-spam` with reason `honeypot`, never dropped. The visitor's response is unchanged | `server/intake.ts`, `server/intake-spam.ts` |
| 5 | Optional `elapsed_ms` timing. The server accepts it first; the forms send the time since the form was rendered | `server/intake.ts`; AnthusAI/Anth.us-web engage form |
| 6 | A real person selling services gets a separate `vendor` label, not `spam`. It is applied by a person; the scorer only shows a `vendor_pitch` hint | `config/intake-spam-rules.json` `vendor_pitch`, `src/spam-review.ts` |
| 7 | Jev stays off: no TypeSafe or Cyclotron calls | Layer 2 below is not implemented |
| 8 | Add "and to protect this form from spam" in the **next** privacy notice version. `contact-v1` is unchanged | Follow-up kanbus-72d6a8 for Ryan to approve the new notice text |

## Design in one paragraph

After the inbox write succeeds, intake runs a pure, local scoring function over the inquiry (`server/intake-spam.ts`). It returns a score from 0 to 1, a verdict (`clean`, `uncertain` or `likely_spam`), named reason codes and counts-only evidence. The result and the rules version are stored on the inquiry, in the inbox item and in `custom.inquiries[]` on the prospect. In label mode a `likely_spam` inquiry is filed as a normal prospect with the label `likely-spam` and no follow-up date, so it stays out of Today and is hidden by default in the pipeline behind a visible "N hidden as likely spam or spam" control. Ryan confirms with **Spam**, restores with **Not spam**, or marks a sales pitch with **Vendor**. Each click is recorded as a correction with the machine result that it corrects. Corrections tune the rules through reviewed changes. The visitor's response never changes.

## Layer 1: deterministic heuristics

All rules are local string checks. They need no network, no paid service and no new AWS resource. They run in microseconds.

The rule table is `config/intake-spam-rules.json`, version `intake-spam-rules-1`. Changing a weight, threshold or phrase is a reviewed change that bumps the version, and every stored result names the version that produced it. The combined score is a noisy-OR, `1 - Π(1 - weight)` over the rules that fire, rounded to three places, so it stays between 0 and 1 and no single weak rule can reach the label threshold.

| Code | Fires when | Weight | Strength | False-positive risk | 2026-10-20 example |
| --- | --- | --- | --- | --- | --- |
| `gibberish_name` | A Latin-script token of 12 or more letters with no space has 3 or more lower-to-upper switches inside it, and either its vowel share (a, e, i, o, u, y, accents folded) is below 0.25 or it has a run of 6 or more consonants | 0.55 | Strong | Low with these guards. McDonald, DeAndre, O'Neil, Krzysztof, Szczepański, Xu Zhengqi and Nguyen have at most 1 switch. Non-Latin scripts, tokens with punctuation and tokens under 12 letters never fire | Fires (22 letters, 6 switches, run 11, vowels 0.23) |
| `gibberish_company` | The same test on the company field | 0.35 | Strong | Low, as above. "PayPal" has 1 switch | Does not fire (the stem is 6 letters) |
| `template_only_message` | The message contains at least one of the engage form's prompts and, after removing the four prompts, the "(Came from: …)" line and a single-word solution the link filled in, has fewer than 3 letters left | 0.40 | Strong | Medium on its own: a real person can press send without typing. That is why it is not enough alone | Fires (4 prompts, 0 letters) |
| `markup_or_links` | BBCode `[url=` or `[url]`, an HTML `<a href`, or 3 or more URLs in the message | 0.55 | Strong | Low for a B2B form. One or two URLs (often the sender's own site) never fire | Does not fire |
| `gmail_dot_scatter` | A `gmail.com` or `googlemail.com` local part with 4 or more dots, or at least 2 dots and a dot share of 0.25 or more, or 3 or more one-character segments | 0.20 | Medium | Medium. Real people write first.m.last (2 dots). Gmail ignores dots, so heavy scattering is a bot signature, but only medium alone. Other domains, including Google Workspace, never fire | Fires (21 characters, 8 dots, share 0.38, 9 segments) |
| `honeypot` | The hidden `website` field is filled | 0.90 | Strong | Low (`autocomplete="off"`, `tabindex="-1"`, hidden). Not zero: some autofill and accessibility tools fill hidden fields | Does not fire (the bot evaded it) |
| `fast_submit` | The form reports `elapsed_ms` below 1,500 | 0.20 | Weak | Medium on waitlists, where autofill can complete a one-field form in about a second | Not available (no timing then) |

**Vendor pitches are a hint, not a reason** (decision 6). Fixed phrases such as "SEO services", "backlinks", "guest post", "rank your website", "web design services" or "lead generation services" add the hint `vendor_pitch`, shown in the CRM next to the **Vendor** button. A hint has no weight and never changes the verdict. There is no automatic vendor label: a real client may ask about SEO, and no phrase list separates a buyer from a seller reliably. A fluent pitch with three or more links still fires `markup_or_links`.

**Not in `intake-spam-rules-1`.** `random_company_stem` (needs a character-bigram model, high false-positive risk for non-English names), `repeat_variant` (needs a new per-address control object) and `disposable_domain` (needs a vendored list) were proposed in the design and are left for a later rules version once shadow data shows they are needed.

Signals deliberately given **zero weight**: short names (Li, Ng, Bo), non-Latin scripts, all-lowercase or all-uppercase names, digits at the end of an address, free-mail domains, the visitor's country or language, and raw IP repeats (offices share addresses behind NAT).

**Protection for real visitors.** If a demo message has 40 or more letters of the visitor's own text (after removing the template) and neither `markup_or_links` nor `honeypot` fired, the verdict is at most `uncertain` and the result records `spam_protected: true`. A real person with an unusual name who writes a real note is never labelled.

**Thresholds** (decision 1):

| Verdict | Rule |
| --- | --- |
| `likely_spam` | Score 0.70 or more, at least two reasons, at least one strong. Also always when `honeypot` fired (decision 4), even as the only reason |
| `uncertain` | Score 0.30 or more otherwise, or capped by the protection above |
| `clean` | Below 0.30 |
| `unscored` | The scorer threw or returned something invalid. Stored with reason `scorer_error` and filed exactly as `clean` |

**The example:** `gibberish_name` (0.55), `template_only_message` (0.40) and `gmail_dot_scatter` (0.20) fire. Score `1 - 0.45 × 0.60 × 0.80 = 0.784`, three reasons, two strong: `likely_spam`. Name and template alone give 0.73 (`likely_spam`); Gmail dots alone (0.20, `clean`), a template-only message alone (0.40, `uncertain`) or Gmail dots with a template-only message (0.52, `uncertain`) would not. `test/intake-spam.test.ts` checks this feature vector with made-up values of the same shapes.

### Submission timing

The engage form and app waitlists may send an optional integer `elapsed_ms`: the time from the form being rendered to the first send attempt of that note. The server accepts integers from 0 to 86,400,000 (one day). An absent or invalid value (negative, too large, fractional, a string) is ignored: it is never a 400 and never a reason, because a valid message is always accepted. `elapsed_ms` is not part of the submission fingerprint, so a retry of the same note with another timing is the same inquiry. The value is unsigned and a bot can fake it, so it stays a weak signal. A signed server timestamp would need a token endpoint, which is a new request on the visitor's path and is not proposed.

**Order of deployment matters.** Intake rejects unknown fields with a 400, so this server change must be deployed before any form sends `elapsed_ms`. The Anth.us-web change merges only after this change is live.

### Honeypot: stored and labelled

Before this change `Intake.submit` returned success and stored nothing when `website` was filled, so a real visitor whose browser filled the hidden field lost their message without anyone knowing. Now the inquiry is stored in the inbox, filed, and labelled `likely-spam` with reason `honeypot` and no follow-up date (decision 4). The honeypot's text is never stored: the inquiry records only `form_signals.honeypot_filled: true`. This applies in **both** labelling modes, because a honeypot submission was never filed before and labelling it keeps it out of Today exactly as dropping it did. The visitor's response is unchanged.

## Where it runs

Inside `IntakeService.submit`, after `inbox.capture` succeeds and before filing:

1. Capture the inbox item exactly as before. The 202 depends only on this.
2. Score the stored inquiry with `scoreInquiry`, wrapped by `safeScore` so any exception or invalid result becomes `unscored` with reason `scorer_error`, filed as clean. A replayed inquiry that already carries a result keeps it.
3. File the prospect. Only the create or append body changes (see below).
4. Store the scored inquiry on the inbox item in the existing best-effort status write after filing, so scoring adds no extra storage request on the visitor's path.

There is no new Lambda, queue, schedule, table or IAM statement. The added CPU is negligible. The operator refile (`scripts/refile-intake-inbox.ts`) scores pending items the same way and files them with the deployed mode from `evaluation-deployment.json`. Logs carry the verdict code only (`intake_spam_scored`), never input text.

Waitlists use the same scorer. They have no message, so only the name, company, email, honeypot and timing rules apply. Waitlist signups already have no follow-up date; the label keeps likely spam out of any launch announcement drawn from waitlist opt-ins.

### Newsletter signups

Newsletter signups ([ARCHITECTURE.md](ARCHITECTURE.md#newsletter-mailing-lists)) use the same scorer with kind `newsletter`. They have only an email, so only the Gmail dot, honeypot and timing rules can fire. The result (`spam_verdict`, `spam_score`, `spam_reasons`, `spam_rules_version` and `form_signals`) is stored on the signup request in the subscription record, in the same write that stores the signup, and the visitor's 202 is identical whatever the result.

A signup scored `likely_spam` is stored and gets **no confirmation email**, in both labelling modes. With the shipped thresholds an email-only signup can reach `likely_spam` only through the honeypot (the other two rules together score 0.36, below 0.70, and neither is strong), so in practice this is decision 4 applied to email: a filled honeypot never makes us send mail. This matters more than for the other forms, because a newsletter form that mails any address it is given can be used to send unwanted mail to someone else. The 24-hour resend limit and the route throttle cover the same abuse for signups that look clean. Nothing is labelled, because a subscription is not a prospect.

A later signup for the same address that is not likely spam is treated normally (it gets a confirmation if the resend window allows), and a confirmation is honoured whatever earlier requests scored. Newsletter signups are not part of the shadow review, because nothing in the CRM changes for them.

### Shadow and label modes

`evaluation-deployment.json` carries `"spamLabelling": "shadow"`, passed to the intake Lambda as `PROSPECTUS_INTAKE_SPAM_LABELLING`. An absent value means `shadow`; any value other than `shadow` or `label` fails the deployment.

| Mode | Score and store | `likely-spam` label | Follow-up on likely spam |
| --- | --- | --- | --- |
| `shadow` (committed) | Yes | Only for a filled honeypot | Unchanged (intake sets it as before) |
| `label` | Yes | Yes | Left out, so it stays out of Today |

Turning labelling off again (back to `shadow`) leaves stored results and existing labels in place.

### Filing

- **New demo prospect, labelled likely spam:** labels `["likely-spam"]`, no `next_action`, no `next_follow_up_at`.
- **New waitlist prospect, labelled likely spam:** the waitlist labels plus `likely-spam`.
- **Needs-review prospect, labelled likely spam:** `["needs-review", "likely-spam"]`.
- **Existing prospect:** a likely-spam inquiry is appended but **never labels** an existing prospect. A demo inquiry that is not itself labelled spam, appended to a prospect labelled `likely-spam` with no follow-up date, sets the usual next action and next-business-day follow-up, so a real person's new message is never held back by an old label. The label stays for a person to resolve.
- Every create and append sets `custom.spam_status` to the latest inquiry's verdict.

## What is stored

On each inquiry, in the inbox item and in `custom.inquiries[]` (example values):

```json
"form_signals": {"elapsed_ms": 2500},
"spam_score": 0.784,
"spam_verdict": "likely_spam",
"spam_reasons": ["gibberish_name", "template_only_message", "gmail_dot_scatter"],
"spam_rules_version": "intake-spam-rules-1",
"spam_hints": [],
"spam_evidence": {
  "gibberish_name": {"length": 22, "case_switches": 6, "longest_consonant_run": 11, "vowel_share": 0.23},
  "template_only_message": {"prompts": 4, "own_letters": 0},
  "gmail_dot_scatter": {"local_length": 21, "dots": 8, "dot_share": 0.38, "segments": 9, "single_character_segments": 5}
},
"spam_protected": false,
"spam_mode": "label",
"spam_checked_at": "2026-10-21T12:00:00.000Z"
```

`spam_evidence` holds counts and lengths only, never the text it measured. `form_signals` holds `honeypot_filled: true` and `elapsed_ms` when the form reported them, never the honeypot's text.

On the prospect: `custom.spam_status` (the latest inquiry's verdict) and, after a person's decision, `custom.spam_review` (the latest) and `custom.spam_corrections` (all decisions, the last 50):

```json
"spam_review": {
  "label": "not_spam",
  "reviewer": "<actor id>",
  "at": "2026-10-22T09:00:00.000Z",
  "inquiry_id": "<id>",
  "rules_version": "intake-spam-rules-1",
  "machine": {"score": 0.784, "verdict": "likely_spam", "reasons": ["gibberish_name", "template_only_message", "gmail_dot_scatter"]}
}
```

All of this is ordinary Kanbus data in the canonical S3 files; nothing new is stored elsewhere.

## In the CRM

- **Pipeline:** prospects labelled `likely-spam` or `spam` are hidden by default. A visible line, "3 hidden as likely spam or spam. Show", reveals them. `vendor` is not hidden; vendors sit in Closed.
- **Today:** likely spam has no follow-up date in label mode, so it is not a follow-up, and prospects labelled `likely-spam` or `spam` are left out of the new-leads list.
- **Prospect detail:** a "Spam check" section with the verdict, the score, the reasons in plain words ("Name looks machine-generated", "Message is only the form's prompts", "Gmail address with scattered dots"), any vendor hint, the protection note, the rules version and whether it was scored in shadow mode. A flagged prospect shows it open at the top of the detail view; a clean one shows it collapsed.
- **Not spam:** removes `likely-spam`, `spam` and `vendor`; for a prospect with a demo inquiry sets `next_action` to "Respond to demo request" and `next_follow_up_at` to the next business day (the values intake would have set); reopens a Closed prospect to New; records a `not_spam` correction.
- **Spam:** replaces the labels with `spam`, moves the prospect to Closed, clears `next_follow_up_at`, records a `spam` correction. Nothing is deleted (decision 3). Deletion stays the existing manual privacy process.
- **Vendor:** replaces the labels with `vendor`, moves the prospect to Closed, clears `next_follow_up_at`, records a `vendor` correction.
- The same three buttons are on every scored prospect, so missed spam becomes a correction too.

Each button is one revisioned update through the Kanbus API (`If-Match`); a revision conflict is shown ("Someone changed this prospect…"), not overwritten. Prospectus adds these application interactions (`src/admin/SpamReview.tsx`, `src/spam-review.ts`). The badge and the hidden-by-label filter are candidates to move into reusable Kanbus/Virtuus UI.

## Learning from corrections

Every **Spam**, **Not spam** and **Vendor** click is a label on one inquiry with the rules version, score, verdict and reasons that it corrects. That is the training and correction data.

**Without a model (the plan).** A later operator script, `scripts/spam-corrections.ts`, collects `(evidence, reasons, score, label)` from records with `spam_corrections`, with no names, addresses or message text. It reports precision and recall per rule and per threshold. When there are enough labels (about 30 of each kind), it fits a logistic regression over the rule features and proposes new weights. A person reviews the proposal and commits it as a new `rules_version`. The rules learn, but only through a reviewed change, and every past result stays explainable by its version. `vendor` corrections count as "not spam" for the spam weights.

## Layer 2 (not implemented; off by decision 7): a Jev decision through Cyclotron

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

- **Layer 1 is consistent with the notice.** It runs inside the intake function on data we already store, sends nothing anywhere, and its stored output is counts and codes. Screening the record we keep is part of keeping it. Ryan decided (decision 8) to add "and to protect this form from spam" in the next notice version. `contact-v1` is not changed now; kanbus-72d6a8 tracks the new notice text for Ryan to approve, deployed server first like any notice version.
- **Layer 2 is off** (decision 7). If it is ever reconsidered: it would send the visitor's message, and possibly name and email, to a second AWS account (Cyclotron) and to a third party (TypeSafe), and a standing run **stores the item text in the Cyclotron catalog**. A deletion request would then have to reach the Cyclotron store too, and there is no documented deletion of standing-run items. It would need a notice version that names automated spam screening by a service provider, with the TypeSafe data processing terms reviewed.
- Waitlist notices (`babulus-waitlist-v1`) need the same wording check per form.
- External spam services were considered and are not proposed. StopForumSpam is free only for non-commercial use and needs the email or IP sent out, and an MD5 of an email is easily reversed. Akismet's free tier excludes commercial use and paid plans start at about $10 a month. OOPSpam has 40 free checks a month. Cloudflare Turnstile is free but adds a third-party script to the page and can show a visible challenge, which is friction.

## Rollout

1. **Specification.** `features/intake-spam.feature`, with made-up data and `@example.com` addresses only. Done.
2. **Shadow mode.** Deploy with `"spamLabelling": "shadow"`: compute and store the result, add no label (except for a filled honeypot), change no follow-up. Ryan reviews the shadow verdicts in the prospect detail for two weeks or 20 `likely_spam` verdicts, whichever is later.
3. **Label.** Change `spamLabelling` to `"label"` in a reviewed pull request only if shadow mode had no false positives among `likely_spam`.
4. **Timing.** Server first (this change), then the engage form (AnthusAI/Anth.us-web) and app waitlists.
5. **Later rules versions** from corrections, and the deferred rules above if shadow data shows they are needed.

Each step is reversible with a configuration change. Going back to `shadow` leaves stored results and labels in place.

## Sources

Code and documents read for this design:

- Prospectus: `server/intake.ts`, `server/inbox.ts`, `server/intake-contact-policy.ts`, `intake-forms.json`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `src/admin/TodayView.tsx`, `src/admin/PipelineView.tsx`.
- AnthusAI/Anth.us-web (formerly Anth.us-Papyrus): `web/inquiry_form.py` (honeypot markup, notice), `web/anthus_pages.py` (`FORM_TEMPLATE`), `web/static-root/engage-inquiry.js` (submission id, request body), `web/inquiry-config.json` (`contact-v1` text).
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
