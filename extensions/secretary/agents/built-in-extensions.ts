import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";

type ExtensionFactories = NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"]>;

/**
 * Reconstruct pi's built-in tool extensions without sharing the parent's live extension runtime.
 *
 * Descriptor-based loading retains `builtin:<name>` enablement and replacement semantics; a bare
 * inline factory would not. The llama.cpp extension is intentionally absent: the runner supplies
 * its selected provider through the parent-authentication adapter rather than constructing another
 * model-provider catalogue.
 */
export function builtInToolExtensionFactories(): ExtensionFactories {
  return [
    { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
    { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
    { name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
  ];
}
