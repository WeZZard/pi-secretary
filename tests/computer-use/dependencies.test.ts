import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../../extensions/secretary");
const moduleRoot = join(root, "computer-use");
const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
});

test("the computer-use module depends on neither the subagent, goal, nor composition modules (design §4.2)", () => {
  for (const path of sources(moduleRoot)) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith(".")) {
        const target = resolve(dirname(path), node.moduleSpecifier.text);
        assert.ok(existsSync(target), `Unresolved import ${node.moduleSpecifier.text} from ${path}`);
        assert.ok(!relative(moduleRoot, target).startsWith(".."), `${relative(root, path)} imports ${relative(root, target)} outside the computer-use module`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

test("the subagent module does not know the computer-use tools (subagent architecture §11)", () => {
  for (const path of sources(join(root, "agents"))) {
    const text = readFileSync(path, "utf8");
    assert.ok(!/computer[-_](use|observe|run_plan)/.test(text), `${relative(root, path)} names a computer-use capability`);
  }
});
