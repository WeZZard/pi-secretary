# Subagent End-to-End Tests

These tests launch the installed project version of Pi with Secretary and the user's configured LiteLLM provider. They make real model requests and may incur charges. They do not substitute a mock provider.

## Directory layout

```text
tests/e2e/
├── cases/
│   ├── interactive/
│   │   └── subagent-spawn.test.ts
│   └── non-interactive/
│       └── subagent-spawn.test.ts
├── environment/
└── fixtures/
```

All executable scenarios belong under `cases/`, categorized by interaction mode. Shared process drivers and configuration helpers belong under `environment/`, and reusable test inputs belong under `fixtures/`.

## Requirements and isolation

- Install the repository dependencies and configure the global `pi-provider-litellm` extension with a working default model.
- The interactive test also requires Python 3 on a POSIX host and the installed `pi-recap` and `@juicesharp/rpiv-todo` packages.
- Each run uses an isolated project and private agent configuration. The test copies the selected provider configuration and credentials into temporary files rather than modifying the user's settings.
- Generated evidence goes into a fresh directory under ignored `test-results/e2e/`. Review and redact evidence before sharing it. The temporary credential configuration is removed during cleanup.

## All E2E cases

```sh
npm run test:e2e
```

This runs both the headless and interactive cases sequentially through the same test runner.

## Headless print-mode matrix

```sh
npm run test:e2e:headless
```

The six scenarios cover projects without Git, unborn Git repositories, and committed repositories, with shared working directories and requested isolation. The default profile loads Secretary and LiteLLM only.

To include the installed widget extensions in that matrix:

```sh
PI_E2E_WIDGET_PACKAGES='pi-recap,@juicesharp/rpiv-todo' npm run test:e2e:headless
```

## Interactive parent

```sh
npm run test:e2e:interactive
```

This test launches Pi's normal interactive TUI on an owned POSIX pseudo-terminal. It submits the task through bracketed paste and Enter, not through `--print`, JSON mode, or a command-line prompt. It does not open a desktop Terminal window or control the user's terminal.

- The parent loads Secretary, LiteLLM, both widget extensions, and a read-only lifecycle observer that records UI capabilities without replacing UI methods or tools.
- The fixture requests one isolated child in a committed repository. Assertions verify the delegation, recorded workspace, child outcome, and returned fixture contents.
- The isolated provider catalog is limited to the selected real test model, and provider discovery is disabled. This prevents auxiliary widget hooks from selecting unrelated model routes. Model inference remains real. The copied recap model preference is retained, but a model absent from that restricted catalog is unavailable.
- The observer verifies that the parent remains interactive and that child UI capabilities follow the native headless SDK contract.
- A zero CLI exit code is not sufficient to pass. An unsuccessful child result fails the test.

## Evidence and verification limits

Each interactive run retains the invocation, UI lifecycle observations, persisted sessions and execution records, an assertion report, and a `terminal/` directory. That directory contains an asciinema-format `walkthrough.cast`, checkpoint metadata, and rendered text and HTML character grids.

The grids are reconstructions of recorded terminal output, not pixel screenshots. A passing automated test does not establish human visual approval, compatibility with every terminal application, or compatibility with every third-party extension. Real-SDK unit tests separately exercise resumption, concurrent children, cancellation, and shutdown.
