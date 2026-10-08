import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { defaultVmUseConfiguration, loadVmUseConfiguration, observationAvailable, planExecutionAvailable } from "../../extensions/secretary/vm-use/configuration.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "secretary-vm-use-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), agentDir = join(root, "user");
  const put = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  return { cwd, agentDir, global: join(agentDir, "secretary.json"), project: join(cwd, CONFIG_DIR_NAME, "secretary.json"), put };
}

test("defaults leave vm-use unavailable, and agents configuration is ignored", (t) => {
  const { cwd, agentDir, global, put } = fixture(t);
  assert.deepEqual(loadVmUseConfiguration(cwd, agentDir, true), defaultVmUseConfiguration());
  put(global, { agents: { unknownAgentField: true } });
  const config = loadVmUseConfiguration(cwd, agentDir, true);
  assert.equal(observationAvailable(config), false);
  assert.equal(planExecutionAvailable(config), false);
});

test("trusted project configuration overrides global fields one by one", (t) => {
  const { cwd, agentDir, global, project, put } = fixture(t);
  put(global, { vmUse: { backend: "relay", relayImage: "macos26", maxElements: 100, settleMs: 500 } });
  put(project, { vmUse: { settleMs: 50, executorUrl: "http://jev.home.arpa" } });
  const untrusted = loadVmUseConfiguration(cwd, agentDir, false);
  assert.equal(untrusted.settleMs, 500);
  assert.equal(planExecutionAvailable(untrusted), false);
  const trusted = loadVmUseConfiguration(cwd, agentDir, true);
  assert.deepEqual([trusted.maxElements, trusted.settleMs, trusted.executorUrl], [100, 50, "http://jev.home.arpa"]);
  assert.equal(observationAvailable(trusted), true);
  assert.equal(planExecutionAvailable(trusted), true);
});

test("unknown fields, invalid values, and the removed local backend are rejected", (t) => {
  const { cwd, agentDir, global, put } = fixture(t);
  put(global, { vmUse: { backnd: "relay" } });
  assert.throws(() => loadVmUseConfiguration(cwd, agentDir, false), /unsupported vmUse field backnd/);
  put(global, { vmUse: { confidenceGate: 1.5 } });
  assert.throws(() => loadVmUseConfiguration(cwd, agentDir, false), /vmUse.confidenceGate must be a number from 0 to 1/);
  // Design §11.4 (decisions PS-D32 and PS-D39): the grounder chooses each action; configuration cannot choose the input.
  put(global, { vmUse: { inputMode: "ordinary" } });
  assert.throws(() => loadVmUseConfiguration(cwd, agentDir, false), /unsupported vmUse field inputMode/);
  // Decision PS-D53: the guardian's settings are gone.
  for (const field of ["permissionMode", "permissionGate", "permissionThink"]) {
    put(global, { vmUse: { [field]: field === "permissionMode" ? "bypass" : 0.8 } });
    assert.throws(() => loadVmUseConfiguration(cwd, agentDir, false), new RegExp(`unsupported vmUse field ${field}`));
  }
  put(global, { vmUse: {} });
  assert.equal(loadVmUseConfiguration(cwd, agentDir, false).approvalTimeoutMs, 300_000);
  put(global, { vmUse: { executorUrl: "jev.home.arpa" } });
  assert.throws(() => loadVmUseConfiguration(cwd, agentDir, false), /must be an http or https URL/);
  // Decision PS-D49: there is no local backend.
  put(global, { vmUse: { backend: "local" } });
  assert.throws(() => loadVmUseConfiguration(cwd, agentDir, false), /vmUse.backend must be none or relay/);
  put(global, { vmUse: { allowLocalDesktop: true } });
  assert.throws(() => loadVmUseConfiguration(cwd, agentDir, false), /unsupported vmUse field allowLocalDesktop/);
});

test("the relay client needs an image key and defaults to the adapter's relay server command", (t) => {
  const { cwd, agentDir, global, put } = fixture(t);
  put(global, { vmUse: { backend: "relay" } });
  assert.throws(() => loadVmUseConfiguration(cwd, agentDir, true), /needs vmUse.relayImage/);
  put(global, { vmUse: { backend: "relay", relayImage: "macos26", relayEnv: "default" } });
  const config = loadVmUseConfiguration(cwd, agentDir, true);
  assert.deepEqual([config.relayImage, config.relayEnv, config.relayTtlHours], ["macos26", "default", 2]);
  assert.deepEqual(config.relayCommand, ["npx", "-y", "--prefer-offline", "@wezzard/mcp-vm-relay@0.11.0"]);
  put(global, { vmUse: { backend: "relay", relayImage: "macos26", relayCommand: [] } });
  assert.throws(() => loadVmUseConfiguration(cwd, agentDir, true), /relayCommand must be a non-empty array/);
});

test("the permission check mode is none or online, and online needs the online API (design §4.5, decision PS-D53)", (t) => {
  const { cwd, agentDir, global, put } = fixture(t);
  assert.equal(defaultVmUseConfiguration().permissionCheck, "none");
  assert.equal(defaultVmUseConfiguration().permissionOnline, undefined);
  for (const mode of ["off", "subagent", "guardian"]) {
    put(global, { vmUse: { permissionCheck: mode } });
    assert.throws(() => loadVmUseConfiguration(cwd, agentDir, false), /vmUse.permissionCheck must be none or online/, mode);
  }
  put(global, { vmUse: { permissionCheck: "online" } });
  assert.throws(() => loadVmUseConfiguration(cwd, agentDir, false), /vmUse.permissionCheck online needs vmUse.permissionOnline/);
  for (const online of [{ url: "http://api.home.arpa/v1/chat/completions" }, { url: "api.home.arpa", model: "m" }, { url: "http://a/", model: "m", apiKey: "secret" },
    { url: "http://a/", model: "m", apiKeyEnv: "NOT A NAME" }]) {
    put(global, { vmUse: { permissionOnline: online } });
    assert.throws(() => loadVmUseConfiguration(cwd, agentDir, false), /vmUse.permissionOnline must be an object with url/, JSON.stringify(online));
  }
  put(global, { vmUse: { permissionCheck: "none", permissionOnline: { url: "http://api.home.arpa/v1/chat/completions", model: "deepseek-flash", apiKeyEnv: "LITELLM_MASTER_KEY" } } });
  const loaded = loadVmUseConfiguration(cwd, agentDir, false);
  assert.deepEqual([loaded.permissionCheck, loaded.permissionOnline], ["none",
    { timeoutMs: 30_000, url: "http://api.home.arpa/v1/chat/completions", model: "deepseek-flash", apiKeyEnv: "LITELLM_MASTER_KEY" }]);
  put(global, { vmUse: { permissionCheck: "online", permissionOnline: { url: "http://api.home.arpa/v1/chat/completions", model: "deepseek-flash" } } });
  assert.equal(loadVmUseConfiguration(cwd, agentDir, false).permissionCheck, "online");
});
