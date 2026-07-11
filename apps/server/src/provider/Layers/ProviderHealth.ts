/**
 * ProviderHealthLive - Cache-backed provider health service.
 *
 * Seeds provider status from disk cache when available, then refreshes from
 * CLI probes without blocking the rest of server startup.
 *
 * Uses effect's ChildProcessSpawner to run CLI probes natively.
 *
 * @module ProviderHealthLive
 */
import * as OS from "node:os";
import type {
  ProviderInstanceId,
  ServerSettings,
  ServerProviderAuthStatus,
  ServerProviderStatus,
  ServerProviderStatusState,
  ServerProviderUpdateState,
} from "@synara/contracts";
import { ProviderKind, ServerProviderUpdateError } from "@synara/contracts";
import { parseCodexConfigModelProvider } from "@synara/shared/codexConfig";
import {
  deriveProviderInstances,
  deriveUnsupportedProviderInstances,
  providerStartOptionsFromInstance,
  type ResolvedProviderInstance,
  type UnsupportedProviderInstance,
} from "@synara/shared/providerInstances";
import { decodeJsonResult } from "@synara/shared/schemaJson";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import { query as claudeQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  Array,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  CODEX_CLI_UNPARSEABLE_VERSION_MESSAGE,
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion";
import { buildClaudeProcessEnv } from "../claudeEnvironment";
import { ServerConfig } from "../../config";
import { ServerSettingsService } from "../../serverSettings";
import { isWindowsShellCommandMissingResult } from "../../shell-command-detection";
import {
  buildGeminiProbeEnv,
  normalizeGeminiCapabilityProbeResult,
  probeGeminiCapabilities,
} from "../geminiAcpProbe";
import {
  buildCursorAgentCommand,
  buildCursorAgentHeadlessEnv,
  DEFAULT_CURSOR_AGENT_BINARY,
  resolveCursorAgentBinaryPath,
} from "../acp/CursorAcpCommand";
import { hasGrokApiKeyEnv } from "../acp/GrokAcpSupport";
import {
  claudeAuthMetadata,
  isStructuredClaudeAuthFalseNegativeCandidate,
  parseClaudeAuthStatusFromOutput,
} from "../claudeAuthStatus";
import { acquireClaudeAuthStatusLock } from "../claudeAuthStatusLock";
import { readClaudeCliCredentialsSummary } from "../claudeProcessEnv";
import {
  detailFromResult,
  extractAuthBoolean,
  extractAuthMethod,
  isCommandMissingCause,
  nonEmptyTrimmed,
  PROVIDER_COMMAND_TIMEOUT_DETAIL,
  toTitleCaseWords,
  type CommandResult,
} from "../providerCliOutput";
import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";
import {
  orderProviderStatuses,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache";
import { makeProviderMaintenanceCommandCoordinator } from "../providerMaintenanceCommandCoordinator";
import {
  enrichProviderStatusWithVersionAdvisory,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  parseGenericCliVersion,
  resolveProviderMaintenanceCapabilitiesEffect,
  type PackageManagedProviderMaintenanceDefinition,
} from "../providerMaintenance";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText";
import { buildCodexProcessEnv } from "../../codexProcessEnv.ts";
import { buildProviderProcessEnv, type ProviderProcessEnvDriver } from "../providerProcessEnv.ts";

export { parseClaudeAuthStatusFromOutput } from "../claudeAuthStatus";
export type { CommandResult } from "../providerCliOutput";

const DEFAULT_TIMEOUT_MS = 4_000;
const CLAUDE_HEALTH_TIMEOUT_MS = 20_000;
const OPENCODE_HEALTH_TIMEOUT_MS = 20_000;
const CODEX_PROVIDER = "codex" as const;
const CLAUDE_AGENT_PROVIDER = "claudeAgent" as const;
const CURSOR_PROVIDER = "cursor" as const;
const GEMINI_PROVIDER = "gemini" as const;
const GROK_PROVIDER = "grok" as const;
const KILO_PROVIDER = "kilo" as const;
const OPENCODE_PROVIDER = "opencode" as const;
const PI_PROVIDER = "pi" as const;
type ProviderStatuses = ReadonlyArray<ServerProviderStatus>;
const DISABLED_PROVIDER_STATUS_MESSAGE = "Provider is disabled in Synara settings.";

const PROVIDERS = [
  CODEX_PROVIDER,
  CLAUDE_AGENT_PROVIDER,
  CURSOR_PROVIDER,
  GEMINI_PROVIDER,
  GROK_PROVIDER,
  KILO_PROVIDER,
  OPENCODE_PROVIDER,
  PI_PROVIDER,
] as const satisfies ReadonlyArray<ProviderKind>;

const UPDATE_OUTPUT_MAX_BYTES = 10_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
export const PROVIDER_HEALTH_PROBE_CONCURRENCY = 4;

export function runProviderHealthProbes<A, E, R>(
  probes: ReadonlyArray<Effect.Effect<A, E, R>>,
): Effect.Effect<ReadonlyArray<A>, E, R> {
  return Effect.all(probes, { concurrency: PROVIDER_HEALTH_PROBE_CONCURRENCY });
}

function providerStatusInstanceKey(status: ServerProviderStatus): ProviderInstanceId {
  return status.instanceId ?? status.provider;
}

// Instance ids are editable settings keys, so driver identity must travel with
// them to prevent a reused id from inheriting another provider's auth/status.
function providerStatusIdentityKey(status: ServerProviderStatus): string {
  return `${status.driver ?? status.provider}\u0000${providerStatusInstanceKey(status)}`;
}

function providerStatusKey(input: {
  readonly provider: ProviderKind;
  readonly instanceId?: ProviderInstanceId | undefined;
}): ProviderInstanceId {
  return input.instanceId ?? input.provider;
}

function providerTargetIdentityKey(input: {
  readonly provider: ProviderKind;
  readonly instanceId?: ProviderInstanceId | undefined;
}): string {
  return `${input.provider}\u0000${providerStatusKey(input)}`;
}

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

const PACKAGE_MANAGED_PROVIDER_UPDATES: Partial<
  Record<ProviderKind, PackageManagedProviderMaintenanceDefinition>
> = {
  codex: {
    provider: CODEX_PROVIDER,
    binaryName: "codex",
    npmPackageName: "@openai/codex",
    homebrew: { name: "codex", kind: "cask" },
    nativeUpdate: null,
  },
  claudeAgent: {
    provider: CLAUDE_AGENT_PROVIDER,
    binaryName: "claude",
    npmPackageName: "@anthropic-ai/claude-code",
    homebrew: { name: "claude-code", kind: "cask" },
    nativeUpdate: {
      executable: "claude",
      args: () => ["update"],
      lockKey: "claude-native",
      strategy: "matching-path",
      isCommandPath: isClaudeNativeCommandPath,
    },
  },
  gemini: {
    provider: GEMINI_PROVIDER,
    binaryName: "gemini",
    npmPackageName: "@google/gemini-cli",
    homebrew: { name: "gemini-cli", kind: "formula" },
    nativeUpdate: null,
  },
  kilo: {
    provider: KILO_PROVIDER,
    binaryName: "kilo",
    npmPackageName: "@kilocode/cli",
    homebrew: null,
    nativeUpdate: {
      executable: "kilo",
      args: () => ["upgrade"],
      lockKey: "kilo-native",
      strategy: "always",
    },
  },
  opencode: {
    provider: OPENCODE_PROVIDER,
    binaryName: "opencode",
    npmPackageName: "opencode-ai",
    homebrew: { name: "anomalyco/tap/opencode", kind: "formula" },
    latestVersionSource: { kind: "npm", name: "opencode-ai" },
    nativeUpdate: {
      executable: "opencode",
      args: (installSource) =>
        installSource === "unknown" || installSource === "native"
          ? ["upgrade"]
          : ["upgrade", "--method", installSource],
      lockKey: "opencode-native",
      strategy: "always",
      excludedInstallSources: ["homebrew"],
      isCommandPath: isOpenCodeNativeCommandPath,
    },
  },
  pi: {
    provider: PI_PROVIDER,
    binaryName: "pi",
    npmPackageName: "@earendil-works/pi-coding-agent",
    homebrew: null,
    nativeUpdate: {
      executable: "pi",
      args: () => ["update"],
      lockKey: "pi-native",
      strategy: "always",
    },
  },
};

// ── Pure helpers ────────────────────────────────────────────────────
//
// Generic CLI-output parsing lives in ../providerCliOutput; Claude auth-status
// interpretation lives in ../claudeAuthStatus.

function resolveVoiceTranscriptionAvailability(
  authMethod: string | undefined,
): boolean | undefined {
  if (!authMethod) {
    return undefined;
  }
  return authMethod === "chatgpt" || authMethod === "chatgptAuthTokens";
}

// ── Subscription type detection ─────────────────────────────────────
//
// Walks arbitrary JSON output from `<provider> auth status` looking for a
// subscription/plan identifier. Used as a best-effort first pass; the SDK
// probe below is the reliable source when available.

const SUBSCRIPTION_TYPE_KEYS = [
  "subscriptionType",
  "subscription_type",
  "plan",
  "tier",
  "planType",
  "plan_type",
] as const;

const SUBSCRIPTION_CONTAINER_KEYS = ["account", "subscription", "user", "billing"] as const;
const AUTH_METHOD_KEYS = ["authMethod", "auth_method"] as const;
const AUTH_METHOD_CONTAINER_KEYS = ["auth", "account", "session"] as const;

const asNonEmptyString = (v: unknown): Option.Option<string> =>
  typeof v === "string" && v.length > 0 ? Option.some(v) : Option.none();

const asRecord = (v: unknown): Option.Option<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Option.some(v as Record<string, unknown>)
    : Option.none();

function findSubscriptionType(value: unknown): Option.Option<string> {
  if (Array.isArray(value)) {
    return Option.firstSomeOf(value.map(findSubscriptionType));
  }
  return asRecord(value).pipe(
    Option.flatMap((record) => {
      const direct = Option.firstSomeOf(
        SUBSCRIPTION_TYPE_KEYS.map((key) => asNonEmptyString(record[key])),
      );
      if (Option.isSome(direct)) return direct;
      return Option.firstSomeOf(
        SUBSCRIPTION_CONTAINER_KEYS.map((key) =>
          asRecord(record[key]).pipe(Option.flatMap(findSubscriptionType)),
        ),
      );
    }),
  );
}

function findAuthMethodDeep(value: unknown): Option.Option<string> {
  if (Array.isArray(value)) {
    return Option.firstSomeOf(value.map(findAuthMethodDeep));
  }
  return asRecord(value).pipe(
    Option.flatMap((record) => {
      const direct = Option.firstSomeOf(
        AUTH_METHOD_KEYS.map((key) => asNonEmptyString(record[key])),
      );
      if (Option.isSome(direct)) return direct;
      return Option.firstSomeOf(
        AUTH_METHOD_CONTAINER_KEYS.map((key) =>
          asRecord(record[key]).pipe(Option.flatMap(findAuthMethodDeep)),
        ),
      );
    }),
  );
}

const decodeUnknownJson = decodeJsonResult(Schema.Unknown);

function extractSubscriptionTypeFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  return Option.getOrUndefined(findSubscriptionType(parsed.success));
}

function extractClaudeAuthMethodFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  return Option.getOrUndefined(findAuthMethodDeep(parsed.success));
}

