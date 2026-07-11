// FILE: codexTextGenerationIsolation.ts
// Purpose: Builds a non-executable Codex runtime and one-way auth snapshot for text generation.
// Layer: Server text-generation isolation helpers.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Effect, FileSystem } from "effect";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import {
  CodexPreparedHomeFileSnapshotError,
  readCodexPreparedHomeFileSnapshot,
  type CodexPreparedAuthSource,
} from "../../codexProcessEnv.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CODEX_SYSTEM_CONFIG_PATHS = [
  "/etc/codex/config.toml",
  "/etc/codex/managed_config.toml",
  "/etc/codex/requirements.toml",
] as const;

type UnknownRecord = Record<string, unknown>;

export class CodexTextGenerationConfigError extends Error {
  override readonly name = "CodexTextGenerationConfigError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class CodexTextGenerationAuthError extends Error {
  override readonly name = "CodexTextGenerationAuthError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

function executeMacDefaultsRead(key: string): string {
  return execFileSync("/usr/bin/defaults", ["read", "com.openai.codex", key], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 1_000,
  });
}

function readMacManagedPreference(
  key: string,
  execute: (key: string) => string = executeMacDefaultsRead,
): string | undefined {
  try {
    return execute(key);
  } catch (cause) {
    const stderr =
      typeof cause === "object" && cause !== null && "stderr" in cause
        ? String((cause as { readonly stderr?: unknown }).stderr ?? "")
        : "";
    if (/does not exist/i.test(stderr)) return undefined;
    throw new CodexTextGenerationConfigError(
      `Managed macOS Codex preference ${key} could not be checked safely.`,
      { cause },
    );
  }
}

/**
 * Managed/system layers can outrank CLI overrides or add MCP servers through
 * recursive config merging. The auxiliary path therefore fails closed rather
 * than claiming a tool-free runtime when such a layer is present.
 */
