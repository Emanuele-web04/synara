import http from "node:http";
import type { ListenOptions } from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Scope } from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { ServeError } from "effect/unstable/http/HttpServerError";
import { WebSocketServer } from "ws";

export const MAX_WEBSOCKET_MESSAGE_BYTES = 2 * 1024 * 1024;

/**
 * Owns the Node HTTP/WebSocket transport so Synara, rather than the platform
 * adapter's 100 MiB default, controls admission before a message is decoded.
 */
export const makeBoundedNodeHttpServer = Effect.fnUntraced(function* (
  evaluate: () => http.Server,
  options: ListenOptions,
) {
  const scope = yield* Effect.scope;
  const server = evaluate();

  yield* Scope.addFinalizer(
    scope,
    Effect.callback<void>((resume) => {
      if (!server.listening) {
        resume(Effect.void);
        return;
      }
      server.close((error) => {
        if (error) resume(Effect.die(error));
        else resume(Effect.void);
      });
    }),
  );

  yield* Effect.callback<void, ServeError>((resume) => {
    const onError = (cause: Error) => resume(Effect.fail(new ServeError({ cause })));
    server.on("error", onError);
    server.listen(options, () => {
      server.off("error", onError);
      resume(Effect.void);
    });
  });

  const address = server.address()!;
  const webSocketServer = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new WebSocketServer({
          noServer: true,
          maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
          perMessageDeflate: false,
        }),
    ),
    (server) =>
      Effect.callback<void>((resume) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Scope.provide(scope));

  return HttpServer.make({
    address:
      typeof address === "string"
        ? { _tag: "UnixAddress", path: address }
        : {
            _tag: "TcpAddress",
            hostname: address.address === "::" ? "0.0.0.0" : address.address,
            port: address.port,
          },
    serve: Effect.fnUntraced(function* (httpApp, middleware) {
      const serveScope = yield* Effect.scope;
      const handler = yield* NodeHttpServer.makeHandler(httpApp, {
        middleware: middleware as any,
        scope: serveScope,
      }) as Effect.Effect<
        (nodeRequest: http.IncomingMessage, nodeResponse: http.ServerResponse) => void
      >;
      const upgradeHandler = yield* NodeHttpServer.makeUpgradeHandler(
        Effect.succeed(webSocketServer),
        httpApp,
        {
          middleware: middleware as any,
          scope: serveScope,
        },
      );

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.off("request", handler);
          server.off("upgrade", upgradeHandler);
        }),
      );
      server.on("request", handler);
      server.on("upgrade", upgradeHandler);
    }),
  });
});
