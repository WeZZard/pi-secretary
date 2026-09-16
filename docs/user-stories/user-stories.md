# User Stories: Codex Goal Replicate with pi-goal-x TUI

**Project:** pi-secretary — Codex goal replicate
**Document type:** User Stories / Requirements
**Status:** Draft
**Date:** 2026-09-15
**Updated:** 2026-09-16
**Audience:** Product owners, developers, and reviewers deciding what outcomes the product must support.
**Scope:** This document states required outcomes and product constraints. It does not prescribe event structures, SDK hooks, storage operations, or test-harness implementation.
**Related:** [UX design](../ux/ux-design.md) · [Architecture](../arch/architecture.md) · [Document responsibilities](../README.md)

## 1. Product Vision

- Give a user a persistent goal that the agent can pursue across responses without repeated instructions.
- Preserve Codex's small public goal interface, one goal per session, and distinction between completion, pause, blockers, and limits.
- Present the goal through a compact terminal display and an expanded dashboard inspired by pi-goal-x.
- Keep the user in control of the objective and make status reports trustworthy. The interface and the agent must not give contradictory answers about whether the goal is active or stopped.

## 2. Personas

| Persona | Primary needs |
| --- | --- |
| The developer using Pi | The user needs to state an outcome, control whether work continues, inspect usage, and understand completion or stopping conditions. |
| The agent | The agent needs an unambiguous objective, current status, available budget, and clear authority to continue or stop. |
| The maintainer | The maintainer needs inspectable behavior, compatibility expectations, and reproducible evidence that changes meet the requirements. |

## 3. Epics

- **Epic A — Goal lifecycle:** The user and agent can manage one goal without silently redefining the user's intent.
- **Epic B — Goal presentation:** The user can inspect and control the goal through the terminal interface.
- **Epic C — Continued work and limits:** The agent continues appropriate work and stops honestly when it is finished, blocked, paused, or limited.
- **Epic D — Continuity and consistency:** The goal survives session changes, and its status remains consistent across the interface and agent responses.

## 4. User Stories

### Epic A — Core goal lifecycle

#### US-A1: Create a goal only on explicit request

**As** the user, **I want** persistent goals created only when I request them, **so that** an ordinary question or task does not become an open-ended commitment.

**Acceptance criteria:**
- The agent creates a goal only after explicit authorization from the user or applicable higher-priority instructions.
- A token budget is set only when explicitly requested.
- The user receives confirmation of the objective and can see the resulting goal.
- An objective must be non-blank and at most 4,000 characters. Invalid input produces corrective feedback without losing an existing goal.
- Asking the agent to create another goal while an unfinished goal exists does not silently replace the existing objective. The conflict is explained so the user can decide what to do.

#### US-A2: Get a goal snapshot at any time

**As** the agent, **I want** to inspect the current goal, **so that** I can report its status and understand what work is authorized.

**Acceptance criteria:**
- `get_goal` remains available regardless of the goal's status and does not change the goal or resume work.
- The answer includes the objective, status, token budget when present, tokens used, elapsed goal time, and remaining tokens.
- If no goal exists, the answer explicitly says so.
- An inability to read the goal is reported as an error, not as proof that no goal exists.

#### US-A3: Update goal status only via terminal outcomes

**As** the user, **I want** the agent's status-changing authority to be limited, **so that** it cannot silently resume, redefine, or abandon my goal.

**Acceptance criteria:**
- The agent can report `complete` or `blocked`, and can report `paused` only at the user's explicit request.
- Completion requires evidence that the full objective has been achieved, not merely that a useful subset is finished.
- An agent-reported blocker requires the same condition to prevent meaningful progress across three consecutive goal turns.
- Difficulty, slow progress, or incomplete work alone is not a blocker.
- The agent cannot use a status update to change the objective, grant itself more budget, clear the goal, or resume it.
- A successful status update reports what actually happened, including when an exhausted budget prevents a requested pause from changing the displayed stopping reason.