export function assertNoExternalCodexConfigLayers(
  options: {
    readonly platform?: NodeJS.Platform;
    readonly systemConfigPaths?: ReadonlyArray<string>;
    readonly fileExists?: (path: string) => boolean;
    readonly readMacPreference?: (key: string) => string | undefined;
    readonly executeMacDefaultsRead?: (key: string) => string;
  } = {},
): void {
  const fileExists = options.fileExists ?? existsSync;
  const configuredSystemPath = (options.systemConfigPaths ?? CODEX_SYSTEM_CONFIG_PATHS).find(
    fileExists,
  );
  if (configuredSystemPath) {
    throw new CodexTextGenerationConfigError(
      `Isolated Codex text generation is disabled because ${configuredSystemPath} can add or force tool configuration outside Synara's isolated home.`,
    );
  }
  if ((options.platform ?? process.platform) !== "darwin") return;
  const readPreference =
    options.readMacPreference ??
    ((key: string) =>
      readMacManagedPreference(key, options.executeMacDefaultsRead ?? executeMacDefaultsRead));
  for (const key of ["config_toml_base64", "requirements_toml_base64"]) {
    if (readPreference(key)?.trim()) {
      throw new CodexTextGenerationConfigError(
        `Isolated Codex text generation is disabled because managed macOS preference ${key} can add or force tool configuration.`,
      );
    }
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readOptionalString(
  record: UnknownRecord,
  key: string,
  context: string,
): string | undefined {
  if (!hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CodexTextGenerationConfigError(`${context}.${key} must be a non-empty string.`);
  }
  return value;
}

function readOptionalStringList(
  record: UnknownRecord,
  key: string,
  context: string,
): string | readonly string[] | undefined {
  if (!hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  ) {
    return value;
  }
  throw new CodexTextGenerationConfigError(
    `${context}.${key} must be a non-empty string or string array.`,
  );
}

// These fields describe transport and credential routing only. Everything
// else, especially command-backed provider auth, is absent from the child.
const SAFE_MODEL_PROVIDER_KEYS = [
  "name",
  "base_url",
  "env_key",
  "experimental_bearer_token",
  "wire_api",
  "query_params",
  "http_headers",
  "env_http_headers",
  "request_max_retries",
  "stream_max_retries",
  "stream_idle_timeout_ms",
  "requires_openai_auth",
  "supports_websockets",
] as const;

function allowSelectedModelProvider(providerId: string, value: unknown): UnknownRecord {
  if (!isRecord(value)) {
    throw new CodexTextGenerationConfigError(`model_providers.${providerId} must be a TOML table.`);
  }
  if (hasOwn(value, "auth")) {
    throw new CodexTextGenerationConfigError(
      `model_providers.${providerId}.auth is command-backed and cannot run during isolated text generation.`,
    );
  }

  const provider: UnknownRecord = {};
  for (const key of SAFE_MODEL_PROVIDER_KEYS) {
    if (hasOwn(value, key)) provider[key] = value[key];
  }
  if (hasOwn(value, "aws")) {
    throw new CodexTextGenerationConfigError(
      `model_providers.${providerId}.aws cannot be preserved safely for a custom provider. AWS routing is supported only by the built-in amazon-bedrock provider.`,
    );
  }
  if (!hasOwn(provider, "name")) provider.name = providerId;
  return provider;
}

function inspectAmazonBedrockProvider(value: unknown): string | undefined {
  if (!isRecord(value)) {
    throw new CodexTextGenerationConfigError(
      "model_providers.amazon-bedrock must be a TOML table.",
    );
  }
  for (const key of Object.keys(value)) {
    if (key !== "aws") {
      throw new CodexTextGenerationConfigError(
        `model_providers.amazon-bedrock.${key} cannot override the built-in provider during isolated text generation.`,
      );
    }
  }
  if (!hasOwn(value, "aws")) return undefined;
  if (!isRecord(value.aws)) {
    throw new CodexTextGenerationConfigError(
      "model_providers.amazon-bedrock.aws must be a TOML table.",
    );
  }
  if (hasOwn(value.aws, "profile")) {
    throw new CodexTextGenerationConfigError(
      "model_providers.amazon-bedrock.aws.profile is unsafe because AWS profiles may execute credential_process helpers. Use direct AWS environment credentials instead.",
    );
  }
  for (const key of Object.keys(value.aws)) {
    if (key !== "region") {
      throw new CodexTextGenerationConfigError(
        `model_providers.amazon-bedrock.aws.${key} is not allowed during isolated text generation.`,
      );
    }
  }
  return readOptionalString(value.aws, "region", "model_providers.amazon-bedrock.aws");
}

export type CodexTextGenerationConfig = {
  readonly content: string;
  readonly selectedProviderId: string;
  readonly providerEnvKey?: string;
  readonly providerEnvKeys: ReadonlyArray<string>;
  readonly usesAwsCredentials: boolean;
  readonly awsRegion?: string;
};

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_PROVIDER_ENV_NAMES = new Set([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "SSH_AUTH_SOCK",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "OPENSSL_CONF",
]);

function assertProviderEnvironmentName(name: string, context: string): void {
  const canonicalName = name.toUpperCase();
  if (
    !ENV_NAME_PATTERN.test(name) ||
    FORBIDDEN_PROVIDER_ENV_NAMES.has(canonicalName) ||
    canonicalName.startsWith("LD_") ||
    canonicalName.startsWith("DYLD_") ||
    canonicalName.startsWith("SYNARA_") ||
    /(?:BROWSER|PLAYWRIGHT|CHROME|CDP).*(?:TOKEN|SOCK|SOCKET|ENDPOINT|WS)/i.test(name)
  ) {
    throw new CodexTextGenerationConfigError(
      `${context} must name a provider credential environment variable, not a process-control or application secret.`,
    );
  }
}

function selectedProviderEnvironmentKeys(
  providerId: string,
  provider: UnknownRecord | undefined,
): ReadonlyArray<string> {
  if (!provider) return [];
  const names = new Set<string>();
  const envKey = readOptionalString(provider, "env_key", `model_providers.${providerId}`);
  if (envKey) {
    assertProviderEnvironmentName(envKey, `model_providers.${providerId}.env_key`);
    names.add(envKey);
  }
  if (hasOwn(provider, "env_http_headers")) {
    const headers = provider.env_http_headers;
    if (!isRecord(headers)) {
      throw new CodexTextGenerationConfigError(
        `model_providers.${providerId}.env_http_headers must be a TOML table.`,
      );
    }
    for (const [header, value] of Object.entries(headers)) {
      if (typeof value !== "string") {
        throw new CodexTextGenerationConfigError(
          `model_providers.${providerId}.env_http_headers.${header} must name one environment variable.`,
        );
      }
      assertProviderEnvironmentName(
        value,
        `model_providers.${providerId}.env_http_headers.${header}`,
      );
      names.add(value);
    }
  }
  return [...names].sort();
}

/**
 * Parses the complete TOML document, then constructs a new positive-allowlist
 * document. No source section is copied textually into the executable home.
 */
export function buildCodexTextGenerationConfig(source: string): CodexTextGenerationConfig {
  let root: UnknownRecord;
  try {
    const parsed = parseToml(source);
    if (!isRecord(parsed)) throw new Error("root is not a table");
    root = parsed;
  } catch (cause) {
    throw new CodexTextGenerationConfigError("Codex config.toml is malformed.", { cause });
  }

  const activeProfileName = readOptionalString(root, "profile", "config");
  let activeProfile: UnknownRecord | undefined;
  if (activeProfileName !== undefined) {
    if (
      !isRecord(root.profiles) ||
      !hasOwn(root.profiles, activeProfileName) ||
      !isRecord(root.profiles[activeProfileName])
    ) {
      throw new CodexTextGenerationConfigError(
        `config.profile selects missing profile '${activeProfileName}'.`,
      );
    }
    activeProfile = root.profiles[activeProfileName];
  }

  const rootModel = readOptionalString(root, "model", "config");
  const profileModel = activeProfile
    ? readOptionalString(activeProfile, "model", `profiles.${activeProfileName}`)
    : undefined;
  const rootProvider = readOptionalString(root, "model_provider", "config");
  const profileProvider = activeProfile
    ? readOptionalString(activeProfile, "model_provider", `profiles.${activeProfileName}`)
    : undefined;
  const selectedProviderId = profileProvider ?? rootProvider ?? "openai";
  const rootChatgptBaseUrl = readOptionalString(root, "chatgpt_base_url", "config");
  const profileChatgptBaseUrl = activeProfile
    ? readOptionalString(activeProfile, "chatgpt_base_url", `profiles.${activeProfileName}`)
    : undefined;
  const openaiBaseUrl = readOptionalString(root, "openai_base_url", "config");
  const forcedLoginMethod = readOptionalString(root, "forced_login_method", "config");
  const forcedWorkspace = readOptionalStringList(root, "forced_chatgpt_workspace_id", "config");

  let selectedProvider: UnknownRecord | undefined;
  const usesAwsCredentials = selectedProviderId === "amazon-bedrock";
  let awsRegion: string | undefined;
  if (hasOwn(root, "model_providers")) {
    if (!isRecord(root.model_providers)) {
      throw new CodexTextGenerationConfigError("config.model_providers must be a TOML table.");
    }
    if (hasOwn(root.model_providers, selectedProviderId)) {
      const rawSelectedProvider = root.model_providers[selectedProviderId];
      if (selectedProviderId === "amazon-bedrock") {
        // Current Codex exposes Bedrock as a built-in provider, while 0.105
        // rejects provider `aws` fields. Preserve the selected built-in and
        // carry only its region through the fresh environment.
        awsRegion = inspectAmazonBedrockProvider(rawSelectedProvider);
      } else {
        selectedProvider = allowSelectedModelProvider(selectedProviderId, rawSelectedProvider);
      }
    }
  }
  if (
    selectedProviderId !== "openai" &&
    selectedProviderId !== "amazon-bedrock" &&
    selectedProvider === undefined
  ) {
    throw new CodexTextGenerationConfigError(
      `config.model_provider selects missing provider '${selectedProviderId}'.`,
    );
  }

  const allowed: UnknownRecord = {
    model_provider: selectedProviderId,
    cli_auth_credentials_store: "file",
  };
  const selectedModel = profileModel ?? rootModel;
  if (selectedModel !== undefined) allowed.model = selectedModel;
  const chatgptBaseUrl = profileChatgptBaseUrl ?? rootChatgptBaseUrl;
  if (chatgptBaseUrl !== undefined) allowed.chatgpt_base_url = chatgptBaseUrl;
  if (openaiBaseUrl !== undefined) allowed.openai_base_url = openaiBaseUrl;
  if (forcedLoginMethod !== undefined) allowed.forced_login_method = forcedLoginMethod;
  if (forcedWorkspace !== undefined) allowed.forced_chatgpt_workspace_id = forcedWorkspace;
  if (selectedProvider !== undefined) {
    allowed.model_providers = { [selectedProviderId]: selectedProvider };
  }

  let content: string;
  try {
    content = stringifyToml(allowed);
  } catch (cause) {
    throw new CodexTextGenerationConfigError(
      "Selected Codex provider routing could not be serialized safely.",
      { cause },
    );
  }
  const providerEnvKey = selectedProvider
    ? readOptionalString(selectedProvider, "env_key", `model_providers.${selectedProviderId}`)
    : undefined;
  const providerEnvKeys = selectedProviderEnvironmentKeys(selectedProviderId, selectedProvider);
  return {
    content,
    selectedProviderId,
    providerEnvKeys,
    usesAwsCredentials,
    ...(awsRegion !== undefined ? { awsRegion } : {}),
    ...(providerEnvKey !== undefined ? { providerEnvKey } : {}),
  };
}

const TOOL_FEATURES_DISABLED = [
  "shell_tool",
  "unified_exec",
  "apply_patch_freeform",
  "js_repl",
  "js_repl_tools_only",
  "code_mode",
  "multi_agent",
  "collab",
  "apps",
  "connectors",
  "apps_mcp_gateway",
  "plugins",
  "skill_mcp_dependency_install",
  "search_tool",
  "tool_search",
  "web_search",
  "web_search_request",
  "web_search_cached",
  "image_generation",
  "imagegen",
  "artifact",
  "artifact_tool",
  "memories",
  "memory_tool",
  "dynamic_tools",
] as const;

const LEGACY_TOOL_CONFIG_OVERRIDES = [
  'approval_policy="never"',
  'sandbox_mode="read-only"',
  'web_search="disabled"',
  "tools.web_search=false",
  "tools.view_image=false",
  "include_apply_patch_tool=false",
  "experimental_use_freeform_apply_patch=false",
  "experimental_use_unified_exec_tool=false",
] as const;

/**
 * Every entry uses Codex's highest-precedence `--config` channel. Unknown
 * feature names are accepted by 0.105 and remain useful as newer tool
 * surfaces appear. The private text-only model catalog additionally prevents
 * 0.105 model metadata from forcing apply_patch or usable image reads.
 */
export function buildCodexTextGenerationCliConfigArgs(
  modelCatalogPath: string,
): ReadonlyArray<string> {
  const overrides = [
    ...LEGACY_TOOL_CONFIG_OVERRIDES,
    ...TOOL_FEATURES_DISABLED.map((feature) => `features.${feature}=false`),
    `model_catalog_json=${JSON.stringify(modelCatalogPath)}`,
  ];
  return overrides.flatMap((override) => ["--config", override]);
}

export function buildCodexTextGenerationModelCatalog(model: string): string {
  // Codex 0.105 advertises a view_image compatibility stub even when its
  // config flag is false. A text-only catalog makes that handler reject the
  // call before resolving or reading its path; the explicit config override
  // remains in place for CLI versions that remove the stub when disabled.
  return JSON.stringify({
    models: [
      {
        slug: model,
        display_name: model,
        description: "Isolated Synara text generation without local or network tools.",
        default_reasoning_level: "low",
        supported_reasoning_levels: [{ effort: "low", description: "Low" }],
        shell_type: "shell_command",
        visibility: "hide",
        minimal_client_version: "0.105.0",
        supported_in_api: true,
        priority: 0,
        upgrade: null,
        base_instructions:
          "Return the requested structured text. No local, network, application, plugin, memory, image, artifact, or code-execution tools are available.",
        supports_reasoning_summaries: false,
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: null,
        truncation_policy: { mode: "bytes", limit: 10_000 },
        supports_parallel_tool_calls: false,
        context_window: 272_000,
        experimental_supported_tools: [],
        input_modalities: ["text"],
        prefer_websockets: false,
      },
    ],
  });
}

export function buildCodexTextGenerationRuntimeConfig(
  sourceConfig: string,
  modelCatalogPath: string,
): string {
  const parsed = parseToml(sourceConfig);
  if (!isRecord(parsed)) {
    throw new CodexTextGenerationConfigError("Isolated Codex config root is not a table.");
  }
  parsed.approval_policy = "never";
  parsed.sandbox_mode = "read-only";
  parsed.web_search = "disabled";
  parsed.include_apply_patch_tool = false;
  parsed.experimental_use_freeform_apply_patch = false;
  parsed.experimental_use_unified_exec_tool = false;
  parsed.model_catalog_json = modelCatalogPath;
  parsed.tools = { web_search: false, view_image: false };
  parsed.features = Object.fromEntries(TOOL_FEATURES_DISABLED.map((feature) => [feature, false]));
  return stringifyToml(parsed);
}

const PLATFORM_ENV_KEYS = ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"];
const LOCALE_ENV_KEYS = ["LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ"];
const PROXY_TLS_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
];
const OPENAI_ENV_KEYS = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
];
const AWS_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_ACCOUNT_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_CA_BUNDLE",
];

