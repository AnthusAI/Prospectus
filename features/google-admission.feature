Feature: Google authenticates only explicitly invited Prospectus members
  Scenario: An invited member signs in through Google for the first time
    Given a local Cognito user with the approved email in prospectus-members
    And Google supplies that same verified email and trusted subject
    When the dedicated Prospectus pool receives the first Google sign-in
    Then the identity is linked to the existing member profile
    And no user or membership is created by the admission function

  Scenario: An uninvited or unverified Google account cannot enroll
    Given no unique enabled local member matches the verified Google email
    When the Google account attempts first sign-in
    Then the pre-sign-up trigger rejects admission before profile creation
    And no email-domain-wide or automatic group grant is made

  Scenario: Google credentials remain outside source and release artifacts
    When the backend is synthesized for review
    Then its Google provider references prospectus/proof/oauth/google client_id and client_secret
    And it creates no placeholder secret or OAuth client
    And deployment waits for the owner's registered Cognito idpresponse callback
