import { getCurrentSystemPrompt, getCurrentTools, type Context, type TranscriptContext } from "@earendil-works/pi-ai";

/** Expose the normalized provider transcript in the shape used by test assertions. */
export function providerContext(context: TranscriptContext): Context {
  return {
    systemPrompt: getCurrentSystemPrompt(context.messages),
    messages: context.messages,
    tools: getCurrentTools(context.messages),
  };
}
