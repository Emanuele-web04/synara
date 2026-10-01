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

/** RelaySocket has no async write acknowledgement; bound queues at native WS consumers. */
export function sendBoundedRelayFrame(socket: RelaySocket, data: string | Uint8Array): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  if (socket instanceof WebSocket && socket.bufferedAmount + bytes > MAX_PENDING_BYTES) {
    socket.close(1009, "Remote consumer is too slow");
    const terminate = setTimeout(() => socket.terminate(), 1000);
    terminate.unref();
    socket.once("close", () => clearTimeout(terminate));
    return false;
  }
  socket.send(data);
  return true;
}
