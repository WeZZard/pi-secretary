@subagents @draft @SA-01
Feature: Delegate work through Claude Code-style tools
  As a parent agent,
  I want to delegate a task to an independently controlled child,
  so that I can use its result without replacing my own conversation.

  @ACC-SA-01-01 @confirmed @compatibility
  Scenario: Expose the canonical launch tool without adopting either reference extension's API.
    Given Secretary subagent support is enabled without tool-name collisions.
    When the parent model receives the available delegation tools.
    Then the launch tool is named "Agent".
    And its required task fields are "prompt" and "description".
    And it does not advertise "task", "agent", "inherit_context", or "resume" as launch fields.

  @ACC-SA-01-02 @proposed
  Scenario: Return control after accepting a background launch.
    Given the parent is in a TUI session.
    And an enabled resumable agent can start with the requested model.
    When the parent calls "Agent" with "run_in_background" set to true.
    And the child remains running at a controlled execution point.
    Then the tool returns an agent identifier and a run identifier before the child finishes.
    And the result identifies the resolved model and output path.
    And the result does not claim that the delegated task is complete.
    And the parent remains able to handle independent work.

  @ACC-SA-01-03 @proposed
  Scenario: Wait for a foreground launch to finish.
    Given an enabled agent can start with the requested model.
    When the parent calls "Agent" with "run_in_background" set to false.
    Then the tool does not return a final result while the child is still executing.
    When the child finishes successfully.
    Then the tool returns the final output and execution identifiers.
    And no duplicate background completion turn is requested for that result.

  @ACC-SA-01-04 @proposed
  Scenario: Keep delegated context separate from the parent conversation.
    Given the parent conversation contains a unique sentence that is not in the task or project instructions.
    And the project has applicable instructions for child work.
    When the parent launches a fresh child with an explicit task.
    Then the child receives the task and applicable project instructions.
    And the child does not receive the unique sentence from the parent conversation.
    And the parent's conversation, model, and tools remain unchanged by child initialization.
    And no goal is created implicitly.

  @ACC-SA-01-05 @proposed
  Scenario Outline: Reject an invalid launch without silently substituting another agent or model.
    Given a launch request has <problem>.
    When the parent calls "Agent" with that request.
    Then the tool reports <diagnostic>.
    And no provider request or worktree allocation occurs for the rejected launch.

    Examples:
      | problem                                  | diagnostic                                      |
      | an unknown explicit agent type           | that the requested agent type is unavailable     |
      | an unavailable resolved model            | that the selected model cannot be used           |
      | an empty task prompt                     | that the prompt must contain task instructions   |
      | a name reserved for an existing agent     | that the name is already in use                  |
      | an explicit remote isolation request     | that remote execution is not supported           |
      | an explicit conversation fork request    | that conversation forks are not supported        |

  @ACC-SA-01-06 @proposed @concurrency
  Scenario: Queue work without exceeding the configured execution capacity.
    Given every configured child execution slot is occupied.
    And the pending queue has room for another run.
    When the parent accepts another background launch.
    Then the new execution is reported as queued.
    And it does not contact a provider while all execution slots are occupied.
    When an execution slot becomes available.
    Then the earliest eligible queued execution starts.

  @ACC-SA-01-07 @proposed @concurrency
  Scenario: Reject a launch when the pending queue is full.
    Given all execution slots and pending queue entries are occupied.
    When the parent requests another launch.
    Then the tool reports that execution capacity is unavailable.
    And the rejected request does not create a child execution or consume provider resources.

  @ACC-SA-01-08 @proposed @compatibility
  Scenario: Refuse ambiguous tool ownership.
    Given another extension already provides the "Agent" tool.
    When Secretary initializes subagent support.
    Then Secretary reports the tool-name collision and a configuration recovery action.
    And Secretary does not silently override the other tool or start its own child executions.
    And Secretary's existing goal tools remain available.

  @ACC-SA-01-09 @proposed @SA-12
  Scenario: Deliver a nested outcome after its delegating session has ended.
    Given agent A launched nested agent B through the delegation contract.
    And B reached a terminal status with a recorded outcome.
    And the session that owns B has ended.
    When the main session prepares its next model context.
    Then the nested outcome is presented to the main session exactly once.
    And the recorded parentage of B is unchanged.
    And the outcome is not presented again after it is observed.
