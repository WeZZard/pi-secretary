import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
type AgentMessage = ContextEvent["messages"][number];
import {
  canonicalJson, compose, isRequestContextMessage, RequestContextComposer,
  REQUEST_CONTEXT_CUSTOM_TYPE, REQUEST_CONTEXT_MAX_BYTES,
  type JsonValue, type RequestContext,
} from "../../extensions/secretary/context/index.ts";

function request(overrides: Partial<RequestContext> = {}): RequestContext {
  return { sessionId: "session", activationEpoch: 1, requestId: "request", signal: new AbortController().signal, ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function payload(content: string | undefined) {
  assert.ok(content);
  return JSON.parse(content.slice("<secretary-runtime-state>".length, -"</secretary-runtime-state>".length));
}

test("multiple synthetic contributors are ordered by integer order then code-unit id, and omitted explicitly", async () => {
  const composer = new RequestContextComposer();
  const captureOrder: string[] = [];
  for (const [id, order] of [["test:z", 2], ["test:a", 2], ["test:Z", 2], ["test:first", -1]] as const) {
    composer.register({ id, order, capture: async (ctx) => { captureOrder.push(id); assert.equal(ctx.requestId, "request"); return { z: 2, a: 1 }; }, project: (value) => value });
  }
  composer.register({ id: "test:omitted", order: 1, capture: async () => undefined, project: () => { throw new Error("must not project"); } });
  const result = await composer.prepare(request());
  assert.deepEqual(captureOrder, ["test:first", "test:Z", "test:a", "test:z"]);
  assert.equal(result.status, "ready");
  assert.equal(result.contributions.get("test:omitted")?.status, "omitted");
  assert.deepEqual(payload(result.content).contributions.map((c: { id: string }) => c.id), captureOrder);
  assert.deepEqual(result.getSnapshot<{ z: number }>("test:z"), { z: 2, a: 1 });
  assert.doesNotMatch(result.content!, /session|requestId|activationEpoch/);
});

test("empty and inapplicable registries produce zero envelopes; duplicate registration and stale unregister are safe", async () => {
  const composer = new RequestContextComposer();
  assert.equal((await composer.prepare(request())).content, undefined);
  const contributor = { id: "test:empty", order: 0, capture: async () => undefined, project: () => null };
  const unregister = composer.register(contributor);
  assert.throws(() => composer.register(contributor), /duplicate_contributor/);
  assert.throws(() => composer.register({ ...contributor, id: "unscoped" }), /invalid_contributor/);
  assert.throws(() => composer.register({ ...contributor, order: 0.5 }), /invalid_contributor/);
  unregister();
  composer.register(contributor);
  unregister();
  const result = await composer.prepare(request());
  assert.equal(result.contributions.size, 1);
  assert.equal(result.content, undefined);
  assert.deepEqual(compose([], result), []);
});

test("canonical serializer sorts numeric keys lexically, retains arrays and escapes delimiters and physical newlines", () => {
  assert.equal(canonicalJson({ z: [2, 1], "2": true, "10": null, a: "</secretary-runtime-state>&\n\u2028\u2029" }),
    '{"10":null,"2":true,"a":"\\u003c/secretary-runtime-state\\u003e\\u0026\\n\\u2028\\u2029","z":[2,1]}');
  const shared = { x: 1 };
  assert.equal(canonicalJson([shared, shared]), '[{"x":1},{"x":1}]');
  assert.equal(canonicalJson(Object.assign(Object.create(null), { "__proto__": 1, a: true })), '{"a":true}');
  assert.equal(canonicalJson(-0), "0");
});

test("strict serializer rejects lossy or executable JSON without invoking accessors or toJSON", () => {
  let invoked = false;
  const accessor = Object.defineProperty({}, "x", { enumerable: true, get() { invoked = true; return 1; } });
  const cycle: unknown[] = []; cycle.push(cycle);
  const sparse = new Array(1);
  const extra = Object.assign([1], { extra: 2 });
  const invalid: unknown[] = [undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol("secret"), new Date(),
    new Map(), new Set(), { x: undefined }, [undefined], accessor, cycle, sparse, extra,
    { toJSON() { invoked = true; return "secret"; } }, { [Symbol("secret")]: 1 },
    Object.defineProperty({}, "hidden", { value: 1 })];
  for (const value of invalid) assert.throws(() => canonicalJson(value as JsonValue), /invalid_json/);
  assert.equal(invoked, false);
});

test("composition is deterministic, pure and idempotent and removes only owned metadata", async () => {
  const composer = new RequestContextComposer();
  composer.register({ id: "test:data", order: 1, capture: async () => ({ x: "<&>" }), project: (s) => s });
  const result = await composer.prepare(request());
  const again = await composer.prepare(request({ requestId: "different" }));
  assert.equal(result.content, again.content);
  const history: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: result.content! }, { type: "image", mimeType: "image/png", data: "AA==" }], timestamp: 1 },
    { role: "custom", customType: REQUEST_CONTEXT_CUSTOM_TYPE, content: "unowned", display: false, timestamp: 2 },
    { role: "custom", customType: "other:projection", content: "other", details: { owner: "secretary.request-context", version: 1 }, display: false, timestamp: 3 },
  ];
  const saved = structuredClone(history);
  const messages = composer.compose(history, result);
  assert.deepEqual(history, saved);
  assert.equal(messages.length, history.length + 1);
  assert.deepEqual(compose(messages, result), messages);
  assert.equal(messages.filter(isRequestContextMessage).length, 1);
  assert.equal(messages[0], history[0]);
  const empty = await new RequestContextComposer().prepare(request());
  assert.deepEqual(compose(messages, empty), history);
});

