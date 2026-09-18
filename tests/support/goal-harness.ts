import { GoalEngine } from "../../extensions/secretary/goal-engine.ts";
import { installSecretary } from "../../extensions/secretary/index.ts";

/** Runs production registration with deterministic event delivery and private in-memory storage. */
export function goalHarness(options: { engine?: GoalEngine; threadId?: string; hasUI?: boolean; entries?: any[] } = {}) {
  const engine = options.engine ?? new GoalEngine({ dbPath: ":memory:", enabled: true });
  const hooks = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: any[] = [];
  const entries: any[] = options.entries ?? [];
  const notices: string[] = [];
  const state = { threadId: options.threadId ?? "session-a", idle: true, pending: false,
    aborts: 0, status: undefined as string | undefined, widget: undefined as string[] | undefined,
    confirm: true, editor: undefined as string | undefined, activeTools: ["get_goal", "create_goal", "update_goal"] };
  const ctx: any = {
    hasUI: options.hasUI ?? true,
    sessionManager: { getSessionFile: () => state.threadId, getSessionId: () => state.threadId, getBranch: () => entries },
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    abort: () => { state.aborts++; },
    ui: {
      setStatus: (_key: string, value: string | undefined) => { state.status = value; },
      setWidget: (_key: string, value: unknown) => {
        // The goal widget is a component factory; render it to lines like the TUI does.
        if (typeof value === "function") {
          const component = (value as (tui: unknown, theme: unknown) => { render(width: number): string[]; dispose?(): void })(
            { requestRender: () => {} }, {});
          state.widget = component.render(80);
          component.dispose?.();
          return;
        }
        state.widget = value as string[] | undefined;
      },
      notify: (message: string) => notices.push(message),
      confirm: async () => state.confirm,
      input: async () => undefined,
      editor: async () => state.editor,
    },
  };
  const pi: any = {
    on: (name: string, handler: any) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    sendMessage: (message: any, delivery: any) => sent.push({ role: "custom", timestamp: Date.now(), ...message, delivery }),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    getActiveTools: () => state.activeTools,
    getSessionName: () => "Test session",
    setSessionName: () => {},
  };
  const sync = installSecretary(pi, engine);
  const emit = async (name: string, event: any = {}) => {
    let result: any;
    for (const handler of hooks.get(name) ?? []) result = await handler(event, ctx) ?? result;
    return result;
  };
  return {
    engine, sync, ctx, pi, state, hooks, tools, commands, sent, notices, entries, emit,
    start: (event = { reason: "startup" }) => emit("session_start", event),
    tool: (name: string, args: any = {}) => tools.get(name).execute("call", args, undefined, undefined, ctx),
    command: (args: string) => commands.get("goal").handler(args, ctx),
    context: async (messages: any[] = []) => (await emit("context", { messages })).messages,
    userMessage: async (text: string, timestamp = Date.now()) => {
      const message = { role: "user", content: text, timestamp };
      await emit("message_start", { message });
      return message;
    },
    flush: () => new Promise<void>((resolve) => setImmediate(resolve)),
    close: () => emit("session_shutdown"),
  };
}

export function assistant(stopReason = "stop", output = 10, text = "Response") {
  return { role: "assistant", stopReason, content: text ? [{ type: "text", text }] : [],
    usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output } };
}
