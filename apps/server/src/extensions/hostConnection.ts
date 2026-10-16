import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { createProtocolProcessTeardown } from "../platform/protocolProcessTeardown";

const MAX_FRAME = 8 * 1_024 * 1_024;
const frameSchema = z.object({
  token: z.string().max(128),
  kind: z.enum(["request", "response", "event"]),
  id: z.number().int().nonnegative().optional(),
  method: z.string().max(128).optional(),
  event: z.string().max(128).optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  body: z.unknown().optional(),
  ok: z.boolean().optional(),
  error: z.string().max(16_384).optional(),
  stack: z.string().max(65_536).optional(),
});
type Waiting = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };
export type ExtensionNativeRequest = (
  method: string,
  params: unknown,
  signal: AbortSignal,
) => Promise<unknown>;

/** Private fd 3 isolates protocol messages from extension stdout/stderr. */
export class ExtensionHostConnection {
  private readonly token = randomBytes(32).toString("hex");
  private sequence = 1;
  private readonly waiting = new Map<number, Waiting>();
  private readonly native = new Map<number, AbortController>();
  private readonly decoder = new StringDecoder("utf8");
  private input = "";
  private failure: Error | undefined;
  private closing = false;
  private readonly teardown: () => Promise<void>;
  readonly events: { event: string; body: unknown }[] = [];
  readonly startedAt = performance.now();
  private eventBytes = 0;
  private outputBytes = 0;

  constructor(
    readonly process: ChildProcess,
    private readonly nativeRequest: ExtensionNativeRequest,
    private readonly onEvent: (event: string, body: unknown) => void = () => undefined,
  ) {
    const protocol = process.stdio[3];
    if (!process.stdin || !process.stdout || !process.stderr || !(protocol instanceof Readable)) {
      throw new Error("Extension host requires private standard and protocol pipes.");
    }
    this.teardown = createProtocolProcessTeardown(process, async () => {
      if (this.failure || process.exitCode !== null || process.signalCode !== null) return;
      await this.request("shutdown", {}, undefined, 2_000);
    });
    protocol.on("data", (chunk: Buffer) => {
      try {
        this.input += this.decoder.write(chunk);
        let newline: number;
        while ((newline = this.input.indexOf("\n")) !== -1) {
          const line = this.input.slice(0, newline);
          this.input = this.input.slice(newline + 1);
          if (Buffer.byteLength(line) > MAX_FRAME)
            throw new Error("Extension host exceeded its frame limit.");
          if (line) this.receive(frameSchema.parse(JSON.parse(line)));
        }
        if (Buffer.byteLength(this.input) > MAX_FRAME)
          throw new Error("Extension host exceeded its frame limit.");
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("Invalid extension host message."));
      }
    });
    const log = (source: string, chunk: Buffer) => {
      this.outputBytes += chunk.length;
      if (this.outputBytes > 4 * 1_024 * 1_024) {
        this.fail(new Error("Extension host exceeded its diagnostic output limit."));
        return;
      }
      this.onEvent(source, chunk.toString("utf8").slice(0, 16_384));
    };
    process.stdout.on("data", (chunk: Buffer) => log("stdout", chunk));
    process.stderr.on("data", (chunk: Buffer) => log("stderr", chunk));
    process.once("error", (error) => this.fail(error));
    process.once("exit", (code, signal) => {
      const error = new Error(`Extension host exited (${code ?? signal ?? "unknown"}).`);
      this.failure ??= error;
      this.rejectPending(error);
      this.onEvent("exit", { code, signal, expected: this.closing });
    });
  }
  private rejectPending(error: Error): void {
    for (const pending of this.waiting.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.waiting.clear();
    for (const controller of this.native.values()) controller.abort(error);
    this.native.clear();
  }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.rejectPending(error);
    this.onEvent("failure", error.message);
    void this.stop().catch((cleanup: unknown) => this.onEvent("cleanupError", String(cleanup)));
  }
  private send(frame: Record<string, unknown>): void {
    if (this.failure) throw this.failure;
    const contents = JSON.stringify({ ...frame, token: this.token }) + "\n";
    if (Buffer.byteLength(contents) > MAX_FRAME)
      throw new Error("Extension host request exceeds its frame limit.");
    if (
      !this.process.stdin ||
      this.process.stdin.destroyed ||
      this.process.stdin.writableLength > MAX_FRAME
    ) {
      throw new Error("Extension host input is unavailable or saturated.");
    }
    this.process.stdin.write(contents, (error) => {
      if (error) this.fail(error);
    });
  }
  private receive(frame: z.infer<typeof frameSchema>): void {
    if (frame.token !== this.token) throw new Error("Extension host authentication failed.");
    if (frame.kind === "response") {
      if (frame.id === undefined || frame.ok === undefined)
        throw new Error("Invalid extension host response.");
      const waiting = this.waiting.get(frame.id);
      if (!waiting) return;
      this.waiting.delete(frame.id);
      waiting.cleanup();
      if (frame.ok) waiting.resolve(frame.result);
      else
        waiting.reject(
          new Error(frame.error ?? "Extension host rejected the operation.", {
            cause: frame.stack,
          }),
        );
      return;
    }
    if (frame.kind === "event") {
      if (!frame.event) throw new Error("Invalid extension host event.");
      this.events.push({ event: frame.event, body: frame.body });
      this.eventBytes += JSON.stringify(frame.body ?? null).length;
      while (this.events.length > 100 || this.eventBytes > 1_000_000)
        this.eventBytes -= JSON.stringify(this.events.shift()!.body ?? null).length;
      this.onEvent(frame.event, frame.body);
      return;
    }
    if (
      frame.id === undefined ||
      !frame.method ||
      this.native.has(frame.id) ||
      this.native.size >= 128
    ) {
      throw new Error("Invalid or excessive extension host native request.");
    }
    const id = frame.id;
    const controller = new AbortController();
    this.native.set(id, controller);
    const timeout = setTimeout(
      () => controller.abort(new Error("Native extension request timed out.")),
      120_000,
    ).unref();
    // Own the native operation until it settles or the bounded deadline aborts it.
    void Promise.resolve()
      .then(() => this.nativeRequest(frame.method!, frame.params, controller.signal))
      .then(
        (result) => {
          if (!this.failure) this.send({ kind: "response", id, ok: true, result });
        },
        (error: unknown) => {
          if (!this.failure)
            this.send({
              kind: "response",
              id,
              ok: false,
              error: error instanceof Error ? error.message : "Native extension operation failed.",
            });
        },
      )
      .catch((error: unknown) =>
        this.fail(error instanceof Error ? error : new Error(String(error))),
      )
      .finally(() => {
        clearTimeout(timeout);
        this.native.delete(id);
      });
  }
  request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing && method !== "shutdown")
      return Promise.reject(new Error("Extension host is stopping."));
    if (this.waiting.size >= 64)
      return Promise.reject(new Error("Extension host request capacity exceeded."));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = this.sequence++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiting.delete(id);
        cleanup();
        reject(new Error("Extension request was cancelled."));
      };
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        cleanup();
        reject(new Error(`Extension host ${method} timed out.`));
      }, timeoutMs).unref();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.waiting.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.send({ kind: "request", id, method, params });
      } catch (error) {
        this.waiting.delete(id);
        cleanup();
        reject(error);
      }
    });
  }
  async stop(): Promise<void> {
    this.closing = true;
    await this.teardown();
    this.rejectPending(new Error("Extension host stopped."));
  }
}
