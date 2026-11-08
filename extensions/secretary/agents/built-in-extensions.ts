import * as host from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

type ResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type ExtensionFactories = NonNullable<ResourceLoaderOptions["extensionFactories"]>;
type ExtensionFactory = ExtensionFactories[number];

const BUILT_IN_TOOL_EXTENSION_EXPORTS = [
  { name: "codemode", exportName: "createCodemodeExtension" },
  { name: "tool-search", exportName: "createToolSearchExtension" },
  { name: "mcp", exportName: "createMcpExtension" },
] as const;

/**
 * Reconstruct pi's built-in tool extensions without sharing the parent's live extension runtime.
 *
 * Pi 0.99 moved these tools out of the ordinary built-in tool registry. Descriptor-based loading
 * retains `builtin:<name>` enablement and replacement semantics; a bare inline factory would not.
 * Feature detection preserves the 0.85.1 baseline, whose host has neither these exports nor tools.
 * The llama.cpp extension is intentionally absent: the runner supplies its selected provider through
 * the parent-authentication adapter rather than constructing another model-provider catalogue.
 */
export function builtInToolExtensionFactories(): ExtensionFactories {
  const exports = host as unknown as Record<string, unknown>;
  return BUILT_IN_TOOL_EXTENSION_EXPORTS.flatMap(({ name, exportName }) => {
    const create = exports[exportName];
    if (typeof create !== "function") return [];
    const factory = (create as () => unknown)();
    return [{ name, factory, builtin: true, replaceable: true } as unknown as ExtensionFactory];
  });
}
