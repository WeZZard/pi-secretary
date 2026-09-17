import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { artifactDirectory } from "../../scripts/test-artifacts.ts";

const pythonEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
test("artifact replay allows ignored output or external directories but rejects source paths and symlinks", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "secretary-artifact-policy-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "secretary-external-output-")));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  mkdirSync(join(root, "docs")); mkdirSync(join(root, "test-results"));
  assert.equal(artifactDirectory(root, join(root, "test-results", "tui", "new-run")), join(root, "test-results", "tui", "new-run"));
  assert.equal(artifactDirectory(root, outside), outside);
  for (const path of [root, join(root, "docs", "report"), join(root, "tests", "fixtures", "report")]) assert.throws(() => artifactDirectory(root, path), /test-results/);
  symlinkSync(join(root, "docs"), join(root, "test-results", "alias"));
  assert.throws(() => artifactDirectory(root, join(root, "test-results", "alias", "report")), /test-results/);
});

test("Python recorder policy creates unique run directories and refuses overwriting or documentation output", () => {
  const source = `
import pathlib, tempfile, sys
sys.path.insert(0, ${JSON.stringify(resolve("scripts"))})
from test_artifacts import artifact_directory, reserve_recording_directory
with tempfile.TemporaryDirectory() as raw, tempfile.TemporaryDirectory() as external:
    root = pathlib.Path(raw).resolve()
    one = reserve_recording_directory(root)
    two = reserve_recording_directory(root)
    assert one != two and one.parent == root / 'test-results' / 'tui'
    assert (one / 'run-metadata.json').is_file()
    for target in [one, root / 'docs' / 'run', root / 'doc' / 'acceptance' / 'run', root]:
        try:
            reserve_recording_directory(root, target)
        except ValueError:
            pass
        else:
            raise AssertionError('Unsafe output accepted: ' + str(target))
    assert artifact_directory(root, external) == pathlib.Path(external).resolve()
    (root / 'docs').mkdir()
    (root / 'test-results' / 'alias').symlink_to(root / 'docs', target_is_directory=True)
    try:
        artifact_directory(root, root / 'test-results' / 'alias' / 'run')
    except ValueError:
        pass
    else:
        raise AssertionError('Source-directed symlink accepted')
print('policy passed')
`;
  assert.match(execFileSync("python3", ["-c", source], { encoding: "utf8", env: pythonEnv }), /policy passed/);
});

test("recording and replay reject documentation output before creating artifacts", () => {
  const target = "docs/__forbidden-test-output__";
  assert.equal(existsSync(target), false);
  const record = spawnSync("python3", ["scripts/record-agent-tui.py", "--output", target], { encoding: "utf8", env: pythonEnv });
  assert.notEqual(record.status, 0); assert.match(record.stderr, /test-results/);
  const replay = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/render-tui-recording.ts", target], { encoding: "utf8" });
  assert.notEqual(replay.status, 0); assert.match(replay.stderr, /test-results/);
  assert.equal(existsSync(target), false);
});

test("project artifact rules preserve reviewed baselines instead of ignoring their file extensions", () => {
  const ignores = readFileSync(".gitignore", "utf8");
  assert.match(ignores, /^\/test-results\/$/m);
  for (const suffix of ["json", "html", "png"]) assert.ok(!ignores.split("\n").includes(`*.${suffix}`));
  const ignored = spawnSync("git", ["check-ignore", "test-results/tui/example/result.json"], { encoding: "utf8" });
  assert.equal(ignored.status, 0);
  assert.match(readFileSync("CLAUDE.md", "utf8"), /intentional baselines/);
});
