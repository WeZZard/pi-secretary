# Project Instructions

## Generated Test Artifacts

**Version control the test source and intentional baselines, not the output of individual test runs.**

- Generated logs, recordings, screenshots, actual-result snapshots, assertion reports, coverage output, and rendered HTML reports MUST go under the repository's ignored `test-results/` directory, or to an explicitly selected external artifact directory.
- Generated run output MUST NOT be written into `doc/`, `docs/`, source directories, or fixture directories. In particular, `doc/acceptance/` contains acceptance specifications and instructions, not an archive of test executions.
- Test code, deterministic fixtures, Gherkin specifications, and explicitly reviewed expected snapshot baselines belong in version control. An actual result from a run does not become a baseline merely because a generator produced it.
- Each recording run MUST use a new or empty directory. Do not overwrite an existing recording or mix artifacts from different attempts.
- Keep concise conclusions, reproduction commands, tested revisions, and verification limits in documentation. Reference CI run identifiers or artifact retrieval instructions instead of copying generated output into documentation.
- CI jobs that retain test evidence SHOULD upload it as a workflow artifact, including on failure, with an explicit retention period. The project's default retention recommendation is 14 days unless the workflow has a documented reason for another value.
- Failed local runs may remain under `test-results/` while being investigated. Do not create versioned `attempt-*` directories, and do not delete evidence needed for an unresolved issue merely to make the working tree look clean.
- Generated output can contain sensitive data. Use isolated fixtures where possible and review or redact artifacts before uploading or sharing them.
- Verify artifact placement with `git check-ignore` and `git status`. Do not use `git add -f` to bypass this policy for routine run output.
- Cleanup must be scoped to known generated artifacts. Never delete fixtures, expected baselines, or user data as part of report cleanup.

See [Test Artifact Policy](docs/testing/test-artifacts.md) for the directory convention, retention guidance, and references.

## Documentation Responsibilities

- Follow the [documentation guide](docs/README.md) when editing requirements, UX, architecture, research, and implementation plans.
- Distinguish executed verification, recorded evidence, and human approval. A generated report or a passing syntax check does not establish that an acceptance scenario ran or that a person approved the interface.