// ── Codex subscription label ────────────────────────────────────────

type CodexPlanTypeLiteral =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "self_serve_business_usage_based"
  | "enterprise_cbp_usage_based"
  | "unknown";

function codexAccountAuthLabel(input: {
  readonly type: string | undefined;
  readonly planType: string | undefined;
}): string | undefined {
  if (input.type === "apiKey") return "OpenAI API Key";
  if (!input.planType) return undefined;
  switch (input.planType as CodexPlanTypeLiteral) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      return toTitleCaseWords(input.planType);
  }
}

function extractCodexAccountTypeFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  const walk = (value: unknown): string | undefined => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = walk(entry);
        if (nested) return nested;
      }
      return undefined;
    }
    const record = Option.getOrUndefined(asRecord(value));
    if (!record) return undefined;
    const direct = Option.getOrUndefined(
      Option.firstSomeOf(["type", "accountType"].map((key) => asNonEmptyString(record[key]))),
    );
    if (direct) return direct;
    for (const key of ["account", "session", "auth"] as const) {
      const nested = walk(record[key]);
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(parsed.success);
}

// ── Claude SDK capability probe ─────────────────────────────────────
//
// Spawns a lightweight Claude Agent SDK session and reads the
// initialization result. The prompt is a never-yielding AsyncIterable so
// no user message reaches the Anthropic API — we get account metadata
// (including subscription type) from local IPC, then abort the
// subprocess. Used as a fallback when `claude auth status` output
// doesn't include subscription info.

const CAPABILITIES_PROBE_TIMEOUT_MS = 8_000;
const CLAUDE_SUBSCRIPTION_CACHE_TTL_MS = 5 * 60 * 1_000;

interface ClaudeSubscriptionProbeInput {
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly binaryPath?: string | undefined;
  readonly homePath?: string | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly homeDir?: string | undefined;
  readonly isolationRootDir?: string | undefined;
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function hashCacheComponent(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function environmentFingerprint(
  environment: Readonly<Record<string, string>> | undefined,
): Record<string, string> | null {
  if (!environment || Object.keys(environment).length === 0) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(environment)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, hashCacheComponent(value)]),
  );
}

function claudeSubscriptionProbeKey(input: ClaudeSubscriptionProbeInput): string {
  return JSON.stringify({
    instanceId: input.instanceId?.trim() || null,
    binaryPath: input.binaryPath?.trim() || null,
    homeDir: input.homeDir?.trim() || null,
    homePath: input.homePath?.trim() || null,
    isolationRootDir: input.isolationRootDir?.trim() || null,
    environment: environmentFingerprint(input.environment),
  });
}

const probeClaudeSubscription = (input: ClaudeSubscriptionProbeInput) => {
  const abort = new AbortController();
  const executable = nonEmptyTrimmed(input.binaryPath) ?? "claude";
  const env = makeClaudeProbeEnv(
    input.homePath,
    input.environment,
    input.homeDir,
    input.instanceId,
    input.isolationRootDir,
  );
  return Effect.tryPromise(async () => {
    const q = claudeQuery({
      // oxlint-disable-next-line require-yield
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await waitForAbortSignal(abort.signal);
      })(),
      options: {
        persistSession: false,
        abortController: abort,
        pathToClaudeCodeExecutable: executable,
        settingSources: ["user", "project", "local"],
        allowedTools: [],
        env,
        stderr: () => {},
      },
    });
    const init = await q.initializationResult();
    return { subscriptionType: init.account?.subscriptionType };
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;
      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );
};

