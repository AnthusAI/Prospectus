Feature: Amplify owns a separate private Prospectus application
  Scenario: The backend is deployed from reviewed dependency commits
    Given a public MIT-licensed Prospectus source commit with full Kanbus and Virtuus revision pins
    When Amplify builds main in papyrus-production account 712236451410
    Then it compiles the real Rust Lambda and deploys the Gen2 custom backend
    And the frontend configuration comes from that backend's generated outputs

  Scenario: Existing marketing and canonical records remain separate
    When the Prospectus backend template is synthesized
    Then it contains one private canonical S3 bucket and metadata catalog
    And it contains dedicated Cognito authorization-code authentication and member protection
    And it contains no marketing distribution, alternative CodePipeline or GraphQL API

  Scenario: Persistent provisioning waits for concrete approval
    Given the complete Amplify and CDK bootstrap IAM delta has not been approved
    When the deployment proposal is prepared
    Then local compilation, resource tests and review synthesis can complete
    And no app, role, user, source connection or DNS record is provisioned

  Scenario: Main is the deployment branch for the shared CRM
    Given the replacement Amplify app is d15sc1sptohtqb in us-east-1
    When its main branch builds the reviewed Prospectus source
    Then the scope guards accept that exact app, account, region and branch
    And the existing Cyclotron proof branch remains unchanged
    And a different branch fails the replacement deployment scope check
