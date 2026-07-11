// FILE: providerProcessEnv.ts
// Purpose: Builds account-isolated environments for provider runtimes and probes.
// Layer: Provider runtime utility
// Exports: provider environment driver types, key mappings, and buildProviderProcessEnv

import {
  defaultInstanceIdForDriver,
  type ProviderInstanceId,
  type ProviderKind,
} from "@synara/contracts";

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
      return MODEL_PROVIDER_ACCOUNT_ENV_KEYS.has(key) || key.startsWith("OPENCODE_");
    case "kilo":
      return MODEL_PROVIDER_ACCOUNT_ENV_KEYS.has(key) || key.startsWith("KILO_");
    case "pi":
      return MODEL_PROVIDER_ACCOUNT_ENV_KEYS.has(key) || key.startsWith("PI_");
  }
}

export function buildProviderProcessEnv(input: {
  readonly driver: ProviderProcessEnvDriver;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly instanceId?: ProviderInstanceId | string | undefined;
  readonly env?: Readonly<NodeJS.ProcessEnv> | undefined;
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

  const env = normalizedEnvironment(baseEnv, platform);
  if (isolatesAccount) {
    for (const key of Object.keys(env)) {
      if (isProviderAccountEnvKey(input.driver, key)) {
        delete env[key];
      }
    }
  }

  if (input.environment !== undefined) {
    Object.assign(env, normalizedEnvironment(input.environment, platform));
  }
  if (input.overlay !== undefined) {
    Object.assign(env, normalizedEnvironment(input.overlay, platform));
  }
  return env;
}
