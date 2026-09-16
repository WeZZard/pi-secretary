# Superseded: Request-specific host admission for automatic goal turns

**Status:** Superseded by the intent-ordering design on 2026-09-16. This is a historical note, not an open handoff or an implementation prerequisite.
**Source project:** pi-secretary.

## Decision

- Do not transfer or implement this former handoff as a requirement for secretary's automatic continuation.
- The former proposal required every obsolete automatic request to be rejected before any model execution, with cancellation confined to that request.
- That was stronger than the required behavior. The revised contract orders user decisions and automatic work: discard obsolete pending work, let work already dispatched finish, and prevent its late control results from overriding newer intent.
- The governing design is [Architecture §13.5](../docs/arch/architecture.md#135-intent-ordering-and-continuation-dispatch), and the remaining local work is in [the synchronization plan](../.plans/2026-09-16-11-13-goal-state-synchronization.md).

## Evidence retained from the investigation

- The Pi 0.85.1 tests show that run-wide abort can interrupt a request containing user steering and restore an unrelated queued follow-up to the editor.
- They also show that authentication cancellation can prevent the inline provider callback. They do not establish that context abort always sends an unwanted network request.
- These findings justify avoiding blanket abort as a conflict-resolution strategy. They do not prove that an upstream host change is necessary for ordering-based continuation.

## Current code versus revised target

- `AutomaticGoalHost` and its missing-port disablement have been removed from the implementation.
- Local input ordering, dispatch checks, originating-intent guards, and real Pi SDK tests now implement continuation through existing Pi facilities.
- No host repository or installed Pi package was modified for this former handoff.
