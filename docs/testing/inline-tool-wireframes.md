# Inline Tool Wireframe Tests

**Scope:** These deterministic tests compare the registered tools' composed Pi rows with [UX Section 2.1.1, wireframes A–I](../ux/subagents.md#211-working-inline-tool-wireframes). They do not implement the proposed renderers or establish human visual approval.

## Run the cases

```bash
node --experimental-strip-types --test --test-concurrency=1 tests/agents/inline-wireframes.test.ts
```

- The suite is included in `npm test` and `npm run test:subagents` because it uses the normal `tests/agents/*.test.ts` convention.
- The layout cases are ordinary assertions, not skipped tests or assertions that expect the renderer to fail. They exercise the implemented compact/full renderers and are part of the normal test gate.
- The tests use the existing isolated public-tool harness and a deterministic SDK provider. They do not contact a paid provider or read user credentials.
- The fixture launches a named agent, queues actual guidance, finishes both assistant turns, and asserts that the execution succeeded before testing completed layouts.
- Rendering uses the registered tool definitions and Pi's real `ToolExecutionComponent`. Testing only the exported rendering helpers would miss unattached hooks, the default call header, and duplicate headers.
- Display-only run values freeze activity, counters, elapsed time, and output path. Generated identifiers and temporary workspace paths are normalized to the illustrative values in the wireframes.
- Assertions remove terminal color and outer host padding, but preserve content order, indentation, and interior blank lines. The drawn documentation borders are not expected UI characters.
- Expected layouts are handwritten from the design. They are not snapshots accepted from the current implementation.

## Case mapping

| Case | Observable expectation |
| --- | --- |
| WF-A | The pending call has one identity header, with `model pending` until execution supplies a resolved model rather than assuming the requested model is already selected. |
| WF-B | Foreground progress retains the identity header, status, activity, statistics, and expansion hint, without separate task or mode rows. |
| WF-C | Compact completion contains only the destination header and outcome. |
| WF-D | Full completion shows identity, outcome, agent ID, run ID, workspace metadata, partial status, original prompt, and result in wireframe order. |
| WF-E | Background launch is one destination header with the `background` suffix, without a completion card or metadata body. |
| WF-F | Compact completion with at least one recorded turn or tool call shows statistics on the outcome line in the illustrated order. C covers zero recorded turns/tools. |
| WF-G | The legacy `TaskOutput` reference retains its default header, ten-line metadata preview, and configured expansion notice. |
| WF-H | Compact `SendMessage` shows destination and exactly one actual-message preview with a visible ellipsis when clipped. It does not substitute the optional summary or child output. |
| WF-I | Full `SendMessage` replaces the preview with the complete message, followed by the run identifier and acknowledgment. |
| WF-H/I, short message | A short message is complete without an ellipsis in compact state, and its separate lines are restored in full state. |

## Interpretation of the edited design

- The explanatory UX bullets now match the edited wireframes. The `SendMessage` header omits the model; compact `Agent` layouts omit the task preview and explicit foreground label; and a successful compact background launch has no separate acknowledgment line.
- Compact and full are Pi's collapsed and expanded states. There is no independent Secretary display-mode selector. Known legacy selector values are accepted and ignored without changing either state's behavior.
- The run identifier remains labeled `Run`, matching the edited wireframes. The suggested `Execution ID` label was not adopted in the document.
- WF-F asserts the exact statistics variant for recorded turn/tool activity; WF-C supplies zero counts and asserts the minimal variant. Elapsed time alone does not select F. Both expand to the same full layout.
- The configured shortcut spelling is not fixed in WF-B or WF-G. Their assertions check the hint's purpose and position rather than one terminal's key notation.
- The exact horizontal truncation point is width-dependent. WF-H checks a real message prefix, a single preview line, and a visible ellipsis rather than inventing a character limit.

## Coverage limits

- `inline-rendering.test.ts` covers independent 199/200/201 wrapped-line boundaries, resize, multiline text, unavailable artifacts, Unicode/control-sequence handling, and the compact/full body contract. `inline-presentation.test.ts` verifies original artifact content, operation separation, exclusive private files, symlink/mismatch rejection, queued-versus-resumed acknowledgment, and non-fatal artifact retention failure.
- Host-row tests cover first result paint, progress/completion on the same row, compact/full toggling, replay, unstructured rejection, and identity retention after an error. The fixture retains the real launch presentation metadata rather than expecting legacy `TaskOutput` to synthesize it.
- These suites use deterministic fixture models. They do not establish live-provider fallback behavior, a broader Pi version matrix, desktop behavior, or human visual approval.
- Component tests do not press terminal keys. The separate isolated PTY walkthrough exercises keyboard expansion and resize through the real Pi TUI; its execution and limits are recorded in the verification report.
- The old display-mode assertions were deliberately replaced with compact/full assertions. The corresponding acceptance specification and binding hash were updated together; a matching hash alone is not behavioral evidence.

## Verification status

- Type checking and the existing inline-renderer regressions should be run alongside this suite to distinguish test-construction errors from the expected design gaps.
- Store generated logs under a new ignored `test-results/` directory for each attempt. Do not copy actual render output into this document or promote it to a baseline.
