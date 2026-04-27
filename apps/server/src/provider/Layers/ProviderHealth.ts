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
  ServerProviderAuthStatus,
  ServerProviderStatus,
  ServerProviderStatusState,
} from "@t3tools/contracts";
import { parseCodexConfigModelProvider } from "@t3tools/shared/codexConfig";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { query as claudeQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  Array,
  Cache,
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
import { isWindowsShellCommandMissingResult } from "../../shell-command-detection";
import { normalizeGeminiCapabilityProbeResult, probeGeminiCapabilities } from "../geminiAcpProbe";
import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";
import {
  orderProviderStatuses,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache";

const DEFAULT_TIMEOUT_MS = 4_000;
const CODEX_PROVIDER = "codex" as const;
const CLAUDE_AGENT_PROVIDER = "claudeAgent" as const;
const CURSOR_PROVIDER = "cursor" as const;
const GEMINI_PROVIDER = "gemini" as const;
const OPENCODE_PROVIDER = "opencode" as const;
type ProviderStatuses = ReadonlyArray<ServerProviderStatus>;

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
  if (result.timedOut) return "Timed out while running command.";
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

const runCodexCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("codex", [...args], {
      shell: process.platform === "win32",
      env: process.env,
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

    if (isWindowsShellCommandMissingResult({ code: exitCode, stderr })) {
      return yield* Effect.fail(new Error("spawn codex ENOENT"));
    }

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runClaudeCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("claude", [...args], {
      shell: process.platform === "win32",
      env: process.env,
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

    if (isWindowsShellCommandMissingResult({ code: exitCode, stderr })) {
      return yield* Effect.fail(new Error("spawn claude ENOENT"));
    }

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runGeminiCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("gemini", [...args], {
      shell: process.platform === "win32",
      env: process.env,
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

    if (isWindowsShellCommandMissingResult({ code: exitCode, stderr })) {
      return yield* Effect.fail(new Error("spawn gemini ENOENT"));
    }

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runOpenCodeCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("opencode", [...args], {
      shell: process.platform === "win32",
      env: process.env,
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

    if (isWindowsShellCommandMissingResult({ code: exitCode, stderr })) {
      return yield* Effect.fail(new Error("spawn opencode ENOENT"));
    }

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runCursorCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("agent", [...args], {
      shell: process.platform === "win32",
      env: process.env,
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

    if (isWindowsShellCommandMissingResult({ code: exitCode, stderr })) {
      return yield* Effect.fail(new Error("spawn agent ENOENT"));
    }

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

// ── Health check ────────────────────────────────────────────────────

export const checkCodexProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();

  // Probe 1: `codex --version` — is the CLI reachable?
  const versionProbe = yield* runCodexCommand(["--version"]).pipe(
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
  if (yield* hasCustomModelProvider) {
    return {
      provider: CODEX_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Using a custom Codex model provider; OpenAI login check skipped.",
    } satisfies ServerProviderStatus;
  }

  const authProbe = yield* runCodexCommand(["login", "status"]).pipe(
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
    ...(codexAuthType ? { authType: codexAuthType } : {}),
    ...(codexLabel ? { authLabel: codexLabel } : {}),
    ...(parsed.voiceTranscriptionAvailable !== undefined
      ? { voiceTranscriptionAvailable: parsed.voiceTranscriptionAvailable }
      : {}),
    checkedAt,
    ...(parsed.message ? { message: parsed.message } : {}),
  } satisfies ServerProviderStatus;
});

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
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();

    // Probe 1: `claude --version` — is the CLI reachable?
    const versionProbe = yield* runClaudeCommand(["--version"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
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

    // Probe 2: `claude auth status` — is the user authenticated?
    const authProbe = yield* runClaudeCommand(["auth", "status"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
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
      ...(authMetadata ? { authType: authMetadata.type, authLabel: authMetadata.label } : {}),
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
    } satisfies ServerProviderStatus;
  });

export const checkClaudeProviderStatus = makeCheckClaudeProviderStatus();

export const checkGeminiProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();

  const versionProbe = yield* runGeminiCommand(["--version"]).pipe(
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

  const capabilityProbe = yield* probeGeminiCapabilities({
    binaryPath: "gemini",
    cwd: OS.homedir(),
  }).pipe(Effect.result);

  if (Result.isFailure(capabilityProbe)) {
    const error = capabilityProbe.failure;
    return {
      provider: GEMINI_PROVIDER,
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
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
    checkedAt,
    ...(parsed.message ? { message: parsed.message } : {}),
  } satisfies ServerProviderStatus;
});

// ── OpenCode health check ───────────────────────────────────────────

export const checkOpenCodeProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();

  const versionProbe = yield* runOpenCodeCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
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
      message: "OpenCode CLI is installed but failed to run. Timed out while running command.",
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

  return {
    provider: OPENCODE_PROVIDER,
    status: "ready" as const,
    available: true,
    authStatus: "unknown" as const,
    checkedAt,
    message: "OpenCode CLI is installed. Configure provider credentials inside OpenCode as needed.",
  } satisfies ServerProviderStatus;
});

// ── Cursor health check ─────────────────────────────────────────────

export const checkCursorProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();

  const versionProbe = yield* runCursorCommand(["--version"]).pipe(
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
        ? "Cursor Agent CLI (`agent`) is not installed or not on PATH."
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
      message: "Cursor Agent CLI is installed but failed to run. Timed out while running command.",
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

  return {
    provider: CURSOR_PROVIDER,
    status: "ready" as const,
    available: true,
    authStatus: "unknown" as const,
    checkedAt,
    message: "Cursor Agent CLI is installed. Sign in with Cursor if a session prompts for authentication.",
  } satisfies ServerProviderStatus;
});

// ── Snapshot helpers ────────────────────────────────────────────────

function providerStatusesEqual(left: ProviderStatuses, right: ProviderStatuses): boolean {
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
      (status.message ?? null) === (next.message ?? null)
    );
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
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProviderStatus>>(),
      PubSub.shutdown,
    );
    const refreshScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(refreshScope, Exit.void));

    const cachePathByProvider = new Map(
      [CODEX_PROVIDER, CLAUDE_AGENT_PROVIDER, CURSOR_PROVIDER, GEMINI_PROVIDER, OPENCODE_PROVIDER].map(
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
      [
        CODEX_PROVIDER,
        CLAUDE_AGENT_PROVIDER,
        CURSOR_PROVIDER,
        GEMINI_PROVIDER,
        OPENCODE_PROVIDER,
      ] as const,
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
    const refreshFiberRef = yield* Ref.make<Fiber.Fiber<ProviderStatuses, never> | null>(null);

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

    const checkClaude = makeCheckClaudeProviderStatus(resolveClaudeSubscription);

    const loadProviderStatuses = Effect.all(
      [
        checkCodexProviderStatus,
        checkClaude,
        checkCursorProviderStatus,
        checkGeminiProviderStatus,
        checkOpenCodeProviderStatus,
      ],
      {
        concurrency: "unbounded",
      },
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.map(orderProviderStatuses),
    );

    const persistStatuses = (statuses: ProviderStatuses) =>
      Effect.forEach(
        statuses,
        (status) =>
          writeProviderStatusCache({
            filePath: cachePathByProvider.get(status.provider)!,
            provider: status,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.tapError(Effect.logError),
            Effect.ignore,
          ),
        { concurrency: "unbounded", discard: true },
      );

    const refreshNow = Effect.gen(function* () {
      const nextStatuses = yield* loadProviderStatuses;
      const previousStatuses = yield* Ref.get(statusesRef);
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

    return {
      // Mirror upstream's behavior here: reads consume the latest stable
      // snapshot, while refreshes happen explicitly or from provider streams.
      getStatuses: Ref.get(statusesRef),
      refresh,
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderHealthShape;
  }),
);