#### US-A4: Recover a blocked goal on resume

**As** the user, **I want** a resumed goal to get a fresh opportunity to proceed, **so that** an old blocker does not automatically stop a new attempt.

**Acceptance criteria:**
- The agent reassesses the situation after the user resumes a blocked goal.
- The previous attempt's repeated blocker does not count toward the new attempt's three-consecutive-turn rule.

#### US-A5: Grant the user ownership of intent

**As** the user, **I want** to create, edit, pause, resume, and clear goals myself, **so that** the agent follows my intended outcome and limits.

**Acceptance criteria:**
- The user can revise the objective without asking the agent to reinterpret it.
- The agent does not independently pause, clear, or redefine the goal.
- A request to inspect status does not authorize resumption.
- If the user makes a newer valid decision while an earlier request is still being processed, the earlier request must not silently replace that decision when it finishes.

### Epic B — Goal TUI

#### US-B1: See goal status at a glance

**As** the user, **I want** the objective, status, elapsed time, and token usage visible, **so that** I know what the agent is pursuing and whether it can continue.

**Acceptance criteria:**
- A current goal appears above the editor and in the footer without requiring a separate inspection command.
- Goal information stays current after creation, edits, stopping, resumption, or return to the session.
- Clearing the goal removes both displays.

#### US-B2: Expand the dashboard for full detail

**As** the user, **I want** to expand the goal display, **so that** I can inspect details without overwhelming the normal conversation view.

**Acceptance criteria:**
- The expanded view shows the complete objective, status, usage, and budget.
- The user can open and close the view with the keyboard without changing the goal.

#### US-B3: Drive lifecycle from the TUI

**As** the user, **I want** a `/goal` command family, **so that** I can control the goal directly rather than explain every action to the agent.

**Acceptance criteria:**
- The user can inspect, create, edit, pause, resume, and clear the goal.
- Clearing requires confirmation, and cancellation leaves the goal unchanged.
- An unsuccessful action does not receive a success confirmation.
- When an action cannot proceed, the explanation identifies the known obstacle and a supported recovery action when available.

### Epic C — Continuation and accounting

#### US-C1: Continue automatically while idle

**As** the user, **I want** an active goal to continue without repeated prompts, **so that** the agent can make progress on a longer task.

**Acceptance criteria:**
- The agent continues an active goal when it is ready for more work, without starting duplicate attempts.
- Stopped goals do not start new ordinary goal work automatically. A budget-limited goal may receive a final progress and usage summary without resuming work.
- A pause, clear, or revised objective takes precedence over an earlier intention to continue. Work already underway may finish, but its late results cannot undo that newer decision or authorize further work under the old objective.
- Stopping automatic goal work does not discard an unrelated question or instruction from the user.

#### US-C2: End a goal safely on error/empty output

**As** the user, **I want** failed work to stop with an accurate explanation, **so that** the agent neither retries indefinitely nor incorrectly tells me that work can continue.

**Acceptance criteria:**
- An error that cannot be recovered from stops the affected active goal as `blocked`.
- A temporary error followed by successful recovery does not leave the goal blocked solely because of that error.
- Repeated empty responses stop the goal rather than continuing indefinitely.
- A service usage limit is reported as `usage_limited`, not as an invented project blocker.
- A late error from earlier work does not undo the user's later pause, clear, or changed goal, or a fresh request to retry even if the goal was still labeled active.

#### US-C3: Account per-turn token and time usage

**As** the user, **I want** accurate goal-token usage and elapsed time, **so that** I can understand the cost of pursuing the goal.

**Acceptance criteria:**
- Usage is not counted twice and does not include work that preceded creation of the goal.
- Usage from an earlier goal is not charged to its replacement.
- Stopping or completing a goal does not silently lose usage that belongs to that goal, and reopening a session does not duplicate prior usage.

#### US-C4: Transition to budget-limited and wrap up

