import {
  TerminalAckOutputInput,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
  TerminalWriteInput,
} from "@synara/contracts";
import type { TerminalActivityState, TerminalCliKind } from "@synara/shared/terminalThreads";
import { PtyProcess } from "./PTY";
import { Effect, Schema, ServiceMap } from "effect";
import type { TerminalModeReplayTracker } from "../terminalModeReplay";
import type { TerminalHistoryBuffer } from "../terminalHistory";

export class TerminalError extends Schema.TaggedErrorClass<TerminalError>()("TerminalError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  status: TerminalSessionStatus;
  pid: number | null;
  /** append-optimized scrollback buffer (sanitized visible text, capped on read) */
  history: TerminalHistoryBuffer;
  pendingHistoryControlSequence: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  /** archive-cleanup generation fence */
  lastOpenedAt: string;
  cols: number;
  rows: number;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  detectedCliKind: TerminalCliKind | null;
  /** true once this branded session has shown a provider child process */
  providerDescendantObserved: boolean;
  managedAgentRunning: boolean;
  managedAgentState: TerminalActivityState | null;
  /** true once a hook event (Start/Stop/PermissionRequest) has been observed */
  managedAgentObserved: boolean;
  runtimeEnv: Record<string, string> | null;
  pendingInputBuffer: string;
  modeReplayTracker: TerminalModeReplayTracker | null;
  pendingOutputChunks: string[];
  pendingOutputLength: number;
  outputFlushTimer: ReturnType<typeof setTimeout> | null;
  /** headless: drain+parse into history but emit no live output events; defaults true for interactive terminals */
  streamOutput: boolean;
  outputPaused: boolean;
  outputBufferPauseRequested: boolean;
  outputAckPauseRequested: boolean;
  outputAckObserved: boolean;
  outputUnackedBytes: number;
  /** force-resume watchdog so a renderer that stops ACKing can't freeze the terminal permanently */
  outputAckResumeTimer: ReturnType<typeof setTimeout> | null;
  lastInputAt: number | null;
  lastOutputAt: number | null;
  /** normalized visible output used to ignore redraw-only PTY noise */
  lastOutputSignature: string | null;
}

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput extends TerminalOpenInput {
  cols: number;
  rows: number;
}

export interface TerminalCloseOpenedAtOrBeforeInput {
  readonly threadId: string;
  readonly openedAtOrBefore: string;
}

export interface TerminalManagerShape {
  /** reuses the session for the same thread/terminal id and restores persisted history on first open */
  readonly open: (
    input: TerminalOpenInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

  readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

  readonly ackOutput: (input: TerminalAckOutputInput) => Effect.Effect<void, TerminalError>;

  readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

  readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

  /** always resets history before spawning the new process */
  readonly restart: (
    input: TerminalRestartInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

  /** omitting terminalId closes all sessions for the thread */
  readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

  /** comparison and close run under the same per-thread terminal lock */
  readonly closeSessionsOpenedAtOrBefore: (
    input: TerminalCloseOpenedAtOrBeforeInput,
  ) => Effect.Effect<void, TerminalError>;

  readonly subscribe: (listener: (event: TerminalEvent) => void) => Effect.Effect<() => void>;

  readonly dispose: Effect.Effect<void>;
}

export class TerminalManager extends ServiceMap.Service<TerminalManager, TerminalManagerShape>()(
  "synara/terminal/Services/Manager/TerminalManager",
) {}
