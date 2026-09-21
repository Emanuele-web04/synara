/** the only module knowing the helper's wire protocol: JSON-RPC 2.0 over stdio for control, a unix socket for frames (u32 LE length + contract envelope); the helper binds one simulator at a time and input coordinates are normalized 0..1 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { decodeDeviceFrame } from "@synara/shared/deviceFrame";

import type { DeviceStreamFrame } from "./DeviceBackend.ts";
import { describeSandboxSuspicion, type HelperSandboxCommand } from "./helperSandbox.ts";

export const HELPER_METHODS = {
  ping: "ping",
  list: "list",
  attach: "attach",
  streamStart: "stream.start",
  streamStop: "stream.stop",
  streamStats: "stream.stats",
  tap: "tap",
  touch: "touch",
  swipe: "swipe",
  key: "key",
  text: "text",
  button: "button",
  screenshot: "screenshot",
  describeUi: "describe-ui",
} as const;

/** `u32 little-endian payload length`, then the contract frame envelope */
const FRAME_LENGTH_PREFIX_BYTES = 4;
/** refuse absurd length prefixes rather than allocating on a desynced stream */
const FRAME_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CONTROL_LINE_BYTES = 4 * 1024 * 1024;

export class DeviceHelperError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DeviceHelperError";
    this.code = code;
  }
}

/** geometry from `attach`, used to convert device points into normalized input */
export interface DeviceHelperAttachment {
  readonly udid: string;
  readonly pointWidth: number;
  readonly pointHeight: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly scale: number;
  readonly inputAvailable: boolean;
  readonly accessibilityAvailable: boolean;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface HelperClientOptions {
  readonly binaryPath: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly requestTimeoutMs?: number;
  readonly onExit?: (reason: string) => void;
  /** resolved by the caller — building it reads the filesystem while `start()` is synchronous; absent means unconfined */
  readonly launch?: HelperSandboxCommand | undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** the error names the offending value and valid range — the common cause is passing frame pixels; "1019 is outside 0..402" makes the scale factor obvious */
function normalizeCoordinate(
  value: number,
  extent: number,
  axis: "x" | "y",
  attachment: DeviceHelperAttachment,
): number {
  if (!Number.isFinite(value) || value < 0 || value > extent) {
    throw new DeviceHelperError(
      "device_coordinate_out_of_bounds",
      `Device ${axis}=${value} is outside the screen bounds 0..${extent} device points ` +
        `(${attachment.pointWidth}x${attachment.pointHeight} points at ${attachment.scale}x; ` +
        `pass device points, not frame pixels).`,
    );
  }
  return extent === 0 ? 0 : value / extent;
}

function readNumber(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** the payload passes through as-is — it is already the contract envelope; re-parsing would duplicate `decodeDeviceFrame` */
export class DeviceFramePrefixParser {
  private buffer: Buffer = Buffer.alloc(0);

  /** every complete payload now available, in order */
  push(chunk: Uint8Array): readonly Uint8Array[] {
    this.buffer =
      this.buffer.byteLength === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, Buffer.from(chunk)]);

    const payloads: Uint8Array[] = [];
    while (this.buffer.byteLength >= FRAME_LENGTH_PREFIX_BYTES) {
      const length = this.buffer.readUInt32LE(0);
      if (length > FRAME_MAX_PAYLOAD_BYTES) {
        throw new DeviceHelperError(
          "frame_stream_desync",
          `Helper frame record claims ${length} bytes`,
        );
      }
      const total = FRAME_LENGTH_PREFIX_BYTES + length;
      if (this.buffer.byteLength < total) break;
      // copied — the payload outlives this parse and `this.buffer` is reassigned
      payloads.push(
        Uint8Array.prototype.slice.call(
          this.buffer,
          FRAME_LENGTH_PREFIX_BYTES,
          total,
        ) as Uint8Array,
      );
      this.buffer = this.buffer.subarray(total);
    }
    return payloads;
  }
}

/** frame the way the helper does; used by tests */
export function encodeFrameRecord(payload: Uint8Array): Buffer {
  const record = Buffer.alloc(FRAME_LENGTH_PREFIX_BYTES + payload.byteLength);
  record.writeUInt32LE(payload.byteLength, 0);
  record.set(payload, FRAME_LENGTH_PREFIX_BYTES);
  return record;
}

/** owns one helper process: spawn, JSON-RPC over stdio, the unix socket it connects back to */
export class HelperClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private stderrTail = "";
  private exited = false;

