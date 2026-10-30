Feature: Remote CLI sign-in through cli-login
  An agent on a machine with no browser runs `prospectus login --remote`. A person approves on any device and signs
  in with Google through the CRM's own Cognito client. The CLI receives its own tokens; the broker never holds one.

  Scenario: The CRM client accepts the remote CLI callback in production only
    When the Prospectus backend template is synthesized
    Then the CRM browser client's callbacks are the browser callbacks plus https://prospectus.anth.us/cli/callback
    And no localhost origin has a CLI callback
    And the client's flows, scopes and identity providers are unchanged

  Scenario: Discovery names everything a CLI needs and nothing secret
    When a CLI reads https://prospectus.anth.us/cli/discovery
    Then it receives the issuer, client ID, OAuth domain, token endpoint and API endpoint
    And it receives the broker endpoint, the remote callback URI and the enrollment endpoint
    And the answer is not cached and holds no secret

  Scenario: The approval page shows the matching code before anything is bound
    Given a CLI started a remote sign-in and printed its approval URL and matching code
    When the person opens the approval URL
    Then the page shows the requester, the matching code, the target and Approve and Deny
    And nothing is bound to the transaction

  Scenario: Approving binds an enrollment challenge to the transaction
    Given the person confirms that the code matches and approves
    When the page asks the accounts service for a login challenge bound to sha256 of the transaction
    Then the broker binds the challenge nonce and the signed challenge as the enrollment string
    And the browser is sent to Google sign-in with that nonce and the transaction's PKCE challenge

  Scenario: The accounts service is unavailable when the person approves
    Given the login challenge cannot be issued
    When the person approves
    Then nothing is bound and the page says sign-in is unavailable and can be retried

  Scenario: The callback completes the transaction for the waiting CLI only
    Given the person signed in with Google
    When the provider returns to /cli/callback
    Then the page checks the nonce cookie and completes the transaction in the broker
    And only the CLI holding the poll secret and the PKCE verifier can collect and redeem the code

  Scenario: Each CLI login is enrolled like a browser sign-in
    Given the CLI exchanged the code for its access and ID tokens
    When it posts the signed challenge, its ID token and the transaction as login state to the identity resolve route
    Then the accounts service resolves the same Person as that human's browser sign-in
    And only then does the CLI store its session

  Scenario: A tampered or misdirected enrollment string is refused
    When the enrollment string is altered or presented with another transaction
    Then the accounts service refuses it and the CLI stores nothing

  Scenario: The pages reach only the broker
    When the pages function's role is synthesized
    Then it may invoke only the configured broker function and write its own logs
    And it has no access to the accounts service, the canonical bucket or the catalog

  Scenario: prospectus.anth.us serves the pages through one rewrite owned by the backend
    When the backend with remote CLI sign-in is deployed
    Then the Amplify app d15sc1sptohtqb has a 200 proxy rewrite from /cli/<*> to the CRM API's /cli/<*>
    And that rule comes before the single-page-app rewrite
    And every other rule on the app is left exactly as it was
    And removing remote CLI sign-in removes only that rule

  Scenario: The rewrite helper can change only the CRM's Amplify app
    When the rewrite helper's role is synthesized
    Then it may read and update only the Amplify app d15sc1sptohtqb and write its own logs
    And it cannot pass a role, touch a branch or reach any other app
