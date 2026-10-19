Feature: Evaluate inquiry capture without contacting real people
  Scenario: A synthetic inquiry reaches the existing private CRM
    Given the approved evaluation runtime has one fixed workspace and shared conditional control authority
    When a visitor submits a valid .invalid inquiry from the configured origin
    Then one canonical prospect retains its source and dated next action
    And repeated delivery and concurrent inquiries retain one contact and each distinct inquiry once
    And the public response contains only a receipt

  Scenario: Public input cannot select authority or expose CRM records
    Given a visitor without CRM membership
    When they submit real contact details, another workspace, an oversized body, or a disallowed method or origin
    Then the request is rejected before invoking the private CRM
    And no invitation, email, account, or permission is created

  Scenario: A Lambda restart loses no canonical intake authority
    Given two invocations with independent temporary receipt caches and the same durable control authority
    When a committed backend response is lost and the receipt is retried
    Then the shared claim resolves the original prospect and canonical inquiry
    And temporary cache deletion does not delete shared claims or CRM records

  Scenario: A first-ever inquiry needs no permission to read an absent claim
    Given the intake runtime may only get and put its own claim prefixes and cannot list the bucket
    When a visitor submits an inquiry whose identity and receipt claims do not exist yet
    Then each claim is created first with an absent-only conditional write and read only if it already exists
    And repeated, changed and concurrent submissions resolve exactly as before
    And a denied read of an existing claim is an error and an unconfirmed submission logs only an error class and transport outcome
