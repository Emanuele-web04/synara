import { EventEmitter } from "node:events";
import { Effect } from "effect";
import { CloseEvent } from "effect/unstable/socket/Socket";
import type { RelaySocket } from "./relaySocket";

/** One bounded writer and one terminal notification for both Effect WS bridges. */
export class EffectRelaySocket extends EventEmitter implements RelaySocket {
  readyState = 1;
  #notified = false;
  #pendingBytes = 0;
  #writes = Promise.resolve();
  constructor(
    private readonly write: (
      chunk: Uint8Array | string | CloseEvent,
    ) => Effect.Effect<void, unknown>,
  ) {
    super();
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) return;
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (this.#pendingBytes + bytes > 8 * 1024 * 1024) {
      this.close(1009, "slow consumer");
      return;
    }
    this.#pendingBytes += bytes;
    this.#writes = this.#writes.then(async () => {
      try {
        if (this.readyState === 1) await Effect.runPromise(this.write(data));
      } catch {
        this.close(1011, "write failed");
      } finally {
        this.#pendingBytes -= bytes;
      }
    });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    // Notify cleanup now; Effect's read pump may terminate after the close write.
    this.closed(code, reason);
    Effect.runFork(this.write(new CloseEvent(code, reason)).pipe(Effect.ignore));
  }

  receive(data: string | Uint8Array): void {
    if (this.readyState === 1) this.emit("message", data, typeof data !== "string");
  }

  closed(code = 1000, reason = ""): void {
    this.readyState = 3;
    if (this.#notified) return;
    this.#notified = true;
    this.emit("close", code, Buffer.from(reason));
  }
}
