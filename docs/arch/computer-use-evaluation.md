# Computer-Use Evaluation

**Document type:** Software design specification.

**Status:** Draft, 2026-09-26. Sections 3 and 4 are implemented in `scripts/computer-use/macarena-run.ts`; the ship gate (Section 5) and the benchmark run (Section 6) have not run yet.

**Decision:** [PS-D9](../decisions.md), 2026-09-26. Computer-use work is driven by evaluation. A small fixed task set decides whether the agent ships, and a public macOS benchmark measures its success rate against other agents. What to build next is chosen by counted failures.

**Related documents:** [Computer-use design](computer-use.md), [requirements CU-01 to CU-07](../user-stories/computer-use.md), [test artifact policy](../testing/test-artifacts.md).

## 1. Purpose

- Until now, each change came from one failure in one of five hand-picked tasks, and each task ran once per revision. That gives "it worked this time", not a success rate, and it made every new use case a discussion.
- This design replaces that with two measured evaluations and one rule for choosing work:
  - The **ship gate** is a small fixed task set. It answers "can we ship this agent?".
  - The **benchmark run** is a public macOS benchmark. It answers "how does the agent compare with other agents, and where does it fail most?".
  - **Work selection:** the next change fixes the failure cause with the most counted failures. A feature that no counted failure needs is not built.

## 2. Benchmark choice

Three public macOS benchmarks were checked on 2026-09-26.

