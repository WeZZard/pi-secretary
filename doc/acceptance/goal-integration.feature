@subagents @draft @SA-08
Feature: Integrate delegated work with the originating goal
  As a user with a goal,
  I want truthful usage and current authorization,
  so that background results cannot revive obsolete work or charge a different objective.

  @ACC-SA-08-01 @proposed
  Scenario Outline: Apply the established goal-budget token formula to normalized child usage.
    Given an active goal has zero goal-budget token usage and enough remaining budget.
    And an attributed child reports a unique normalized usage event with these synthetic values:
      | inputTokens       | <input>  |
      | cachedInputTokens | <cached> |
      | outputTokens      | <output> |
    When the event is accounted using max(inputTokens - cachedInputTokens, 0) + max(outputTokens, 0).
    Then the goal-budget token usage is <expected> tokens under that formula.

    Examples:
      | input | cached | output | expected |
      | 100   | 40     | 20     | 80       |
      | 100   | 100    | 20     | 20       |
      | 0     | 0      | 20     | 20       |

  @ACC-SA-08-02 @proposed @recovery
  Scenario: Do not charge the same child usage twice.
    Given a child usage event has already been applied to its originating goal.
    When the same event is received again or recovered after restoration.
    Then that event does not increase goal-budget token usage again.
    And foreground tool usage reporting does not apply an additional charge for the same child event.

  @ACC-SA-08-03 @proposed
  Scenario: Do not charge a replacement goal for old child work.
    Given a child run was authorized by goal A.
    And goal A has been cleared and replaced by goal B.
    When a late usage event arrives from that child.
    Then goal B's usage is not increased by that event.
    And the child's run history retains the usage evidence.
    And goal A is not recreated.

  @ACC-SA-08-04 @proposed
  Scenario: Keep resource facts even when a goal is paused.
    Given a child was authorized while its originating goal was active.
    And the user then paused that same goal.
    When eligible late usage from already-started work arrives.
    Then the usage is attributed to that originating goal under the existing accounting rules.
    And the usage event does not authorize new ordinary child work or resume the goal.

  @ACC-SA-08-05 @proposed
  Scenario: Do not equate child completion with goal completion.
    Given a child is investigating one part of an active goal.
    When the child finishes successfully.
    Then its result is available to the parent.
    And the goal is not automatically marked complete.
    And the parent must still satisfy the existing goal completion contract.

  @ACC-SA-08-06 @proposed
  Scenario Outline: Respect newer intent when a background result arrives.
    Given a child was launched under an earlier goal instruction.
    And the user has since <decision>.
    When the child's result arrives.
    Then the result remains available as historical task evidence.
    And it does not undo the newer decision or authorize further work under the obsolete instruction.
    And it does not independently request automatic continuation of obsolete goal work.

    Examples:
      | decision                         |
      | paused the goal                  |
      | changed the goal objective       |
      | cleared the goal                 |
      | replaced the goal                |

  @ACC-SA-08-07 @proposed
  Scenario: Wait for material child progress instead of repeatedly delegating.
    Given the parent has outstanding children attributed to its active goal.
    And a current continuation has already informed the parent of that work.
    And the parent yielded without starting independent work.
    When repeated idle signals occur without a child state change or new user input.
    Then no repeated automatic continuation or duplicate delegation is requested for the same outstanding work.
    And the user can still explicitly request unrelated parent work.

  @ACC-SA-08-08 @proposed
  Scenario: Prevent further ordinary work after goal-budget exhaustion.
    Given a child is executing under an active goal's authority.
    When eligible usage exhausts that goal's token budget.
    Then subsequent ordinary child actions under that authority are refused at the next supported model or tool boundary.
    And available partial output is retained.
    And any permitted budget summary reports results without ordinary task tools.
    And already-started side effects are not described as rolled back.

  @ACC-SA-08-09 @proposed
  Scenario: Keep unattributed delegation separate from goal accounting.
    Given the parent has no current goal.
    When the user explicitly asks for a delegated task and the child runs.
    Then no goal is created implicitly.
    And the child's usage remains available in its run history without being assigned to a nonexistent goal.
