# Testing Guide

Use this guide to choose a verification layer. Test procedures explain how to reproduce a check; the [subagent verification report](subagent-verification.md) records dated observations and remaining limits.

## Choose a test command

| Purpose | Command | Model and environment requirements |
| --- | --- | --- |
| Run the routine development gate. | `npm run verify` runs type checking, the default tests, Mermaid validation, and acceptance linting. | The tests use deterministic fixtures and do not make paid model requests. |
| Run focused subagent tests. | `npm run test:subagents` runs component and SDK regressions. | The tests use temporary state and deterministic providers. |
| Execute the Gherkin acceptance bindings. | `npm run test:acceptance` runs scenario-specific adapters. | The tests use isolated fixtures rather than a live provider. |
| Check acceptance syntax and identities only. | `npm run lint:acceptance` parses the specifications. | This command does not execute the scenarios. |
| Run all real-provider E2E cases. | `npm run test:e2e` runs headless and interactive cases sequentially. | A configured LiteLLM installation is required, and model calls may incur charges. |
| Run headless real-provider cases. | `npm run test:e2e:headless` runs the six-case workspace matrix. | A configured LiteLLM installation is required. |
| Run interactive real-provider cases. | `npm run test:e2e:interactive` runs the parent TUI with widget extensions. | LiteLLM, the installed widget packages, Python 3, and POSIX PTY support are required. |
| Record the deterministic UI walkthrough. | `npm run record:tui` records the prescribed interactions. | The walkthrough runs real Pi with a deterministic provider, not a paid model. |
| Replay a terminal recording. | `npm run render:tui -- <recording-directory>` reconstructs character grids. | Replay does not run a model or establish human visual approval. |

The default `npm test` and `npm run verify` commands do not include the paid-provider E2E suites. Run those suites explicitly when their prerequisites and costs are acceptable.

## Procedures and references

- Follow [Subagent E2E Tests](subagent-e2e.md) for provider setup, interaction modes, fixture layout, and live-run evidence.
- Follow the [deterministic TUI recording procedure](../../doc/acceptance/tui-recording.md) for the longer inspector and keyboard walkthrough.
- Read the [acceptance specification index](../../doc/acceptance/README.md) for scenario identities, source-hash checks, and approval tags.
- Follow the [test artifact policy](test-artifacts.md) when recording, sharing, retaining, or deleting generated output.
- Read the [verification report](subagent-verification.md) for the tested implementation baseline and known gaps.

## Interpret results correctly

- Type checking and syntax linting do not establish that a runtime scenario executed.
- Real-SDK tests with deterministic providers establish different evidence from live-provider E2E tests.
- A successful process exit is not sufficient evidence of a successful child task. E2E assertions inspect persisted outcomes and transcripts.
- Terminal recordings and reconstructed grids do not establish human visual approval, desktop-window behavior, or compatibility with every terminal emulator.
- Keep generated logs and recordings under ignored `test-results/`. Do not promote actual run output into expected baselines without review.