function copyPresentEnvironment(
  target: Record<string, string>,
  source: NodeJS.ProcessEnv,
  keys: Iterable<string>,
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") target[key] = value;
  }
}

export function buildCodexTextGenerationChildEnv(input: {
  readonly sourceEnv: NodeJS.ProcessEnv;
  readonly trustedPlatformEnv: NodeJS.ProcessEnv;
  readonly isolatedHomePath: string;
  readonly isolatedTempPath: string;
  readonly providerEnvKeys: ReadonlyArray<string>;
  readonly usesAwsCredentials: boolean;
  readonly awsRegion?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  copyPresentEnvironment(env, input.trustedPlatformEnv, PLATFORM_ENV_KEYS);
  copyPresentEnvironment(env, input.sourceEnv, LOCALE_ENV_KEYS);
  for (const key of Object.keys(input.sourceEnv)) {
    if (/^LC_[A-Z0-9_]+$/.test(key)) copyPresentEnvironment(env, input.sourceEnv, [key]);
  }
  copyPresentEnvironment(env, input.sourceEnv, PROXY_TLS_ENV_KEYS);
  copyPresentEnvironment(env, input.sourceEnv, OPENAI_ENV_KEYS);
  copyPresentEnvironment(env, input.sourceEnv, input.providerEnvKeys);
  if (input.usesAwsCredentials) {
    copyPresentEnvironment(env, input.sourceEnv, AWS_ENV_KEYS);
    env.AWS_EC2_METADATA_DISABLED = "true";
    if (input.awsRegion) env.AWS_REGION = input.awsRegion;
    const hasBearer = nonEmptyString(env.AWS_BEARER_TOKEN_BEDROCK) !== undefined;
    const hasDirectKeys =
      nonEmptyString(env.AWS_ACCESS_KEY_ID) !== undefined &&
      nonEmptyString(env.AWS_SECRET_ACCESS_KEY) !== undefined;
    if (!hasBearer && !hasDirectKeys) {
      throw new CodexTextGenerationConfigError(
        "The selected AWS provider requires direct environment credentials; profile, process, container, and web-identity credential discovery are disabled.",
      );
    }
  }

  Object.assign(env, {
    HOME: input.isolatedHomePath,
    USERPROFILE: input.isolatedHomePath,
    TMPDIR: input.isolatedTempPath,
    TMP: input.isolatedTempPath,
    TEMP: input.isolatedTempPath,
    CODEX_HOME: input.isolatedHomePath,
    CODEX_SQLITE_HOME: input.isolatedHomePath,
    XDG_CONFIG_HOME: join(input.isolatedHomePath, "xdg-config"),
    XDG_CACHE_HOME: join(input.isolatedHomePath, "xdg-cache"),
    XDG_DATA_HOME: join(input.isolatedHomePath, "xdg-data"),
    XDG_STATE_HOME: join(input.isolatedHomePath, "xdg-state"),
  });
  return env;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStableBoundAuthFile(
  source: Extract<CodexPreparedAuthSource, { kind: "bound" }>,
): Buffer | undefined {
  try {
    return readCodexPreparedHomeFileSnapshot(source, "auth.json");
  } catch (cause) {
    if (!(cause instanceof CodexPreparedHomeFileSnapshotError)) {
      throw new CodexTextGenerationAuthError("Codex auth.json could not be snapshotted safely.", {
        cause,
      });
    }
    switch (cause.failure) {
      case "home-changed":
        throw new CodexTextGenerationAuthError(
          "The Codex account auth home changed after account selection; retry the request.",
          { cause },
        );
      case "home-unavailable":
        throw new CodexTextGenerationAuthError(
          "The selected Codex account auth home can no longer be verified safely; retry the request.",
          { cause },
        );
      case "file-check-failed":
        throw new CodexTextGenerationAuthError("Codex auth.json could not be checked safely.", {
          cause,
        });
      case "symbolic-link":
        throw new CodexTextGenerationAuthError("Codex auth.json must not be a symbolic link.", {
          cause,
        });
      case "not-regular-file":
        throw new CodexTextGenerationAuthError("Codex auth.json must be a regular file.", {
          cause,
        });
      case "file-changed":
        throw new CodexTextGenerationAuthError(
          "Codex auth.json changed while its isolated snapshot was being read; retry the request.",
          { cause },
        );
      case "file-read-failed":
        throw new CodexTextGenerationAuthError("Codex auth.json could not be snapshotted safely.", {
          cause,
        });
    }
  }
}

function jwtClaims(token: string, label: string): UnknownRecord {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new CodexTextGenerationAuthError(
      `Codex ChatGPT ${label} is not a JWT and cannot be checked safely.`,
    );
  }
  try {
    const claims = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8"));
    if (!isRecord(claims)) throw new Error("claims are not an object");
    return claims;
  } catch (cause) {
    throw new CodexTextGenerationAuthError(
      `Codex ChatGPT ${label} is malformed and cannot be checked safely.`,
      { cause },
    );
  }
}

function accessTokenExpiryMs(accessToken: string): number {
  try {
    const claims = jwtClaims(accessToken, "access token");
    if (claims.exp === undefined) {
      throw new Error("exp is missing");
    }
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
      throw new Error("exp is not numeric");
    }
    const expiryMs = claims.exp * 1_000;
    if (!Number.isFinite(expiryMs)) throw new Error("exp is outside the supported range");
    return expiryMs;
  } catch (cause) {
    if (cause instanceof CodexTextGenerationAuthError) throw cause;
    throw new CodexTextGenerationAuthError(
      "Codex ChatGPT access token is malformed and cannot be checked for expiry.",
      { cause },
    );
  }
}

