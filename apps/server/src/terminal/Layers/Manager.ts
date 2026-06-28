// Purpose: TerminalManagerRuntime — terminal session lifecycle, PTY spawn, batched
//   output streaming with backpressure, subprocess-activity polling, kill escalation.
// Layer: Effect Layer over a stateful EventEmitter runtime. Pure helpers, subprocess
//   probing, and history persistence live in ./Manager.{helpers,subprocess,persistence}.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import treeKill from "tree-kill";

import {
  type TerminalAckOutputInput,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import {
  consumeTerminalIdentityInput,
  deriveTerminalTitleSignalIdentity,
  type TerminalCliKind,
} from "@t3tools/shared/terminalThreads";
import { Effect, Layer } from "effect";

import { createLogger } from "../../logger";
import { PtyAdapter, PtyAdapterShape, type PtyExitEvent, type PtyProcess } from "../Services/PTY";
import { ServerConfig } from "../../config";
import { prepareManagedTerminalAgentWrappers } from "../managedTerminalWrappers";
import {
  TerminalError,
  TerminalManager,
  TerminalManagerShape,
  TerminalSessionState,
  TerminalStartInput,
} from "../Services/Manager";
import { DEFAULT_HISTORY_BYTE_LIMIT } from "../terminalHistory";
import { createTerminalModeReplayTracker } from "../terminalModeReplay";
import {
  agentStateFromHookEvent,
  appendSessionHistory,
  cliKindFromRuntimeEnv,
  createTerminalSessionState,
  decodeTerminalClearInput,
  decodeTerminalCloseInput,
  decodeTerminalAckOutputInput,
  decodeTerminalOpenInput,
  decodeTerminalResizeInput,
  decodeTerminalRestartInput,
  decodeTerminalWriteInput,
  DEFAULT_HISTORY_LINE_LIMIT,
  DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS,
  DEFAULT_OPEN_COLS,
  DEFAULT_OPEN_ROWS,
  DEFAULT_PERSIST_DEBOUNCE_MS,
  DEFAULT_PROCESS_KILL_GRACE_MS,
  defaultShellResolver,
  deriveActivityAgentState,
  isProviderSessionBusy,
  MANAGED_TERMINAL_WRAPPER_DIRNAME,
  MANAGED_TERMINAL_ZSH_DIRNAME,
  normalizedRuntimeEnv,
  normalizeProviderOutputSignature,
  OUTPUT_BATCH_INTERVAL_MS,
  OUTPUT_BATCH_SIZE_LIMIT,
  OUTPUT_BUFFER_HIGH_WATERMARK,
  resetSessionHistory,
  sanitizeTerminalHistoryChunk,
  spawnTerminalShell,
  toSessionKey,
  resolveShellCandidates,
  WINDOWS_DEFAULT_TERMINAL_SHELL,
} from "./Manager.helpers";
import { TerminalHistoryStore } from "./Manager.persistence";
import {
  captureProcessChildrenMap,
  defaultSubprocessChecker,
  inspectSubprocessActivity,
  normalizeSubprocessActivity,
  type ProcessChildrenMap,
  type TerminalSubprocessActivity,
  type TerminalSubprocessChecker,
} from "./Manager.subprocess";

export {
  captureProcessChildrenMap,
  inspectSubprocessActivity,
  type ProcessChildrenMap,
  type TerminalSubprocessActivity,
  type TerminalSubprocessChecker,
} from "./Manager.subprocess";

const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const OUTPUT_ACK_PAUSE_THRESHOLD_BYTES = 64_000;

function messageWithNestedCause(error: unknown, fallback: string): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }
    if (current instanceof Error) {
      messages.push(current.message);
      const cause = (current as { cause?: unknown }).cause;
      if (cause) queue.push(cause);
      continue;
    }
    if (typeof current === "object") {
      const record = current as { message?: unknown; cause?: unknown };
      if (typeof record.message === "string") messages.push(record.message);
      if (record.cause) queue.push(record.cause);
    }
  }

  const [first, second] = messages.filter((message) => message.trim().length > 0);
  if (first && second) return `${first}: ${second}`;
  return first ?? fallback;
}

