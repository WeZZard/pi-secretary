import { test } from "node:test";
import assert from "node:assert/strict";
import { adapter } from "../acceptance/ui-harness.ts";
import { nestedRealTree, settle } from "../support/nested-real-tree.ts";

/**
 * Failing reproducers for the nested-subagent UI audit checkpoints 1-3.
 *
 * Each test drives the real host wiring (`registerAgentUI` through `adapter`) against a real
 * `AgentService` delegation tree (`nestedRealTree`), so the reducer, the service, the storage,
 * and the session files are production implementations. They are expected to fail until the
 * reducer's session filter is fixed; see `.plans/` for the fix plan.
 */

test("checkpoint 1 repro: drilling into a delegating agent shows the nested agent's own transcript", async t => {
  const tree = await nestedRealTree(t);
  const h = adapter(t, tree.uiPort);
  const closed = h.command(tree.a.agent.agentId);
  await settle();
  assert.ok(h.inspector, "the overlay must open on the delegating agent");
  h.inspector!.handleInput("\r");
  await settle();
  assert.match(h.render(), /NESTED_TRANSCRIPT_NESTED-B/,
    "the transcript pane must show the nested child's own transcript after drilling in");
  h.inspector!.handleInput("\x1b");
  await closed;
});

test("checkpoint 2 repro: the overlay renders nested children as a drill level, the indicator stays top-level", async t => {
  const tree = await nestedRealTree(t);
  const h = adapter(t, tree.uiPort);
  const closed = h.command(tree.a.agent.agentId);
  await settle();
  assert.match(h.fleet(), /delegator/, "the indicator lists the top-level delegating agent");
  assert.doesNotMatch(h.fleet(), /nested-b|nested-c/, "the indicator must never list nested agents");
  h.inspector!.handleInput("\r");
  await settle();
  const drilled = h.render();
  assert.match(drilled, /nested-b/, "the drilled level must render the first nested child");
  assert.match(drilled, /nested-c/, "the drilled level must render the second nested child");
  assert.match(drilled, /Agents ›/, "the title must show the drill path");
  h.inspector!.handleInput("\x1b[D");
  await settle();
  assert.doesNotMatch(h.render(), /nested-b/, "Left must return to the root level");
  h.inspector!.handleInput("\x1b");
  await closed;
});

test("checkpoint 1 repro: drilling two levels reaches the deepest nested agent and returns to the root", async t => {
  const tree = await nestedRealTree(t, { grandchild: true });
  const h = adapter(t, tree.uiPort);
  const closed = h.command(tree.a.agent.agentId);
  await settle();
  h.inspector!.handleInput("\r");
  await settle();
  assert.match(h.render(), /NESTED_TRANSCRIPT_NESTED-B/, "the first drill level shows the nested child's transcript");
  h.inspector!.handleInput("\r");
  await settle();
  assert.match(h.render(), /NESTED_TRANSCRIPT_NESTED-D/, "the second drill level shows the deepest nested agent's transcript");
  assert.match(h.render(), /Agents ›/, "the title shows the drill path at depth two");
  h.inspector!.handleInput("\x1b[D");
  await settle();
  assert.match(h.render(), /NESTED_TRANSCRIPT_NESTED-B/, "the first Left returns to the intermediate level");
  h.inspector!.handleInput("\x1b[D");
  await settle();
  assert.doesNotMatch(h.render(), /nested-d/, "the second Left returns to the root level");
  h.inspector!.handleInput("\x1b");
  await closed;
});

test("checkpoint 3 repro: the main session can stop an individual nested agent from the TUI", async t => {
  const tree = await nestedRealTree(t);
  const h = adapter(t, tree.uiPort);
  const closed = h.command(`stop ${tree.b.agent.agentId}`);
  await settle();
  const nestedStatus = tree.service.run(tree.b.run!.runId).status;
  assert.ok(nestedStatus === "cancelling" || nestedStatus === "cancelled",
    `the TUI stop must cancel the nested run; observed status ${nestedStatus}`);
  assert.equal(tree.service.run(tree.a.run!.runId).status, "running", "the delegating parent keeps running");
  h.inspector?.handleInput("\x1b");
  await closed;
});