| Benchmark | Tasks | How macOS runs | Checking | Published results |
| --- | --- | --- | --- | --- |
| [macOSWorld](https://arxiv.org/abs/2506.04135) (NeurIPS 2025) | 202 tasks in 30 apps, 7 categories, 5 languages | AWS Mac minis, or VMware | Scripts in AppleScript, JavaScript or zsh, success or failure | English: Claude computer use 44.4%, OpenAI computer use 33.3%, Gemini 2.5 Pro 22.8%, UI-TARS 5.3% |
| [MacArena](https://github.com/MacPaw/MacArena) (2026) | 421 tasks in 50 apps: 221 ported from OSWorld, 151 from macOSWorld, 49 new | Apple Silicon virtual machines through UTM and Apple's Virtualization framework | Scripts that return a score from 0 to 1 | 15-step limit: OpenAI computer use 31.83%, Qwen3-VL 4B 24.23%, UI-TARS-1.5 7B 21.14%, Qwen3-VL 2B 11.40% |
| [MacAgentBench](https://github.com/JetAstra/MacAgentBench) (2026) | 676 tasks in 25 apps, 140 of them across applications | A Docker-OSX container | Rule-based checks with several checkpoints per task | Pass@1: OpenClaw with Claude Opus 4.6 73.7%, Agent-S3 66.9% |

- **Choice: MacArena.** Its machines are Apple Silicon virtual machines, the same kind the relay provides, so its preparation and checking scripts are most likely to run in a relay machine. It includes most of macOSWorld's tasks, and its scripts are open source.
- MacAgentBench runs macOS in a Docker-OSX container, which the relay cannot provide. Its published scores are the most recent, so it stays a candidate for a second comparison.
- **Comparability limit.** The agent runs MacArena's tasks in relay machines, not in MacArena's image. Tasks whose applications or files the relay image lacks cannot run. A comparison with a published score is therefore approximate, and every result table states how many tasks ran.
- **Licence.** The macOSWorld tasks inside MacArena are licensed CC BY-NC. The task files are fetched at a pinned revision into a cache outside this repository and are never committed here.
- **Other agents.** Other agents are compared through their published scores. This project does not run another vendor's agent itself.

## 3. Running one task

A task is an instruction, preparation steps, and a checking script. One task run is one delegation through Pi in one fresh relay machine, as in `scripts/computer-use/pi-delegation-live.ts`.

1. The relay client acquires a machine and runs the task's preparation in the guest with the existing `computerUse.relayPrepare` commands.
2. Pi delegates the task's instruction, unchanged, to the computer-use agent.
3. After the child run ends and before the lease is finished, the relay client runs the task's checking script in the guest. The configuration field `computerUse.relayCheck` is a list of commands run once before `relay_finish`, like `relayPrepare` after staging. Their output is recorded as relay steps in the evidence package and as a `checks/check-<time>.json` record next to the run's other records. The runner keeps Pi running until that record exists, because the checks run while the child session closes.
4. A task is scored as MacArena scores it: its checks worth 100 are tried in order, the first that prints "true" scores 1, one that prints anything else lets the next try, and one that does not run ends grading with 0.
5. The runner, `scripts/computer-use/macarena-run.ts`, writes one result line per run: task, run, score, failure cause (Section 4), the agent's final report, the check output, and the run's artifact directory with `report.html`.

- A task counts as passed when its score is 1.
- Preparation that uses AppleScript or shell commands is setup, not agent input, so input mode ([design Section 11.4](computer-use.md#114-input-mode)) does not apply to it.
- Every run writes into a new directory under `test-results/`.

## 4. Failure causes

Each failed run gets one cause, taken from the run's records in this order. The first two are failures of the evaluation harness, not of the agent, and are reported apart.

| Cause | How it is found |
| --- | --- |
| `setup_failed` | A preparation command failed, so the task never started as written. |
| `check_failed` | A checking script did not run, or its result is missing. |
| `false_success` | The agent's last plan completed, with every step checked by the agent's own code, and the task's check scored below 1. This breaks CU-05 and is the most serious agent cause. The agent's written report is kept for review, but the cause is decided from the plan record, not from its wording. |
| `destructive` | An action ran that the risk question judged destructive, without authority. This breaks CU-04. |
| `out_of_scope` | The task needs something the approved requirements exclude, such as launching an application, several applications, or a browser page through a browser protocol. It is found from the agent's report and from `app_not_running` observations. |
| An escalation reason | The last plan stopped with a reason such as `target_not_found`, `no_progress`, `postcondition_failed` or `input_mode`. |
| A rejection rule | Every plan was rejected, with rules such as `needs_text` or `ios_target`. |
| `no_plan` | No plan ran and none was rejected, for example when the agent only observed. |
| `wrong_result` | None of the above, and the check scored below 1. |

- Causes are counted per benchmark run. The next change fixes the cause with the most failures, unless a `false_success` or `destructive` failure exists, which is always fixed first.
- A cause is taken apart further only when it is the largest, for example `target_not_found` split by application.

## 5. The ship gate

- **Tasks.** 20 MacArena tasks that are within the approved requirements: one application, which the preparation opens, whose applications exist in the relay image. They are spread over MacArena's categories, at most 4 per category. The list is fixed once and changes only by a recorded decision, so results stay comparable over time.
- **Task list, fixed on 2026-09-26** from the 107 tasks that the inventory of [research §17.1](../research/computer-use-s0-s1.md#171-which-macarena-tasks-can-run) found runnable in the `macos26` image. Identifiers are the first 8 characters of MacArena's task identifiers, at MacArena revision `dcdc7d3`.

  | MacArena category | Tasks | Application |
  | --- | --- | --- |
  | macarena/system_apps | `4ff150c8`, `7bcb0652` | Reminders |
  | macarena/system_apps | `1de17bab` | Calendar |
  | macarena/system_apps | `e7480f08` | Contacts |
  | macarena/productivity | `4f0d1950`, `99ab4414`, `46649835` | Notes |
  | macarena/productivity | `a13331ed` | TextEdit |
  | macarena/file_management | `6b2f9a53`, `95575366`, `d012561d` | Preview |
  | macarena/system_and_interface | `92ee67c9`, `385645e8` | System Settings |
  | macarena/system_and_interface | `2c38b942` | Automator |
  | macosworld/sys_apps | `4a89fe83` | Reminders |
  | macosworld/sys_apps | `48cf0af3`, `b071a2dc` | Contacts |
  | macosworld/productivity | `12c3de99`, `a1b99040` | Notes |
  | macosworld/advanced | `5a219d2f` | Script Editor |

- **The task's application.** It is the task's `related_apps` entry. macOSWorld tasks list none, so it is the application that their setup and checks address with `tell application` or `tell process`, except System Events. The runner's `--open-app` opens it after the task's setup.
- **Runs.** Each task runs 3 times.
- **The agent ships when all of these hold:**
  - at least 80 percent of the 60 runs pass;
  - no run has `false_success`;
  - no run has `destructive`.
- The 80 percent value is a proposed default. The owner sets the value.

## 6. The benchmark run

- Every MacArena task that can run in a relay machine runs once. Tasks that cannot run are listed with the reason.
- The result is pass@1 overall and per category, placed next to the published scores of Section 2, with the number of tasks that ran.
- The counted failure causes of Section 4 are the input to the next plan.

## 7. Cost

- A task run took 4 to 7.5 minutes through Pi on 2026-09-26, including the relay finish. The host runs at most 2 macOS machines, which other sessions also use.
- The ship gate is 60 runs, about 4 to 8 hours on one machine.
- A benchmark run of up to 421 tasks is about 28 to 53 hours on one machine. It runs only after the ship gate's runner works, and it can be split by category.

## 8. Open points

These are checked in the first plan phase before anything else is built:

- Which MacArena tasks' applications and files exist in the relay's `macos26` image, and which macOS version that image and MacArena's image run.
- Whether MacArena's preparation and checking scripts assume tools or paths that the relay guest lacks.
- Whether a check that reads the screen state can run in the guest after the child session ends.
