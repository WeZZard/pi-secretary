# Implementation Plan: Goal State Synchronization

**Project:** pi-secretary
**Document type:** Implementation Plan
**Status:** Implemented and verified in the checkout. Local intent ordering, automatic continuation, and reporting-only budget wrap-up use existing Pi facilities; no upstream host-admission interface is required.
**Date:** 2026-09-16
**Design revision:** The implemented ordering contract supersedes the earlier strict cancellation requirement. The former host-port dependency has been removed.
**Scope:** Keep stored goal state, UI output, agent context, and subsequent automatic work aligned with the user's latest accepted decision without changing the three public tools or six statuses.

## 1. Design authority and current evidence

- [Architecture §13.5](../docs/arch/architecture.md#135-intent-ordering-and-continuation-dispatch) defines input receipt, UI publication, accepted intent, local dispatch, and late-result ordering.
- [Architecture §13.2](../docs/arch/architecture.md#132-committed-change-events-and-ownership) separates committed state revisions from accepted intent. [§13.3](../docs/arch/architecture.md#133-authoritative-context-before-each-model-request) defines current model context, and [§13.6](../docs/arch/architecture.md#136-lifecycle-errors-and-final-accounting) preserves recovery and accounting rules.
- [UX §2](../docs/ux/ux-design.md#2-product-model) and [§6](../docs/ux/ux-design.md#6-interaction-flows) define the user-facing promise: subsequent work follows the newer decision, while work already underway may finish without restoring old intent.
- [US-C1](../docs/user-stories/user-stories.md#us-c1-continue-automatically-while-idle) and [US-D4](../docs/user-stories/user-stories.md#us-d4-keep-the-ui-and-agent-synchronized) define the required outcomes. Mechanisms and counters belong in architecture, not those stories.
- The previous implementation passed 146 tests against Pi 0.85.1. The revised implementation passes 179 tests, including positive real-SDK continuation and the new ordering regressions. Type checking, Mermaid validation, Markdown links, whitespace checks, and package dry-run also pass.
- Production code now dispatches automatic continuation and budget wrap-up through existing Pi facilities. `AutomaticGoalHost` and the missing-port disablement are removed.
- Ordinary input is bound to receipts at actual user-message ingestion, never by assigning newly received authority to historical context. Ambiguous correlation refuses goal mutation and offers an explicit `/goal` command recovery path.
- Review regressions cover historical same-text input, superseded budget markers that must not consume delivery, and late cancellation that must not suppress a newer resume.
- Real SDK tests show why run-wide abort can disrupt unrelated user work. They do not establish that an upstream change is necessary for ordered continuation.
- The [former handoff](../.handoff/pi-host-automatic-goal-admission.md) is superseded. Do not transfer it or wait for a host patch as a condition of this plan.
- The [traceability document](../docs/research/codex-goal-test-traceability.md#9-goal-synchronization-implementation-evidence) retains baseline evidence and separately lists the new required ordering cases.

## 2. Completed baseline to preserve

- [x] Publish typed committed changes with previous/current snapshots, thread identity, revisions, and control generations; isolate listener failures and semantic no-ops.
- [x] Initialize goal widgets and footer state without requiring a prior `/goal` command, including stopped and absent goals.
- [x] Supply current goal state before each model request, remove obsolete extension-owned context, and preserve the stored transcript and unrelated messages.
- [x] Report actual command/tool results, including exhausted-budget pause/resume, and require clear confirmation.
- [x] Preserve fork snapshots and finalize originating-turn usage without duplicate charges or recreation of a cleared goal.
- [x] Distinguish successful retry or compaction recovery from an unrecovered failure, and distinguish signal-based cancellation from a project impasse.
- [x] Cover cross-thread revisions, stale objective results, and reentrant accounting with regression tests.

- These baseline items remain intact alongside the new input-receipt and accepted-intent ordering below.
- The old admission-port assumptions have been replaced with local-dispatch tests and positive real-host continuation cases.

## 3. Scope and constraints

- Use the existing Pi input, command, context, tool, and lifecycle facilities. No request-specific provider cancellation interface or host patch is a release prerequisite.
- Keep one current goal per session and SQLite as the authoritative store. Preserve public tool schemas and the existing goal-token accounting formula.
- Use session-epoch sequence numbers to decide order and timestamps to explain it. Do not infer human acknowledgment from a UI publication or compare wall clocks from different processes.
- Discard obsolete pending work before local dispatch. Work already dispatched may finish; prevent it from authorizing subsequent stale actions or overwriting newer intent.
- Do not add blanket `ctx.abort()` or queue clearing to eliminate stale wake-ups. A harmless reconciled response is allowed; interference with unrelated user work is not.
- Do not change live goals, installed Pi files, credentials, or existing `.pi` settings while developing. Use isolated databases, sessions, and deterministic fake providers.
- Keep requirements, UX, architecture, and implementation evidence in their respective documents under [the documentation guide](../docs/README.md).
- The proposed expanded dashboard, keyboard interactions, general descendant-accounting work, and a distributed multi-controller protocol remain outside this change.

## 4. Phase R1 — Record input, UI publication, and accepted intent

**Technical references:** [Architecture §5.2](../docs/arch/architecture.md#52-mutation-ordering), [§9.1–9.2](../docs/arch/architecture.md#91-command-adapter-semantics), and [§13.5](../docs/arch/architecture.md#135-intent-ordering-and-continuation-dispatch).

**Files:** `extensions/secretary/index.ts`, `goal-ui.ts`, `goal/goal-service.ts`, `goal/synchronization.ts`, and tests under `tests/service/` and `tests/integration/`.

- [x] Add a monotonically increasing sequence scoped to the session epoch, with diagnostic timestamps for receipt, publication, decision acceptance, dispatch, and result arrival.
- [x] Record the goal identity, revision, and ordering stamp successfully published to the UI. Treat headless operation and failed publication as an unavailable display reference, not as acknowledgment.
- [x] Stamp ordinary input at the earliest supported ingress observable by secretary and commands at command entry, before asynchronous processing. Test these separate routes because extension commands bypass the normal input hook.
- [x] Treat edit submission and affirmative clear confirmation as decision receipt, rather than assigning the opening command's time to a choice made later.
- [x] Preserve receipt identity through interpretation and any resulting goal-tool operation without adding public tool arguments. Never associate a delayed tool call with whichever user message happens to be newest.
- [x] Separate pending input, accepted goal decisions, invalid/cancelled input, and status-only or unrelated messages. Hold pending automatic dispatch while relevant input is unresolved; status questions must not create intent or resume a stopped goal.
- [x] Retain the receipt sequence when a decision is accepted. Reject an older decision processed after a newer accepted one, and explain supersession rather than silently overwriting the goal.
- [x] Advance accepted intent for a valid no-op decision without fabricating a storage mutation. Revalidate target identity, current budget, and permissions independently of temporal precedence.

**Exit criteria:** Equal timestamps and clock adjustments cannot reverse precedence; delayed processing cannot make an older decision newer; UI refreshes and status questions do not become goal-changing decisions.

## 5. Phase R2 — Restore automatic continuation using local dispatch ordering

**Dependencies:** Phase R1 must establish receipt and intent provenance before automation is re-enabled.

**Technical references:** [Architecture §6.2](../docs/arch/architecture.md#62-idle-continuation), [§13.3](../docs/arch/architecture.md#133-authoritative-context-before-each-model-request), and [§13.5](../docs/arch/architecture.md#135-intent-ordering-and-continuation-dispatch).

**Files:** `extensions/secretary/goal/synchronization.ts`, `goal/runtime.ts`, `goal-engine.ts`, `index.ts`, and adapter/host integration tests.

- [x] Replace the mandatory `AutomaticGoalHost` port with scheduling through existing Pi facilities. Remove the unconditional missing-port disablement and its obsolete warning after the new path passes tests.
- [x] Retain at most one local dispatch evaluation per thread. Form a fresh identified request from current goal/intent and control generation at dispatch, rather than copying authorization into a timer.
- [x] Immediately before submission, check current intent, compatible state, host idleness, tool availability, and unresolved input. Discard stale pending requests rather than relabeling them as fresh work.
- [x] Perform the final check and submission without an asynchronous gap, and record local dispatch order. Do not describe that order as proof of provider execution.
- [x] Associate the actual model request and subsequent goal actions with their originating work record; do not mark an arbitrary next user turn automatic.
- [x] When a newer decision follows dispatch, reconcile context and check provenance before subsequent goal actions. Preserve unrelated user messages and already-started work without blanket abort.
- [x] Allow an already-submitted obsolete wake-up to receive a reconciled model response, but prevent old-goal actions, state restoration, and repeated automatic wake-up loops.
- [x] Track definite submission failure separately from an uncertain outcome. Inspect lifecycle evidence before resubmitting uncertain work.
- [x] Restore automatic budget wrap-up under the same ordering checks, with deduplication for one exhaustion and a distinct allowance for a later genuine exhaustion. A superseded summary cannot restart the goal.

**Exit criteria:** An active goal continues automatically through stock Pi facilities. Newer decisions prevent stale pending work and subsequent old-intent actions without requiring zero obsolete provider invocations or disrupting user input.

## 6. Phase R3 — Apply originating-intent guards to late results

**Technical references:** [Architecture §6.3](../docs/arch/architecture.md#63-stop-on-error--empty--usage), [§13.5](../docs/arch/architecture.md#135-intent-ordering-and-continuation-dispatch), and [§13.6](../docs/arch/architecture.md#136-lifecycle-errors-and-final-accounting).

**Files:** `extensions/secretary/index.ts`, `goal/runtime.ts`, `goal/goal-service.ts`, `goal/tools/`, and runtime/integration tests.

- [x] Capture originating intent for automatic work, agent goal-tool calls, pending failures, and their retries. A delayed result must not receive authority from its arrival timestamp.
- [x] Compare originating goal identity and intent before applying completion, blocking, or follow-up scheduling. Include same-ID objective edits and valid no-op resume decisions.
- [x] Preserve the three-consecutive-turn blocker policy without allowing an older attempt's audit to block a fresh user decision.
- [x] Continue accounting eligible late usage to the originating goal even when its control result is superseded. Do not charge a replacement, recreate a cleared goal, erase spent budget, or bypass current limits.
- [x] Keep successful retry, compaction recovery, and abort classification intact while adding intent checks to settled outcomes.
- [x] Start a fresh ordering epoch on lifecycle replacement, reconcile stored state, and discard old pending work. Keep full interactive session-replacement coverage distinct from initialization-handler tests.

**Exit criteria:** A result may arrive after a newer decision but cannot undo it. Legitimate resource facts remain accounted, and fresh decisions are not confused with new status values alone.

## 7. Phase R4 — Verify temporal conflicts and update support claims

**References:** [Architecture §13.7](../docs/arch/architecture.md#137-verification-requirements), [UX §10](../docs/ux/ux-design.md#10-ux-acceptance-criteria), and [US-D4](../docs/user-stories/user-stories.md#us-d4-keep-the-ui-and-agent-synchronized).

- [x] Test publication, input receipt, decision acceptance, local dispatch, and result arrival in controlled orders using barriers, not timing sleeps.
- [x] Cover a decision between scheduling and dispatch, a decision after dispatch, and an earlier user message processed after a later accepted decision.
- [x] Cover identical timestamps, a backwards wall-clock adjustment, UI-publication failure, headless operation, and epoch replacement. Compare sequence and provenance rather than clock values.
- [x] Verify valid no-op resume, invalid/cancelled input, editor/confirmation submission, status-only questions, and unrelated user input interleaved with automatic work.
- [x] Verify that late completion and error judgments cannot override newer intent while late usage still follows the established accounting rules.
- [x] Exercise an already-dispatched stale wake-up on the real SDK. Assert current-state delivery, no subsequent stale goal actions, and preserved user input rather than requiring every stale model invocation to be suppressed.
- [x] Replace stock-host tests that require automation to remain disabled and replace mandatory-port assumptions with the revised dispatch path. Retain the mixed-user abort test as evidence against blanket cancellation, not as an upstream blocker.
- [x] Verify automatic continuation and one budget wrap-up per exhaustion through the installed adapter, including failed or uncertain submission handling and session replacement.
- [x] Update test traceability, README, architecture implementation status, and this plan only after the corresponding behavior is implemented and verified.
- [x] Run the validation commands below and review documentation boundaries and relative links.

**Exit criteria:** The transition matrix has current integration evidence, ordinary automation is restored, and neither code nor documentation treats the superseded host-cancellation proposal as a prerequisite.

## 8. Validation commands

```bash
npm run check
npm test
npm run lint:mermaid
git diff --check
npm pack --dry-run
```

- The existing test command includes component, adapter, and host tests. Keep host tests isolated and deterministic, without live goals or paid APIs.
- Passing the baseline suite alone does not satisfy the new ordering cases. Record the tested Pi version and the new cases in the traceability document.
- Validate Markdown links and section anchors in the revised design and plan.

## 9. Rollout and completion boundary

- Implement and verify receipt ordering and late-result guards before removing the current automation disablement. Ship the restoration as a local implementation change, not as an assumed consequence of this documentation edit.
- Preserve existing goal records and historical transcripts. Filter obsolete extension instructions only in outgoing context, and never discard unrelated user input to enforce goal ordering.
- The old handoff is superseded and requires no transfer. A future optional cancellation optimization would be a separate proposal, not a hidden prerequisite for this work.
- Phases R1–R4 are implemented and verified in the checkout. This does not imply installation into a live Pi session, a commit, or completion of the separate expanded-dashboard and keyboard work.
- Verification covers real SDK initialization and request behavior plus controller epoch isolation. It does not claim a full physical-terminal interaction test.
