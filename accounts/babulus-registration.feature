Feature: Register Babulus as a quota product through deployment options
  Babulus sells voiceover and video made on the customer's own machine first. Its cloud fallback runs only after
  Prospectus reserves quota, so Prospectus must know the Babulus server role, and must trust only the Babulus sign-in.

  Scenario: Babulus is not registered until it is switched on
    Given no Babulus deployment options are set
    When the accounts plane is built
    Then no product named babulus exists
    And no role may call a quota route on Babulus's behalf

  Scenario: A reviewed registration
    Given the Babulus server role, its Google-only Cognito issuer and app client, and the reviewed federation ID are supplied as deployment options
    When the accounts plane is built
    Then Babulus is registered as a Google-only product with the quota flag
    And its role may read identities and accounts, and authorize an operation on an account
    And its role may reserve, settle, release, record and check quota, and nothing else
    And its role may not create accounts or change memberships

  Scenario: An optional quota caller role
    Given the deployment options also name a second role, such as a spending gate, as the quota caller
    When the accounts plane is built
    Then that role may call the five quota routes as Babulus
    And it may not call identity or account routes
    And only the quota statement of the resource policy names it
    And PROSPECTUS_BABULUS_QUOTA_ROLE_ARN supplies it when set

  Scenario Outline: Unreviewed options are refused
    Given the Babulus deployment options have <problem>
    When the accounts plane is built
    Then the build is refused with a message naming the rule
    And nothing is registered
    Examples:
      | problem                                   |
      | a role that is not an IAM role            |
      | an issuer that is not a Cognito user pool |
      | a client ID that is not an app client     |
      | no federation review ID                   |
      | an unknown extra option                   |
      | a quota caller that is not an IAM role    |

  Scenario: No values are kept in the repository
    Given the Babulus registration
    Then the role, issuer, client and review ID come only from the deployment environment
    And the repository holds no account, role or client identifier for Babulus

  Scenario: Babulus appears in the portal
    Given a person with an Account entitled to babulus
    When the person opens the Account's apps
    Then Babulus is listed by name and opens its public address
