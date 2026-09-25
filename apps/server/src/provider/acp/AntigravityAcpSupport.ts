/**
 * Antigravity ACP support - resolves `agy_acp_server`, builds spawn input, and
 * owns the shared ACP runtime for Antigravity sessions.
 *
 * @module AntigravityAcpSupport
 */
import { accessSync, constants, existsSync } from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import { resolveExecutable } from "@synara/shared/executable";
import { supportsPosixPermissions } from "@synara/shared/filesystemPlatform";
import {
  type AntigravityModelOptions,
  type ProviderListModelsResult,
  type ProviderModelDescriptor,
} from "@synara/contracts";
import { formatModelDisplayName } from "@synara/shared/model";
import { Effect, Layer, Schema, Scope, ServiceMap } from "effect";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { ChildProcessSpawner } from "effect/unstable/process";

import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
  type AcpSessionStartupTimeouts,
} from "./AcpSessionRuntime.ts";
import {
  collectSessionConfigOptionValues,
  extractModelConfigId,
  findSessionConfigOption,
} from "./AcpRuntimeModel.ts";

export const ANTIGRAVITY_ACP_EXECUTABLE_ENV = "ANTIGRAVITY_ACP_EXECUTABLE";
export const ANTIGRAVITY_ACP_BINARY_NAME = "agy_acp_server";
export const ANTIGRAVITY_ACP_PAR_BINARY_NAME = "agy_acp_server.par";

/**
 * Cold PyInstaller unpack plus auth can exceed the shared 20s initialize budget.
 * Keep generous so a healthy but slow handshake still succeeds.
 */
export const ANTIGRAVITY_ACP_STARTUP_TIMEOUTS = {
  initializeMs: 90_000,
  authenticateMs: 60_000,
  sessionSetupMs: 60_000,
  totalMs: 100_000,
} as const satisfies AcpSessionStartupTimeouts;

/** Model discovery runs in a disposable session and may re-unpack the archive. */
export const ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS = 100_000;

const ANTIGRAVITY_CACHED_AUTH_METHOD_IDS = new Set([
  "cached_token",
  "google.cached_token",
  "oauth",
  "google.oauth",
  "google",
]);
const ANTIGRAVITY_INTERACTIVE_AUTH_METHOD_IDS = new Set([
  "browser_login",
  "google.browser_login",
  "device_code",
]);
const ANTIGRAVITY_API_KEY_AUTH_METHOD_IDS = new Set([
  "api_key",
  "google.api_key",
  "gemini.api_key",
  "google_api_key",
]);
const ANTIGRAVITY_API_KEY_ENV_KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

/** Browser open is disabled so ACP startup never launches a GUI browser. */
const ANTIGRAVITY_BROWSERLESS_ENV = {
  BROWSER: "true",
  NO_BROWSER: "true",
} as const;

export interface AntigravityAcpRuntimeSettings {
  readonly binaryPath?: string;
  readonly model?: string;
  readonly reasoningEffort?: AntigravityModelOptions["reasoningEffort"];
}

export interface AntigravityAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "freshSessionRetry" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly antigravitySettings: AntigravityAcpRuntimeSettings | null | undefined;
}

export interface AntigravityAcpModelSelectionErrorContext {
  readonly cause: AcpErrors.AcpError;
  readonly method: "session/set_config_option";
}

export interface AntigravityAcpResolutionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly pathExists?: (candidate: string) => boolean;
  readonly resolveOnPath?: (command: string) => string | null;
}

export type AntigravityAcpResolution =
  | {
      readonly outcome: "resolved";
      readonly executable: string;
      readonly source: "env" | "configured" | "managed" | "path" | "local-bin";
    }
  | {
      readonly outcome: "unsupported-platform";
      readonly source: "path" | "configured" | "managed" | "env";
      readonly detail: string;
    }
  | {
      readonly outcome: "not-installed";
      readonly detail: string;
    };