  private attachment: DeviceHelperAttachment | null = null;
  private frameServer: Server | null = null;
  private frameSocket: Socket | null = null;
  private frameSocketDirectory: string | null = null;

  constructor(private readonly options: HelperClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  get running(): boolean {
    return this.process !== null && !this.exited;
  }

  /** the simulator this helper is bound to, if any */
  get attachedDevice(): DeviceHelperAttachment | null {
    return this.attachment;
  }

  start(): void {
    if (this.process) return;
    const launch = this.options.launch;
    const [command, args] = launch
      ? [launch.command, [...launch.args]]
      : [this.options.binaryPath, [...(this.options.args ?? [])]];
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.options.env ?? process.env,
    });
    this.process = child;
    this.exited = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // keep only a tail — diagnostics belong in the failure message but must never grow unboundedly
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_096);
    });
    child.on("error", (error) =>
      this.fail(new DeviceHelperError("helper_spawn_failed", error.message)),
    );
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.attachment = null;
      const reason = `device helper exited (code=${code ?? "null"}, signal=${signal ?? "null"})${
        this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ""
      }`;
      this.fail(new DeviceHelperError("helper_exited", reason));
      this.options.onExit?.(reason);
    });
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.process) this.start();
    const child = this.process;
    if (!child || this.exited) {
      throw new DeviceHelperError("helper_unavailable", "Device helper is not running");
    }

    const id = this.nextRequestId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // a denied sandbox rule does not raise — CoreSimulator swallows it and the helper simply never answers, indistinguishable from a hang; name the profile so it's the first thing checked
        reject(
          new DeviceHelperError(
            "helper_timeout",
            `Device helper ${method} timed out.${describeSandboxSuspicion(
              this.options.launch?.profilePath ?? null,
            )}`,
          ),
        );
      }, this.requestTimeoutMs);
      // `unref` so a stuck request can't hold the process open at exit
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(payload, (error) => {
        if (!error) return;
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        clearTimeout(request.timer);
        reject(new DeviceHelperError("helper_write_failed", error.message));
      });
    });
  }

  /** the helper holds a single attachment — attaching a different device implicitly replaces the previous one */
  async attach(
    udid: string,
    options: { readonly force?: boolean } = {},
  ): Promise<DeviceHelperAttachment> {
    if (!options.force && this.attachment?.udid === udid) return this.attachment;
    // cleared before the request — a failed re-attach must not leave the caller believing the dead attachment is still good
    this.attachment = null;
    const result = asRecord(await this.request(HELPER_METHODS.attach, { udid }));
    const capabilities = asRecord(result.capabilities);
    const pixelWidth = readNumber(result, "pixelWidth", 0);
    const pixelHeight = readNumber(result, "pixelHeight", 0);
    const scale = readNumber(result, "scale", 3);
    const attachment: DeviceHelperAttachment = {
      udid,
      pixelWidth,
      pixelHeight,
      scale,
      pointWidth: readNumber(result, "pointWidth", pixelWidth / scale),
      pointHeight: readNumber(result, "pointHeight", pixelHeight / scale),
      inputAvailable: capabilities.input === true,
      accessibilityAvailable: capabilities.accessibility === true,
    };
    if (attachment.pointWidth <= 0 || attachment.pointHeight <= 0) {
      throw new DeviceHelperError(
        "helper_malformed_response",
        "Device helper reported no usable screen geometry",
      );
    }
    this.attachment = attachment;
    return attachment;
  }

  /** the attachment holds a descriptor tied to one boot; the helper outlives the simulator, so without this the next `attach` would short-circuit on the matching udid and fail against a dead framebuffer */
  invalidateAttachment(udid: string): void {
    if (this.attachment?.udid === udid) this.attachment = null;
  }

  /** out-of-bounds coordinates are rejected, never clamped — clamping pinned pixel-space taps to the screen edge and acked success, hiding a coordinate-space bug behind a green result */
  normalize(x: number, y: number): { readonly x: number; readonly y: number } {
    const attachment = this.attachment;
    if (!attachment) {
      throw new DeviceHelperError(
        "helper_not_attached",
        "Device helper is not attached to a device",
      );
    }
    return {
      x: normalizeCoordinate(x, attachment.pointWidth, "x", attachment),
      y: normalizeCoordinate(y, attachment.pointHeight, "y", attachment),
    };
  }

  /** the server listens first and passes the path — the helper never guesses where to connect and a stale socket file can't be reused */
  async startStream(udid: string, onFrame: (frame: DeviceStreamFrame) => void): Promise<void> {
    await this.stopStream();
    await this.attach(udid);

    const directory = await mkdtemp(path.join(tmpdir(), "synara-device-frames-"));
    const socketPath = path.join(directory, "frames.sock");
    this.frameSocketDirectory = directory;

    const server = createServer();
    this.frameServer = server;
    server.on("connection", (socket) => {
      this.frameSocket = socket;
      const parser = new DeviceFramePrefixParser();
      socket.on("data", (chunk: Buffer) => {
        let payloads: readonly Uint8Array[];
        try {
          payloads = parser.push(chunk);
        } catch {
          // a desynced stream can't resynchronize — drop it rather than emitting garbage NALs into the decoder
          socket.destroy();
          return;
        }
        for (const record of payloads) {
          const decoded = decodeDeviceFrame(record);
          if (!decoded.ok) continue;
          const { header, payload } = decoded.frame;
          onFrame({
            sequence: header.sequence,
            timestampMs: header.timestampMs,
            keyframe: header.keyframe,
            codecConfig: header.codecConfig,
            // envelope stripped — the transport re-encodes one with the routing device id; forwarding whole leaves a second header and every frame fails to decode
            data: payload,
          });
        }
      });
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        if (this.frameSocket === socket) this.frameSocket = null;
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      await this.request(HELPER_METHODS.streamStart, { socketPath });
    } catch (error) {
      await this.closeFrameSocket();
      throw error;
    }
  }

  async stopStream(): Promise<void> {
    if (this.running && this.frameServer !== null) {
      await this.request(HELPER_METHODS.streamStop).catch(() => undefined);
    }
    await this.closeFrameSocket();
  }

  async dispose(): Promise<void> {
    await this.stopStream().catch(() => undefined);
    this.fail(new DeviceHelperError("helper_disposed", "Device helper was shut down"));
    const child = this.process;
    this.process = null;
    this.attachment = null;
    this.exited = true;
    child?.stdin.end();
    child?.kill("SIGTERM");
  }

  private async closeFrameSocket(): Promise<void> {
    this.frameSocket?.destroy();
    this.frameSocket = null;
    const server = this.frameServer;
    this.frameServer = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const directory = this.frameSocketDirectory;
    this.frameSocketDirectory = null;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > MAX_CONTROL_LINE_BYTES) {
      this.stdoutBuffer = "";
      this.fail(
        new DeviceHelperError("helper_protocol_error", "Device helper control line exceeded limit"),
      );
      return;
    }
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.handleControlLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleControlLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // helper logs that aren't JSON are ignored
      return;
    }
    const record = asRecord(message);
    // notifications (`ready`, diagnostics) carry no id and need no reply
    if (typeof record.id !== "number") return;
    const request = this.pending.get(record.id);
    if (!request) return;
    this.pending.delete(record.id);
    clearTimeout(request.timer);
    if (record.error !== undefined && record.error !== null) {
      const error = asRecord(record.error);
      request.reject(
        new DeviceHelperError(
          typeof error.code === "number" ? `helper_${error.code}` : "helper_error",
          typeof error.message === "string" ? error.message : "Device helper reported an error",
        ),
      );
      return;
    }
    request.resolve(record.result ?? null);
  }

  /** reject everything in flight — used on exit, spawn failure, disposal */
  private fail(error: DeviceHelperError): void {
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