test("plain snapshots are detached and deeply frozen while opaque owned state stays contributor-owned", async () => {
  const composer = new RequestContextComposer();
  const original = { nested: { value: 1 }, array: [1] };
  composer.register({ id: "test:plain", order: 0, capture: async () => original, project: (s) => s });
  const first = await composer.prepare(request());
  const snapshot = first.getSnapshot<typeof original>("test:plain")!;
  assert.notEqual(snapshot, original);
  assert.ok(Object.isFrozen(snapshot.nested));
  assert.throws(() => { snapshot.nested.value = 2; }, TypeError);
  original.nested.value = 2;
  original.array.push(2);
  assert.equal(snapshot.nested.value, 1);
  assert.deepEqual(snapshot.array, [1]);
  assert.equal(payload(first.content).contributions[0].data.nested.value, 1);
  assert.notEqual((await composer.prepare(request())).content, first.content);
  const outcomes = first.contributions as Map<string, unknown>;
  outcomes.clear();
  assert.equal(first.contributions.size, 1);
});

test("capture, projection and invalid JSON failures use bounded codes and do not corrupt valid contributions", async () => {
  const composer = new RequestContextComposer();
  composer.register({ id: "test:capture", order: 0, capture: async () => { throw new Error("SECRET_CAPTURE"); }, project: () => null });
  composer.register({ id: "test:project", order: 1, capture: async () => ({ state: 1 }), project: () => { throw new Error("SECRET_PROJECT"); } });
  composer.register({ id: "test:json", order: 2, capture: async () => true, project: () => ({ x: undefined }) as unknown as JsonValue });
  composer.register({ id: "test:ready", order: 3, capture: async () => ({ data: 42 }), project: (s) => s });
  const result = await composer.prepare(request());
  assert.equal(result.status, "unavailable");
  assert.doesNotMatch(result.content!, /SECRET/);
  assert.deepEqual(payload(result.content).contributions, [
    { id: "test:capture", status: "unavailable", errorCode: "capture_failed" },
    { id: "test:project", status: "unavailable", errorCode: "projection_failed" },
    { id: "test:json", status: "unavailable", errorCode: "invalid_json" },
    { id: "test:ready", status: "ready", data: { data: 42 } },
  ]);
  assert.deepEqual(result.getSnapshot("test:project"), { state: 1 });
});

test("UTF-8 envelope bound includes wrapper and overflow publishes no partial contributions", async () => {
  const composer = new RequestContextComposer();
  let data = "";
  composer.register({ id: "test:size", order: 0, capture: async () => data, project: (s) => s });
  const overhead = Buffer.byteLength((await composer.prepare(request())).content!, "utf8");
  data = "a".repeat(REQUEST_CONTEXT_MAX_BYTES - overhead);
  assert.equal(Buffer.byteLength((await composer.prepare(request())).content!, "utf8"), REQUEST_CONTEXT_MAX_BYTES);
  data += "é";
  const result = await composer.prepare(request());
  assert.equal(result.status, "unavailable");
  assert.equal(result.errorCode, "overflow");
  assert.deepEqual(payload(result.content), { version: 1, status: "unavailable", errorCode: "overflow" });
  assert.equal(result.contributions.get("test:size")?.status, "ready");
});

test("abort settles without waiting for an uncooperative capture and never projects its late result", async () => {
  const composer = new RequestContextComposer();
  const late = deferred<object>();
  let projected = false;
  let signal!: AbortSignal;
  composer.register({ id: "test:slow", order: 0, capture: (ctx) => { signal = ctx.signal; return late.promise; }, project: () => { projected = true; return null; } });
  const controller = new AbortController();
  const pending = composer.prepare(request({ signal: controller.signal }));
  controller.abort(new Error("SECRET_ABORT"));
  const result = await pending;
  assert.equal(result.errorCode, "cancelled");
  assert.ok(signal.aborted);
  late.resolve({ stale: true });
  await Promise.resolve();
  assert.equal(projected, false);
  assert.equal(result.getSnapshot("test:slow"), undefined);
  assert.doesNotMatch(result.content!, /SECRET_ABORT|stale/);
});