/** Old print-mode `agy` paths must not be launched as the ACP server. */
export function isAntigravityAcpBinaryPath(value: string | null | undefined): boolean {
  // Split on both separators so Windows-style paths (`C:\tools\agy_acp_server.exe`)
  // are recognized on any platform; nodePath.basename only handles the host separator.
  const base = (value?.trim() ?? "").split(/[/\\]/).pop()?.toLowerCase() ?? "";
  return (
    base === ANTIGRAVITY_ACP_BINARY_NAME ||
    base === `${ANTIGRAVITY_ACP_BINARY_NAME}.par` ||
    base === `${ANTIGRAVITY_ACP_BINARY_NAME}.exe`
  );
}

function isParExecutable(candidate: string): boolean {
  return candidate.toLowerCase().endsWith(".par");
}

function supportedWindowsCandidates(): ReadonlyArray<string> {
  return [
    nodePath.join(
      nodeOs.homedir(),
      ".synara",
      "acp-servers",
      "antigravity",
      `${ANTIGRAVITY_ACP_BINARY_NAME}.exe`,
    ),
    nodePath.join(nodeOs.homedir(), ".local", "bin", `${ANTIGRAVITY_ACP_BINARY_NAME}.exe`),
  ];
}

function managedInstallCandidates(homeDir: string, platform: NodeJS.Platform): string[] {
  const base = nodePath.join(homeDir, ".synara", "acp-servers", "antigravity");
  if (platform === "win32") {
    return [nodePath.join(base, `${ANTIGRAVITY_ACP_BINARY_NAME}.exe`)];
  }
  return [
    nodePath.join(base, ANTIGRAVITY_ACP_BINARY_NAME),
    nodePath.join(base, ANTIGRAVITY_ACP_PAR_BINARY_NAME),
  ];
}

function localBinCandidates(homeDir: string, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return [nodePath.join(homeDir, ".local", "bin", `${ANTIGRAVITY_ACP_BINARY_NAME}.exe`)];
  }
  return [
    nodePath.join(homeDir, ".local", "bin", ANTIGRAVITY_ACP_BINARY_NAME),
    nodePath.join(homeDir, ".local", "bin", ANTIGRAVITY_ACP_PAR_BINARY_NAME),
    nodePath.join(homeDir, ".local", "share", "agy-acp", ANTIGRAVITY_ACP_PAR_BINARY_NAME),
  ];
}

