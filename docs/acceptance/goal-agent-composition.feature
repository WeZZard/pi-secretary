@subagents @draft @SA-08
Feature: Compose independent delegation with goal management
  As a user recovering from a blocked goal,
  I want to delegate fresh work without resuming that goal,
  so that recovery and investigation remain available independently of automatic goal pursuit.

  @ACC-SA-08-10 @confirmed @recovery
  Scenario: Complete fresh delegated recovery while the goal stays blocked.
    Given a goal is blocked after a resumable child has finished its original assignment.
    When the user requests recovery beyond the original objective without resuming or classifying the goal work.
    And the parent launches a new child with Agent and gives the finished child a new assignment with SendMessage.
    Then the parent observes successful completion of both recovery assignments.
    And the resumed child retains its agent identity and uses a new run.
    And the goal remains blocked with the same objective and identity.
    And no automatic goal continuation is requested.

  @ACC-SA-08-11 @confirmed @compatibility
  Scenario: Install and use delegation without goal management.
    Given the standalone subagent extension is installed without a goal service or goal schema.
    When the user launches a resumable child and later gives it a new assignment.
    Then the parent observes successful completion of both assignments.
    And the child's usage and completion records remain available without an external accounting consumer.
    And no goal or composition schema is created implicitly.
