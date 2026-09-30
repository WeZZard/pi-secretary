/**
 * Serves the trajectory viewer (decisions PS-D17 and PS-D18, design §12.3) for every computer-use
 * agent in a run's artifact directory: the prompts, the agent's messages and tool calls, and each
 * call's machine steps.
 *
 *   npm run dev:trajectory-viewer -- <artifact directory>      (PORT=8765 by default)
 *
 * It reads the agents' session files under extension-state/agents/, their lease records under
 * extension-state/computer-use/, and the packages under relay-evidence/. It writes nothing.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { leasedPackages, type TrajectoryInput } from "../../extensions/secretary/computer-use/trajectory.ts";
import { TrajectoryServer } from "../../extensions/secretary/computer-use/viewer/server.ts";

const COMPUTER_TOOLS = /"name":"computer_(observe|run_plan)"/;

/** Every computer-use agent's session file under `artifacts`, with its agent identifier. */
export function computerUseSessions(artifacts: string): { agentId: string; session: string }[] {
  const agents = join(artifacts, "extension-state", "agents");
  if (!existsSync(agents)) return [];
  return readdirSync(agents).flatMap(parent => {
    const sessions = join(agents, parent, "sessions");
    return existsSync(sessions) ? readdirSync(sessions).flatMap(agentId => readdirSync(join(sessions, agentId))
      .filter(file => file.endsWith(".jsonl") && COMPUTER_TOOLS.test(readFileSync(join(sessions, agentId, file), "utf8")))
      .map(file => ({ agentId, session: join(sessions, agentId, file) }))) : [];
  });
}

/** What the viewer needs to build each computer-use agent's trajectory in `artifacts`. */
export function trajectoryInputs(artifacts: string): TrajectoryInput[] {
  return computerUseSessions(artifacts).map(({ agentId, session }) => {
    const packages = leasedPackages(computerUseState(join(artifacts, "extension-state"), session));
    return { session, evidence: join(artifacts, "relay-evidence"), agentId, ...(packages ? { packages } : {}) };
  });
}

/** The command that serves the viewer for a run's artifact directory. */
export const viewerCommand = (artifacts: string) => `npm run dev:trajectory-viewer -- ${JSON.stringify(resolve(artifacts))}`;

/** The session's computer-use state directory, named as the extension names it (installation.ts). */
export function computerUseState(extensionState: string, session: string): string {
  const header = readFileSync(session, "utf8").split("\n", 1)[0] ?? "";
  const id = (() => { try { return (JSON.parse(header) as { id?: string }).id ?? ""; } catch { return ""; } })();
  return join(extensionState, "computer-use", createHash("sha256").update(id).digest("hex"));
}

if (import.meta.main) {
  const artifacts = process.argv[2];
  if (!artifacts) { console.error("usage: trajectory.ts <artifact directory>"); process.exit(2); }
  const inputs = trajectoryInputs(resolve(artifacts));
  if (!inputs.length) { console.error(`No computer-use agent session under ${artifacts}.`); process.exit(1); }
  const server = new TrajectoryServer(Number(process.env.PORT ?? 8765));
  for (const input of inputs) console.log(await server.add(input.agentId!, input));
  // The server does not hold the process open by itself; this keeps it serving until interrupted.
  setInterval(() => {}, 1 << 30);
}
