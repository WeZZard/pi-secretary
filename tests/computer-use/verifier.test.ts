import assert from "node:assert/strict";
import { test } from "node:test";
import type { WindowRead } from "../../extensions/secretary/computer-use/backend/backend.ts";
import { evaluatePostcondition, isWeakPostcondition, validatePostcondition, visibleSignature } from "../../extensions/secretary/computer-use/verifier.ts";
import { textEditRead } from "./fixtures/trees.ts";

const read = (): WindowRead => ({ ...textEditRead(), readMs: 0 });

test("exists and absent count only on-screen elements, so a closed menu item never satisfies them", () => {
  const after = read();
  assert.equal(evaluatePostcondition({ exists: { name: "Save…" } }, after).holds, false, "The closed File menu's Save item has no frame");
  assert.equal(evaluatePostcondition({ absent: { name: "save…" } }, after).holds, true);
  assert.equal(evaluatePostcondition({ exists: { name: "disposable  document text", role: "TextArea" } }, after).holds, true);
  assert.equal(evaluatePostcondition({ exists: { name: "Disposable document text", role: "AXButton" } }, after).holds, false);
});

test("value compares exactly, and names also come from descendant text", () => {
  const after = read();
  assert.equal(evaluatePostcondition({ value: { name: "Disposable document text", equals: "Disposable document text" } }, after).holds, true);
  const wrong = evaluatePostcondition({ value: { name: "Disposable document text", equals: "Other" } }, after);
  assert.deepEqual(wrong, { holds: false, detail: "\"Disposable document text\" has value \"Disposable document text\"" });
  after.descendantText = { 6: "Close" };
  assert.equal(evaluatePostcondition({ exists: { name: "Close", role: "Button" } }, after).holds, true);
});

test("changed compares the visible tree, and combinators nest", () => {
  const before = read(), same = read(), moved = read();
  moved.elements.find(element => element.role === "AXTextArea")!.value = "Edited";
  assert.equal(evaluatePostcondition({ changed: true }, same, before).holds, false);
  assert.equal(evaluatePostcondition({ changed: true }, moved, before).holds, true);
  assert.equal(evaluatePostcondition({ changed: true }, moved).holds, false, "Without a before-tree, change is not assumed");
  assert.equal(visibleSignature(before), visibleSignature(same));
  assert.equal(evaluatePostcondition({ all: [{ window: { titleContains: "SCRATCH" } }, { any: [{ exists: { name: "Nope" } }, { changed: true }] }] }, moved, before).holds, true);
  assert.equal(isWeakPostcondition({ changed: true }), true);
  assert.equal(isWeakPostcondition({ exists: { name: "A" } }), false);
});

test("malformed postconditions are rejected with a reason before any action", () => {
  assert.equal(validatePostcondition({ all: [{ exists: { name: "Save" } }, { value: { name: "Title", equals: "" } }] }), undefined);
  assert.match(validatePostcondition({ focused: { name: "Title" } })!, /not supported/);
  assert.match(validatePostcondition({ exists: { name: "" } })!, /needs a name/);
  assert.match(validatePostcondition({ exists: { name: "A" }, absent: { name: "B" } })!, /exactly one predicate/);
  assert.match(validatePostcondition({ any: [] })!, /non-empty list/);
  assert.match(validatePostcondition({ all: [{ changed: false }] })!, /all\[0\]: changed must be true/);
  assert.match(validatePostcondition({ exists: { name: "A", colour: "red" } })!, /needs a name/);
  let deep: unknown = { changed: true };
  for (let i = 0; i < 10; i++) deep = { all: [deep] };
  assert.match(validatePostcondition(deep)!, /deeper than 8/);
});
