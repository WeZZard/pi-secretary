# Implementation Plan: Codex Goal Replicate with pi-goal-x TUI

**Project:** pi-secretary
**Document type:** Implementation Plan
**Status:** Draft
**Date:** 2026-09-15
**Phase count:** 6
**Source designs:** `../docs/user-stories/user-stories.md` · `../docs/ux/ux-design.md` · `../docs/arch/architecture.md`
**Test traceability:** `../docs/research/codex-goal-test-traceability.md`

> **Tests are built per phase.** Every phase that introduces a module also
> turns the corresponding scenarios from the **traceability matrix**
> (`codex-goal-test-traceability.md`) into runnable TypeScript tests before the
> phase is considered done. A phase is not complete until its mapped scenario
> set is green.

---

## 0. Summary

Port **OpenAI Codex's goal semantics** (three tools, six statuses,
single-goal-per-thread, SQLite, prompt-driven completion) into the
`pi-secretary` extension, presented through **pi-goal-x's TUI** (above-editor
widget + dashboard, status line, `/goal` command palette, keybindings).

The work is decomposed into **6 independently shippable, reviewable phases**,
each small enough to review and each leaving the extension in a working state.

### Phase roadmap

| Phase | Title | Exit criteria |
| --- | --- | --- |
| 0 | Characterize & wire the extension skeleton | Extension loads as a pi package; test harness runs. |
| 1 | SQLite storage + data model | `thread_goals` table; CRUD + validation tested. |
| 2 | `GoalService` (sole mutation boundary) | All mutations route through the service; tested. |
| 3 | Core tools (`get_goal` / `create_goal` / `update_goal`) | Exactly three statically-installed tools; schemas match Codex. |
| 4 | Runtime: continuation, restore, accounting, budget | Idle continuation, per-turn accounting, budget-limit, steering. |
| 5 | TUI: widget, dashboard, palette, keybindings | pi-goal-x-style TUI renders from service state. |

Recommended ordering is strict: persistence → service → tools → runtime →
TUI. However, phases 3–5 can be developed against a stub service if a vertical
slice is preferred.

---

## 1. Cross-cutting Conventions

- **Language/format:** TypeScript (`NodeNext`, `verbatimModuleSyntax`),
  `noEmit` typecheck via `tsc`.
- **Package manifest:** `package.json` with `pi.extensions: ["extensions"]`.
- **Test invocation:** serial mode (`--test-concurrency=1`) to avoid parallel
  `EMFILE` loader flakes (see pi-goal-x hardening notes).
- **Single mutation path:** no tool/command/UI writes goal state directly; all
  go through `GoalService`.
- **Expected id / version token:** every async mutation captures
  `expected_goal_id` and is validated immediately before write.

---

## 2. Phase 0 — Characterize & Wire the Extension Skeleton

**Goal:** A working pi package that loads the goal extension and runs tests.

### Tasks
- [ ] Adopt a test harness (e.g. `node --experimental-strip-types --test
  --test-concurrency=1`) and a `check` script.
- [ ] Create `extensions/goal.ts` thin installer that registers a no-op
  extension (or wire the empty skeleton).
- [ ] Add package scripts: `check`, `test`, `test:serial`, `pack:dry`.
- [ ] Add a smoke test asserting the extension factory runs and registers no
  tools yet.
- [ ] Typecheck + package dry run pass.

**Exit:** `npm run check`, `npm test`, and `npm pack --dry-run` pass; the
extension loads via `pi -e ./extensions/goal.ts`.

---

## 3. Phase 1 — SQLite Storage + Data Model

**Goal:** Persist one goal per thread in SQLite, with validation.

### Tasks
- [ ] `extensions/storage/goal-db.ts` — open/create the SQLite DB, apply the
  `thread_goals` DDL (§3.3 of architecture.md).
- [ ] Define `ThreadGoal` and `ThreadGoalStatus` types (§3.1–3.2
  architecture.md), including `MAX_THREAD_GOAL_OBJECTIVE_CHARS = 4000` and
  `validate_thread_goal_objective`.
- [ ] Implement CRUD: `get_thread_goal`, `insert_thread_goal`,
  `update_thread_goal`, `delete_thread_goal`, plus
  `account_thread_goal_usage` (token/time deltas) and
  `has_thread_goal_continuation_deferral`.
- [ ] Enforce single-goal-per-thread: `insert_thread_goal` fails if an
  unfinished goal exists.

