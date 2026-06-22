// Purpose: Pure helpers, constants, and types for the terminal manager runtime —
//   shell-candidate resolution, spawn-env construction, ANSI/OSC history
//   sanitization, history measurement/append, provider-output signatures, and
//   session-state resets. No PTY, filesystem, or class state.
// Layer: Module-scope pure functions over plain values and TerminalSessionState.
//   The TerminalManagerRuntime class composes these; nothing here touches `this`,
//   spawns processes, or performs IO beyond string/buffer work.
// Exports: terminal config constants, decode* schema helpers, shell helpers,
//   env helpers, history helpers, session helpers, id helpers,
//   isProviderSessionBusy, normalizeProviderOutputSignature.
import path from "node:path";

import {
  TerminalAckOutputInput,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalWriteInput,
} from "@t3tools/contracts";
import {
  deriveTerminalTitleSignalIdentity,
  terminalCliKindFromValue,
  T3CODE_TERMINAL_HOOK_OSC_PREFIX,
  T3CODE_TERMINAL_CLI_KIND_ENV_KEY,
  type TerminalActivityState,
  type TerminalAgentHookEventType,
  type TerminalCliKind,
} from "@t3tools/shared/terminalThreads";
import { Effect, Encoding, Schema } from "effect";

import { applyManagedTerminalAgentWrapperEnv } from "../managedTerminalWrappers";
import { ShellCandidate, TerminalSessionState } from "../Services/Manager";
import type { PtyAdapterShape, PtyProcess } from "../Services/PTY";
import { countCharacter, TerminalHistoryBuffer, type HistoryLimits } from "../terminalHistory";

export const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
export const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
export const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
export const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
/** Flush batched PTY output at ~60 fps to reduce WebSocket message volume. */
export const OUTPUT_BATCH_INTERVAL_MS = 16;
/** Flush immediately when the batched output exceeds this byte count. */
export const OUTPUT_BATCH_SIZE_LIMIT = 131_072; // 128 KB
/** Pause PTY reads when the pending output buffer exceeds this size. */
export const OUTPUT_BUFFER_HIGH_WATERMARK = 1_048_576; // 1 MB
export const DEFAULT_OPEN_COLS = 120;
export const DEFAULT_OPEN_ROWS = 30;
export const PROVIDER_INPUT_ACTIVITY_GRACE_MS = 120_000;
export const PROVIDER_OUTPUT_ACTIVITY_GRACE_MS = 30_000;
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);
export const MANAGED_TERMINAL_WRAPPER_DIRNAME = "_managed-bin";
export const MANAGED_TERMINAL_ZSH_DIRNAME = "_managed-zsh";
export const WINDOWS_DEFAULT_TERMINAL_SHELL = "powershell.exe";

interface ShellResolutionOptions {
  platform?: NodeJS.Platform;
  envShell?: string;
  envComSpec?: string;
}

export const decodeTerminalOpenInput = Schema.decodeUnknownSync(TerminalOpenInput);
export const decodeTerminalRestartInput = Schema.decodeUnknownSync(TerminalRestartInput);
export const decodeTerminalWriteInput = Schema.decodeUnknownSync(TerminalWriteInput);
export const decodeTerminalResizeInput = Schema.decodeUnknownSync(TerminalResizeInput);
export const decodeTerminalClearInput = Schema.decodeUnknownSync(TerminalClearInput);
export const decodeTerminalCloseInput = Schema.decodeUnknownSync(TerminalCloseInput);
export const decodeTerminalAckOutputInput = Schema.decodeUnknownSync(TerminalAckOutputInput);

export function isProviderSessionBusy(session: TerminalSessionState, now: number): boolean {
  const lastInputAt = session.lastInputAt ?? 0;
  const lastOutputAt = session.lastOutputAt ?? 0;
  const latestSignalAt = Math.max(lastInputAt, lastOutputAt);
  if (latestSignalAt <= 0) {
    return false;
  }
  if (lastOutputAt >= lastInputAt) {
    return now - lastOutputAt <= PROVIDER_OUTPUT_ACTIVITY_GRACE_MS;
  }
  return now - lastInputAt <= PROVIDER_INPUT_ACTIVITY_GRACE_MS;
}

export function normalizeProviderOutputSignature(visibleText: string): string {
  return visibleText
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[P^_].*?(?:\u001b\\|\u0007|\u009c)/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-256);
}

export function defaultShellResolver(): string {
  if (process.platform === "win32") {
    return WINDOWS_DEFAULT_TERMINAL_SHELL;
  }
  return process.env.SHELL ?? "bash";
}

function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform = process.platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = path.basename(command).toLowerCase();
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

export function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

