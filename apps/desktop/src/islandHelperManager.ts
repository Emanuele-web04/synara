// FILE: islandHelperManager.ts
// Purpose: Owns the optional native macOS island helper lifecycle and bounded JSONL transport.
// Layer: Desktop main-process service
// Depends on: A packaged helper implementing the Synara island protocol v1.

import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import type { Readable, Writable } from "node:stream";

export const ISLAND_HELPER_PROTOCOL_VERSION = 1;
export const ISLAND_HELPER_MAX_LINE_BYTES = 64 * 1024;

const DEFAULT_READY_TIMEOUT_MS = 2_000;
const DEFAULT_RESTART_DELAY_MS = 150;
const DEFAULT_MAX_RESTARTS = 2;
const MAX_ACTION_ID_CHARS = 128;
const MAX_TARGET_ID_CHARS = 512;
const MAX_REMEMBERED_ACTION_IDS = 256;
const MAX_STDERR_CHARS = 4_096;

type IslandHelperProcess = ChildProcess.ChildProcessByStdio<Writable, Readable, Readable>;

export type IslandHelperActionKind = "open-thread" | "deny" | "allow-once" | "always-allow";

export type IslandHelperAction =
  | {
      actionId: string;
      revision: number;
      kind: "open-thread";
      threadId: string;
    }
  | {
      actionId: string;
      revision: number;
      kind: Exclude<IslandHelperActionKind, "open-thread">;
      threadId: string;
      requestId: string;
    };

export type IslandHelperStatus =
  | "idle"
  | "unsupported"
  | "unavailable"
  | "starting"
  | "ready"
  | "restarting"
  | "fallback"
  | "disposed";

export type IslandHelperFailureCode =
  | "unsupported-platform"
  | "capability-disabled"
  | "helper-missing"
  | "helper-spawn-failed"
  | "helper-crashed"
  | "ready-timeout"
  | "protocol-error"
  | "protocol-line-too-large"
  | "snapshot-too-large"
  | "write-failed"
  | "invalid-action";

export interface IslandHelperFailure {
  code: IslandHelperFailureCode;
  message: string;
}

export interface IslandHelperState {
  status: IslandHelperStatus;
  nativeActive: boolean;
  restartCount: number;
  renderedRevision: number | null;
  failure: IslandHelperFailure | null;
}

export interface DesktopIslandHelperManagerOptions {
  platform: NodeJS.Platform;
  capability: boolean;
  helperPath: string;
  onAction: (action: IslandHelperAction) => void;
  onState?: (state: IslandHelperState) => void;
  onFallback?: (failure: IslandHelperFailure) => void;
  onError?: (failure: IslandHelperFailure) => void;
  spawn?: typeof ChildProcess.spawn;
  helperExists?: (helperPath: string) => boolean;
  readyTimeoutMs?: number;
  restartDelayMs?: number;
  maxRestarts?: number;
}

type IslandHelperOutputMessage =
  | { type: "ready"; protocolVersion: typeof ISLAND_HELPER_PROTOCOL_VERSION }
  | { type: "rendered"; revision: number }
  | ({ type: "action" } & IslandHelperAction);