### Test cases to build (traceability §3) — `tests/storage/goal-db.test.ts`
- [ ] CRUD round-trip (`replace_update_and_get_thread_goal`).
- [ ] Budget-limit immediacy on replace and insert (`*_applies_budget_limit_immediately`).
- [ ] Insert does not replace existing goal (`insert_thread_goal_does_not_replace_existing_goal`).
- [ ] `expected_goal_id` version guard rejects stale writes (`update_thread_goal_ignores_replaced_goal_version`, `usage_accounting_ignores_replaced_goal_version`).
- [ ] Objective update preserves usage/created_at (`update_thread_goal_objective_preserves_usage_and_created_at`).
- [ ] Concurrent partial updates preserve independent fields.
- [ ] Terminal-status precedence (pause/block cannot override `complete`/`budget_limited`).
- [ ] Accounting mode scoping (ActiveOnly vs ActiveOrComplete/Stopped) and concurrent delta addition.
- [ ] Cascade delete on thread delete.

**Exit:** all storage scenarios in traceability §3 are green; cannot create a
second unfinished goal; accounting is idempotent.

---

## 4. Phase 2 — GoalService (sole mutation boundary)

**Goal:** All mutations route through `GoalService`.

### Tasks
- [ ] `extensions/goal-service.ts` — `createGoal`, `getGoal`, `setGoal`
  (objective/status/budget), `clearGoal`, `requestTerminalUpdate`.
- [ ] Centralize the `goal_state_permit` semaphore — serialize a persisted
  mutation against idle continuation.
- [ ] Capture and validate `expected_goal_id` on every write (compare-and-apply).
- [ ] Define `GoalMutationOutcome` carrying runtime effects (`start_if_idle` /
  `stop` / `unchanged`) and steering hints.
- [ ] Emit `ThreadGoalUpdated` on every mutation.
- [ ] Tests: create/get/set/clear, single-goal invariant, late-result
  `expected_goal_id` rejection, mutation-effect ordering.

### Test cases to build (traceability §2 service rows) — `tests/service/goal-service.test.ts`
- [ ] Set/get/clear thread goal (`goal_service_sets_gets_and_clears_thread_goal`).
- [ ] Enforce maximum token budget on create/update (`goal_service_enforces_maximum_token_budget_on_creation_and_updates`).
- [ ] `requestTerminalUpdate` only accepts terminal statuses for the model.
- [ ] Late (stale) result is rejected via `expected_goal_id` / focus token.

**Exit:** `goal.ts`/tools no longer write goal state directly; service is the
only mutation path; service scenarios green.

---

## 5. Phase 3 — Core Tools (`get_goal` / `create_goal` / `update_goal`)

**Goal:** Exactly three statically-installed tools matching Codex schemas.

### Tasks
- [ ] `extensions/tools/goal-tools.ts` — tool specs (§4 architecture.md):
  - `get_goal` — `{}`
  - `create_goal` — `{ objective, token_budget? }`
  - `update_goal` — `{ status: complete|blocked|paused }`
- [ ] Thin executors that call `GoalService` and return a `GoalToolResponse`
  (`goal`, `remainingTokens`, `completionBudgetReport`).
- [ ] Enforce: create only on explicit request; create fails when an unfinished
  goal exists; `paused` only on user request; `update_goal` accepts only one
  field.
- [ ] Install tools **statically** (no dynamic allowlist by phase).
- [ ] Tool-selection tests: no calls to removed tools; no confusion between
  complete/blocked/paused.

### Test cases to build (traceability §2 tool rows) — `tests/tools/goal-tools.test.ts`
- [ ] Create goal + fill empty preview (`installed_goal_tools_create_goal_and_fill_empty_preview`).
- [ ] Apply max token budget (`installed_goal_tools_apply_maximum_token_budget`).
- [ ] Ephemeral tools preserve specs but reject execution (`ephemeral_goal_tools_preserve_specs_but_reject_execution`).
- [ ] Tools hidden for review subagents (`goal_tools_hidden_for_review_subagents`).
- [ ] Only replace a completed goal (`installed_goal_tools_only_replace_complete_goal`).
- [ ] `update_goal` can stop + accounts final progress; rejects resume/system-limit statuses (`update_goal_rejects_resume_and_system_limit_statuses`).
- [ ] Tool-selection: no calls to removed tools; no confusion between complete/blocked/paused.

**Exit:** exactly three advertised goal tools; schemas deep-equal the expected
specs; tool scenarios green.

---

## 6. Phase 4 — Runtime: Continuation, Restore, Accounting, Budget

**Goal:** Codex-faithful idle continuation + accounting + budget-limit.

### Tasks
- [ ] `extensions/goal-runtime.ts` — `GoalRuntimeHandle`:
  - `restore_after_resume` (active → re-mark active; else clear).
  - `continue_if_idle` (only `active` + `tools_available`) via
    `start_turn_if_idle(TurnInput(ResponseItem(steering)))`.
  - stop-on-error/empty/usage → `blocked` / `usage_limited`.
  - external-mutation effects (`apply_external_goal_set/clear`).
