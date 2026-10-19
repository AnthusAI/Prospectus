Feature: Find a person's accounts without reading every account
  Scenario: Indexed lookup reads only the person's accounts
    Given a person who belongs to two accounts among many others
    When the person's accounts or account directory are listed with indexed lookup
    Then only that person's membership markers and those two account documents are read
    And the listing works past the 256-account limit of the full scan

  Scenario: The canonical account document stays the authority
    Given a person whose membership was revoked, or whose marker points at an account that never published
    When the person's accounts are listed
    Then that account is not listed, because every candidate is checked against its account document

  Scenario: Rolling out the index to existing accounts
    Given accounts created before membership markers existed
    When the marker-writing code is deployed in scan mode and the index is rebuilt
    Then indexed lookup returns exactly what the full scan returns
    And deployment.json switches membershipLookup from scan to indexed only after the rebuild
