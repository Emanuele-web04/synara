/**
 * The TCP socket under an upgraded frame WebSocket, as a `FrameByteStream`.
 *
 * Effect's WebSocket writer resolves as soon as `ws.send` queues the frame, so
 * the frame transports could not tell a client that stopped reading from one
 * keeping up: a stalled viewer made the server buffer megabytes with nothing
 * dropped. The `ws` library writes straight to the request's socket (no
 * compression on the frame paths), so that socket's write queue is the real
 * backlog.
 *
 * Returns undefined when the request is not a Node request (a runtime whose
 * HTTP server is not `node:http`), which keeps the previous accounting.
 *
 * @module frameSocketByteStream
 */
import type { Socket } from "node:net";

import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import type { FrameByteStream } from "@synara/shared/frameTransport";
import type { HttpServerRequest } from "effect/unstable/http";

export function frameSocketByteStream(
  request: HttpServerRequest.HttpServerRequest,
): FrameByteStream | undefined {
  let socket: Socket | undefined;
  try {
    socket = NodeHttpServerRequest.toIncomingMessage(request)?.socket;
  } catch {
    return undefined;
  }
  if (!socket || typeof socket.writableLength !== "number" || typeof socket.on !== "function") {
    return undefined;
  }
  const stream = socket;
  return {
    pendingBytes: () => stream.writableLength,
    onDrain: (listener) => {
      stream.on("drain", listener);
      return () => {
        stream.off("drain", listener);
      };
    },
  };
}
