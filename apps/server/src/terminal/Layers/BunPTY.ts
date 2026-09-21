import { Effect, Layer } from "effect";
import { PtyAdapter, PtyAdapterShape, PtyExitEvent, PtyProcess } from "../Services/PTY";

/** force-flush cap for paused output — Bun's PTY has no read-pause primitive, so the producer can't be stopped under overload */
const PAUSE_BUFFER_LIMIT = 8 * 1024 * 1024;

class BunPtyProcess implements PtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  private readonly decoder = new TextDecoder();
  private didExit = false;
  // push-only `data` callback: buffer raw output while paused, flush on resume — keeps pause/resume consistent with NodePTY
  private paused = false;
  private readonly pausedChunks: Uint8Array[] = [];
  private pausedBytes = 0;

  constructor(private readonly process: Bun.Subprocess) {
    void this.process.exited
      .then((exitCode) => {
        this.emitExit({
          exitCode: Number.isInteger(exitCode) ? exitCode : 0,
          signal: typeof this.process.signalCode === "number" ? this.process.signalCode : null,
        });
      })
      .catch(() => {
        this.emitExit({ exitCode: 1, signal: null });
      });
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    if (!this.process.terminal) {
      throw new Error("Bun PTY terminal handle is unavailable");
    }
    this.process.terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.process.terminal?.resize) {
      throw new Error("Bun PTY resize is unavailable");
    }
    this.process.terminal.resize(cols, rows);
  }

  kill(signal?: string): void {
    if (!signal) {
      this.process.kill();
      return;
    }
    this.process.kill(signal as NodeJS.Signals);
  }

  pause(): void {
    // Bun's PTY read can't be stopped at the kernel — defer emission and buffer instead
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.flushPausedChunks();
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: Uint8Array): void {
    if (this.didExit) return;
    if (this.paused && this.pausedBytes < PAUSE_BUFFER_LIMIT) {
      // Bun may reuse the backing buffer after this callback returns
      const copy = data.slice();
      this.pausedChunks.push(copy);
      this.pausedBytes += copy.byteLength;
      return;
    }
    // drain queued bytes first to preserve order
    this.flushPausedChunks();
    this.emitDecoded(data);
  }

  private flushPausedChunks(): void {
    if (this.pausedChunks.length === 0) {
      this.pausedBytes = 0;
      return;
    }
    const chunks = this.pausedChunks.splice(0, this.pausedChunks.length);
    this.pausedBytes = 0;
    for (const chunk of chunks) {
      this.emitDecoded(chunk);
    }
  }

  private emitDecoded(data: Uint8Array): void {
    if (this.didExit) return;
    // TextDecoder is stateful — decoding buffered raw bytes in order keeps multi-byte sequences intact across chunks
    const text = this.decoder.decode(data, { stream: true });
    if (text.length === 0) return;
    for (const listener of this.dataListeners) {
      listener(text);
    }
  }

  private emitExit(event: PtyExitEvent): void {
    if (this.didExit) return;
    // flush paused-buffered output before teardown so no bytes are lost
    this.flushPausedChunks();
    this.didExit = true;

    const remainder = this.decoder.decode();
    if (remainder.length > 0) {
      for (const listener of this.dataListeners) {
        listener(remainder);
      }
    }

    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

export const layer = Layer.effect(
  PtyAdapter,
  Effect.gen(function* () {
    if (process.platform === "win32") {
      return yield* Effect.die(
        "Bun PTY terminal support is unavailable on Windows. Please use Node.js (e.g. by running `npx synara`) instead.",
      );
    }
    return {
      spawn: (input) =>
        Effect.sync(() => {
          let processHandle: BunPtyProcess | null = null;
          const command = [input.shell, ...(input.args ?? [])];
          const subprocess = Bun.spawn(command, {
            cwd: input.cwd,
            env: input.env,
            terminal: {
              cols: input.cols,
              rows: input.rows,
              data: (_terminal, data) => {
                processHandle?.emitData(data);
              },
            },
          });
          processHandle = new BunPtyProcess(subprocess);
          return processHandle;
        }),
    } satisfies PtyAdapterShape;
  }),
);
