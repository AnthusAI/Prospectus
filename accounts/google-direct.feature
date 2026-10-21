Feature: Anthus One signs in with Google directly, with no Cognito pool
  The customer portal gets a Google ID token in the browser and sends it to its own accounts BFF. Central
  Accounts verifies Google's signature itself and resolves the same Prospectus Person as the Cognito path.

  Scenario: A Google ID token for the same Google account resolves the same Person as a Cognito pool
    Given a Person already enrolled through a Cognito-backed product
    And the portal is registered as a google-direct product with its own role and Google client
    When the portal enrolls with a fresh challenge nonce and a Google ID token for the same Google subject
    Then the same Person is returned
    And later requests with any unexpired token for that subject resolve that Person without a new challenge

  Scenario: A first Google sign-in enrolls a new Person and grants no access
    Given no Person exists for a Google subject
    When the portal enrolls with a fresh challenge nonce
    Then a Person is created and no membership or entitlement is created

  Scenario Outline: Invalid Google evidence is refused
    Given <failure>
    When the BFF or central Accounts verifies the token
    Then the request is refused as invalid identity evidence
    Examples:
      | failure |
      | a signature from a key Google does not publish |
      | the wrong issuer |
      | the wrong audience, or an audience list |
      | an expired token, or one issued in the future |
      | an email that Google has not verified |
      | a token with no nonce |
      | alg other than RS256 or an embedded key |
      | a Cognito token presented to the portal, or a Google token presented to the CRM |

  Scenario: Enrollment needs a fresh server challenge
    Given a valid Google ID token whose nonce is not the issued challenge nonce
    Or a token issued more than 300 seconds before enrollment
    Or a challenge bound to another login state
    Then enrollment is refused and no Person or alias is written

  Scenario: The portal reaches customer routes only
    Given a valid portal session
    When it requests an operator route, an entitlement change, or any unregistered path
    Then the BFF refuses it before calling central Accounts
    And central Accounts also refuses operator reads for a google-direct product