interface SerializedSnapshot {
  revision: number;
  line: string;
  activatesNative: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotActivatesNative(payload: object): boolean {
  return !(isRecord(payload) && payload.mode === "idle");
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isBoundedIdentifier(value: unknown, maximumChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumChars &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function parseAction(value: Record<string, unknown>): IslandHelperAction | null {
  if (
    !isBoundedIdentifier(value.actionId, MAX_ACTION_ID_CHARS) ||
    !isRevision(value.revision) ||
    !isBoundedIdentifier(value.threadId, MAX_TARGET_ID_CHARS)
  ) {
    return null;
  }

  if (value.kind === "open-thread") {
    return {
      actionId: value.actionId,
      revision: value.revision,
      kind: value.kind,
      threadId: value.threadId,
    };
  }

  if (
    (value.kind === "deny" || value.kind === "allow-once" || value.kind === "always-allow") &&
    isBoundedIdentifier(value.requestId, MAX_TARGET_ID_CHARS)
  ) {
    return {
      actionId: value.actionId,
      revision: value.revision,
      kind: value.kind,
      threadId: value.threadId,
      requestId: value.requestId,
    };
  }

  return null;
}

export function parseIslandHelperOutput(line: string): IslandHelperOutputMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  if (parsed.type === "ready" && parsed.protocolVersion === ISLAND_HELPER_PROTOCOL_VERSION) {
    return {
      type: "ready",
      protocolVersion: ISLAND_HELPER_PROTOCOL_VERSION,
    };
  }

  if (parsed.type === "rendered" && isRevision(parsed.revision)) {
    return { type: "rendered", revision: parsed.revision };
  }

  if (parsed.type === "action") {
    const action = parseAction(parsed);
    return action ? { type: "action", ...action } : null;
  }

  return null;
}

function cloneState(state: IslandHelperState): IslandHelperState {
  return {
    ...state,
    failure: state.failure ? { ...state.failure } : null,
  };
}

function stateEquals(left: IslandHelperState, right: IslandHelperState): boolean {
  return (
    left.status === right.status &&
    left.nativeActive === right.nativeActive &&
    left.restartCount === right.restartCount &&
    left.renderedRevision === right.renderedRevision &&
    left.failure?.code === right.failure?.code &&
    left.failure?.message === right.failure?.message
  );
}

export class DesktopIslandHelperManager {
  readonly #options: Required<
    Pick<
      DesktopIslandHelperManagerOptions,
      "spawn" | "helperExists" | "readyTimeoutMs" | "restartDelayMs" | "maxRestarts"
    >
  > &
    Omit<
      DesktopIslandHelperManagerOptions,
      "spawn" | "helperExists" | "readyTimeoutMs" | "restartDelayMs" | "maxRestarts"
    >;

  #state: IslandHelperState = {
    status: "idle",
    nativeActive: false,
    restartCount: 0,
    renderedRevision: null,
    failure: null,
  };
  #child: IslandHelperProcess | null = null;
  #readyTimer: NodeJS.Timeout | null = null;
  #restartTimer: NodeJS.Timeout | null = null;
  #started = false;
  #disposed = false;
  #ready = false;
  #nextRevision = 0;
  #latestSnapshot: SerializedSnapshot | null = null;
  #inFlightSnapshot: SerializedSnapshot | null = null;
  #stdoutRemainder = Buffer.alloc(0);
  #stderr = "";
  readonly #acceptedActionIds = new Set<string>();
  readonly #acceptedActionOrder: string[] = [];

  constructor(options: DesktopIslandHelperManagerOptions) {
    this.#options = {
      ...options,
      spawn: options.spawn ?? ChildProcess.spawn,
      helperExists: options.helperExists ?? FS.existsSync,
      readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      restartDelayMs: options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
      maxRestarts: options.maxRestarts ?? DEFAULT_MAX_RESTARTS,
    };
  }

