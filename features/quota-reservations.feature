Feature: Reserve, settle and release weekly quota for expensive work
  An Account has one weekly quota shared by every app. A product reports billable items, never money, and
  Prospectus converts them to internal usage with a private rate table. For expensive work (AWS Batch, renders)
  a product reserves from the estimated maximum items, settles with the actual items, and releases if nothing ran.
  Every call carries a client-generated operation ID so a retry is safe, and every failure denies spending.
  The made-up table used by these specs has a default plan of 1000 units a week. See docs/QUOTA.md.

  Scenario: A reservation within this week's remaining quota succeeds
    Given an Account on a plan of 1000 units a week and a product it is entitled to
    When the product reserves items that convert to 300 units
    Then the reservation succeeds and names its reservation ID and expiry
    And a check reports 30 percent used
    And the response contains no units, rates or amounts

  Scenario: A reservation that does not fit is refused
    Given an Account with 600 units used or held
    When a product reserves items that convert to 402 units
    Then the reservation is refused as insufficient and nothing is written
    And items that convert to 399 units still fit

  Scenario: At 100 percent every new reservation is refused
    Given an Account whose used and held usage has reached its weekly allowance
    When a product reserves anything, even items that convert to zero units
    Then the reservation is refused as exhausted
    And a check answers that new work is not allowed and reports 100 percent

  Scenario: Concurrent reservations cannot overspend
    Given an Account with a weekly allowance of 1000 units
    When several processes reserve 300 units at the same moment
    Then at most three reservations succeed
    And the losers are refused or asked to retry, never granted

  Scenario: A retry with the same operation ID returns the same result
    Given a product that reserved and did not see the response
    When it repeats the reserve with the same operation ID and body
    Then it receives the original result and the quota is held once
    And the original answer is returned even if the remaining quota has since changed

  Scenario: The same operation ID with a different request is refused
    Given an operation ID already used for one reservation
    When it is reused with other items, or by another product
    Then the request is refused as an idempotency conflict and nothing changes

  Scenario: A crash between the week's write and the journal write is repaired by the retry
    Given a reservation whose write committed but whose journal write failed
    When the product repeats the same call
    Then the journal event is written and the original result is returned
    And the quota is held only once

  Scenario: Settling charges the actual items and releases the hold
    Given a reservation estimated at 300 units
    When the product settles it with items that convert to 120 units
    Then 120 units are charged to the Account and counted against that product
    And the hold is gone and the rest returns to the week's quota
    And repeating the settle returns the same result and charges nothing more

  Scenario: Work that cost more than it reserved is recorded in full
    Given a reservation estimated at 300 units
    When the product settles with items that convert to 1500 units
    Then the full 1500 units are recorded, never refused or capped
    And the overshoot past the allowance is recorded internally
    And the display stays at 100 percent and new work is refused

  Scenario: Releasing returns everything and charges nothing
    Given a reservation
    When the product releases it
    Then nothing is charged and the whole hold returns to the week's quota
    And repeating the release returns the same result

  Scenario: A closed reservation cannot be closed again
    Given a reservation that was settled
    When the product settles or releases it again under a new operation ID
    Then the request is refused as not open and nothing is charged twice

  Scenario: Another product cannot settle or release the reservation
    Given a reservation made by one product
    When a different registered product tries to settle or release it
    Then the request is refused as the wrong product and the hold is unchanged

  Scenario: An abandoned reservation frees its quota at expiry
    Given a reservation with a ten-minute lifetime that holds nearly the whole week's quota
    When ten minutes pass and no one settles or releases it
    Then it no longer counts, with no sweeper and no action by an operator
    And a late settle still records what the work really used

  Scenario: Expired holds are dropped only when the record needs room
    Given a week's record filled with expired reservations
    When a new reservation needs the room
    Then the oldest expired entries are dropped after a journal event records each one
    And active reservations are never dropped
    And a record full of active reservations refuses a new one

  Scenario: One quota is shared by every app
    Given an Account with two entitled products
    When the first product holds most of the week's quota
    Then the second product cannot reserve more than what remains
    And the customer sees each app's share as a percent of the quota

  Scenario: Malformed requests are refused
    When a request has no items, an item with an extra field, a malformed kind, or a fractional, negative or oversized quantity
    And a lifetime that is zero, fractional or longer than the service allows
    Then it is refused as invalid and nothing is written
