import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-secretary.
 *
 * Personal pi coding agent extension. Features are added incrementally; this
 * entrypoint only wires up what exists.
 */
export default function secretaryExtension(pi: ExtensionAPI): void {
	// Extension surface registered here as features are added.
	void pi;
}
