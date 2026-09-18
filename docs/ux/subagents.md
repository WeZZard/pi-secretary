# Subagent Support: Interaction Design

**Document type:** UX and interaction specification.

**Status:** Interaction specification for the implemented subagent interface. Automated execution evidence is recorded in the [verification report](../testing/subagent-verification.md); human visual approval remains separate.

**Related documents:** [Requirements](../user-stories/subagents.md), [technical design](../arch/subagents.md), and [research](../research/subagent-system-comparison.md).

## 1. Design Principles

- The interface ports nicobailon's inline display, FleetView, async widget, and inspector interaction model onto Secretary's Claude Code-compatible runtime.
- The user can inspect background work without asking the parent model to poll.
- FleetView is displayed below the editor by default and can be configured above it. The async widget is displayed below the editor by default and can be disabled.
- Status uses text and symbols as well as color.
- Closing a view is different from stopping execution.
- A completed execution is different from a completed user objective.
- The UI and tool responses report the same underlying state.

Foreground detach, live prompt auditing, external job display, and external terminal inspectors remain excluded. The corresponding upstream surfaces are not ported because their runtime features are out of scope. All other upstream controls and configuration are ported.

## 2. Information Architecture

### 2.1 Inline tool display

- Each `Agent` call displays the agent type, task description, execution mode, and available status.
- Two display modes are configurable. Rich mode is the default and allows expansion; summary mode keeps one static result row per call and ignores expansion.
- A foreground call streams bounded recent activity until it settles. Its card shows the agent name and status glyph, a bounded task line, current activity, a live status line, the configured tool-expansion hint, and available token and duration statistics.
- Interrupting a foreground `Agent` call requests cancellation of that child. The child's output remains inspectable if the foreground response is interrupted. Cancelling a `TaskOutput` wait stops only the wait.
- A background call reports the launch identifier and directs the user to FleetView for current activity.
- A completed background execution creates a separate completion entry. It does not rewrite the historical launch result. A failed or interrupted completion produces a visible notice in the owning session.
- The configured pi tool-expansion key reveals task details, result text, and artifact paths in rich mode.
- A truncated result identifies where the full output can be read.

### 2.2 FleetView

- The collapsed view reports active and queued work belonging to the current parent session. It includes cumulative usage labels when usage is available and identifies the activation keys.
- The expanded view contains the main session and agent rows ordered by creation time.
- Each row shows the agent name, an explicit status glyph and label, elapsed execution time when available, and usage labels when available.
- Rows are themed and display width-aware. The layout truncates by terminal display width and realigns right-side information after resize.
- **Context-window usage** is the latest assistant turn's input plus cache-read tokens. **Cumulative usage** is the accumulated input-plus-output total. These are different quantities and are labeled separately. They are not the goal-budget usage defined by the goal subsystem, and they are not substituted for it.
- Unknown usage is not displayed as zero. Rows whose source artifacts predate window data keep the token-total label without a window label.
- Recently finished executions remain visible until FleetView is next collapsed. The inspector retains the full session list.
- FleetView is hidden when no active, queued, or recently finished work remains. The inspector can still be opened by command.

The following is a layout example. Angle-bracket values are placeholders, not measurements:

```text
<active count> active agents · <queued count> queued · <window label> · <cumulative label> · ↓/← to inspect

> main
  general-purpose  Implement validation        <elapsed> · <window> · <cumulative>
  reviewer         Review error handling       <elapsed> · <window> · <cumulative>
```

### 2.3 Async widget

- The async widget is a separate live summary below the editor. It lists active background executions with status glyphs, per-agent rows, current activity, elapsed time, and available usage.
- It is enabled by default. Configuration can disable it without disabling FleetView.
- Its expand key follows the configured pi tool-expansion key. Expanding reveals live detail lines for running children.
- It does not intercept printable editor keys. Clicking its header in a mouse-enabled full-screen host folds it into a one-line status summary; clicking again restores the layout. Folding does not change run execution or completion notification.
- The widget is removed when no active background work remains.

### 2.4 Inspector

- `/agents` opens the current-session agent list and selected transcript.
- `/agents <id-or-name>` opens one agent directly.
- The inspector is a bordered overlay with a title row, a selection-position indicator, a footer of available keys, and a minimum supported width below which only a diagnostic line is shown.
- Wide terminals display the agent list beside the transcript. Narrow terminals display a selectable list followed by a full-width detail view.
- Details include the original task, definition source, model, status, current activity, messages, tool calls, outcome, output path, and worktree information.
- The transcript renders assistant text as Markdown where appropriate, tool calls with their name, bounded arguments, status, and bounded output, and notices such as queued or undelivered guidance. Control sequences from transcripts are not executed.
- New content is followed automatically only while the user is at the end of the transcript.
- Scrolling upward pauses automatic following. Returning to the end resumes it.

## 3. Primary Interactions

