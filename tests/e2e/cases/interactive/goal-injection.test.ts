import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCleanPiEnvironment } from "../../environment/isolation.ts";
import { useGlobalLiteLLM } from "../../environment/global-litellm.ts";
import { startInteractivePi } from "../../environment/interactive-pi-process.ts";
import { readTranscript, sessionFiles } from "../../environment/transcripts.ts";

// Architecture §13.3: context injection is positive-only. A conversation that never
// used the goal system must receive no goal snapshot and no agents roster message.
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const fixtures = join(repository, "tests/e2e/fixtures/goal-injection");
const recorderEntry = join(repository, "tests/e2e/environment/context-recorder.ts");
const observerEntry = join(repository, "tests/e2e/environment/ui-observer.ts");

function readRecording(path: string): Array<{ sequence: number; customTypes: Array<string | null> }> {
  assert.ok(existsSync(path), "The recorder must observe at least one model request");
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as { sequence: number; customTypes: Array<string | null> });
}

test("goal-free conversation receives no goal injection (interactive)", { timeout: 330000 }, async t => {
  const environment = createCleanPiEnvironment({ name: "goal-injection-tui",
    extensionUnderTest: join(repository, "extensions/secretary/index.ts"),
    projectFixture: fixtures, repositoryState: "none" });
  t.after(() => environment.dispose());
  const profile = useGlobalLiteLLM(environment, undefined, { model: "kimi-k3-256k" });
  const settings = JSON.parse(readFileSync(join(environment.agentDir, "settings.json"), "utf8"));
  settings.extensions.push(observerEntry, recorderEntry);
  environment.extensions.push(observerEntry, recorderEntry);
  settings.enabledModels = [`${profile.provider}/${profile.model}`];
  writeFileSync(join(environment.agentDir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
  const recording = join(environment.artifacts, "context-requests.jsonl");
  environment.env.PI_E2E_CONTEXT_RECORDER = recording;
  environment.env.LITELLM_OFFLINE = "1"; // Disable discovery, not real inference.
  writeFileSync(join(environment.artifacts, "terminal-profile.json"), JSON.stringify({ frontend: "interactive TUI",
    inputTransport: "POSIX PTY", realModelRequests: true, visibleDesktopWindow: false,
    permittedCatalogModels: [`${profile.provider}/${profile.model}`], discoveryDisabled: true,
    observer: observerEntry, recorder: recorderEntry, humanReview: "not performed" }, null, 2) + "\n");
  const observer = join(environment.artifacts, "ui-lifecycle.jsonl");
  const prompt = "Reply with exactly: PONG";
  const pi = startInteractivePi(environment, { prompt, model: `${profile.provider}/${profile.model}`,
    observer, timeoutMs: 180000, tools: [] });
  t.after(() => pi.stop());
  const outcome = await pi.result;
  profile.redactArtifacts();
  const terminalResult = JSON.parse(readFileSync(join(pi.terminal, "result.json"), "utf8"));
  assert.equal(terminalResult.completedInteraction, true, terminalResult.failure ?? "The interactive session did not complete");
  assert.equal(outcome.code, 0, readFileSync(join(environment.artifacts, "terminal-driver.stderr.log"), "utf8"));
  const requests = readRecording(recording);
  for (const request of requests) {
    assert.ok(!request.customTypes.includes("secretary:goal-state"),
      `request ${request.sequence} carried a goal snapshot in a goal-free conversation`);
    assert.ok(!request.customTypes.includes("secretary:agents-state"),
      `request ${request.sequence} carried an empty agents roster in an agent-free conversation`);
  }
  const files = sessionFiles(environment.sessions);
  assert.equal(files.length, 1, "Expected one persisted conversation");
  const transcript = readTranscript(files[0]!);
  const reply = transcript.map(entry => entry.message).find(message => message?.role === "assistant");
  assert.ok(reply, "The live model must answer the prompt");
  writeFileSync(join(environment.artifacts, "assertions.json"), JSON.stringify({ requests: requests.length,
    goalMessages: requests.filter(request => request.customTypes.includes("secretary:goal-state")).length,
    rosterMessages: requests.filter(request => request.customTypes.includes("secretary:agents-state")).length }, null, 2) + "\n");
});
