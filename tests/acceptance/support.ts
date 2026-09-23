import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Parser, AstBuilder, GherkinClassicTokenMatcher, compile } from "@cucumber/gherkin";

export type AcceptanceScenario = ReturnType<typeof compile>[number];
export interface AcceptanceCase {
  t: TestContext;
  scenario: AcceptanceScenario;
  /** Expanded Given/When/Then text, including the current Examples row. */
  text: string;
}
export type ScenarioBindings = Record<string, (context: AcceptanceCase) => void | Promise<void>>;

/** Execute every compiled Gherkin example through a named, non-skipping scenario binding.
 * Frozen source hashes force review of the binding whenever the specification changes.
 * These are scenario-specific adapters, not a generic natural-language step interpreter.
 */
export function runFeatures(names: string[], bindings: ScenarioBindings, hashes: Record<string, string>): void {
  let id = 0;
  const parser = new Parser(new AstBuilder(() => String(++id)), new GherkinClassicTokenMatcher());
  const used = new Set<string>();
  for (const name of names) {
    const path = `docs/acceptance/${name}.feature`;
    const source = readFileSync(path, "utf8");
    test(`${name}: acceptance specification matches reviewed bindings`, () => {
      assert.equal(createHash("sha256").update(source).digest("hex"), hashes[name], "Specification changed: review scenario assertions before updating its binding hash.");
    });
    const scenarios = compile(parser.parse(source), path, () => String(++id));
    for (const scenario of scenarios) {
      const key = scenario.tags.find(tag => tag.name.startsWith("@ACC-SA-"))?.name.slice(1);
      if (!key) throw new Error(`Missing scenario identity: ${scenario.name}`);
      used.add(key);
      const text = scenario.steps.map(step => step.text).join("\n");
      test(`${key}: ${scenario.name} [${scenario.id}]`, async t => {
        assert.ok(bindings[key], `Missing executable binding for ${key}`);
        await bindings[key]({ t, scenario, text });
      });
    }
  }
  test(`${names.join(", ")}: all bindings name current scenarios`, () => {
    assert.deepEqual(new Set(Object.keys(bindings)), used);
  });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
