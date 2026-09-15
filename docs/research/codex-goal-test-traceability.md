# Test Case Inventory: Codex Goal System (translated for pi-secretary)

**Project:** pi-secretary — Codex goal replicate
**Document type:** Test Design Specification / Requirement Traceability Matrix
**Status:** Draft
**Date:** 2026-09-15
**Source:** OpenAI Codex `codex-rs/` goal test suite (Rust)
**Related:** `../arch/architecture.md` · `../../.plans/2026-09-15T13-17-45z-codex-goal-replicate.md`

> **Scope.** This doc translates the **scenarios** of Codex's goal test suite
> into the naming and structure of the pi-secretary TypeScript replicate. It
> is a **verification reference**, not runnable code. Each case is mapped to
> the `.plans` phase and the module (`GoalService`, storage, tools, runtime,
> steering) that must satisfy it.
>
> **Why translation, not copy.** Codex's tests are Rust integration tests
> against `codex_state` and a `GoalExtensionHarness`. Our replicate is
> TypeScript and the modules do not exist yet. The scenarios below are the
> authoritative behavior contract; they will be turned into runnable
> TypeScript tests in their owning phase.

---

## 1. Inventory of Source Layers

| Source file | Layer | Native tests |
| --- | --- | --- |
| `codex-rs/ext/goal/tests/goal_extension_backend.rs` | Tool / backend integration | 27 |
| `codex-rs/ext/goal/tests/accounting.rs` | Accounting state | 7 |
| `codex-rs/ext/goal/tests/steering.rs` | Steering prompts | 2 |
| `codex-rs/state/src/runtime/goals.rs` | Storage / DB layer | 23 |
| `codex-rs/app-server/tests/suite/v2/thread_goal_empty_responses.rs` | App-server behavior | 1 |
| `codex-rs/tui/src/chatwidget/tests/{goal_menu,goal_validation}.rs` | TUI | 17 |
| **Total** | | **77** |

The storage layer (`goals.rs`) is the deepest and densest; the tool/backend
layer exercises the public surface. The TUI tests cover the pi-goal-x-style
presentation that our replicate ports.

---

## 2. Scenario-to-Module Mapping

| Scenario | Native test | pi-secretary module | Phase |
| --- | --- | --- | --- |
| Create goal + fill empty preview | `installed_goal_tools_create_goal_and_fill_empty_preview` | `tools/create_goal` | 3 |
| Apply max token budget | `installed_goal_tools_apply_maximum_token_budget` | `create_goal` | 3 |
| Ephemeral tools reject execution | `ephemeral_goal_tools_preserve_specs_but_reject_execution` | `tools` | 3 |
| Tools hidden for review subagents | `goal_tools_hidden_for_review_subagents` | `tools` | 3 |
| Only replace a complete goal | `installed_goal_tools_only_replace_complete_goal` | `create_goal` | 3 |
| Reset baseline before turn-stop accounting | `create_goal_resets_baseline_before_turn_stop_accounting` | `accounting` | 4 |
| Tool-finish accounts + emits event | `tool_finish_accounts_active_goal_progress_and_emits_event` | `accounting` | 4 |
| Parallel tool-finish accounts once | `parallel_tool_finish_accounts_active_goal_progress_once` | `accounting` | 4 |
| Spawned descendant usage exhausts budget once | `spawned_descendant_usage_exhausts_root_goal_budget_once` | `accounting` | 4 |
| Grandchild usage rolls up after parent unloads | `grandchild_usage_rolls_up_after_parent_runtime_unloads` | `accounting` | 4 |
| Subagent usage resets when root goal replaced | `subagent_usage_resets_when_root_goal_is_replaced` | `accounting` | 4 |
| Budget-limited keeps accruing until turn-stop | `budget_limited_goal_keeps_accruing_until_turn_stop` | `accounting` | 4 |
| Budget-limited keeps accounting after later tool-finish | `budget_limited_goal_keeps_accounting_after_later_tool_finish` | `accounting` | 4 |
| Turn-error usage-limit accounts + clears | `turn_error_usage_limit_accounts_progress_and_clears_accounting` | `runtime` | 4 |
| Turn-error blocks goal | `turn_error_blocks_goal` | `runtime` | 4 |
| Failed-execution turns block unless a tool succeeds | `failed_execution_turns_block_goal_unless_a_tool_succeeds` | `runtime` | 4 |
| Usage-limit budget-limited accounts remaining | `usage_limit_budget_limited_goal_accounts_remaining_progress` | `runtime` | 4 |
| Usage-limit plan-turn does not stop goal | `usage_limit_plan_turn_does_not_stop_goal` | `runtime` | 4 |
| Usage-limit stale turn does not stop current goal | `usage_limit_stale_turn_does_not_stop_current_goal` | `runtime` | 4 |
| `update_goal` stops and accounts final progress | `update_goal_can_stop_and_accounts_final_progress` | `tools/update_goal` | 3 |
| `update_goal` rejects resume/system-limit statuses | `update_goal_rejects_resume_and_system_limit_statuses` | `tools/update_goal` | 3 |
| External mutation start accounts active progress | `external_goal_mutation_start_accounts_active_goal_progress` | `runtime` | 4 |
| External set active preserves concurrent usage | `goal_service_external_set_active_preserves_concurrent_usage` | `runtime` | 4 |
| Thread stop unregisters runtime | `thread_stop_unregisters_goal_runtime_from_service` | `runtime` | 4 |
| Thread resume rehydrates active idle accounting | `thread_resume_rehydrates_active_goal_idle_accounting` | `runtime` | 4 |
| Service set/get/clear thread goal | `goal_service_sets_gets_and_clears_thread_goal` | `GoalService` | 2 |
| Service enforces max token budget | `goal_service_enforces_maximum_token_budget_on_creation_and_updates` | `GoalService` | 2 |

