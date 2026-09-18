import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCleanPiEnvironment } from "../../environment/isolation.ts";
import { useGlobalLiteLLM } from "../../environment/global-litellm.ts";
import { startPi } from "../../environment/pi-process.ts";
import { readTranscript, sessionFiles } from "../../environment/transcripts.ts";

// Architecture §13.3: context injection is positive-only. A conversation that never
// used the goal system must receive no goal snapshot and no agents roster message.
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const fixtures = join(repository, "tests/e2e/fixtures/goal-injection");
const recorderEntry = join(repository, "tests/e2e/environment/context-recorder.ts");

function readRecording(path: string): Array<{ sequence: number; customTypes: Array<string | null> }> {
  assert.ok(existsSync(path), "The recorder must observe at least one model request");
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as { sequence: number; customTypes: Array<string | null> });
}

test("goal-free conversation receives no goal injection (non-interactive)", { timeout: 240000 }, async t => {
  const environment = createCleanPiEnvironment({ name: "goal-injection",
    extensionUnderTest: join(repository, "extensions/secretary/index.ts"),
    projectFixture: fixtures, repositoryState: "none" });
  t.after(() => environment.dispose());
  const profile = useGlobalLiteLLM(environment);
  const settings = JSON.parse(readFileSync(join(environment.agentDir, "settings.json"), "utf8"));
  settings.extensions.push(recorderEntry); environment.extensions.push(recorderEntry);
  writeFileSync(join(environment.agentDir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
  const recording = join(environment.artifacts, "context-requests.jsonl");
  environment.env.PI_E2E_CONTEXT_RECORDER = recording;
  const prompt = "Reply with exactly: PONG";
  const pi = startPi(environment, { prompt, model: `${profile.provider}/${profile.model}`,
    offline: false, timeoutMs: 120000, tools: [] });
  t.after(() => pi.stop());
  const outcome = await pi.result;
  profile.redactArtifacts();
  const stderr = readFileSync(join(environment.artifacts, "stderr.log"), "utf8");
  assert.equal(outcome.timedOut, false, "Live provider test exceeded its process deadline");
  assert.equal(outcome.code, 0, stderr);
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
