import { upgradeNativeWebSocket } from "../nodeHttpServer";
import { REMOTE_OUTER_PATH } from "../remoteTransport/tunnel";
import type { WebSocket } from "ws";

import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export const HOST_REMOTE_WS_PATH = REMOTE_OUTER_PATH;

type SocketAcceptor = (socket: WebSocket) => void | Promise<void>;
let currentAcceptor: SocketAcceptor | undefined;

export function registerHostRemoteSocketAcceptor(acceptor: SocketAcceptor): () => void {
  currentAcceptor = acceptor;
  return () => {
    if (currentAcceptor === acceptor) currentAcceptor = undefined;
  };
}

export const hostRemoteWebSocketRouteLayer = HttpRouter.add(
  "GET",
  HOST_REMOTE_WS_PATH,
  Effect.gen(function* () {
    const acceptor = currentAcceptor;
    if (!acceptor) return HttpServerResponse.text("Host is not linked", { status: 503 });
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* upgradeNativeWebSocket(request.source);
    yield* Effect.callback<void, unknown>((resume) => {
      socket.once("close", () => resume(Effect.void));
      socket.on("error", () => socket.terminate());
      try {
        Promise.resolve(acceptor(socket)).catch((error) => {
          socket.terminate();
          resume(Effect.fail(error));
        });
      } catch (error) {
        socket.terminate();
        resume(Effect.fail(error));
      }
    });
    return HttpServerResponse.empty();
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty()))),
);
