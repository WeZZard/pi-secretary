# User Stories: Codex Goal Replicate with pi-goal-x TUI

**Project:** pi-secretary — Codex goal replicate
**Document type:** User Stories / Requirements
**Status:** Draft
**Date:** 2026-09-15
**Related:** `../ux/ux-design.md` · `../arch/architecture.md` · `../../.plans/implementation-plan.md`

---

## 1. Product Vision

Build a **faithful replicate of OpenAI Codex's goal system** — its exact
model-facing surface, single-goal-per-thread semantics, SQLite persistence,
and prompt-driven completion/blocked policy — **presented through pi-goal-x's
polished TUI** (the above-editor goal dashboard, status line, command palette,
and keyboard interactions).

The guiding principle, borrowed from Codex and preserved by pi-goal-x:

> **Tools express durable model intents; a service owns validated state
> mutation; runtime hooks own accounting and continuation; steering prompts
> own behavioral policy; UI and external commands mutate through the same
> service.**

The point of this replicate is **not** to re-derive a richer goal system, but
to produce a **high-fidelity, minimal-surface, reliable** goal capability whose
behavior matches Codex, wrapped in the ergonomics users already know from
`pi-goal-x`.

---

## 2. Personas

| Persona | Description | Primary needs |
| --- | --- | --- |
| **The Agent (LLM)** | The coding model driving pi. Uses `get_goal` / `create_goal` / `update_goal`. | Minimal, stable, unambiguous tool schemas; clear policy in descriptions. |
| **The Developer (user)** | A developer running pi through the TUI, issuing `/goal` commands. | Visibility into goal state, easy create/edit/pause/resume/clear, trustworthy completion. |
| **The Maintainer** | Someone maintaining the extension. | Testable modules, a single mutation service, inspectable persistence, audited behavior. |

For this replicate the agent is the primary *actor* of the goal lifecycle; the
developer is the *owner* of intent and the *consumer* of visibility.

---

## 3. Epics

### Epic A — Core goal lifecycle (Codex-faithful)
Create, read, update, and complete/block a single goal per thread, matching
Codex's three-tool surface and status state machine.

### Epic B — Goal TUI (pi-goal-x style)
The above-editor goal dashboard, status line, command palette, and keyboard
interactions, rendered from the Codex goal state.

### Epic C — Continuation and accounting (Codex-faithful)
Idle auto-continuation, per-turn token/time accounting, token-budget
transition, and wrap-up steering.

### Epic D — Persistence (Codex-faithful)
SQLite-backed goal storage, single goal per thread, transactional updates.

---

## 4. User Stories

### Epic A — Core goal lifecycle

#### US-A1: Create a goal only on explicit request
**As** the agent, **I want** to create a goal **only** when the user or
system/developer instructions explicitly request it, **so that** ordinary
tasks never become persistent goals.

**Acceptance criteria:**
- `create_goal` is callable only after an explicit user/system/developer
  request.
- The tool result states the new goal became this thread's focus.
- Creating a goal when an unfinished goal already exists **fails** with a
  message directing the caller to complete it first (Codex's
  single-goal-per-thread invariant).

#### US-A2: Get a goal snapshot at any time
**As** the agent, **I want** to read the complete goal snapshot, **so that** I
know objective, status, usage, budget, and remaining tokens.

**Acceptance criteria:**
- `get_goal` is read-only and always available.
- It returns objective, status, `tokenBudget`, `tokensUsed`,
  `timeUsedSeconds`, and remaining token budget.
- It carries no side effects.

#### US-A3: Update goal status only via terminal outcomes
**As** the agent, **I want** to report only `complete`, `blocked`, or (on user
request) `paused` through a single `status` field, **so that** I cannot
silently redefine or abandon the objective.

**Acceptance criteria:**
- `update_goal` accepts exactly one field: `status`.
- `paused` is accepted **only** at the user's explicit request; the model must
  never pause on its own initiative.
- `complete` is emitted only after the requirement-by-requirement completion
  audit passes.
- `blocked` is emitted only after the **same blocking condition recurs for 3
  consecutive goal turns**.
- No objective, reason, summary, evidence, or bypass fields are accepted.

#### US-A4: Recover a blocked goal on resume
**As** the agent, **I want** a resumed (previously blocked) goal to start a
**fresh blocked audit**, **so that** an old impasse does not immediately
re-block.

**Acceptance criteria:**
- After a user resumes a blocked goal, the resumed run resets the blocked
  audit counter.
- The same condition must recur 3 times on the resumed run before `blocked` is
  emitted again.

#### US-A5: Grant the user ownership of intent
**As** the developer, **I want** a dedicated command palette for lifecycle
actions, **so that** I control create/edit/pause/resume/clear and the agent
cannot redefine intent.

**Acceptance criteria:**
- An `edit`/tweak command replaces the objective through a user editor.
- `pause`, `resume`, and `clear` are user-owned.
- The model cannot clear a goal.

### Epic B — Goal TUI (pi-goal-x style)

#### US-B1: See goal status at a glance
**As** the developer, **I want** the goal status, progress, elapsed time, and
token usage visible above the editor, **so that** I always know what the agent
is pursuing.

