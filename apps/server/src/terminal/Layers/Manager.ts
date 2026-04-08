import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import treeKill from "tree-kill";

import {
  DEFAULT_TERMINAL_ID,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalWriteInput,
  type TerminalEvent,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import {
  consumeTerminalIdentityInput,
  deriveTerminalOutputIdentity,
  deriveTerminalProcessIdentity,
  deriveTerminalTitleSignalIdentity,
  terminalCliKindFromValue,
  T3CODE_TERMINAL_HOOK_OSC_PREFIX,
  T3CODE_TERMINAL_CLI_KIND_ENV_KEY,
  type TerminalAgentHookEventType,
  type TerminalCliKind,
} from "@t3tools/shared/terminalThreads";
import { Effect, Encoding, Layer, Schema } from "effect";

import { createLogger } from "../../logger";
import { PtyAdapter, PtyAdapterShape, type PtyExitEvent, type PtyProcess } from "../Services/PTY";
import { runProcess } from "../../processRunner";
import { ServerConfig } from "../../config";
import {
  applyManagedTerminalAgentWrapperEnv,
  prepareManagedTerminalAgentWrappers,
} from "../managedTerminalWrappers";
import {
  ShellCandidate,
  TerminalError,
  TerminalManager,
  TerminalManagerShape,
  TerminalSessionState,
  TerminalStartInput,
} from "../Services/Manager";

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
/** Flush batched PTY output at ~60 fps to reduce WebSocket message volume. */
const OUTPUT_BATCH_INTERVAL_MS = 16;
/** Flush immediately when the batched output exceeds this byte count. */
const OUTPUT_BATCH_SIZE_LIMIT = 131_072; // 128 KB
/** Pause PTY reads when the pending output buffer exceeds this size. */
const OUTPUT_BUFFER_HIGH_WATERMARK = 1_048_576; // 1 MB
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const PROVIDER_INPUT_ACTIVITY_GRACE_MS = 8_000;
const PROVIDER_OUTPUT_ACTIVITY_GRACE_MS = 4_000;
const PROVIDER_REPEAT_OUTPUT_REFRESH_MS = 1_500;
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);
const MANAGED_TERMINAL_WRAPPER_DIRNAME = "_managed-bin";
const MANAGED_TERMINAL_ZSH_DIRNAME = "_managed-zsh";

const decodeTerminalOpenInput = Schema.decodeUnknownSync(TerminalOpenInput);
const decodeTerminalRestartInput = Schema.decodeUnknownSync(TerminalRestartInput);
const decodeTerminalWriteInput = Schema.decodeUnknownSync(TerminalWriteInput);
const decodeTerminalResizeInput = Schema.decodeUnknownSync(TerminalResizeInput);
const decodeTerminalClearInput = Schema.decodeUnknownSync(TerminalClearInput);
const decodeTerminalCloseInput = Schema.decodeUnknownSync(TerminalCloseInput);

interface TerminalSubprocessActivity {
  cliKind: TerminalCliKind | null;
  hasRunningSubprocess: boolean;
  hasProviderDescendant: boolean;
  hasNonProviderSubprocess: boolean;
}

type TerminalSubprocessChecker = (
  terminalPid: number,
) => Promise<boolean | TerminalSubprocessActivity>;

function normalizeSubprocessActivity(
  result: boolean | TerminalSubprocessActivity,
): TerminalSubprocessActivity {
  return typeof result === "boolean"
    ? {
        cliKind: null,
        hasNonProviderSubprocess: result,
        hasProviderDescendant: false,
        hasRunningSubprocess: result,
      }
    : result;
}

function isProviderSessionBusy(session: TerminalSessionState, now: number): boolean {
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

function normalizeProviderOutputSignature(visibleText: string): string {
  return visibleText
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[P^_].*?(?:\u001b\\|\u0007|\u009c)/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-256);
}

function defaultShellResolver(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "cmd.exe";
  }
  return process.env.SHELL ?? "bash";
}

