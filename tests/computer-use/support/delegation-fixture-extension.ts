import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExecutionBackend } from "../../../extensions/secretary/computer-use/backend/backend.ts";
import type { Executor } from "../../../extensions/secretary/computer-use/harness.ts";
import { installComputerUse } from "../../../extensions/secretary/computer-use/installation.ts";

/**
 * Installs computer use with a test's fakes, and a stand-in for pi-mcp-adapter's direct `relay`
 * tool, which every session of the user's Pi has. Parent and child sessions load it; the child
 * finds it through the agent directory, as real Pi loads installed packages.
 */
export interface DelegationFixture { backend: ExecutionBackend; executor: Executor; root: string }

export default function delegationFixtureExtension(pi: ExtensionAPI) {
  const fixture = (globalThis as { computerUseDelegationFixture?: DelegationFixture }).computerUseDelegationFixture;
  if (!fixture) throw new Error("the delegation fixture is not set");
  const computerUse = installComputerUse(pi, { root: fixture.root, backendFactory: () => fixture.backend, executorFactory: () => fixture.executor });
  pi.registerTool({ name: "relay", label: "Relay", description: "Model-facing VM relay.", parameters: Type.Object({}),
    async execute() { throw new Error("a computer-use child must not reach the relay tool"); } });
  return computerUse;
}