function firstExisting(
  candidates: ReadonlyArray<string>,
  pathExists: (candidate: string) => boolean,
): string | undefined {
  for (const candidate of candidates) {
    if (pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function posixExecutableExists(
  candidate: string,
  platform: NodeJS.Platform,
  pathExists: (candidate: string) => boolean = existsSync,
): boolean {
  if (!pathExists(candidate)) return false;
  // Custom existence seams already confirmed the path; do not re-stat.
  if (pathExists !== existsSync) return true;
  if (!supportsPosixPermissions(platform)) return true;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveAntigravityAcpExecutable(
  configuredBinaryPath?: string | null,
  options: AntigravityAcpResolutionOptions = {},
): AntigravityAcpResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? nodeOs.homedir();
  const pathExists = options.pathExists ?? existsSync;
  const resolveOnPath =
    options.resolveOnPath ?? ((command: string) => resolveExecutable(command, { env, platform }));

  const detail =
    "Install the Antigravity ACP server (`agy_acp_server`) and make sure it is on PATH, install it under ~/.synara/acp-servers/antigravity/, or set ANTIGRAVITY_ACP_EXECUTABLE. The interactive `agy` CLI is not a substitute.";

  const envOverride = env[ANTIGRAVITY_ACP_EXECUTABLE_ENV]?.trim();
  if (envOverride) {
    if (
      platform === "win32" &&
      !envOverride.toLowerCase().endsWith(".exe") &&
      !pathExists(envOverride)
    ) {
      return {
        outcome: "unsupported-platform",
        source: "env",
        detail: `No Windows build of ${ANTIGRAVITY_ACP_BINARY_NAME} was found at ${envOverride}.`,
      };
    }
    return { outcome: "resolved", executable: envOverride, source: "env" };
  }

  const configured = configuredBinaryPath?.trim();
  if (configured && isAntigravityAcpBinaryPath(configured)) {
    if (platform === "win32" && !configured.toLowerCase().endsWith(".exe")) {
      return {
        outcome: "unsupported-platform",
        source: "configured",
        detail: `Configured Antigravity ACP path ${configured} is not a Windows executable.`,
      };
    }
    return { outcome: "resolved", executable: configured, source: "configured" };
  }

  const managed = firstExisting(managedInstallCandidates(homeDir, platform), pathExists);
  if (managed) {
    return { outcome: "resolved", executable: managed, source: "managed" };
  }

  const pathResolved =
    resolveOnPath(ANTIGRAVITY_ACP_BINARY_NAME) ?? resolveOnPath(ANTIGRAVITY_ACP_PAR_BINARY_NAME);
  if (pathResolved) {
    if (platform === "win32" && !pathResolved.toLowerCase().endsWith(".exe")) {
      return {
        outcome: "unsupported-platform",
        source: "path",
        detail: `Found ${pathResolved} on PATH, but Synara has no Windows artifact for ${ANTIGRAVITY_ACP_BINARY_NAME}.`,
      };
    }
    return { outcome: "resolved", executable: pathResolved, source: "path" };
  }

  const localBin = firstExisting(localBinCandidates(homeDir, platform), pathExists);
  if (localBin) {
    if (platform === "win32" && !localBin.toLowerCase().endsWith(".exe")) {
      return {
        outcome: "unsupported-platform",
        source: "managed",
        detail: `Found ${localBin}, but Synara has no Windows artifact for ${ANTIGRAVITY_ACP_BINARY_NAME}.`,
      };
    }
    if (
      platform !== "win32" &&
      isParExecutable(localBin) &&
      !posixExecutableExists(localBin, platform, pathExists)
    ) {
      return {
        outcome: "not-installed",
        detail: `${localBin} exists but is not executable. Run \`chmod +x\` on it, then retry.`,
      };
    }
    return { outcome: "resolved", executable: localBin, source: "local-bin" };
  }

  if (platform === "win32") {
    const windowsHint = supportedWindowsCandidates().find((candidate) => pathExists(candidate));
    if (windowsHint) {
      return { outcome: "resolved", executable: windowsHint, source: "managed" };
    }
    return {
      outcome: "unsupported-platform",
      source: "path",
      detail: `Synara has no Windows artifact for ${ANTIGRAVITY_ACP_BINARY_NAME}. ${detail}`,
    };
  }

  return { outcome: "not-installed", detail };
}

export function resolveAntigravityAcpBinaryPath(
  binaryPath?: string | null,
  options: AntigravityAcpResolutionOptions = {},
): string {
  const resolution = resolveAntigravityAcpExecutable(binaryPath, options);
  if (resolution.outcome === "resolved") {
    return resolution.executable;
  }
  if (resolution.outcome === "unsupported-platform") {
    return resolution.detail;
  }
  return ANTIGRAVITY_ACP_BINARY_NAME;
}

/** PyInstaller `.par` archives on Linux need an empty uid arg to unpack. */
export function antigravityAcpArgsForExecutable(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "win32") {
    return [];
  }
  return isParExecutable(executable) ? ["--uid="] : [];
}

export function buildAntigravityAcpSpawnInput(
  antigravitySettings: AntigravityAcpRuntimeSettings | null | undefined,
  cwd: string,
  options: AntigravityAcpResolutionOptions = {},
): AcpSpawnInput {
  const resolution = resolveAntigravityAcpExecutable(antigravitySettings?.binaryPath, options);
  const executable =
    resolution.outcome === "resolved"
      ? resolution.executable
      : resolution.outcome === "unsupported-platform"
        ? resolution.detail
        : ANTIGRAVITY_ACP_BINARY_NAME;

  return {
    command: executable,
    args: antigravityAcpArgsForExecutable(executable, options.platform ?? process.platform),
    cwd,
    env: buildProviderChildEnvironment({
      provider: "antigravity",
      overrides: ANTIGRAVITY_BROWSERLESS_ENV,
    }),
  };
}

export function getAntigravityApiKeyEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of ANTIGRAVITY_API_KEY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function hasAntigravityApiKeyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return getAntigravityApiKeyEnv(env) !== undefined;
}

function availableAuthMethodIds(initializeResult: Acp.InitializeResponse): ReadonlySet<string> {
  return new Set(
    (initializeResult.authMethods ?? [])
      .map((method) => method.id.trim())
      .filter((methodId) => methodId.length > 0),
  );
}

function describeAuthMethodIds(authMethodIds: ReadonlySet<string>): string {
  return authMethodIds.size > 0 ? [...authMethodIds].join(", ") : "none";
}

export const resolveAntigravityAcpAuthMethodId = (
  initializeResult: Acp.InitializeResponse,
): Effect.Effect<string, AcpErrors.AcpError> =>
  Effect.gen(function* () {
    const authMethodIds = availableAuthMethodIds(initializeResult);
    const hasApiKey = hasAntigravityApiKeyEnv();

    if (hasApiKey) {
      const apiKeyMethod = [...authMethodIds].find((methodId) =>
        ANTIGRAVITY_API_KEY_AUTH_METHOD_IDS.has(methodId),
      );
      if (apiKeyMethod) {
        return apiKeyMethod;
      }
    }
    const cachedMethod = [...authMethodIds].find((methodId) =>
      ANTIGRAVITY_CACHED_AUTH_METHOD_IDS.has(methodId),
    );
    if (cachedMethod) {
      return cachedMethod;
    }
    if (authMethodIds.size === 0) {
      // No advertised methods: let session setup surface the real -32000
      // sign-in challenge instead of failing early with a synthetic message.
      return "cached_token";
    }
    const onlyInteractive =
      authMethodIds.size > 0 &&
      [...authMethodIds].every((methodId) => ANTIGRAVITY_INTERACTIVE_AUTH_METHOD_IDS.has(methodId));
    if (onlyInteractive) {
      const advertised = describeAuthMethodIds(authMethodIds);
      return yield* new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `Antigravity ACP is not authenticated for headless use (advertised: ${advertised}). Sign in with \`agy\` or set GEMINI_API_KEY / GOOGLE_API_KEY, then retry.`,
        data: { authMethods: [...authMethodIds], reason: "credentials_missing" },
      });
    }
    if (hasApiKey && authMethodIds.size > 0) {
      const advertised = describeAuthMethodIds(authMethodIds);
      return yield* new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `Antigravity ACP advertised no supported API-key auth method (advertised: ${advertised}). Update agy_acp_server or sign in with the Antigravity CLI, then retry.`,
        data: { authMethods: [...authMethodIds], reason: "compatibility_mismatch" },
      });
    }
    const advertised = describeAuthMethodIds(authMethodIds);
    return yield* new AcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: `Antigravity ACP advertised no supported headless authentication method (advertised: ${advertised}). Sign in with \`agy\` or set GEMINI_API_KEY / GOOGLE_API_KEY, then retry.`,
      data: { authMethods: [...authMethodIds], reason: "compatibility_mismatch" },
    });
  });