**Acceptance criteria:**
- An above-editor widget shows objective/status and live `tokensUsed` /
  `timeUsedSeconds`.
- It updates on goal state changes (via a `ThreadGoalUpdated`-style event).

#### US-B2: Expand the dashboard for full detail
**As** the developer, **I want** to expand the dashboard, **so that** I can see
usage, budget, status, and recent activity.

**Acceptance criteria:**
- A keybinding (e.g. `Ctrl+Shift+T`) expands/collapses the dashboard.
- The expanded view shows status, usage, and budget.

#### US-B3: Drive lifecycle from the TUI
**As** the developer, **I want** a `/goal` command namespace with
subcommands, **so that** I can edit, pause, resume, and clear without typing
model instructions.

**Acceptance criteria:**
- Bare `/goal` shows the goal summary.
- `/goal <objective>` creates/sets a goal.
- `/goal edit`, `/goal pause`, `/goal resume`, `/goal clear` are handled
  in-app.
- `clear` asks for confirmation before deleting goal state.

### Epic C — Continuation and accounting (Codex-faithful)

#### US-C1: Continue automatically while idle
**As** the agent, **I want** the runtime to start an idle continuation when the
goal is active, **so that** long work progresses without a fresh prompt.

**Acceptance criteria:**
- When the thread is idle and the goal is `active`, a `start_turn_if_idle`
  with a continuation steering item is issued.
- A non-active goal never continues.
- Continuation is gated by the goal state permit so it cannot interleave with
  an external mutation.

#### US-C2: End a goal safely on error/empty output
**As** the runtime, **I want** to stop the active goal on a turn error or a
repeated empty response, **so that** a broken run does not spin forever.

**Acceptance criteria:**
- A turn error transitions the goal to `blocked`.
- A repeated empty response transitions the goal to `blocked`.
- A usage limit transitions the goal to `usage_limited`.

#### US-C3: Account per-turn token and time usage
**As** the runtime, **I want** to record `tokensUsed` and `timeUsedSeconds`
per turn and at idle, **so that** usage is accurate and idempotent.

**Acceptance criteria:**
- Progress is accounted once per snapshot (no double charging).
- Excludes pre-goal tokens from the creation turn (baseline reset at
  `create_goal`).

#### US-C4: Transition to budget-limited and wrap up
**As** the system, **I want** to mark the goal `budget_limited` and inject a
one-time wrap-up prompt when the budget is reached, **so that** work winds
down without claiming completion.

**Acceptance criteria:**
- When `tokensUsed >= tokenBudget`, the goal becomes `budget_limited`.
- A one-time wrap-up steering prompt is injected.
- The budget limit never calls completion or bypasses the audit.

### Epic D — Persistence (Codex-faithful)

#### US-D1: Persist one goal per thread
**As** the system, **I want** the goal stored transactionally in SQLite keyed
to the thread, **so that** it survives restarts and is atomic.

**Acceptance criteria:**
- Exactly one goal row per thread.
- Updates are transactional (all-or-nothing).
- Objective length is validated (≤ 4,000 chars, non-empty).

#### US-D2: Restore goal state after resume
**As** the runtime, **I want** to restore the persisted goal on thread resume,
**so that** an active goal resumes accounting and continuation.

**Acceptance criteria:**
- On resume, an `active` goal is re-marked active; other statuses clear the
  active accounting.
- No duplicate accounting after restore.

#### US-D3: Emit goal-updated events
**As** the app, **I want** a `ThreadGoalUpdated` event on every goal change,
**so that** the TUI and integrations stay in sync.

**Acceptance criteria:**
- Every mutation emits an event with the updated goal.
- Events carry thread id and (where applicable) turn id.

---

## 5. Out of Scope

The following are **deliberately excluded** to keep the replicate
Codex-faithful and minimal:

- **Multiple open goals per project / focus model.** Codex is single-goal per
  thread; this replicate preserves that.
- **Recursive task trees and task evidence.** Codex has no task model; the
  goal is the unit.
- **Verification contracts** as a persisted model field.
- **Independent completion auditor agent.** Completion is the model's
  prompt-driven self-audit (Codex-faithful).
- **Sisyphus / ordered-step mode.**
- **Goal-mode archival**; `clear` **deletes** goal state (Codex semantics),
  it does not archive.
- **Per-goal file persistence and ledger**; replaced by SQLite.

---

## 6. Acceptance / Definition of Done

A story is done when:

1. Its model-facing surface matches Codex exactly (same tool names/schemas,
   same status vocabulary).
2. All mutations route through a single service with version/token checks.
3. Tools are installed statically (no phase-dependent dynamic allowlist).
4. Behavior is covered by unit + integration tests, and serial runs pass.
5. The TUI renders from the same state the service mutates.
6. Typecheck (`npm run check`), package dry run, and install-as-extension all
   pass.

---

## 7. Non-functional Requirements

- **Fidelity:** The three tools, six statuses, and prompt policy mirror
  Codex.
- **Reliability:** Transactional writes; continuation serialized against
  mutation.
- **Inspectability:** SQLite is the source of truth; a CLI/TUI can read it.
- **Performance:** Tool schemas are small; the TUI renders only what changed.
- **Extensibility:** The service boundary is the only mutation path, so future
  features bolt on without widening the model surface.
