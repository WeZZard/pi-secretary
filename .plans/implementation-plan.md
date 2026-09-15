# Implementation Plan: Codex Goal Replicate with pi-goal-x TUI

**Project:** pi-secretary
**Document type:** Implementation Plan
**Status:** Draft
**Date:** 2026-09-15
**Phase count:** 6
**Source designs:** `../docs/user-stories/user-stories.md` · `../docs/ux/ux-design.md` · `../docs/arch/architecture.md`

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
- [ ] Unit tests: validation, single-goal invariant, transactional write,
  accounting idempotence.

**Exit:** storage layer fully tested; cannot create a second unfinished goal;
accounting is idempotent.

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

**Exit:** `goal.ts`/tools no longer write goal state directly; service is the
only mutation path.

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

**Exit:** exactly three advertised goal tools; schemas deep-equal the expected
specs.

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

**Exit:** continuation/accounting/budget behavior verified; steering prompts
bounded and escaped.

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

**Exit:** TUI matches `docs/ux/ux-design.md`; renders only from service state.

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
