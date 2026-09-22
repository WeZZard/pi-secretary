# Terminal Acceptance Recording

**Document type:** Acceptance procedure and evidence summary.

**Status:** The automated walkthrough has passed. Human visual approval remains separate.

## 1. Source and Generated Output

- This document, the test fixture, and the recording scripts are versioned source.
- Recordings, run manifests, assertion results, and reconstructed screen views are generated artifacts. They belong under ignored `test-results/`, not beside the acceptance specifications.
- See the [Test Artifact Policy](../../docs/testing/test-artifacts.md) for storage, retention, and baseline rules.

## 2. Reproduction

```bash
# Create a new isolated recording under test-results/tui/<run-id>/.
npm run record:tui

# Use the output path printed by the recorder.
npm run render:tui -- test-results/tui/<run-id>
```

An explicit external directory is also supported:

```bash
npm run record:tui -- --output /tmp/secretary-tui-unique-run
npm run render:tui -- /tmp/secretary-tui-unique-run
```

- Reproduction requires Python 3 with POSIX pseudo-terminal support, Node.js, and the project dependencies.
- The output directory must be new or empty. The recorder refuses to overwrite an existing run.
- The recorder launches real pi in a pseudo-terminal with temporary configuration, storage, sessions, and fixture files. It does not open a desktop terminal or modify the user's pi configuration.
- The fixture provider performs no network model requests.
- Checkpoints wait for pi's synchronized-output frame boundary. A label appearing in a partial output read is not sufficient evidence of a complete screen.

## 3. Artifact Contents

| Artifact | Purpose |
| --- | --- |
| `run-metadata.json` | It identifies the recorder, fixture, creation time, source revision, and dirty-working-tree status. |
| `walkthrough.cast` | It records real terminal input, output, and resize events in Asciinema format. |
| `checkpoints.json` | It identifies the output boundaries and terminal dimensions selected for inspection. |
| `result.json` | It reports whether the scripted interaction completed and distinguishes human review from automation. |
| `screen-assertions.json` | Replay generates this record of checks against the reconstructed terminal grids. |
| `screens/` | Replay generates TXT and HTML views of the selected character grids for inspection. |

- Reconstructed HTML grids are not desktop pixel screenshots and do not reproduce terminal colors.
- Generate derived views on demand. They do not constitute independent evidence beyond the recording they reconstruct.
- In CI, retain the relevant run directory as a workflow artifact and reference its run identifier and artifact name in review notes.

## 4. Executed Interaction Coverage

- The parent launches an agent through the real `Agent` tool using a deterministic local provider.
- The user enters FleetView from the editor's last line and opens the agent inspector.
- The user pauses transcript following, expands tool details, and returns to the transcript end.
- The user composes guidance, dismisses the composer, reopens the retained draft, and submits it.
- The terminal resizes from a wide layout to a narrow layout while the inspector remains open.
- The user requests cancellation with the configured stop key and observes the cancelled outcome without losing the inspector.
- The user opens the `/secretary` configuration menu, drills through the Subagents section's configuration items into the fallback-list manager, and creates a list through the name prompt.
- The user renames the list through the prefilled rename prompt, opens it, adds the fixture model through the model picker, and dismisses the menu with Escape.
- The user returns to the main editor and types a new draft.

## 5. Existing Local Evidence

- Earlier recordings have been preserved locally under `test-results/tui/legacy-evidence/`. The final successful archived run is its `verified/` directory.
- `migration-manifest.json` in that archive records the original paths, relocated paths, and SHA-256 hashes. The migration preserved the file contents.
- Earlier failed and intermediate runs remain available in the same ignored archive for debugging. They are not counted as final successful acceptance.
- Those older recordings predate the new `run-metadata.json` format. Do not infer an exact source revision from their directory names.
- The local archive is intentionally absent from clean clones. Use the reproduction commands or the relevant CI artifact rather than expecting documentation links to resolve to local generated files.

## 6. Review Limits

- The recording establishes real terminal execution and the asserted character-grid outcomes, not human approval of the visual design.
- Real operating-system IME composition, color perception, screen-reader behavior, and additional terminal emulators require appropriate manual review.
- These artifacts are not performance measurements and do not prove that every possible interaction sequence has been tested.
