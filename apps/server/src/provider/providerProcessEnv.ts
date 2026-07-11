// FILE: providerProcessEnv.ts
// Purpose: Builds account-isolated environments for provider runtimes and probes.
// Layer: Provider runtime utility
// Exports: provider environment driver types, key mappings, and buildProviderProcessEnv

import {
  defaultInstanceIdForDriver,
  type ProviderInstanceId,
  type ProviderKind,
} from "@synara/contracts";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import NodePath from "node:path";

export type ProviderProcessEnvDriver = Extract<
  ProviderKind,
  "cursor" | "gemini" | "grok" | "kilo" | "opencode" | "pi"
>;

export const MODEL_PROVIDER_API_KEY_ENV_MAPPINGS: ReadonlyArray<{
  readonly provider: string;
  readonly envKeys: ReadonlyArray<string>;
}> = [
  { provider: "github-copilot", envKeys: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] },
  { provider: "anthropic", envKeys: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] },
  { provider: "openai", envKeys: ["OPENAI_API_KEY"] },
  { provider: "azure-openai-responses", envKeys: ["AZURE_OPENAI_API_KEY"] },
  { provider: "deepseek", envKeys: ["DEEPSEEK_API_KEY"] },
  { provider: "google", envKeys: ["GEMINI_API_KEY"] },
  { provider: "google-vertex", envKeys: ["GOOGLE_CLOUD_API_KEY"] },
  { provider: "groq", envKeys: ["GROQ_API_KEY"] },
  { provider: "cerebras", envKeys: ["CEREBRAS_API_KEY"] },
  { provider: "xai", envKeys: ["XAI_API_KEY"] },
  { provider: "openrouter", envKeys: ["OPENROUTER_API_KEY"] },
  { provider: "vercel-ai-gateway", envKeys: ["AI_GATEWAY_API_KEY"] },
  { provider: "zai", envKeys: ["ZAI_API_KEY"] },
  { provider: "mistral", envKeys: ["MISTRAL_API_KEY"] },
  { provider: "minimax", envKeys: ["MINIMAX_API_KEY"] },
  { provider: "minimax-cn", envKeys: ["MINIMAX_CN_API_KEY"] },
  { provider: "moonshotai", envKeys: ["MOONSHOT_API_KEY"] },
  { provider: "moonshotai-cn", envKeys: ["MOONSHOT_API_KEY"] },
  { provider: "huggingface", envKeys: ["HF_TOKEN"] },
  { provider: "fireworks", envKeys: ["FIREWORKS_API_KEY"] },
  { provider: "opencode", envKeys: ["OPENCODE_API_KEY"] },
  { provider: "opencode-go", envKeys: ["OPENCODE_API_KEY"] },
  { provider: "kimi-coding", envKeys: ["KIMI_API_KEY"] },
  { provider: "cloudflare-workers-ai", envKeys: ["CLOUDFLARE_API_KEY"] },
  { provider: "cloudflare-ai-gateway", envKeys: ["CLOUDFLARE_API_KEY"] },
  { provider: "xiaomi", envKeys: ["XIAOMI_API_KEY"] },
  { provider: "xiaomi-token-plan-cn", envKeys: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"] },
  { provider: "xiaomi-token-plan-ams", envKeys: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"] },
  { provider: "xiaomi-token-plan-sgp", envKeys: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"] },
];

const MODEL_PROVIDER_ACCOUNT_ENV_KEYS = new Set<string>([
  ...MODEL_PROVIDER_API_KEY_ENV_MAPPINGS.flatMap(({ envKeys }) => envKeys),
  // Provider routing and alternate direct credentials used by Pi/OpenCode-compatible drivers.
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_VERSION",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CONFIG",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GENAI_API_VERSION",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
]);

const MODEL_PROVIDER_ACCOUNT_ENV_PREFIXES = [
  "AI_GATEWAY_",
  "ANTHROPIC_",
  "AWS_",
  "AZURE_OPENAI_",
  "CEREBRAS_",
  "CLOUDFLARE_",
  "COHERE_",
  "COPILOT_",
  "DEEPSEEK_",
  "FIREWORKS_",
  "GEMINI_",
  "GITHUB_",
  "GOOGLE_",
  "GROQ_",
  "HF_",
  "HUGGINGFACE_",
  "KIMI_",
  "MINIMAX_",
  "MISTRAL_",
  "MOONSHOT_",
  "OPENAI_",
  "OPENCODE_",
  "OPENROUTER_",
  "PERPLEXITY_",
  "TOGETHER_",
  "VERCEL_AI_",
  "XAI_",
  "XIAOMI_",
  "ZAI_",
] as const;

const MODEL_PROVIDER_ACCOUNT_ENV_SUFFIXES = [
  "_ACCESS_TOKEN",
  "_ACCOUNT_ID",
  "_API_KEY",
  "_API_TOKEN",
  "_API_VERSION",
  "_AUTH_TOKEN",
  "_BASE_URL",
  "_BEARER_TOKEN",
  "_CLIENT_SECRET",
  "_DEPLOYMENT_NAME_MAP",
  "_ENDPOINT",
  "_GATEWAY_ID",
  "_ORG_ID",
  "_PROJECT_ID",
  "_RESOURCE_NAME",
] as const;

const GEMINI_ACCOUNT_ENV_KEYS = new Set<string>([
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CONFIG",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
]);

const GROK_ACCOUNT_ENV_KEYS = new Set<string>([
  "XAI_API_KEY",
  "XAI_API_BASE_URL",
  "GROK_CODE_XAI_API_KEY",
]);

const CURSOR_ACCOUNT_ENV_KEYS = new Set<string>(["CURSOR_API_KEY"]);

function normalizedEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") {
    return { ...environment };
  }

  // Spreading process.env loses Windows' case-insensitive lookup behavior.
  // Collapse aliases so the selected instance overlay wins deterministically.
  const normalized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    normalized[name.toUpperCase()] = value;
  }
  return normalized;
}

