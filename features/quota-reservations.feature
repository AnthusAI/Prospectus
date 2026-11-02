Feature: Reserve, settle and release shared account quota
  An account has one quota allowance, in whole US cents of cloud cost, shared by every app. A product's server
  role reserves quota before it starts paid cloud work, settles against the real cost when the work ends, and
  releases what it did not use. Every call carries a client-generated operation ID so a retry is safe. The
  routes fail closed: nothing but a successful reserve ever means spending is allowed. See docs/QUOTA.md.

  Scenario: A reservation within the remaining quota succeeds
    Given an account with an allowance of 1000 cents and nothing held
    And a registered product that the account is entitled to
    When the product reserves 400 cents with a lifetime of one hour
    Then the reservation succeeds and names its reservation ID and expiry
    And the account's remaining quota is 600 cents
    And the journal records one reservation event

  Scenario: A reservation over the remaining quota is refused
    Given an account with 600 cents remaining
    When a product reserves 601 cents
    Then the reservation is refused as insufficient quota
    And nothing is written, no hold exists and the remaining quota is unchanged
    And a reservation of exactly 600 cents still succeeds

  Scenario: Concurrent reservations cannot overspend
    Given an account with an allowance of 1000 cents
    When several processes reserve 300 cents at the same moment
    Then at most three reservations succeed
    And the losers are refused or asked to retry, never granted
    And the held total never exceeds the allowance

  Scenario: A retry with the same operation ID returns the same result
    Given a product that reserved 250 cents and did not see the response
    When it repeats the reserve with the same operation ID and the same body
    Then it receives the original result
    And the quota is held once, not twice
    And the original answer is returned even if the remaining quota has since changed

  Scenario: The same operation ID with a different request is refused
    Given an operation ID already used to reserve 100 cents
    When it is reused to reserve 200 cents, or by another product
    Then the request is refused as an idempotency conflict and nothing changes

  Scenario: A crash between the allowance write and the journal write is repaired by the retry
    Given a reservation whose allowance write committed but whose journal write failed
    When the product repeats the same call
    Then the journal event is written and the original result is returned
    And the quota is still held only once

  Scenario: Settling below the reservation charges the actual cost and releases the rest
    Given a reservation of 400 cents
    When the product settles it at 150 cents
    Then 150 cents are charged to the account and counted against that product
    And 250 cents are released and the hold is gone
    And repeating the settle returns the same result and charges nothing more

  Scenario: Settling exactly at the reservation releases nothing
    Given a reservation of 400 cents
    When the product settles it at 400 cents
    Then 400 cents are charged and nothing is released

  Scenario: A cost above the reservation is recorded only as an acknowledged overage
    Given a reservation of 400 cents
    When the product settles at 450 cents without acknowledging an overage
    Then the settle is refused, nothing is charged and the hold remains
    When the product settles at 450 cents and acknowledges the overage
    Then 450 cents are charged and 50 cents are recorded as overage in the account and the journal
    And the account's remaining quota may now be below zero, which refuses every new reservation

  Scenario: Releasing returns everything
    Given a reservation of 400 cents
    When the product releases it
    Then nothing is charged and the full 400 cents are available again
    And repeating the release returns the same result

  Scenario: A closed reservation cannot be closed again
    Given a reservation that was settled
    When the product settles or releases it again under a new operation ID
    Then the request is refused as not open and nothing is charged twice

  Scenario: Another product cannot settle or release the reservation
    Given a reservation made by one product
    When a different registered product tries to settle or release it
    Then the request is refused as the wrong product and the hold is unchanged

  Scenario: One allowance is shared by every app
    Given an account with an allowance of 1000 cents and two entitled products
    When the first product holds 600 cents
    Then the second product cannot reserve 500 cents
    And the account's usage is split by product in the CRM and the portal

  Scenario: Amounts must be whole cents
    When a request carries zero, a negative, a fractional, a string or an unsafe number as an amount
    Then it is refused as invalid and nothing is written
