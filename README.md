# pi-secretary

A Pi extension for persistent goals and controlled subagent execution, with goal commands, agent tools, and a terminal inspector.

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

## Subagent controls

| Interface | Purpose |
| --- | --- |
| `Agent` | The parent delegates a task with `prompt`, `description`, and an optional agent type, model alias, name, or worktree request. |
| `SendMessage` | The parent sends guidance to a running child or explicitly resumes an eligible saved agent. |
| `TaskStop` | The parent requests cancellation of a Secretary-owned execution without rolling back files. |
| `TaskOutput` | The parent reads current output or waits for a captured run. Cancelling the wait does not cancel the child. |
| `/agents` | The user opens the agent list and transcript inspector. |
| `/agents stop <id-or-name>` | The user confirms cancellation of the selected execution. |
| `/agents cleanup <id-or-name>` | The user confirms conservative cleanup of an unchanged, idle worktree. |

- Background execution is the default in persistent TUI and RPC sessions. Print and JSON mode default to foreground execution and reject explicit background requests and idle-agent resumption.
- Ordinary spawning shares the parent's working directory and requires no Git history. Requested isolation uses a real Git worktree for a committed checkout or an explicitly reported directory snapshot for a project without Git or an unborn branch. The fallback copies current files without Git metadata and never initializes or commits the original project.
- Child sessions use the parent's model and authentication through delegation rather than a second copy of stored credentials. The parent keeps its terminal and widgets; child sessions use Pi's native headless UI context, so widget extensions do not attempt terminal rendering in a child.
- Child sessions stop when pi exits or replaces the parent session. Saved conversations do not continue in a detached supervisor and are not automatically restarted.
- `general-purpose` is resumable. Packaged `Explore` and `Plan` are one-shot definitions with read-only tools.
- Trusted project definitions in `.pi/agents/` override user definitions in the pi agent directory's `agents/` folder. Definitions use Markdown and supported YAML frontmatter; unsupported behavioral fields fail validation.
- The public tool schemas follow the documented Claude Code 2.1.272 subset. Conversation forks, teams, remote execution, nested delegation, and workflow orchestration are not implemented.
- If another extension provides one of the same control tools, Secretary refuses delegation registration instead of silently overriding it. Disable the conflicting extension before reloading.
- FleetView appears below the editor. Down or Left activates it from an empty editor. The inspector supports guidance, stop confirmation, transcript scrolling, and tool-detail expansion without replacing the goal widget.
- Git worktrees use the captured parent `HEAD` commit and do not include uncommitted parent changes. Directory snapshots include current project files but exclude Git metadata. Both mechanisms remain available for inspection and resumption until explicit cleanup; the host never auto-commits or merges their changes.
- A Git worktree and a tool allowlist are not security sandboxes. Noncooperative tools and external detached jobs have the cancellation limits described in the design.

### Metadata-only custom agents

A custom agent's Markdown body is optional. For example, `.pi/agents/general-purpose.md` can contain only frontmatter:

```markdown
---
name: general-purpose
description: General-purpose delegated work.
model: inherit
---
```

- This definition adds no custom role prompt. Empty and whitespace-only bodies are both accepted.
- The child still receives pi's system instructions, applicable project instructions, and its delegated task.
- The `prompt` argument on an `Agent` call remains required and nonempty. It specifies the task, not the optional role prompt in the definition file.

### Model and execution configuration

- Global configuration is read from `secretary.json` in the pi agent directory, which defaults to `~/.pi/agent/`.
- Trusted project configuration in `.pi/secretary.json` overrides global agent settings.
- Model fallback lists map a name to an ordered list of exact pi model identifiers. An agent definition's `model` field or the `Agent.model` input names a list; when a model is unavailable, the list's models are tried from first to last. An exact `provider/modelId` available in the session is also accepted, and omitting the model uses the definition's model or inherits the parent model. The plugin ships with no lists; every list is user-created, in the file or through the `/secretary` menu. The removed `agents.modelAliases` key fails validation with guidance toward `modelFallbackLists`.
- The following model identifiers are example placeholders and must be replaced with available configured models.

```json
{
  "agents": {
    "modelFallbackLists": {
      "primary": ["your-provider/your-model", "your-provider/your-cheap-model"]
    },
    "maxConcurrent": 4,
    "maxQueued": 16,
    "shutdownTimeoutMs": 5000
  }
}
```

- Agent metadata shares Secretary's database, and artifacts live below its `agents/` directory. `PI_SECRETARY_DB_DIR` controls the root.
- Parent sessions have exclusive execution ownership. A conflict or unverifiable stale lock refuses execution; timestamps alone do not grant ownership.
- Failed worktree allocations and uncertain cleanup can retain artifacts for manual recovery. They are not force-deleted.
- Runtime compatibility is tested against pi 0.85.1. Parent-only inline tools that cannot be rediscovered for a child fail explicitly rather than silently disappearing.
- See the [subagent architecture](docs/arch/subagents.md), [BDD specifications](doc/acceptance/README.md), and [verification report](docs/testing/subagent-verification.md) for scope and verification limits.

## Development

```bash
npm install
npm run check
npm test
npm run lint:mermaid
npm run lint:acceptance
npm run test:subagents
npm run test:acceptance
npm pack --dry-run
```

Real-provider end-to-end suites are separate commands because they make model calls that may incur charges:

```bash
npm run test:e2e             # headless and interactive cases
npm run test:e2e:headless    # six-case workspace matrix
npm run test:e2e:interactive # parent TUI with widget extensions
```

- `npm test` includes component, adapter integration, and real Pi SDK host tests.
- `npm run test:subagents` runs the implemented agent tests with temporary storage, disposable Git repositories, and deterministic providers.
- `npm run lint:acceptance` checks Gherkin syntax and scenario identities without executing behavior.
- `npm run test:acceptance` executes every current scenario and Examples row through production-backed scenario adapters. Reviewed source hashes make specification changes require assertion review.
- The E2E commands use your configured LiteLLM installation; the interactive case additionally requires the installed widget packages and Python 3. See the [testing guide](docs/testing/README.md) and the [E2E procedures](docs/testing/subagent-e2e.md).
- `npm run record:tui` records an isolated real pi terminal walkthrough into a new ignored `test-results/tui/<run-id>/` directory. `npm run render:tui -- <printed-output-path>` replays and checks its terminal grids.
- The [TUI recording procedure](doc/acceptance/tui-recording.md) explains reproduction and artifact contents. Automated terminal assertions do not constitute human visual approval.
- Follow the [test artifact policy](docs/testing/test-artifacts.md): commit specifications, fixtures, and intentional baselines, but keep generated recordings and reports in ignored local output or CI artifact storage.
- The host tests run against Pi 0.85.1 and cover positive automatic dispatch, stale actions and late results, delayed input, preserved queued questions, retry/compaction recovery, and reporting-only budget wrap-up.
- See [the documentation guide](docs/README.md) for the responsibilities of requirements, UX, architecture, and implementation plans.

## License

MIT
