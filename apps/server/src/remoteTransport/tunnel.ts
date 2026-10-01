import http from "node:http";
import tls from "node:tls";
import { Duplex, Writable } from "node:stream";
import WebSocket, { createWebSocketStream, WebSocketServer } from "ws";
import {
  remoteTlsAnchor,
  remoteTlsServerName,
  validateRemoteTlsAnchor,
  type RemoteTlsAnchor,
  type RemoteTlsIdentity,
} from "./certificates";

export const REMOTE_OUTER_PATH = "/ws/host/v2";
export const REMOTE_INNER_RPC_PATH = "/v2/rpc";
export const REMOTE_INNER_PAIRING_PATH = "/v2/pairing";
export const REMOTE_HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const STREAM_HIGH_WATER_BYTES = 64 * 1024;

function ciphertextStream(outer: WebSocket): Duplex {
  // ws pauses its underlying socket when the Duplex's readable queue fills.
  // Ciphertext frames cannot be interpreted as UTF-8, even before TLS starts.
  const onMessage = (_data: unknown, binary: boolean) => {
    if (!binary) outer.terminate();
  };
  outer.prependListener("message", onMessage);
  outer.once("close", () => outer.off("message", onMessage));
  const stream = createWebSocketStream(outer, { highWaterMark: STREAM_HIGH_WATER_BYTES });
  stream.on("error", () => outer.terminate());
  // TLS can aggregate an entire write burst into one ciphertext buffer. Outer
  // messages are byte-stream chunks, not RPC messages: bound each frame without
  // lifting the receiving limit or buffering an unbounded send queue.
  const writer = new Writable({
    highWaterMark: STREAM_HIGH_WATER_BYTES,
    write(chunk: Buffer, _encoding, callback) {
      let offset = 0;
      const next = (error?: Error | null) => {
        if (error || offset >= chunk.length) {
          callback(error);
          return;
        }
        const end = Math.min(chunk.length, offset + STREAM_HIGH_WATER_BYTES);
        const part = chunk.subarray(offset, end);
        offset = end;
        stream.write(part, next);
      };
      next();
    },
    final(callback) {
      stream.end(callback);
    },
    destroy(error, callback) {
      stream.destroy(error ?? undefined);
      callback(error);
    },
  });
  return Duplex.from({ readable: stream, writable: writer });
}

export interface RemoteIngressContext {
  readonly via: "direct" | "relay" | "cloudflare" | "ssh-forward";
}
const DIRECT_INGRESS: RemoteIngressContext = { via: "direct" };

export interface RemoteTlsServerOptions {
  readonly identity: RemoteTlsIdentity;
  readonly accept: (
    socket: WebSocket,
    path: string,
    context: RemoteIngressContext,
  ) => void | Promise<void>;
  readonly request?: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    context: RemoteIngressContext,
  ) => void;
  readonly handshakeTimeoutMs?: number;
  readonly maxConnections?: number;
}

/** Shared by direct, Cloudflare and SSH ingress; none accepts plaintext RPC. */
export class RemoteTlsServer {
  readonly #http = http.createServer();
  readonly #ws = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  #identity: RemoteTlsIdentity;
  readonly #contexts = new WeakMap<Duplex, RemoteIngressContext>();
  readonly #connections = new Map<WebSocket, Duplex>();
  readonly #options: RemoteTlsServerOptions;
  #closed = false;