const PERSONAL_CHATGPT_PLAN_TYPES = new Set(["free", "go", "plus", "pro", "prolite"]);

function assertNoWorkspaceManagedCloudConfig(idToken: string): void {
  const claims = jwtClaims(idToken, "ID token");
  const authClaims = claims["https://api.openai.com/auth"];
  if (!isRecord(authClaims)) {
    throw new CodexTextGenerationAuthError(
      "Codex ChatGPT ID token does not expose a recognizable account plan, so workspace-managed cloud configuration cannot be ruled out safely.",
    );
  }
  const planType = authClaims.chatgpt_plan_type;
  if (typeof planType !== "string" || !PERSONAL_CHATGPT_PLAN_TYPES.has(planType.toLowerCase())) {
    throw new CodexTextGenerationAuthError(
      "Codex ChatGPT workspace accounts are unavailable for isolated text generation because Codex can merge workspace-managed cloud configuration that re-enables tools.",
    );
  }
}

export type CodexTextGenerationAuthSnapshot = {
  readonly effectiveAuthFilePath: string;
  readonly mode: "api-key" | "chatgpt";
};

/**
 * Copies credentials one way into the scoped home. ChatGPT refresh tokens are
 * blanked so the auxiliary process cannot redeem or rotate a single-use token,
 * and the independent candidate is discarded with the scoped home.
 */
