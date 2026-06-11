/**
 * ProviderHealth.checks - Per-provider CLI health-check builders.
 *
 * Purpose: build a ServerProviderStatus per provider by running version/auth
 * CLI probes and interpreting their output. Each `makeCheck*` takes optional
 * binary/home paths; the eager check constants bind the defaults.
 * Layer: Effect helpers requiring ChildProcessSpawner (Codex also FileSystem/Path).
 * Exports: makeCheck and eager check builders for all 8 providers.
 *
 * @module ProviderHealth.checks
 */
import * as nodePath from "node:path";
import * as OS from "node:os";
import type { ServerProviderStatus } from "@t3tools/contracts";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Option, Path, Result } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion";
import { normalizeGeminiCapabilityProbeResult, probeGeminiCapabilities } from "../geminiAcpProbe";
import { resolveCursorAgentBinaryPath } from "../acp/CursorAcpCommand";
import { hasGrokApiKeyEnv } from "../acp/GrokAcpSupport";
import { parseGenericCliVersion } from "../providerMaintenance";
import {
  claudeAuthMetadata,
  codexAccountAuthLabel,
  detailFromResult,
  extractClaudeAuthMethodFromOutput,
  extractCodexAccountTypeFromOutput,
  extractSubscriptionTypeFromOutput,
  isCommandMissingCause,
  nonEmptyTrimmed,
  parseAuthStatusFromOutput,
  parseClaudeAuthStatusFromOutput,
} from "./ProviderHealth.parsing";
import {
  CLAUDE_AGENT_PROVIDER,
  CODEX_PROVIDER,
  CURSOR_PROVIDER,
  DEFAULT_TIMEOUT_MS,
  GEMINI_PROVIDER,
  GROK_PROVIDER,
  KILO_PROVIDER,
  OPENCODE_PROVIDER,
  PI_PROVIDER,
} from "./ProviderHealth.config";
import {
  hasCustomModelProviderForEnv,
  makeCodexProbeEnv,
  runClaudeCommand,
  runCodexCommand,
  runCursorCommand,
  runGeminiCommand,
  runGrokCommand,
  runKiloCommand,
  runOpenCodeCommand,
  runPiCommand,
} from "./ProviderHealth.commands";

// ── Health check ────────────────────────────────────────────────────

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

export const makeCheckClaudeProviderStatus = (
  resolveSubscriptionType?: Effect.Effect<string | undefined>,
  binaryPath?: string,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "claude";

    // Probe 1: `claude --version` — is the CLI reachable?
    const versionProbe = yield* runClaudeCommand(["--version"], executable).pipe(
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
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    // Probe 2: `claude auth status` — is the user authenticated?
    const authProbe = yield* runClaudeCommand(["auth", "status"], executable).pipe(
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
