import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../../extensions/secretary");
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

test("agent runtime, type imports and storage have no transitive goal dependency", () => {
  const visited = new Set<string>();
  function visit(path: string, chain: string[]): void {
    assert.ok(!relative(root, path).split(/[\\/]/).includes("goal"), `Goal dependency: ${[...chain, path].join(" -> ")}`);
    if (visited.has(path)) return;
    visited.add(path);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    function walk(node: ts.Node): void {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) {
        const target = resolve(dirname(path), specifier.text);
        const dependency = [target, `${target}.ts`, join(target, "index.ts")].find(candidate => existsSync(candidate) && candidate.endsWith(".ts"));
        assert.ok(dependency, `Unresolved dependency ${specifier.text} from ${path}`);
        visit(dependency, [...chain, path]);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  for (const path of sources(join(root, "agents"))) visit(path, []);
  assert.ok(visited.has(join(root, "usage.ts")), "Usage must use the neutral contract");
});

test("agent public schemas and implementation do not carry goal policy", () => {
  for (const path of sources(join(root, "agents"))) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    function walk(node: ts.Node): void {
      if (ts.isIdentifier(node)) assert.ok(!/^(GoalOrigin|goal|goalId|resumeOrigin|controlGeneration|intentSeq)$/.test(node.text), `${path}: goal-specific identifier ${node.text}`);
      if (ts.isStringLiteral(node)) assert.ok(!/^(get_goal|create_goal|update_goal|clear_goal|secretary_goals)$/.test(node.text), `${path}: goal-specific capability or schema ${node.text}`);
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
});
