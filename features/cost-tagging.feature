Feature: Every app tags every resource the same way
  A shared CDK helper applies the anthus: cost tags to every taggable resource in a stack from the stack's own
  configuration, and a check fails a synthesized stack that misses them. Nobody tags by hand.

  Scenario: The helper tags a per-customer stack
    Given a stack configured with account "<uuid>", app "papyrus" and deployment "example"
    When the cost tagging helper is applied and the stack is synthesized
    Then every taggable resource carries anthus:account "<uuid>", anthus:app "papyrus", anthus:deployment "example"
    And anthus:cost-key "<uuid>/papyrus/example"

  Scenario: A shared stack
    Given a stack configured as shared for app "cyclotron"
    Then every taggable resource carries anthus:account "shared" and anthus:cost-key "shared/cyclotron/"

  Scenario: Invalid configuration fails synthesis
    Given an app not in the fixed list, an account that is neither a UUID nor "shared", or a deployment with characters outside lower-case letters, digits and hyphens
    When the stack is synthesized
    Then synthesis fails with a message naming the field

  Scenario: The check fails an untagged resource
    Given a synthesized template with a taggable resource missing anthus:app or anthus:account
    When the cost tag check runs in CI
    Then it fails and names the resource's logical ID and type

  Scenario: Existing tags stay
    Given a stack that already tags anthus:project
    Then anthus:project is unchanged

  Scenario: Cost allocation tags are activated by code
    When the management account's cost stack is deployed
    Then anthus:account, anthus:app, anthus:deployment and anthus:cost-key are active cost allocation tags

  Scenario: A per-customer stack names no customer
    Given a Papyrus site stack tagged with account "owner" and deployment "example"
    When the daily import reads its cost
    Then it is charged to the one Account holding the active papyrus-example entitlement
    And with no such Account, or more than one, it is recorded as overhead