const SAFE_INHERITED_ENV_KEYS = new Set([
  "ALL_PROXY",
  "CI",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LANGUAGE",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "NO_PROXY",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "WINDIR",
  "XDG_RUNTIME_DIR",
]);

function safeInheritedEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [rawName, value] of Object.entries(environment)) {
    const name = rawName.toUpperCase();
    if (SAFE_INHERITED_ENV_KEYS.has(name) || name.startsWith("LC_")) {
      safe[platform === "win32" ? name : rawName] = value;
    }
  }
  return safe;
}

const PROVIDER_OWNED_PATH_ENV_KEYS = new Set([
  "HOME",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "CURSOR_CONFIG_DIR",
  "GROK_HOME",
  "GROK_AUTH_PATH",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
]);

function sanitizedSelectedEnvironment(
  environment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const selected = normalizedEnvironment(environment, platform);
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  for (const key of PROVIDER_OWNED_PATH_ENV_KEYS) {
    const value = selected[key];
    if (value !== undefined && (!value.trim() || !pathApi.isAbsolute(value.trim()))) {
      delete selected[key];
    } else if (value !== undefined) {
      selected[key] = value.trim();
    }
  }
  return selected;
}

function providerInstanceHomeScope(
  driver: ProviderProcessEnvDriver,
  instanceId: string | undefined,
): string {
  const resolvedInstanceId = instanceId?.trim() || defaultInstanceIdForDriver(driver);
  return `instance-${Buffer.from(resolvedInstanceId, "utf8").toString("hex")}`;
}

