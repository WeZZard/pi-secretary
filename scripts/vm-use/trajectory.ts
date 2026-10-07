/**
 * Serves the trajectory viewer (decisions PS-D17, PS-D18 and PS-D40, design §12.3) for every vm-use
 * agent in a run's artifact directory: the agent's session, extended with the extension's records
 * of each vm-use call and the machine steps those records name (decision PS-D40).
 *
 *   npm run dev:trajectory-viewer -- <artifact directory>      (PORT=8765 by default)
 *
 * It reads the agents' session files under extension-state/agents/, their records under
 * extension-state/vm-use/, and the packages under relay-evidence/. It writes nothing.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TrajectoryInput } from "../../extensions/secretary/vm-use/trajectory.ts";
import { TrajectoryServer } from "../../extensions/secretary/vm-use/viewer/server.ts";

const VM_USE_TOOLS = /"name":"(?:vm|computer)_(observe|run_plan)"/;

/** Every vm-use agent's session file under `artifacts`, with its agent identifier. */
export function vmUseSessions(artifacts: string): { agentId: string; session: string }[] {
  const agents = join(artifacts, "extension-state", "agents");
  if (!existsSync(agents)) return [];
  return readdirSync(agents).flatMap(parent => {
    const sessions = join(agents, parent, "sessions");
    return existsSync(sessions) ? readdirSync(sessions).flatMap(agentId => readdirSync(join(sessions, agentId))
      .filter(file => file.endsWith(".jsonl") && VM_USE_TOOLS.test(readFileSync(join(sessions, agentId, file), "utf8")))
      .map(file => ({ agentId, session: join(sessions, agentId, file) }))) : [];
  });
}

/** What the viewer needs to build each vm-use agent's trajectory in `artifacts`. */
export function trajectoryInputs(artifacts: string): TrajectoryInput[] {
  return vmUseSessions(artifacts).map(({ agentId, session }) => {
    const state = vmUseState(join(artifacts, "extension-state"), session);
    return { session, evidence: join(artifacts, "relay-evidence"), state, agentId };
  });
}

/** The command that serves the viewer for a run's artifact directory. */
export const viewerCommand = (artifacts: string) => `npm run dev:trajectory-viewer -- ${JSON.stringify(resolve(artifacts))}`;

/** The session's vm-use state directory, named as the extension names it (installation.ts). */
export function vmUseState(extensionState: string, session: string): string {
  const header = readFileSync(session, "utf8").split("\n", 1)[0] ?? "";
  const id = (() => { try { return (JSON.parse(header) as { id?: string }).id ?? ""; } catch { return ""; } })();
  const name = createHash("sha256").update(id).digest("hex");
  // Runs recorded before the rename keep their state under computer-use (decision PS-D48).
  const earlier = join(extensionState, "computer-use", name);
  return existsSync(earlier) && !existsSync(join(extensionState, "vm-use", name)) ? earlier : join(extensionState, "vm-use", name);
}

if (import.meta.main) {
  const artifacts = process.argv[2];
  if (!artifacts) { console.error("usage: trajectory.ts <artifact directory>"); process.exit(2); }
  const inputs = trajectoryInputs(resolve(artifacts));
  if (!inputs.length) { console.error(`No vm-use agent session under ${artifacts}.`); process.exit(1); }
  const server = new TrajectoryServer(Number(process.env.PORT ?? 8765));
  for (const input of inputs) console.log(await server.add(input.agentId!, input));
  // The server does not hold the process open by itself; this keeps it serving until interrupted.
  setInterval(() => {}, 1 << 30);
}