  getState(): IslandHelperState {
    return cloneState(this.#state);
  }

  start(): IslandHelperState {
    if (this.#disposed || this.#started) return this.getState();
    this.#started = true;

    if (this.#options.platform !== "darwin") {
      this.#enterUnavailable("unsupported", {
        code: "unsupported-platform",
        message: "The native island helper is available only on macOS.",
      });
      return this.getState();
    }

    if (!this.#options.capability) {
      this.#enterUnavailable("unavailable", {
        code: "capability-disabled",
        message: "This desktop build does not include the native island capability.",
      });
      return this.getState();
    }

    if (!this.#options.helperExists(this.#options.helperPath)) {
      this.#enterUnavailable("unavailable", {
        code: "helper-missing",
        message: "The native island helper is missing from this desktop build.",
      });
      return this.getState();
    }

    this.#launch();
    return this.getState();
  }

  publishSnapshot(payload: object): number | null {
    if (this.#disposed) return null;

    const revision = this.#nextRevision + 1;
    let line: string;
    try {
      line = `${JSON.stringify({ type: "snapshot", revision, payload })}\n`;
    } catch (error) {
      this.#reportError({
        code: "protocol-error",
        message: `Could not serialize the native island snapshot: ${error instanceof Error ? error.message : String(error)}`,
      });
      return null;
    }

    if (Buffer.byteLength(line, "utf8") > ISLAND_HELPER_MAX_LINE_BYTES) {
      this.#reportError({
        code: "snapshot-too-large",
        message: `The native island snapshot exceeded ${ISLAND_HELPER_MAX_LINE_BYTES} bytes.`,
      });
      return null;
    }

    this.#nextRevision = revision;
    this.#latestSnapshot = {
      revision,
      line,
      activatesNative: snapshotActivatesNative(payload),
    };
    this.#pumpSnapshot();
    return revision;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#started = false;
    this.#clearReadyTimer();
    this.#clearRestartTimer();
    this.#latestSnapshot = null;
    this.#inFlightSnapshot = null;
    this.#acceptedActionIds.clear();
    this.#acceptedActionOrder.length = 0;

    const child = this.#detachChild();
    if (child) {
      try {
        child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
        child.stdin.end();
      } catch {
        // The process may already have closed its input while Electron disposes.
      }
      child.kill("SIGTERM");
    }

    this.#setState({
      status: "disposed",
      nativeActive: false,
      renderedRevision: null,
      failure: null,
    });
  }

  #launch(): void {
    if (this.#disposed) return;
    if (!this.#options.helperExists(this.#options.helperPath)) {
      this.#enterUnavailable("unavailable", {
        code: "helper-missing",
        message: "The native island helper is missing from this desktop build.",
      });
      return;
    }

    this.#setState({
      status: this.#state.restartCount > 0 ? "restarting" : "starting",
      nativeActive: false,
      renderedRevision: null,
      failure: null,
    });

    let child: IslandHelperProcess;
    try {
      child = this.#options.spawn(this.#options.helperPath, ["--stdio-jsonl"], {
        stdio: ["pipe", "pipe", "pipe"],
      }) as IslandHelperProcess;
    } catch (error) {
      this.#recover({
        code: "helper-spawn-failed",
        message: `Could not start the native island helper: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    this.#child = child;
    this.#ready = false;
    this.#inFlightSnapshot = null;
    this.#stdoutRemainder = Buffer.alloc(0);
    this.#stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      this.#consumeStdout(child, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (this.#child !== child || this.#stderr.length >= MAX_STDERR_CHARS) return;
      this.#stderr = `${this.#stderr}${chunk.toString()}`.slice(0, MAX_STDERR_CHARS);
    });
    child.stdin.once("error", (error) => {
      this.#failChild(child, {
        code: "write-failed",
        message: `The native island helper stopped accepting updates: ${error.message}`,
      });
    });
    child.once("error", (error) => {
      this.#failChild(child, {
        code: "helper-spawn-failed",
        message: `Could not start the native island helper: ${error.message}`,
      });
    });
    child.once("exit", (code, signal) => {
      const suffix = this.#stderr.trim();
      const diagnostic = suffix.length > 0 ? ` ${suffix}` : "";
      this.#failChild(child, {
        code: "helper-crashed",
        message: `The native island helper stopped unexpectedly (${signal ?? `exit ${code ?? "unknown"}`}).${diagnostic}`,
      });
    });

    this.#readyTimer = setTimeout(() => {
      this.#failChild(child, {
        code: "ready-timeout",
        message: "The native island helper did not become ready in time.",
      });
    }, this.#options.readyTimeoutMs);
    this.#readyTimer.unref();
  }

  #consumeStdout(child: IslandHelperProcess, chunk: Buffer): void {
    if (this.#child !== child || this.#disposed) return;

    let offset = 0;
    while (offset < chunk.length && this.#child === child) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);

      if (this.#stdoutRemainder.length + segment.length > ISLAND_HELPER_MAX_LINE_BYTES) {
        this.#failChild(child, {
          code: "protocol-line-too-large",
          message: `The native island helper emitted a line larger than ${ISLAND_HELPER_MAX_LINE_BYTES} bytes.`,
        });
        return;
      }

      if (segment.length > 0) {
        this.#stdoutRemainder = Buffer.concat([this.#stdoutRemainder, segment]);
      }

      if (newline === -1) return;

      let lineBytes = this.#stdoutRemainder;
      this.#stdoutRemainder = Buffer.alloc(0);
      if (lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, -1);
      if (lineBytes.length > 0) {
        let line: string;
        try {
          line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
        } catch {
          this.#failChild(child, {
            code: "protocol-error",
            message: "The native island helper emitted invalid UTF-8.",
          });
          return;
        }
        this.#handleLine(child, line);
      }
      offset = newline + 1;
    }
  }

  #handleLine(child: IslandHelperProcess, line: string): void {
    if (this.#child !== child || this.#disposed) return;
    const message = parseIslandHelperOutput(line);
    if (!message) {
      let failureCode: IslandHelperFailureCode = "protocol-error";
      try {
        const invalidMessage = JSON.parse(line) as unknown;
        if (isRecord(invalidMessage) && invalidMessage.type === "action") {
          failureCode = "invalid-action";
        }
      } catch {
        // Invalid JSON is a generic protocol error.
      }
      this.#reportError({
        code: failureCode,
        message: "The native island helper emitted an invalid protocol message.",
      });
      return;
    }

    if (message.type === "ready") {
      if (this.#ready) return;
      this.#ready = true;
      this.#clearReadyTimer();
      this.#setState({
        status: "ready",
        // Keep the React island visible until the helper proves that it rendered
        // the current revision. A ready process can still have an empty window.
        nativeActive: false,
        renderedRevision: null,
        failure: null,
      });
      this.#pumpSnapshot();
      return;
    }

    if (!this.#ready) {
      this.#reportError({
        code: "protocol-error",
        message: "The native island helper sent output before its ready handshake.",
      });
      return;
    }

    if (message.type === "rendered") {
      const renderedSnapshot = this.#inFlightSnapshot;
      if (message.revision !== renderedSnapshot?.revision) return;
      this.#inFlightSnapshot = null;
      this.#setState({
        nativeActive: renderedSnapshot.activatesNative,
        renderedRevision: message.revision,
      });
      this.#pumpSnapshot();
      return;
    }

    this.#handleAction(message);
  }

  #handleAction(message: Extract<IslandHelperOutputMessage, { type: "action" }>): void {
    const action: IslandHelperAction =
      message.kind === "open-thread"
        ? {
            actionId: message.actionId,
            revision: message.revision,
            kind: message.kind,
            threadId: message.threadId,
          }
        : {
            actionId: message.actionId,
            revision: message.revision,
            kind: message.kind,
            threadId: message.threadId,
            requestId: message.requestId,
          };

    if (
      action.revision !== this.#state.renderedRevision ||
      this.#acceptedActionIds.has(action.actionId)
    ) {
      return;
    }

    this.#acceptedActionIds.add(action.actionId);
    this.#acceptedActionOrder.push(action.actionId);
    if (this.#acceptedActionOrder.length > MAX_REMEMBERED_ACTION_IDS) {
      const expiredId = this.#acceptedActionOrder.shift();
      if (expiredId) this.#acceptedActionIds.delete(expiredId);
    }

    try {
      this.#options.onAction(action);
    } catch (error) {
      this.#reportError({
        code: "invalid-action",
        message: `Could not handle the native island action: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  #pumpSnapshot(): void {
    if (
      this.#disposed ||
      !this.#ready ||
      !this.#child ||
      this.#inFlightSnapshot !== null ||
      !this.#latestSnapshot ||
      this.#latestSnapshot.revision === this.#state.renderedRevision
    ) {
      return;
    }

    const child = this.#child;
    const snapshot = this.#latestSnapshot;
    this.#inFlightSnapshot = snapshot;
    try {
      child.stdin.write(snapshot.line, "utf8", (error) => {
        if (!error) return;
        this.#failChild(child, {
          code: "write-failed",
          message: `Could not update the native island helper: ${error.message}`,
        });
      });
    } catch (error) {
      this.#failChild(child, {
        code: "write-failed",
        message: `Could not update the native island helper: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  #failChild(child: IslandHelperProcess, failure: IslandHelperFailure): void {
    if (this.#child !== child || this.#disposed) return;
    const detached = this.#detachChild();
    detached?.kill("SIGTERM");
    this.#recover(failure);
  }

  #recover(failure: IslandHelperFailure): void {
    if (this.#disposed) return;
    this.#clearReadyTimer();
    this.#ready = false;
    this.#inFlightSnapshot = null;
    this.#options.onFallback?.(failure);

    if (this.#state.restartCount >= this.#options.maxRestarts) {
      this.#setState({
        status: "fallback",
        nativeActive: false,
        renderedRevision: null,
        failure,
      });
      return;
    }

    const restartCount = this.#state.restartCount + 1;
    this.#setState({
      status: "restarting",
      nativeActive: false,
      restartCount,
      renderedRevision: null,
      failure,
    });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      this.#launch();
    }, this.#options.restartDelayMs);
    this.#restartTimer.unref();
  }

  #enterUnavailable(
    status: Extract<IslandHelperStatus, "unsupported" | "unavailable">,
    failure: IslandHelperFailure,
  ): void {
    this.#options.onFallback?.(failure);
    this.#setState({
      status,
      nativeActive: false,
      renderedRevision: null,
      failure,
    });
  }

  #detachChild(): IslandHelperProcess | null {
    const child = this.#child;
    this.#child = null;
    this.#ready = false;
    this.#inFlightSnapshot = null;
    this.#stdoutRemainder = Buffer.alloc(0);
    this.#stderr = "";
    this.#clearReadyTimer();
    return child;
  }

  #clearReadyTimer(): void {
    if (!this.#readyTimer) return;
    clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
  }

  #clearRestartTimer(): void {
    if (!this.#restartTimer) return;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
  }

  #reportError(failure: IslandHelperFailure): void {
    this.#options.onError?.(failure);
  }

  #setState(patch: Partial<IslandHelperState>): void {
    const next = { ...this.#state, ...patch };
    if (stateEquals(this.#state, next)) return;
    this.#state = next;
    this.#options.onState?.(this.getState());
  }
}
