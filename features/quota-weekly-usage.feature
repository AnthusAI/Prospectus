Feature: Weekly quota, pay-after usage, and the private rate table
  The quota applies per Account per week and resets by time alone. High-volume small items such as LLM tokens and
  Lambda time are checked cheaply before work and recorded in batches after it. Usage is priced with a rate table
  that lives outside Git; a missing or broken table refuses every call, and each charge records the table version.
  See docs/QUOTA.md.

  Scenario: The week resets by time alone
    Given an Account with 30 percent of its week's quota used
    When the week's end passes
    Then the next check reports 0 percent and a reset time one week later
    And last week's record is kept untouched
    And unused quota does not carry over

  Scenario: The week is a fixed seven days from the Account's creation, in UTC
    Given an Account created at a known time
    Then its weeks start at that time plus whole multiples of seven days

  Scenario: A hold counts against the week it was taken until it ends
    Given a reservation taken late in one week that is still open when the week ends
    Then it counts against that week and does not count against the next

  Scenario: A charge counts in the week it settles
    Given that reservation, settled in the following week
    Then the actual usage is charged to the following week and last week is not rewritten
    And settling or releasing it again is refused

  Scenario: Check is a cheap read
    When a product checks an Account that is under 100 percent
    Then it is told new work is allowed, with the percent used and when the quota resets
    And nothing is written
    And a product that is not entitled, or an Account with no allowance, is refused

  Scenario: Pay-after usage is recorded in batches and retries are safe
    Given a product with many small items from several requests
    When it records them in one call with an operation ID
    Then the converted usage is charged once, to the product that reported it
    And repeating the call with the same ID and body returns the same result and charges nothing more
    And the same ID with different items is refused as an idempotency conflict

  Scenario: Recording may overshoot 100 percent
    Given an Account near its allowance
    When a batch of recorded items takes usage past the allowance
    Then the usage is recorded in full and the overshoot is kept internally
    And the display caps at 100 percent
    And the next check and the next reservation are refused

  Scenario: High volume does not grow the week's document
    Given hundreds of record calls in one week
    Then the week's document holds only aggregates and stays about the same size
    And every call is its own immutable journal file with its items, units and table version

  Scenario: An unknown item kind is refused and operators can see it
    When a product reserves, settles or records an item kind the table does not know
    Then the call is refused as an unknown item kind and nothing is charged
    And the refusal log and a journal event name the refused kind for operators

  Scenario: An unavailable or unparseable table refuses everything
    Given the rate table parameter cannot be read, is not valid, or still holds its placeholder
    When a product reserves, settles, records or checks
    Then the service answers that quota is unavailable and nothing is written or charged
    And the portal and CRM show the quota as unavailable, never as zero or free

  Scenario: Each charge records the table version and a rate change never rewrites history
    Given usage charged under one table version
    When the table changes to a version with other rates
    Then earlier charges keep their units and their version
    And later charges are priced and recorded under the new version
    And a reservation keeps the units it was priced at when it was made

  Scenario: The rate table is private
    Then the repository holds only the engine, with a made-up table in tests and docs
    And no response to a product, the CRM, the portal or a log contains a rate, a formula or a table
    And the infrastructure template contains no rate and no allowance

  Scenario: The table is read from a parameter outside Git
    Given a deployment that names the rate table parameter
    Then the parameter is created once with an unparseable placeholder and never overwritten by a deployment
    And only the central runtime may read it
    And a change an operator makes applies within about a minute

  Scenario: Nothing from the private model reaches a product
    When a product calls any quota route
    Then the success body has only identifiers, a status, an expiry, and for check a flag, a whole percent and a reset time