export function resolveShellCandidates(
  shellResolver: () => string,
  options: ShellResolutionOptions = {},
): ShellCandidate[] {
  const platform = options.platform ?? process.platform;
  const requested = shellCandidateFromCommand(
    normalizeShellCommand(shellResolver(), platform),
    platform,
  );

  if (platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand(options.envComSpec ?? process.env.ComSpec ?? null, platform),
      shellCandidateFromCommand(WINDOWS_DEFAULT_TERMINAL_SHELL, platform),
      shellCandidateFromCommand("cmd.exe", platform),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(
      normalizeShellCommand(options.envShell ?? process.env.SHELL, platform),
      platform,
    ),
    shellCandidateFromCommand("/bin/zsh", platform),
    shellCandidateFromCommand("/bin/bash", platform),
    shellCandidateFromCommand("/bin/sh", platform),
    shellCandidateFromCommand("zsh", platform),
    shellCandidateFromCommand("bash", platform),
    shellCandidateFromCommand("sh", platform),
  ]);
}

export function isRetryableShellSpawnError(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      const cause = (current as { cause?: unknown }).cause;
      if (cause) {
        queue.push(cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

export function measureHistory(history: string): {
  historyLineBreakCount: number;
  historyEndsWithNewline: boolean;
} {
  return {
    historyLineBreakCount: countCharacter(history, "\n"),
    historyEndsWithNewline: history.endsWith("\n"),
  };
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  // Persisted terminal history is replayed into a fresh xterm. Keep styling, but
  // strip cursor movement, erase, query/reply, and mode-control CSI sequences
  // that can move replayed prompt text off-screen or blank the pane.
  return finalByte !== "m";
}

function shouldStripOscSequence(content: string): boolean {
  return (
    /^(10|11|12);(?:\?|rgb:)/.test(content) || content.startsWith(T3CODE_TERMINAL_HOOK_OSC_PREFIX)
  );
}

function extractOscTitle(content: string): string | null {
  const match = content.match(/^(?:0|2);([\s\S]+)$/);
  return match?.[1]?.trim() || null;
}

function extractOscHookEvent(content: string): TerminalAgentHookEventType | null {
  if (!content.startsWith(T3CODE_TERMINAL_HOOK_OSC_PREFIX)) {
    return null;
  }
  const eventType = content.slice(T3CODE_TERMINAL_HOOK_OSC_PREFIX.length).trim();
  return eventType === "Start" || eventType === "Stop" || eventType === "PermissionRequest"
    ? eventType
    : null;
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === "\u0007" || lastCharacter === "\u009c") {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) {
      return index + 1;
    }
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

export function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): {
  visibleText: string;
  pendingControlSequence: string;
  titleSignals: string[];
  hookEvents: TerminalAgentHookEventType[];
} {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;
  const titleSignals: string[] = [];
  const hookEvents: TerminalAgentHookEventType[] = [];

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return {
          visibleText,
          pendingControlSequence: input.slice(index),
          titleSignals,
          hookEvents,
        };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(sequence);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return {
            visibleText,
            pendingControlSequence: input.slice(index),
            titleSignals,
            hookEvents,
          };
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return {
            visibleText,
            pendingControlSequence: input.slice(index),
            titleSignals,
            hookEvents,
          };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const hookEvent = extractOscHookEvent(content);
        if (hookEvent) {
          hookEvents.push(hookEvent);
        }
        if (nextCodePoint === 0x5d) {
          const titleSignal = extractOscTitle(content);
          if (titleSignal) {
            titleSignals.push(titleSignal);
          }
        }
        if (nextCodePoint !== 0x5d || !shouldStripOscSequence(content)) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return {
          visibleText,
          pendingControlSequence: input.slice(index),
          titleSignals,
          hookEvents,
        };
      }
      const sequence = input.slice(index, escapeSequenceEndIndex);
      if (sequence !== "\u001b7" && sequence !== "\u001b8") {
        append(sequence);
      }
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
            append(sequence);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return {
          visibleText,
          pendingControlSequence: input.slice(index),
          titleSignals,
          hookEvents,
        };
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return {
          visibleText,
          pendingControlSequence: input.slice(index),
          titleSignals,
          hookEvents,
        };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      const hookEvent = extractOscHookEvent(content);
      if (hookEvent) {
        hookEvents.push(hookEvent);
      }
      if (codePoint === 0x9d) {
        const titleSignal = extractOscTitle(content);
        if (titleSignal) {
          titleSignals.push(titleSignal);
        }
      }
      if (codePoint !== 0x9d || !shouldStripOscSequence(content)) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    append(input[index] ?? "");
    index += 1;
  }

  return { visibleText, pendingControlSequence: "", titleSignals, hookEvents };
}

