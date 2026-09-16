# pi-secretary

A Pi extension for one persistent goal per session, with goal tools, `/goal` commands, and a goal widget and footer.

## Implementation status

- Goal changes are shared between the interface and the agent. Each model request receives the current goal status, including an explicit absence after clear.
- Commands report the actual result, including when an exhausted budget prevents resumption. Clearing requires confirmation.
- A provider error does not mark a goal blocked while Pi is still recovering. An unrecovered failure is applied after the run settles.
- Goal usage is finalized even when a tool completes or pauses the goal during a turn. Forks inherit the goal snapshot without transferring pending work.
- **Automatic continuation and automatic budget wrap-up are enabled through existing Pi facilities.** Pending work is checked against current intent immediately before submission; a newer pause, clear, or objective change supersedes earlier intent without aborting unrelated user input.
- Work already underway may finish, but its late control results cannot undo a newer decision. A valid no-op resume also supersedes an older failure even when the status remains `active`.
- Budget wrap-up is reporting-only and is tracked in session metadata to avoid repeating the same attempt after reload. An uncertain submission is not automatically replayed.
- If concurrent ordinary messages cannot be correlated unambiguously, the agent cannot guess which one authorized a goal change. It asks for an explicit `/goal` command instead; status inspection and unrelated messages are preserved.
- The synchronization implementation does not add the proposed expanded dashboard or keyboard shortcuts.

The implementation follows [the intent-ordering contract](docs/arch/architecture.md#135-intent-ordering-and-continuation-dispatch), with verification tracked in [the implementation plan](.plans/2026-09-16-11-13-goal-state-synchronization.md). The [old admission handoff](.handoff/pi-host-automatic-goal-admission.md) is superseded; no upstream host change is required.

## Install

```bash
pi install git:github.com/WeZZard/pi-secretary
```

## Goal controls

| Interface | Purpose |
| --- | --- |
| `get_goal` | The agent reads the current objective, status, budget, and usage. |
| `create_goal` | The agent creates a goal only when explicitly requested. |
| `update_goal` | The agent reports completion or blocking, or pauses at the user's request. |
| `/goal` | The user inspects the current goal. |
| `/goal <objective>` or `/goal edit` | The user creates or revises the objective. |
| `/goal pause` or `/goal resume` | The user changes whether the goal is active, subject to its budget. |
| `/goal clear` | The user removes the goal after confirmation. |

- Goals are stored in `~/.pi/secretary/pi-secretary-goals.sqlite` by default. `PI_SECRETARY_DB_DIR` selects a different directory.
- The tests use temporary or in-memory storage and deterministic local providers; they do not use your live goals or paid API requests.

## Development

```bash
npm install
npm run check
npm test
npm run lint:mermaid
npm pack --dry-run
```

- `npm test` includes component, adapter integration, and real Pi SDK host tests.
- The host tests run against Pi 0.85.1 and cover positive automatic dispatch, stale actions and late results, delayed input, preserved queued questions, retry/compaction recovery, and reporting-only budget wrap-up.
- See [the documentation guide](docs/README.md) for the responsibilities of requirements, UX, architecture, and implementation plans.

## License

MIT
