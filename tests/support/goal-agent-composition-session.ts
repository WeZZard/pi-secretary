import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import type { InputEvent } from "@earendil-works/pi-coding-agent";
import { AgentRepository } from "../../extensions/secretary/agents/storage/agent-repository.ts";
import { discoverySession } from "./discovery-session.ts";

export async function goalAgentCompositionSession(t: TestContext, options: Parameters<typeof discoverySession>[1]) {
  const base = resolve(process.env.SECRETARY_COMPOSITION_RESULTS ?? "test-results/goal-agent-composition");
  await mkdir(base, { recursive: true });
  const evidence = await mkdtemp(join(base, "run-"));
  t.diagnostic(`Composition evidence: ${evidence}`);
  const inputs: InputEvent[] = [];
  const h = await discoverySession(t, { ...options, mode: "rpc", extension(pi) {
    pi.on("input", event => { inputs.push(structuredClone(event)); });
    options?.extension?.(pi);
  } });
  const repository = new AgentRepository(h.engine.db.connection);
  const threadId = h.manager.getSessionId();
  const goalThreadId = h.session.sessionFile!;
  return { ...h, evidence, repository, threadId, goalThreadId, inputs,
    async retain(extra: unknown) {
      await writeFile(join(evidence, "execution.json"), JSON.stringify({
        mode: "rpc", threadId, goalThreadId, inputs, parentCalls: h.parentCalls, childCalls: h.childCalls,
        messages: h.session.messages, goal: h.engine.service.getGoal(goalThreadId),
        agents: repository.agents(threadId), runs: repository.runs(threadId),
        completions: repository.completions(threadId), extra,
      }, null, 2));
      await cp(h.root, join(evidence, "isolated-session"), { recursive: true });
    },
  };
}