export function providerIsolatedHomePath(input: {
  readonly driver: ProviderProcessEnvDriver;
  readonly instanceId?: ProviderInstanceId | string | undefined;
  readonly homeDir?: string | undefined;
  readonly isolationRootDir?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}): string {
  const pathApi = input.platform === "win32" ? NodePath.win32 : NodePath;
  const isolationRoot =
    input.isolationRootDir?.trim() ||
    pathApi.join(input.homeDir?.trim() || homedir(), ".synara", "userdata");
  return pathApi.resolve(
    isolationRoot,
    "provider-homes",
    input.driver,
    providerInstanceHomeScope(input.driver, input.instanceId),
  );
}

/**
 * Creates the private on-disk boundary used by an account-isolated child
 * provider. This is intentionally synchronous: it is called only while
 * constructing a launch environment, before a child can observe the path.
 */
function privateProviderHomeDirectories(
  homePath: string,
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const environment = providerHomeEnvironment(homePath, platform);
  return [
    homePath,
    environment.XDG_CACHE_HOME,
    environment.XDG_CONFIG_HOME,
    environment.XDG_DATA_HOME,
    environment.XDG_STATE_HOME,
    pathApi.join(homePath, ".cursor"),
    ...(platform === "win32" ? [environment.APPDATA, environment.LOCALAPPDATA] : []),
  ].filter((value): value is string => typeof value === "string" && pathApi.isAbsolute(value));
}

function ensurePrivateProviderHome(homePath: string, platform: NodeJS.Platform): void {
  const directories = privateProviderHomeDirectories(homePath, platform);
  for (const directory of directories) mkdirSync(directory, { recursive: true, mode: 0o700 });
  // mkdir's mode is filtered by umask and an existing directory retains its
  // previous mode, so tighten it explicitly on platforms that support it.
  if (platform !== "win32") {
    for (const directory of directories) chmodSync(directory, 0o700);
  }
}

function providerHomeEnvironment(homePath: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const environment: NodeJS.ProcessEnv = {
    HOME: homePath,
    XDG_CACHE_HOME: pathApi.join(homePath, ".cache"),
    XDG_CONFIG_HOME: pathApi.join(homePath, ".config"),
    XDG_DATA_HOME: pathApi.join(homePath, ".local", "share"),
    XDG_STATE_HOME: pathApi.join(homePath, ".local", "state"),
  };
  if (platform !== "win32") {
    return environment;
  }

  const appDataRoot = NodePath.win32.join(homePath, "AppData");
  const parsed = NodePath.win32.parse(homePath);
  return {
    ...environment,
    USERPROFILE: homePath,
    APPDATA: NodePath.win32.join(appDataRoot, "Roaming"),
    LOCALAPPDATA: NodePath.win32.join(appDataRoot, "Local"),
    ...(parsed.root.match(/^[A-Za-z]:\\$/)
      ? {
          HOMEDRIVE: parsed.root.slice(0, 2),
          HOMEPATH: homePath.slice(2) || "\\",
        }
      : {}),
  };
}

function isModelProviderAccountEnvKey(key: string): boolean {
  return (
    MODEL_PROVIDER_ACCOUNT_ENV_KEYS.has(key) ||
    MODEL_PROVIDER_ACCOUNT_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    MODEL_PROVIDER_ACCOUNT_ENV_SUFFIXES.some((suffix) => key.endsWith(suffix))
  );
}

function isProviderAccountEnvKey(driver: ProviderProcessEnvDriver, rawKey: string): boolean {
  const key = rawKey.toUpperCase();
  switch (driver) {
    case "cursor":
      return CURSOR_ACCOUNT_ENV_KEYS.has(key) || key.startsWith("CURSOR_");
    case "gemini":
      return (
        GEMINI_ACCOUNT_ENV_KEYS.has(key) ||
        key.startsWith("GEMINI_") ||
        key.startsWith("GOOGLE_GENAI_")
      );
    case "grok":
      return (
        GROK_ACCOUNT_ENV_KEYS.has(key) || key.startsWith("XAI_") || key.startsWith("GROK_CODE_")
      );
    case "opencode":
      return isModelProviderAccountEnvKey(key);
    case "kilo":
      return isModelProviderAccountEnvKey(key) || key.startsWith("KILO_");
    case "pi":
      return isModelProviderAccountEnvKey(key) || key.startsWith("PI_");
  }
}