### Accounting scenarios (`accounting.rs`)

| Scenario | Native test |
| --- | --- |
| Per-turn start baseline gives exact deltas | `goal_accounting_uses_turn_start_baseline_for_exact_deltas` |
| Ignore plan-mode turns | `goal_accounting_ignores_plan_mode_turns` |
| Empty continuations need 3 turns without activity/change | `empty_continuations_require_three_turns_without_activity_or_goal_changes` |
| Execution failures do not transfer to replacement goal | `execution_failures_do_not_transfer_to_a_replacement_goal` |
| Script/pre-execution errors do not block goals | `script_errors_and_failures_before_execution_do_not_block_goals` |
| Successful tool resets failures before interrupted turn ends | `successful_tool_resets_failures_before_an_interrupted_turn_ends` |
| Concurrent descendant usage preserved across checkpoints | `goal_accounting_preserves_concurrent_descendant_usage_across_checkpoints` |

### Steering scenarios (`steering.rs`)

| Scenario | Native test |
| --- | --- |
| Enabled checklist preserves the original continuation prompt | `enabled_checklist_preserves_the_original_continuation_prompt` |
| Disabled checklist preserves goal text mentioning the tool | `disabled_checklist_preserves_goal_text_that_mentions_the_tool` |

---

## 3. Storage-Layer Scenarios (`goals.rs`)

These are the deepest invariants of the persistence layer. They map to
`storage/goal-db.ts` (Phase 1) and are the foundation for everything above.

