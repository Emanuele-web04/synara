/**
 * ProviderHealth.commands - Effect-native CLI probe execution.
 *
 * Purpose: spawn provider CLIs via ChildProcessSpawner, collect stdout/stderr,
 * and read the Codex `model_provider` config for the auth-skip decision.
 * Layer: Effect helpers requiring ChildProcessSpawner / FileSystem / Path.
 * Exports: per-provider run* command helpers, readCodexConfigModelProvider,
 *   hasCustomModelProvider, readCodexConfigModelProviderForEnv,
 *   hasCustomModelProviderForEnv.
 *
 * @module ProviderHealth.commands
 */
import * as OS from "node:os";
import { parseCodexConfigModelProvider } from "@t3tools/shared/codexConfig";
import { query as claudeQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect, FileSystem, Option, Path, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsShellCommandMissingResult } from "../../shell-command-detection";
import { DEFAULT_CURSOR_AGENT_BINARY } from "../acp/CursorAcpCommand";
import { buildCodexProcessEnv } from "../../codexProcessEnv.ts";
import { OPENAI_AUTH_PROVIDERS } from "./ProviderHealth.config";
import type { CommandResult } from "./ProviderHealth.parsing";
import { nonEmptyTrimmed } from "./ProviderHealth.parsing";

export function makeCodexProbeEnv(homePath?: string): NodeJS.ProcessEnv {
  const normalizedHomePath = nonEmptyTrimmed(homePath);
  return buildCodexProcessEnv({
    ...(normalizedHomePath ? { homePath: normalizedHomePath } : {}),
  });
}

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

const guardWindowsMissing = (executable: string) => (result: CommandResult) =>
  isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
    ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
    : Effect.succeed(result);

export const runCodexCommand = (
  args: ReadonlyArray<string>,
  executable = "codex",
  env: NodeJS.ProcessEnv = process.env,
) =>
  runProviderCommand(executable, args, env).pipe(Effect.flatMap(guardWindowsMissing(executable)));

export const runClaudeCommand = (args: ReadonlyArray<string>, executable = "claude") =>
  runProviderCommand(executable, args).pipe(Effect.flatMap(guardWindowsMissing(executable)));

export const runGeminiCommand = (args: ReadonlyArray<string>, executable = "gemini") =>
  runProviderCommand(executable, args).pipe(Effect.flatMap(guardWindowsMissing(executable)));

export const runGrokCommand = (args: ReadonlyArray<string>, executable = "grok") =>
  runProviderCommand(executable, args).pipe(Effect.flatMap(guardWindowsMissing(executable)));

export const runOpenCodeCommand = (args: ReadonlyArray<string>, executable = "opencode") =>
  runProviderCommand(executable, args).pipe(Effect.flatMap(guardWindowsMissing(executable)));

export const runKiloCommand = (args: ReadonlyArray<string>, executable = "kilo") =>
  runProviderCommand(executable, args).pipe(Effect.flatMap(guardWindowsMissing(executable)));

export const runCursorCommand = (
  args: ReadonlyArray<string>,
  executable = DEFAULT_CURSOR_AGENT_BINARY,
) => runProviderCommand(executable, args).pipe(Effect.flatMap(guardWindowsMissing(executable)));

export const runPiCommand = (args: ReadonlyArray<string>, executable = "pi") =>
  runProviderCommand(executable, args).pipe(Effect.flatMap(guardWindowsMissing(executable)));

// ── Codex CLI config detection ──────────────────────────────────────

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

export const readCodexConfigModelProviderForEnv = (env: NodeJS.ProcessEnv) =>
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

export const hasCustomModelProviderForEnv = (env: NodeJS.ProcessEnv) =>
  Effect.map(
    readCodexConfigModelProviderForEnv(env),
    (provider) => provider !== undefined && !OPENAI_AUTH_PROVIDERS.has(provider),
  );

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

export const probeClaudeSubscription = () => {
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
