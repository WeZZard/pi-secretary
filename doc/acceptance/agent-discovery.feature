@subagents @draft @SA-13
Feature: Discover delegation types from current application state
  As a user,
  I want installed agent definitions to be available automatically,
  so that the parent need not inspect definition files before delegating.

  @ACC-SA-13-01 @confirmed
  Scenario: Discover a custom definition before any child launch.
    Given a valid custom agent definition is installed.
    When the parent sends its first model request.
    Then the request contains the exact custom type and description.
    And no parent filesystem tool call is needed to discover that type.
    And the saved user message contains no injected reminder.

  @ACC-SA-13-02 @proposed @concurrency
  Scenario: Keep the definition advertised to an issued response.
    Given the parent model has received a custom definition in its catalog.
    And the definition changes while that response is being generated.
    When the response launches two instances of that type.
    Then both children use the originally advertised definition.
    And the next model request advertises the edited definition.

  @ACC-SA-13-03 @proposed @recovery
  Scenario: Reject incomplete discovery and recover after correction.
    Given a custom definition has invalid source content.
    When the parent attempts a fresh delegation.
    Then the call fails without a child provider request.
    And the catalog is explicitly unavailable rather than partially ready.
    When the source is corrected and the parent makes a new request.
    Then the corrected definition can launch successfully.