| Scenario | Native test | Invariant |
| --- | --- | --- |
| Replace/update/get thread goal | `replace_update_and_get_thread_goal` | Basic CRUD round-trip; `replace` resets usage. |
| Replace applies budget-limit immediately | `replace_thread_goal_applies_budget_limit_immediately` | `token_budget=0` ⇒ `budget_limited`. |
| Insert does not replace existing | `insert_thread_goal_does_not_replace_existing_goal` | Single-goal-per-thread for active/replace. |
| Insert applies budget-limit immediately | `insert_thread_goal_applies_budget_limit_immediately` | Insert with budget 0 ⇒ `budget_limited`. |
| Update ignores replaced-goal version | `update_thread_goal_ignores_replaced_goal_version` | `expected_goal_id` CAS rejects stale writes. |
| Usage accounting ignores replaced version | `usage_accounting_ignores_replaced_goal_version` | Accounting never applies to a replaced goal. |
| Objective update preserves usage + created_at | `update_thread_goal_objective_preserves_usage_and_created_at` | Edit does not reset usage/timestamps. |
| Concurrent partial updates preserve independent fields | `concurrent_partial_updates_preserve_independent_fields` | Row-level field independence. |
| Pause active does not clobber terminal status | `pause_active_thread_goal_does_not_clobber_terminal_status` | `paused` cannot override `complete`. |
| Usage-limit updates active or budget-limited | `usage_limit_active_thread_goal_updates_active_or_budget_limited_goals` | System stop applies to active/budget-limited. |
| Usage accounting updates active, accounts budget-limited in-flight | `usage_accounting_updates_active_goals_and_accounts_budget_limited_in_flight_usage` | In-flight tokens still charged. |
| Active-only accounting does not update budget-limited | `active_status_only_usage_accounting_does_not_update_budget_limited_goals` | Mode-scoped accounting. |
| Stopped accounting promotes paused goal over budget | `stopped_usage_accounting_promotes_paused_goal_over_budget` | Stop wins over budget for a paused goal. |
| Budget update immediately stops active over-budget | `budget_updates_immediately_stop_active_goals_already_over_budget` | Lowering budget stops active goal now. |
| Activating over-budget goal keeps it budget-limited | `activating_goal_already_over_budget_keeps_it_budget_limited` | Cannot activate over budget. |
| Pausing budget-limited preserves terminal | `pausing_budget_limited_goal_preserves_terminal_status` | `paused` does not lift `budget_limited`. |
| Blocking budget-limited preserves terminal | `blocking_budget_limited_goal_preserves_terminal_status` | `blocked` does not lift `budget_limited`. |
| Usage accounting can finalize completed goal | `usage_accounting_can_finalize_completed_goal_for_completing_turn` | `complete` plus in-flight tokens. |
| Usage accounting can finalize stopped goal | `usage_accounting_can_finalize_stopped_goal_for_in_flight_turn` | `stopped` plus in-flight tokens. |
| Usage accounting adds concurrent token deltas | `usage_accounting_adds_concurrent_token_deltas` | No lost updates under concurrency. |
| Deleting thread deletes goal | `deleting_thread_deletes_goal` | Cascading delete. |

### App-server scenario

| Scenario | Native test | Invariant |
| --- | --- | --- |
| Empty goal continuations block after three without activity | `empty_goal_continuations_block_after_three_without_activity` | 3-turn empty-continuation rule (see also accounting). |

---

## 4. TUI Scenarios (pi-goal-x presentation)

These map to the widget / dashboard / command / validation UX (Phase 5). See
`docs/ux/ux-design.md`.

| Scenario | Native test |
| --- | --- |
| Goal menu renders summary | `goal_menu.rs` (13 tests) |
| Goal validation/status | `goal_validation.rs` (6 tests) |

Detailed sub-scenarios for the TUI are enumerated in `docs/ux/ux-design.md`
and the corresponding user stories (`US-B1..B3`).

---

## 5. Priority and Sequencing

### Phase 1 — storage (`storage/goal-db.ts`)
Must satisfy §3 invariants: single-goal-per-thread, budget-limit immediacy,
`expected_goal_id` version guard, field-preserving updates, concurrent
accounting deltas, cascade delete.

### Phase 2 — `GoalService`
Must satisfy §2 service scenarios: set/get/clear, max-budget enforcement,
terminate-only updates.

### Phase 3 — tools
Must satisfy §2 tool scenarios: create/get/update surface, single-goal
invariant, budget caps, ephemeral/subagent rejection, `update_goal`
status whitelist.

### Phase 4 — runtime + accounting
Must satisfy §2 accounting + runtime scenarios: baselines, plan-mode
exclusion, empty-continuation 3-turn rule, stop-on-error/usage, budget-limit
accrual, descendant usage roll-up, external-mutation effects.

### Phase 5 — TUI
Must satisfy §4 and `docs/ux/ux-design.md`.

---

## 6. Porting Notes

- **Test harness.** Our TypeScript harness will seed an in-memory SQLite DB
  and a fake `GoalService`/runtime, mirroring Codex's `GoalExtensionHarness`.
- **`expected_goal_id`.** Every multi-step scenario in §2 that involves a
  mutation must assert the CAS rejection path (stale token ⇒ no write).
- **Status precedence.** §3's "preserves terminal status" tests encode the
  ordering rule: `budget_limited`/`complete` cannot be overridden by
  `paused`/`blocked`; only the user/systems transition out of them.
- **Budget-limit vs accounting mode.** Distinguish `ActiveOnly` from
  `ActiveOrComplete`/`ActiveOrStopped` accounting modes (see architecture.md
  §7).

---

## 7. Acceptance

This reference is complete when:

1. Every scenario in §2–§4 is represented, with a module + phase owner.
2. The storage (§3) invariants are the same set as Codex's `goals.rs`.
3. No Codex goal scenario is dropped silently.
4. Each scenario maps to a user story or arch requirement.