export function parseAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly voiceTranscriptionAvailable?: boolean;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return {
        attemptedJsonParse: false as const,
        auth: undefined as boolean | undefined,
        authMethod: undefined as string | undefined,
      };
    }
    try {
      const parsed = JSON.parse(trimmed);
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(parsed),
        authMethod: extractAuthMethod(parsed),
      };
    } catch {
      return {
        attemptedJsonParse: false as const,
        auth: undefined as boolean | undefined,
        authMethod: undefined as string | undefined,
      };
    }
  })();

  if (parsedAuth.auth === true) {
    const voiceTranscriptionAvailable = resolveVoiceTranscriptionAvailability(
      parsedAuth.authMethod,
    );
    return {
      status: "ready",
      authStatus: "authenticated",
      ...(voiceTranscriptionAvailable !== undefined ? { voiceTranscriptionAvailable } : {}),
    };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Codex authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

// ── Codex CLI config detection ──────────────────────────────────────

/**
 * Providers that use OpenAI-native authentication via `codex login`.
 * When the configured `model_provider` is one of these, the `codex login
 * status` probe still runs. For any other provider value the auth probe
 * is skipped because authentication is handled externally (e.g. via
 * environment variables like `PORTKEY_API_KEY` or `AZURE_API_KEY`).
 */
const OPENAI_AUTH_PROVIDERS = new Set(["openai"]);

/**
 * Read the `model_provider` value from the Codex CLI config file.
 *
 * Looks for the file at `$CODEX_HOME/config.toml` (falls back to
 * `~/.codex/config.toml`). Uses a simple line-by-line scan rather than
 * a full TOML parser to avoid adding a dependency for a single key.
 *
 * Returns `undefined` when the file does not exist or does not set
 * `model_provider`.
 */
export const readCodexConfigModelProvider = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const codexHome = process.env.CODEX_HOME || path.join(OS.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");

  const content = yield* fileSystem
    .readFileString(configPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (content === undefined) {
    return undefined;
  }

  return parseCodexConfigModelProvider(content);
});

/**
 * Returns `true` when the Codex CLI is configured with a custom
 * (non-OpenAI) model provider, meaning `codex login` auth is not
 * required because authentication is handled through provider-specific
 * environment variables.
 */
export const hasCustomModelProvider = Effect.map(
  readCodexConfigModelProvider,
  (provider) => provider !== undefined && !OPENAI_AUTH_PROVIDERS.has(provider),
);

// ── Effect-native command execution ─────────────────────────────────

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

const runProviderCommand = (
  executable: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const prepared = prepareWindowsSafeProcess(executable, args, { env });
    const command = ChildProcess.make(prepared.command, prepared.args, {
      shell: prepared.shell,
      env,
    });

    const child = yield* spawner.spawn(command);

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runCodexCommand = (
  args: ReadonlyArray<string>,
  executable = "codex",
  env: NodeJS.ProcessEnv = process.env,
) =>
  runProviderCommand(executable, args, env).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runClaudeCommand = (
  args: ReadonlyArray<string>,
  executable = "claude",
  env: NodeJS.ProcessEnv = buildClaudeProcessEnv(),
) =>
  runProviderCommand(executable, args, env).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const makeProviderProbeEnv = (
  driver: ProviderProcessEnvDriver,
  environment?: Readonly<Record<string, string>>,
  instanceId?: string,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
):
  | { readonly ok: true; readonly env: NodeJS.ProcessEnv }
  | { readonly ok: false; readonly cause: unknown } => {
  try {
    return {
      ok: true,
      env: buildProviderProcessEnv({
        driver,
        ...(environment !== undefined ? { environment } : {}),
        ...(instanceId !== undefined ? { instanceId } : {}),
        ...(paths?.homeDir !== undefined ? { homeDir: paths.homeDir } : {}),
        ...(paths?.isolationRootDir !== undefined
          ? { isolationRootDir: paths.isolationRootDir }
          : {}),
      }),
    };
  } catch (cause) {
    return { ok: false, cause };
  }
};

function providerHomePreparationFailure(
  provider: ProviderProcessEnvDriver,
  checkedAt: string,
  cause: unknown,
): ServerProviderStatus {
  return {
    provider,
    instanceId: provider,
    driver: provider,
    status: "error",
    available: false,
    authStatus: "unknown",
    checkedAt,
    message: `Failed to prepare the private provider account home. ${cause instanceof Error ? cause.message : String(cause)}`,
  };
}

export const makeProviderUpdateEnv = (
  instance: ResolvedProviderInstance,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
): NodeJS.ProcessEnv => {
  const environment =
    instance.raw.environment !== undefined || Object.keys(instance.environment).length > 0
      ? instance.environment
      : undefined;
  switch (instance.driver) {
    case "cursor":
    case "gemini":
    case "grok":
    case "kilo":
    case "opencode":
    case "pi":
      return buildProviderProcessEnv({
        driver: instance.driver,
        instanceId: instance.instanceId,
        ...(paths?.homeDir !== undefined ? { homeDir: paths.homeDir } : {}),
        ...(paths?.isolationRootDir !== undefined
          ? { isolationRootDir: paths.isolationRootDir }
          : {}),
        ...(environment !== undefined ? { environment } : {}),
      });
    case "codex":
    case "claudeAgent":
      return environment ? { ...process.env, ...environment } : process.env;
  }
};

const runGeminiCommand = (
  args: ReadonlyArray<string>,
  executable = "gemini",
  env: NodeJS.ProcessEnv = process.env,
) =>
  runProviderCommand(executable, args, buildGeminiProbeEnv(env)).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runGrokCommand = (
  args: ReadonlyArray<string>,
  executable = "grok",
  env: NodeJS.ProcessEnv = process.env,
) =>
  runProviderCommand(executable, args, env).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runOpenCodeCommand = (
  args: ReadonlyArray<string>,
  executable = "opencode",
  env: NodeJS.ProcessEnv = process.env,
) =>
  runProviderCommand(executable, args, env).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runKiloCommand = (
  args: ReadonlyArray<string>,
  executable = "kilo",
  env: NodeJS.ProcessEnv = process.env,
) =>
  runProviderCommand(executable, args, env).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runCursorCommand = (
  args: ReadonlyArray<string>,
  executable = DEFAULT_CURSOR_AGENT_BINARY,
  env: NodeJS.ProcessEnv = process.env,
) => {
  const command = buildCursorAgentCommand(executable, args);
  return runProviderCommand(command.command, command.args, buildCursorAgentHeadlessEnv(env)).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${command.command} ENOENT`))
        : Effect.succeed(result),
    ),
  );
};

function parseCursorAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const output = `${result.stdout}\n${result.stderr}`;
  const lowerOutput = output.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Cursor Agent authentication status command is unavailable in this Cursor Agent version.",
    };
  }

  if (
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("not authenticated") ||
    lowerOutput.includes("unauthenticated") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("run 'agent login'") ||
    lowerOutput.includes("run `agent login`") ||
    lowerOutput.includes("run cursor-agent login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Cursor Agent is not authenticated. Run `cursor-agent login` and try again.",
    };
  }

  if (
    lowerOutput.includes("logged in") ||
    lowerOutput.includes("login successful") ||
    lowerOutput.includes("authenticated")
  ) {
    return { status: "ready", authStatus: "authenticated" };
  }

  if (result.code === 0) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Cursor Agent is installed, but Synara could not verify authentication status.",
    };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Cursor Agent authentication status. ${detail}`
      : "Could not verify Cursor Agent authentication status.",
  };
}

function cursorModelsOutputHasModels(output: string): boolean {
  return output.split(/\r?\n/u).some((line) => line.trim().length > 0 && line.includes(" - "));
}

function cursorModelsOutputHasNoModels(output: string): boolean {
  return output.toLowerCase().includes("no models available");
}

const runPiCommand = (
  args: ReadonlyArray<string>,
  executable = "pi",
  env: NodeJS.ProcessEnv = process.env,
) =>
  runProviderCommand(executable, args, env).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

// ── Health check ────────────────────────────────────────────────────

function makeCodexProbeEnv(
  homePath?: string,
  shadowHomePath?: string,
  accountId?: string,
  environment?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const normalizedHomePath = nonEmptyTrimmed(homePath);
  const normalizedShadowHomePath = nonEmptyTrimmed(shadowHomePath);
  const normalizedAccountId = nonEmptyTrimmed(accountId);
  return buildCodexProcessEnv({
    ...(environment ? { env: { ...process.env, ...environment } } : {}),
    ...(normalizedHomePath ? { homePath: normalizedHomePath } : {}),
    ...(normalizedShadowHomePath ? { shadowHomePath: normalizedShadowHomePath } : {}),
    ...(normalizedAccountId ? { accountId: normalizedAccountId } : {}),
  });
}

export function makeClaudeProbeEnv(
  homePath?: string,
  environment?: Readonly<Record<string, string>>,
  homeDir?: string,
  providerInstanceId?: ProviderInstanceId,
  isolationRootDir?: string,
): NodeJS.ProcessEnv {
  return buildClaudeProcessEnv({
    homePath,
    environment,
    homeDir,
    providerInstanceId,
    isolationRootDir,
  });
}

const readCodexConfigModelProviderForEnv = (env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const codexHome = env.CODEX_HOME?.trim() || path.join(OS.homedir(), ".codex");
    const configPath = path.join(codexHome, "config.toml");

    const content = yield* fileSystem
      .readFileString(configPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (content === undefined) {
      return undefined;
    }

    return parseCodexConfigModelProvider(content);
  });

const hasCustomModelProviderForEnv = (env: NodeJS.ProcessEnv) =>
  Effect.map(
    readCodexConfigModelProviderForEnv(env),
    (provider) => provider !== undefined && !OPENAI_AUTH_PROVIDERS.has(provider),
  );

export const makeCheckCodexProviderStatus = (
  binaryPath?: string,
  homePath?: string,
  shadowHomePath?: string,
  accountId?: string,
  environment?: Readonly<Record<string, string>>,
): Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "codex";
    // Overlay materialization can reject misconfigured account homes (e.g. a
    // symlinked shadow auth.json); report that as this instance's status instead
    // of letting a defect take down the whole provider refresh.
    let probeEnv: NodeJS.ProcessEnv;
    try {
      probeEnv = makeCodexProbeEnv(homePath, shadowHomePath, accountId, environment);
    } catch (error) {
      return {
        provider: CODEX_PROVIDER,
        instanceId: CODEX_PROVIDER,
        driver: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: error instanceof Error ? error.message : String(error),
      } satisfies ServerProviderStatus;
    }

    // Probe 1: `codex --version` — is the CLI reachable?
    const versionProbe = yield* runCodexCommand(["--version"], executable, probeEnv).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: CODEX_PROVIDER,
        instanceId: CODEX_PROVIDER,
        driver: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: isCommandMissingCause(error)
          ? "Codex CLI (`codex`) is not installed or not on PATH."
          : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: CODEX_PROVIDER,
        instanceId: CODEX_PROVIDER,
        driver: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Codex CLI is installed but failed to run. Timed out while running command.",
      };
    }

    const version = versionProbe.success.value;
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: CODEX_PROVIDER,
        instanceId: CODEX_PROVIDER,
        driver: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Codex CLI is installed but failed to run. ${detail}`
          : "Codex CLI is installed but failed to run.",
      };
    }

    const parsedVersion = parseCodexCliVersion(`${version.stdout}\n${version.stderr}`);
    if (!parsedVersion) {
      return {
        provider: CODEX_PROVIDER,
        instanceId: CODEX_PROVIDER,
        driver: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: CODEX_CLI_UNPARSEABLE_VERSION_MESSAGE,
      } satisfies ServerProviderStatus;
    }
    if (!isCodexCliVersionSupported(parsedVersion)) {
      return {
        provider: CODEX_PROVIDER,
        instanceId: CODEX_PROVIDER,
        driver: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: formatCodexCliUpgradeMessage(parsedVersion),
      };
    }

    // Probe 2: `codex login status` — is the user authenticated?
    //
    // Custom model providers (e.g. Portkey, Azure OpenAI proxy) handle
    // authentication through their own environment variables, so `codex
    // login status` will report "not logged in" even when the CLI works
    // fine.  Skip the auth probe entirely for non-OpenAI providers.
    if (yield* hasCustomModelProviderForEnv(probeEnv)) {
      return {
        provider: CODEX_PROVIDER,
        instanceId: CODEX_PROVIDER,
        driver: CODEX_PROVIDER,
        status: "ready" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message: "Using a custom Codex model provider; OpenAI login check skipped.",
      } satisfies ServerProviderStatus;
    }

    const authProbe = yield* runCodexCommand(["login", "status"], executable, probeEnv).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CODEX_PROVIDER,
        instanceId: CODEX_PROVIDER,
        driver: CODEX_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify Codex authentication status: ${error.message}.`
            : "Could not verify Codex authentication status.",
      };
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: CODEX_PROVIDER,
        instanceId: CODEX_PROVIDER,
        driver: CODEX_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message: "Could not verify Codex authentication status. Timed out while running command.",
      };
    }

    const authOutput = authProbe.success.value;
    const parsed = parseAuthStatusFromOutput(authOutput);
    const codexPlanType = extractSubscriptionTypeFromOutput(authOutput);
    const codexAccountType = extractCodexAccountTypeFromOutput(authOutput);
    const codexLabel =
      parsed.authStatus === "authenticated"
        ? codexAccountAuthLabel({ type: codexAccountType, planType: codexPlanType })
        : undefined;
    const codexAuthType =
      parsed.authStatus === "authenticated"
        ? codexAccountType === "apiKey"
          ? "apiKey"
          : codexPlanType
        : undefined;

    return {
      provider: CODEX_PROVIDER,
      instanceId: CODEX_PROVIDER,
      driver: CODEX_PROVIDER,
      status: parsed.status,
      available: true,
      authStatus: parsed.authStatus,
      version: parsedVersion,
      ...(codexAuthType ? { authType: codexAuthType } : {}),
      ...(codexLabel ? { authLabel: codexLabel } : {}),
      ...(parsed.voiceTranscriptionAvailable !== undefined
        ? { voiceTranscriptionAvailable: parsed.voiceTranscriptionAvailable }
        : {}),
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
    } satisfies ServerProviderStatus;
  });

export const checkCodexProviderStatus = makeCheckCodexProviderStatus();

// ── Claude Agent health check ───────────────────────────────────────

const CLAUDE_AUTH_FALSE_NEGATIVE_RETRY_DELAY_MS = 1_000;

export const makeCheckClaudeProviderStatus = (
  resolveSubscriptionType?: Effect.Effect<string | undefined>,
  binaryPath?: string,
  homePath?: string,
  environment?: Readonly<Record<string, string>>,
  homeDir?: string,
  options?: {
    readonly falseNegativeRetryDelayMs?: number;
    readonly providerInstanceId?: ProviderInstanceId;
    readonly isolationRootDir?: string;
  },
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "claude";
    const probeEnv = buildClaudeProcessEnv({
      homePath,
      environment,
      homeDir,
      providerInstanceId: options?.providerInstanceId,
      isolationRootDir: options?.isolationRootDir,
    });

    // Probe 1: `claude --version` — is the CLI reachable?
    const versionProbe = yield* runClaudeCommand(["--version"], executable, probeEnv).pipe(
      Effect.timeoutOption(CLAUDE_HEALTH_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        instanceId: CLAUDE_AGENT_PROVIDER,
        driver: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
          : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        instanceId: CLAUDE_AGENT_PROVIDER,
        driver: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      };
    }

    const version = versionProbe.success.value;
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        instanceId: CLAUDE_AGENT_PROVIDER,
        driver: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Claude Agent CLI is installed but failed to run. ${detail}`
          : "Claude Agent CLI is installed but failed to run.",
      };
    }
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    // Probe 2: `claude auth status` — is the user authenticated? The command can
    // redeem a single-use rotating OAuth refresh token, so it is serialized with
    // every other `claude auth status` invocation in this process (credential
    // keepalive, concurrent health probes) via the shared lock.
    const runAuthStatusProbe = Effect.acquireUseRelease(
      Effect.promise(() => acquireClaudeAuthStatusLock()),
      () =>
        runClaudeCommand(["auth", "status"], executable, probeEnv).pipe(
          Effect.timeoutOption(CLAUDE_HEALTH_TIMEOUT_MS),
        ),
      (release) => Effect.sync(release),
    ).pipe(Effect.result);

    const authProbe = yield* runAuthStatusProbe;

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        instanceId: CLAUDE_AGENT_PROVIDER,
        driver: CLAUDE_AGENT_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify Claude authentication status: ${error.message}.`
            : "Could not verify Claude authentication status.",
      };
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        instanceId: CLAUDE_AGENT_PROVIDER,
        driver: CLAUDE_AGENT_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message: "Could not verify Claude authentication status. Timed out while running command.",
      };
    }

    let authOutput = authProbe.success.value;
    let parsed = parseClaudeAuthStatusFromOutput(authOutput);
    const credentialsHome = nonEmptyTrimmed(probeEnv.HOME) ?? homeDir;
    const credentialSummary = readClaudeCliCredentialsSummary(
      credentialsHome ? { env: probeEnv, homeDir: credentialsHome } : { env: probeEnv },
    );
    // A structured `loggedIn:false` with a clean exit and no local credential
    // record to rescue it (macOS keeps OAuth in the Keychain, not on disk) is
    // the signature of a lost refresh-token rotation race with a concurrent
    // `claude auth status` invocation. Re-probe once after the rotation settles.
    if (
      !credentialSummary.usable &&
      isStructuredClaudeAuthFalseNegativeCandidate(authOutput, parsed)
    ) {
      const retryDelayMs =
        options?.falseNegativeRetryDelayMs ?? CLAUDE_AUTH_FALSE_NEGATIVE_RETRY_DELAY_MS;
      if (retryDelayMs > 0) {
        yield* Effect.sleep(retryDelayMs);
      }
      const retryProbe = yield* runAuthStatusProbe;
      if (Result.isSuccess(retryProbe) && Option.isSome(retryProbe.success)) {
        authOutput = retryProbe.success.value;
        parsed = parseClaudeAuthStatusFromOutput(authOutput);
      }
    }
    const structuredFalseNegative = isStructuredClaudeAuthFalseNegativeCandidate(
      authOutput,
      parsed,
    );
    const credentialProbeSubscriptionType =
      credentialSummary.usable && structuredFalseNegative && resolveSubscriptionType
        ? yield* resolveSubscriptionType
        : undefined;
    // Claude 2.1.x can report `loggedIn:false` from `auth status` while a live
    // SDK init still reads account metadata. Token strings alone are not enough:
    // require the SDK probe before treating the credential file as authenticated.
    const effectiveParsed: ReturnType<typeof parseClaudeAuthStatusFromOutput> =
      credentialProbeSubscriptionType !== undefined
        ? { status: "ready", authStatus: "authenticated" }
        : parsed;
    const useCredentialMetadata = credentialProbeSubscriptionType !== undefined;

    // Determine subscription type from multiple sources (cheapest first):
    // 1. JSON output of `claude auth status` (may or may not contain it)
    // 2. Cached SDK probe (spawns a Claude process on miss, reads
    //    `initializationResult()` for account metadata, then aborts
    //    immediately — no API tokens are consumed)
    let subscriptionType =
      extractSubscriptionTypeFromOutput(authOutput) ??
      credentialProbeSubscriptionType ??
      (useCredentialMetadata ? credentialSummary.subscriptionType : undefined);
    const authMethod =
      extractClaudeAuthMethodFromOutput(authOutput) ??
      (useCredentialMetadata ? "claude.ai" : undefined);
    if (
      !subscriptionType &&
      resolveSubscriptionType &&
      effectiveParsed.authStatus === "authenticated"
    ) {
      subscriptionType = yield* resolveSubscriptionType;
    }
    const authMetadata = claudeAuthMetadata({ subscriptionType, authMethod });

    return {
      provider: CLAUDE_AGENT_PROVIDER,
      instanceId: CLAUDE_AGENT_PROVIDER,
      driver: CLAUDE_AGENT_PROVIDER,
      status: effectiveParsed.status,
      available: true,
      authStatus: effectiveParsed.authStatus,
      version: parsedVersion,
      ...(authMetadata ? { authType: authMetadata.type, authLabel: authMetadata.label } : {}),
      checkedAt,
      ...(effectiveParsed.message ? { message: effectiveParsed.message } : {}),
    } satisfies ServerProviderStatus;
  });

export const checkClaudeProviderStatus = makeCheckClaudeProviderStatus();

export const makeCheckGeminiProviderStatus = (
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
  instanceId?: string,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "gemini";
    const probeEnvResult = makeProviderProbeEnv(GEMINI_PROVIDER, environment, instanceId, paths);
    if (!probeEnvResult.ok) {
      return providerHomePreparationFailure(GEMINI_PROVIDER, checkedAt, probeEnvResult.cause);
    }
    const probeEnv = probeEnvResult.env;

    const versionProbe = yield* runGeminiCommand(["--version"], executable, probeEnv).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: GEMINI_PROVIDER,
        instanceId: GEMINI_PROVIDER,
        driver: GEMINI_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: isCommandMissingCause(error)
          ? "Gemini CLI (`gemini`) is not installed or not on PATH."
          : `Failed to execute Gemini CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: GEMINI_PROVIDER,
        instanceId: GEMINI_PROVIDER,
        driver: GEMINI_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Gemini CLI is installed but failed to run. Timed out while running command.",
      };
    }

    const version = versionProbe.success.value;
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: GEMINI_PROVIDER,
        instanceId: GEMINI_PROVIDER,
        driver: GEMINI_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Gemini CLI is installed but failed to run. ${detail}`
          : "Gemini CLI is installed but failed to run.",
      };
    }
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    const capabilityProbe = yield* probeGeminiCapabilities({
      binaryPath: executable,
      cwd: OS.homedir(),
      ...(instanceId !== undefined ? { instanceId } : {}),
      ...(environment !== undefined ? { environment } : {}),
      ...(paths ? { homeDir: paths.homeDir, isolationRootDir: paths.isolationRootDir } : {}),
    }).pipe(Effect.result);

    if (Result.isFailure(capabilityProbe)) {
      const error = capabilityProbe.failure;
      return {
        provider: GEMINI_PROVIDER,
        instanceId: GEMINI_PROVIDER,
        driver: GEMINI_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify Gemini authentication status: ${error.message}.`
            : "Could not verify Gemini authentication status.",
      };
    }

    const parsed = normalizeGeminiCapabilityProbeResult(capabilityProbe.success);
    return {
      provider: GEMINI_PROVIDER,
      instanceId: GEMINI_PROVIDER,
      driver: GEMINI_PROVIDER,
      status: parsed.status,
      available: true,
      authStatus: parsed.auth.status,
      version: parsedVersion,
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
    } satisfies ServerProviderStatus;
  });

