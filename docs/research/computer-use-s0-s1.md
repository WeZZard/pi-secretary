# Computer-Use Subagent: Planner and Executor Investigation

**Document type:** Research record.

**Status:** Recorded evidence from a design investigation on 2026-09-22. Sections 8 and 9 add observations from implementing Phases 1 to 4 on 2026-09-23. This record does not describe current Secretary behavior, and it does not approve any requirement. The [technical design](../arch/computer-use.md) cites this record as the evidence for its decisions.

**Related documents:** [Computer-use technical design](../arch/computer-use.md), [subagent architecture](../arch/subagents.md), and [documentation responsibilities](../README.md).

## 1. Scope

- This investigation evaluated a computer-use subagent with two model tiers. A large planner model (System 0) plans once per task, and a small structured-decision model (System 1) makes one local decision per step.
- The planner candidate is Qwen 3.8 27B. The executor candidate is DiffusionGemma 26B-A4B served behind a Jev-compatible structured-decision interface.
- The harness, which is ordinary code, owns memory, routing, execution and verification in the design under test.
- Every experiment tested selection among supplied candidates. No experiment tested whether the correct candidate was supplied. [Section 7](#7-verification-limits) explains why this is the largest limitation.
- No service was modified during the investigation, and no probe ran against a production desktop session.

## 2. Target infrastructure

All facts in this section were read from the running services on 2026-09-22, not from deployment notes.

### 2.1 Planner: Qwen 3.8 27B

- One SGLang server runs with tensor parallelism across both DGX Spark nodes. It is launched with `--tp-size 2 --nnodes 2`, and rank 0 runs on `spark-left`.
- The server binds `127.0.0.1:8000`. A Caddy reverse proxy on `192.168.50.199:8080` exposes it behind a bearer token.
- The LiteLLM gateway publishes the model as `qwen3.8-27b`.
- The context window is 262,144 tokens, and the output limit is 131,072 tokens.
- The server runs the `qwen3` reasoning parser and the `qwen3_coder` tool-call parser. It uses DFLASH speculative decoding with 8 draft tokens.
- The model accepts images. The gateway declares `supports_vision: true`, which contradicts an earlier note in the deployment kit. A 128×128 four-quadrant PNG sent through the gateway returned `Red` for the top-left quadrant, which is correct.

### 2.2 Executor: DiffusionGemma 26B-A4B behind the Jev interface

- Each DGX Spark node runs one `djev-spark:latest` container.
- Inside each container, vLLM serves plain generation on port 8010. A Jev-compatible structured server serves `POST /v1/systemone` on port 8011.
- The containers run with `CANVAS=128`, `MAX_MODEL_LEN=4096`, `MAX_SEQS=8`, `KV_CACHE_GB=3` and `GPU_UTIL=0.35`.

### 2.3 Load balancing

There are two separate paths, and they must not be confused.

- The plain-generation path is the `dgemma` model on the LiteLLM gateway. It is two entries with the same name, one for port 8010 on each node, which is how LiteLLM spreads load.
- The structured-decision path is `http://jev.home.arpa/`. The gateway host's Caddy forwards it to `127.0.0.1:8012`. A second Caddy in the `~/bin/jev-lb` container balances with the `least_conn` policy across `192.168.50.199:8011` and `192.168.50.200:8011`. It performs `/health` checks and serves `/llms.txt` as the client-facing contract.

### 2.4 The 26-alternative limit

- The limit is a constant in the deployed fork, not a model property.
- In the `mmastrac/djev-spark` checkout at revision `1444f3e`, `server/structured_server.py:148` rejects any question with more than 26 alternatives.
- Option labels are generated as `chr(ord("A") + i)`. The label set is therefore the 26 single letters, and a 27th option would produce `[`.
- The source sets `CANVAS_LEN = 64`, while the deployment runs with `CANVAS=128`.
- Hosted Jev documents a limit of 255 alternatives for a choice question. The local deployment is therefore more constrained.

## 3. Measurement method

The following definitions apply to every number in this record.

- **Round-trip latency, median (ms):** Each request is timed on the client from sending the request to receiving the full response. The client is the Mac, and requests go to `http://jev.home.arpa`, so the balancer hop is included. The reported value is the median across the trials in a cell.
- **Input tokens, median:** The value is the service's own `usage.input_tokens`, reported as the median across the trials in a cell.
- **Top-1 accuracy:** A trial is correct only when the highest-ranked label equals the expected label.
- **Confidence, median:** The value is the service's reported confidence for the chosen label, reported as the median across the trials in a cell.
- Every request pins `samples` to 1, so each stage is exactly one read.
- These figures are not comparable with the single-node figures published in the service's `/llms.txt`. Those figures were measured without a balancer in the path. They are also not comparable with any third-party figure.
- Sample sizes are small and are stated per experiment. A difference of two or three trials is not an established difference.

## 4. Recorded measurements

### 4.1 Candidate list length (n = 8 per cell)

Four near-miss distractors were held constant in every cell.

| Candidates | Top-1 accuracy | Round-trip latency, median | Confidence, median | Input tokens, median |
| --- | --- | --- | --- | --- |
| 5 | 7/8 | 155 ms | 0.84 | 263 |
| 10 | 7/8 | 128 ms | 0.80 | 424 |
| 16 | 8/8 | 201 ms | 0.98 | 624 |
| 22 | 8/8 | 207 ms | 0.99 | 824 |
| 25 | 8/8 | 192 ms | 1.00 | 924 |
| 26 | 8/8 | 212 ms | 0.96 | 959 |

- Accuracy did not collapse at any length up to the limit.
- The only hard failure was input validation. A question with 26 alternatives returned HTTP 200, and a question with 27 returned HTTP 422.
- A 26-candidate list with realistic descriptors cost 1,785 input tokens. Each descriptor carried role, label, value, enabled state, focus state and bounds. The context window is therefore not the binding constraint at the limit.
- **Recorded defect:** The distractor count was held constant, but the distractor proportion was not. Longer lists therefore had a lower density of hard distractors. This experiment does not separate list length from distractor difficulty. It supports only two claims: accuracy did not collapse, and the failure at 27 was a validation rejection.

### 4.2 Question coupling on a list of buttons (n = 12)

| Arrangement | Top-1 accuracy | Round-trip latency, median |
| --- | --- | --- |
| Both questions in one stage | 12/12 | 173 ms |
| Operation question staged with `depends_on` | 9/12 | 329 ms |
| Operation question marked `alone` in its own pass | 9/12 | 220 ms |

### 4.3 Question coupling on a mixed-role list of 26 candidates (n = 48)

The experiment used six goals across eight random seeds.

| Arrangement | Element correct | Operation correct | Both correct | Round-trip latency, median | Input tokens, median |
| --- | --- | --- | --- | --- | --- |
| Both questions in one stage | 48/48 | 48/48 | 48/48 | 256 ms | 990 |
| Operation question staged with `depends_on` | 43/48 | 47/48 | 43/48 | 397 ms | 996 |
| Operation question marked `alone` in its own pass | 46/48 | 47/48 | 45/48 | 359 ms | 947 |

- Staging the operation question after the element question reduced accuracy.
- Staging also increased median latency by roughly 55 percent.
- Staging produced five element errors that the single-stage form did not produce.
- The supported shape is several separate questions in one request, answered in one stage.

### 4.4 Companion questions (n = 12)

| Arrangement | Top-1 accuracy | Round-trip latency, median | Confidence, median |
| --- | --- | --- | --- |
| Element question only | 9/12 | 168 ms | 0.84 |
| Element question and a related operation question | 12/12 | 179 ms | 0.99 |
| Element question and an unrelated progress question | 12/12 | 170 ms | 1.00 |

Adding a companion question to the same request did not measurably increase latency.

### 4.5 Name-only labels compared with verbose descriptors (n = 8, 26 candidates)

| Encoding | Top-1 accuracy | Input tokens, median | Round-trip latency, median |
| --- | --- | --- | --- |
| Verbose descriptors with role and state | 8/8 | 435.5 | 395 ms |
| Name-only labels without role or kind | 8/8 | 349.5 | 341 ms |

- The sample does not separate the two encodings by accuracy.
- The name-only encoding used about 20 percent fewer input tokens.
- The name-only encoding dropped role and kind without a measurable accuracy penalty at this sample size.

### 4.6 Cost of a name-only element list as it grows

The share is computed against the executor's 4,096-token model length.

| Elements | Input tokens | Share of the 4,096-token model length |
| --- | --- | --- |
| 26 | 350 | 9% |
| 52 | 506 | 12% |
| 100 | 794 | 19% |
| 200 | 1,494 | 36% |
| 240 | 1,774 | 43% |

- The marginal cost is roughly seven tokens per element.
- A full window's controls fit in the request and still leave room for the plan step, the recent actions and the answer.
- This result overturns the earlier assumption that retrieval down to a shortlist was mandatory before every step.

### 4.7 Merging independent heads by confidence (n = 8)

- 52 candidates were split across two independent questions of 26 each. The harness took the answer from whichever question reported the higher confidence.
- This scored 6/8.
- One failure returned a confidence of 0.99 on a wrong answer while the question holding the correct answer reported a lower confidence.
- Confidences from independent questions are not comparable. They must not be used to choose between questions.

### 4.8 A routing question with one speculative question per group (n = 12)

One request carried a routing question over four groups and one speculative element question per group. The groups were toolbar, sidebar, content and context menu, and they covered 103 candidates. Code selected the element answer from the group that the routing question chose.

| Measure | Result |
| --- | --- |
| Routing question correct | 12/12 |
| Element correct when routed | 12/12 |
| End-to-end correct | 12/12 |
| Input tokens | 1,301, which is 32 percent of the 4,096-token model length |
| Round-trip latency, median | 526 ms |

- Capacity becomes 26 multiplied by the number of groups, and no confidence comparison is involved.
- The name `New Folder` appeared in two groups at once. The routing question still chose the correct group in 12 of 12 trials. The group level therefore recovers some of the disambiguation that the name-only encoding gives up.

## 5. Findings

- Asking every needed question in one request, in one stage, is faster and more accurate than staging questions.
- Confidence is not an error detector. In the list-length experiment, the two wrong answers carried a confidence of 0.77, while several correct answers carried confidences between 0.51 and 0.67.
- Confidence is usable as a safety gate and as a routing hint. Error detection belongs to structural signals and to postconditions computed by code.
- A routing question with speculative per-group questions removes the practical effect of the 26-alternative limit without changing the service.
- The economic case for the executor is not token savings. The executor spends more tokens per decision than the planner would. The benefit is that each per-step decision stays out of the planner's conversation.

## 6. Prior art consulted

These sources were read but not verified here. None of their figures is comparable with the measurements above.

- **TypeSafe speculative fan-out pattern:** It puts every question the system might need, including speculative ones, into a single call, and code decides relevance afterward.
- **Browser Use `jev-ultrafast`:** It resolves an operation and a target in one round trip with one speculative target question per operation. It filters each target question to compatible elements, and it calls a small language model only for typed text.
- **`lahfir/agent-desktop`:** It drives macOS through accessibility trees. A language model holds memory and context while Jev selects the control, and the tree is never placed in the language model's context.
- **`awlevin/typesafe-computer-use`:** It combines optical character recognition, the accessibility tree and computed context. It keeps the action and the target as separate questions. It stops on a confidence below 0.4, on two consecutive actions with no effect, or at 100 steps. It presses accessibility elements rather than clicking coordinates. An open issue in that project reports that similar link names split the vote.
- **Cua `jev-use`:** It documents a typed escalation contract. Its reasons distinguish a task that needs generated text, a state too large to judge, genuine uncertainty that still returns the answer as a prior, and an unreachable backend. Its chooser also offers reserved `reobserve` and `abstain` choices.
- **Cua `CUA-S1-FORMS`:** It is an MIT-licensed specialist model with 706,048 parameters trained on Jev's contract. Its authors report 99.7 percent against 83.6 percent for hosted Jev overall. On steps that needed judgment, the two scored 100 and 96 percent. The whole gap sat on steps where the correct action was no action, at 100 against 74 percent. The lesson is that conventions such as "do nothing when the step is already satisfied" must be stated or trained, not assumed. Its training data used forced pairs of look-alike distractors, which is the only known countermeasure to the near-miss confusion also observed here.

## 7. Verification limits

- Everything in [Section 4](#4-recorded-measurements) was executed against the live services on 2026-09-22.
- The probe scripts are kept outside version control, beside the investigation handoff in the `pi-secretary` main checkout at `.handoff/s0-s1-probe/`. Each script prints the measurement formula it uses. A clean clone of this repository cannot reproduce the measurements until the scripts are added to version control.
- Sample sizes are 8, 12 or 48 depending on the experiment. The small differences between cells are not statistically established.
- The list-length experiment confounds length with near-miss density, as recorded in [Section 4.1](#41-candidate-list-length-n--8-per-cell).
- Every experiment tested selection among supplied candidates. None tested whether the correct candidate was present. The retrieval step must therefore record the full tree, the reduced list and every discard reason from the first day. A wrong answer can then be attributed to retrieval or to judgment.
- A 96×96 test image was billed at 64 image tokens. The cost of a real screenshot at panel resolution has not been measured.
- This record does not establish that the design works end to end. No acceptance scenario has run against a real computer-use target.

## 8. Phase 1 observations (2026-09-23)

These observations come from implementing Phase 1 of the plan. They were taken on the development Mac with `cua-driver` 0.12.6, against a disposable TextEdit document opened in the background. They are not comparable with the executor measurements in Section 4.

### 8.1 Accessibility tree facts

- A tree-only `get_window_state` read of the TextEdit window returned 364 elements. 319 of them were menu items of closed menus, and those items had no frames.
- The first read after a background launch lacked the window element entirely. A read taken seconds later included it.
- The three title-bar buttons had no label and no value, so a name-only table cannot include them.
- The text area's label was the whole document text.
- TextEdit's menu-bar items at first had no frames. A later read, with TextEdit still not active, reported frames at the top of the screen, where the active application's menu bar was drawn.
- The background launch raised TextEdit's window above the active application's window without activating TextEdit. Window stacking order therefore does not identify the application that owns the menu bar.
- A visible window was briefly reported with `is_on_screen` set to `false` in three consecutive reads, and then reported as on screen again. The cause was not identified.

### 8.2 Observation read time

**Formula:** The value is the backend-side wall-clock time of one `readWindow` call. It runs from the first driver call to the parsed result, and it includes `list_windows`, `list_apps` and `get_window_state`. The client is the local backend on the development Mac, and the value is the median over the samples.

| Read | Samples | Observation read time, median |
| --- | --- | --- |
| Tree only | 5 | 1,291 ms |
| With screenshot | 1 | 1,108 ms |

- A single `list_apps` call took about one second on its own when timed with the shell, so it dominates the read time.
- A single tree-only `get_window_state` call took 0.26 seconds of shell wall-clock time, which is a different formula and is stated here only to locate the cost.

### 8.3 Screenshot input tokens on the planner

**Formula:** Image input tokens equal the gateway's `usage.prompt_tokens` for a request with the image and a fixed text, minus the same value for the identical request without the image. The model was `qwen3.8-27b` through the LiteLLM gateway. Each variant was sent twice, and both counts were identical.

| Screenshot size in pixels | Image input tokens |
| --- | --- |
| 1312×844, the window at native Retina scale | 1,068 |
| 656×422 | 262 |
| 328×211 | 72 |

- The cost is close to one token per 32×32-pixel patch, so it scales with pixel area.
- A full Retina screen would cost more than ten thousand tokens by the same proportion. That extrapolation was not measured.
- The script is `scripts/computer-use/measure-image-tokens.ts`, and it prints its formula.

## 9. Phase 2 to 4 observations (2026-09-23)

These observations come from recording real accessibility trees and replaying them against the live executor. The windows were a disposable TextEdit document and its Open dialog, Calculator, a Finder window on a folder of 40 dummy files, and a local Safari test page with look-alike links. The development Mac ran `cua-driver` 0.12.6. The recording and evaluation scripts are `scripts/computer-use/record-trees.ts` and `scripts/computer-use/evaluate-decisions.ts`, and both print their formulas.

### 9.1 Tree facts

- The structured `elements` array holds only indexed elements. In Finder and in the Open dialog, the names of sidebar rows, such as "Downloads", exist only as unindexed static text in the Markdown rendering. The observer now takes those names from the Markdown, but this was verified only against recorded Markdown, because the windows were unavailable for a live re-read.
- Safari's first read of the test page had no web area at all. The second read had all 28 links and the form controls.
- In Safari, more than 90 percent of the walked nodes were closed-menu items, mostly from the History and Bookmarks menus. The menu bar is walked first, so large menus can consume the node cap before the window content.
- Calculator in programmer mode exposed 106 buttons as direct children of the window, with no containers.
- The title-bar buttons of every window had no label, value or descendant text.
- Finder's Back button was named `back` and was disabled, because the folder had no history.
- While these checks ran, every window, including other applications' windows, was reported off screen twice for minutes at a time. This is consistent with a Space switch or a locked screen. Live re-recording and the Phase 3 live check could not run during those periods on the development Mac. Both were later run as standalone scripts in a relay virtual machine, as [Section 10](#10-standalone-script-checks-in-a-macos-virtual-machine-2026-09-23) records.

### 9.2 Retrieval on recorded trees

19 step intents were labelled with their correct element before any tree was inspected. One more intent, creating a folder in the Open dialog, was withdrawn because that dialog has no such control.

| Cause | Intents | Assessment |
| --- | --- | --- |
| The target was below the visible part of Finder's list. | 2 | The exclusion is correct. A scroll is needed first. |
| The target was only a menu item of a closed menu. | 1 | The exclusion is correct. A menu or shortcut step is needed. |
| The target was disabled. | 1 | The exclusion is correct. |
| The target was an unnamed title-bar button. | 1 | This is a real gap. |
| The target's name was only in the Markdown. | 1 | This is fixed in code and verified on recorded Markdown only. |

**Retrieval miss rate:** 6 of 19 labelled intents had their target absent from the executor's table.

### 9.3 Executor decisions on recorded trees

**Formulas:** Each labelled intent was sent as one request per seed, with seeds 1, 2 and 3, so each run has 57 decisions.

- A correct action means the policy acted on an expected element.
- A judgment miss means the expected element was in the table and the policy acted on another element. Its rate is over the 39 decisions whose element was in the table.
- A wrong action on an unlisted target means the expected element was absent and the policy acted anyway. Its rate is over the 18 decisions whose element was absent.
- Executor round-trip latency, median (ms), is the harness-side time from sending the request to the full response.

The first two runs grouped by 26 elements, before the `none` option existed. The last two grouped by 25 elements and included the hidden-item note in region descriptions.

| Run | Correct actions | Judgment misses | Wrong actions on unlisted targets | Escalations | Round-trip latency, median |
| --- | --- | --- | --- | --- | --- |
| Plain region names, 26 per group | 22 of 57 | 11 of 39 | not recorded | 10 | 175 ms |
| Region descriptions with member names, 26 per group | 34 of 57 | 0 of 39 | not recorded | 8 | 187 ms |
| Member names, 25 per group, no `none` | 35 of 57 | 0 of 39 | 16 of 18 | 6 | 190 ms |
| Member names, 25 per group, with `none` | 33 of 57 | 0 of 39 | 7 of 18 | 17 | 193 ms |

- Every judgment miss with plain region names occurred in windows split into meaningless parts, which were Calculator and the Safari page. In an earlier single-seed run with plain region names, seed 42, the five wrong answers carried element confidences between 0.80 and 0.98, so the confidence gate could not catch them.
- Member-name descriptions raised the input tokens reported by the service. On Calculator they rose from 1,950 to 2,480, which is 61 percent of the executor's 4,096-token model length.
- Adding `none` to every element question adds a 27th alternative to a full 26-element group. The service rejected those requests with HTTP 422 until groups were capped at 25.
- With `none`, three of the seven remaining wrong actions on unlisted targets chose a plausible path. Finder's Action menu contains New Folder, and the Open dialog's "Where:" menu leads to folders. The three "close the document window" decisions clicked the text area, because the close button has no name.
- The executor never chose to scroll when the target was below the visible part of a list, in 18 of 18 decisions, even when the request stated how many items were hidden.
- The executor judged "Submit the form" and "Sign out of every device" destructive in some seeds, which produced `approval_required` escalations with the correct element as the prior.
- These results come from 19 intents on five windows. They show the direction of each change but do not establish rates for other applications.

## 10. Standalone script checks in a macOS virtual machine (2026-09-23)

These checks ran the Phase 2, Phase 3 and Phase 5 scripts under Node.js inside a disposable macOS 26 virtual machine. Claude Code leased the machine and started the scripts through the `mcp-vm-relay` plugin. The guest ran `cua-driver` through the local driver backend.

**Scope:** Pi did not run in these checks, so they are not live checks of the Pi extension.

- The staged copy replaced Pi's package, `@earendil-works/pi-coding-agent`, with a stub.
- The scripts called the harness function `executeRunPlan` directly, which is the function that the `computer_run_plan` tool calls.
- The plans were written by hand, so the planner model was not tested.
- Pi's extension loading, tool registration, tool-call input from the planner, cancellation signal and session hooks were not tested.
- The results are therefore evidence for the harness modules and for `cua-driver` behavior in the guest. They are not evidence for the Pi infrastructure. The fix plan requires the same checks to be repeated with Pi running the extension. Every action used real pointer or keyboard input, as owner decision D3 requires. The test content was a scratch TextEdit document, Calculator, a Finder window on a folder of 40 dummy files, and a local Safari test page. Safari stayed in front, so TextEdit, Calculator and Finder were partly or fully covered during every action.

**Formulas:**

- **Step time (ms)** is wall clock from the first action of a step to the evaluated postcondition, including the verifying observation. The scripted-plan script prints this formula with its table.
- **Executor round-trip latency (ms)** is the harness-side time from sending the request to receiving the full response. This is the formula of [Section 9.3](#93-executor-decisions-on-recorded-trees), but the client here is the guest virtual machine rather than the development Mac. The two sets of values were measured under different network paths and are not compared.
- **Input tokens** are the values that the executor service reported in `usage.input_tokens`.

The run directories are under the ignored `relay-evidence/relay-computer-use-live-check-89d2966b/` directory. The relay manifest records the whole session as failed, because several intermediate runs exited with an error before the fixes below. Human review of the relay evidence is pending.

### 10.1 Tree recording

- The guest recorded all four windows through the local backend. No read was truncated.
- The labelled retrieval check missed 4 of 16 intents. Every miss had a known cause. The close button exists only as a closed-menu item, Finder's Back button is disabled, the file "Report Q4" is not in the folder, and New Folder is reachable only through a closed menu.

### 10.2 Real input into covered windows

| Check | Steps verified | Result |
| --- | --- | --- |
| Type 19 characters into the TextEdit document | 1 of 1 | All 19 characters arrived through real key presses. The step time was 24,964 ms. |
| Clear Calculator, then compute 7 plus 3 | 6 of 6 | The window's descendant text read "7+3 10" at the end. |
| Scroll Finder's file list to the top, down two pages and up two pages | 6 of 6 | The last row appeared after the second page, and the first file returned after scrolling up. |

- The TextEdit text arrived at the start of the document, although the step clicked the center of the text area first. The click, posted to the covered window's process, did not move the insertion point. A step that relies on a click to place the insertion point is therefore not reliable in a covered window.
- Calculator's display is not an element. Its text exists only as descendant text of the window, and each number is preceded by a Unicode left-to-right mark.
- Calculator's clear button is named "All Clear" when the display is empty and "Clear" otherwise, so the scripted check cleared the display with the Escape key instead.

### 10.3 Defects found and fixed

Each defect below made a check fail although the action had worked. Each fix has a unit test, and each check was run again after its fix.

- **`changed` ignored descendant text.** Pressing "3" in Calculator changed only the display, so the visible signature did not change. The signature now includes descendant text.
- **Names kept bidirectional marks.** The marks prevented a match on the display text. Names and compared text now drop them.
- **No predicate could find text inside a larger text.** After Equals, the window's descendant text was "7+3 10", and no element was named "10". The new `text { contains }` predicate searches values and descendant text.
- **`text` first searched labels too.** In the first live harness run, `text contains "7"` held before anything was pressed, because the button labelled "7" matched. The step was skipped by the precheck. Labels are no longer searched, because they name controls rather than show content.
- **A group's frame could lie outside the window.** Finder's icon-view list reported a container frame 804 points tall inside a 436-point window, so the scroll point at its center fell outside the window. A group's frame is now clipped to the window.
- **A page scroll moved much less than a page.** One page-sized wheel notch moved Finder's list by 100 points. The local backend now sends enough notches to move about 80 percent of the scrolled region's height.
- **The verifier counted elements scrolled out of the window.** After a scroll, Finder still reported the first file 140 points above the window, and `absent` failed. The verifier now uses the observer's rule that an element's center must lie inside the window unless it belongs to a menu.

### 10.4 The harness function with the live executor, without Pi

`scripts/computer-use/run-plan-live.ts` ran `computer_run_plan` inputs through the real harness, the local backend and the live executor at `http://jev.home.arpa`. Pi did not run, and the planner was not involved, because the plans were written by hand.

| Plan | Outcome | Executor decisions | Round-trip latency, per decision | Input tokens, per decision |
| --- | --- | --- | --- | --- |
| Calculator: press 7, Add, 3 and Equals | completed, 4 of 4 steps verified | 4 | 176, 230, 193 and 217 ms | 591 to 641 |
| Finder: scroll the list down twice | completed, 2 of 2 steps verified | 2 | 607 and 365 ms | 1,365 and 1,423 |

- In Calculator, the window has 22 kept elements and forms one group, so no routing question was asked. The executor chose the expected button in every step. The lowest element confidence was 0.79, for the 7 button.
- In Finder, the executor answered the routing question with the list region at confidence 1.0 and chose `scroll_down` at confidence 1.0 in both steps. It answered `none` to every element question, which is correct for a scroll.
- The first Calculator attempt skipped every step, because every postcondition already held on the stale display "7+3 10". The precheck works as designed, but a plan whose postconditions are already true before their steps does nothing. The postconditions must describe a change that the step causes.
- The second attempt escalated `postcondition_failed` at the Add step, because the 7 step had been skipped by the label match described in Section 10.3. The escalation carried the executor's prior and the current table, as the escalation contract requires.

### 10.5 Verification limits

- These checks used standalone scripts and hand-written plans. Pi, the planner model, the Pi tool call and the relay backend were not part of the loop.
- The screenshots in the relay evidence show the desktop, where Safari covered the other windows. They do not show Calculator's display or Finder's list, so the accessibility tree is the only evidence for those results.
- Each check ran once. The results show that the path works, not how often it works.


## 11. First checks through Pi (2026-09-23)

These checks ran Pi itself. Pi 0.85.1 ran non-interactively inside a disposable macOS 26 virtual machine, with `--print --mode json`. It loaded only this worktree's secretary extension and the LiteLLM provider. The planner was Qwen 3.8 27B, and the allowed tools were `computer_observe` and `computer_run_plan`. The executor was the live service at `http://jev.home.arpa`. Claude Code started the virtual machine and collected the evidence, but it did not take part in the runs. Safari covered the other windows, as in [Section 10](#10-standalone-script-checks-in-a-macos-virtual-machine-2026-09-23).

| Run | Task | Tool calls | Result |
| --- | --- | --- | --- |
| 1 | Compute 7 plus 3 in Calculator. | 2 observations and 3 plans | The final answer, 10, was correct and verified by the last plan. |
| 2 | Add a new last line "Hello from Pi" to the TextEdit document. | 3 observations and 4 plans | The line landed at the end of the document. The final answer claimed more than the harness verified. |

**What worked:**

- Pi loaded the extension, registered both tools, and passed the planner's calls to the harness.
- Each observation carried a screenshot to the planner.
- A plan with an empty postcondition was rejected before any action, and the planner corrected it.

**What failed:**

- **Postconditions that were already true.** The planner twice wrote a postcondition that held before its step: "text contains 7" for the Add step, and "window title contains scratch.txt" for a Cmd+Down step. The precheck skipped both steps. In run 1 the skipped Add step made the sum wrong until the planner replanned.
- **Content missing from the element table.** The table listed Calculator's buttons but not its display, because the display is descendant text of the window rather than an element. The planner could not read the result from the table.
- **Actions with no visible effect.** A click into the text area and the Cmd+Down key changed nothing in the element tree. The harness therefore sent each action twice and escalated `no_progress`, although the later text entry shows that Cmd+Down had moved the insertion point to the end.
- **A label used as content.** The planner wrote "text contains All Clear" to check a button name. The `text` predicate searches values and descendant text only, so a successful press was reported as failed.
- **An unverified final claim.** The final answer of run 2 said that the text was "the new last line". The harness had verified only that the document contained it.
- **Covered windows in the evidence.** The relay's desktop screenshots show Safari in front and only an edge of TextEdit.

**Test tooling:** An `osascript` query to System Events in the guest stalled until the relay timed out, and the relay recorded that run as uncertain. The document text was then read from the harness's own observation records instead.

**Verification limits:** Each task ran once. The covered-window typing problem of Section 10.2 did not recur, because the planner moved the insertion point with Cmd+Down before typing, so its cause is still unknown. The fixes are planned in `.plans/2026-09-23-computer-use-live-fixes.md`, which is not versioned.

## 12. Fix checks through Pi (2026-09-23)

These checks tested the fixes planned after [Section 11](#11-first-checks-through-pi-2026-09-23). Two leases were used. The first lease ran the click experiment only. The second lease ran the click experiment again and then the Pi tasks with every fix in place. The Pi setup matched Section 11: Pi 0.85.1, the Qwen 3.8 27B planner, the two computer-use tools, and the live executor. Step pictures and foreground delivery were enabled in the guest's `secretary.json`.

### 12.1 Why a click into a covered window did not move the insertion point

The script `scripts/computer-use/click-placement.ts` clicked the center of TextEdit's text area while Safari was in front, then typed "z". Before each click, the script put the insertion point after a "y" at the start of the text. A "z" at the end of the text means that the click moved the insertion point. A "z" after the "y" means that it did not.

| Click method | Lease 1: moved | Lease 2: moved |
| --- | --- | --- |
| `background`: one click posted to the process | 0 of 3 | 3 of 3 |
| `background-twice`: two such clicks | 0 of 3 | 3 of 3 |
| `foreground`: the driver brings the window forward for the click, then restores the previous app | 3 of 3 | 3 of 3 |
| `bring_to_front` first, then one background click | 3 of 3 | 3 of 3 |

- The one difference between the leases was the reset. In lease 2, every trial began with Cmd+A sent with foreground delivery, which briefly activated TextEdit. In lease 1, the keys were sent with background delivery only.
- A background click therefore depends on hidden state of the app, most likely whether the app was recently active. The covering window is not the cause, because Safari covered TextEdit in all 24 trials.
- Foreground delivery moved the insertion point in 6 of 6 trials, and it returned the foreground to the previous app. The harness now uses it for clicks and for shortcuts with Command, Control or Option.
- After `bring_to_front`, TextEdit was the active app, but its window stayed behind Safari. Activating an app does not raise its window.
- Cmd+A did not select all text with either delivery mode, so the setup check of the script failed in every trial of both leases. The classification above uses where the "z" landed, which the failed check does not affect. Text replacement now selects with Cmd+Up and then Shift+Cmd+Down.
- In lease 1, the covering window was reported as Finder. This was a defect: the code read the driver's `z_index` in the wrong direction. A lower `z_index` is nearer the front. The defect was fixed before lease 2, which reported Safari.

### 12.2 Pi tasks with the fixes in place

| Run | Task | Tool calls | Result |
| --- | --- | --- | --- |
| 1 | Compute 7 plus 3 in Calculator, from a cleared display. | 2 observations and 2 plans | Correct. The plan validator rejected a first plan that checked "text contains 7" after pressing 7, because "7" is also the name of a button. The second plan completed, and its last step was verified by "text contains 10". |
| 2 | The same task, with the display still showing "7+3 10" from run 1. | 1 observation and 0 plans | The answer, 10, was correct, but Pi did not compute it. See below. |
| 3 | Add a new last line "Hello from Pi" to the TextEdit document, with Safari in front. | 1 observation and 1 plan | Correct. One `enter_text` step with `position: "end"` and the postcondition "text ends with Hello from Pi" was verified on the first attempt. The document's recorded value ends with a new line "Hello from Pi". |

**What the fixes changed:**

- No step was skipped. In Section 11, two steps were skipped because their postconditions already held.
- The display text of Calculator appeared under the element table, so the planner could read the result.
- The rejected label check made the planner write a postcondition that could be false before the step.
- Each result ended with the list "Verified by code after the step", and Pi's final answer in run 3 claimed only what that list said.
- Each run wrote `review.md` with a before picture and an after picture of the target window for every step, and a SHA-256 hash for each picture. In run 1, each step's before picture has the same hash as the previous step's after picture, as expected.
- The TextEdit text landed at the end although Safari covered the window. The planner used the new `position` field instead of a separate Cmd+Down step.

**A problem that code did not catch (run 2):**

- The planner observed the window, saw "7+3 10" already on the display, and answered 10 without running a plan.
- Its final answer said "I verified the window directly (buttons 7, +, 3 and Equals are all present, and the display text reads 7+3 10)". The presence of buttons does not show that they were pressed in this task.
- The harness cannot catch this, because no plan ran. Whether a planner may answer from a stale screen is a planner instruction question for Phase 6.

**Evidence:** The relay manifests are under `relay-evidence/relay-computer-use-fixes-dadc305d/` and `relay-evidence/relay-computer-use-f5-0e14f091/`, which are not versioned. Lease 2 finished with delivery verified. The relay failed to return one after-screenshot image to the conversation, but the image file and its hash were recorded.

**Verification limits:**

- Each Pi task ran once, and the click experiment ran 3 times per method in each lease. The results show that the paths work, not how often they work.
- The step pictures are recorded evidence. A person has not reviewed them yet.
- Only Calculator and TextEdit were tested through Pi. A Finder scrolling task was not rerun.

## 13. Executor token budget (2026-09-23)

These measurements set the answer reserve in [design Section 7.3](../arch/computer-use.md#73-token-budget). The script is `scripts/computer-use/measure-token-budget.ts`, and it prints its formulas. It ran against the live executor at `http://jev.home.arpa`.

**Formulas:**

- Answer tokens are the service's `usage.output_tokens`. This is the output length that the service's reads request from vLLM.
- Input tokens are the service's `usage.input_tokens`.
- The estimate is the request builder's `ceil(JSON characters / 3)` of the request body.
- The estimate ratio is input tokens divided by the estimate, for the same request.

### 13.1 The model-length limit

- The service accepts a request when input tokens plus answer tokens are at most 4,096. A request with 4,088 input tokens and 8 answer tokens was accepted, and a request one input token longer was rejected.
- A rejected request returns HTTP 502 with vLLM's message "This model's maximum context length is 4096 tokens". The client previously reported this as an unavailable executor.

### 13.2 Answer tokens by group count

The service writes each answer into a fixed template of question identifiers and single-letter labels. The answer length therefore depends only on the questions, and the request builder's questions depend only on the group count. The script sent the builder's question shape for every group count from 1 to 26.

| Groups | Questions | Answer tokens |
| --- | --- | --- |
| 1 | 3 | 18 |
| 2 | 5 | 28 |
| 5 | 8 | 46 |
| 7 | 10 | 58 |
| 8 | 11 | 43 |
| 10 | 13 | 52 |
| 25 | 28 | 127 |
| 26 | 29 | 137, in two reads |

- The answer grows by about 6 tokens per question up to 10 questions. Above 10 questions, the service switches to a shorter answer format that costs 5 tokens per question.
- At 26 groups, the service splits the answer into two reads. No single read requested more than 127 answer tokens.
- 26 groups is the largest possible count, because the routing question has one option per group and the service accepts at most 26 options.
- The questions alone cost 3,768 input tokens at 25 groups, before any element name. A window with that many groups cannot fit, so input, not the answer, limits the group count in practice.

### 13.3 Estimate error

77 distinct requests from the Phase 4 evaluation, the standalone script checks and the Pi runs had both an estimate and the service's input tokens.

| Window | Requests | Estimate ratio |
| --- | --- | --- |
| Calculator, 106 buttons | 14 | 1.21 to 1.26 |
| Safari test page | 11 | 0.91 to 0.99 |
| Finder folder | 17 | 0.91 to 0.94 |
| TextEdit document and Open dialog | 7 | 0.84 to 0.93 |
| Plans run in the virtual machine | 28 | 0.83 to 1.02 |

- The estimate undercounted Calculator by up to 514 tokens and overcounted a TextEdit document by up to 17 percent.
- The Calculator requests hold many short digit and symbol names. Such text costs more tokens per character than prose.
- No fixed reserve can absorb this error in both directions. A reserve large enough for Calculator would refuse TextEdit requests that fit.

### 13.4 Consequence for the design

- The answer reserve is 128 tokens, which covers every single read that the request builder can cause. The earlier default of 512 tokens was not measured.
- The executor decides whether a request fits, because only it counts tokens exactly. The estimate only decides how much history to send.
- The client reports the length rejection as its own error. The harness then sends the request once more without history, and escalates `state_too_large` if it is still rejected. A retry is safe, because a decision request acts on nothing.

**Verification limits:** The limits belong to the executor deployment measured on 2026-09-23. A change of model, tokenizer, answer format or model length changes them, and the script must then run again. Non-Latin text, such as Chinese window content, was not measured. Its estimate ratio is likely higher than Calculator's, and the executor's rejection is the safeguard for it.

## 14. Pi task batch (2026-09-23)

The script `scripts/computer-use/pi-task-batch.ts` runs Pi on three fixed tasks and checks each outcome with code. The Pi setup matches [Section 11](#11-first-checks-through-pi-2026-09-23): Pi 0.85.1, the Qwen 3.8 27B planner, the two computer-use tools, and the live executor. Safari is opened over the target window before each run. Foreground delivery and step pictures are on.

| Task | Prompt | Code check after Pi exits |
| --- | --- | --- |
| Calculator | Compute 7 plus 3 and tell the result shown on the display. The display is cleared first. | The display text ends with "10". |
| TextEdit | Add a new last line "Hello from Pi" to the open document `scratch.txt`. The file is rewritten and TextEdit is restarted first. | The document's value is the original text followed by a new line "Hello from Pi". |
| Finder | Select the file "Zoning notes.txt" in the window "Fixture Folder". The folder holds 40 files, and the target sorts last, below the visible part of the list. | "Zoning notes.txt" is the only selected item. |

**Formulas.** These formulas hold for every number in this section:

- **Task done:** After Pi exits, the code check of the task holds.
- **Answer states the result:** Pi's final text contains the checked result, which is 10, the typed line, or the file name. It does not test whether the answer claims checks that were not made.
- **Pi wall time:** The time from starting Pi to its exit, in seconds.
- **Driver call time:** The time from spawning `cua-driver call` to its parsed output, over 10 calls, in milliseconds.

### 14.1 Earlier rounds

- A smoke round and a second batch each ran every task once. Every task was done by the code check in both rounds. They exposed four defects, which were fixed in commit `6c33cd5` before the third batch:
  - A planner that had just typed into TextEdit could not see its own line, because an element's name is cut at the name length. It typed probe letters into the document to find it. The planner's table now shows the last 200 characters of a text field or text area.
  - A step with the key "Backspace" was answered with `press`, which clicked the text area. A step with `keys` is now offered only `key_combo`, a step with `text` only `enter_text`, and keys are validated with common aliases.
  - The executor abstained on a clear text-entry step, because it was also asked to choose the operation. A step that fixes its operation no longer asks the operation question.
  - A planner wrote `role: "selected"` to check a Finder selection, so a successful click was reported as failed. A `selected` predicate was added, and a role must now look like an accessibility role.
- The first relay execution of the smoke round ran all three tasks in one command. The relay reported that command as uncertain. Its output was extracted read-only and not replayed. Later rounds ran one task per relay command.

### 14.2 Third batch: 15 runs

The third batch ran each task 5 times, on the code of commit `6c33cd5`, in lease `relay-computer-use-batch-3-968add37`.

| Task | Task done | Answer states the result | Plan calls per run | Runs with no escalation or rejection | Pi wall time (s) |
| --- | --- | --- | --- | --- | --- |
| Calculator | 5 of 5 | 5 of 5 | 2 to 4 | 0 of 5 | 54 to 343 |
| TextEdit | 5 of 5 | 5 of 5 | 1 to 3 | 3 of 5 | 49 to 233 |
| Finder | 5 of 5 | 5 of 5 | 1 to 4 | 1 of 5 | 30 to 139 |

- Every run reached the checked result. The escalations and rejections cost plan calls and time, not correctness.
- In Calculator, every first plan was rejected by the plan validator. In 4 runs, the reason was a text check for "7", which is the name of a button. In the fifth run, the reason was an unsupported `equals` text check, and a later call added a `name` field to each step, which the tool's schema rejected. Pi corrected each rejection in the next call.
- The first Calculator run took 343 seconds, and the relay reported its command as uncertain. Its evidence was extracted read-only.

### 14.3 Escalations in the third batch

**The harness pressed a button twice after the first press took effect.** In the first Calculator run, the Add step had a postcondition that could not hold. The first press changed the display, and the harness pressed Add a second time, because the step allowed two attempts. The step pictures show different before and after images for the first attempt. A second press of a Send button would send twice. Fix, after the batch: an action that changed the screen but missed its postcondition is not repeated, unless the step is `idempotent`, and a step may allow more than one attempt only when it is `idempotent`.

**A plan acted on another window.** Two Finder runs planned without `window_title`. The backend then took the frontmost titled Finder window, which was a second window showing the batch's `content` folder, not "Fixture Folder". In one run, the plan also named an observation of "Fixture Folder" in `based_on`, and the harness still read the other window. The executor abstained in two of these plans, and in a third its choice, the file "cover.html", fell below the confidence gate. No wrong action was taken. How the second Finder window was opened is not established. Fix, after the batch:

- A plan with `based_on` acts on the window of that observation.
- A plan without `based_on` or `window_title` escalates `window_unclear` when several windows of the app are on screen, instead of taking the frontmost one.
- Every read after the first one in a plan uses the same window. A closed window escalates `window_unclear`.

**A text check for a control's name.** In three Finder runs, the scroll step checked `text contains "Zoning notes"`. The file's name is the label of a list item, and text checks do not search labels, so the check failed while the file was in view. The step escalated `postcondition_failed` in one run. In the two runs that allowed more attempts, a further scroll changed nothing, and the step escalated `no_progress`. The later plans selected the file directly. Fix, after the batch: when a text check fails and a control with a matching name is on screen, the failure names the control and says to check it with `exists`.

**A check that held before the step.** In one Finder run, the select step checked `exists "Zoning notes.txt"`, which already held after the scroll. The harness stopped with `already_satisfied` before any action, as designed, and the next plan checked `selected`.

**A save that the harness could not confirm.** In one TextEdit run, Pi added a Cmd+S step with the postcondition `changed`, although the task did not ask to save. The tree did not change, and the step escalated `no_progress`. Pi then tried the File menu, which escalated `target_not_found` because menu bar items are not in the table, and sent Cmd+S once more.

- The title bar of the TextEdit window has a disabled menu button labelled "Edited" after a change and "document actions" before one. It stayed "Edited" after both Cmd+S steps, so Cmd+S did not save the document.
- The file on disk still ended with the new line in all 5 TextEdit runs, including the 4 runs without Cmd+S. TextEdit's autosave wrote it. The file on disk is therefore no evidence of a save.
- Cmd+S was sent with foreground delivery. With [Section 12.1](#121-why-a-click-into-a-covered-window-did-not-move-the-insertion-point), where Cmd+A selected nothing in either delivery mode, this is a second menu shortcut that had no effect through the driver.
- Pi's final answer said the document was saved with Cmd+S and explained the missing change away. The harness had reported the step as failed. This is a claim that the "Answer states the result" formula does not detect.
- No fix was made. Saving and other menu commands need either a menu operation or a proven way to deliver menu shortcuts, which is a design decision.

### 14.4 Driver call time

Each run of the batch script measured each call 10 times. The table gives the lowest and highest of those per-run medians over the smoke round and batches 2 and 3.

| Call | Driver call time, median (ms) |
| --- | --- |
| `list_apps` | 438 to 630 |
| `list_windows` | 11 to 13 |
| `get_window_state` | 159 to 179 |
| `lsappinfo front`, then `lsappinfo info -only pid` | 6 to 8 |

- The backend calls `list_apps` only to learn which application is active, and the call also scans installed applications. The two `lsappinfo` calls answer the same question about 70 times faster.
- The `lsappinfo` output was compared with `list_apps` in the batch script only, not in the backend.

### 14.5 Relay limits met

- A lease cannot be staged twice, so a code change needs a new lease.
- A detached process started by a relay command is stopped when the command ends, so the batch cannot run in the background.
- A relay command that runs longer than about 5 minutes can return "request failed", which the relay records as an uncertain outcome. Running one task per command kept each command short.

### 14.6 Fourth batch on the fixes

Two leases ran the fixes of Section 14.3 through Pi. Lease `relay-computer-use-batch-4-49dbacc5` ran commit `32b9c64`, which contains the act-once rule, the window rules, the control-name hint and the `lsappinfo` source of the active application. Lease `relay-computer-use-batch-5-80c0c1cf` ran commit `92d26e5`, which also lets a scroll step repeat. The formulas are those of this section.

| Lease | Task | Task done | Answer states the result | Plan outcomes | Pi wall time (s) |
| --- | --- | --- | --- | --- | --- |
| 4 | Calculator | yes | yes | rejected, rejected, completed | 213 |
| 4 | TextEdit | yes | yes | escalated 5 times | 411 |
| 4 | Finder | yes | yes | escalated, escalated, completed | 37 |
| 5 | Finder | yes | yes | completed | 98 |
| 5 | Finder | yes | yes | escalated, completed | 46 |
| 5 | Finder | yes | yes | escalated, escalated, completed | 29 |
| 5 | Calculator | yes | yes | rejected, completed | 166 |

**The fixes seen through Pi:**

- **Act-once:** No non-scroll action was repeated after it changed the screen. Each such step stopped with "it was not repeated".
- **Window rules:** Twice, once in each lease, a plan named no window while 2 or 4 Finder windows were open. Each plan escalated `window_unclear` with the window titles and took no action, and the next plan named "Fixture Folder" and completed.
- **Scroll repeat:** In lease 4, a scroll step that missed its check was not repeated, and Pi needed a new plan. After the change in lease 5, a scroll step repeated within its plan. In the first lease-5 run, the task took one plan.
- **Control-name hint:** In two lease-5 runs, the scroll step still checked the file name with a text check. The scroll repeated until the list stopped moving, the step escalated `no_progress` because the view had reached its end, and the failure named the control. The next plan selected the file in both runs. The hint arrives only after the failure, so it does not prevent the first mistake.
- The extra Finder windows were titled "content" and "Recents". They most likely are windows that Finder restores when the batch script relaunches it. This was not checked.

**TextEdit and the save:** In the lease-4 TextEdit run, Pi added a save to the task again and spent five plans on it: Cmd+S twice, a click and a double click to activate the window, and the File menu. Each plan escalated, and the run took 411 seconds. The relay recorded the command as uncertain, and the evidence was extracted read-only. This time, Pi's final answer said that the save could not be confirmed.

**Menu shortcut delivery:** The script `scripts/computer-use/menu-shortcut.ts` typed one letter into TextEdit, covered it with Safari, sent Cmd+S one way, and read the title-bar menu button.

| Cmd+S sent with | "Edited" cleared |
| --- | --- |
| `press_key` with foreground delivery, as the backend sends it | 0 of 3 |
| `hotkey` with background delivery | 0 of 3 |
| `hotkey` with foreground delivery, which the driver documents as the path for menu key equivalents | 0 of 3 |
| `open -a TextEdit`, then `hotkey` to the frontmost application | 0 of 3 |

- A control run asked TextEdit to save through AppleScript. The `osascript` call timed out after 20 seconds in 3 of 3 trials, and no permission dialog was on screen afterwards.
- The control therefore did not show that the "Edited" label clears after a real save. The result is that none of the four deliveries changed the label, not that the shortcuts are proven undeliverable.

**Active application:** With each application brought to the front by `open -a`, the batch script compared the `lsappinfo` process with the one active process of `list_apps`.

- They agreed in 24 of 28 readings, over 5 passes of 4 applications and one separate pass of 8.
- All 4 disagreements came from the first pass in a new virtual machine. In each, `list_apps` still named the application that had been active before, and `lsappinfo` named the application just brought forward. Later passes in the same machine agreed in every reading.
- No third source settled which answer was correct for those 4 readings. The window order from `list_windows` stayed on TextEdit through a whole pass, so it is no witness.
- The backend uses `lsappinfo` and falls back to `list_apps` when `lsappinfo` fails. Delivery is chosen by the kind of action, not by the active flag. The flag decides whether the observer keeps menu bar items, so a wrong answer would hide or show the menu bar in one observation.

**Evidence:** The relay manifests are under `relay-evidence/relay-computer-use-batch-db90647b/`, `relay-evidence/relay-computer-use-batch-2-6373b845/`, `relay-evidence/relay-computer-use-batch-3-968add37/`, `relay-evidence/relay-computer-use-batch-4-49dbacc5/` and `relay-evidence/relay-computer-use-batch-5-80c0c1cf/`, which are not versioned. The batch-4 lease finished with execution uncertain, because of its TextEdit run, and the batch-5 lease finished with execution passed. Each run has `events.jsonl`, the harness records, the step pictures and `review.md`. The batch-3 lease finished with delivery verified and execution uncertain, because of the first Calculator run.

**Verification limits:**

- The fixes made after the third batch ran through Pi in 7 runs, which show that each path works, not how often.
- Five runs per task show that the paths work repeatedly on three tasks. They do not give a rate for other applications.
- A person has not reviewed the step pictures.

## 15. Relay client checks (2026-09-24)

The relay client ([design Section 11.2](../arch/computer-use.md#112-relay-client)) ran on the development machine against a fresh `macos26` virtual machine, through its own `mcp-vm-relay` 0.4.0 server. The script is `scripts/computer-use/relay-live.ts`. It opens Calculator, reads the window, and then runs a four-step plan for 7 plus 3 through the real harness and the executor at `jev.home.arpa`. The tested revision is the working tree on top of `2edd2e9`.

**Formulas.** Each number below names one of these:

- *Relay read time, ms* is the wall clock from calling `readWindow` to its return, with a window screenshot, on a window that was already read once, so no warm-up read is included. One such read makes three relay runs, `list_windows`, `lsappinfo` and `get_window_state`, and one `image` call.
- *Relay action time, ms* is the wall clock of one `act` call. For a click it makes two relay runs: `list_windows` for the window bounds, and the `cua` click. Each run includes the relay's own before and after display screenshots.

**Results.**

| Run | What happened |
| --- | --- |
| First | The `npx` start of the server timed out. A registry request reset by the network kept `npx` retrying past the client's 60-second start limit, in 3 of 3 starts. With `--prefer-offline`, 3 of 3 starts connected in about 285 ms, wall clock from `connect` to its return. |
| Second | Reads worked, with 176 elements, but every screenshot failed with `presentation-unavailable`, and the first click escalated `backend_failed`. |
| Third | The plan completed: 4 executor decisions, 4 actions, and 3 postconditions verified by code, the last one that the display ends with "10". |

- The relay's `image` action refuses a PNG with compressed metadata chunks, `iCCP`, `zTXt` or `iTXt`, and then reports no original. Every macOS window screenshot here carried `iCCP` and `iTXt`. The relay's own presentation function refused the original, 92,113 bytes, and accepted a copy without those chunks, 88,715 bytes, at the same 460 × 816 pixels. The guest read program now removes the chunks.

| Quantity | n | Median | Min | Max |
| --- | --- | --- | --- | --- |
| Relay read time, ms, before the plan | 5 | 22,891 | 22,530 | 23,269 |
| Relay read time, ms, during the plan | 5 | 17,540 | 15,948 | 17,576 |
| Relay action time, ms | 4 | 14,052 | 13,284 | 17,988 |

- These numbers are one virtual machine and one application. They show the scale of the cost, not its spread.
- In the second run, reads without a successful screenshot took a median of 13,606 ms by the same formula, so retrieving the screenshot cost about 9 seconds of each read.
- Acquisition, staging and opening Calculator took 30,680 ms. Neither this nor `finish` is a per-read quantity.
- `finish` failed in the second and third runs with "extraction exceeds 512MiB / 10000 files", and the relay kept both machines. The screenshot extraction was about 1 MB. The limit applies to each transfer out of the guest, and `finish` pulls the whole guest recording in one transfer. That recording holds two display screenshots of 5 to 11 MB for every relay run, and these runs made about 40 relay runs each. The client ignored the failed result and reported success. It now releases the machine after a failed `finish` and reports that the package was not delivered; this path has passed a contract test but has not run live. The two machines were released by hand through their owning relay sessions, and the VM service then listed none.
- At these times, one plan step with a verifying read takes about 30 seconds. The local backend's reads took well under 2 seconds ([Section 14.4](#144-driver-call-time)).

**Evidence:** The run directories are `test-results/computer-use/relay-live-2026-09-24T01-44-23-214Z/` and `test-results/computer-use/relay-live-2026-09-24T01-49-14-913Z/`, each with `log.txt`, the harness records and the delivered relay evidence package. They are not versioned.

**Verification limits:**

- The plan ran through the harness directly, not through Pi or a delegated agent.
- Only Calculator was used. A Finder read, which needs the compressed read path most, has not run through the relay client.

### 15.1 One relay run per read

The relay client was changed so that one read is one relay run. The guest program lists the windows, chooses the target with the client's own selection function, reads the active application, makes the warm-up read of a window not read before, reads the tree with a screenshot, and measures the screenshot's width for the scale. A click reuses the window bounds and scale from the latest read, so it is one relay run instead of two. The same script and the same formulas as above ran in a fresh `macos26` machine.

| Quantity | Before, median | After, n | After, median | After, min | After, max |
| --- | --- | --- | --- | --- | --- |
| Relay read time, ms, before the plan | 22,891 | 5 | 5,042 | 4,876 | 5,276 |
| Relay read time, ms, during the plan | 17,540 | 5 | 4,507 | 4,445 | 4,796 |
| Relay action time, ms | 14,052 | 4 | 7,127 | 7,038 | 7,175 |

- The script made 69 relay runs before the change and 21 after it, counted from the run requests in each evidence package.
- The plan completed again, with 4 executor decisions, 4 actions and 3 postconditions verified by code.
- `finish` succeeded, and took 90,430 ms. The package was delivered with delivery verified and execution passed, and the machine was released. Its size on this machine was 684 MB, mostly the relay's display screenshots.
- A click still takes about 7 seconds as one relay run, most of it the relay's before and after display screenshots and their transfer. A read without a screenshot fetch would be one relay run, but that was not measured separately.

**Evidence:** `test-results/computer-use/relay-live-2026-09-24T02-53-38-861Z/`, which is not versioned.

**Verification limits:**

- A click now uses the window position from the latest read. A window that moves between that read and the click would be clicked where it was; the step's postcondition would report the miss. This case has not been run.
- The 512 MiB cap on `finish` was not reached with 21 runs. The run count at which it is reached is not measured; the earlier runs passed it at about 69.

### 15.2 Delegation through Pi

A real Pi parent in RPC mode delegated a Calculator task to the computer-use agent definition, which ran through the relay client in a fresh `macos26` machine. The parent and the agent both used `litellm/qwen3.8-27b`, and the executor was `jev.home.arpa`. The script is `scripts/computer-use/pi-delegation-live.ts`; `relayPrepare` opened Calculator after staging, because the tools do not launch applications. The tested revision is the working tree on top of `8f3ce58`.

- The parent made one `Agent` call in the background and one `TaskOutput` call. It did not use the computer tools itself.
- The agent observed the window, and its first plan was rejected before any action. It had asked for "the display text contains 7" after pressing 7, and the plan check refused it because "7" is also the name of a button (see below).
- The agent's second plan completed with 4 executor decisions and 4 actions. Code verified only the last step, that the on-screen text contains "10". The steps for 7, Add and 3 were weakly verified, by a change on screen.
- The agent observed again and saw "7+3 10". Its report put the code-verified fact apart from the weak ones, as the template requires. It added one inference, that the final state is consistent with correct intermediate states, and labelled it as such.
- The parent's report repeated the agent's result and its limits correctly.
- The run took 225 s from the prompt to the run's success, wall clock, including acquiring the machine.
- The relay lease finished after Pi stopped, with delivery verified and execution passed, and the machine was released.

**Finding: the control-name plan check is too strict.** It was added on 2026-09-23 after the planner wrote "text contains All Clear" to check a button ([Section 11](#11-first-checks-through-pi-2026-09-23)). It cannot tell that mistake apart from a text the window will show after the step, such as a digit on a calculator display. In this run it removed code verification from 3 of 4 steps.

**Evidence:** `test-results/e2e/computer-use-delegation/2026-09-24T04-54-25-347Z-2f483b4b/`, with the parent's RPC events, the agent's session transcript under `extension-state/`, the run record and the relay evidence package. It is not versioned.

**Verification limits:**

- One run of one task. It shows that the chain works, not how often.
- The model does not accept images, so the agent planned from the element table only.


## 16. Plan checks and thinking (2026-09-25 to 2026-09-26)

### 16.1 A plan-start window check, replayed

A proposed check compares the observation a plan was written against with the plan's first read. It compares the kept controls by role and name, the window identifier, the window title, and elements that open over the window, such as a sheet, a dialog or a context menu. It ignores values and shown text. When the two differ, it also accepts a match with the last read of an earlier plan of ours that ran after that observation. The script `scripts/computer-use/replay-drift-check.ts` replayed it over every recorded plan and changed no behavior.

- 61 plans had a first read and an observation to compare, from 79 recorded session directories. Copies of a run were counted once.
- The check would have stopped 3 plans and let 58 through. All 3 were Finder plans that ran on a different window from the one observed, and each ended in an escalation when it ran. No plan that completed would have been stopped.
- 4 plans were let through only because their first read matched the last read of an earlier plan of ours.
- The check cost 0.012 ms of CPU time per comparison, over 61 comparisons.
- The staleness gap, which is the time from the observation to the plan's first read, had a median of 37.0 s and a longest value of 254.9 s.

**Evidence:** `test-results/computer-use/drift-replay-2026-09-25T20-54-56-847Z/report.md`. It is not versioned.

**Verification limits:** The replay judges recorded reads. It does not show what the planner would have done after a stop.

### 16.2 Calculator with thinking off

The Calculator task of [Section 15.2](#152-delegation-through-pi) ran again through Pi on 2026-09-25 at 22:41 UTC, with the computer-use definition set to `thinking: off`. The script, the task, the model, the executor and the relay image were the same.

| Quantity | Run of 2026-09-24 | Run of 2026-09-25 |
| --- | --- | --- |
| Thinking level recorded for the child | `off` | `off` |
| Thinking text in the child's replies, characters | 14,298 | 0 |
| Output tokens of the child's model replies | 4,655 | 1,526 |
| Model wait time: the sum of the times from each user message or tool result to the next assistant message | 102.3 s | 27.1 s |
| Tool time: the sum of the times from each assistant message to its tool result | 106.3 s | 97.0 s |
| Run wall time: from sending the prompt to stopping Pi | 240 s | 183 s |
| Plans rejected by the control-name plan check | 1 | 3 |
| Result | 10, correct | 10, correct |

- The child was already at thinking level `off` in the earlier run, because it inherited the parent's level, and the model still produced thinking text. Between the two runs, the provider package `pi-provider-litellm` changed from version 3.1.0 to 3.2.0, and 3.2.0 sends `off` as the reasoning effort `none`. The package change is the likely cause of the difference. The earlier run did not record the provider request, so this is not proven.
- The executor chose the correct control in every step of both runs.
- In the second run, the planner wrote "the display shows 7" after pressing 7 three times, with small changes, and the control-name check rejected each plan. The planner then used `{changed:true}` for the first three steps. Code verified only the last step, that the on-screen text contains "10".

**Evidence:** `test-results/e2e/computer-use-delegation/2026-09-25T22-41-55-635Z-e39a7820/`. It is not versioned.

**Verification limits:** One run for each setting. The parent was at thinking level `off` in both runs, so the runs do not show that the definition's field overrides a higher parent level. The deterministic tests in `tests/agents/thinking.test.ts` cover that.

### 16.3 Review of the plan check

An independent reviewer read the code on 2026-09-26 and judged the control-name plan check. Its findings were checked against the code.

- The check also rejects `{text:{endsWith}}`, which the agent's instructions tell the planner to use for typed text. The instructions and the check contradicted each other.
- The mistake the check was written for is already caught after the step. When a text check fails and a control with a matching name is on screen, the failure names the control and says to use `exists`. Because an action that took effect is not repeated, that mistake costs one escalation and never a double action.
- The planner's output is not constrained by the tool schema. The schema is fixed when the tool is registered, and the provider request carries no strict flag. A list of allowed controls in the schema would guide the planner but would not bind it.
- The executor's choice of control is already limited to a list built from a fresh read before each step.

The owner decided on 2026-09-26 to remove the check and to build plans from the controls the observation offers ([decisions PS-D3 and PS-D4](../decisions.md)).

### 16.4 Calculator after the plan checks were narrowed

The Calculator task of [Section 16.2](#162-calculator-with-thinking-off) ran again through Pi on 2026-09-25 at 23:50 UTC, at revision `3e8fb97`. The plan check no longer rejects a plan on a guess ([decision PS-D3](../decisions.md)). The script, the task, the model, the executor, the relay image and `thinking: off` were the same.

| Quantity | Run of 2026-09-25, 22:41 | Run of 2026-09-25, 23:50 |
| --- | --- | --- |
| Plans rejected | 3 | 0 |
| Plans run | 1 | 1 |
| Steps verified by code | 1 of 4 | 4 of 4 |
| Output tokens of the child's model replies | 1,526 | 402 |
| Model wait time: the sum of the times from each user message or tool result to the next assistant message | 27.1 s | 8.6 s |
| Tool time: the sum of the times from each assistant message to its tool result | 97.0 s | 103.5 s |
| Run wall time: from sending the prompt to stopping Pi | 183 s | 173 s |
| Result | 10, correct | 10, correct |

- The planner's first plan ran. Its checks were that the display text ends with "7", ends with "7+", contains "3", and ends with "10", and code verified each one after its step.
- The child made one `computer_observe` call and one `computer_run_plan` call.

**Evidence:** `test-results/e2e/computer-use-delegation/2026-09-25T23-50-46-723Z-5c21edf8/`. It is not versioned.

**Verification limits:** One run of one task. The check "contains 3" after pressing 3 would also hold for a display such as "3+", so a stricter check would have been `endsWith "7+3"`.

### 16.5 Named controls, the start check and three tasks, on relay 0.4.0

Pi delegated each task to the computer-use agent through the relay client, with `litellm/qwen3.8-27b`, the executor at `jev.home.arpa`, `thinking: off` and relay 0.4.0. The script is `scripts/computer-use/pi-delegation-live.ts` with the task as its third argument. Each task ran once, and each result below comes from the harness's plan records.

| Task | Started (UTC) | Revision | Plans run | Plans rejected | Outcome | Steps verified by code |
| --- | --- | --- | --- | --- | --- | --- |
| Calculator, 7 plus 3 | 2026-09-25 23:54 | `831184d`, named controls | 1 | 0 | completed, 10 | 4 of 4 |
| Calculator, 7 plus 3 | 2026-09-25 23:59 | `f58915c`, start check | 1 | 0 | completed, 10 | 3 of 4 |
| TextEdit, add a last line | 2026-09-26 00:01 | `f58915c` | 5 | 3 | stopped at the escalation limit | 0 |
| Finder, select a file | 2026-09-26 00:02 | `f58915c` | 1 | 0 | stopped, `backend_failed` | 0 |
| Finder, select a file | 2026-09-26 00:08 | `5f1add0`, title limit | 1 | 0 | completed | 2 of 2 |

- In both Calculator runs, the planner named each button in `control` exactly as the observation listed it, and the executor chose the same button every time. In the second run the planner chose `{changed:true}` for Add itself; no rule forced it.
- The start check ran in every plan that named `based_on`, and it stopped none of them.
- In TextEdit, the executor chose the menu bar item "Apple", at confidence 0.45, for a step that named the document's text area. The control check stopped the step twice before any click. The executor's element list has names without roles, and the text area's name is the start of the document, "Disposable document for the computer-use batch.…". The planner's list shows the role `TextArea`.
- In TextEdit, two plans stopped with `already_satisfied`, because their first checks were true before the step, and one stopped with `no_progress` after `cmd+down`. Its detail named the `position` field, as the removed rule had. One plan was rejected for a malformed `text` check, and two were rejected after the escalation limit.
- The first Finder run failed before any read, because the relay refused a preparation title of 740 characters (Section 16.6). Each failed start acquired and released a new machine, five in all. After the fix, the planner scrolled the list until "Zoning notes.txt" was on screen, named the file's control and selected it.

**Evidence:** the run directories under `test-results/e2e/computer-use-delegation/`, `test-results/e2e/computer-use-delegation-textedit/` and `test-results/e2e/computer-use-delegation-finder/`. They are not versioned.

**Verification limits:** One run per row. Nothing reads the window after Pi stops, so each outcome rests on the harness's own postconditions and the agent's report.

### 16.6 Relay 0.6.1

The relay client pinned `@wezzard/mcp-vm-relay@0.4.0` from 2026-09-24. Pi's own installed copy was 0.6.1, published on 2026-09-25. Every live check through 2026-09-26 at 00:09 UTC, including [Sections 16.2, 16.4 and 16.5](#162-calculator-with-thinking-off), ran on 0.4.0.

- Relay 0.6 replaced the single `relay` tool with one tool per operation: `relay_acquire`, `relay_stage`, `relay_exec`, `relay_code`, `relay_run`, `relay_image`, `relay_finish` and `relay_release`, among 19.
- `relay_run` sends one tool call to an MCP server inside the machine. For the `cua` target that is the guest's `cua-driver` server, so a click is `relay_run` with the driver's `click` tool.
- A probe on 2026-09-26 made one call of each kind in a `macos26` machine with 0.6.1. `relay_exec` and `relay_code` return the same result layout as 0.4.0: a line of image-delivery facts, then the execution. Output over 64 KiB is reported as an `uncertain` outcome with the diagnostic "execution exceeded output bound", without an `outputTruncated` field.
- A `relay_run` result carries the relay's record in its first text block and the driver's text in a second one. It reports `toolOutcome` apart from the relay's own outcome, and the driver's structured result in `structuredContent`.
- The guest had Node at `/usr/local/pilot-node/bin/node` on its path, and `RELAY_CUA_DRIVER` named `/Applications/CuaDriver.app/Contents/MacOS/cua-driver`. The working directory of a run was the guest workspace.
- The relay refuses a step title over 500 characters with the message "Invalid relay input: action is required; run and console-open require nonblank reason", which does not name the field. A Finder preparation command of 740 characters failed this way on 0.4.0 in the live check of 2026-09-26 at 00:02 UTC.

**Evidence:** `test-results/computer-use/relay-061-probe-2026-09-26T00-12-16-774Z/`. It is not versioned.

**The three tasks on 0.6.1.** Each task ran once through Pi at revision `f9f0fb2`, as in [Section 16.5](#165-named-controls-the-start-check-and-three-tasks-on-relay-040). Calculator and TextEdit started together, and Finder started when Calculator ended.

| Task | Started (UTC) | Delegations | Outcome | Steps verified by code |
| --- | --- | --- | --- | --- |
| Calculator | 2026-09-26 00:18 | 1 | completed, 10 | 3 of 4; the planner chose `{changed:true}` for Add |
| TextEdit | 2026-09-26 00:18 | 2; the parent resumed the agent after the first stopped | stopped | 0 |
| Finder | 2026-09-26 00:22 | 2; the parent delegated again after the first failed | completed on the second | 2 of 2 |

- Every lease ended with `relay_finish`, and each evidence package was delivered.
- The first Finder delegation could not acquire a machine: "macOS VM limit reached (2 active); … host-wide Virtualization.framework guests: 3 (1 not ours)". The TextEdit run held one machine at the time, and a guest outside this project held another. The second delegation acquired one and completed.
- In TextEdit, the executor answered "none" for every step that named the text area, and the plans stopped with `target_not_found`. The driver reports the text area's label as the document's text, so the executor's line for it is `I Disposable document for the computer-use batch.…`, with nothing that marks it as a place to type. Once the planner wrote `control: {name: "I"}`, the element's letter, and the control check stopped the step.
- After the TextEdit agent's first run reached the limit of 5 escalations, the parent resumed it with `SendMessage`. The limit counts per run, so the resumed run planned 5 more times.

**Verification limits:** One run per task. Two runs overlapped, so the machine-limit failure came from this check's own schedule.
