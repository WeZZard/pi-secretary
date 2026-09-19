@subagents @draft @SA-09
Feature: Retrieve output and control execution without a terminal
  As a parent agent or headless client,
  I want explicit output and execution behavior,
  so that I do not need a TUI or accept work that disappears at process completion.

  @ACC-SA-09-01 @proposed @SA-02
  Scenario: Read available output without waiting.
    Given a child run is still executing and has produced partial output.
    When the parent calls "TaskOutput" for that run with "block" set to false.
    Then the response returns its current status and available bounded output.
    And the response does not report full completion.
    And the child continues executing.

  @ACC-SA-09-02 @proposed
  Scenario: Time out a blocking output request without stopping the child.
    Given a child remains executing beyond the requested wait timeout.
    When the parent calls "TaskOutput" with blocking enabled and that timeout.
    Then the response identifies that the wait expired while execution remains active.
    And the child is not cancelled by the timeout.

  @ACC-SA-09-03 @proposed @concurrency
  Scenario: Keep an output wait attached to the run it selected.
    Given "TaskOutput" selected run A as the agent's latest run when the call was accepted.
    When run A finishes and run B starts for the same agent.
    Then the waiting call returns run A's outcome.
    And it does not silently switch to waiting for run B.

  @ACC-SA-09-04 @proposed @SA-02
  Scenario: Report truncation with a usable full-output path.
    Given a completed child's output exceeds the configured inline output limit.
    When its output is retrieved.
    Then the response explicitly states that the inline output was truncated.
    And it identifies an existing file containing the full output.
    And the existing pi read tool can retrieve that file.

  @ACC-SA-09-05 @proposed @SA-01
  Scenario Outline: Complete an ordinary headless launch in the foreground.
    Given the parent is running in <mode> mode.
    And the selected definition does not require background execution.
    When "Agent" is called without "run_in_background".
    Then the operation waits for the child's outcome.
    And it does not require the fleet indicator, the fleet view overlay, or a confirmation dialog.

    Examples:
      | mode  |
      | print |
      | JSON  |

  @ACC-SA-09-06 @proposed
  Scenario Outline: Reject work that requires unsupported headless background execution.
    Given the parent is in normal print or JSON mode.
    When the caller requests <operation>.
    Then the operation is rejected before a child run or provider request is created.
    And the response explains the supported foreground or persistent-session alternative.

    Examples:
      | operation                                                 |
      | an Agent launch with run_in_background set to true        |
      | an Agent launch whose definition requires background work |
      | SendMessage resumption of an idle agent                   |

  @ACC-SA-09-07 @proposed
  Scenario: Use background execution in a persistent RPC session.
    Given the parent is a persistent RPC session without a TUI.
    When an eligible background "Agent" call is accepted.
    Then the launch returns its identifiers before completion.
    And completion can be delivered to the owning RPC session.
    And no terminal component is required.

  @ACC-SA-09-08 @proposed
  Scenario: Distinguish explicit tool cancellation from interactive cleanup confirmation.
    Given the parent is running without an interactive UI.
    And it owns a running child and a separate unchanged idle worktree.
    When the parent explicitly calls "TaskStop" for the running child.
    Then the stop request can be accepted without a dialog.
    When cleanup of the idle worktree is requested without an available confirmation mechanism.
    Then cleanup is refused with an explanation that confirmation is required.
    And the worktree remains unchanged.

  @ACC-SA-09-09 @proposed @compatibility
  Scenario Outline: Validate TaskOutput timeout boundaries.
    Given the selected run belongs to the current parent.
    When "TaskOutput" is called with timeout <timeout> milliseconds.
    Then input validation <result>.

    Examples:
      | timeout | result                              |
      | 0       | accepts the request                 |
      | 0.5     | accepts the request                 |
      | 600000  | accepts the request                 |
      | -1      | rejects the request before waiting  |
      | 600001  | rejects the request before waiting  |
