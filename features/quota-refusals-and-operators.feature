Feature: Quota fails closed, admins set plans, and customers see one number
  The quota routes refuse anything that is not a registered, entitled product asking about a known Account.
  Operators choose a plan or a per-Account override. The CRM and portal show a percent used, when it resets, and
  clear empty and unavailable states, and never any money. See docs/QUOTA.md.

  Scenario: An unknown Account is refused
    When a product calls a quota route for an Account that does not exist
    Then the request is refused as an unknown Account

  Scenario: An Account with no allowance is refused
    Given an Account with no plan, no override and no default plan in the table
    When a product reserves or checks
    Then the request is refused for no allowance

  Scenario: A product the Account is not entitled to is refused
    Given an Account entitled to one product and not another
    When the other product reserves or checks, or the entitlement is disabled
    Then the request is refused as not entitled

  Scenario: The store being unavailable means refusal
    Given the quota store cannot be read or written
    When a product reserves, settles, releases, records or checks
    Then the service answers that quota is unavailable and nothing is held, charged or released
    And the server client throws, so no caller reads it as permission to spend
    And the Account directory shows the quota as unavailable

  Scenario: Quota storage that is not configured refuses every call
    Given a deployment with no quota storage
    When a product calls any quota route
    Then it receives the unavailable answer

  Scenario: Callers that are not registered quota products are refused
    When a request arrives with no verified role, an unregistered role, a disabled registration, or a product without the quota flag
    Then it is refused before any Account or quota data is read
    And a reader site, a google-direct product, an execution role and the lab verifier can never hold the quota flag or use the routes

  Scenario: Unknown fields, methods and routes are refused
    When a request carries an unknown field, uses a method other than POST, or names an unknown route
    Then it is refused and nothing is written

  Scenario: An admin chooses a plan or an override
    Given an admin with the reviewed accounts:admin:quota permission
    When they choose a plan from the table, or a per-Account weekly allowance override, with an operation ID
    Then the Account's allowance follows, with the override winning over the plan
    And null clears either one
    And the journal records the operator's reviewed grant ID
    And repeating the call with the same operation ID changes nothing, and reusing it with other input is refused

  Scenario: Only admins with the reviewed quota permission may change a plan
    Given a person with operator read access only, with only the entitlements permission, or an Account owner
    When they try to change a plan or override
    Then the request is refused
    And unknown plans, malformed plans, negative or fractional overrides, an empty change and unknown fields are refused

  Scenario: Nothing in the portal or CRM edits quotas, plans or rates
    Then neither surface has a control to add quota, change a plan, or edit a rate or allowance
    And quota changes are made only through the admin route
    And rates and allowances are written programmatically by a deployment, not by anyone by hand

  Scenario: The portal shows one number and no money
    Given a signed-in member of an Account with a weekly quota
    Then the header shows the percent of the weekly quota used
    And Home shows a weekly quota card and Usage shows the percent, when it resets and each app's share in percent
    And no page shows a dollar amount, a rate, units or per-item amounts

  Scenario: Near and at 100 percent
    Given an Account at 96 percent, then at 100 percent
    Then the portal and CRM show the percent and the reset time
    And at 100 percent they say new work is paused until the quota resets

  Scenario: An Account with no quota shows an empty state
    Given an Account with no allowance
    Then members and staff read that no weekly quota has been set and apps cannot start paid cloud work
    And no zero or invented figure is shown

  Scenario: Unreadable quota is shown as unavailable
    Given the store or rate table cannot be used
    Then the page says the quota could not be read and that apps cannot spend meanwhile

  Scenario: Staff see more than customers, but never the table
    When staff open the Account in the CRM
    Then they also see the plan, the override, internal usage units, any overshoot and the table versions charged
    And the rate table's contents are never shown

  Scenario: A product reads and writes quota through the server client
    Given a product's server role with temporary credentials
    When it uses the accounts client's server entry to reserve, settle, release, record and check
    Then each call is signed with SigV4 and carries no person or token
    And static or expired credentials are refused before anything is sent
    And a refusal, a store failure, a timeout or an unexpected response throws
