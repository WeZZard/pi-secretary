@subagents @draft @SA-02 @ui
Feature: Inspect delegated work without polling the parent model
  As a user,
  I want persistent agent navigation and a live fleet view overlay,
  so that I can understand and control work without disrupting the main editor.

  @ACC-SA-02-01 @proposed
  Scenario: Keep launch history distinct from current execution status.
    Given a background launch has returned while its child remains running.
    When the user views the main conversation and the fleet indicator.
    Then the historical tool result reports an accepted background launch.
    And the fleet indicator reports the child's current running state.
    And neither surface claims that the task completed merely because the launch tool returned.

  @ACC-SA-02-02 @proposed
  Scenario: Enter the fleet indicator only from an empty editor.
    Given the fleet indicator is visible below the main editor.
    And the editor is empty and focused.
    When the user presses Down.
    Then focus moves into the fleet indicator and selects its first row.
    And the selected row's circle is filled while every other circle is hollow.
    And the user can select an agent and open its fleet view overlay without a model turn.
    And pressing Left does not move focus into the fleet indicator.

  @ACC-SA-02-02a @proposed
  Scenario: Return focus from the fleet indicator to the editor.
    Given the fleet indicator has focus.
    When the user presses Escape.
    Then focus returns to the main editor.
    And every row's circle is hollow.
    Given the fleet indicator has focus with its first row selected.
    When the user presses Up.
    Then focus returns to the main editor.
    Given the fleet indicator has focus with the main session row selected.
    When the user presses Enter.
    Then focus returns to the main editor's prompt input.
    And the fleet view overlay does not open.

  @ACC-SA-02-02b @proposed
  Scenario: Hide the fleet indicator when no agent is active.
    Given the session has no non-terminal agent executions.
    When the fleet indicator renders.
    Then nothing is rendered below the editor.
    And no summary or info bar is rendered above the list.
    When a top-level agent starts.
    Then the fleet indicator appears with the main session row first.

  @ACC-SA-02-02c @proposed
  Scenario: Remove a row immediately when its execution reaches a terminal status.
    Given the fleet indicator lists a running agent.
    When the agent's execution reaches a terminal status.
    Then the agent's row is absent from the fleet indicator.
    And the completion remains visible in the inline transcript entry.
    And the agent remains inspectable in the fleet view overlay.

  @ACC-SA-02-03 @proposed
  Scenario: Preserve ordinary editing when the editor contains text.
    Given the main editor contains an unsent draft and has focus.
    When the user presses navigation keys or types "j" or "k".
    Then the editor handles the input normally.
    And the fleet indicator does not capture the input or erase the draft.

  @ACC-SA-02-04 @proposed
  Scenario: Close inspection without cancelling work.
    Given the user opened an active agent's fleet view overlay while the main editor contained a draft.
    When the user closes the overlay with Escape.
    Then focus returns to the main editor with the draft preserved.
    And the agent continues executing.

  @ACC-SA-02-05 @proposed
  Scenario: Pause automatic transcript following while reading earlier output.
    Given the fleet view overlay is following a streaming transcript at its end.
    When the user scrolls upward.
    And new output arrives.
    Then the user's reading position is preserved.
    When the user returns to the end of the transcript.
    Then automatic following resumes.

  @ACC-SA-02-06 @proposed
  Scenario: Keep the fleet view overlay open when an agent finishes.
    Given an agent's live fleet view overlay is open.
    When the agent finishes.
    Then the overlay remains open on that agent.
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
    When the fleet view overlay renders that transcript.
    Then those sequences do not execute terminal actions.
    And the transcript's readable content remains inspectable.

  @ACC-SA-02-10 @proposed
  Scenario: Leave unknown usage explicitly unavailable.
    Given the host has not reported context-window usage for an agent.
    When the fleet indicator and the fleet view overlay render that agent.
    Then context-window usage is omitted or identified as unavailable.
    And it is not represented as a measured zero.
    And any goal-budget usage is labeled separately from context-window usage.

  @ACC-SA-02-11 @proposed
  Scenario: Show active agents only in the fleet view overlay by default.
    Given a session has two running agents, one queued agent, and one finished agent.
    When the user opens the fleet view overlay.
    Then the list shows the running and queued agents.
    And the finished agent is absent from the list.
    And the main session is not a row in the list.
    When the user presses "a".
    Then the finished agent appears in the list.
    When the user presses "a" again.
    Then the finished agent is absent again.

  @ACC-SA-02-12 @proposed
  Scenario: Split the fleet view overlay vertically on a wide terminal.
    Given the terminal is wider than the split layout's minimum.
    When the fleet view overlay is open.
    Then a navigation list with between 20 and 40 content columns occupies the left column.
    And each list row shows only the selection circle and the agent name.
    And the selected agent's transcript content occupies at least 61.8 percent of terminal columns on the right.
    And excess width belongs to the transcript rather than widening navigation beyond 40 content columns.
    And both side borders remain visible on every body row.
    And the frame height and position remain unchanged while selecting agents and loading their transcripts.
    And short or empty transcripts leave padded space instead of shrinking the frame.
    And the transcript pane follows the selection as it moves.
    And a status header floats at the top of the transcript pane without an enclosing box.
    And the header shows the agent name, status label, stats, and current activity above a single divider.
    And the header does not scroll when the transcript scrolls.

  @ACC-SA-02-13 @proposed @SA-12
  Scenario: Drill into a nested agent level in the fleet view overlay.
    Given agent A has two nested child agents.
    And the fleet view overlay lists A at the root level.
    When the user selects A and presses Enter.
    Then the list replaces itself with A's children.
    And the title row shows the drill path with the root label and A.
    And the transcript pane shows the selected child.
    When the user presses Left.
    Then the list returns to the root level with A re-selected.
    When the user selects A and presses Right.
    Then the list enters A's level as with Enter.
    Given the overlay is at the root level.
    When the user presses Left.
    Then the list and selection do not change.

  @ACC-SA-02-14 @proposed @SA-12
  Scenario: Refuse drilling into a childless agent.
    Given the fleet view overlay lists an agent without nested children.
    When the user selects it and presses Enter or Right.
    Then the list remains at the current level.
    And the transcript pane shows the selected agent.