export function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function toSafeThreadId(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}`;
}

export function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

export function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("T3CODE_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

export function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
  managedWrapperOptions?: {
    binDir: string | null;
    zshDir: string | null;
  },
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      spawnEnv[key] = value;
    }
  }
  return managedWrapperOptions
    ? applyManagedTerminalAgentWrapperEnv(spawnEnv, managedWrapperOptions)
    : spawnEnv;
}

export function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

export function cliKindFromRuntimeEnv(
  runtimeEnv: Record<string, string> | null | undefined,
): TerminalCliKind | null {
  return terminalCliKindFromValue(runtimeEnv?.[T3CODE_TERMINAL_CLI_KIND_ENV_KEY]);
}

export function resetSessionHistory(session: TerminalSessionState): void {
  session.history.reset();
  session.pendingHistoryControlSequence = "";
  session.pendingInputBuffer = "";
  session.managedAgentRunning = false;
  session.managedAgentState = null;
  session.managedAgentObserved = false;
  session.providerDescendantObserved = false;
}

export function deriveActivityAgentState(
  session: TerminalSessionState,
): TerminalActivityState | null {
  if (session.managedAgentState !== null) {
    return session.managedAgentState;
  }
  if (session.hasRunningSubprocess && session.detectedCliKind !== null) {
    return "running";
  }
  return null;
}

export function agentStateFromHookEvent(
  eventType: TerminalAgentHookEventType,
): TerminalActivityState {
  switch (eventType) {
    case "PermissionRequest":
      return "attention";
    case "Stop":
      return "review";
    case "Start":
      return "running";
  }
}

export function appendSessionHistory(session: TerminalSessionState, chunk: string): void {
  if (chunk.length === 0) return;
  session.history.append(chunk);
}

export function sanitizePersistedTerminalHistory(history: string): string {
  if (history.length === 0) return history;
  return sanitizeTerminalHistoryChunk("", history).visibleText;
}

/**
 * Spawn a PTY for the session, trying each resolved shell candidate in order and
 * falling back on retryable spawn errors. Resolves to the live process and its
 * shell label, or throws an aggregated error naming every shell that was tried.
 */
export async function spawnTerminalShell(deps: {
  ptyAdapter: PtyAdapterShape;
  shellResolver: () => string;
  managedWrapperBinDir: string | null;
  managedWrapperZshDir: string | null;
  session: Pick<TerminalSessionState, "cwd" | "cols" | "rows" | "runtimeEnv">;
}): Promise<{ process: PtyProcess; shellLabel: string }> {
  const { ptyAdapter, shellResolver, managedWrapperBinDir, managedWrapperZshDir, session } = deps;
  const shellCandidates = resolveShellCandidates(shellResolver);
  const terminalEnv = createTerminalSpawnEnv(process.env, session.runtimeEnv, {
    binDir: managedWrapperBinDir,
    zshDir: managedWrapperZshDir,
  });
  let lastSpawnError: unknown = null;

  const spawnWithCandidate = (candidate: ShellCandidate) =>
    Effect.runPromise(
      ptyAdapter.spawn({
        shell: candidate.shell,
        ...(candidate.args ? { args: candidate.args } : {}),
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        env: terminalEnv,
      }),
    );

  const trySpawn = async (
    candidates: ShellCandidate[],
    index = 0,
  ): Promise<{ process: PtyProcess; shellLabel: string } | null> => {
    if (index >= candidates.length) {
      return null;
    }
    const candidate = candidates[index];
    if (!candidate) {
      return null;
    }

    try {
      const process = await spawnWithCandidate(candidate);
      return { process, shellLabel: formatShellCandidate(candidate) };
    } catch (error) {
      lastSpawnError = error;
      if (!isRetryableShellSpawnError(error)) {
        throw error;
      }
      return trySpawn(candidates, index + 1);
    }
  };

  const spawnResult = await trySpawn(shellCandidates);
  if (spawnResult) {
    return spawnResult;
  }

  const detail = lastSpawnError instanceof Error ? lastSpawnError.message : "Terminal start failed";
  const tried =
    shellCandidates.length > 0
      ? ` Tried shells: ${shellCandidates.map((candidate) => formatShellCandidate(candidate)).join(", ")}.`
      : "";
  throw new Error(`${detail}.${tried}`.trim());
}

export function createTerminalSessionState(params: {
  threadId: string;
  terminalId: string;
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string> | undefined;
  history: string;
  historyLimits: HistoryLimits;
}): TerminalSessionState {
  const runtimeEnv = normalizedRuntimeEnv(params.env);
  return {
    threadId: params.threadId,
    terminalId: params.terminalId,
    cwd: params.cwd,
    status: "starting",
    pid: null,
    history: TerminalHistoryBuffer.fromString(params.history, params.historyLimits),
    pendingHistoryControlSequence: "",
    exitCode: null,
    exitSignal: null,
    updatedAt: new Date().toISOString(),
    cols: params.cols,
    rows: params.rows,
    process: null,
    unsubscribeData: null,
    unsubscribeExit: null,
    hasRunningSubprocess: false,
    detectedCliKind: cliKindFromRuntimeEnv(runtimeEnv),
    providerDescendantObserved: false,
    managedAgentRunning: false,
    managedAgentState: null,
    managedAgentObserved: false,
    runtimeEnv,
    pendingInputBuffer: "",
    modeReplayTracker: null,
    pendingOutputChunks: [],
    pendingOutputLength: 0,
    outputFlushTimer: null,
    streamOutput: true,
    outputPaused: false,
    outputBufferPauseRequested: false,
    outputAckPauseRequested: false,
    outputAckObserved: false,
    outputUnackedBytes: 0,
    outputAckResumeTimer: null,
    lastInputAt: null,
    lastOutputAt: null,
    lastOutputSignature: null,
  };
}
