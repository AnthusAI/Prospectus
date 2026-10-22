Feature: Register each Papyrus site through reviewed configuration
  Scenario: A reviewed site registration
    Given a site's server role, Google-only Cognito issuer, app client and reviewed federation and site review IDs
    When the site is added as one entry in accounts/papyrus-sites.json and deployed
    Then that role may call Prospectus only as that site and only on the site routes
    And the site may read the person's account directory to answer Cyclotron Lab access
    And the site may not create accounts or change memberships

  Scenario: A public-reader site
    Given a reviewed site entry with audience public-reader
    When the site is registered
    Then the site may enroll its readers and read their own profile through the identity routes
    And it identifies each reader by a pairwise site subject and never receives the Person ID (see site-subjects.feature)
    And it holds no capabilities, so it cannot list accounts, authorize an operation or read the account directory
    And the lab verifier does not trust its tokens

  Scenario: Ambiguous or unreviewed site entries
    Given a site entry with extra fields, a missing review, a non-Papyrus product name or a role shared with another registration
    When the registry loads
    Then synthesis and the runtime both refuse it

  Scenario: Many sites
    Given up to 40 registered sites, more than the old limit of 20
    When the registry loads and the API access policy is synthesized
    Then every site remains exactly registered and the access policy stays within the API Gateway size limit
