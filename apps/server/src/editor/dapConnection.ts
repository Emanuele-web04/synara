import net from "node:net";

export type DapObject = Record<string, unknown>;
export const dapObject = (value: unknown): DapObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as DapObject) : {};
export const dapNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
export const dapString = (value: unknown): string => (typeof value === "string" ? value : "");
export const dapArray = (value: unknown): DapObject[] =>
  Array.isArray(value) ? value.slice(0, 2_000).map(dapObject) : [];
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

/** Bounded DAP framing. Adapter replies cannot hang a client or grow an unbounded receive buffer. */
export class DapConnection {
  private socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private closed = false;
  private pending = new Map<
    number,
    {
      resolve: (body: DapObject) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  onEvent: (event: string, body: DapObject) => void = () => undefined;
  onRequest: (command: string, args: DapObject) => Promise<DapObject> = async () => {
    throw new Error("Unsupported reverse debug request.");
  };
  onClose: (error: Error) => void = () => undefined;

  constructor(port: number) {
    this.socket = net.createConnection({ host: "127.0.0.1", port });
    this.socket.setNoDelay(true);
    this.socket.on("data", (chunk: Buffer) => {
      try {
        this.receive(chunk);
      } catch (cause) {
        this.dispose(cause instanceof Error ? cause : new Error("Invalid DAP message."));
      }
    });
    this.socket.on("error", (error) => this.dispose(error));
    this.socket.on("close", () => this.dispose(new Error("The debug adapter connection closed.")));
  }
  private send(message: DapObject) {
    if (this.closed) throw new Error("The debug adapter connection is closed.");
    const json = JSON.stringify({ ...message, seq: ++this.sequence });
    const bytes = Buffer.byteLength(json);
    if (bytes > MAX_MESSAGE_BYTES || this.socket.writableLength > MAX_MESSAGE_BYTES)
      throw new Error("Debug adapter send queue exceeded its limit.");
    this.socket.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
    return this.sequence;
  }
  request(command: string, args: DapObject = {}, timeout = 15_000): Promise<DapObject> {
    if (this.pending.size >= 64)
      return Promise.reject(new Error("Too many pending debugger commands."));
    return new Promise((resolve, reject) => {
      try {
        const id = this.send({ type: "request", command, arguments: args });
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Debugger command ${command} timed out.`));
        }, timeout);
        this.pending.set(id, { resolve, reject, timer });
      } catch (error) {
        reject(error);
      }
    });
  }
  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (this.buffer.length > 8_192) throw new Error("Invalid debugger protocol header.");
        return;
      }
      if (end > 8_192) throw new Error("Debugger protocol header is too large.");
      const header = this.buffer.subarray(0, end).toString("ascii");
      const lengths = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
      const size = lengths.length === 1 ? Number(lengths[0]?.[1]) : NaN;
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_MESSAGE_BYTES)
        throw new Error("Invalid debugger message length.");
      if (this.buffer.length < end + 4 + size) return;
      const message = dapObject(
        JSON.parse(this.buffer.subarray(end + 4, end + 4 + size).toString("utf8")),
      );
      this.buffer = this.buffer.subarray(end + 4 + size);
      if (message.type === "response") {
        const id = dapNumber(message.request_seq, -1),
          pending = this.pending.get(id);
        if (!pending) continue;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (message.success === true) pending.resolve(dapObject(message.body));
        else
          pending.reject(
            new Error(
              dapString(message.message) ||
                `Debugger command ${dapString(message.command)} failed.`,
            ),
          );
      } else if (message.type === "event")
        this.onEvent(dapString(message.event), dapObject(message.body));
      else if (message.type === "request") {
        void this.onRequest(dapString(message.command), dapObject(message.arguments))
          .then(
            (body) => {
              this.send({
                type: "response",
                request_seq: message.seq,
                command: message.command,
                success: true,
                body,
              });
            },
            (error: unknown) => {
              this.send({
                type: "response",
                request_seq: message.seq,
                command: message.command,
                success: false,
                message: error instanceof Error ? error.message : "Reverse request failed.",
              });
            },
          )
          .catch(() => undefined);
      }
    }
  }
  dispose(error = new Error("Debugger connection disposed.")) {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onClose(error);
  }
}
