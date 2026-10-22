Feature: Other Anthus apps send waitlist signups to Prospectus as leads
  Scenario: Resolve the trusted source from the registry and never from the caller
    Given a registry of intake forms where each form declares its app, form id, notice version, owner and allowed origins
    When a visitor submits to a form route from one of that form's origins
    Then the site, form, notice version and owner come from the registry
    And a body that names a site, form, owner, assignee, status or any undeclared attribute is rejected

  Scenario: Bind each origin to its own form only
    Given the demo form allows only anth.us origins and the Babulus waitlist form allows only Babulus origins
    When a Babulus origin posts to the demo route or an anth.us origin posts to the Babulus waitlist route
    Then the request is rejected with 403 before any service is opened
    And an unknown form route returns 404 before any service is opened
    And the gateway preflight allows exactly the union of enabled form origins with only the content-type header

  Scenario: Validate a waitlist signup strictly
    Given the Babulus waitlist form
    When a signup has a malformed email, a stale notice version, an unknown persona, an unknown field or an invalid source slug
    Then it is rejected with a safe message and nothing is written
    And a signup with only an email, notice version and receipt is accepted
    And persona must be one of business, agency, marketer, creator, developer or other

  Scenario: Land a waitlist signup as a lead without follow-up tasks
    Given an empty CRM
    When a visitor joins the Babulus waitlist
    Then one prospect in the new stage is owned by the form owner and tagged waitlist and app-babulus
    And it retains the trusted source, persona, marketing preference and receipt time
    And it has no next action and no follow-up date so the queue is not flooded
    And no account, membership, entitlement or appointment is created

  Scenario: Resolve an existing contact to the same prospect
    Given a prospect created by the anth.us demo form for the same normalized email
    When that person joins the Babulus waitlist
    Then the waitlist inquiry is appended to the same prospect
    And its stage, owner, next action, follow-up date and notes are preserved

  Scenario: Deduplicate by email per app and replay by receipt
    Given a person who already joined the Babulus waitlist
    When they submit again with a new receipt or the same receipt is retried
    Then no second inquiry is stored and the visitor sees the same success response
    And a different app may still add its own waitlist inquiry for that email
    And reusing a receipt for different content returns 409

  Scenario: Record consent changes on repeat signups
    Given a person already on the Babulus waitlist
    When they submit again with a different marketing preference or a different notice version
    Then the new inquiry is appended so the latest choice is recorded and earlier consent is preserved
    And no next action or follow-up is added
    And a repeat with the same preference and notice stays deduplicated even if name or attributes differ

  Scenario: Reject unsafe registry entries
    Given a registry entry with a coerced non-string field, an unanchored attribute pattern, or origins shared with another form or the demo
    When the registry is loaded
    Then loading fails before any route or origin is configured

  Scenario: Honeypot
    Given the Babulus waitlist form
    When the hidden website field is filled
    Then the visitor sees success and the signup is stored and labelled likely-spam (see intake-spam.feature)

  Scenario: Keep anth.us demo intake unchanged
    Given the deployed real-contacts demo form
    When registry forms are added or disabled
    Then POST /intake/demo accepts the same fields, origins, notice and response as before
    And a disabled registry entry adds no route, origin or Lambda configuration

  Scenario: Isolate waitlist throttling
    Given the stage default throttle applies to demo intake
    When a waitlist form is enabled
    Then it has its own route with its own route-level throttle
    And the intake role gains no permission and still has no s3:ListBucket
