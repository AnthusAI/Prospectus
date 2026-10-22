Feature: Other Anthus sites send contact messages to Prospectus on their own route
  Scenario: Declare a contact form in the registry
    Given a registry entry of kind contact with a site, form id, notice version, owner and allowed origins
    When the registry is loaded
    Then the form gets its own route POST /intake/contact/<formId>
    And the entry may not declare attributes
    And the origins may not overlap the anth.us demo origins or any other form

  Scenario: Accept the same fields as the demo form
    Given the Papyrus contact form
    When a visitor sends a receipt, name, email, message, optional company, honeypot, notice version, optional marketing preference, page path, campaign and optional elapsed time
    Then the message is accepted with the same strictness as the anth.us demo form
    And a body that names a site, form, owner, assignee, status or any undeclared field is rejected
    And a stale notice version, malformed email, missing name or missing message is rejected with a safe message and nothing is written

  Scenario: Bind each origin to its own route only
    Given the demo route allows only anth.us origins and the Papyrus contact route allows only https://p.apyr.us
    When https://p.apyr.us posts to the demo route or an anth.us origin posts to the Papyrus contact route
    Then the request is rejected with 403 before any service is opened
    And an unknown contact route returns 404 before any service is opened

  Scenario: Store first, then file as an inquiry that needs a reply
    Given an empty CRM
    When a visitor sends the Papyrus contact message
    Then the full message is stored durably before the CRM is touched
    And one prospect is owned by the form owner and tagged contact and app-papyrus
    And it carries the message, the trusted source, the receipt time and the spam result
    And its next action is "Respond to inquiry" on the next business day
    And a CRM outage leaves the stored message pending and the visitor still sees success

  Scenario: Resolve an existing contact to the same prospect
    Given a prospect for the same normalized email
    When that person sends a Papyrus contact message
    Then the inquiry is appended to the same prospect and its stage, owner and notes are preserved
    And replaying the receipt stores nothing twice and reusing a receipt for different content is kept as its own inquiry, never rejected

  Scenario: Score like every other form
    Given the Papyrus contact form
    When a message trips the spam rules or the hidden website field is filled
    Then the visitor sees success and the message is stored, scored and labelled exactly as a demo inquiry would be
    And a likely-spam message gets no follow-up and "Not spam" restores "Respond to inquiry"

  Scenario: Isolate contact throttling
    Given the stage default throttle applies to demo intake
    When a contact form is enabled
    Then it has its own route with its own route-level throttle, created before the stage is updated
    And the intake role gains no permission and still has no s3:ListBucket

  Scenario: Ship disabled until approved
    Given the Papyrus waitlist and contact entries are committed with enabled false
    When the stack is synthesized
    Then no route, origin, Lambda configuration or throttle is added
    And enabling an entry needs a recorded approval