export const makeAntigravityAcpRuntime = (
  input: AntigravityAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildAntigravityAcpSpawnInput(input.antigravitySettings, input.cwd),
        resolveAuthMethodId: resolveAntigravityAcpAuthMethodId,
        authenticateMeta: { headless: true },
        startupTimeouts: ANTIGRAVITY_ACP_STARTUP_TIMEOUTS,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

type AntigravitySelectConfigOption = Extract<Acp.SessionConfigOption, { type: "select" }>;

function flattenAntigravitySelectEntries(
  options: AntigravitySelectConfigOption["options"],
): ReadonlyArray<Acp.SessionConfigSelectOption> {
  return options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

function antigravityModelDescriptor(
  option: AntigravitySelectConfigOption | undefined,
  effortOption: AntigravitySelectConfigOption | undefined,
  value: string,
): ProviderModelDescriptor {
  const choice = option
    ? flattenAntigravitySelectEntries(option.options).find((entry) => entry.value === value)
    : undefined;
  const name = choice?.name?.trim() || formatModelDisplayName(value) || value;
  const description = choice?.description?.trim() || undefined;
  const efforts = effortOption ? flattenAntigravitySelectEntries(effortOption.options) : [];
  const defaultEffort = effortOption?.currentValue?.trim() || undefined;
  return {
    slug: value,
    name,
    ...(description ? { description } : {}),
    ...(efforts.length > 0
      ? {
          supportedReasoningEfforts: efforts.map((effort) => ({
            value: effort.value,
            label: effort.name || effort.value,
            ...(effort.description ? { description: effort.description } : {}),
          })),
          ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
        }
      : {}),
    supportsFastMode: false,
    supportsThinkingToggle: false,
  };
}

function findAntigravityEffortOption(
  options: ReadonlyArray<Acp.SessionConfigOption>,
): AntigravitySelectConfigOption | undefined {
  const candidates = options.filter(
    (option): option is AntigravitySelectConfigOption =>
      option.type === "select" &&
      (option.category === "thought_level" ||
        option.id.trim().toLowerCase().includes("effort") ||
        option.id.trim().toLowerCase().includes("reasoning") ||
        option.name.trim().toLowerCase().includes("effort") ||
        option.name.trim().toLowerCase().includes("reasoning")),
  );
  return (
    candidates.find((option) => option.category === "thought_level") ??
    candidates.find((option) => option.id.trim().toLowerCase() === "reasoning_effort") ??
    candidates[0]
  );
}

function findAntigravityModelOption(
  options: ReadonlyArray<Acp.SessionConfigOption>,
): AntigravitySelectConfigOption | undefined {
  return options.find(
    (option): option is AntigravitySelectConfigOption =>
      option.type === "select" && option.category === "model",
  );
}

export function discoverAntigravityAcpModels(
  runtime: Pick<AcpSessionRuntimeShape, "getConfigOptions">,
): Effect.Effect<ProviderListModelsResult, AcpErrors.AcpError> {
  return Effect.gen(function* () {
    const configOptions = yield* runtime.getConfigOptions;
    const modelOption = findAntigravityModelOption(configOptions);
    if (!modelOption) {
      return yield* new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Antigravity ACP did not advertise a model configuration option.",
      });
    }
    const effortOption = findAntigravityEffortOption(configOptions);
    const values = collectSessionConfigOptionValues(modelOption);
    const seen = new Set<string>();
    const models: ProviderModelDescriptor[] = [];
    for (const value of values) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      models.push(antigravityModelDescriptor(modelOption, effortOption, value));
    }
    if (models.length === 0) {
      return yield* new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Antigravity ACP advertised an empty model list.",
      });
    }
    return {
      models,
      source: "antigravity-acp",
      cached: false,
    } satisfies ProviderListModelsResult;
  });
}