export function buildProviderProcessEnv(input: {
  readonly driver: ProviderProcessEnvDriver;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly instanceId?: ProviderInstanceId | string | undefined;
  readonly env?: Readonly<NodeJS.ProcessEnv> | undefined;
  readonly homeDir?: string | undefined;
  readonly isolationRootDir?: string | undefined;
  readonly overlay?: Readonly<Record<string, string>> | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}): NodeJS.ProcessEnv {
  const baseEnv = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const instanceId = input.instanceId?.trim();
  const hasNonDefaultInstance =
    instanceId !== undefined && instanceId !== defaultInstanceIdForDriver(input.driver);
  const isolatesAccount = input.environment !== undefined || hasNonDefaultInstance;

  // Preserve the historical/default path exactly when no instance account
  // boundary or mandatory child-process overlay is present.
  if (!isolatesAccount && input.overlay === undefined) {
    return baseEnv as NodeJS.ProcessEnv;
  }

  const normalizedBaseEnv = normalizedEnvironment(baseEnv, platform);
  const env = isolatesAccount
    ? safeInheritedEnvironment(normalizedBaseEnv, platform)
    : normalizedBaseEnv;
  const ambientHome = normalizedBaseEnv.HOME?.trim() || normalizedBaseEnv.USERPROFILE?.trim();
  const selectedEnvironment =
    input.environment === undefined
      ? undefined
      : sanitizedSelectedEnvironment(input.environment, platform);
  if (isolatesAccount) {
    for (const key of Object.keys(env)) {
      if (isProviderAccountEnvKey(input.driver, key)) {
        delete env[key];
      }
    }
    const selectedHome = selectedEnvironment?.HOME ?? selectedEnvironment?.USERPROFILE;
    const baseHome = input.homeDir?.trim() || ambientHome || homedir();
    const syntheticHome = providerIsolatedHomePath({
      driver: input.driver,
      ...(instanceId !== undefined ? { instanceId } : {}),
      homeDir: baseHome,
      ...(input.isolationRootDir !== undefined ? { isolationRootDir: input.isolationRootDir } : {}),
      platform,
    });
    const homePath = selectedHome || syntheticHome;
    if (!selectedHome) {
      ensurePrivateProviderHome(homePath, platform);
    }
    Object.assign(env, providerHomeEnvironment(homePath, platform));
    // Cursor's credential file store is configurable independently of HOME.
    // Pin it into the synthetic root; an explicitly selected value still wins
    // when the selected environment is overlaid below.
    if (input.driver === "cursor") {
      const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
      env.CURSOR_CONFIG_DIR = pathApi.join(homePath, ".cursor");
    }
  }

  if (input.environment !== undefined) {
    Object.assign(env, selectedEnvironment);
  }
  if (isolatesAccount) {
    const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
    const effectiveHome = env.HOME ?? env.USERPROFILE;
    if (input.driver === "cursor") {
      // Nondefault Cursor accounts must never fall back to the user's global
      // Keychain credential entry, even if a selected environment requests it.
      env.AGENT_CLI_CREDENTIAL_STORE = "file";
    } else if (input.driver === "gemini") {
      env.GEMINI_FORCE_FILE_STORAGE = "true";
      delete env.GEMINI_ENCRYPTED_FILE_STORAGE;
      delete env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE;
    } else if (input.driver === "grok" && effectiveHome) {
      env.GROK_HOME ??= pathApi.join(effectiveHome, ".grok");
      env.GROK_AUTH_PATH ??= pathApi.join(env.GROK_HOME, "auth.json");
    }
  }
  if (input.overlay !== undefined) {
    Object.assign(env, normalizedEnvironment(input.overlay, platform));
  }
  return env;
}
