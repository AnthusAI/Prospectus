Feature: Write the private quota rate table from a script a person runs
  The real rate table lives outside this repository. A person with the deployment identity writes it to the
  parameter with one script, and the script refuses anything that would leave quota unusable or write to the wrong
  place. It never prints the values.

  Scenario: A valid table is written to the one parameter
    Given a values file that the repository's own rate table parser accepts
    And the signed-in account is the account named by --account
    When the script runs
    Then the table is written as an overwriting Advanced SecureString to /prospectus/central-accounts/quota-rate-table/v1
    And only the new parameter version number is printed
    And none of the values are printed

  Scenario: The wrong account is refused
    Given the signed-in account is not the account named by --account
    When the script runs
    Then it exits with status 2 and nothing is written

  Scenario: An invalid table is refused
    Given a values file the rate table parser rejects
    When the script runs
    Then it exits with status 2 and nothing is written

  Scenario: Placeholders are refused
    Given the example file, which still contains placeholders
    When the script runs
    Then it exits with status 2 and nothing is written

  Scenario: Missing or malformed arguments are refused
    When the account is not 12 digits, or the values file is missing, or an unknown argument is given
    Then it exits with status 2 and nothing is written