function normalizeShellCommand(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (process.platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function shellCandidateFromCommand(command: string | null): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = path.basename(command).toLowerCase();
  if (process.platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function formatShellCandidate(candidate: ShellCandidate): string {
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

function resolveShellCandidates(shellResolver: () => string): ShellCandidate[] {
  const requested = shellCandidateFromCommand(normalizeShellCommand(shellResolver()));

  if (process.platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand(process.env.ComSpec ?? null),
      shellCandidateFromCommand("powershell.exe"),
      shellCandidateFromCommand("cmd.exe"),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(process.env.SHELL)),
    shellCandidateFromCommand("/bin/zsh"),
    shellCandidateFromCommand("/bin/bash"),
    shellCandidateFromCommand("/bin/sh"),
    shellCandidateFromCommand("zsh"),
    shellCandidateFromCommand("bash"),
    shellCandidateFromCommand("sh"),
  ]);
}

function isRetryableShellSpawnError(error: unknown): boolean {
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

async function checkWindowsSubprocessActivity(
  terminalPid: number,
): Promise<TerminalSubprocessActivity> {
  const command = [
    `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${terminalPid}" -ErrorAction SilentlyContinue`,
    "if ($children) { exit 0 }",
    "exit 1",
  ].join("; ");
  try {
    const result = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 32_768,
        outputMode: "truncate",
      },
    );
    return {
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: result.code === 0,
    };
  } catch {
    return {
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: false,
    };
  }
}

async function checkPosixSubprocessActivity(
  terminalPid: number,
): Promise<TerminalSubprocessActivity> {
  const shellLikeProcessNames = new Set([
    "bash",
    "dash",
    "fish",
    "ksh",
    "login",
    "nu",
    "screen",
    "sh",
    "tcsh",
    "tmux",
    "zellij",
    "zsh",
  ]);

  const isShellLikeProcessName = (command: string): boolean => {
    const normalized = path.basename(command.trim().split(/\s+/g)[0] ?? "").toLowerCase();
    return shellLikeProcessNames.has(normalized);
  };

  const inspectDescendants = (
    parentPid: number,
    childrenByParentPid: Map<number, Array<{ pid: number; command: string }>>,
  ): TerminalSubprocessActivity => {
    const children = childrenByParentPid.get(parentPid) ?? [];
    let cliKind: TerminalCliKind | null = null;
    let hasNonProviderSubprocess = false;
    let hasProviderDescendant = false;
    let hasRunningSubprocess = false;
    for (const child of children) {
      const nestedActivity = inspectDescendants(child.pid, childrenByParentPid);
      const childCliKind = deriveTerminalProcessIdentity(child.command)?.cliKind ?? null;
      if (childCliKind || nestedActivity.hasProviderDescendant) {
        hasProviderDescendant = true;
      }
      if ((!childCliKind && !isShellLikeProcessName(child.command)) || nestedActivity.hasNonProviderSubprocess) {
        hasNonProviderSubprocess = true;
      }
      cliKind = cliKind ?? childCliKind ?? nestedActivity.cliKind;
      if (!isShellLikeProcessName(child.command) || nestedActivity.hasRunningSubprocess) {
        hasRunningSubprocess = true;
      }
    }
    return { cliKind, hasNonProviderSubprocess, hasProviderDescendant, hasRunningSubprocess };
  };

  try {
    const pgrepResult = await runProcess("pgrep", ["-P", String(terminalPid)], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 32_768,
      outputMode: "truncate",
    });
    if (pgrepResult.code === 0) {
      if (pgrepResult.stdout.trim().length === 0) {
        return {
          cliKind: null,
          hasNonProviderSubprocess: false,
          hasProviderDescendant: false,
          hasRunningSubprocess: false,
        };
      }
    }
    if (pgrepResult.code === 1) {
      return {
        cliKind: null,
        hasNonProviderSubprocess: false,
        hasProviderDescendant: false,
        hasRunningSubprocess: false,
      };
    }
  } catch {
    // Fall back to ps when pgrep is unavailable.
  }

  try {
    const psResult = await runProcess("ps", ["-eo", "pid=,ppid=,command="], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 262_144,
      outputMode: "truncate",
    });
    if (psResult.code !== 0) {
      return {
        cliKind: null,
        hasNonProviderSubprocess: false,
        hasProviderDescendant: false,
        hasRunningSubprocess: false,
      };
    }

    const childrenByParentPid = new Map<number, Array<{ pid: number; command: string }>>();
    for (const line of psResult.stdout.split(/\r?\n/g)) {
      const [pidRaw, ppidRaw, ...commandParts] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      const command = commandParts.join(" ").trim();
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      if (command.length === 0) continue;
      const siblings = childrenByParentPid.get(ppid) ?? [];
      siblings.push({ pid, command });
      childrenByParentPid.set(ppid, siblings);
    }

    return inspectDescendants(terminalPid, childrenByParentPid);
  } catch {
    return {
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: false,
    };
  }
}

async function defaultSubprocessChecker(terminalPid: number): Promise<TerminalSubprocessActivity> {
  if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
    return {
      cliKind: null,
      hasProviderDescendant: false,
      hasRunningSubprocess: false,
    };
  }
  if (process.platform === "win32") {
    return checkWindowsSubprocessActivity(terminalPid);
  }
  return checkPosixSubprocessActivity(terminalPid);
}

function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

function countCharacter(value: string, target: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === target) {
      count += 1;
    }
  }
  return count;
}

function measureHistory(history: string): {
  historyLineBreakCount: number;
  historyEndsWithNewline: boolean;
} {
  return {
    historyLineBreakCount: countCharacter(history, "\n"),
    historyEndsWithNewline: history.endsWith("\n"),
  };
}

function historyLineCount(
  history: string,
  lineBreakCount: number,
  endsWithNewline: boolean,
): number {
  if (history.length === 0) return 0;
  return lineBreakCount + (endsWithNewline ? 0 : 1);
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") {
    return true;
  }
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) {
    return true;
  }
  return false;
}

function shouldStripOscSequence(content: string): boolean {
  return (
    /^(10|11|12);(?:\?|rgb:)/.test(content) ||
    content.startsWith(T3CODE_TERMINAL_HOOK_OSC_PREFIX)
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

function sanitizeTerminalHistoryChunk(
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
        return { visibleText, pendingControlSequence: input.slice(index), titleSignals, hookEvents };
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
          return { visibleText, pendingControlSequence: input.slice(index), titleSignals, hookEvents };
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
          return { visibleText, pendingControlSequence: input.slice(index), titleSignals, hookEvents };
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
        return { visibleText, pendingControlSequence: input.slice(index), titleSignals, hookEvents };
      }
      append(input.slice(index, escapeSequenceEndIndex));
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
        return { visibleText, pendingControlSequence: input.slice(index), titleSignals, hookEvents };
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index), titleSignals, hookEvents };
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

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

