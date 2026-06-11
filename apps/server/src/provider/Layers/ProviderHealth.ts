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
import * as nodePath from "node:path";
import type {
  ProviderKind,
  ServerSettings,
  ServerProviderAuthStatus,
  ServerProviderStatus,
  ServerProviderStatusState,
  ServerProviderUpdateState,
} from "@t3tools/contracts";
import { ServerProviderUpdateError } from "@t3tools/contracts";
import { parseCodexConfigModelProvider } from "@t3tools/shared/codexConfig";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { query as claudeQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  Array,
  Cache,
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
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion";
import { ServerConfig } from "../../config";
import { ServerSettingsService } from "../../serverSettings";
import { isWindowsShellCommandMissingResult } from "../../shell-command-detection";
import {
  buildGeminiProbeEnv,
  normalizeGeminiCapabilityProbeResult,
  probeGeminiCapabilities,
} from "../geminiAcpProbe";
import { DEFAULT_CURSOR_AGENT_BINARY, resolveCursorAgentBinaryPath } from "../acp/CursorAcpCommand";
import { hasGrokApiKeyEnv } from "../acp/GrokAcpSupport";
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
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText";
import { buildCodexProcessEnv } from "../../codexProcessEnv.ts";

const DEFAULT_TIMEOUT_MS = 4_000;
const CLAUDE_HEALTH_TIMEOUT_MS = 20_000;
const OPENCODE_HEALTH_TIMEOUT_MS = 20_000;
const PROVIDER_COMMAND_TIMEOUT_DETAIL = "Timed out while running command.";
const CODEX_PROVIDER = "codex" as const;
const CLAUDE_AGENT_PROVIDER = "claudeAgent" as const;
const CURSOR_PROVIDER = "cursor" as const;
const GEMINI_PROVIDER = "gemini" as const;
const GROK_PROVIDER = "grok" as const;
const KILO_PROVIDER = "kilo" as const;
const OPENCODE_PROVIDER = "opencode" as const;
const PI_PROVIDER = "pi" as const;
type ProviderStatuses = ReadonlyArray<ServerProviderStatus>;

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

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isCommandMissingCause(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return lower.includes("enoent") || lower.includes("notfound");
}

function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return PROVIDER_COMMAND_TIMEOUT_DETAIL;
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

function extractAuthBoolean(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function extractAuthMethod(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthMethod(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authMethod", "auth_type", "authType"] as const) {
    if (typeof record[key] === "string") {
      const trimmed = record[key].trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthMethod(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

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

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  switch (normalized) {
    case "max":
    case "maxplan":
    case "max5":
    case "max20":
      return "Max";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (normalized === "apikey") return "apiKey";
  return undefined;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return { type: "apiKey", label: "Claude API Key" };
  }
  if (input.subscriptionType) {
    const subscriptionLabel = claudeSubscriptionLabel(input.subscriptionType);
    return {
      type: input.subscriptionType,
      label: `Claude ${subscriptionLabel ?? toTitleCaseWords(input.subscriptionType)} Subscription`,
    };
  }
  return undefined;
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

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

const probeClaudeSubscription = () => {
  const abort = new AbortController();
  return Effect.tryPromise(async () => {
    const q = claudeQuery({
      // oxlint-disable-next-line require-yield
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await waitForAbortSignal(abort.signal);
      })(),
      options: {
        persistSession: false,
        abortController: abort,
        settingSources: ["user", "project", "local"],
        allowedTools: [],
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
    const command = ChildProcess.make(executable, [...args], {
      shell: process.platform === "win32",
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

const runClaudeCommand = (args: ReadonlyArray<string>, executable = "claude") =>
  runProviderCommand(executable, args).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runGeminiCommand = (args: ReadonlyArray<string>, executable = "gemini") =>
  runProviderCommand(executable, args, buildGeminiProbeEnv()).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runGrokCommand = (args: ReadonlyArray<string>, executable = "grok") =>
  runProviderCommand(executable, args).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runOpenCodeCommand = (args: ReadonlyArray<string>, executable = "opencode") =>
  runProviderCommand(executable, args).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runKiloCommand = (args: ReadonlyArray<string>, executable = "kilo") =>
  runProviderCommand(executable, args).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runCursorCommand = (args: ReadonlyArray<string>, executable = DEFAULT_CURSOR_AGENT_BINARY) =>
  runProviderCommand(executable, args).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runPiCommand = (args: ReadonlyArray<string>, executable = "pi") =>
  runProviderCommand(executable, args).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

// ── Health check ────────────────────────────────────────────────────

function makeCodexProbeEnv(homePath?: string): NodeJS.ProcessEnv {
  const normalizedHomePath = nonEmptyTrimmed(homePath);
  return buildCodexProcessEnv({
    ...(normalizedHomePath ? { homePath: normalizedHomePath } : {}),
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
): Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "codex";
    const probeEnv = makeCodexProbeEnv(homePath);

    // Probe 1: `codex --version` — is the CLI reachable?
    const versionProbe = yield* runCodexCommand(["--version"], executable, probeEnv).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: CODEX_PROVIDER,
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
    if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
      return {
        provider: CODEX_PROVIDER,
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

export function parseClaudeAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
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
      message:
        "Claude Agent authentication status command is unavailable in this version of Claude.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `claude login`") ||
    lowerOutput.includes("run claude login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }

  // `claude auth status` returns JSON with a `loggedIn` boolean.
  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", authStatus: "authenticated" };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Claude authentication status from JSON output (missing auth marker).",
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
      ? `Could not verify Claude authentication status. ${detail}`
      : "Could not verify Claude authentication status.",
  };
}

export const makeCheckClaudeProviderStatus = (
  resolveSubscriptionType?: Effect.Effect<string | undefined>,
  binaryPath?: string,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "claude";

    // Probe 1: `claude --version` — is the CLI reachable?
    const versionProbe = yield* runClaudeCommand(["--version"], executable).pipe(
      Effect.timeoutOption(CLAUDE_HEALTH_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: CLAUDE_AGENT_PROVIDER,
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

    // Probe 2: `claude auth status` — is the user authenticated?
    const authProbe = yield* runClaudeCommand(["auth", "status"], executable).pipe(
      Effect.timeoutOption(CLAUDE_HEALTH_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CLAUDE_AGENT_PROVIDER,
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
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message: "Could not verify Claude authentication status. Timed out while running command.",
      };
    }

    const authOutput = authProbe.success.value;
    const parsed = parseClaudeAuthStatusFromOutput(authOutput);

    // Determine subscription type from multiple sources (cheapest first):
    // 1. JSON output of `claude auth status` (may or may not contain it)
    // 2. Cached SDK probe (spawns a Claude process on miss, reads
    //    `initializationResult()` for account metadata, then aborts
    //    immediately — no API tokens are consumed)
    let subscriptionType = extractSubscriptionTypeFromOutput(authOutput);
    const authMethod = extractClaudeAuthMethodFromOutput(authOutput);
    if (!subscriptionType && resolveSubscriptionType && parsed.authStatus === "authenticated") {
      subscriptionType = yield* resolveSubscriptionType;
    }
    const authMetadata = claudeAuthMetadata({ subscriptionType, authMethod });

    return {
      provider: CLAUDE_AGENT_PROVIDER,
      status: parsed.status,
      available: true,
      authStatus: parsed.authStatus,
      version: parsedVersion,
      ...(authMetadata ? { authType: authMetadata.type, authLabel: authMetadata.label } : {}),
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
    } satisfies ServerProviderStatus;
  });

export const checkClaudeProviderStatus = makeCheckClaudeProviderStatus();

export const makeCheckGeminiProviderStatus = (
  binaryPath?: string,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "gemini";

    const versionProbe = yield* runGeminiCommand(["--version"], executable).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: GEMINI_PROVIDER,
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
    }).pipe(Effect.result);

    if (Result.isFailure(capabilityProbe)) {
      const error = capabilityProbe.failure;
      return {
        provider: GEMINI_PROVIDER,
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
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "grok";

    const versionProbe = yield* runGrokCommand(["--version"], executable).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: GROK_PROVIDER,
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
    const hasApiKey = hasGrokApiKeyEnv();

    return {
      provider: GROK_PROVIDER,
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

// ── OpenCode health check ───────────────────────────────────────────

export const makeCheckOpenCodeProviderStatus = (
  binaryPath?: string,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "opencode";

    const versionProbe = yield* runOpenCodeCommand(["--version"], executable).pipe(
      Effect.timeoutOption(OPENCODE_HEALTH_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: OPENCODE_PROVIDER,
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
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "kilo";

    const versionProbe = yield* runKiloCommand(["--version"], executable).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: KILO_PROVIDER,
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
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "pi";
    const versionProbe = yield* runPiCommand(["--version"], executable).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );
    const version =
      Result.isSuccess(versionProbe) && Option.isSome(versionProbe.success)
        ? versionProbe.success.value
        : null;
    const parsedVersion =
      version && version.code === 0
        ? parseGenericCliVersion(`${version.stdout}\n${version.stderr}`)
        : null;

    try {
      const trimmedAgentDir = nonEmptyTrimmed(agentDir);
      const authStorage = trimmedAgentDir
        ? AuthStorage.create(nodePath.join(trimmedAgentDir, "auth.json"))
        : AuthStorage.create();
      const registry = trimmedAgentDir
        ? ModelRegistry.create(authStorage, nodePath.join(trimmedAgentDir, "models.json"))
        : ModelRegistry.create(authStorage);
      registry.refresh();
      const modelCount = registry.getAvailable().length;
      const authPath = trimmedAgentDir
        ? nodePath.join(trimmedAgentDir, "auth.json")
        : "~/.pi/agent/auth.json";
      return {
        provider: PI_PROVIDER,
        status: modelCount > 0 ? "ready" : "warning",
        available: modelCount > 0,
        authStatus: modelCount > 0 ? "authenticated" : "unknown",
        version: parsedVersion,
        checkedAt,
        message:
          modelCount > 0
            ? `Pi SDK is available with ${modelCount} authenticated model${modelCount === 1 ? "" : "s"}.`
            : `Pi SDK is available, but no authenticated models were found in ${authPath}.`,
      } satisfies ServerProviderStatus;
    } catch (cause) {
      return {
        provider: PI_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: `Failed to read Pi auth/model registry: ${cause instanceof Error ? cause.message : String(cause)}.`,
      } satisfies ServerProviderStatus;
    }
  });

// ── Cursor health check ─────────────────────────────────────────────

export const makeCheckCursorProviderStatus = (
  binaryPath?: string,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = resolveCursorAgentBinaryPath(nonEmptyTrimmed(binaryPath));

    const versionProbe = yield* runCursorCommand(["--version"], executable).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: CURSOR_PROVIDER,
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

    return {
      provider: CURSOR_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "unknown" as const,
      version: parsedVersion,
      checkedAt,
      message:
        "Cursor Agent CLI is installed. Sign in with Cursor if a session prompts for authentication.",
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

  const previousByProvider = new Map(
    previousStatuses.map((status) => [status.provider, status] as const),
  );

  return nextStatuses.map((status) => {
    const previous = previousByProvider.get(status.provider);
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

    const cachePathByProvider = new Map(
      PROVIDERS.map(
        (provider) =>
          [
            provider,
            resolveProviderStatusCachePath({
              stateDir: serverConfig.stateDir,
              provider,
            }),
          ] as const,
      ),
    );

    const cachedStatuses: ProviderStatuses = yield* Effect.forEach(
      PROVIDERS,
      (provider) =>
        readProviderStatusCache(cachePathByProvider.get(provider)!).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        ),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((statuses) =>
        orderProviderStatuses(
          statuses.filter((status): status is ServerProviderStatus => status !== undefined),
        ),
      ),
    );

    const statusesRef = yield* Ref.make<ProviderStatuses>(cachedStatuses);
    const updateStatesRef = yield* Ref.make<ReadonlyMap<ProviderKind, ServerProviderUpdateState>>(
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

    // 5-minute TTL cache for the Claude SDK subscription probe. The probe
    // spawns a short-lived `claude` subprocess to read account metadata
    // from the local init handshake; capacity=1 because the probe has no
    // parameters.
    const claudeSubscriptionCache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(5),
      lookup: (_: "claude") => probeClaudeSubscription(),
    });
    const resolveClaudeSubscription = Cache.get(claudeSubscriptionCache, "claude").pipe(
      Effect.map((probe) => probe?.subscriptionType),
    );

    const getProviderBinaryPath = (provider: ProviderKind, settings: ServerSettings) => {
      switch (provider) {
        case "codex":
          return settings.providers.codex.binaryPath;
        case "claudeAgent":
          return settings.providers.claudeAgent.binaryPath;
        case "cursor":
          return settings.providers.cursor.binaryPath;
        case "gemini":
          return settings.providers.gemini.binaryPath;
        case "grok":
          return settings.providers.grok.binaryPath;
        case "kilo":
          return settings.providers.kilo.binaryPath;
        case "opencode":
          return settings.providers.opencode.binaryPath;
        case "pi":
          return settings.providers.pi.binaryPath;
      }
    };

    const getProviderMaintenanceCapabilities = Effect.fn("getProviderMaintenanceCapabilities")(
      function* (provider: ProviderKind) {
        const settings = yield* serverSettings.getSettings;
        if (provider === "cursor") {
          return makeProviderMaintenanceCapabilities({
            provider,
            packageName: null,
            updateExecutable: resolveCursorAgentBinaryPath(
              getProviderBinaryPath(provider, settings),
            ),
            updateArgs: ["update"],
            updateLockKey: "cursor-agent",
          });
        }
        const definition = PACKAGE_MANAGED_PROVIDER_UPDATES[provider];
        if (!definition) {
          return makeProviderMaintenanceCapabilities({
            provider,
            packageName: null,
            updateExecutable: null,
            updateArgs: [],
            updateLockKey: null,
          });
        }
        return yield* resolveProviderMaintenanceCapabilitiesEffect(definition, {
          binaryPath: getProviderBinaryPath(provider, settings),
          env: process.env,
          platform: process.platform,
        }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
      },
    );

    const applyVolatileProviderState = Effect.fn("applyVolatileProviderState")(function* (
      status: ServerProviderStatus,
    ) {
      const updateStates = yield* Ref.get(updateStatesRef);
      const updateState = updateStates.get(status.provider);
      if (!updateState) {
        const { updateState: _updateState, ...statusWithoutUpdateState } = status;
        return statusWithoutUpdateState;
      }
      return {
        ...status,
        updateState,
      };
    });

    const setProviderUpdateState = Effect.fn("setProviderUpdateState")(function* (
      provider: ProviderKind,
      state: ServerProviderUpdateState | null,
    ) {
      yield* Ref.update(updateStatesRef, (previous) => {
        const next = new Map(previous);
        if (!state || state.status === "idle") {
          next.delete(provider);
        } else {
          next.set(provider, state);
        }
        return next;
      });

      const current = yield* Ref.get(statusesRef);
      const next = yield* Effect.forEach(current, applyVolatileProviderState, {
        concurrency: "unbounded",
      });
      yield* Ref.set(statusesRef, next);
      yield* PubSub.publish(changesPubSub, next);
      return next;
    });

    const enrichStatuses = Effect.fn("enrichProviderStatuses")(function* (
      statuses: ReadonlyArray<ServerProviderStatus>,
    ) {
      const enriched = yield* Effect.forEach(
        statuses,
        (status) =>
          getProviderMaintenanceCapabilities(status.provider).pipe(
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
          ),
        { concurrency: "unbounded" },
      );
      return yield* Effect.forEach(enriched, applyVolatileProviderState, {
        concurrency: "unbounded",
      });
    });

    const loadProviderStatuses = serverSettings.getSettings
      .pipe(
        Effect.flatMap((settings) =>
          Effect.all(
            [
              makeCheckCodexProviderStatus(
                settings.providers.codex.binaryPath,
                settings.providers.codex.homePath,
              ),
              makeCheckClaudeProviderStatus(
                resolveClaudeSubscription,
                settings.providers.claudeAgent.binaryPath,
              ),
              makeCheckCursorProviderStatus(settings.providers.cursor.binaryPath),
              makeCheckGeminiProviderStatus(settings.providers.gemini.binaryPath),
              makeCheckGrokProviderStatus(settings.providers.grok.binaryPath),
              makeCheckKiloProviderStatus(settings.providers.kilo.binaryPath),
              makeCheckOpenCodeProviderStatus(settings.providers.opencode.binaryPath),
              checkPiProviderStatus(
                settings.providers.pi.agentDir,
                settings.providers.pi.binaryPath,
              ),
            ],
            {
              concurrency: "unbounded",
            },
          ),
        ),
      )
      .pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.map(orderProviderStatuses),
        Effect.flatMap(enrichStatuses),
      );

    const persistStatuses = (statuses: ProviderStatuses) =>
      Effect.forEach(
        statuses,
        (status) => {
          const { updateState: _updateState, ...statusToPersist } = status;
          return writeProviderStatusCache({
            filePath: cachePathByProvider.get(status.provider)!,
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
      yield* Cache.invalidate(claudeSubscriptionCache, "claude");
      const loadedStatuses = yield* loadProviderStatuses;
      const previousStatuses = yield* Ref.get(statusesRef);
      const nextStatuses = stabilizeProviderStatusesAgainstTransientTimeouts(
        previousStatuses,
        loadedStatuses,
      );
      if (providerStatusesEqual(previousStatuses, nextStatuses)) {
        yield* Ref.set(statusesRef, nextStatuses);
        return nextStatuses;
      }
      yield* Ref.set(statusesRef, nextStatuses);
      yield* persistStatuses(nextStatuses);
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
          return yield* Ref.get(statusesRef);
        }).pipe(Effect.ensuring(Ref.set(refreshFiberRef, null)), Effect.forkIn(refreshScope));
        yield* Ref.set(refreshFiberRef, refreshFiber);
        return refreshFiber;
      },
    );

    yield* ensureRefreshFiber;

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
    }) {
      const child = yield* spawner.spawn(
        ChildProcess.make(input.command, [...input.args], {
          shell: process.platform === "win32",
          env: process.env,
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
      const toUpdateError = (reason: unknown) =>
        new ServerProviderUpdateError({
          provider,
          reason: reason instanceof Error ? reason.message : String(reason),
        });
      const capabilities = yield* getProviderMaintenanceCapabilities(provider).pipe(
        Effect.mapError(toUpdateError),
      );
      const update = capabilities.update;
      if (!update) {
        return yield* new ServerProviderUpdateError({
          provider,
          reason: "This provider does not support one-click updates.",
        });
      }

      const run = Effect.gen(function* () {
        const startedAt = yield* nowIso;
        yield* setProviderUpdateState(
          provider,
          makeUpdateState({
            status: "running",
            startedAt,
            finishedAt: null,
            message: "Updating provider.",
          }),
        );

        const commandResult = yield* runUpdateCommand({
          command: update.executable,
          args: update.args,
        }).pipe(
          Effect.scoped,
          Effect.timeoutOption(Duration.millis(UPDATE_TIMEOUT_MS)),
          Effect.result,
        );
        const finishedAt = yield* nowIso;
        if (Result.isFailure(commandResult)) {
          const providers = yield* setProviderUpdateState(
            provider,
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
            provider,
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
        const refreshed = providers.find((status) => status.provider === provider);
        const stillOutdated = refreshed?.versionAdvisory?.status === "behind_latest";
        const finalProviders = yield* setProviderUpdateState(
          provider,
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
        targetKey: provider,
        lockKey: update.lockKey,
        onQueued: setProviderUpdateState(
          provider,
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
      getStatuses: Ref.get(statusesRef),
      refresh,
      updateProvider,
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderHealthShape;
  }),
);
