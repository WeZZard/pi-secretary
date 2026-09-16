/**
 * Entrypoint registration test — ensures the goal tools and /goal command are
 * registered at extension load (regression guard against lazy registration).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalEngine } from "../../extensions/secretary/goal-engine.ts";

test("extension registers goal tools and /goal command at load", async () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const stub = {
    on: () => {},
    registerTool: (t: { name: string }) => tools.push(t.name),
    registerCommand: (n: string) => commands.push(n),
  };

  const { installSecretary } = await import("../../extensions/secretary/index.ts");
  const engine = new GoalEngine({ dbPath: ":memory:" });
  const sync = installSecretary(stub as any, engine);
  sync.dispose();
  engine.dispose();
  engine.close();

  assert.deepEqual(tools.sort(), ["create_goal", "get_goal", "update_goal"]);
  assert.ok(commands.includes("goal"), "expected /goal command to be registered");
});
