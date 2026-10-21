Feature: The Cyclotron lab verifies Papyrus site editors without gaining any other authority
  The Cyclotron lab BFF receives a Papyrus editor's Cognito access token from a Papyrus site. It may ask
  Prospectus exactly two questions with a dedicated verifier role: who is this person, and may this person
  perform an operation on this account. The Papyrus token proves identity only. Lab authority comes from the
  person's active membership in an account that has the cyclotron product active.

  Background:
    Given a reviewed verifier role in the Cyclotron account
    And the reviewed Papyrus site registry in accounts/papyrus-sites.json
    And the verifier is enabled in accounts/lab-verifier.json

  Scenario: A registered Papyrus site token is accepted on the two routes
    Given an editor signed in at a registered Papyrus site and enrolled by that site
    And the editor is an active member of an account with the cyclotron product active
    When the verifier calls GET identities/me with the editor's access token
    Then the editor's own Person is returned
    When the verifier calls POST accounts/{account}/authorize for console:read
    Then the result names the account, the Person, the product cyclotron, the membership role and the revision

  Scenario Outline: Only tokens of a registered Papyrus site are accepted
    Given an otherwise valid access token from <source>
    When the verifier calls GET identities/me
    Then the request is refused as unverifiable identity evidence
    And the response does not reveal which issuers or clients are registered
    Examples:
      | source |
      | the CRM user pool |
      | the Cyclotron console user pool and client |
      | a Google ID token as used by Anthus One |
      | an unregistered Cognito pool |
      | a registered Papyrus pool with an unregistered client |
      | a registered site with an expired, forged or tampered signature |
      | a registered site's ID token instead of its access token |

  Scenario: A site added to papyrus-sites.json is accepted without a second list
    Given a new reviewed entry in the Papyrus site registry
    When the registry loads
    Then the verifier accepts that site's tokens and no other list names it

  Scenario Outline: The verifier cannot call anything else
    When the verifier calls <call>
    Then the request is forbidden before any identity or account side effect
    Examples:
      | call |
      | identity challenge, Google resolve or legacy resolve |
      | account list, detail or creation |
      | membership read or write |
      | the account directory or operator routes |
      | any other method or path |

  Scenario Outline: Authority is the intersection of membership role, cyclotron entitlement and the verifier
    Given the editor's role is <role>
    When the verifier asks to authorize <operation>
    Then the answer is <answer>
    Examples:
      | role   | operation     | answer  |
      | owner  | console:read  | allowed |
      | owner  | console:write | allowed |
      | admin  | console:write | allowed |
      | member | console:write | allowed |
      | viewer | console:read  | allowed |
      | viewer | console:write | refused |
      | owner  | members:read  | refused |
      | owner  | members:write | refused |

  Scenario Outline: Authorization is refused without both a current membership and a cyclotron entitlement
    Given <situation>
    When the verifier asks to authorize console:read
    Then the answer is the same generic refusal
    Examples:
      | situation |
      | the editor is not a member of the account |
      | the membership is revoked |
      | the account has no cyclotron entitlement |
      | the cyclotron entitlement is disabled |
      | only the Papyrus site product is entitled |
      | the account does not exist |

  Scenario: The verifier cannot enumerate accounts or people
    Given a valid editor token
    When the verifier probes accounts the editor does not belong to, unknown accounts and other people
    Then every probe is refused with the same status and message
    And identities/me returns only the token holder's own Person

  Scenario: The verifier does not weaken existing registrations
    Given the cyclotron and Papyrus site registrations
    When the verifier is registered
    Then role names remain unique across every registration, the verifier included
    And the API resource policy allows the verifier role only the two routes
    And every other principal is still denied
    And the verifier is unregistered when it is not enabled
