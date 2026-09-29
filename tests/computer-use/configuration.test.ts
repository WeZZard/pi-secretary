import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { defaultComputerUseConfiguration, loadComputerUseConfiguration, observationAvailable, planExecutionAvailable } from "../../extensions/secretary/computer-use/configuration.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "secretary-computer-use-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), agentDir = join(root, "user");
  const put = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  return { cwd, agentDir, global: join(agentDir, "secretary.json"), project: join(cwd, CONFIG_DIR_NAME, "secretary.json"), put };
}

test("defaults leave computer use unavailable, and agents configuration is ignored", (t) => {
  const { cwd, agentDir, global, put } = fixture(t);
  assert.deepEqual(loadComputerUseConfiguration(cwd, agentDir, true), defaultComputerUseConfiguration());
  put(global, { agents: { unknownAgentField: true } });
  const config = loadComputerUseConfiguration(cwd, agentDir, true);
  assert.equal(observationAvailable(config), false);
  assert.equal(planExecutionAvailable(config), false);
});

test("trusted project configuration overrides global fields one by one", (t) => {
  const { cwd, agentDir, global, project, put } = fixture(t);
  put(global, { computerUse: { backend: "local", allowLocalDesktop: true, maxElements: 100, settleMs: 500 } });
  put(project, { computerUse: { settleMs: 50, executorUrl: "http://jev.home.arpa" } });
  const untrusted = loadComputerUseConfiguration(cwd, agentDir, false);
  assert.equal(untrusted.settleMs, 500);
  assert.equal(planExecutionAvailable(untrusted), false);
  const trusted = loadComputerUseConfiguration(cwd, agentDir, true);
  assert.deepEqual([trusted.maxElements, trusted.settleMs, trusted.executorUrl], [100, 50, "http://jev.home.arpa"]);
  assert.equal(observationAvailable(trusted), true);
  assert.equal(planExecutionAvailable(trusted), true);
});

test("unknown fields, invalid values, and an unacknowledged local desktop are rejected", (t) => {
  const { cwd, agentDir, global, put } = fixture(t);
  put(global, { computerUse: { backnd: "local" } });
  assert.throws(() => loadComputerUseConfiguration(cwd, agentDir, false), /unsupported computerUse field backnd/);
  put(global, { computerUse: { confidenceGate: 1.5 } });
  assert.throws(() => loadComputerUseConfiguration(cwd, agentDir, false), /computerUse.confidenceGate must be a number from 0 to 1/);
  put(global, { computerUse: { inputMode: "accessibility" } });
  assert.throws(() => loadComputerUseConfiguration(cwd, agentDir, false), /computerUse.inputMode must be ordinary or accessibility-test/);
  put(global, { computerUse: { inputMode: "accessibility-test" } });
  assert.equal(loadComputerUseConfiguration(cwd, agentDir, false).inputMode, "accessibility-test");
  put(global, { computerUse: { permissionMode: "never" } });
  assert.throws(() => loadComputerUseConfiguration(cwd, agentDir, false), /computerUse.permissionMode must be ask, auto, or bypass/);
  put(global, { computerUse: { permissionThink: 1.5 } });
  assert.throws(() => loadComputerUseConfiguration(cwd, agentDir, false), /computerUse.permissionThink/);
  put(global, { computerUse: { permissionMode: "bypass", permissionGate: 0.8 } });
  assert.deepEqual((({ permissionMode, permissionGate, permissionThink, approvalTimeoutMs }) => ({ permissionMode, permissionGate, permissionThink, approvalTimeoutMs }))(loadComputerUseConfiguration(cwd, agentDir, false)),
    { permissionMode: "bypass", permissionGate: 0.8, permissionThink: 256, approvalTimeoutMs: 300_000 });
  put(global, { computerUse: { executorUrl: "jev.home.arpa" } });
  assert.throws(() => loadComputerUseConfiguration(cwd, agentDir, false), /must be an http or https URL/);
  put(global, { computerUse: { backend: "local" } });
  assert.throws(() => loadComputerUseConfiguration(cwd, agentDir, false), /allowLocalDesktop/);
});

test("the relay client needs an image key and defaults to the adapter's relay server command", (t) => {
  const { cwd, agentDir, global, put } = fixture(t);
  put(global, { computerUse: { backend: "relay" } });
  assert.throws(() => loadComputerUseConfiguration(cwd, agentDir, true), /needs computerUse.relayImage/);
  put(global, { computerUse: { backend: "relay", relayImage: "macos26", relayEnv: "default" } });
  const config = loadComputerUseConfiguration(cwd, agentDir, true);
  assert.deepEqual([config.relayImage, config.relayEnv, config.relayTtlHours], ["macos26", "default", 2]);
  assert.deepEqual(config.relayCommand, ["npx", "-y", "--prefer-offline", "@wezzard/mcp-vm-relay@0.6.2"]);
  put(global, { computerUse: { backend: "relay", relayImage: "macos26", relayCommand: [] } });
  assert.throws(() => loadComputerUseConfiguration(cwd, agentDir, true), /relayCommand must be a non-empty array/);
});
