@subagents @draft @SA-02 @ui
Feature: Inspect delegated work without polling the parent model
  As a user,
  I want persistent agent navigation and a live inspector,
  so that I can understand and control work without disrupting the main editor.

  @ACC-SA-02-01 @proposed
  Scenario: Keep launch history distinct from current execution status.
    Given a background launch has returned while its child remains running.
    When the user views the main conversation and FleetView.
    Then the historical tool result reports an accepted background launch.
    And FleetView reports the child's current running state.
    And neither surface claims that the task completed merely because the launch tool returned.

  @ACC-SA-02-02 @proposed
  Scenario: Enter FleetView only from an empty editor.
    Given FleetView is visible below the main editor.
    And the editor is empty and focused.
    When the user presses Down or Left.
    Then focus moves into FleetView.
    And the user can select an agent and open its inspector without a model turn.

  @ACC-SA-02-03 @proposed
  Scenario: Preserve ordinary editing when the editor contains text.
    Given the main editor contains an unsent draft and has focus.
    When the user presses navigation keys or types "j" or "k".
    Then the editor handles the input normally.
    And FleetView does not capture the input or erase the draft.

  @ACC-SA-02-04 @proposed
  Scenario: Close inspection without cancelling work.
    Given the user opened an active agent's inspector while the main editor contained a draft.
    When the user closes the inspector with Escape.
    Then focus returns to the main editor with the draft preserved.
    And the agent continues executing.

  @ACC-SA-02-05 @proposed
  Scenario: Pause automatic transcript following while reading earlier output.
    Given the inspector is following a streaming transcript at its end.
    When the user scrolls upward.
    And new output arrives.
    Then the user's reading position is preserved.
    When the user returns to the end of the transcript.
    Then automatic following resumes.

  @ACC-SA-02-06 @proposed
  Scenario: Keep the inspector open when an agent finishes.
    Given an agent's live inspector is open.
    When the agent finishes.
    Then the inspector remains open on that agent.
    And it displays the final outcome and available output paths.
    And completion does not steal focus from an open message composer.

  @ACC-SA-02-07 @proposed
  Scenario Outline: Distinguish terminal outcomes without color.
    Given a child ends with <outcome>.
    When its outcome is displayed with colors unavailable.
    Then the display identifies <visible_status> using text or symbols.
    And the display does not mislabel the outcome as <incorrect_status>.

    Examples:
      | outcome                          | visible_status             | incorrect_status       |
      | an unrecovered provider error    | failure                    | successful completion  |
      | a supported execution limit      | partial output             | full completion        |
      | confirmed cancellation           | cancellation               | successful completion  |
      | interruption after process death | interrupted execution      | successful completion  |

  @ACC-SA-02-08 @proposed
  Scenario: Keep inspection usable after a terminal resize.
    Given the user has selected an agent and scrolled within its transcript.
    When the terminal changes from a wide layout to a narrow layout.
    Then the selected agent and reading position remain available.
    And the interface uses a full-width detail view rather than overflowing the terminal width.
    And the user can still inspect, message, and stop eligible work.

  @ACC-SA-02-09 @proposed
  Scenario: Render untrusted output as text rather than terminal commands.
    Given an agent transcript contains terminal control sequences supplied by a tool.
    When the inspector renders that transcript.
    Then those sequences do not execute terminal actions.
    And the transcript's readable content remains inspectable.

  @ACC-SA-02-10 @proposed
  Scenario: Leave unknown usage explicitly unavailable.
    Given the host has not reported context-window usage for an agent.
    When FleetView and the inspector render that agent.
    Then context-window usage is omitted or identified as unavailable.
    And it is not represented as a measured zero.
    And any goal-budget usage is labeled separately from context-window usage.
