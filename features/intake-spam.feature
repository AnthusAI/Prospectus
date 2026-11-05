Feature: Intake spam is scored after capture and never rejected
  Every valid website message is accepted with the normal success response. Spam scoring is a
  pure, local, deterministic check that runs only after the inquiry is durably stored in the
  inbox. It labels; it never rejects, delays, deletes or hides a record where it cannot be found.
  All examples use made-up values and @example.com addresses only.

  Background:
    Given the shipped rules in config/intake-spam-rules.json with rules version "intake-spam-rules-2"

  Scenario: Score the 2026-10-20 bot submission from its feature vector
    Given a synthetic demo inquiry shaped like the 2026-10-20 bot submission
      | field   | shape                                                                         |
      | name    | one 22-letter token, 6 lower-to-upper switches, an 11-letter consonant run   |
      | email   | a Gmail local part of 21 characters with 8 dots and nine short segments      |
      | company | a six-letter stem and the suffix LLC                                          |
      | message | exactly the four prefilled prompts and the "Came from" line                   |
      | website | empty                                                                         |
    When it is scored
    Then the reasons are gibberish_name, template_only_message and gmail_dot_scatter
    And the score is 0.784 and the verdict is likely_spam
    And the stored evidence holds counts and lengths only, never the measured text

  Scenario: Bots with vowel-heavy random names are caught
    Given a demo inquiry whose name is one long token with 4 or more lower-to-upper switches and no long consonant run
    And its message is only the prefilled prompts and its Gmail address has scattered dots
    When it is scored
    Then the reasons include gibberish_name and the verdict is likely_spam

  Scenario: A blank form sent in under a second is likely spam
    Given a demo inquiry whose message is only the prefilled prompts, with an ordinary name and email
    When it is submitted with elapsed_ms under 1000
    Then the reasons are template_only_message and instant_submit and the verdict is likely_spam
    But the same blank form sent after 1000 milliseconds or more is at most uncertain

  Scenario: A real note sent instantly is never labelled
    Given a demo inquiry with 40 or more letters of the visitor's own text
    When it is submitted with elapsed_ms under 1000
    Then the verdict is at most uncertain

  Scenario: Fast signups are not treated as instant
    When a waitlist or newsletter signup has elapsed_ms under 1000
    Then it adds only the weak fast_submit reason, because autofill can complete a one-field form that fast

  Scenario: Label stored prospects with the current rules
    Given a prospect in the initial stage whose every inquiry scores likely_spam under the current rules
    And no person has reviewed it
    When an operator runs scripts/label-stored-spam.ts with --apply
    Then it gains the likely-spam label and loses its next action and follow-up date, and its inquiries are unchanged
    And the same run without --apply writes nothing and prints counts and ids only
    But a prospect with a person's spam decision, an inquiry that does not score likely_spam, or a later stage is left alone
    And running it again changes nothing

  Scenario: One signal alone is never enough
    When a demo inquiry fires only gmail_dot_scatter, only template_only_message, only instant_submit or only gibberish_name
    Then the verdict is clean or uncertain, never likely_spam

  Scenario: Protect a real visitor who writes a real note
    Given a demo inquiry with a machine-looking name, scattered Gmail dots and 40 or more letters of the visitor's own text
    When it is scored
    Then the verdict is at most uncertain
    But markup, three or more links, or a filled honeypot can still make it likely_spam

  Scenario: A vendor pitch is a hint, not spam
    Given a demo inquiry that offers SEO or web design services
    When it is scored
    Then it carries the vendor_pitch hint and no spam reason for the phrases
    And only a person applies the vendor label

  Scenario: A likely-spam inquiry gets the same response and is stored
    Given the deployment flag spamLabelling is "label"
    When a likely_spam demo inquiry is submitted
    Then the visitor receives 202 with the same receipt and message as any inquiry
    And the inbox item and the inquiry carry spam_score, spam_verdict, spam_reasons and spam_rules_version
    And the prospect is filed with the label likely-spam and no next action or follow-up date

  Scenario: Shadow mode scores and stores but changes nothing else
    Given the deployment flag spamLabelling is "shadow"
    When a likely_spam demo inquiry is submitted
    Then the inquiry carries the score, verdict, reasons and rules version
    And the prospect has no likely-spam label and the usual next action and follow-up date

  Scenario: A filled honeypot is stored and labelled, never dropped
    Given either labelling mode
    When the hidden website field is filled on the demo form or a waitlist form
    Then the visitor sees the normal success response
    And the full inquiry is stored in the inbox and filed with reason honeypot and verdict likely_spam
    And the prospect is labelled likely-spam with no follow-up date

  Scenario: Accept an optional submission timing
    When a submission includes elapsed_ms between 0 and 86400000
    Then it is accepted and a value under 1500 adds the weak fast_submit reason, or instant_submit under 1000 on a form with a message
    And an absent, non-integer or out-of-range elapsed_ms is ignored, never a 400 and never a reason
    And elapsed_ms is not part of the submission fingerprint, so a retry with another timing is the same inquiry

  Scenario: The scorer can never change the HTTP response
    Given a scorer that throws
    When a valid inquiry is submitted
    Then the visitor receives the same 202, receipt and message
    And the inquiry is stored with verdict unscored and reason scorer_error and filed as clean

  Scenario: Waitlists use the same scorer
    When a waitlist signup is submitted
    Then it is scored with the same module, without the message rules
    And a likely_spam signup in label mode adds likely-spam to the waitlist labels

  Scenario: A later clean message is never held back by an old label
    Given a prospect labelled likely-spam with no follow-up date
    When the same contact sends a clean demo inquiry
    Then the prospect gets the usual next action and next business day follow-up
    And the likely-spam label stays until a person resolves it

  Scenario: Review a likely-spam prospect in the CRM
    Given a prospect labelled likely-spam
    When a member opens it in the pipeline
    Then the detail view shows the verdict, the score, the reasons in plain words and the rules version
    And Not spam removes the label, sets the next action and next business day follow-up, and records a not_spam correction
    And Spam replaces the label with spam, moves the prospect to Closed, clears the follow-up and records a spam correction
    And Vendor sets the vendor label, moves the prospect to Closed, clears the follow-up and records a vendor correction
    And nothing is deleted
    And each correction keeps the machine score, verdict, reasons and rules version for weight tuning
    And a revision conflict is shown, not overwritten

  Scenario: The pipeline hides likely spam by default
    Given prospects labelled likely-spam or spam
    When a member opens the pipeline
    Then those prospects are hidden and a visible "N hidden as spam" control can show them
    And Today does not list them as new leads