test("activation replacement discards late work; request records and retries remain independent", async () => {
  const composer = new RequestContextComposer();
  const slow = deferred<string>();
  let captures = 0;
  composer.register({ id: "test:state", order: 0, capture: async (ctx) => { captures++; return ctx.sessionId === "old" ? slow.promise : ctx.requestId; }, project: (s) => s });
  const old = composer.prepare(request({ sessionId: "old" }));
  const current = await composer.prepare(request({ sessionId: "new", activationEpoch: 2, requestId: "new-request" }));
  assert.equal((await old).errorCode, "invalidated");
  slow.resolve("STALE");
  const retry = compose([], current);
  assert.deepEqual(compose([], current), retry);
  assert.equal(captures, 2);
  const next = await composer.prepare(request({ sessionId: "new", activationEpoch: 2, requestId: "next" }));
  assert.equal(current.getSnapshot("test:state"), "new-request");
  assert.equal(next.getSnapshot("test:state"), "next");
  assert.doesNotMatch(current.content!, /STALE/);
});

test("invalidate and dispose are idempotent, cancel pending work, and disposal forbids new registration", async () => {
  for (const operation of ["invalidate", "dispose"] as const) {
    const composer = new RequestContextComposer();
    const late = deferred<null>();
    composer.register({ id: "test:pending", order: 0, capture: () => late.promise, project: () => null });
    const pending = composer.prepare(request());
    composer[operation]();
    composer[operation]();
    const result = await pending;
    assert.equal(result.errorCode, operation === "dispose" ? "disposed" : "invalidated");
    late.reject(new Error("SECRET_LATE_REJECTION"));
    await Promise.resolve();
    if (operation === "dispose") {
      assert.equal((await composer.prepare(request())).errorCode, "disposed");
      assert.throws(() => composer.register({ id: "test:new", order: 0, capture: async () => 1, project: (s) => s }), /disposed/);
    }
  }
});

test("already aborted requests never invoke captures and preparation identity cannot be changed by caller", async () => {
  const composer = new RequestContextComposer();
  let calls = 0;
  const wait = deferred<string>();
  composer.register({ id: "test:identity", order: 0, capture: async () => { calls++; return wait.promise; }, project: (s) => s });
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await composer.prepare(request({ signal: aborted.signal }))).errorCode, "cancelled");
  assert.equal(calls, 0);
  const input = { ...request() };
  const pending = composer.prepare(input);
  input.requestId = "mutated";
  wait.resolve("value");
  assert.equal((await pending).requestId, "request");
});

test("concurrent requests in one activation retain their own captures despite reversed completion", async () => {
  const composer = new RequestContextComposer();
  const first = deferred<string>();
  const second = deferred<string>();
  composer.register({ id: "test:concurrent", order: 0,
    capture: (ctx) => ctx.requestId === "first" ? first.promise : second.promise, project: (s) => s });
  const a = composer.prepare(request({ requestId: "first" }));
  const b = composer.prepare(request({ requestId: "second" }));
  second.resolve("second-snapshot");
  const preparedB = await b;
  first.resolve("first-snapshot");
  const preparedA = await a;
  assert.equal(preparedA.getSnapshot("test:concurrent"), "first-snapshot");
  assert.equal(preparedB.getSnapshot("test:concurrent"), "second-snapshot");
  assert.equal(preparedA.status, "ready");
  assert.equal(preparedB.status, "ready");
});

test("composition serialization failure is bounded even when wrapper depth exceeds the JSON limit", async () => {
  const composer = new RequestContextComposer();
  let nested: JsonValue = 1;
  for (let index = 0; index < 128; index++) nested = [nested];
  composer.register({ id: "test:deep", order: 0, capture: async () => true, project: () => nested });
  const result = await composer.prepare(request());
  assert.equal(result.status, "unavailable");
  assert.equal(result.errorCode, "invalid_json");
  assert.equal(result.getSnapshot("test:deep"), undefined);
  assert.deepEqual(payload(result.content), { version: 1, status: "unavailable", errorCode: "invalid_json" });
});

test("registration snapshots callbacks and same-session epoch replacement cancels pending captures", async () => {
  const composer = new RequestContextComposer();
  const late = deferred<string>();
  const contributor = { id: "test:registered", order: 0,
    capture: async (ctx: RequestContext) => ctx.activationEpoch === 1 ? late.promise : "fresh",
    project: (s: string) => s };
  composer.register(contributor);
  contributor.project = () => "MUTATED";
  const old = composer.prepare(request());
  const fresh = await composer.prepare(request({ activationEpoch: 2 }));
  assert.equal((await old).errorCode, "invalidated");
  assert.equal(payload(fresh.content).contributions[0].data, "fresh");
  late.resolve("STALE");
});
