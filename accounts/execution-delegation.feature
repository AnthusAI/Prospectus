Feature: Explicit execution principal continuation of an enrolled human session
  A product may register one reviewed execution principal without changing the
  original enrollment binding or granting enrollment authority to that principal.

  Scenario: Paired worker continues the original BFF session
    Given a reviewed product, issuer, client, enrollment policy and BFF principal
    And one explicitly reviewed execution principal paired to that exact binding
    And a committed session enrolled by the BFF
    When the worker presents the original valid access token to identities/me
    Then the original Person is returned without changing enrollment provenance
    And account authorization checks current membership, role and product entitlement

  Scenario Outline: Execution authority cannot become enrollment or management authority
    Given an explicitly paired worker and a valid enrolled human token
    When the worker attempts <operation>
    Then the request is forbidden before identity or account side effects
    Examples:
      | operation |
      | challenge or Google resolve |
      | legacy identity resolve or link |
      | account list, detail or creation |
      | membership read or write authorization |
      | membership mutation or account directory access |
      | a method or path outside the exact execution allowlist |

  Scenario Outline: Invalid continuation never acquires execution authority
    Given <failure>
    When a worker attempts session continuation or account authorization
    Then no execution is authorized
    Examples:
      | failure |
      | unknown role or unlisted role pair |
      | disabled product or removed delegation |
      | another product, issuer or client |
      | changed enrollment policy revision |
      | an unenrolled or different authentication/session family |
      | expired or forged access token |
      | revoked membership or disabled product entitlement |
      | missing canonical identity or unavailable persistence |

  Scenario: Delegations do not chain or introduce ambiguous callers
    Given a registry with duplicate products or colliding enrolling/executing roles
    Or a pair whose enrollment principal, issuer, client or policy differs from its product
    Or an absent delegation review identifier
    When the registry is loaded
    Then configuration is rejected before requests are served

  Scenario: Canonical persistence preserves the original binding across restart
    Given a BFF enrollment and an account stored through the native Virtuus bridge
    When the handler restarts with the same explicitly reviewed pair
    Then the worker continues that session and authorizes only current account access
    And removing the pair denies the next request
    And existing products without delegation retain their original behavior