function toSessionKey(threadId: string, terminalId: string): string {
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

function createTerminalSpawnEnv(
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

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

function cliKindFromRuntimeEnv(
  runtimeEnv: Record<string, string> | null | undefined,
): TerminalCliKind | null {
  return terminalCliKindFromValue(runtimeEnv?.[T3CODE_TERMINAL_CLI_KIND_ENV_KEY]);
}

function resetSessionHistory(session: TerminalSessionState): void {
  session.history = "";
  session.historyLineBreakCount = 0;
  session.historyEndsWithNewline = false;
  session.pendingHistoryControlSequence = "";
  session.pendingInputBuffer = "";
  session.managedAgentRunning = false;
}

function appendSessionHistory(
  session: TerminalSessionState,
  chunk: string,
  historyLineLimit: number,
): void {
  if (chunk.length === 0) return;

  const nextHistory = `${session.history}${chunk}`;
  const nextLineBreakCount = session.historyLineBreakCount + countCharacter(chunk, "\n");
  const nextEndsWithNewline = chunk.endsWith("\n");
  const nextLineCount = historyLineCount(nextHistory, nextLineBreakCount, nextEndsWithNewline);

  if (nextLineCount <= historyLineLimit) {
    session.history = nextHistory;
    session.historyLineBreakCount = nextLineBreakCount;
    session.historyEndsWithNewline = nextEndsWithNewline;
    return;
  }

  session.history = capHistory(nextHistory, historyLineLimit);
  const cappedMetrics = measureHistory(session.history);
  session.historyLineBreakCount = cappedMetrics.historyLineBreakCount;
  session.historyEndsWithNewline = cappedMetrics.historyEndsWithNewline;
}

interface TerminalManagerEvents {
  event: [event: TerminalEvent];
}

interface TerminalManagerOptions {
  logsDir?: string;
  historyLineLimit?: number;
  ptyAdapter: PtyAdapterShape;
  shellResolver?: () => string;
  subprocessChecker?: TerminalSubprocessChecker;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
}

interface KillEscalationHandle {
  timer: ReturnType<typeof setTimeout>;
  unsubscribeExit: (() => void) | null;
}

export class TerminalManagerRuntime extends EventEmitter<TerminalManagerEvents> {
  private readonly sessions = new Map<string, TerminalSessionState>();
  private readonly logsDir: string;
  private managedWrapperBinDir: string | null;
  private managedWrapperZshDir: string | null;
  private readonly historyLineLimit: number;
  private readonly ptyAdapter: PtyAdapterShape;
  private readonly shellResolver: () => string;
  private readonly persistQueues = new Map<string, Promise<void>>();
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingPersistHistory = new Map<string, string>();
  private readonly threadLocks = new Map<string, Promise<void>>();
  private readonly persistDebounceMs: number;
  private readonly subprocessChecker: TerminalSubprocessChecker;
  private readonly subprocessPollIntervalMs: number;
  private readonly processKillGraceMs: number;
  private readonly maxRetainedInactiveSessions: number;
  private subprocessPollTimer: ReturnType<typeof setInterval> | null = null;
  private subprocessPollInFlight = false;
  private readonly killEscalationTimers = new Map<PtyProcess, KillEscalationHandle>();
  private readonly logger = createLogger("terminal");

  constructor(options: TerminalManagerOptions) {
    super();
    this.logsDir = options.logsDir ?? path.resolve(process.cwd(), ".logs", "terminals");
    this.managedWrapperBinDir =
      process.platform === "win32"
        ? null
        : path.join(this.logsDir, MANAGED_TERMINAL_WRAPPER_DIRNAME);
    this.managedWrapperZshDir =
      process.platform === "win32" ? null : path.join(this.logsDir, MANAGED_TERMINAL_ZSH_DIRNAME);
    this.historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    this.ptyAdapter = options.ptyAdapter;
    this.shellResolver = options.shellResolver ?? defaultShellResolver;
    this.persistDebounceMs = DEFAULT_PERSIST_DEBOUNCE_MS;
    this.subprocessChecker = options.subprocessChecker ?? defaultSubprocessChecker;
    this.subprocessPollIntervalMs =
      options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
    this.processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    this.maxRetainedInactiveSessions =
      options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;
    fs.mkdirSync(this.logsDir, { recursive: true });
    if (this.managedWrapperBinDir) {
      try {
        const preparedWrappers = prepareManagedTerminalAgentWrappers({
          baseEnv: process.env,
          targetDir: this.managedWrapperBinDir,
          zshDir:
            this.managedWrapperZshDir ?? path.join(this.logsDir, MANAGED_TERMINAL_ZSH_DIRNAME),
        });
        this.managedWrapperBinDir = preparedWrappers.binDir;
        this.managedWrapperZshDir = preparedWrappers.zshDir;
      } catch (error) {
        this.logger.warn("failed to prepare managed terminal wrappers", {
          binDir: this.managedWrapperBinDir,
          zshDir: this.managedWrapperZshDir,
          error: error instanceof Error ? error.message : String(error),
        });
        this.managedWrapperBinDir = null;
        this.managedWrapperZshDir = null;
      }
    }
  }

  async open(raw: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const input = decodeTerminalOpenInput(raw);
    return this.runWithThreadLock(input.threadId, async () => {
      await this.assertValidCwd(input.cwd);

      const sessionKey = toSessionKey(input.threadId, input.terminalId);
      const existing = this.sessions.get(sessionKey);
      if (!existing) {
        await this.flushPersistQueue(input.threadId, input.terminalId);
        const history = await this.readHistory(input.threadId, input.terminalId);
        const cols = input.cols ?? DEFAULT_OPEN_COLS;
        const rows = input.rows ?? DEFAULT_OPEN_ROWS;
        const historyMetrics = measureHistory(history);
        const session: TerminalSessionState = {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          status: "starting",
          pid: null,
          history,
          historyLineBreakCount: historyMetrics.historyLineBreakCount,
          historyEndsWithNewline: historyMetrics.historyEndsWithNewline,
          pendingHistoryControlSequence: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: new Date().toISOString(),
          cols,
          rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          detectedCliKind: cliKindFromRuntimeEnv(normalizedRuntimeEnv(input.env)),
          managedAgentRunning: false,
          runtimeEnv: normalizedRuntimeEnv(input.env),
          pendingInputBuffer: "",
          pendingOutputChunks: [],
          pendingOutputLength: 0,
          outputFlushTimer: null,
          outputPaused: false,
          lastInputAt: null,
          lastOutputAt: null,
          lastOutputSignature: null,
        };
        this.sessions.set(sessionKey, session);
        this.evictInactiveSessionsIfNeeded();
        await this.startSession(session, { ...input, cols, rows }, "started");
        return this.snapshot(session);
      }

      const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
      const currentRuntimeEnv = existing.runtimeEnv;
      const targetCols = input.cols ?? existing.cols;
      const targetRows = input.rows ?? existing.rows;
      const runtimeEnvChanged =
        JSON.stringify(currentRuntimeEnv) !== JSON.stringify(nextRuntimeEnv);

      if (existing.cwd !== input.cwd || runtimeEnvChanged) {
        this.stopProcess(existing);
        existing.cwd = input.cwd;
        existing.runtimeEnv = nextRuntimeEnv;
        resetSessionHistory(existing);
        await this.persistHistory(existing.threadId, existing.terminalId, existing.history);
      } else if (existing.status === "exited" || existing.status === "error") {
        existing.runtimeEnv = nextRuntimeEnv;
        resetSessionHistory(existing);
        await this.persistHistory(existing.threadId, existing.terminalId, existing.history);
      } else if (currentRuntimeEnv !== nextRuntimeEnv) {
        existing.runtimeEnv = nextRuntimeEnv;
      }

      if (!existing.process) {
        await this.startSession(
          existing,
          { ...input, cols: targetCols, rows: targetRows },
          "started",
        );
        return this.snapshot(existing);
      }

      if (existing.cols !== targetCols || existing.rows !== targetRows) {
        existing.cols = targetCols;
        existing.rows = targetRows;
        existing.process.resize(targetCols, targetRows);
        existing.updatedAt = new Date().toISOString();
      }

      return this.snapshot(existing);
    });
  }

  async write(raw: TerminalWriteInput): Promise<void> {
    const input = decodeTerminalWriteInput(raw);
    const session = this.requireSession(input.threadId, input.terminalId);
    if (!session.process || session.status !== "running") {
      if (session.status === "exited") {
        return;
      }
      throw new Error(
        `Terminal is not running for thread: ${input.threadId}, terminal: ${input.terminalId}`,
      );
    }
    const nextIdentityState = consumeTerminalIdentityInput(session.pendingInputBuffer, input.data);
    session.pendingInputBuffer = nextIdentityState.buffer;
    if (nextIdentityState.identity?.cliKind && session.detectedCliKind === null) {
      session.detectedCliKind = nextIdentityState.identity.cliKind;
      this.emitEvent({
        type: "activity",
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        hasRunningSubprocess: session.hasRunningSubprocess,
        cliKind: session.detectedCliKind,
      });
    }
    const submittedPrompt = input.data.includes("\r") || input.data.includes("\n");
    if (submittedPrompt && session.detectedCliKind !== null && !session.hasRunningSubprocess) {
      session.hasRunningSubprocess = true;
      this.emitEvent({
        type: "activity",
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        hasRunningSubprocess: true,
        cliKind: session.detectedCliKind,
      });
    }
    session.lastInputAt = Date.now();
    session.process.write(input.data);
  }

  async resize(raw: TerminalResizeInput): Promise<void> {
    const input = decodeTerminalResizeInput(raw);
    const session = this.requireSession(input.threadId, input.terminalId);
    if (!session.process || session.status !== "running") {
      throw new Error(
        `Terminal is not running for thread: ${input.threadId}, terminal: ${input.terminalId}`,
      );
    }
    session.cols = input.cols;
    session.rows = input.rows;
    session.updatedAt = new Date().toISOString();
    session.process.resize(input.cols, input.rows);
  }

  async clear(raw: TerminalClearInput): Promise<void> {
    const input = decodeTerminalClearInput(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      const session = this.requireSession(input.threadId, input.terminalId);
      resetSessionHistory(session);
      session.updatedAt = new Date().toISOString();
      await this.persistHistory(input.threadId, input.terminalId, session.history);
      this.emitEvent({
        type: "cleared",
        threadId: input.threadId,
        terminalId: input.terminalId,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async restart(raw: TerminalRestartInput): Promise<TerminalSessionSnapshot> {
    const input = decodeTerminalRestartInput(raw);
    return this.runWithThreadLock(input.threadId, async () => {
      await this.assertValidCwd(input.cwd);

      const sessionKey = toSessionKey(input.threadId, input.terminalId);
      let session = this.sessions.get(sessionKey);
      if (!session) {
        const cols = input.cols ?? DEFAULT_OPEN_COLS;
        const rows = input.rows ?? DEFAULT_OPEN_ROWS;
        session = {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          status: "starting",
          pid: null,
          history: "",
          historyLineBreakCount: 0,
          historyEndsWithNewline: false,
          pendingHistoryControlSequence: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: new Date().toISOString(),
          cols,
          rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          detectedCliKind: cliKindFromRuntimeEnv(normalizedRuntimeEnv(input.env)),
          managedAgentRunning: false,
          runtimeEnv: normalizedRuntimeEnv(input.env),
          pendingInputBuffer: "",
          pendingOutputChunks: [],
          pendingOutputLength: 0,
          outputFlushTimer: null,
          outputPaused: false,
          lastOutputSignature: null,
          lastInputAt: null,
          lastOutputAt: null,
        } satisfies TerminalSessionState;
        this.sessions.set(sessionKey, session);
        this.evictInactiveSessionsIfNeeded();
      } else {
        this.stopProcess(session);
        session.cwd = input.cwd;
        session.runtimeEnv = normalizedRuntimeEnv(input.env);
      }

      if (!session) {
        throw new Error(
          `Terminal session was not initialized for thread: ${input.threadId}, terminal: ${input.terminalId}`,
        );
      }

      const cols = input.cols ?? session.cols;
      const rows = input.rows ?? session.rows;

      resetSessionHistory(session);
      await this.persistHistory(input.threadId, input.terminalId, session.history);
      await this.startSession(session, { ...input, cols, rows }, "restarted");
      return this.snapshot(session);
    });
  }

  async close(raw: TerminalCloseInput): Promise<void> {
    const input = decodeTerminalCloseInput(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      if (input.terminalId) {
        await this.closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
        return;
      }

      const threadSessions = this.sessionsForThread(input.threadId);
      for (const session of threadSessions) {
        this.stopProcess(session);
        this.sessions.delete(toSessionKey(session.threadId, session.terminalId));
      }
      await Promise.all(
        threadSessions.map((session) =>
          this.flushPersistQueue(session.threadId, session.terminalId),
        ),
      );

      if (input.deleteHistory) {
        await this.deleteAllHistoryForThread(input.threadId);
      }
      this.updateSubprocessPollingState();
    });
  }

  dispose(): void {
    this.stopSubprocessPolling();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      // Flush any remaining batched output before tearing down.
      this.flushOutputBuffer(session);
      this.stopProcess(session);
    }
    for (const timer of this.persistTimers.values()) {
      clearTimeout(timer);
    }
    this.persistTimers.clear();
    for (const handle of this.killEscalationTimers.values()) {
      clearTimeout(handle.timer);
      handle.unsubscribeExit?.();
    }
    this.killEscalationTimers.clear();
    this.pendingPersistHistory.clear();
    this.threadLocks.clear();
    this.persistQueues.clear();
  }

  private async startSession(
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
  ): Promise<void> {
    this.stopProcess(session);

    session.status = "starting";
    session.cwd = input.cwd;
    session.cols = input.cols;
    session.rows = input.rows;
    session.exitCode = null;
    session.exitSignal = null;
    session.hasRunningSubprocess = false;
    session.detectedCliKind = cliKindFromRuntimeEnv(session.runtimeEnv);
    session.managedAgentRunning = false;
    session.pendingInputBuffer = "";
    session.lastInputAt = null;
    session.lastOutputAt = null;
    session.lastOutputSignature = null;
    session.updatedAt = new Date().toISOString();

    let ptyProcess: PtyProcess | null = null;
    let startedShell: string | null = null;
    try {
      const shellCandidates = resolveShellCandidates(this.shellResolver);
      const terminalEnv = createTerminalSpawnEnv(process.env, session.runtimeEnv, {
        binDir: this.managedWrapperBinDir,
        zshDir: this.managedWrapperZshDir,
      });
      let lastSpawnError: unknown = null;

      const spawnWithCandidate = (candidate: ShellCandidate) =>
        Effect.runPromise(
          this.ptyAdapter.spawn({
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
        ptyProcess = spawnResult.process;
        startedShell = spawnResult.shellLabel;
      }

      if (!ptyProcess) {
        const detail =
          lastSpawnError instanceof Error ? lastSpawnError.message : "Terminal start failed";
        const tried =
          shellCandidates.length > 0
            ? ` Tried shells: ${shellCandidates.map((candidate) => formatShellCandidate(candidate)).join(", ")}.`
            : "";
        throw new Error(`${detail}.${tried}`.trim());
      }

      session.process = ptyProcess;
      session.pid = ptyProcess.pid;
      session.status = "running";
      session.updatedAt = new Date().toISOString();
      session.unsubscribeData = ptyProcess.onData((data) => {
        this.onProcessData(session, data);
      });
      session.unsubscribeExit = ptyProcess.onExit((event) => {
        this.onProcessExit(session, event);
      });
      this.updateSubprocessPollingState();
      this.emitEvent({
        type: eventType,
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        snapshot: this.snapshot(session),
      });
      if (session.detectedCliKind) {
        this.emitEvent({
          type: "activity",
          threadId: session.threadId,
          terminalId: session.terminalId,
          createdAt: new Date().toISOString(),
          hasRunningSubprocess: false,
          cliKind: session.detectedCliKind,
        });
      }
    } catch (error) {
      if (ptyProcess) {
        this.killProcessWithEscalation(ptyProcess, session.threadId, session.terminalId);
      }
      session.status = "error";
      session.pid = null;
      session.process = null;
      session.hasRunningSubprocess = false;
      session.detectedCliKind = null;
      session.managedAgentRunning = false;
      session.updatedAt = new Date().toISOString();
      this.evictInactiveSessionsIfNeeded();
      this.updateSubprocessPollingState();
      const message = error instanceof Error ? error.message : "Terminal start failed";
      this.emitEvent({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        message,
      });
      this.logger.error("failed to start terminal", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        error: message,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  }

  private onProcessData(session: TerminalSessionState, data: string): void {
    const sanitized = sanitizeTerminalHistoryChunk(session.pendingHistoryControlSequence, data);
    session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
    const latestHookEvent = sanitized.hookEvents.at(-1) ?? null;
    if (latestHookEvent) {
      const nextManagedAgentRunning = latestHookEvent !== "Stop";
      if (session.managedAgentRunning !== nextManagedAgentRunning) {
        session.managedAgentRunning = nextManagedAgentRunning;
        const nextHasRunningSubprocess = nextManagedAgentRunning;
        session.hasRunningSubprocess = nextHasRunningSubprocess;
        this.emitEvent({
          type: "activity",
          threadId: session.threadId,
          terminalId: session.terminalId,
          createdAt: new Date().toISOString(),
          hasRunningSubprocess: nextHasRunningSubprocess,
          cliKind: session.detectedCliKind,
        });
      }
    }
    const titleSignalCliKind =
      sanitized.titleSignals
        .map((titleSignal) => deriveTerminalTitleSignalIdentity(titleSignal)?.cliKind ?? null)
        .find((cliKind): cliKind is TerminalCliKind => cliKind !== null) ?? null;
    const outputCliKind = deriveTerminalOutputIdentity(sanitized.visibleText)?.cliKind ?? null;
    const detectedCliKind = outputCliKind ?? titleSignalCliKind;
    if (detectedCliKind && session.detectedCliKind === null) {
      session.detectedCliKind = detectedCliKind;
      this.emitEvent({
        type: "activity",
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        hasRunningSubprocess: session.hasRunningSubprocess,
        cliKind: detectedCliKind,
      });
    }
    if (sanitized.visibleText.length > 0) {
      appendSessionHistory(session, sanitized.visibleText, this.historyLineLimit);
      this.queuePersist(session.threadId, session.terminalId, session.history);
      const normalizedSignature = normalizeProviderOutputSignature(sanitized.visibleText);
      const now = Date.now();
      const shouldRefreshRepeatedSignature =
        normalizedSignature.length > 0 &&
        normalizedSignature === session.lastOutputSignature &&
        session.lastOutputAt !== null &&
        now - session.lastOutputAt >= PROVIDER_REPEAT_OUTPUT_REFRESH_MS;
      if (
        normalizedSignature.length > 0 &&
        (normalizedSignature !== session.lastOutputSignature || shouldRefreshRepeatedSignature)
      ) {
        // Keep provider sessions alive on repeated visible redraws, but only after a small gap
        // so idle prompt repaints do not pin the tab in a running state forever.
        session.lastOutputAt = now;
        session.lastOutputSignature = normalizedSignature;
      }
    }
    session.updatedAt = new Date().toISOString();

    // Accumulate output and batch-emit at ~60 fps to reduce WS message volume.
    session.pendingOutputChunks.push(data);
    session.pendingOutputLength += data.length;

    // Backpressure: pause PTY when the pending buffer grows too large.
    if (!session.outputPaused && session.pendingOutputLength >= OUTPUT_BUFFER_HIGH_WATERMARK) {
      session.process?.pause();
      session.outputPaused = true;
    }

    if (session.pendingOutputLength >= OUTPUT_BATCH_SIZE_LIMIT) {
      // Large burst — flush immediately to avoid excessive latency.
      this.flushOutputBuffer(session);
    } else if (session.outputFlushTimer === null) {
      session.outputFlushTimer = setTimeout(() => {
        this.flushOutputBuffer(session);
      }, OUTPUT_BATCH_INTERVAL_MS);
    }
  }

  private flushOutputBuffer(session: TerminalSessionState): void {
    if (session.outputFlushTimer !== null) {
      clearTimeout(session.outputFlushTimer);
      session.outputFlushTimer = null;
    }
    if (session.pendingOutputChunks.length === 0) return;

    const data = session.pendingOutputChunks.join("");
    session.pendingOutputChunks = [];
    session.pendingOutputLength = 0;

    // Backpressure: resume PTY reads now that the buffer is drained.
    if (session.outputPaused) {
      session.process?.resume();
      session.outputPaused = false;
    }

    this.emitEvent({
      type: "output",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: new Date().toISOString(),
      data,
    });
  }

  private onProcessExit(session: TerminalSessionState, event: PtyExitEvent): void {
    // Drain any remaining batched output before emitting the exit event.
    this.flushOutputBuffer(session);
    this.clearKillEscalationTimer(session.process);
    this.cleanupProcessHandles(session);
    session.process = null;
    session.pid = null;
    session.hasRunningSubprocess = false;
    session.detectedCliKind = null;
    session.managedAgentRunning = false;
    session.lastInputAt = null;
    session.lastOutputAt = null;
    session.lastOutputSignature = null;
    session.outputPaused = false;
    session.status = "exited";
    session.pendingHistoryControlSequence = "";
    session.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
    session.exitSignal = Number.isInteger(event.signal) ? event.signal : null;
    session.updatedAt = new Date().toISOString();
    this.emitEvent({
      type: "exited",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: new Date().toISOString(),
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
    });
    this.evictInactiveSessionsIfNeeded();
    this.updateSubprocessPollingState();
  }

  private stopProcess(session: TerminalSessionState): void {
    // Drain any remaining batched output before killing.
    this.flushOutputBuffer(session);
    const process = session.process;
    if (!process) return;
    this.cleanupProcessHandles(session);
    session.process = null;
    session.pid = null;
    session.hasRunningSubprocess = false;
    session.detectedCliKind = null;
    session.managedAgentRunning = false;
    session.lastInputAt = null;
    session.lastOutputAt = null;
    session.lastOutputSignature = null;
    session.outputPaused = false;
    session.status = "exited";
    session.pendingHistoryControlSequence = "";
    session.updatedAt = new Date().toISOString();
    this.killProcessWithEscalation(process, session.threadId, session.terminalId);
    this.evictInactiveSessionsIfNeeded();
    this.updateSubprocessPollingState();
  }

  private cleanupProcessHandles(session: TerminalSessionState): void {
    session.unsubscribeData?.();
    session.unsubscribeData = null;
    session.unsubscribeExit?.();
    session.unsubscribeExit = null;
  }

  private clearKillEscalationTimer(process: PtyProcess | null): void {
    if (!process) return;
    const handle = this.killEscalationTimers.get(process);
    if (!handle) return;
    clearTimeout(handle.timer);
    handle.unsubscribeExit?.();
    this.killEscalationTimers.delete(process);
  }

  private killProcessWithEscalation(
    process: PtyProcess,
    threadId: string,
    terminalId: string,
  ): void {
    this.clearKillEscalationTimer(process);
    const pid = process.pid;
    const signalProcess = (signal: "SIGTERM" | "SIGKILL") => {
      try {
        process.kill(signal);
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno?.code === "ESRCH") {
          return;
        }
        this.logger.warn("process signal failed", {
          threadId,
          terminalId,
          pid,
          signal,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // Use tree-kill to terminate the entire process tree (shell + children).
    treeKill(pid, "SIGTERM", (err) => {
      if (err) {
        this.logger.warn("tree-kill SIGTERM failed", {
          threadId,
          terminalId,
          pid,
          error: err.message,
        });
      }
    });
    // Also signal the PTY handle directly for adapter compatibility and test doubles.
    signalProcess("SIGTERM");

    const unsubscribeExit = process.onExit(() => {
      this.clearKillEscalationTimer(process);
    });

    const timer = setTimeout(() => {
      const handle = this.killEscalationTimers.get(process);
      if (handle) {
        handle.unsubscribeExit?.();
      }
      this.killEscalationTimers.delete(process);
      treeKill(pid, "SIGKILL", (err) => {
        if (err) {
          this.logger.warn("tree-kill SIGKILL failed", {
            threadId,
            terminalId,
            pid,
            error: err.message,
          });
        }
      });
      signalProcess("SIGKILL");
    }, this.processKillGraceMs);
    timer.unref?.();
    this.killEscalationTimers.set(process, { timer, unsubscribeExit });
  }

  private evictInactiveSessionsIfNeeded(): void {
    const inactiveSessions = [...this.sessions.values()].filter(
      (session) => session.status !== "running",
    );
    if (inactiveSessions.length <= this.maxRetainedInactiveSessions) {
      return;
    }

    inactiveSessions.sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.threadId.localeCompare(right.threadId) ||
        left.terminalId.localeCompare(right.terminalId),
    );
    const toEvict = inactiveSessions.length - this.maxRetainedInactiveSessions;
    for (const session of inactiveSessions.slice(0, toEvict)) {
      const key = toSessionKey(session.threadId, session.terminalId);
      this.flushOutputBuffer(session);
      this.sessions.delete(key);
      this.clearPersistTimer(session.threadId, session.terminalId);
      this.pendingPersistHistory.delete(key);
      this.persistQueues.delete(key);
      this.clearKillEscalationTimer(session.process);
    }
  }

  private queuePersist(threadId: string, terminalId: string, history: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.pendingPersistHistory.set(persistenceKey, history);
    this.schedulePersist(threadId, terminalId);
  }

  private async persistHistory(
    threadId: string,
    terminalId: string,
    history: string,
  ): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.clearPersistTimer(threadId, terminalId);
    this.pendingPersistHistory.delete(persistenceKey);
    await this.enqueuePersistWrite(threadId, terminalId, history);
  }

  private enqueuePersistWrite(
    threadId: string,
    terminalId: string,
    history: string,
  ): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    const task = async () => {
      await fs.promises.writeFile(this.historyPath(threadId, terminalId), history, "utf8");
    };
    const previous = this.persistQueues.get(persistenceKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        this.logger.warn("failed to persist terminal history", {
          threadId,
          terminalId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.persistQueues.set(persistenceKey, next);
    const finalized = next.finally(() => {
      if (this.persistQueues.get(persistenceKey) === next) {
        this.persistQueues.delete(persistenceKey);
      }
      if (
        this.pendingPersistHistory.has(persistenceKey) &&
        !this.persistTimers.has(persistenceKey)
      ) {
        this.schedulePersist(threadId, terminalId);
      }
    });
    void finalized.catch(() => undefined);
    return finalized;
  }

  private schedulePersist(threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    if (this.persistTimers.has(persistenceKey)) return;
    const timer = setTimeout(() => {
      this.persistTimers.delete(persistenceKey);
      const pendingHistory = this.pendingPersistHistory.get(persistenceKey);
      if (pendingHistory === undefined) return;
      this.pendingPersistHistory.delete(persistenceKey);
      void this.enqueuePersistWrite(threadId, terminalId, pendingHistory);
    }, this.persistDebounceMs);
    this.persistTimers.set(persistenceKey, timer);
  }

  private clearPersistTimer(threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    const timer = this.persistTimers.get(persistenceKey);
    if (!timer) return;
    clearTimeout(timer);
    this.persistTimers.delete(persistenceKey);
  }

  private async readHistory(threadId: string, terminalId: string): Promise<string> {
    const nextPath = this.historyPath(threadId, terminalId);
    try {
      const raw = await fs.promises.readFile(nextPath, "utf8");
      const capped = capHistory(raw, this.historyLineLimit);
      if (capped !== raw) {
        await fs.promises.writeFile(nextPath, capped, "utf8");
      }
      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (terminalId !== DEFAULT_TERMINAL_ID) {
      return "";
    }

    const legacyPath = this.legacyHistoryPath(threadId);
    try {
      const raw = await fs.promises.readFile(legacyPath, "utf8");
      const capped = capHistory(raw, this.historyLineLimit);

      // Migrate legacy transcript filename to the terminal-scoped path.
      await fs.promises.writeFile(nextPath, capped, "utf8");
      try {
        await fs.promises.rm(legacyPath, { force: true });
      } catch (cleanupError) {
        this.logger.warn("failed to remove legacy terminal history", {
          threadId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }

      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  private async deleteHistory(threadId: string, terminalId: string): Promise<void> {
    const deletions = [fs.promises.rm(this.historyPath(threadId, terminalId), { force: true })];
    if (terminalId === DEFAULT_TERMINAL_ID) {
      deletions.push(fs.promises.rm(this.legacyHistoryPath(threadId), { force: true }));
    }
    try {
      await Promise.all(deletions);
    } catch (error) {
      this.logger.warn("failed to delete terminal history", {
        threadId,
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async flushPersistQueue(threadId: string, terminalId: string): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.clearPersistTimer(threadId, terminalId);

    while (true) {
      const pendingHistory = this.pendingPersistHistory.get(persistenceKey);
      if (pendingHistory !== undefined) {
        this.pendingPersistHistory.delete(persistenceKey);
        await this.enqueuePersistWrite(threadId, terminalId, pendingHistory);
      }

      const pending = this.persistQueues.get(persistenceKey);
      if (!pending) {
        return;
      }
      await pending.catch(() => undefined);
    }
  }

  private updateSubprocessPollingState(): void {
    const hasRunningSessions = [...this.sessions.values()].some(
      (session) => session.status === "running" && session.pid !== null,
    );
    if (hasRunningSessions) {
      this.ensureSubprocessPolling();
      return;
    }
    this.stopSubprocessPolling();
  }

  private ensureSubprocessPolling(): void {
    if (this.subprocessPollTimer) return;
    this.subprocessPollTimer = setInterval(() => {
      void this.pollSubprocessActivity();
    }, this.subprocessPollIntervalMs);
    this.subprocessPollTimer.unref?.();
    void this.pollSubprocessActivity();
  }

  private stopSubprocessPolling(): void {
    if (!this.subprocessPollTimer) return;
    clearInterval(this.subprocessPollTimer);
    this.subprocessPollTimer = null;
  }

  private async pollSubprocessActivity(): Promise<void> {
    if (this.subprocessPollInFlight) return;

    const runningSessions = [...this.sessions.values()].filter(
      (session): session is TerminalSessionState & { pid: number } =>
        session.status === "running" && Number.isInteger(session.pid),
    );
    if (runningSessions.length === 0) {
      this.stopSubprocessPolling();
      return;
    }

    this.subprocessPollInFlight = true;
    try {
      await Promise.all(
        runningSessions.map(async (session) => {
          const terminalPid = session.pid;
          let hasRunningSubprocess = false;
          let terminalCliKind: TerminalCliKind | null = null;
          try {
            const subprocessActivity = normalizeSubprocessActivity(
              await this.subprocessChecker(terminalPid),
            );
            terminalCliKind = subprocessActivity.cliKind ?? session.detectedCliKind;
            hasRunningSubprocess = subprocessActivity.hasProviderDescendant
              ? subprocessActivity.hasNonProviderSubprocess || isProviderSessionBusy(session, Date.now())
              : subprocessActivity.hasRunningSubprocess;
            if (session.managedAgentRunning) {
              hasRunningSubprocess = true;
            }
          } catch (error) {
            this.logger.warn("failed to check terminal subprocess activity", {
              threadId: session.threadId,
              terminalId: session.terminalId,
              terminalPid,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }

          const liveSession = this.sessions.get(toSessionKey(session.threadId, session.terminalId));
          if (!liveSession || liveSession.status !== "running" || liveSession.pid !== terminalPid) {
            return;
          }
          if (
            liveSession.hasRunningSubprocess === hasRunningSubprocess &&
            liveSession.detectedCliKind === terminalCliKind
          ) {
            return;
          }

          liveSession.hasRunningSubprocess = hasRunningSubprocess;
          liveSession.detectedCliKind = terminalCliKind;
          liveSession.updatedAt = new Date().toISOString();
          this.emitEvent({
            type: "activity",
            threadId: liveSession.threadId,
            terminalId: liveSession.terminalId,
            createdAt: new Date().toISOString(),
            hasRunningSubprocess,
            cliKind: terminalCliKind,
          });
        }),
      );
    } finally {
      this.subprocessPollInFlight = false;
    }
  }

  private async assertValidCwd(cwd: string): Promise<void> {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Terminal cwd does not exist: ${cwd}`, { cause: error });
      }
      throw error;
    }
    if (!stats.isDirectory()) {
      throw new Error(`Terminal cwd is not a directory: ${cwd}`);
    }
  }

  private async closeSession(
    threadId: string,
    terminalId: string,
    deleteHistory: boolean,
  ): Promise<void> {
    const key = toSessionKey(threadId, terminalId);
    const session = this.sessions.get(key);
    if (session) {
      this.stopProcess(session);
      this.sessions.delete(key);
    }
    this.updateSubprocessPollingState();
    await this.flushPersistQueue(threadId, terminalId);
    if (deleteHistory) {
      await this.deleteHistory(threadId, terminalId);
    }
  }

  private sessionsForThread(threadId: string): TerminalSessionState[] {
    return [...this.sessions.values()].filter((session) => session.threadId === threadId);
  }

  private async deleteAllHistoryForThread(threadId: string): Promise<void> {
    const threadPrefix = `${toSafeThreadId(threadId)}_`;
    try {
      const entries = await fs.promises.readdir(this.logsDir, { withFileTypes: true });
      const removals = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter(
          (name) =>
            name === `${toSafeThreadId(threadId)}.log` ||
            name === `${legacySafeThreadId(threadId)}.log` ||
            name.startsWith(threadPrefix),
        )
        .map((name) => fs.promises.rm(path.join(this.logsDir, name), { force: true }));
      await Promise.all(removals);
    } catch (error) {
      this.logger.warn("failed to delete terminal histories for thread", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requireSession(threadId: string, terminalId: string): TerminalSessionState {
    const session = this.sessions.get(toSessionKey(threadId, terminalId));
    if (!session) {
      throw new Error(`Unknown terminal thread: ${threadId}, terminal: ${terminalId}`);
    }
    return session;
  }

  private snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
    return {
      threadId: session.threadId,
      terminalId: session.terminalId,
      cwd: session.cwd,
      status: session.status,
      pid: session.pid,
      history: session.history,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      updatedAt: session.updatedAt,
    };
  }

  private emitEvent(event: TerminalEvent): void {
    this.emit("event", event);
  }

  private historyPath(threadId: string, terminalId: string): string {
    const threadPart = toSafeThreadId(threadId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(this.logsDir, `${threadPart}.log`);
    }
    return path.join(this.logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
  }

  private legacyHistoryPath(threadId: string): string {
    return path.join(this.logsDir, `${legacySafeThreadId(threadId)}.log`);
  }

  private async runWithThreadLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.threadLocks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.threadLocks.set(threadId, current);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.threadLocks.get(threadId) === current) {
        this.threadLocks.delete(threadId);
      }
    }
  }
}

export const TerminalManagerLive = Layer.effect(
  TerminalManager,
  Effect.gen(function* () {
    const { terminalLogsDir } = yield* ServerConfig;

    const ptyAdapter = yield* PtyAdapter;
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => new TerminalManagerRuntime({ logsDir: terminalLogsDir, ptyAdapter })),
      (r) => Effect.sync(() => r.dispose()),
    );

    return {
      open: (input) =>
        Effect.tryPromise({
          try: () => runtime.open(input),
          catch: (cause) => new TerminalError({ message: "Failed to open terminal", cause }),
        }),
      write: (input) =>
        Effect.tryPromise({
          try: () => runtime.write(input),
          catch: (cause) => new TerminalError({ message: "Failed to write to terminal", cause }),
        }),
      resize: (input) =>
        Effect.tryPromise({
          try: () => runtime.resize(input),
          catch: (cause) => new TerminalError({ message: "Failed to resize terminal", cause }),
        }),
      clear: (input) =>
        Effect.tryPromise({
          try: () => runtime.clear(input),
          catch: (cause) => new TerminalError({ message: "Failed to clear terminal", cause }),
        }),
      restart: (input) =>
        Effect.tryPromise({
          try: () => runtime.restart(input),
          catch: (cause) => new TerminalError({ message: "Failed to restart terminal", cause }),
        }),
      close: (input) =>
        Effect.tryPromise({
          try: () => runtime.close(input),
          catch: (cause) => new TerminalError({ message: "Failed to close terminal", cause }),
        }),
      subscribe: (listener) =>
        Effect.sync(() => {
          runtime.on("event", listener);
          return () => {
            runtime.off("event", listener);
          };
        }),
      dispose: Effect.sync(() => runtime.dispose()),
    } satisfies TerminalManagerShape;
  }),
);