export const checkGeminiProviderStatus = makeCheckGeminiProviderStatus();

// ── Grok health check ───────────────────────────────────────────────

export const makeCheckGrokProviderStatus = (
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
  instanceId?: string,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "grok";
    const probeEnvResult = makeProviderProbeEnv(GROK_PROVIDER, environment, instanceId, paths);
    if (!probeEnvResult.ok) {
      return providerHomePreparationFailure(GROK_PROVIDER, checkedAt, probeEnvResult.cause);
    }
    const probeEnv = probeEnvResult.env;

    const versionProbe = yield* runGrokCommand(["--version"], executable, probeEnv).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: GROK_PROVIDER,
        instanceId: GROK_PROVIDER,
        driver: GROK_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: isCommandMissingCause(error)
          ? "Grok CLI (`grok`) is not installed or not on PATH."
          : `Failed to execute Grok CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: GROK_PROVIDER,
        instanceId: GROK_PROVIDER,
        driver: GROK_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Grok CLI is installed but failed to run. Timed out while running command.",
      } satisfies ServerProviderStatus;
    }

    const version = versionProbe.success.value;
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: GROK_PROVIDER,
        instanceId: GROK_PROVIDER,
        driver: GROK_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Grok CLI is installed but failed to run. ${detail}`
          : "Grok CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
    const hasApiKey = hasGrokApiKeyEnv(probeEnv);

    return {
      provider: GROK_PROVIDER,
      instanceId: GROK_PROVIDER,
      driver: GROK_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: hasApiKey ? ("authenticated" as const) : ("unknown" as const),
      version: parsedVersion,
      checkedAt,
      ...(hasApiKey
        ? { authType: "apiKey", authLabel: "xAI API Key" }
        : {
            message:
              "Grok CLI is installed. Run `grok` to authenticate locally, or set XAI_API_KEY before starting a session.",
          }),
    } satisfies ServerProviderStatus;
  });

export const checkGrokProviderStatus = makeCheckGrokProviderStatus();

function openCodeCompatibleExternalServerStatus(input: {
  readonly provider: typeof OPENCODE_PROVIDER | typeof KILO_PROVIDER;
  readonly checkedAt: string;
  readonly serverUrl: string;
  readonly hasServerPassword: boolean;
  readonly experimentalWebSockets?: boolean | undefined;
}): ServerProviderStatus {
  try {
    new URL(input.serverUrl);
  } catch {
    return {
      provider: input.provider,
      instanceId: input.provider,
      driver: input.provider,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt: input.checkedAt,
      message: `Configured ${input.provider === OPENCODE_PROVIDER ? "OpenCode" : "Kilo"} server URL is invalid.`,
    } satisfies ServerProviderStatus;
  }

  const label = input.provider === OPENCODE_PROVIDER ? "OpenCode" : "Kilo";
  return {
    provider: input.provider,
    instanceId: input.provider,
    driver: input.provider,
    status: "ready" as const,
    available: true,
    authStatus: "unknown" as const,
    checkedAt: input.checkedAt,
    ...(input.hasServerPassword
      ? { authType: "serverPassword", authLabel: "Configured server password" }
      : {}),
    message: `${label} will use the configured server at ${input.serverUrl}${input.experimentalWebSockets ? " with experimental WebSockets enabled" : ""}.`,
  } satisfies ServerProviderStatus;
}

// ── OpenCode health check ───────────────────────────────────────────

