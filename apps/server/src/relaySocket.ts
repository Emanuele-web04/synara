import WebSocket, { type RawData } from "ws";

export interface RelaySocket {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData, binary: boolean) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  off(event: "open", listener: () => void): this;
  off(event: "message", listener: (data: RawData, binary: boolean) => void): this;
  off(event: "close", listener: (code: number, reason: Buffer) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  removeAllListeners(event?: "open" | "message" | "close" | "error"): this;
}

const MAX_PENDING_BYTES = 8 * 1024 * 1024;
export const MAX_RELAY_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Reconstructs the original WebSocket message kind without changing its bytes. */
export function normalizeRelayFrame(data: RawData, binary: boolean): string | Buffer {
  if (!binary) return data.toString();
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function closeBoundedRelay(socket: WebSocket, code: number, reason: string): void {
  const terminate = setTimeout(() => socket.terminate(), 1000);
  terminate.unref();
  socket.once("close", () => clearTimeout(terminate));
  socket.close(code, reason);
}

/** RelaySocket has no async write acknowledgement; bound queues at native WS consumers. */
export function sendBoundedRelayFrame(socket: RelaySocket, data: string | Uint8Array): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  if (socket instanceof WebSocket && socket.bufferedAmount + bytes > MAX_PENDING_BYTES) {
    closeBoundedRelay(socket, 1009, "Remote consumer is too slow");
    return false;
  }
  socket.send(data);
  return true;
}

/** Preserve one response message while bounding its writes, waiting bytes and lifetime. */
export function forwardBoundedRelayResponses(source: WebSocket, target: RelaySocket): () => void {
  // Non-native adapters retain their existing bounded, whole-message behavior.
  // Both production response hops use native sockets so write callbacks and
  // continuation frames can propagate backpressure without a larger wire queue.
  if (!(target instanceof WebSocket)) {
    const forward = (data: RawData, binary: boolean) =>
      sendBoundedRelayFrame(target, normalizeRelayFrame(data, binary));
    source.on("message", forward);
    return () => source.off("message", forward);
  }
  type Response = { bytes: Buffer; binary: boolean; offset: number };
  const waiting: Response[] = [];
  let waitingBytes = 0;
  let active: Response | undefined;
  let writing = false;
  let stopped = false;
  let paused = false;
  let stalled: NodeJS.Timeout | undefined;
  const clearStall = () => {
    clearTimeout(stalled);
    stalled = undefined;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearStall();
    active = undefined;
    waiting.length = 0;
    waitingBytes = 0;
    source.off("message", forward);
    source.off("close", stop);
    target.off("close", stop);
    if (paused && source.readyState === WebSocket.OPEN) source.resume();
  };
  const fail = (code: number, reason: string) => {
    stop();
    if (target.readyState === WebSocket.OPEN) closeBoundedRelay(target, code, reason);
  };
  const pump = () => {
    if (stopped || writing) return;
    if (target.readyState !== WebSocket.OPEN) return stop();
    if (!active) {
      active = waiting.shift();
      if (active) waitingBytes -= active.bytes.length;
    }
    if (!active) {
      if (paused) {
        paused = false;
        source.resume();
      }
      return;
    }
    const end = Math.min(active.bytes.length, active.offset + 64 * 1024);
    const part = active.bytes.subarray(active.offset, end);
    if (target.bufferedAmount + part.length > MAX_PENDING_BYTES)
      return fail(1009, "Remote consumer is too slow");
    writing = true;
    stalled = setTimeout(() => fail(1013, "Remote response write stalled"), 30_000);
    stalled.unref();
    try {
      target.send(part, { binary: active.binary, fin: end === active.bytes.length }, (error) => {
        if (stopped) return;
        clearStall();
        writing = false;
        if (error) return fail(1011, "Remote response write failed");
        if (active) {
          active.offset = end;
          if (end === active.bytes.length) active = undefined;
        }
        queueMicrotask(pump);
      });
    } catch {
      fail(1011, "Remote response write failed");
    }
  };
  const forward = (data: RawData, binary: boolean) => {
    if (stopped) return;
    const bytes = normalizeRelayFrame(data, true) as Buffer;
    if (bytes.length > MAX_RELAY_RESPONSE_BYTES)
      return fail(1009, "Remote response exceeds the message limit");
    const response = { bytes, binary, offset: 0 };
    if (!active && !writing && waiting.length === 0) active = response;
    else {
      // A count cap also bounds a burst of empty messages already decoded in
      // the current read before pause takes effect.
      if (waitingBytes + bytes.length > MAX_PENDING_BYTES || waiting.length >= 128)
        return fail(1009, "Remote response queue exceeded");
      waiting.push(response);
      waitingBytes += bytes.length;
    }
    if (!paused) {
      paused = true;
      source.pause();
    }
    pump();
  };
  source.on("message", forward);
  source.on("close", stop);
  target.on("close", stop);
  return stop;
}
