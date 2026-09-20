import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import secretaryExtension from "../../extensions/secretary/index.ts";

export default function fixture(pi: ExtensionAPI) {
  const root = process.env.SECRETARY_TUI_FIXTURE;
  if (!root) throw new Error("Isolated SECRETARY_TUI_FIXTURE is required");
  let sequence = 0;
  const submitted = new Set<string>();
  pi.registerProvider("inline-test", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1/never", apiKey: "fixture-only",
    models: [{ id: "fixture", name: "Inline fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const users = context.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
      const childTask = users.find(text => text.startsWith("Current child task"));
      const base: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], stopReason: "stop", timestamp: Date.now(), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const done = (content: AssistantMessage["content"], tool = false) => {
        const message: AssistantMessage = { ...base, content, stopReason: tool ? "toolUse" : "stop" };
        stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message }); stream.end();
      };
      if (childTask) {
        const kind = childTask.includes("FOREGROUND_TASK") ? "foreground" : "background";
        writeFileSync(join(root, `${kind}-running`), "yes");
        const timer = setInterval(() => {
          if (options?.signal?.aborted) {
            clearInterval(timer);
            stream.push({ type: "error", reason: "aborted", error: { ...base, stopReason: "aborted" } }); stream.end();
          } else if (existsSync(join(root, `release-${kind}`))) {
            clearInterval(timer);
            done([{ type: "text", text: `${kind.toUpperCase()}_RESULT: deterministic work completed.` }]);
          }
        }, 25);
      } else {
        const command = [...users].reverse().find(text => /^(foreground|background|message)(\s|$)/.test(text))?.split(/\s/)[0] ?? "";
        if (submitted.has(command)) done([{ type: "text", text: "INLINE_STEP_DONE" }]);
        else if (command === "message") done([{ type: "toolCall", id: `fixture-${++sequence}`, name: "SendMessage", arguments: { to: "background-worker", message: "MESSAGE_FIRST: inspect the cancellation path carefully before finishing.\nMESSAGE_SECOND: preserve the original multiline guidance and report the result.", summary: "Not the actual message" } }], true);
        else if (command === "foreground" || command === "background") done([{ type: "toolCall", id: `fixture-${++sequence}`, name: "Agent", arguments: {
          prompt: `${command.toUpperCase()}_TASK: inspect the isolated fixture.`, description: "Inline fixture", name: `${command}-worker`, run_in_background: command === "background",
        } }], true);
        else done([{ type: "text", text: "INLINE_IDLE" }]);
        submitted.add(command);
      }
      return stream;
    },
  });
  secretaryExtension(pi);
  pi.on("session_start", () => { writeFileSync(join(root, "parent-ready"), "yes"); });
}
