import {
  JSONRPC_STDIO_MAX_FRAME_BYTES,
  JSONRPC_STDIO_MAX_QUEUED_STDIN_BYTES,
  JsonRpcStdioFramer,
  JsonRpcStdioTransportError,
  JsonRpcStdioWriter,
  type JsonRpcStdioTransportErrorReason,
} from "@synara/shared/jsonrpc-stdio";

export const CODEX_APP_SERVER_MAX_FRAME_BYTES = JSONRPC_STDIO_MAX_FRAME_BYTES;
// Plugin catalogs have no pagination in the app-server protocol and can exceed
// the conversation budget. Keep their larger responses on discovery processes.
export const CODEX_APP_SERVER_MAX_DISCOVERY_FRAME_BYTES = 32 * 1024 * 1024;
export const CODEX_APP_SERVER_MAX_QUEUED_STDIN_BYTES = JSONRPC_STDIO_MAX_QUEUED_STDIN_BYTES;

export type CodexAppServerTransportErrorReason = JsonRpcStdioTransportErrorReason;

type CodexTransportErrorInput = {
  readonly reason: CodexAppServerTransportErrorReason;
  readonly maxBytes: number;
  readonly observedBytes: number;
  readonly cause?: unknown;

  constructor(input: {
    readonly reason: CodexAppServerTransportErrorReason;
    readonly maxBytes: number;
    readonly observedBytes: number;
    readonly cause?: unknown;
  }) {
    super(transportErrorMessage(input), (input.cause !== undefined ? { cause: input.cause } : {}));
    this.name = "CodexAppServerTransportError";
    this.reason = input.reason;
    this.maxBytes = input.maxBytes;
    this.observedBytes = input.observedBytes;
  }
}

/** Raw-byte JSONL framing so split UTF-8 sequences never decode prematurely. */
export class CodexJsonlFramer {
  private readonly chunks: Buffer[] = [];
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private frameBytes = 0;
  private ended = false;

  constructor(readonly maxFrameBytes = CODEX_APP_SERVER_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new RangeError("Codex JSONL frame budget must be a positive safe integer");
    }
  }

  push(chunk: Buffer | Uint8Array | string): ReadonlyArray<string> {
    if (this.ended) {
      throw new CodexAppServerTransportError({
        reason: "unterminated-frame",
        maxBytes: this.maxFrameBytes,
        observedBytes: this.frameBytes,
      });
    }

    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const frames: string[] = [];
    let start = 0;

    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start);
      const end = newline === -1 ? bytes.length : newline;
      this.append(bytes.subarray(start, end));
      if (newline === -1) break;
      frames.push(this.takeFrame());
      start = newline + 1;
    }

    return frames;
  }

  finish(): void {
    this.ended = true;
    if (this.frameBytes > 0) {
      throw new CodexAppServerTransportError({
        reason: "unterminated-frame",
        maxBytes: this.maxFrameBytes,
        observedBytes: this.frameBytes,
      });
    }
  }

  reset(): void {
    this.chunks.length = 0;
    this.frameBytes = 0;
    this.ended = true;
  }

  get bufferedBytes(): number {
    return this.frameBytes;
  }

  private append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    const observedBytes = this.frameBytes + chunk.length;
    if (observedBytes > this.maxFrameBytes) {
      throw new CodexAppServerTransportError({
        reason: "frame-too-large",
        maxBytes: this.maxFrameBytes,
        observedBytes,
      });
    }
    // Do not retain a large source chunk through one small trailing slice.
    this.chunks.push(Buffer.from(chunk));
    this.frameBytes = observedBytes;
  }

  private takeFrame(): string {
    let frame = Buffer.concat(this.chunks, this.frameBytes);
    if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
    this.chunks.length = 0;
    this.frameBytes = 0;
    try {
      return this.decoder.decode(frame);
    } catch (cause) {
      throw new CodexAppServerTransportError({
        reason: "invalid-utf8",
        maxBytes: this.maxFrameBytes,
        observedBytes: frame.length,
        cause,
      });
    }
  }
}

type PendingWrite = {
  readonly frame: Buffer;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

export class CodexAppServerTransportError extends JsonRpcStdioTransportError {
  constructor(input: CodexTransportErrorInput) {
    super({ ...input, message: transportErrorMessage(input) });
    this.name = "CodexAppServerTransportError";
  }
}

/**
 * Whether a stdout line the framer dropped has to end the session.
 *
 * Only an oversized line does: a frame past the budget was on the wire, so a
 * response we may be waiting on is gone. Invalid UTF-8 costs only its own line.
 * Codex subprocesses and hooks can leak arbitrary output onto the same pipe,
 * which the manager already ignores when it is not JSON, and the framer has
 * resynchronized past it.
 */
export const isFatalCodexLineError = (error: JsonRpcStdioTransportError): boolean =>
  error.reason === "frame-too-large";

/** Codex-compatible name for the shared raw-byte JSONL framer. */
export class CodexJsonlFramer extends JsonRpcStdioFramer {
  constructor(maxFrameBytes = CODEX_APP_SERVER_MAX_FRAME_BYTES) {
    super(maxFrameBytes, (error) => {
      if (isFatalCodexLineError(error)) throw error;
    });
  }

  protected override makeTransportError(
    input: CodexTransportErrorInput,
  ): CodexAppServerTransportError {
    return new CodexAppServerTransportError(input);
  }
}

/** Codex-compatible name for the shared bounded, drain-aware JSONL writer. */
export class CodexJsonlWriter extends JsonRpcStdioWriter {
  constructor(
    writable: ConstructorParameters<typeof JsonRpcStdioWriter>[0],
    maxFrameBytes = CODEX_APP_SERVER_MAX_FRAME_BYTES,
    maxQueuedBytes = CODEX_APP_SERVER_MAX_QUEUED_STDIN_BYTES,
  ) {
    super(writable, maxFrameBytes, maxQueuedBytes);
  }

  protected override makeTransportError(
    input: CodexTransportErrorInput,
  ): CodexAppServerTransportError {
    return new CodexAppServerTransportError(input);
  }

  protected override serializationError(cause?: unknown): Error {
    if (cause instanceof Error) return cause;
    if (cause !== undefined) return new Error(String(cause));
    return new TypeError("Codex app-server message is not JSON serializable");
  }

  protected override stdinClosedDuringWriteError(): Error {
    return new Error("Codex app-server stdin closed during write");
  }

  protected override stdinWriteAbortedError(): Error {
    return new Error("Codex app-server stdin write aborted");
  }
}

function transportErrorMessage(input: CodexTransportErrorInput): string {
  switch (input.reason) {
    case "invalid-utf8":
      return `Codex app-server emitted invalid UTF-8 (${input.observedBytes} bytes).`;
    case "read-closed":
      return "Codex app-server stdout closed before process shutdown.";
    case "unterminated-frame":
      return `Codex app-server stdout ended with an unterminated JSONL frame (${input.observedBytes}/${input.maxBytes} bytes).`;
    case "frame-too-large":
      return `Codex app-server JSONL frame exceeded its byte limit (${input.observedBytes}/${input.maxBytes}).`;
    case "write-overloaded":
      return `Codex app-server stdin queue exceeded its byte limit (${input.observedBytes}/${input.maxBytes}).`;
    case "write-closed":
      return "Codex app-server stdin closed before the frame was written.";
  }
}