export function applyAntigravityAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntimeShape,
    "getConfigOptions" | "setConfigOption" | "setModel"
  >;
  readonly model?: string | null;
  readonly options?: AntigravityModelOptions | null;
  readonly mapError: (context: AntigravityAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const model = input.model?.trim();
    const effort = input.options?.reasoningEffort?.trim();
    if (!model && !effort) {
      return;
    }
    const mapError = (cause: AcpErrors.AcpError) =>
      input.mapError({ cause, method: "session/set_config_option" });
    if (model) {
      yield* input.runtime.setModel(model).pipe(Effect.mapError(mapError), Effect.asVoid);
    }
    if (effort) {
      const configOptions = yield* input.runtime.getConfigOptions.pipe(Effect.mapError(mapError));
      const effortOption = findAntigravityEffortOption(configOptions);
      const configId = effortOption?.id ?? "reasoning_effort";
      const allowed = effortOption
        ? new Set(collectSessionConfigOptionValues(effortOption))
        : undefined;
      if (!allowed || allowed.size === 0 || allowed.has(effort)) {
        yield* input.runtime
          .setConfigOption(configId, effort)
          .pipe(Effect.mapError(mapError), Effect.asVoid);
      }
    }
  });
}

/** Re-export for adapters that need the model config id without re-walking options. */
export function antigravityModelConfigId(
  sessionSetup: Parameters<typeof extractModelConfigId>[0],
): string | undefined {
  return extractModelConfigId(sessionSetup) ?? "model";
}

export function findAntigravityConfigOption(
  options: ReadonlyArray<Acp.SessionConfigOption> | null | undefined,
  configId: string,
): Acp.SessionConfigOption | undefined {
  return findSessionConfigOption(options, configId);
}

export const AntigravityAcpRuntimeSchema = Schema.Struct({
  binaryPath: Schema.optional(Schema.String),
});
