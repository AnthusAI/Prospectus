Feature: Refused central Accounts requests leave a reason in the server log
  A refusal is visible to operators without exposing who made the request. Every refused request writes exactly one
  structured JSON log line. Nothing personal is logged: no tokens, subjects, emails, names, Person IDs or raw paths.

  Scenario: A rule refusal logs its status, code and static message
    Given an identity, account or directory request is refused with an Accounts error
    When the service returns the refusal
    Then one log line is written with event "accounts.refusal", the route template, status, code and message
    And the response body is unchanged

  Scenario: An unexpected failure logs only the error class
    Given a request fails with an unexpected error
    When the service returns 503
    Then one log line is written with event "accounts.unavailable", the route template, the error name and any error code
    And no stack, error message or request data is logged

  Scenario Outline: Routes are logged as templates
    Given a refused request to <path>
    Then the logged route is <route>
    Examples:
      | path                                                                  | route                                                                  |
      | POST /v1/identities/google/resolve                                    | POST /v1/identities/google/resolve                                    |
      | POST /v1/accounts/<account id>/authorize                              | POST /v1/accounts/{account}/authorize                                 |
      | GET /v1/account-directory/operator/accounts/<account id>             | GET /v1/account-directory/operator/accounts/{account}                 |
      | POST /v1/account-directory/operator/accounts/<id>/entitlements/<product> | POST /v1/account-directory/operator/accounts/{account}/entitlements/{product} |
      | GET /v1/anything-else/<free text>                                     | GET {unrecognized}                                                     |

  Scenario: Successful requests are not logged as refusals
    Given a request succeeds
    Then no refusal log line is written
