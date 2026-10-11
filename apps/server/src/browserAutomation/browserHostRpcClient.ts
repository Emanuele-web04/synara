import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";

import type { BrowserToolName, ProviderKind, ThreadId } from "@synara/contracts";

const FRAME_HEADER_BYTES = 4;
// A bounded 8 MiB PNG expands to roughly 10.7 MiB as base64 inside the
// snapshot host envelope. Leave protocol overhead while keeping the private
// transport capped well below arbitrary-memory framing.
const MAX_FRAME_BYTES = 12 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5_000;
const INFO_TIMEOUT_MS = 5_000;
const MIN_DESKTOP_TIMEOUT_MS = 100;
const IS_LITTLE_ENDIAN = OS.endianness() === "LE";

interface MonotonicDeadline {
  readonly expiresAt: number;
}

function makeDeadline(timeoutMs: number): MonotonicDeadline {
  return { expiresAt: performance.now() + Math.max(0, timeoutMs) };
}

function remainingMs(deadline: MonotonicDeadline): number {
  return Math.max(0, deadline.expiresAt - performance.now());
}

function remainingOrThrow(deadline: MonotonicDeadline, phase: string): number {
  const remaining = remainingMs(deadline);
  if (remaining <= 0) {
    throw new BrowserHostRpcError("timeout", `Browser host ${phase} timed out.`);
  }
  return remaining;
}

type RpcId = number;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export type BrowserHostRpcFailureKind =
  | "unavailable"
  | "timeout"
  | "transport"
  | "remote"
  | "malformed";

export class BrowserHostRpcError extends Error {
  readonly kind: BrowserHostRpcFailureKind;
  readonly data?: unknown;

  constructor(kind: BrowserHostRpcFailureKind, message: string, data?: unknown) {
    super(message);
    this.name = "BrowserHostRpcError";
    this.kind = kind;
    this.data = data;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new BrowserHostRpcError("malformed", "Browser host request exceeds 12 MiB.");
  }
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  if (IS_LITTLE_ENDIAN) header.writeUInt32LE(payload.byteLength, 0);
  else header.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

function readFrameLength(buffer: Buffer): number {
  return IS_LITTLE_ENDIAN ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
}

class BrowserHostRpcConnection {
  private readonly socket: Net.Socket;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private terminalError: Error | null = null;

  private constructor(socket: Net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (error) => this.fail(new BrowserHostRpcError("transport", error.message)));
    socket.on("close", () =>
      this.fail(new BrowserHostRpcError("transport", "Browser host connection closed.")),
    );
  }

