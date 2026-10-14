Feature: Amplify owns a separate private Prospectus application
  Scenario: The backend is deployed from reviewed dependency commits
    Given a private Prospectus source commit with full Kanbus and Virtuus revision pins
    When Amplify builds its reviewed production branch in cyclotron-production
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