- [ ] `extensions/goal-accounting.ts` — per-turn baselines, idempotent
  `account_thread_goal_usage`, budget-limit transition.
- [ ] `extensions/prompts/goal-prompts.ts` — bounded `continuation.md`,
  `budget_limit.md`, `objective_updated.md` templates; escape objective as
  untrusted; hard size cap.
- [ ] Tests: continuation gated by permit; restore; stop reasons; no
  double-charge; budget-limit exactly once; template escaping/caps.

### Test cases to build (traceability §2 accounting/runtime rows + §2 accounting & steering tables) — `tests/runtime/goal-runtime.test.ts`, `tests/runtime/goal-accounting.test.ts`, `tests/prompts/goal-prompts.test.ts`
- [ ] Per-turn start baseline gives exact deltas (`goal_accounting_uses_turn_start_baseline_for_exact_deltas`).
- [ ] Ignore plan-mode turns (`goal_accounting_ignores_plan_mode_turns`).
- [ ] Empty continuations require 3 turns without activity (`empty_continuations_require_three_turns_without_activity_or_goal_changes`).
- [ ] Execution failures do not transfer to a replacement goal.
- [ ] Successful tool resets failures before an interrupted turn ends.
- [ ] Concurrent descendant usage preserved across checkpoints.
- [ ] Budget-limited keeps accruing; spawn/grandchild/subagent usage roll-up.
- [ ] Turn-error / usage-limit stop reasons; stale turn does not stop current goal.
- [ ] External mutation start/set accounts active progress; preserves concurrent usage.
- [ ] Thread stop unregisters runtime; resume rehydrates idle accounting (trace §2 runtime rows).
- [ ] Steering: checklist on/off preserves the original continuation prompt and goal text (trace §2 steering table).

**Exit:** continuation/accounting/budget behavior verified; steering prompts
bounded and escaped; runtime/accounting/steering scenarios green.

---

## 7. Phase 5 — TUI: Widget, Dashboard, Palette, Keybindings

**Goal:** pi-goal-x-style presentation over Codex semantics.

### Tasks
- [ ] `extensions/widgets/goal-widget.ts` — compact above-editor widget
  (status dot + label, truncated objective, `tokensUsed`/`timeUsedSeconds`).
- [ ] Expanded dashboard (`Ctrl+Shift+T`): status, objective, usage, budget,
  created/updated. `Esc` collapses.
- [ ] Status line (compact one-line summary).
- [ ] `extensions/commands/goal-commands.ts` — `/goal` namespace: bare summary,
  `/goal <objective>`, `edit`, `pause`, `resume`, `clear` (with confirm).
- [ ] Wire everything to render from the authoritative service snapshot, and
  re-render on `ThreadGoalUpdated`.
- [ ] UX tests: widget present when a goal exists; expand/collapse; command
  feedback; clear confirmation; no task tree/contracts/auditor surfaced.

### Test cases to build (traceability §4 + UX stories) — `tests/tui/goal-widget.test.ts`, `tests/commands/goal-commands.test.ts`
- [ ] Goal menu renders summary / validation states (trace §4 goal_menu + goal_validation).
- [ ] Widget present when a goal exists; absent when none.
- [ ] Expand/collapse via `Ctrl+Shift+T`; `Esc` collapse/pause.
- [ ] Command palette: bare summary, create, edit, pause, resume, clear-with-confirm.
- [ ] No task tree / contracts / auditor surfaced (Codex-faithful).

**Exit:** TUI matches `docs/ux/ux-design.md`; renders only from service state;
TUI scenarios green.

---

## 8. Deliverable Mapping

| Story | Phase |
| --- | --- |
| US-A1..A5 (core lifecycle) | 2, 3 |
| US-B1..B3 (TUI) | 5 |
| US-C1..C4 (continuation/accounting) | 4 |
| US-D1..D3 (persistence) | 1 |

---

## 9. Validation Commands

```bash
npm install
npm run check                          # tsc --noEmit
node --experimental-strip-types --test --test-concurrency=1 tests/*.test.ts
npm pack --dry-run
git diff --check
pi -e ./extensions/goal.ts -p "Hello"  # smoke: extension loads
```

---

## 10. Risks & Rollback

- **Static tools allow invalid phase calls** → service validators + actionable
  tool results.
- **Prompt-only completion audit inconsistent** → mirror Codex template wording,
  gate release on evaluations.
- **Single-goal-per-thread limiting** → deliberate (Codex). Document in README.
- **SQLite opacity** → expose a read path in TUI/CLI; no schema churn.
- **Late async results** → `expected_goal_id` + permit.

Each phase is independently revertible. Do not dual-write a second storage
format; keep old data readers if any migration occurs.
