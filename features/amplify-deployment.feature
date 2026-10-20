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

  Scenario: Local development uses the deployed backend with real sign-in
    Given a developer logged in to papyrus-production on their own machine
    When they run npm run dev:cloud
    Then the deployed main branch's public outputs are read once and cached in the ignored .build directory
    And Vite serves the working tree at http://localhost:5417 with instant reload
    And Google sign-in completes through the deployed Cognito client and returns to localhost
    And the deployed API and accounts service accept requests from that origin
    And nothing is deployed and no cloud environment is created
