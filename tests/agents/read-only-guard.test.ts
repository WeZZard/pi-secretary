import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectBashCommand, isReadOnly } from "../../extensions/secretary/agents/read-only-guard.ts";

/**
 * The read-only contract for the packaged `Explore`/`Plan` pair (architecture §5.2) is a tool
 * denylist plus a prompt, and `bash` is retained because it is pi's only search mechanism. These
 * cases pin the *guard* that backs the prompt: what it recognizes as a write, and just as
 * importantly what it must leave alone so read-only agents can still do their job.
 *
 * The last group documents the guard's stated limits. Those cases assert the current, accepted
 * behaviour rather than an absence of risk: they are why no surface may call a read-only
 * subagent sandboxed.
 */

function refuses(command: string): string {
  const reason = inspectBashCommand(command);
  assert.ok(reason !== undefined, `Expected a refusal for: ${command}`);
  return reason;
}

function allows(command: string): void {
  assert.equal(inspectBashCommand(command), undefined, `Expected no refusal for: ${command}`);
}

test("filesystem redirection is refused, including through pipes and wrappers", () => {
  assert.match(refuses("echo hi > out.txt"), /redirects output into out\.txt/);
  assert.match(refuses("echo hi >> out.txt"), /redirects output into out\.txt/);
  assert.match(refuses("echo hi 2> err.txt"), /redirects output into err\.txt/);
  assert.match(refuses("cat a > b"), /redirects output into b/);
  assert.match(refuses("cat a &> b"), /redirects output into b/);
  assert.match(refuses("git log | tee out.txt"), /it runs tee/);
});

test("sinks and descriptor duplications are not writes", () => {
  allows("echo hi > /dev/null");
  allows("echo hi 2>&1");
  allows("echo hi >/dev/null 2>&1");
  allows('echo "the arrow -> is quoted"');
});

test("destructive commands are refused, including by absolute path and behind a wrapper", () => {
  assert.match(refuses("rm -rf build"), /it runs rm/);
  assert.match(refuses("/bin/rm build"), /it runs rm/);
  assert.match(refuses("sudo rm -rf /tmp/x"), /it runs rm/);
  assert.match(refuses("FOO=1 rm build"), /it runs rm/);
  assert.match(refuses("mkdir -p x"), /it runs mkdir/);
  assert.match(refuses("cp a b"), /it runs cp/);
  assert.match(refuses("mv a b"), /it runs mv/);
  assert.match(refuses("touch f"), /it runs touch/);
  assert.match(refuses("truncate -s 0 f"), /it runs truncate/);
  assert.match(refuses("chmod +x f"), /it runs chmod/);
  assert.match(refuses("cat a | tee b"), /it runs tee/);
});

test("in-place editors are refused while their filtering modes are allowed", () => {
  assert.match(refuses("sed -i '' 's/a/b/' f"), /edits in place with sed -i/);
  assert.match(refuses("sed -i.bak 's/a/b/' f"), /edits in place with sed -i/);
  assert.match(refuses("perl -pi -e 's/a/b/' f"), /edits in place with perl -i/);
  allows("sed -n '1,10p' file");
  allows("sed 's/a/b/' file");
  allows("perl -pe 's/a/b/' file");
});

test("downloads are refused when they write a file", () => {
  assert.match(refuses("curl -o f https://x"), /downloads to a file with curl/);
  assert.match(refuses("curl -O https://x/y"), /downloads to a file with curl/);
  assert.match(refuses("wget https://x"), /wget, which writes a file by default/);
  allows("curl -s https://x");
  allows("wget -O- https://x");
});

test("git is judged by subcommand, so searching and inspecting stay available", () => {
  allows("git log --oneline -5");
  allows("git diff");
  allows("git status --short");
  allows("git show HEAD:src/a.ts");
  allows("git cat-file -p HEAD");
  allows("git rev-parse --show-toplevel");
  allows("git grep -n symbol");
  allows("git branch -a");
  allows("git remote -v");
  allows("git stash list");
  allows("git config --get user.name");
  allows("git log | head -20");
  assert.match(refuses("git add ."), /it runs git add/);
  assert.match(refuses("git commit -m x"), /it runs git commit/);
  assert.match(refuses("git push"), /it runs git push/);
  assert.match(refuses("git checkout main"), /it runs git checkout/);
  assert.match(refuses("git branch new"), /it runs git branch new/);
  assert.match(refuses("git stash"), /it runs git stash/);
  assert.match(refuses("git config user.name x"), /it runs git config/);
  assert.match(refuses("git -C /repo commit -m x"), /it runs git commit/);
});

test("package managers, build tools and find actions are refused", () => {
  assert.match(refuses("npm install"), /npm install, which writes/);
  assert.match(refuses("yarn add lodash"), /yarn add, which writes/);
  assert.match(refuses("pip install requests"), /pip install, which writes/);
  assert.match(refuses("cargo add serde"), /cargo add, which writes/);
  assert.match(refuses("make"), /it runs make/);
  assert.match(refuses("find . -delete"), /find to modify or execute/);
  assert.match(refuses("find . -exec rm {} ;"), /find to modify or execute/);
  allows("npm ls");
  allows("pip list");
  allows("cargo tree");
  allows("find . -name '*.ts'");
});

test("ordinary read-only searching is left alone", () => {
  allows("ls -la");
  allows("cat file");
  allows("wc -l file");
  allows("grep -rn 'needle' src");
  allows("rg --files");
  allows("head -50 file");
  allows("git log | rg fix | head -5");
  allows("");
});

test("the guard's stated limits: constructs it does not recognize still reach the filesystem", () => {
  // Recorded so the limitation is explicit and reviewed, not discovered later. Each of these can
  // write, and none is refused. This is why the read-only pair is prompt-enforced plus guarded,
  // and never described as sandboxed.
  allows("python3 -c \"open('x','w').write('hi')\"");
  allows("node -e \"require('fs').writeFileSync('x','hi')\"");
  allows("awk 'BEGIN{print \"x\" > \"out\"}'");
  allows("kubectl get pods");
  allows("$EDITOR file");
});

test("only a definition that denies write is treated as read-only", () => {
  assert.equal(isReadOnly({ disallowedTools: ["edit", "write"] }), true);
  assert.equal(isReadOnly({ disallowedTools: ["edit"] }), false);
  assert.equal(isReadOnly({ disallowedTools: [] }), false);
  assert.equal(isReadOnly({}), false);
});