### 3.1 Inspect an agent

- **User intent:** The user wants to understand delegated work and its current outcome.
- **Entry conditions:** The current session has an agent record, or the user knows its identifier.
- **User action:** The user presses Down or Left in an empty editor, selects an agent, and presses Enter. The user can instead invoke `/agents`.
- **Observable outcome:** The inspector shows the selected agent without starting a model turn.
- **Feedback:** The view identifies the agent, execution state, and whether the transcript is live or historical.
- **Failure and recovery:** Missing artifacts remain visible as a diagnostic. The user can inspect the retained record and output paths; the interface does not manufacture a transcript.

### 3.2 Message or resume an agent

- **User intent:** The user wants to redirect active work or continue a previous conversation.
- **Entry conditions:** The selected agent belongs to the current session and is eligible for messaging or resumption.
- **User action:** The user presses `s`, enters guidance, and submits it. Escape cancels the composer.
- **Observable outcome:** A running agent receives queued guidance. A resumable finished agent starts another background execution of the same conversation.
- **Feedback:** The interface reports either “Message queued” or “Resume accepted.” It does not report “Instruction followed.”
- **Failure and recovery:** One-shot agents, missing history, unavailable models, changed tool permissions, and missing worktrees produce explicit errors. The draft is retained after a rejected submission so the user can copy or revise it. If previously accepted guidance cannot be delivered before the run stops, the inspector labels it undelivered or uncertain. The user can copy it for an explicit resend; it is not automatically replayed.

Secretary initially exposes one guidance operation. Nicobailon's `steer`, `follow_up`, and `auto` selector is not copied because those modes would introduce a second public messaging contract beyond the selected Claude Code behavior.

### 3.3 Stop an agent

- **User intent:** The user wants selected work to stop while retaining its available output.
- **Entry conditions:** The selected execution is queued, starting, running, or already stopping.
- **User action:** The user presses `D` and confirms the identified execution. `/agents stop <id-or-name>` provides the same operation with confirmation in the TUI.
- **Observable outcome:** A queued execution is cancelled before starting. Active execution shows “Stopping” until termination is observed.
- **Feedback:** The view distinguishes a pending stop request from a cancelled execution. It states that file changes are not rolled back.
- **Failure and recovery:** If the selected execution finishes or is replaced before confirmation, the confirmation does not target the newer execution. If stopping cannot be confirmed, the view reports that uncertainty and does not offer a conflicting resume.

### 3.4 Exit, reload, or switch sessions

- **User intent:** The user wants to leave the current session without orphaned background work.
- **Entry conditions:** The parent may have active child executions.
- **User action:** The user quits pi, reloads extensions, starts a new session, or switches sessions.
- **Observable outcome:** Current-session children are stopped. Their available records and saved conversations remain inspectable when the parent is restored.
- **Feedback:** On restoration, interrupted executions are identified as interrupted, not completed. No child starts automatically.
- **Failure and recovery:** A missing or damaged saved session cannot be resumed. The user can still inspect other retained evidence and start a separate task explicitly.

### 3.5 Inspect and clean up a worktree

- **User intent:** The user wants to locate an agent's changes and safely remove an unnecessary worktree.
- **Entry conditions:** The selected agent has a recorded worktree.
- **User action:** The user reads its path and branch in the inspector. `/agents cleanup <id-or-name>` requests cleanup of that agent's idle worktree.
- **Observable outcome:** An unchanged worktree can be removed after confirmation. Worktrees with changes or commits remain available.
- **Feedback:** Retained worktrees explain that changes require manual review. Cleanup states that future resumption of that agent will be unavailable.
- **Failure and recovery:** The command refuses dirty, changed, active, foreign, or unverifiable worktrees. Resumption is unavailable while cleanup is in progress. If cleanup is interrupted and the remaining files cannot be verified, the view reports that manual recovery is required and continues to refuse resumption. This release provides no force-delete or automatic merge command.

## 4. Navigation and Accessibility

| Context | Key | Behavior |
| --- | --- | --- |
| The editor is empty and focused. | Down or Left | The key activates FleetView when visible. |
| FleetView has focus. | Up/Down or `j/k` | The key changes selection. |
| FleetView has focus. | Enter | The key opens the selected inspector or returns to the main session. |
| FleetView has focus. | Escape | The key returns focus to the editor. |
| The inspector is open. | Up/Down or `j/k` | The key changes the selected agent. |
| The inspector is open. | Home/End | The key selects the first or last agent. |
| The inspector is open. | Page Up/Page Down | The key scrolls by the available transcript viewport. |
| The inspector is open. | Shift+K/Shift+J | The key scrolls the transcript by one line. |
| The inspector is open. | `x`, `X`, or the configured tool-expansion key | The key toggles tool details. |
| The inspector is open. | `s` | The key opens the message composer. |
| The inspector is open. | `D` | The key opens stop confirmation. |
| The inspector is open. | `r` or `R` | The key reloads the selected transcript. |
| The inspector is open. | Escape | The key closes the inspector without stopping work. |
| The composer is open. | Escape | The key cancels composition without sending a message. |