  constructor(options: RemoteTlsServerOptions) {
    this.#options = options;
    this.#identity = options.identity;
    this.#http.headersTimeout = options.handshakeTimeoutMs ?? REMOTE_HANDSHAKE_TIMEOUT_MS;
    this.#http.requestTimeout = 30_000;
    this.#http.keepAliveTimeout = 5_000;
    this.#http.maxHeadersCount = 32;
    this.#http.on("clientError", (_error, socket) => socket.destroy());
    this.#http.on("request", (request, response) => {
      if (options.request)
        options.request(request, response, this.#contexts.get(request.socket) ?? DIRECT_INGRESS);
      else {
        response.writeHead(404);
        response.end();
      }
    });
    this.#http.on("upgrade", (request, socket, head) => {
      if (request.url !== REMOTE_INNER_RPC_PATH && request.url !== REMOTE_INNER_PAIRING_PATH) {
        socket.destroy();
        return;
      }
      this.#ws.handleUpgrade(request, socket, head, (inner) => {
        inner.on("error", () => inner.terminate());
        // Invoke synchronously: the first frame may accompany the upgrade.
        try {
          Promise.resolve(
            options.accept(
              inner,
              request.url!,
              this.#contexts.get(request.socket) ?? DIRECT_INGRESS,
            ),
          ).catch(() => inner.terminate());
        } catch {
          inner.terminate();
        }
      });
    });
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  accept(outer: WebSocket, context: RemoteIngressContext = DIRECT_INGRESS): void {
    if (this.#closed || this.#connections.size >= (this.#options.maxConnections ?? 32)) {
      outer.close(1013, "Remote connection limit reached");
      return;
    }
    // A scoped TLS server carries ingress metadata through the public secure
    // callback, without relying on Node's private TLSSocket parent fields.
    const server = tls.createServer(
      {
        key: this.#identity.leafPrivateKey,
        cert: this.#identity.leafCertificate,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        handshakeTimeout: this.#options.handshakeTimeoutMs ?? REMOTE_HANDSHAKE_TIMEOUT_MS,
      },
      (socket) => {
        this.#contexts.set(socket, context);
        socket.on("error", () => socket.destroy());
        this.#http.emit("connection", socket);
      },
    );
    server.on("tlsClientError", (_error, socket) => socket.destroy());
    const stream = ciphertextStream(outer);
    this.#connections.set(outer, stream);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#connections.delete(outer);
      server.close();
      stream.destroy();
      outer.terminate();
    };
    outer.once("close", release);
    stream.once("close", release);
    server.emit("connection", stream);
  }

  /** Existing TLS sessions retain their keys while new handshakes use this leaf. */
  renew(identity: RemoteTlsIdentity): void {
    if (
      remoteTlsAnchor(identity).rootFingerprint !==
      remoteTlsAnchor(this.#options.identity).rootFingerprint
    ) {
      throw new Error("Root replacement requires local re-pair");
    }
    this.#identity = identity;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [outer, stream] of this.#connections) {
      stream.destroy();
      outer.terminate();
    }
    this.#connections.clear();
    for (const inner of this.#ws.clients) inner.terminate();
    this.#ws.close();
    this.#http.closeAllConnections();
    this.#http.close();
  }
}

/** Opens TLS on an already upgraded opaque transport using only the locally paired root. */
export function connectRemoteTls(
  outer: WebSocket,
  anchor: RemoteTlsAnchor,
  signal?: AbortSignal,
  timeoutMs = REMOTE_HANDSHAKE_TIMEOUT_MS,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    try {
      validateRemoteTlsAnchor(anchor);
    } catch (error) {
      outer.terminate();
      reject(error);
      return;
    }
    const stream = ciphertextStream(outer);
    const socket = tls.connect({
      socket: stream,
      ca: anchor.rootCertificate,
      servername: remoteTlsServerName(anchor.environmentId),
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      // No session option or ticket cache: reconnect always authenticates anew.
    });
    let settled = false;
    const timer = setTimeout(() => fail(new Error("Remote TLS handshake timed out")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      cleanup();
      socket.destroy();
      stream.destroy();
      outer.terminate();
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const onAbort = () => fail(new Error("Remote TLS connection aborted"));
    socket.on("error", fail);
    socket.once("close", () => fail(new Error("Remote TLS connection closed")));
    socket.once("secureConnect", () => {
      cleanup();
      settled = true;
      resolve(socket);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Inner WS preserves application message boundaries across the TLS byte stream. */
export async function connectRemoteWebSocket(
  outer: WebSocket,
  anchor: RemoteTlsAnchor,
  path = REMOTE_INNER_RPC_PATH,
  signal?: AbortSignal,
): Promise<WebSocket> {
  const secure = await connectRemoteTls(outer, anchor, signal);
  return new Promise((resolve, reject) => {
    const inner = new WebSocket(`ws://${remoteTlsServerName(anchor.environmentId)}${path}`, {
      createConnection: () => secure,
      handshakeTimeout: REMOTE_HANDSHAKE_TIMEOUT_MS,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    const abort = () => {
      inner.terminate();
      secure.destroy();
    };
    const finish = () => signal?.removeEventListener("abort", abort);
    inner.once("open", () => {
      finish();
      resolve(inner);
    });
    inner.on("error", (error) => {
      finish();
      secure.destroy();
      outer.terminate();
      reject(error);
    });
    inner.once("close", () => {
      finish();
      secure.destroy();
      outer.terminate();
      reject(new Error("Remote inner WebSocket closed during upgrade"));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
