import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Records the final outgoing model context after every other extension has run. */
export default function recordContextRequests(pi: ExtensionAPI) {
  const path = process.env.PI_E2E_CONTEXT_RECORDER;
  if (!path) throw new Error("The context recorder requires its output path");
  let sequence = 0;
  pi.on("context", (event) => {
    sequence += 1;
    const customTypes = event.messages
      .filter((message) => message.role === "custom")
      .map((message) => (message as { customType?: string }).customType ?? null);
    appendFileSync(path, JSON.stringify({ sequence, customTypes }) + "\n", { mode: 0o600 });
  });
}