- Inspector-level keys are configurable when a terminal intercepts them. Displayed hints always reflect the configured keys. Prompt interactions keep fixed keys such as Enter and Escape.
- Printable navigation keys are captured only after focus enters FleetView or the inspector.
- Normal editing, file completion, IME composition, and existing editor extensions continue to work.
- The interface wraps or truncates by terminal display width and remains usable after resize.
- Theme changes update existing views without losing selection or scroll position.
- The main editor retains its text when the inspector opens or closes.

## 5. Visible Interaction Flow

- The sequence diagram shows one successful interaction path from the user's perspective.
- The [architecture's UI state model](../arch/subagents.md#121-ui-state-model) is the authoritative specification of states, transitions, guards, and effects. Those implementation contracts are not duplicated here.

```mermaid
sequenceDiagram
    actor User
    participant Editor as Main editor
    participant Fleet as FleetView
    participant Inspector as Agent inspector
    User->>Editor: Press Down with an empty editor
    Editor->>Fleet: Move focus
    User->>Fleet: Select an agent and press Enter
    Fleet->>Inspector: Open the selected conversation
    User->>Inspector: Compose and submit guidance
    Inspector-->>User: Show message acknowledgment
    User->>Inspector: Request stop and confirm
    Inspector-->>User: Show Stopping, then the observed outcome
    User->>Inspector: Press Escape
    Inspector->>Editor: Restore editor focus and text
```

### 5.1 Pending actions and recovery

- While guidance is being submitted, the interface prevents duplicate submission and identifies the selected recipient.
- If submission is rejected, the user keeps the draft and receives an actionable explanation.
- If acceptance is uncertain, the interface preserves the text and target and prevents resubmission until the original request is resolved.
- Dismissing a pending request returns focus to the originating view. It does not retract the request or cancel the agent.
- A delayed response cannot replace a more recently selected transcript, close another dialog, or steal focus.
- If the agent completes while the composer is open, the draft remains available. The interface explains whether submitting it will resume the agent or whether resumption is unavailable.
- Escape dismisses only the currently focused dialog. A subsequent Escape can close the inspector without stopping work.
- Message drafts are not restored after leaving or replacing the parent UI session in this release.

## 6. Notifications and Non-TUI Behavior

- Successful completion updates inline history and FleetView without an extra success toast.
- Completion never steals keyboard focus from the editor or an open composer.
- A state-only display refresh does not start a model turn.
- The parent model can receive a completion message independently of whether a toast is shown.
- In headless modes, commands return text rather than opening a terminal component.
- Print and JSON mode reject a request to resume an idle agent through `SendMessage`, because that operation starts background execution. The response directs the caller to use a persistent TUI or RPC session; it does not accept work that normal process completion would terminate.
- Cleanup requiring confirmation is unavailable in headless mode. Model-facing `TaskStop` remains an explicit stop request and does not require a dialog.

## 7. Review Criteria

- Reviewers must be able to distinguish launch, completion, failure, partial output, and cancellation without relying on color.
- Inspection, messaging, stopping, and cleanup must satisfy the requirements in [SA-02 through SA-06](../user-stories/subagents.md#sa-02-observe-concurrent-work), and the ported presentation must satisfy [SA-10](../user-stories/subagents.md#sa-10-recognize-delegated-work-through-the-ported-presentation).
- A UI walkthrough must cover narrow and wide terminals, keyboard focus, resize, scrolling during streaming, completion while open, and stale stop confirmation.
- The review must record visual verification separately from execution tests and human approval.
- The user must retain their draft, selected target, and reading position through progress updates and unsuccessful actions where the interaction contract requires it.
- Technical transition and guard coverage is specified in the [architecture verification contract](../arch/subagents.md#125-state-machine-verification).
- The [UI state-machine acceptance scenarios](../../doc/acceptance/ui-state-machine.feature) cover modal focus, duplicate submission, stale responses, and session deactivation.

## 8. Ported Surface Exclusions

The following upstream surfaces depend on runtime features that are out of scope in [Section 1 of the requirements](../user-stories/subagents.md#1-purpose-and-confirmed-constraints). They are not ported, and no equivalent control is shown:

- The foreground detach card hint and configured shortcut. Interrupting a foreground call remains the supported way to stop foreground work.
- Prompt Audit and its redo-with-guidance view. Secretary does not record or replay live prompt snapshots.
- External job rows, project panes, and external terminal inspector plugins such as Herdr and Ghostty.
- Upstream steering delivery modes. Secretary exposes one guidance operation whose acknowledgment follows the selected Claude Code messaging contract.
- Workflow, chain, mission, and schedule tree rows. Secretary's initial scope excludes orchestration.
