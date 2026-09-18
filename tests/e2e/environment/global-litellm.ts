import { readFileSync, writeFileSync, existsSync, chmodSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { CleanPiEnvironment } from "./isolation.ts";

/** Read the real provider installation/configuration; never install packages or modify global files. */
export function useGlobalLiteLLM(environment: CleanPiEnvironment, source = process.env.PI_E2E_GLOBAL_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), options: { model?: string } = {}) {
  const read = (name: string): Record<string, any> => JSON.parse(readFileSync(join(source, name), "utf8"));
  const settings = read("settings.json");
  const provider = settings.defaultProvider;
  if (typeof provider !== "string" || !provider.startsWith("litellm")) throw new Error("The selected global model must belong to the installed LiteLLM provider; refusing to choose a substitute.");
  const catalog = read("models-store.json");
  const model = options.model ?? settings.defaultModel;
  if (typeof model !== "string") throw new Error("The global provider must declare a default model; refusing to choose a substitute.");
  if (options.model !== undefined && !catalog[provider]?.models?.some((item: any) => item.id === options.model)) {
    throw new Error(`The requested model ${options.model} is not in the saved provider catalog; refusing to substitute.`);
  }
  const packageRoot = join(source, "npm", "node_modules", "pi-provider-litellm");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const entries = manifest.pi?.extensions;
  if (!Array.isArray(entries) || entries.length !== 1 || typeof entries[0] !== "string") throw new Error("Expected one installed LiteLLM provider entry point");
  const entry = resolve(packageRoot, entries[0]);
  if (!existsSync(entry)) throw new Error("The configured LiteLLM provider installation is missing");
  const credentials = read("auth.json");
  const credential = credentials[provider];
  if (!credential) throw new Error(`No saved credential for global provider ${provider}; refusing to substitute test credentials`);
  const selected = catalog[provider]?.models?.find((item: any) => item.id === model);
  if (!selected) throw new Error("The global default model is not in the saved provider catalog; refresh the global provider before reproducing");
  if (selected.api === "anthropic-messages") throw new Error("This live test does not issue Anthropic requests; use the required Claude Code client for that provider path");

  const secrets = new Set<string>();
  function collect(value: unknown, sensitive = false) {
    if (typeof value === "string" && sensitive && value.length >= 6) secrets.add(value);
    else if (Array.isArray(value)) for (const item of value) collect(item, sensitive);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) collect(item, sensitive || /key|token|secret|password|authorization|headers/i.test(key));
  }
  collect(credential);
  collect(settings.litellm);
  const models = existsSync(join(source, "models.json")) ? read("models.json") : {};
  const overrides = models.providers?.[provider];
  collect(overrides);
  const providerSettings = JSON.parse(JSON.stringify(settings.litellm ?? {}));
  if (providerSettings.providers) providerSettings.providers = { [provider]: providerSettings.providers[provider] ?? {} };
  const baseline = JSON.parse(readFileSync(join(environment.agentDir, "settings.json"), "utf8"));
  const isolated = { ...baseline, litellm: providerSettings };
  for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel", "enabledModels", "retry", "compaction", "httpIdleTimeoutMs"]) {
    if (settings[key] !== undefined) isolated[key] = settings[key];
  }
  if (options.model !== undefined) isolated.defaultModel = options.model;
  isolated.extensions = [environment.extension, entry];
  isolated.packages = [];
  environment.extensions.splice(0, environment.extensions.length, ...isolated.extensions);
  const privateWrite = (name: string, value: unknown) => {
    const path = join(environment.agentDir, name);
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); chmodSync(path, 0o600);
  };
  privateWrite("settings.json", isolated);
  privateWrite("auth.json", { [provider]: credential });
  privateWrite("models-store.json", { [provider]: catalog[provider] });
  privateWrite("models.json", { providers: overrides ? { [provider]: overrides } : {} });
  delete environment.env.PI_OFFLINE;
  // Preserve only the provider's relevant environment, not unrelated global plugin state.
  const names = new Set(["LITELLM_BASE_URL", "LITELLM_API_KEY", "LITELLM_API_KEY_HELPER", "LITELLM_HEADERS", "LITELLM_GCLOUD_TOKEN_AUTH", "GOOGLE_APPLICATION_CREDENTIALS", "LITELLM_DISCOVERY_TIMEOUT_MS", "LITELLM_OFFLINE"]);
  for (const match of JSON.stringify(providerSettings).matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g)) names.add(match[1]);
  for (const name of names) if (process.env[name] !== undefined) {
    environment.env[name] = process.env[name];
    if (/key|token|secret|password|headers/i.test(name)) collect(process.env[name], true);
  }
  environment.redact = text => {
    let result = text;
    for (const secret of secrets) for (const form of [secret, JSON.stringify(secret).slice(1, -1)]) result = result.split(form).join("[REDACTED]");
    return result;
  };
  const profile = { kind: "live-global-litellm", provider, model, api: selected.api,
    providerPackage: manifest.name, providerVersion: manifest.version, providerEntry: entry,
    globalAgentDir: source, loadedExtensions: isolated.extensions,
    configurationSource: "global settings.json, selected provider auth/catalog and models.json overrides",
    inheritedSettingNames: Object.keys(isolated).filter(key => key !== "litellm"),
    inheritedEnvironmentNames: [...names].filter(name => process.env[name] !== undefined),
    credentials: "private temporary auth.json; never copied into artifacts" };
  writeFileSync(join(environment.artifacts, "provider-profile.json"), JSON.stringify(profile, null, 2) + "\n");
  const manifestPath = join(environment.artifacts, "environment.json");
  const environmentManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  environmentManifest.modelTransport = "real installed global LiteLLM provider; no mock server";
  delete environmentManifest.environment.PI_OFFLINE;
  environmentManifest.providerProfile = "provider-profile.json";
  writeFileSync(manifestPath, JSON.stringify(environmentManifest, null, 2) + "\n");
  return { ...profile,
    redactArtifacts() {
      function visit(directory: string) {
        for (const name of readdirSync(directory)) {
          const path = join(directory, name);
          if (statSync(path).isDirectory()) visit(path);
          else if (/\.(jsonl?|log|txt|cast)$/.test(name)) {
            const original = readFileSync(path, "utf8");
            const clean = environment.redact(original);
            if (clean !== original) writeFileSync(path, clean);
          }
        }
      }
      visit(environment.artifacts);
    },
  };
}