  static connect(
    path: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BrowserHostRpcConnection> {
    return new Promise((resolve, reject) => {
      const socket = Net.createConnection(path);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(
        () => {
          cleanup();
          socket.destroy();
          reject(new BrowserHostRpcError("timeout", "Browser host connection timed out."));
        },
        Math.min(timeoutMs, CONNECT_TIMEOUT_MS),
      );
      const onError = (error: Error) => {
        cleanup();
        socket.destroy();
        reject(new BrowserHostRpcError("unavailable", error.message));
      };
      const onAbort = () => {
        cleanup();
        socket.destroy();
        reject(new BrowserHostRpcError("timeout", "Browser host connection was cancelled."));
      };
      socket.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      socket.once("connect", () => {
        cleanup();
        resolve(new BrowserHostRpcConnection(socket));
      });
    });
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (signal?.aborted) {
      return Promise.reject(
        new BrowserHostRpcError("timeout", `Browser host ${method} was cancelled.`),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new BrowserHostRpcError("timeout", `Browser host ${method} timed out.`));
        this.socket.destroy();
      }, timeoutMs);
      const onAbort = () => {
        this.pending.delete(id);
        cleanup();
        reject(new BrowserHostRpcError("timeout", `Browser host ${method} was cancelled.`));
        this.socket.destroy();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      const frame = encodeFrame({ jsonrpc: "2.0", id, method, params });
      this.socket.write(frame, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(new BrowserHostRpcError("transport", error.message));
      });
    });
  }

  close(): void {
    this.socket.end();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.byteLength >= FRAME_HEADER_BYTES) {
      const length = readFrameLength(this.buffer);
      if (length > MAX_FRAME_BYTES) {
        this.fail(new BrowserHostRpcError("malformed", "Browser host frame exceeds 12 MiB."));
        this.socket.destroy();
        return;
      }
      const frameLength = FRAME_HEADER_BYTES + length;
      if (this.buffer.byteLength < frameLength) return;
      const payload = this.buffer.subarray(FRAME_HEADER_BYTES, frameLength).toString("utf8");
      this.buffer = this.buffer.subarray(frameLength);
      this.onMessage(payload);
    }
  }

  private onMessage(payload: string): void {
    let value: unknown;
    try {
      value = JSON.parse(payload) as unknown;
    } catch {
      this.fail(new BrowserHostRpcError("malformed", "Browser host returned invalid JSON."));
      return;
    }
    const record = asRecord(value);
    if (!record || typeof record.id !== "number") return;
    const pending = this.pending.get(record.id);
    if (!pending) return;
    this.pending.delete(record.id);
    if ("error" in record) {
      const error = asRecord(record.error);
      pending.reject(
        new BrowserHostRpcError(
          "remote",
          typeof error?.message === "string" && error.message.length > 0
            ? error.message
            : "Browser host rejected the request.",
          error?.data,
        ),
      );
      return;
    }
    if (!("result" in record)) {
      pending.reject(new BrowserHostRpcError("malformed", "Browser host response is incomplete."));
      return;
    }
    pending.resolve(record.result);
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export interface BrowserHostToolCall {
  readonly pipePath: string;
  readonly capability: string;
  readonly sessionKey: string;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly name: BrowserToolName;
  readonly arguments: Record<string, unknown>;
  /** Server-resolved authenticated thread workspace. Never sourced from MCP arguments. */
  readonly workspaceRoot?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

function assertCompatibleHostInfo(value: unknown, expectedSessionId: string): void {
  const info = asRecord(value);
  const metadata = asRecord(info?.metadata);
  const protocolVersion = metadata?.protocolVersion ?? info?.protocolVersion;
  const sessionId = metadata?.sessionId;
  const methods = metadata?.methods;
  if (
    protocolVersion !== 1 ||
    (info?.type !== undefined && info.type !== "synara-browser-host") ||
    (sessionId !== undefined && sessionId !== expectedSessionId) ||
    (methods !== undefined && (!Array.isArray(methods) || !methods.includes("executeTool")))
  ) {
    throw new BrowserHostRpcError(
      "malformed",
      "The visible browser host uses an incompatible protocol.",
    );
  }
}

export async function callBrowserHostTool(input: BrowserHostToolCall): Promise<unknown> {
  const deadline = makeDeadline(input.timeoutMs);
  const connection = await BrowserHostRpcConnection.connect(
    input.pipePath,
    remainingOrThrow(deadline, "connection"),
    input.signal,
  );
  try {
    const hostInfo = await connection.request(
      "getInfo",
      { session_id: input.sessionKey, capability: input.capability },
      Math.min(remainingOrThrow(deadline, "getInfo"), INFO_TIMEOUT_MS),
      input.signal,
    );
    assertCompatibleHostInfo(hostInfo, input.sessionKey);
    const executeBudget = Math.floor(remainingOrThrow(deadline, "executeTool"));
    // The desktop validates the public timeout lower bound. If transport/auth
    // overhead consumed all but a sub-action quantum, fail here instead of
    // manufacturing a fresh desktop budget beyond the caller's deadline.
    if (executeBudget < MIN_DESKTOP_TIMEOUT_MS) {
      throw new BrowserHostRpcError("timeout", "Browser host executeTool timed out.");
    }
    return await connection.request(
      "executeTool",
      {
        session_id: input.sessionKey,
        provider: input.provider,
        thread_id: input.threadId,
        name: input.name,
        arguments: { ...input.arguments, timeoutMs: executeBudget },
        ...(input.workspaceRoot === undefined ? {} : { workspace_root: input.workspaceRoot }),
      },
      remainingOrThrow(deadline, "executeTool"),
      input.signal,
    );
  } finally {
    connection.close();
  }
}

export function resolveBrowserHostPipePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured =
    env.SYNARA_BROWSER_HOST_PIPE_PATH?.trim() || env.SYNARA_BROWSER_USE_PIPE_PATH?.trim();
  return configured || null;
}

let inheritedCapabilityFromFd: string | null | undefined;

export function resolveBrowserHostCapability(env: NodeJS.ProcessEnv = process.env): string | null {
  const direct = env.SYNARA_BROWSER_HOST_CAPABILITY?.trim();
  if (direct && Buffer.byteLength(direct, "utf8") >= 32) return direct;

  const rawFd = env.SYNARA_BROWSER_HOST_CAPABILITY_FD?.trim();
  if (!rawFd || !/^\d+$/.test(rawFd)) return null;
  const fd = Number(rawFd);
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 255) return null;
  if (inheritedCapabilityFromFd !== undefined) return inheritedCapabilityFromFd;
  try {
    const value = FS.readFileSync(fd, "utf8").trim();
    inheritedCapabilityFromFd = Buffer.byteLength(value, "utf8") >= 32 ? value : null;
  } catch {
    inheritedCapabilityFromFd = null;
  } finally {
    try {
      FS.closeSync(fd);
    } catch {
      // The inherited one-shot descriptor may already have been closed by the runtime.
    }
  }
  return inheritedCapabilityFromFd;
}