export const makeCheckOpenCodeProviderStatus = (
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
  connection?: {
    readonly serverUrl?: string | undefined;
    readonly serverPassword?: string | undefined;
    readonly experimentalWebSockets?: boolean | undefined;
  },
  instanceId?: string,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const configuredServerUrl = nonEmptyTrimmed(connection?.serverUrl);
    if (configuredServerUrl) {
      return openCodeCompatibleExternalServerStatus({
        provider: OPENCODE_PROVIDER,
        checkedAt,
        serverUrl: configuredServerUrl,
        hasServerPassword: nonEmptyTrimmed(connection?.serverPassword) !== undefined,
        experimentalWebSockets: connection?.experimentalWebSockets,
      });
    }

    const executable = nonEmptyTrimmed(binaryPath) ?? "opencode";
    const probeEnvResult = makeProviderProbeEnv(OPENCODE_PROVIDER, environment, instanceId, paths);
    if (!probeEnvResult.ok) {
      return providerHomePreparationFailure(OPENCODE_PROVIDER, checkedAt, probeEnvResult.cause);
    }
    const probeEnv = probeEnvResult.env;

    const versionProbe = yield* runOpenCodeCommand(["--version"], executable, probeEnv).pipe(
      Effect.timeoutOption(OPENCODE_HEALTH_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: OPENCODE_PROVIDER,
        instanceId: OPENCODE_PROVIDER,
        driver: OPENCODE_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: isCommandMissingCause(error)
          ? "OpenCode CLI (`opencode`) is not installed or not on PATH."
          : `Failed to execute OpenCode CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: OPENCODE_PROVIDER,
        instanceId: OPENCODE_PROVIDER,
        driver: OPENCODE_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: `OpenCode CLI is installed but failed to run. ${PROVIDER_COMMAND_TIMEOUT_DETAIL}`,
      } satisfies ServerProviderStatus;
    }

    const version = versionProbe.success.value;
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: OPENCODE_PROVIDER,
        instanceId: OPENCODE_PROVIDER,
        driver: OPENCODE_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `OpenCode CLI is installed but failed to run. ${detail}`
          : "OpenCode CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    return {
      provider: OPENCODE_PROVIDER,
      instanceId: OPENCODE_PROVIDER,
      driver: OPENCODE_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "unknown" as const,
      version: parsedVersion,
      checkedAt,
      message:
        "OpenCode CLI is installed. Configure provider credentials inside OpenCode as needed.",
    } satisfies ServerProviderStatus;
  });

export const checkOpenCodeProviderStatus = makeCheckOpenCodeProviderStatus();

// ── Kilo health check ───────────────────────────────────────────────

export const makeCheckKiloProviderStatus = (
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
  connection?: {
    readonly serverUrl?: string | undefined;
    readonly serverPassword?: string | undefined;
  },
  instanceId?: string,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const configuredServerUrl = nonEmptyTrimmed(connection?.serverUrl);
    if (configuredServerUrl) {
      return openCodeCompatibleExternalServerStatus({
        provider: KILO_PROVIDER,
        checkedAt,
        serverUrl: configuredServerUrl,
        hasServerPassword: nonEmptyTrimmed(connection?.serverPassword) !== undefined,
      });
    }

    const executable = nonEmptyTrimmed(binaryPath) ?? "kilo";
    const probeEnvResult = makeProviderProbeEnv(KILO_PROVIDER, environment, instanceId, paths);
    if (!probeEnvResult.ok) {
      return providerHomePreparationFailure(KILO_PROVIDER, checkedAt, probeEnvResult.cause);
    }
    const probeEnv = probeEnvResult.env;

    const versionProbe = yield* runKiloCommand(["--version"], executable, probeEnv).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: KILO_PROVIDER,
        instanceId: KILO_PROVIDER,
        driver: KILO_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: isCommandMissingCause(error)
          ? "Kilo CLI (`kilo`) is not installed or not on PATH."
          : `Failed to execute Kilo CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: KILO_PROVIDER,
        instanceId: KILO_PROVIDER,
        driver: KILO_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Kilo CLI is installed but failed to run. Timed out while running command.",
      } satisfies ServerProviderStatus;
    }

    const version = versionProbe.success.value;
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: KILO_PROVIDER,
        instanceId: KILO_PROVIDER,
        driver: KILO_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Kilo CLI is installed but failed to run. ${detail}`
          : "Kilo CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    return {
      provider: KILO_PROVIDER,
      instanceId: KILO_PROVIDER,
      driver: KILO_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "unknown" as const,
      version: parsedVersion,
      checkedAt,
      message: "Kilo CLI is installed. Configure provider credentials inside Kilo as needed.",
    } satisfies ServerProviderStatus;
  });

export const checkKiloProviderStatus = makeCheckKiloProviderStatus();

// ── Pi health check ─────────────────────────────────────────────

export const checkPiProviderStatus = (
  agentDir?: string,
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
  instanceId?: string,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "pi";
    const probeEnvResult = makeProviderProbeEnv(PI_PROVIDER, environment, instanceId, paths);
    if (!probeEnvResult.ok) {
      return providerHomePreparationFailure(PI_PROVIDER, checkedAt, probeEnvResult.cause);
    }
    const probeEnv = probeEnvResult.env;

    const versionProbe = yield* runPiCommand(["--version"], executable, probeEnv).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    // Pi itself is SDK-backed in Synara. Keep this CLI probe advisory so health
    // refreshes do not import the SDK and initialize its native clipboard module.
    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: PI_PROVIDER,
        instanceId: PI_PROVIDER,
        driver: PI_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message: isCommandMissingCause(error)
          ? "Pi SDK is bundled, but the Pi CLI (`pi`) is not on PATH, so Synara could not verify the installed CLI version."
          : `Pi SDK is bundled, but the CLI health check failed: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: PI_PROVIDER,
        instanceId: PI_PROVIDER,
        driver: PI_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          "Pi SDK is bundled, but the CLI health check timed out before Synara could verify the installed version.",
      } satisfies ServerProviderStatus;
    }

    const version = versionProbe.success.value;
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: PI_PROVIDER,
        instanceId: PI_PROVIDER,
        driver: PI_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Pi SDK is bundled, but the CLI health check failed. ${detail}`
          : "Pi SDK is bundled, but the CLI health check failed.",
      } satisfies ServerProviderStatus;
    }

    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
    const configuredAgentDir = nonEmptyTrimmed(agentDir);
    return {
      provider: PI_PROVIDER,
      instanceId: PI_PROVIDER,
      driver: PI_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "unknown" as const,
      version: parsedVersion,
      checkedAt,
      message: configuredAgentDir
        ? `Pi CLI is installed. Synara will use Pi agent dir ${configuredAgentDir}.`
        : "Pi CLI is installed. Configure provider credentials inside Pi as needed.",
    } satisfies ServerProviderStatus;
  });

// ── Cursor health check ─────────────────────────────────────────────

export const makeCheckCursorProviderStatus = (
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
  instanceId?: string,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = resolveCursorAgentBinaryPath(nonEmptyTrimmed(binaryPath));
    const probeEnvResult = makeProviderProbeEnv(CURSOR_PROVIDER, environment, instanceId, paths);
    if (!probeEnvResult.ok) {
      return providerHomePreparationFailure(CURSOR_PROVIDER, checkedAt, probeEnvResult.cause);
    }
    const probeEnv = probeEnvResult.env;

    const versionProbe = yield* runCursorCommand(["--version"], executable, probeEnv).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: isCommandMissingCause(error)
          ? "Cursor Agent CLI (`cursor-agent`) is not installed or not on PATH."
          : `Failed to execute Cursor Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          "Cursor Agent CLI is installed but failed to run. Timed out while running command.",
      } satisfies ServerProviderStatus;
    }

    const version = versionProbe.success.value;
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Cursor Agent CLI is installed but failed to run. ${detail}`
          : "Cursor Agent CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    const authProbe = yield* runCursorCommand(["status"], executable, probeEnv).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify Cursor Agent authentication status: ${error.message}.`
            : "Could not verify Cursor Agent authentication status.",
      } satisfies ServerProviderStatus;
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message:
          "Could not verify Cursor Agent authentication status. Timed out while running command.",
      } satisfies ServerProviderStatus;
    }

    const parsedAuth = parseCursorAuthStatusFromOutput(authProbe.success.value);
    if (parsedAuth.authStatus !== "authenticated") {
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: parsedAuth.status,
        available: true,
        authStatus: parsedAuth.authStatus,
        version: parsedVersion,
        checkedAt,
        ...(parsedAuth.message ? { message: parsedAuth.message } : {}),
      } satisfies ServerProviderStatus;
    }

    const modelsProbe = yield* runCursorCommand(["models"], executable, probeEnv).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(modelsProbe)) {
      const error = modelsProbe.failure;
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "authenticated" as const,
        version: parsedVersion,
        checkedAt,
        message:
          error instanceof Error
            ? `Cursor Agent is authenticated, but model discovery failed: ${error.message}.`
            : "Cursor Agent is authenticated, but model discovery failed.",
      } satisfies ServerProviderStatus;
    }

    if (Option.isNone(modelsProbe.success)) {
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "authenticated" as const,
        version: parsedVersion,
        checkedAt,
        message:
          "Cursor Agent is authenticated, but model discovery timed out before Synara could verify available models.",
      } satisfies ServerProviderStatus;
    }

    const modelsResult = modelsProbe.success.value;
    const modelsOutput = `${modelsResult.stdout}\n${modelsResult.stderr}`;
    const modelAuth = parseCursorAuthStatusFromOutput(modelsResult);
    if (modelAuth.authStatus === "unauthenticated") {
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: modelAuth.status,
        available: true,
        authStatus: modelAuth.authStatus,
        version: parsedVersion,
        checkedAt,
        ...(modelAuth.message ? { message: modelAuth.message } : {}),
      } satisfies ServerProviderStatus;
    }
    if (cursorModelsOutputHasNoModels(modelsOutput)) {
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "authenticated" as const,
        version: parsedVersion,
        checkedAt,
        message:
          "Cursor Agent is authenticated, but it reports no models available for this account.",
      } satisfies ServerProviderStatus;
    }
    if (modelsResult.code !== 0) {
      const detail = detailFromResult(modelsResult);
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "authenticated" as const,
        version: parsedVersion,
        checkedAt,
        message: detail
          ? `Cursor Agent is authenticated, but model discovery failed. ${detail}`
          : "Cursor Agent is authenticated, but model discovery failed.",
      } satisfies ServerProviderStatus;
    }
    if (!cursorModelsOutputHasModels(modelsOutput)) {
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "authenticated" as const,
        version: parsedVersion,
        checkedAt,
        message:
          "Cursor Agent is authenticated, but model discovery returned no recognizable model rows.",
      } satisfies ServerProviderStatus;
    }

    return {
      provider: CURSOR_PROVIDER,
      instanceId: CURSOR_PROVIDER,
      driver: CURSOR_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "authenticated" as const,
      version: parsedVersion,
      checkedAt,
    } satisfies ServerProviderStatus;
  });

export const checkCursorProviderStatus = makeCheckCursorProviderStatus();

// ── Snapshot helpers ────────────────────────────────────────────────

function comparableProviderVersionAdvisory(
  advisory: ServerProviderStatus["versionAdvisory"] | undefined,
): Omit<NonNullable<ServerProviderStatus["versionAdvisory"]>, "checkedAt"> | null {
  if (!advisory) {
    return null;
  }
  const { checkedAt: _checkedAt, ...comparableAdvisory } = advisory;
  return comparableAdvisory;
}

export function providerStatusesEqual(
  left: ReadonlyArray<ServerProviderStatus>,
  right: ReadonlyArray<ServerProviderStatus>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((status, index) => {
    const next = right[index];
    return (
      next !== undefined &&
      status.provider === next.provider &&
      (status.instanceId ?? null) === (next.instanceId ?? null) &&
      (status.driver ?? null) === (next.driver ?? null) &&
      (status.displayName ?? null) === (next.displayName ?? null) &&
      (status.enabled ?? null) === (next.enabled ?? null) &&
      status.status === next.status &&
      status.available === next.available &&
      status.authStatus === next.authStatus &&
      (status.authType ?? null) === (next.authType ?? null) &&
      (status.authLabel ?? null) === (next.authLabel ?? null) &&
      status.voiceTranscriptionAvailable === next.voiceTranscriptionAvailable &&
      (status.version ?? null) === (next.version ?? null) &&
      (status.message ?? null) === (next.message ?? null) &&
      JSON.stringify(comparableProviderVersionAdvisory(status.versionAdvisory)) ===
        JSON.stringify(comparableProviderVersionAdvisory(next.versionAdvisory)) &&
      JSON.stringify(status.updateState ?? null) === JSON.stringify(next.updateState ?? null)
    );
  });
}

function isTransientProviderCommandTimeout(status: ServerProviderStatus): boolean {
  return (
    status.status !== "ready" &&
    status.authStatus === "unknown" &&
    (status.message ?? "").includes(PROVIDER_COMMAND_TIMEOUT_DETAIL)
  );
}

function wasPreviouslyUsableProviderStatus(status: ServerProviderStatus): boolean {
  return status.available && status.status === "ready";
}

export function stabilizeProviderStatusesAgainstTransientTimeouts(
  previousStatuses: ReadonlyArray<ServerProviderStatus>,
  nextStatuses: ReadonlyArray<ServerProviderStatus>,
): ReadonlyArray<ServerProviderStatus> {
  if (previousStatuses.length === 0) {
    return nextStatuses;
  }

  const previousByInstance = new Map(
    previousStatuses.map((status) => [providerStatusIdentityKey(status), status] as const),
  );

  return nextStatuses.map((status) => {
    const previous = previousByInstance.get(providerStatusIdentityKey(status));
    if (
      !previous ||
      !wasPreviouslyUsableProviderStatus(previous) ||
      !isTransientProviderCommandTimeout(status)
    ) {
      return status;
    }

    // A single slow CLI probe should not make an already usable provider look broken.
    return {
      ...previous,
      checkedAt: status.checkedAt,
      ...(status.updateState !== undefined ? { updateState: status.updateState } : {}),
    };
  });
}

export function isProviderEnabledForSettings(
  provider: ProviderKind,
  settings: ServerSettings,
): boolean {
  return settings.providers[provider].enabled !== false;
}