export const __terminalManagerShellTesting = {
  resolveShellCandidates,
  windowsDefaultTerminalShell: WINDOWS_DEFAULT_TERMINAL_SHELL,
};

interface TerminalManagerEvents {
  event: [event: TerminalEvent];
}

interface TerminalManagerOptions {
  logsDir?: string;
  historyLineLimit?: number;
  historyByteLimit?: number;
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
  private readonly historyByteLimit: number;
  private readonly ptyAdapter: PtyAdapterShape;
  private readonly shellResolver: () => string;
  private readonly historyStore: TerminalHistoryStore;
  private readonly threadLocks = new Map<string, Promise<void>>();
  private readonly subprocessChecker: TerminalSubprocessChecker;
  private readonly useDefaultSubprocessChecker: boolean;
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
    this.historyByteLimit = options.historyByteLimit ?? DEFAULT_HISTORY_BYTE_LIMIT;
    this.ptyAdapter = options.ptyAdapter;
    this.shellResolver = options.shellResolver ?? defaultShellResolver;
    this.historyStore = new TerminalHistoryStore({
      logsDir: this.logsDir,
      historyLineLimit: this.historyLineLimit,
      historyByteLimit: this.historyByteLimit,
      persistDebounceMs: DEFAULT_PERSIST_DEBOUNCE_MS,
      logger: this.logger,
    });
    this.subprocessChecker = options.subprocessChecker ?? defaultSubprocessChecker;
    // Only the built-in checker can share a single process snapshot across the
    // poll cycle; injected checkers (tests) keep the per-pid path.
    this.useDefaultSubprocessChecker = options.subprocessChecker === undefined;
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
        await this.historyStore.flushPersistQueue(input.threadId, input.terminalId);
        const history = await this.historyStore.readHistory(input.threadId, input.terminalId);
        const cols = input.cols ?? DEFAULT_OPEN_COLS;
        const rows = input.rows ?? DEFAULT_OPEN_ROWS;
        const session = createTerminalSessionState({
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          cols,
          rows,
          env: input.env,
          history,
          historyLimits: {
            maxLines: this.historyLineLimit,
            maxBytes: this.historyByteLimit,
          },
        });
        session.streamOutput = input.streamOutput ?? true;
        this.sessions.set(sessionKey, session);
        this.evictInactiveSessionsIfNeeded();
        await this.startSession(session, { ...input, cols, rows }, "started");
        return this.snapshot(session);
      }

      const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
      if (input.streamOutput !== undefined) {
        existing.streamOutput = input.streamOutput;
      }
      const currentRuntimeEnv = existing.runtimeEnv;
      const targetCols = input.cols ?? existing.cols;
      const targetRows = input.rows ?? existing.rows;
      const runtimeEnvChanged =
        JSON.stringify(currentRuntimeEnv) !== JSON.stringify(nextRuntimeEnv);

      if (existing.status === "exited" || existing.status === "error") {
        existing.cwd = input.cwd;
        existing.runtimeEnv = nextRuntimeEnv;
        resetSessionHistory(existing);
        await this.historyStore.persistHistory(
          existing.threadId,
          existing.terminalId,
          existing.history.toString(),
        );
      } else if (currentRuntimeEnv !== nextRuntimeEnv && !runtimeEnvChanged) {
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
        existing.modeReplayTracker?.resize(targetCols, targetRows);
        existing.updatedAt = new Date().toISOString();
      }

      this.resetOutputAckBackpressure(existing);
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
    const submittedPrompt = input.data.includes("\r") || input.data.includes("\n");
    const submittedCliKind = nextIdentityState.identity?.cliKind ?? null;
    if (submittedCliKind && session.detectedCliKind === null) {
      session.detectedCliKind = submittedCliKind;
      this.emitActivityEvent(session);
    }
    if (submittedPrompt && submittedCliKind === null) {
      this.clearProviderIdentity(session);
    }
    if (submittedPrompt && session.detectedCliKind !== null && !session.hasRunningSubprocess) {
      session.hasRunningSubprocess = true;
      this.emitActivityEvent(session);
    }
    session.lastInputAt = Date.now();
    session.process.write(input.data);
  }

  async ackOutput(raw: TerminalAckOutputInput): Promise<void> {
    const input = decodeTerminalAckOutputInput(raw);
    const session = this.sessions.get(toSessionKey(input.threadId, input.terminalId));
    if (!session) return;

    session.outputAckObserved = true;
    session.outputUnackedBytes = Math.max(0, session.outputUnackedBytes - input.bytes);
    if (session.outputUnackedBytes <= OUTPUT_ACK_PAUSE_THRESHOLD_BYTES) {
      session.outputAckPauseRequested = false;
      this.resumeOutputIfReady(session);
    }
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
      await this.historyStore.persistHistory(
        input.threadId,
        input.terminalId,
        session.history.toString(),
      );
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
        session = createTerminalSessionState({
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          cols,
          rows,
          env: input.env,
          history: "",
          historyLimits: {
            maxLines: this.historyLineLimit,
            maxBytes: this.historyByteLimit,
          },
        });
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
      await this.historyStore.persistHistory(
        input.threadId,
        input.terminalId,
        session.history.toString(),
      );
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
          this.historyStore.flushPersistQueue(session.threadId, session.terminalId),
        ),
      );

      if (input.deleteHistory) {
        await this.historyStore.deleteAllHistoryForThread(input.threadId);
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
    this.historyStore.dispose();
    for (const handle of this.killEscalationTimers.values()) {
      clearTimeout(handle.timer);
      handle.unsubscribeExit?.();
    }
    this.killEscalationTimers.clear();
    this.threadLocks.clear();
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
    session.managedAgentState = null;
    session.managedAgentObserved = false;
    session.pendingInputBuffer = "";
    session.lastInputAt = null;
    session.lastOutputAt = null;
    session.lastOutputSignature = null;
    session.outputAckPauseRequested = false;
    session.outputBufferPauseRequested = false;
    session.outputUnackedBytes = 0;
    session.updatedAt = new Date().toISOString();
    session.modeReplayTracker?.dispose();
    session.modeReplayTracker = createTerminalModeReplayTracker(session.cols, session.rows);

    let ptyProcess: PtyProcess | null = null;
    let startedShell: string | null = null;
    try {
      const spawnResult = await spawnTerminalShell({
        ptyAdapter: this.ptyAdapter,
        shellResolver: this.shellResolver,
        managedWrapperBinDir: this.managedWrapperBinDir,
        managedWrapperZshDir: this.managedWrapperZshDir,
        session,
      });
      ptyProcess = spawnResult.process;
      startedShell = spawnResult.shellLabel;

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
        this.emitActivityEvent(session);
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
      session.managedAgentState = null;
      session.managedAgentObserved = false;
      session.modeReplayTracker?.dispose();
      session.modeReplayTracker = null;
      session.updatedAt = new Date().toISOString();
      this.evictInactiveSessionsIfNeeded();
      this.updateSubprocessPollingState();
      const message = messageWithNestedCause(error, "Terminal start failed");
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
    session.modeReplayTracker?.feed(data);
    const sanitized = sanitizeTerminalHistoryChunk(session.pendingHistoryControlSequence, data);
    session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
    const latestHookEvent = sanitized.hookEvents.at(-1) ?? null;
    if (latestHookEvent) {
      session.managedAgentObserved = true;
      const nextManagedAgentRunning = latestHookEvent !== "Stop";
      const nextManagedAgentState = agentStateFromHookEvent(latestHookEvent);
      if (
        session.managedAgentRunning !== nextManagedAgentRunning ||
        session.managedAgentState !== nextManagedAgentState
      ) {
        session.managedAgentRunning = nextManagedAgentRunning;
        session.managedAgentState = nextManagedAgentState;
        session.hasRunningSubprocess = nextManagedAgentRunning;
        this.emitActivityEvent(session);
      }
    }
    const titleSignalCliKind =
      sanitized.titleSignals
        .map((titleSignal) => deriveTerminalTitleSignalIdentity(titleSignal)?.cliKind ?? null)
        .find((cliKind): cliKind is TerminalCliKind => cliKind !== null) ?? null;
    const detectedCliKind = titleSignalCliKind;
    if (detectedCliKind && session.detectedCliKind === null) {
      session.detectedCliKind = detectedCliKind;
      this.emitActivityEvent(session);
    }
    if (sanitized.visibleText.length > 0) {
      appendSessionHistory(session, sanitized.visibleText);
      this.historyStore.queuePersist(
        session.threadId,
        session.terminalId,
        session.history.toString(),
      );
      const normalizedSignature = normalizeProviderOutputSignature(sanitized.visibleText);
      if (normalizedSignature.length > 0 && normalizedSignature !== session.lastOutputSignature) {
        // Only refresh on genuinely new output. Repeated identical redraws (idle prompt
        // repaints) are ignored so they do not pin the provider in a "busy" state forever.
        // When hooks are active (managedAgentObserved), hooks are the source of truth anyway;
        // this heuristic only matters for unmanaged terminals.
        session.lastOutputAt = Date.now();
        session.lastOutputSignature = normalizedSignature;
      }
    }
    session.updatedAt = new Date().toISOString();

    // Accumulate output and batch-emit at ~60 fps to reduce WS message volume.
    session.pendingOutputChunks.push(data);
    session.pendingOutputLength += Buffer.byteLength(data, "utf8");

    // Backpressure: pause PTY when the pending buffer grows too large.
    if (!session.outputPaused && session.pendingOutputLength >= OUTPUT_BUFFER_HIGH_WATERMARK) {
      session.process?.pause();
      session.outputPaused = true;
      session.outputBufferPauseRequested = true;
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

    session.outputBufferPauseRequested = false;
    this.resumeOutputIfReady(session);

    const byteLength = Buffer.byteLength(data, "utf8");
    if (session.streamOutput) {
      this.emitEvent({
        type: "output",
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        data,
        byteLength,
      });
    }
    if (session.outputAckObserved) {
      session.outputUnackedBytes += byteLength;
      if (session.outputUnackedBytes > OUTPUT_ACK_PAUSE_THRESHOLD_BYTES) {
        session.outputAckPauseRequested = true;
        if (!session.outputPaused) {
          session.process?.pause();
          session.outputPaused = true;
        }
      }
    }
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
    session.managedAgentState = null;
    session.managedAgentObserved = false;
    session.modeReplayTracker?.dispose();
    session.modeReplayTracker = null;
    session.lastInputAt = null;
    session.lastOutputAt = null;
    session.lastOutputSignature = null;
    session.outputPaused = false;
    session.outputAckPauseRequested = false;
    session.outputBufferPauseRequested = false;
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
    session.managedAgentState = null;
    session.managedAgentObserved = false;
    session.modeReplayTracker?.dispose();
    session.modeReplayTracker = null;
    session.lastInputAt = null;
    session.lastOutputAt = null;
    session.lastOutputSignature = null;
    session.outputPaused = false;
    session.outputAckPauseRequested = false;
    session.outputBufferPauseRequested = false;
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
      this.flushOutputBuffer(session);
      this.sessions.delete(toSessionKey(session.threadId, session.terminalId));
      this.historyStore.evictSession(
        session.threadId,
        session.terminalId,
        session.history.toString(),
      );
      this.clearKillEscalationTimer(session.process);
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
    // Capture the whole process tree once per cycle (built-in POSIX checker
    // only); every running terminal is then inspected against this shared
    // snapshot instead of each spawning its own full-system `ps`.
    const sharedChildrenMap =
      this.useDefaultSubprocessChecker && process.platform !== "win32"
        ? await captureProcessChildrenMap()
        : null;
    try {
      await Promise.all(
        runningSessions.map(async (session) => {
          const terminalPid = session.pid;
          let hasRunningSubprocess = false;
          let terminalCliKind: TerminalCliKind | null = null;
          try {
            const subprocessActivity =
              sharedChildrenMap !== null
                ? inspectSubprocessActivity(terminalPid, sharedChildrenMap)
                : normalizeSubprocessActivity(await this.subprocessChecker(terminalPid));
            if (session.detectedCliKind !== null) {
              const providerStillObserved =
                subprocessActivity.hasProviderDescendant || subprocessActivity.cliKind !== null;
              terminalCliKind = providerStillObserved ? session.detectedCliKind : null;
            }
            if (session.managedAgentObserved) {
              // Hooks have fired — trust them as the sole source of truth (superset model).
              // Only override with non-provider subprocesses (e.g. user spawned a build).
              hasRunningSubprocess =
                session.managedAgentRunning || subprocessActivity.hasNonProviderSubprocess;
            } else {
              // No hooks observed — fall back to process-tree + output heuristic.
              if (session.detectedCliKind !== null && subprocessActivity.hasProviderDescendant) {
                session.providerDescendantObserved = true;
              }
              hasRunningSubprocess = subprocessActivity.hasProviderDescendant
                ? subprocessActivity.hasNonProviderSubprocess ||
                  isProviderSessionBusy(session, Date.now())
                : subprocessActivity.hasRunningSubprocess;
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
          this.emitActivityEvent(liveSession);
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
    await this.historyStore.flushPersistQueue(threadId, terminalId);
    if (deleteHistory) {
      await this.historyStore.deleteHistory(threadId, terminalId);
    }
  }

  private sessionsForThread(threadId: string): TerminalSessionState[] {
    return [...this.sessions.values()].filter((session) => session.threadId === threadId);
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
      history: session.history.toString(),
      ...(session.modeReplayTracker
        ? { replayPreamble: session.modeReplayTracker.buildPreamble() }
        : {}),
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      updatedAt: session.updatedAt,
    };
  }

  private emitActivityEvent(session: TerminalSessionState): void {
    this.emitEvent({
      type: "activity",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: new Date().toISOString(),
      hasRunningSubprocess: session.hasRunningSubprocess,
      cliKind: session.detectedCliKind,
      agentState: deriveActivityAgentState(session),
    });
  }

  private emitEvent(event: TerminalEvent): void {
    this.emit("event", event);
  }

  private clearProviderIdentity(session: TerminalSessionState): void {
    if (session.detectedCliKind === null) return;
    session.detectedCliKind = null;
    session.providerDescendantObserved = false;
    session.managedAgentRunning = false;
    session.managedAgentState = null;
    this.emitActivityEvent(session);
  }

  private resetOutputAckBackpressure(session: TerminalSessionState): void {
    session.outputUnackedBytes = 0;
    session.outputAckPauseRequested = false;
    this.resumeOutputIfReady(session);
  }

  private resumeOutputIfReady(session: TerminalSessionState): void {
    if (!session.outputPaused) return;
    if (session.outputBufferPauseRequested || session.outputAckPauseRequested) return;
    session.process?.resume();
    session.outputPaused = false;
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
      ackOutput: (input) =>
        Effect.tryPromise({
          try: () => runtime.ackOutput(input),
          catch: (cause) =>
            new TerminalError({ message: "Failed to acknowledge terminal output", cause }),
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