**As** the user, **I want** work to stop when the goal exhausts its token budget, **so that** the agent respects my allowance without claiming unfinished work is complete.

**Acceptance criteria:**
- An exhausted goal is visibly `budget_limited`.
- The agent provides a single wrap-up of progress, unfinished work, and usage for that exhaustion, without treating the summary as permission to continue the task.
- Repeating resume or editing the objective does not grant additional budget.
- Clearing or changing the goal does not cause an obsolete wrap-up to restart the old task.

### Epic D — Continuity and consistency

#### US-D1: Persist one goal per thread

**As** the user, **I want** my session's goal to survive a restart, **so that** I do not lose the objective, stopping status, or recorded usage.

**Acceptance criteria:**
- A session has at most one current goal.
- Reopening the session preserves its objective, status, budget, and recorded usage.
- A failed change does not leave a partially changed goal.

#### US-D2: Restore goal state after resume

**As** the user, **I want** the correct goal when I return to or fork a session, **so that** I can continue from a known point without confusing it with another session's work.

**Acceptance criteria:**
- Returning to an active goal allows continued work; returning to a stopped goal does not implicitly resume it.
- Switching sessions shows the selected session's goal or the absence of one.
- A fork initially inherits the source goal and usage, but later goal changes in either session do not change the other.

#### US-D3: Observe goal changes consistently

**As** the user, **I want** changes to a goal reflected wherever its current status is presented, **so that** I do not have to decide which status report to trust.

**Acceptance criteria:**
- Goal changes made through commands or through the agent are reflected in the goal display.
- After a goal is cleared, the display and subsequent status answers report that there is no current goal.
- Returning to a session shows the current goal even if an earlier display update failed.
- If current goal information is unavailable, the interface and agent do not present an older status as certain.

#### US-D4: Keep the UI and agent synchronized

**As** the user, **I want** the goal display, action confirmations, and the agent's answers to agree, **so that** I can trust whether work is active, stopped, or finished.

**Acceptance criteria:**
- A status question after pause or clear receives an answer consistent with that action, without restarting work.
- “Work remains possible” is not presented as evidence that a stopped goal is active.
- An unsuccessful resume explains why work remains stopped instead of claiming that it resumed.
- A response already being written may predate a goal change, but a new answer must not keep repeating that outdated status.
- A notification about goal status does not itself authorize further work.
- Late completion or error reports cannot restore an older objective or stopping status after a newer decision has been accepted.

## 5. Out of Scope

- Multiple open goals within one session and a goal-focus selector are excluded.
- Task trees, verification-contract editing, and a separate completion auditor are excluded.
- Clearing removes the current goal; it does not create a goal archive or undo work already performed.
- This document does not choose the event protocol, queue-cancellation method, or model-context format used to satisfy the requirements.

## 6. Acceptance / Definition of Done

- A story is complete only when its observable acceptance criteria are demonstrated, including unsuccessful actions and recovery cases.
- Agent-facing behavior and user-facing status reports must be assessed together; a correct display alone is insufficient.
- The [UX design](../ux/ux-design.md) defines concrete interactions, wording, and visual behavior.
- The [architecture](../arch/architecture.md) defines implementation contracts and technical verification requirements.
- The [implementation plan](../../.plans/2026-09-16-11-13-goal-state-synchronization.md) assigns changes and verification work to phases; a proposed plan is not evidence that a requirement is implemented.

## 7. Product Constraints and Quality Requirements

- **Compatibility:** Preserve the three public goal tools (`get_goal`, `create_goal`, and `update_goal`) and the six existing goal statuses. Detailed schemas belong in the architecture document.
- **Persistence constraint:** Retain SQLite as the goal store; this work does not introduce another persistence format.
- **Reliability:** A failure must not produce a false success message, lose the current goal, or restart work the user stopped.
- **Inspectability:** The user can inspect the goal and usage without changing them, and unknown stopping reasons are reported honestly.
- **Accessibility:** Status meaning and goal controls remain understandable without relying on color or a mouse.