export function makeDisabledProviderStatus(
  provider: ProviderKind,
  checkedAt = new Date().toISOString(),
): ServerProviderStatus {
  return {
    provider,
    instanceId: provider,
    driver: provider,
    status: "warning" as const,
    available: false,
    authStatus: "unknown" as const,
    checkedAt,
    message: DISABLED_PROVIDER_STATUS_MESSAGE,
  } satisfies ServerProviderStatus;
}

function isDisabledProviderStatusOverlay(status: ServerProviderStatus): boolean {
  return status.message === DISABLED_PROVIDER_STATUS_MESSAGE && status.available === false;
}

interface ProviderStatusProjectionInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderKind;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly isDefault?: boolean;
}

function projectStatusForProviderInstance(
  status: ServerProviderStatus,
  instance: ProviderStatusProjectionInstance,
): ServerProviderStatus {
  const projected = {
    ...status,
    instanceId: instance.instanceId,
    driver: instance.driver,
    displayName: instance.displayName,
    enabled: instance.enabled,
  } satisfies ServerProviderStatus;
  const isExactInstanceStatus =
    providerStatusInstanceKey(status) === instance.instanceId &&
    (status.driver ?? status.provider) === instance.driver;
  if (isExactInstanceStatus || instance.isDefault || status.authStatus === "unknown") {
    return projected;
  }
  const { authType, authLabel, voiceTranscriptionAvailable, ...withoutAuthMetadata } = projected;
  void authType;
  void authLabel;
  void voiceTranscriptionAvailable;
  return {
    ...withoutAuthMetadata,
    status: projected.status === "ready" ? "warning" : projected.status,
    authStatus: "unknown",
    message: projected.message ?? "Authentication has not been checked for this provider instance.",
  } satisfies ServerProviderStatus;
}

function makeUncheckedProviderInstanceStatus(
  provider: ProviderKind,
  instance: ProviderStatusProjectionInstance,
  checkedAt: string,
): ServerProviderStatus {
  return {
    provider,
    instanceId: instance.instanceId,
    driver: instance.driver,
    displayName: instance.displayName,
    enabled: instance.enabled,
    status: "warning",
    available: false,
    authStatus: "unknown",
    checkedAt,
    message: "Provider instance has not been checked yet.",
  } satisfies ServerProviderStatus;
}

function makeUnsupportedProviderInstanceStatus(
  instance: UnsupportedProviderInstance,
  checkedAt: string,
): ServerProviderStatus {
  const unavailableReason = `Provider driver '${instance.driver}' is not supported by this Synara build.`;
  return {
    provider: instance.driver,
    instanceId: instance.instanceId,
    driver: instance.driver,
    displayName: instance.displayName,
    enabled: false,
    status: "error",
    available: false,
    availability: "unavailable",
    unavailableReason,
    authStatus: "unknown",
    checkedAt,
    message: unavailableReason,
  } satisfies ServerProviderStatus;
}

function mergeProviderStatusUpdates(
  previousStatuses: ReadonlyArray<ServerProviderStatus>,
  updatedStatuses: ReadonlyArray<ServerProviderStatus>,
): ProviderStatuses {
  const statusByInstance = new Map(
    previousStatuses.map((status) => [providerStatusIdentityKey(status), status] as const),
  );
  for (const status of updatedStatuses) {
    const instanceId = providerStatusInstanceKey(status);
    for (const [key, previous] of statusByInstance) {
      if (
        providerStatusInstanceKey(previous) === instanceId &&
        providerStatusIdentityKey(previous) !== providerStatusIdentityKey(status)
      ) {
        statusByInstance.delete(key);
      }
    }
    statusByInstance.set(providerStatusIdentityKey(status), status);
  }
  return orderProviderStatuses([...statusByInstance.values()]);
}

// Keeps local CLI version/status visible while removing network-backed update metadata.
function makeSuppressedProviderVersionAdvisory(
  status: ServerProviderStatus,
  currentVersion?: string | null,
): NonNullable<ServerProviderStatus["versionAdvisory"]> {
  return {
    status: "unknown",
    currentVersion: currentVersion ?? status.version ?? null,
    latestVersion: null,
    updateCommand: null,
    canUpdate: false,
    checkedAt: status.checkedAt,
    message: null,
  };
}

function suppressProviderVersionAdvisory(status: ServerProviderStatus): ServerProviderStatus {
  return {
    ...status,
    versionAdvisory: makeSuppressedProviderVersionAdvisory(status),
  };
}

// Disabled providers are a settings overlay, not a probe result. Keep the raw
// cached/probed status intact so re-enabling a provider can reuse it immediately.
export function projectProviderStatusesForSettings(
  statuses: ReadonlyArray<ServerProviderStatus>,
  settings: ServerSettings,
  checkedAt = new Date().toISOString(),
): ProviderStatuses {
  const statusByInstance = new Map(
    statuses.map((status) => [providerStatusIdentityKey(status), status] as const),
  );
  const instancesByProvider = new Map<ProviderKind, ReturnType<typeof deriveProviderInstances>>();
  for (const instance of deriveProviderInstances(settings)) {
    const entries = instancesByProvider.get(instance.driver) ?? [];
    instancesByProvider.set(instance.driver, [...entries, instance]);
  }
  const projected: ServerProviderStatus[] = [];

  for (const provider of PROVIDERS) {
    const providerInstances = instancesByProvider.get(provider) ?? [];
    const instances: ReadonlyArray<ResolvedProviderInstance> =
      providerInstances.length > 0
        ? providerInstances
        : [
            {
              instanceId: provider,
              driver: provider,
              displayName: provider,
              enabled: true,
              isDefault: true,
              config: {},
              environment: {},
              raw: { driver: provider },
            },
          ];
    const projectStatusForInstances = (baseStatus: ServerProviderStatus) => {
      for (const instance of instances) {
        projected.push(projectStatusForProviderInstance(baseStatus, instance));
      }
    };

    const defaultStatus = statusByInstance.get(
      providerTargetIdentityKey({ provider, instanceId: provider }),
    );
    if (instances.every((instance) => !instance.enabled)) {
      const disabledStatus = makeDisabledProviderStatus(
        provider,
        defaultStatus?.checkedAt ?? checkedAt,
      );
      const disabledStatusWithAdvisory = {
        ...disabledStatus,
        versionAdvisory: makeSuppressedProviderVersionAdvisory(
          disabledStatus,
          defaultStatus?.version,
        ),
      } satisfies ServerProviderStatus;
      projectStatusForInstances(
        defaultStatus?.updateState
          ? { ...disabledStatusWithAdvisory, updateState: defaultStatus.updateState }
          : disabledStatusWithAdvisory,
      );
      continue;
    }

    for (const instance of instances) {
      const exactStatus = statusByInstance.get(
        providerTargetIdentityKey({
          provider: instance.driver,
          instanceId: instance.instanceId,
        }),
      );
      const status = exactStatus ?? (instance.isDefault ? defaultStatus : undefined);
      if (!instance.enabled) {
        projected.push({
          ...makeDisabledProviderStatus(provider, status?.checkedAt ?? checkedAt),
          instanceId: instance.instanceId,
          driver: instance.driver,
          displayName: instance.displayName,
          enabled: false,
        });
        continue;
      }
      if (status && !isDisabledProviderStatusOverlay(status)) {
        const instanceStatus = projectStatusForProviderInstance(status, instance);
        projected.push(
          settings.enableProviderUpdateChecks
            ? instanceStatus
            : suppressProviderVersionAdvisory(instanceStatus),
        );
        continue;
      }
      if (!instance.isDefault || instances.length > 1) {
        projected.push(
          makeUncheckedProviderInstanceStatus(
            provider,
            instance,
            defaultStatus?.checkedAt ?? checkedAt,
          ),
        );
      }
    }
  }

  for (const instance of deriveUnsupportedProviderInstances(settings)) {
    projected.push(makeUnsupportedProviderInstanceStatus(instance, checkedAt));
  }

  return orderProviderStatuses(projected);
}

// ── Layer ───────────────────────────────────────────────────────────

