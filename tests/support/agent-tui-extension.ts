import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import secretaryExtension from "../../extensions/secretary/index.ts";

/** Isolated real-terminal fixture. Its provider never performs network requests. */
export default function fixture(pi: ExtensionAPI) {
  const root = process.env.SECRETARY_TUI_FIXTURE;
  if (!root) throw new Error("SECRETARY_TUI_FIXTURE is required; this fixture must not run in a user session.");
  let launched = false;
  let childCalls = 0;
  pi.registerProvider("secretary-tui-test", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1/never", apiKey: "test-only",
    models: [{ id: "fixture", name: "Terminal acceptance fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const child = context.messages.some(message => message.role === "user" &&
        (typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join("\n")).startsWith("Current child task"));
      const base: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], stopReason: "stop", timestamp: Date.now(), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      if (child && ++childCalls > 1) {
        writeFileSync(join(root, "child-running"), "yes");
        const abort = () => {
          const error: AssistantMessage = { ...base, stopReason: "aborted", content: [{ type: "text", text: "The controlled child stopped after cancellation." }] };
          stream.push({ type: "error", reason: "aborted", error }); stream.end();
          writeFileSync(join(root, "child-cancelled"), "yes");
        };
        if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener("abort", abort, { once: true });
        return stream;
      }
      const message: AssistantMessage = child ? { ...base, stopReason: "toolUse", content: [
        { type: "text", text: "## Fixture investigation\n\nI will read the local evidence and wait for guidance.\n\n" + Array.from({ length: 32 }, (_, i) => `- Evidence item ${i + 1} remains available for scrolling.`).join("\n") },
        { type: "toolCall", id: "read-fixture", name: "read", arguments: { path: join(root, "facts.txt") } },
      ] } : !launched ? { ...base, stopReason: "toolUse", content: [{ type: "toolCall", id: "launch-fixture", name: "Agent", arguments: {
        prompt: "Inspect the acceptance fixture and wait for further guidance.", description: "Inspect acceptance fixture", name: "acceptance-worker", run_in_background: true,
      } }] } : { ...base, content: [{ type: "text", text: "The delegated execution is visible in FleetView. Open /agents to inspect it." }] };
      if (!child) launched = true;
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }); stream.end();
      return stream;
    },
  });
  secretaryExtension(pi);
  pi.on("session_start", () => { writeFileSync(join(root, "parent-ready"), "yes"); });
  pi.on("ui_prompt_end", () => { writeFileSync(join(root, "ui-closed"), "yes"); });
}
