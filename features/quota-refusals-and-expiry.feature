Feature: Quota fails closed and abandoned reservations free their quota
  A reservation never leaks quota forever and never succeeds when anything is wrong. Expiry is a fact of time:
  there is no sweeper to run and nothing for an operator to do. See docs/QUOTA.md.

  Scenario: An abandoned reservation stops holding quota when it expires
    Given an account whose whole allowance is held by a reservation with a ten-minute lifetime
    When ten minutes pass and no one settles or releases it
    Then the account's remaining quota is the whole allowance again
    And a new reservation succeeds without any action by an operator

  Scenario: Settling an expired reservation records the real cost as an acknowledged overage
    Given a reservation that expired
    When the product settles it without acknowledging an overage
    Then the settle is refused as expired and nothing is charged
    When the product settles it and acknowledges the overage
    Then the whole actual cost is charged as overage with the status settled late
    And nothing is released, because the expired hold already returned its quota

  Scenario: Releasing an expired reservation is harmless
    Given a reservation that expired
    When the product releases it
    Then the release succeeds, nothing is charged and no hold remains

  Scenario: Expired entries are dropped only when the record needs room
    Given an allowance record filled with expired reservations
    When a new reservation needs the room
    Then the oldest expired entries are dropped after a journal event records each one
    And active reservations are never dropped
    And settling a dropped reservation is refused as not open

  Scenario: A full record of active reservations refuses a new one
    Given an allowance record full of reservations that have not expired
    When another is requested
    Then it is refused for capacity and no active hold is lost

  Scenario: An unknown account is refused
    When a product reserves quota for an account that does not exist
    Then the request is refused as an unknown account

  Scenario: An account with no allowance, or an allowance of zero, is refused
    Given an account no operator has granted quota to
    When a product reserves any amount
    Then the request is refused for no allowance
    And an allowance of zero covers no reservation either

  Scenario: A product the account is not entitled to is refused
    Given an account entitled to one product and not another
    When the other product reserves quota, or the entitlement is disabled
    Then the request is refused as not entitled

  Scenario: The store being unavailable means refusal
    Given the quota store cannot be read or written
    When a product reserves, settles or releases
    Then the service answers that quota is unavailable and nothing is held, charged or released
    And the server client throws, so no caller reads it as permission to spend
    And the account directory shows the quota as unavailable, never as zero or unlimited

  Scenario: Quota storage that is not configured refuses every call
    Given a deployment with no quota storage
    When a product calls any quota route
    Then it receives the unavailable answer

  Scenario: Callers that are not registered quota products are refused
    When a request arrives with no verified role, an unregistered role, a disabled registration, or a product without the quota flag
    Then it is refused before any account or quota data is read
    And a reader site, a google-direct product, an execution role and the lab verifier can never hold the quota flag or use the routes

  Scenario: Unknown fields, methods and routes are refused
    When a quota request carries an unknown field, uses a method other than POST, or names an unknown route
    Then it is refused and nothing is written

  Scenario: Quota records stay apart from billing and accounts
    Given any quota activity
    Then the files written are only allowances and journal events under the quota project
    And no billing or account record is read as authority or written
