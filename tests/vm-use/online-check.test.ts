import assert from "node:assert/strict";
import { test } from "node:test";
import { DecisionServiceError, type Fetch } from "../../extensions/secretary/vm-use/decision-service-client.ts";
import { OnlineCheckClient, buildPlanCheckRequest, judgeStep, planCheckState } from "../../extensions/secretary/vm-use/online-check.ts";

const plan = planCheckState({
  request: "Write to Bob that the meeting moved, and send it.‮", goal: "Send Bob a message", app: "Mail", window: "New Message",
  steps: [
    { id: "body", intent: "Type the message", action: "type", text: `The meeting moved.${"x".repeat(600)}`, position: "end", ui_element: { role: "AXTextArea", name: "Message  body" } },
    { id: "send", intent: "Send it", action: "click", ui_element: { role: "AXButton", name: "Send" } },
    { id: "close", intent: "Close the window", keys: "cmd+w" },
  ],
});
const config = { url: "http://api.home.arpa/v1/chat/completions", model: "deepseek-flash", apiKeyEnv: "TEST_KEY", timeoutMs: 1000 };
const reply = (content: string, status = 200): Fetch => async () => ({ ok: status < 400, status, text: async () => JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 300, completion_tokens: 20 } }) });

test("the plan check sends the request, the goal, the application, the window and the steps, and no window text (design §8.3)", () => {
  assert.equal(plan.request, "Write to Bob that the meeting moved, and send it.", "Bidirectional marks are removed");
  assert.deepEqual(plan.steps[1], { id: "send", intent: "Send it", action: "click", ui_element: 'Button "Send"' });
  assert.equal(plan.steps[0]!.ui_element, 'TextArea "Message body"');
  assert.equal([...plan.steps[0]!.text!].length, 500, "Typed text is cut at 500 characters");
  assert.deepEqual(plan.steps[2], { id: "close", intent: "Close the window", keys: "cmd+w" });
  assert.equal(planCheckState({ request: "x".repeat(5000), goal: "g", app: "a", steps: [] }).request!.length, 4000);
  const request = buildPlanCheckRequest(plan, "deepseek-flash") as { model: string; messages: { role: string; content: string }[]; response_format: unknown };
  assert.equal(request.model, "deepseek-flash");
  assert.deepEqual(request.response_format, { type: "json_object" });
  assert.deepEqual(JSON.parse(request.messages[1]!.content), plan);
  assert.deepEqual(Object.keys(JSON.parse(request.messages[1]!.content)), ["request", "goal", "app", "window", "steps"]);
  for (const text of ["Question reach:", "- guest:", "- outside_guest:", "Question requested:", "- yes:", "- no:",
    '"send":{"reach":"guest | outside_guest","requested":"yes | no"}']) {
    assert.ok(request.messages[0]!.content.includes(text), text);
  }
});

test("a step needs approval when it leaves the guest, when the request asks for it, or when its answer is missing or unknown", () => {
  assert.deepEqual(judgeStep("s", { reach: "guest", requested: "no" }), { id: "s", reach: "guest", requested: "no", needsApproval: false });
  assert.deepEqual(judgeStep("s", { reach: "outside_guest", requested: "no" }), { id: "s", reach: "outside_guest", requested: "no", needsApproval: true, why: "outside_guest" });
  assert.deepEqual(judgeStep("s", { reach: "guest", requested: "yes" }), { id: "s", reach: "guest", requested: "yes", needsApproval: true, why: "requested" });
  assert.deepEqual(judgeStep("s", { reach: "outside_guest", requested: "yes" }).why, "outside_guest");
  for (const answer of [undefined, null, "guest", [], {}, { reach: "guest" }, { requested: "no" }, { reach: "local", requested: "no" }, { reach: "guest", requested: "maybe" }]) {
    const judged = judgeStep("s", answer);
    assert.deepEqual([judged.needsApproval, judged.why], [true, "doubt"], JSON.stringify(answer));
  }
});

test("the client sends the key from the named variable and judges every step of the plan from the reply", async () => {
  let seen: { url: string; headers: Record<string, string>; body: string } | undefined;
  const fetch: Fetch = async (url, init) => {
    seen = { url, headers: init.headers, body: String(init.body) };
    return reply('```json\n{"steps": {"body": {"reach": "guest", "requested": "no"}, "send": {"reach": "outside_guest", "requested": "no"}}}\n```')(url, init);
  };
  let clock = 0;
  const client = new OnlineCheckClient(config, { env: { TEST_KEY: "k" }, fetch, now: () => (clock += 40) });
  const check = await client.checkPlan(plan);
  assert.deepEqual(check.steps.map(step => [step.id, step.needsApproval, step.why]), [["body", false, undefined], ["send", true, "outside_guest"], ["close", true, "doubt"]],
    "A step the reply leaves out is doubt");
  assert.deepEqual([check.failure, check.roundTripMs, check.inputTokens, check.outputTokens], [undefined, 40, 300, 20]);
  assert.deepEqual([seen?.url, seen?.headers.authorization, JSON.parse(seen!.body).model], [config.url, "Bearer k", "deepseek-flash"]);
});

test("a failed check makes every step need approval, and only cancellation throws", async () => {
  const client = (fetch: Fetch, env: NodeJS.ProcessEnv = { TEST_KEY: "k" }) => new OnlineCheckClient(config, { env, fetch });
  const failures: [OnlineCheckClient, RegExp][] = [
    [client(reply("not json")), /reply is not a JSON object/],
    [client(reply('["guest"]')), /reply is not a JSON object/],
    [client(async () => ({ ok: true, status: 200, text: async () => "<html>" })), /response is not JSON/],
    [client(reply("{}", 502)), /returned HTTP 502/],
    [client(async () => { throw new Error("connection refused"); }), /unreachable: connection refused/],
    [client(reply("{}"), {}), /key variable TEST_KEY is not set/],
  ];
  for (const [each, failure] of failures) {
    const check = await each.checkPlan(plan);
    assert.match(check.failure ?? "", failure);
    assert.deepEqual(check.steps.map(step => [step.needsApproval, step.why]), plan.steps.map(() => [true, "doubt"]), String(failure));
  }
  const slow = new OnlineCheckClient({ ...config, timeoutMs: 20 }, { env: { TEST_KEY: "k" }, fetch: (_url, init) => new Promise((_, reject) =>
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")))) });
  assert.match((await slow.checkPlan(plan)).failure ?? "", /did not answer within 20 ms/);
  const cancelled = new AbortController();
  const pending = slow.checkPlan(plan, cancelled.signal);
  cancelled.abort();
  await assert.rejects(pending, (error: DecisionServiceError) => error instanceof DecisionServiceError && error.code === "aborted");
});