export const ProviderHealthLive = Layer.effect(
  ProviderHealth,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProviderStatus>>(),
      PubSub.shutdown,
    );
    const refreshScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(refreshScope, Exit.void));

    const cachePathForProviderTarget = (input: {
      readonly provider: ServerProviderStatus["provider"];
      readonly instanceId?: ProviderInstanceId | undefined;
    }) =>
      resolveProviderStatusCachePath({
        stateDir: serverConfig.stateDir,
        provider: input.provider,
        ...(input.instanceId && input.instanceId !== input.provider
          ? { instanceId: input.instanceId }
          : {}),
      });

    const initialSettings = yield* serverSettings.getSettings;
    const initialInstances = deriveProviderInstances(initialSettings);
    const cachedStatuses: ProviderStatuses = yield* Effect.forEach(
      initialInstances,
      (instance) =>
        readProviderStatusCache(
          cachePathForProviderTarget({
            provider: instance.driver,
            instanceId: instance.instanceId,
          }),
          {
            provider: instance.driver,
            instanceId: instance.instanceId,
          },
        ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((statuses) =>
        orderProviderStatuses(
          statuses.filter(
            (status): status is ServerProviderStatus =>
              status !== undefined && !isDisabledProviderStatusOverlay(status),
          ),
        ),
      ),
    );

    const statusesRef = yield* Ref.make<ProviderStatuses>(cachedStatuses);
    const updateStatesRef = yield* Ref.make<ReadonlyMap<string, ServerProviderUpdateState>>(
      new Map(),
    );
    const refreshFiberRef = yield* Ref.make<Fiber.Fiber<ProviderStatuses, never> | null>(null);
    const commandCoordinator = yield* makeProviderMaintenanceCommandCoordinator({
      makeAlreadyRunningError: (provider) =>
        new ServerProviderUpdateError({
          provider: provider as ProviderKind,
          reason: "An update is already running for this provider.",
        }),
    });

    // 5-minute TTL cache for Claude SDK subscription probes. Each key is scoped
    // to the same binary/home/env envelope used by CLI health and discovery.
    const claudeSubscriptionCacheRef = yield* Ref.make(
      new Map<string, { readonly expiresAt: number; readonly subscriptionType?: string }>(),
    );
    const resolveClaudeSubscription = (input: ClaudeSubscriptionProbeInput) =>
      Effect.gen(function* () {
        const key = claudeSubscriptionProbeKey(input);
        const now = Date.now();
        const cached = (yield* Ref.get(claudeSubscriptionCacheRef)).get(key);
        if (cached && cached.expiresAt > now) {
          return cached.subscriptionType;
        }
        const probe = yield* probeClaudeSubscription(input);
        const subscriptionType = probe?.subscriptionType;
        yield* Ref.update(claudeSubscriptionCacheRef, (cache) => {
          const next = new Map(cache);
          next.set(key, {
            expiresAt: now + CLAUDE_SUBSCRIPTION_CACHE_TTL_MS,
            ...(subscriptionType !== undefined ? { subscriptionType } : {}),
          });
          return next;
        });
        return subscriptionType;
      });

    const readInstanceConfigString = (
      instance: ResolvedProviderInstance,
      key: string,
    ): string | undefined => {
      const value = instance.config[key];
      return typeof value === "string" ? nonEmptyTrimmed(value) : undefined;
    };
    const readInstanceConfigBoolean = (
      instance: ResolvedProviderInstance,
      key: string,
    ): boolean | undefined => {
      const value = instance.config[key];
      return typeof value === "boolean" ? value : undefined;
    };

    const resolveProviderInstanceTarget = (
      settings: ServerSettings,
      target: {
        readonly provider: ProviderKind;
        readonly instanceId?: ProviderInstanceId | undefined;
      },
    ): ResolvedProviderInstance | null => {
      const targetInstanceId = target.instanceId ?? target.provider;
      const instances = deriveProviderInstances(settings).filter(
        (instance) => instance.driver === target.provider,
      );
      const exactInstance = instances.find((instance) => instance.instanceId === targetInstanceId);
      if (exactInstance || target.instanceId !== undefined) {
        return exactInstance ?? null;
      }
      return instances.find((instance) => instance.isDefault) ?? null;
    };

    const stampProviderStatusForInstance = (
      status: ServerProviderStatus,
      instance: ResolvedProviderInstance,
    ): ServerProviderStatus =>
      ({
        ...status,
        instanceId: instance.instanceId,
        driver: instance.driver,
        displayName: instance.displayName,
        enabled: instance.enabled,
      }) satisfies ServerProviderStatus;

    const makeManualProviderMaintenanceCapabilities = (provider: ProviderKind) =>
      makeProviderMaintenanceCapabilities({
        provider,
        packageName: null,
        latestVersionSource: null,
        updateExecutable: null,
        updateArgs: [],
        updateLockKey: null,
      });

    const getProviderMaintenanceCapabilities = Effect.fn("getProviderMaintenanceCapabilities")(
      function* (target: {
        readonly provider: ProviderKind;
        readonly instanceId?: ProviderInstanceId | undefined;
      }) {
        const settings = yield* serverSettings.getSettings;
        const instance = resolveProviderInstanceTarget(settings, target);
        if (!instance || !instance.enabled) {
          return makeManualProviderMaintenanceCapabilities(target.provider);
        }
        const binaryPath = readInstanceConfigString(instance, "binaryPath");
        if (target.provider === "cursor") {
          const command = buildCursorAgentCommand(binaryPath, ["update"]);
          return makeProviderMaintenanceCapabilities({
            provider: target.provider,
            packageName: null,
            updateExecutable: command.command,
            updateArgs: command.args,
            updateLockKey: "cursor-agent",
          });
        }
        const definition = PACKAGE_MANAGED_PROVIDER_UPDATES[target.provider];
        if (!definition) {
          return makeManualProviderMaintenanceCapabilities(target.provider);
        }
        return yield* resolveProviderMaintenanceCapabilitiesEffect(definition, {
          binaryPath: binaryPath ?? null,
          env: process.env,
          platform: process.platform,
        }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
      },
    );

    const applyVolatileProviderState = Effect.fn("applyVolatileProviderState")(function* (
      status: ServerProviderStatus,
    ) {
      const updateStates = yield* Ref.get(updateStatesRef);
      const updateState = updateStates.get(providerStatusIdentityKey(status));
      if (!updateState) {
        const { updateState: _updateState, ...statusWithoutUpdateState } = status;
        return statusWithoutUpdateState;
      }
      return {
        ...status,
        updateState,
      };
    });

    const applyVolatileProviderStates = (
      statuses: ReadonlyArray<ServerProviderStatus>,
    ): Effect.Effect<ProviderStatuses> =>
      Effect.forEach(statuses, applyVolatileProviderState, {
        concurrency: "unbounded",
      });

    const projectStatusesForCurrentSettings = Effect.fn(
      "projectProviderStatusesForCurrentSettings",
    )(function* (statuses: ReadonlyArray<ServerProviderStatus>) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (!settings) {
        return yield* applyVolatileProviderStates(statuses);
      }
      return yield* applyVolatileProviderStates(
        projectProviderStatusesForSettings(statuses, settings),
      );
    });

    const publishProjectedStatuses = Effect.fn("publishProjectedProviderStatuses")(function* () {
      const rawStatuses = yield* Ref.get(statusesRef);
      const projectedStatuses = yield* projectStatusesForCurrentSettings(rawStatuses);
      yield* PubSub.publish(changesPubSub, projectedStatuses);
      return projectedStatuses;
    });

    const publishProjectedStatusesForSettings = Effect.fn(
      "publishProjectedProviderStatusesForSettings",
    )(function* (settings: ServerSettings) {
      const rawStatuses = yield* Ref.get(statusesRef);
      const projectedStatuses = yield* applyVolatileProviderStates(
        projectProviderStatusesForSettings(rawStatuses, settings),
      );
      yield* PubSub.publish(changesPubSub, projectedStatuses);
      return projectedStatuses;
    });

    const setProviderUpdateState = Effect.fn("setProviderUpdateState")(function* (
      target: {
        readonly provider: ProviderKind;
        readonly instanceId?: ProviderInstanceId | undefined;
      },
      state: ServerProviderUpdateState | null,
    ) {
      const key = providerTargetIdentityKey(target);
      yield* Ref.update(updateStatesRef, (previous) => {
        const next = new Map(previous);
        if (!state || state.status === "idle") {
          next.delete(key);
        } else {
          next.set(key, state);
        }
        return next;
      });

      return yield* publishProjectedStatuses();
    });

    const enrichStatuses = Effect.fn("enrichProviderStatuses")(function* (
      statuses: ReadonlyArray<ServerProviderStatus>,
    ) {
      const settings = yield* serverSettings.ready.pipe(
        Effect.flatMap(() => serverSettings.getSettings),
        Effect.catch(() => Effect.succeed(null)),
      );
      if (settings?.enableProviderUpdateChecks === false) {
        return yield* Effect.forEach(
          statuses.map(suppressProviderVersionAdvisory),
          applyVolatileProviderState,
          { concurrency: "unbounded" },
        );
      }

      const enriched = yield* Effect.forEach(
        statuses,
        (status) => {
          const provider = status.driver ?? status.provider;
          if (!Schema.is(ProviderKind)(provider)) {
            return Effect.succeed(status);
          }
          return getProviderMaintenanceCapabilities({
            provider,
            instanceId: providerStatusInstanceKey(status),
          }).pipe(
            Effect.flatMap((capabilities) =>
              enrichProviderStatusWithVersionAdvisory(status, capabilities),
            ),
            Effect.catch(() =>
              Effect.succeed({
                ...status,
                versionAdvisory: {
                  status: "unknown" as const,
                  currentVersion: status.version ?? null,
                  latestVersion: null,
                  updateCommand: null,
                  canUpdate: false,
                  checkedAt: status.checkedAt,
                  message: null,
                },
              }),
            ),
          );
        },
        { concurrency: "unbounded" },
      );
      return yield* Effect.forEach(enriched, applyVolatileProviderState, {
        concurrency: "unbounded",
      });
    });

    const checkProviderInstanceWhenEnabled = <R>(
      instance: ResolvedProviderInstance,
      check: Effect.Effect<ServerProviderStatus, never, R>,
    ): Effect.Effect<Option.Option<ServerProviderStatus>, never, R> =>
      instance.enabled
        ? check.pipe(
            Effect.map((status) => Option.some(stampProviderStatusForInstance(status, instance))),
          )
        : Effect.succeed(Option.none());

    const checkProviderInstanceStatus = (
      instance: ResolvedProviderInstance,
    ): Effect.Effect<
      Option.Option<ServerProviderStatus>,
      never,
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
    > => {
      const binaryPath = readInstanceConfigString(instance, "binaryPath");
      switch (instance.driver) {
        case "codex": {
          // Launches derive their codex options (including the seeded account
          // discriminator) from providerStartOptionsFromInstance; the status
          // probe must check the same home/auth the instance runs against.
          const codexOptions = providerStartOptionsFromInstance(instance)?.codex;
          return checkProviderInstanceWhenEnabled(
            instance,
            makeCheckCodexProviderStatus(
              binaryPath,
              codexOptions?.homePath,
              codexOptions?.shadowHomePath,
              codexOptions?.accountId,
              instance.environment,
            ),
          );
        }
        case "claudeAgent": {
          const claudeOptions = providerStartOptionsFromInstance(instance)?.claudeAgent;
          const claudeHomePath = claudeOptions?.homePath;
          const claudeEnvironment = claudeOptions?.environment;
          return checkProviderInstanceWhenEnabled(
            instance,
            makeCheckClaudeProviderStatus(
              resolveClaudeSubscription({
                instanceId: instance.instanceId,
                binaryPath,
                homePath: claudeHomePath,
                environment: claudeEnvironment,
                homeDir: serverConfig.homeDir,
                isolationRootDir: serverConfig.stateDir,
              }),
              binaryPath,
              claudeHomePath,
              claudeEnvironment,
              serverConfig.homeDir,
              {
                providerInstanceId: instance.instanceId,
                isolationRootDir: serverConfig.stateDir,
              },
            ),
          );
        }
        case "cursor": {
          const cursorOptions = providerStartOptionsFromInstance(instance)?.cursor;
          return checkProviderInstanceWhenEnabled(
            instance,
            makeCheckCursorProviderStatus(
              binaryPath,
              cursorOptions?.environment,
              instance.instanceId,
              { homeDir: serverConfig.homeDir, isolationRootDir: serverConfig.stateDir },
            ),
          );
        }
        case "gemini": {
          const geminiOptions = providerStartOptionsFromInstance(instance)?.gemini;
          return checkProviderInstanceWhenEnabled(
            instance,
            makeCheckGeminiProviderStatus(
              binaryPath,
              geminiOptions?.environment,
              instance.instanceId,
              { homeDir: serverConfig.homeDir, isolationRootDir: serverConfig.stateDir },
            ),
          );
        }
        case "grok": {
          const grokOptions = providerStartOptionsFromInstance(instance)?.grok;
          return checkProviderInstanceWhenEnabled(
            instance,
            makeCheckGrokProviderStatus(binaryPath, grokOptions?.environment, instance.instanceId, {
              homeDir: serverConfig.homeDir,
              isolationRootDir: serverConfig.stateDir,
            }),
          );
        }
        case "kilo": {
          const kiloOptions = providerStartOptionsFromInstance(instance)?.kilo;
          return checkProviderInstanceWhenEnabled(
            instance,
            makeCheckKiloProviderStatus(
              binaryPath,
              kiloOptions?.environment,
              {
                serverUrl: readInstanceConfigString(instance, "serverUrl"),
                serverPassword: readInstanceConfigString(instance, "serverPassword"),
              },
              instance.instanceId,
              { homeDir: serverConfig.homeDir, isolationRootDir: serverConfig.stateDir },
            ),
          );
        }
        case "opencode": {
          const openCodeOptions = providerStartOptionsFromInstance(instance)?.opencode;
          return checkProviderInstanceWhenEnabled(
            instance,
            makeCheckOpenCodeProviderStatus(
              binaryPath,
              openCodeOptions?.environment,
              {
                serverUrl: readInstanceConfigString(instance, "serverUrl"),
                serverPassword: readInstanceConfigString(instance, "serverPassword"),
                experimentalWebSockets: readInstanceConfigBoolean(
                  instance,
                  "experimentalWebSockets",
                ),
              },
              instance.instanceId,
              { homeDir: serverConfig.homeDir, isolationRootDir: serverConfig.stateDir },
            ),
          );
        }
        case "pi": {
          const piOptions = providerStartOptionsFromInstance(instance)?.pi;
          return checkProviderInstanceWhenEnabled(
            instance,
            checkPiProviderStatus(
              readInstanceConfigString(instance, "agentDir"),
              binaryPath,
              piOptions?.environment,
              instance.instanceId,
              { homeDir: serverConfig.homeDir, isolationRootDir: serverConfig.stateDir },
            ),
          );
        }
      }
    };

    const loadProviderStatuses = serverSettings.ready
      .pipe(
        Effect.flatMap(() => serverSettings.getSettings),
        Effect.flatMap((settings) =>
          runProviderHealthProbes(
            deriveProviderInstances(settings).map((instance) =>
              checkProviderInstanceStatus(instance),
            ),
          ),
        ),
      )
      .pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.map((statuses) =>
          orderProviderStatuses(
            statuses.flatMap((status) => (Option.isSome(status) ? [status.value] : [])),
          ),
        ),
        Effect.flatMap(enrichStatuses),
      );

    const persistStatuses = (statuses: ProviderStatuses) =>
      Effect.forEach(
        statuses,
        (status) => {
          const { updateState: _updateState, ...statusToPersist } = status;
          return writeProviderStatusCache({
            filePath: cachePathForProviderTarget({
              provider: status.provider,
              instanceId: providerStatusInstanceKey(status),
            }),
            provider: statusToPersist,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.tapError(Effect.logError),
            Effect.ignore,
          );
        },
        { concurrency: "unbounded", discard: true },
      );

    const refreshNow = Effect.gen(function* () {
      // Drop the cached Claude subscription probe so switching accounts (login
      // / logout / add account outside the app) is reflected on the next
      // refresh instead of being pinned to the old account for up to 5 minutes.
      yield* Ref.set(claudeSubscriptionCacheRef, new Map());
      const loadedStatuses = yield* loadProviderStatuses;
      const previousRawStatuses = yield* Ref.get(statusesRef);
      const previousStatuses = yield* projectStatusesForCurrentSettings(previousRawStatuses);
      const stabilizedLoadedStatuses = stabilizeProviderStatusesAgainstTransientTimeouts(
        previousRawStatuses,
        loadedStatuses,
      );
      const nextRawStatuses = mergeProviderStatusUpdates(
        previousRawStatuses,
        stabilizedLoadedStatuses,
      );
      const nextStatuses = yield* projectStatusesForCurrentSettings(nextRawStatuses);
      yield* Ref.set(statusesRef, nextRawStatuses);
      if (providerStatusesEqual(previousStatuses, nextStatuses)) {
        return nextStatuses;
      }
      yield* persistStatuses(nextRawStatuses);
      yield* PubSub.publish(changesPubSub, nextStatuses);
      return nextStatuses;
    });

    // Keep a single refresh in flight so repeated config reads do not spawn
    // overlapping CLI probes while the cache already gives us a usable answer.
    const ensureRefreshFiber: Effect.Effect<Fiber.Fiber<ProviderStatuses, never>> = Effect.gen(
      function* () {
        const inFlight = yield* Ref.get(refreshFiberRef);
        if (inFlight) {
          return inFlight;
        }
        const refreshFiber = yield* Effect.gen(function* () {
          const refreshExit = yield* Effect.exit(refreshNow);
          if (Exit.isSuccess(refreshExit)) {
            return refreshExit.value;
          }
          // Keep the current in-memory snapshot as the source of truth if a
          // foreground refresh fails after startup.
          const rawStatuses = yield* Ref.get(statusesRef);
          return yield* projectStatusesForCurrentSettings(rawStatuses);
        }).pipe(Effect.ensuring(Ref.set(refreshFiberRef, null)), Effect.forkIn(refreshScope));
        yield* Ref.set(refreshFiberRef, refreshFiber);
        return refreshFiber;
      },
    );

    yield* serverSettings.streamChanges.pipe(
      Stream.runForEach((settings) =>
        Effect.gen(function* () {
          // Settings can change only the projection layer (disabled/deleted/renamed
          // instances). Publish that immediately from the cached raw probe data,
          // then run a fresh serialized probe pass for any settings that affect CLI
          // lookups.
          yield* publishProjectedStatusesForSettings(settings).pipe(Effect.asVoid);
          yield* Effect.gen(function* () {
            const inFlight = yield* Ref.get(refreshFiberRef);
            if (inFlight) {
              yield* Fiber.join(inFlight).pipe(Effect.asVoid);
            }
            yield* ensureRefreshFiber.pipe(Effect.flatMap(Fiber.join), Effect.asVoid);
            yield* publishProjectedStatuses().pipe(Effect.asVoid);
          }).pipe(Effect.forkIn(refreshScope), Effect.asVoid);
        }),
      ),
      Effect.forkIn(refreshScope),
    );

    const refresh: Effect.Effect<ProviderStatuses> = ensureRefreshFiber.pipe(
      Effect.flatMap(Fiber.join),
    );

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    const makeUpdateState = (input: {
      readonly status: ServerProviderUpdateState["status"];
      readonly startedAt: string | null;
      readonly finishedAt: string | null;
      readonly message: string | null;
      readonly output?: string | null;
    }): ServerProviderUpdateState => ({
      status: input.status,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      message: input.message,
      output: input.output ?? null,
    });

    const describeUpdateCommandError = (error: unknown): string => {
      if (error instanceof Error && error.message.trim().length > 0) {
        if (error.message.includes("initial is not a function")) {
          return "Update command failed before producing output. Try running the provider update command from a terminal.";
        }
        return error.message;
      }
      if (typeof error === "string" && error.trim().length > 0) {
        return error;
      }
      return "Update command could not be started.";
    };

    const runUpdateCommand = Effect.fn("runProviderUpdateCommand")(function* (input: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env?: NodeJS.ProcessEnv;
    }) {
      const env = input.env ?? process.env;
      const prepared = prepareWindowsSafeProcess(input.command, input.args, { env });
      const child = yield* spawner.spawn(
        ChildProcess.make(prepared.command, prepared.args, {
          shell: prepared.shell,
          env,
        }),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({
            stream: child.stdout,
            maxBytes: UPDATE_OUTPUT_MAX_BYTES,
          }),
          collectUint8StreamText({
            stream: child.stderr,
            maxBytes: UPDATE_OUTPUT_MAX_BYTES,
          }),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };
    });

    const updateProvider: ProviderHealthShape["updateProvider"] = Effect.fn(
      "ProviderHealth.updateProvider",
    )(function* (input) {
      const provider = input.provider;
      const instanceId = input.instanceId;
      const target = { provider, ...(instanceId ? { instanceId } : {}) };
      const toUpdateError = (reason: unknown) =>
        new ServerProviderUpdateError({
          provider,
          ...(instanceId ? { instanceId } : {}),
          reason: reason instanceof Error ? reason.message : String(reason),
        });
      const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(toUpdateError));
      const instance = resolveProviderInstanceTarget(settings, target);
      if (!instance || !instance.enabled) {
        return yield* new ServerProviderUpdateError({
          provider,
          ...(instanceId ? { instanceId } : {}),
          reason: instance
            ? "Provider instance is disabled in Synara settings."
            : "Provider instance is not configured.",
        });
      }
      const capabilities = yield* getProviderMaintenanceCapabilities(target).pipe(
        Effect.mapError(toUpdateError),
      );
      const update = capabilities.update;
      if (!update) {
        return yield* new ServerProviderUpdateError({
          provider,
          ...(instanceId ? { instanceId } : {}),
          reason: "This provider does not support one-click updates.",
        });
      }

      const run = Effect.gen(function* () {
        const startedAt = yield* nowIso;
        yield* setProviderUpdateState(
          target,
          makeUpdateState({
            status: "running",
            startedAt,
            finishedAt: null,
            message: "Updating provider.",
          }),
        );

        const commandResult = yield* Effect.try({
          try: () =>
            makeProviderUpdateEnv(instance, {
              homeDir: serverConfig.homeDir,
              isolationRootDir: serverConfig.stateDir,
            }),
          catch: toUpdateError,
        }).pipe(
          Effect.flatMap((env) =>
            runUpdateCommand({ command: update.executable, args: update.args, env }),
          ),
          Effect.scoped,
          Effect.timeoutOption(Duration.millis(UPDATE_TIMEOUT_MS)),
          Effect.result,
        );
        const finishedAt = yield* nowIso;
        if (Result.isFailure(commandResult)) {
          const providers = yield* setProviderUpdateState(
            target,
            makeUpdateState({
              status: "failed",
              startedAt,
              finishedAt,
              message: describeUpdateCommandError(commandResult.failure),
            }),
          );
          return { providers };
        }
        const result = commandResult.success;
        const output = Option.isSome(result)
          ? [result.value.stderr, result.value.stdout].filter(Boolean).join("\n\n").trim() || null
          : null;
        const failed = Option.isNone(result) || result.value.exitCode !== 0;
        if (failed) {
          const message = Option.isNone(result)
            ? "Update timed out."
            : `Update command exited with code ${result.value.exitCode}.`;
          const providers = yield* setProviderUpdateState(
            target,
            makeUpdateState({
              status: "failed",
              startedAt,
              finishedAt,
              message,
              output: output ? output.slice(0, UPDATE_OUTPUT_MAX_BYTES) : null,
            }),
          );
          return { providers };
        }

        const providers = yield* refreshNow.pipe(Effect.mapError(toUpdateError));
        const refreshed = providers.find(
          (status) =>
            (status.driver ?? status.provider) === provider &&
            providerStatusInstanceKey(status) === providerStatusKey(target),
        );
        const stillOutdated = refreshed?.versionAdvisory?.status === "behind_latest";
        const finalProviders = yield* setProviderUpdateState(
          target,
          makeUpdateState({
            status: stillOutdated ? "unchanged" : "succeeded",
            startedAt,
            finishedAt,
            message: stillOutdated
              ? "Update command completed, but Synara still detects an outdated provider version."
              : "Provider updated.",
            output: output ? output.slice(0, UPDATE_OUTPUT_MAX_BYTES) : null,
          }),
        );
        return { providers: finalProviders };
      });

      return yield* commandCoordinator.withCommandLock({
        targetKey: `instance:${providerStatusKey(target)}`,
        lockKey: update.lockKey,
        onQueued: setProviderUpdateState(
          target,
          makeUpdateState({
            status: "queued",
            startedAt: null,
            finishedAt: null,
            message: "Waiting for another provider update to finish.",
          }),
        ).pipe(Effect.asVoid),
        run,
      });
    });

    return {
      // Mirror upstream's behavior here: reads consume the latest stable
      // snapshot, while refreshes happen explicitly or from provider streams.
      getStatuses: Ref.get(statusesRef).pipe(Effect.flatMap(projectStatusesForCurrentSettings)),
      refresh,
      updateProvider,
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderHealthShape;
  }),
);