export function prepareCodexTextGenerationAuthSnapshot(
  authSource: CodexPreparedAuthSource,
  isolatedHomePath: string,
  options: { readonly nowMs?: number; readonly minimumValidityMs?: number } = {},
): CodexTextGenerationAuthSnapshot | undefined {
  if (authSource.kind === "missing") return undefined;
  const content = readStableBoundAuthFile(authSource);
  if (!content) return undefined;
  let auth: UnknownRecord;
  try {
    const parsed = JSON.parse(content.toString("utf8"));
    if (!isRecord(parsed)) throw new Error("auth root is not an object");
    auth = parsed;
  } catch (cause) {
    throw new CodexTextGenerationAuthError("Codex auth.json is malformed.", { cause });
  }

  const tokens = isRecord(auth.tokens) ? auth.tokens : undefined;
  const modeValue = nonEmptyString(auth.auth_mode ?? auth.authMode)?.toLowerCase();
  const apiKey = nonEmptyString(auth.OPENAI_API_KEY ?? auth.openai_api_key ?? auth.apiKey);
  let mode: CodexTextGenerationAuthSnapshot["mode"];
  if (modeValue === "apikey" || modeValue === "api-key") {
    mode = "api-key";
  } else if (modeValue === "chatgpt" || modeValue === "chatgptauthtokens") {
    mode = "chatgpt";
  } else if (modeValue !== undefined) {
    throw new CodexTextGenerationAuthError(
      "Codex auth.json uses an unrecognized credential format and cannot be shared with isolated text generation safely.",
    );
  } else {
    mode = apiKey ? "api-key" : "chatgpt";
  }

  if (mode === "api-key" && !apiKey) {
    throw new CodexTextGenerationAuthError(
      "Codex API-key auth is missing OPENAI_API_KEY and cannot be shared with isolated text generation.",
    );
  }

  let candidateAuth: UnknownRecord;
  if (mode === "chatgpt") {
    const accessToken = nonEmptyString(
      tokens?.access_token ?? tokens?.accessToken ?? auth.access_token ?? auth.accessToken,
    );
    if (!accessToken) {
      throw new CodexTextGenerationAuthError(
        "Codex ChatGPT auth requires a refresh before isolated text generation, but refresh tokens are never shared with the auxiliary process.",
      );
    }
    const expiryMs = accessTokenExpiryMs(accessToken);
    const nowMs = options.nowMs ?? Date.now();
    const minimumValidityMs = options.minimumValidityMs ?? 300_000;
    if (expiryMs <= nowMs + minimumValidityMs) {
      throw new CodexTextGenerationAuthError(
        "Codex ChatGPT access token expires before isolated text generation can safely finish; refresh the main Codex session first.",
      );
    }
    const idToken = nonEmptyString(
      tokens?.id_token ?? tokens?.idToken ?? auth.id_token ?? auth.idToken,
    );
    if (!idToken) {
      throw new CodexTextGenerationAuthError(
        "Codex ChatGPT auth is missing an ID token, so workspace-managed cloud configuration cannot be ruled out safely.",
      );
    }
    assertNoWorkspaceManagedCloudConfig(idToken);
    const candidateTokens: UnknownRecord = {
      access_token: accessToken,
      id_token: idToken,
      refresh_token: "",
    };
    const accountId = nonEmptyString(
      tokens?.account_id ?? tokens?.accountId ?? auth.account_id ?? auth.accountId,
    );
    if (accountId) candidateTokens.account_id = accountId;
    candidateAuth = {
      auth_mode: "chatgptAuthTokens",
      tokens: candidateTokens,
    };
  } else {
    candidateAuth = { auth_mode: "apikey", OPENAI_API_KEY: apiKey };
  }

  const effectiveAuthFilePath = join(isolatedHomePath, "auth.json");
  try {
    writeFileSync(effectiveAuthFilePath, JSON.stringify(candidateAuth), {
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    chmodSync(effectiveAuthFilePath, PRIVATE_FILE_MODE);
  } catch (cause) {
    throw new CodexTextGenerationAuthError(
      "The private Codex auth snapshot could not be created.",
      { cause },
    );
  }
  return { effectiveAuthFilePath, mode };
}

export function acquireSecureTempFile(input: {
  readonly directory: string;
  readonly prefix: string;
  readonly content: string;
}) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const filePath = yield* fileSystem.makeTempFileScoped({
      directory: input.directory,
      prefix: input.prefix,
      suffix: ".tmp",
    });
    yield* writePrivateFileString(filePath, input.content);
    return filePath;
  });
}

export function writePrivateFileString(filePath: string, content: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, content, {
      mode: PRIVATE_FILE_MODE,
    });
    yield* fileSystem.chmod(filePath, PRIVATE_FILE_MODE);
  });
}

export function acquireSecureTempDirectory(input: {
  readonly directory: string;
  readonly prefix: string;
}) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directoryPath = yield* fileSystem.makeTempDirectoryScoped(input);
    yield* fileSystem.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
    return directoryPath;
  });
}
