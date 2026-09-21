import http from "node:http";
import type { ListenOptions, Socket } from "node:net";

import { WS_FEATURE_PATH } from "@synara/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Scope } from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { ServeError } from "effect/unstable/http/HttpServerError";
import { WebSocketServer } from "ws";

export const MAX_WEBSOCKET_MESSAGE_BYTES = 2 * 1024 * 1024;

/** Node's HTTP parser owns the socket error listener until an upgrade starts; a peer reset in that gap otherwise becomes an unhandled `error` event terminating the backend. Keep this boundary for the lifetime of every accepted connection — destroying an already-failed socket just guarantees prompt release */
function handleClientSocketError(this: Socket): void {
  this.destroy();
}

function protectClientSocket(socket: Socket): void {
  socket.on("error", handleClientSocketError);
}

/** permessage-deflate on the feature socket only: the RPC stream is small repetitive JSON — best case for DEFLATE with context takeover (~80% wire reduction measured). The pre-auth bootstrap socket deliberately never negotiates compression — each compressed connection retains ~288KiB zlib state plus inflated buffers, and that path is reachable without credentials */
const PER_MESSAGE_DEFLATE_OPTIONS = true;

/** the one upgrade route allowed to negotiate compression (post-auth) — shared with route registration so dispatcher and router can't drift */
const COMPRESSED_UPGRADE_PATH = WS_FEATURE_PATH;

/** normalizes the raw target the way the router does — absolute-form, query/fragment, ;params, dup slashes, percent-encoding, case, trailing slashes all collapse; matching the raw target would let /WS/BOOTSTRAP or /ws/%62ootstrap reach bootstrap while classifying as something else */
function normalizeUpgradePath(requestUrl: string | undefined): string {
  const target = requestUrl ?? "";
  const afterAuthority = /^[a-z][a-z0-9+.-]*:\/\//i.test(target)
    ? target.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "") || "/"
    : target;
  const pathOnly = afterAuthority.split("#")[0]?.split("?")[0] ?? "";
  let decoded = pathOnly;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    // malformed percent-encoding can't be a recognized route — leave as-is so it falls through to the uncompressed default
  }
  const withoutParams = decoded
    .split("/")
    .map((segment) => segment.split(";")[0] ?? "")
    .join("/");
  const collapsed = withoutParams.replace(/\/{2,}/g, "/").toLowerCase();
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

/** fail closed — only the exact feature route negotiates compression; anything else lands on the uncompressed server so no unauthenticated connection can hold zlib state regardless of spelling */
export function upgradePathAllowsCompression(requestUrl: string | undefined): boolean {
  return normalizeUpgradePath(requestUrl) === COMPRESSED_UPGRADE_PATH;
}

/** Synara owns the transport so admission is controlled before decode, not the adapter's 100MiB default */
export const makeBoundedNodeHttpServer = Effect.fnUntraced(function* (
  evaluate: () => http.Server,
  options: ListenOptions,
) {
  const scope = yield* Effect.scope;
  const server = evaluate();

  // install before listen() — no accepted connection may exist without a permanent error boundary, incl. resets during startup
  server.on("connection", protectClientSocket);

  yield* Scope.addFinalizer(
    scope,
    Effect.callback<void>((resume) => {
      server.off("connection", protectClientSocket);
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
  const makeBoundedWebSocketServer = (perMessageDeflate: boolean) =>
    Effect.acquireRelease(
      Effect.sync(
        () =>
          new WebSocketServer({
            noServer: true,
            maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
            perMessageDeflate: perMessageDeflate ? PER_MESSAGE_DEFLATE_OPTIONS : false,
          }),
      ),
      (server) =>
        Effect.callback<void>((resume) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resume(Effect.void));
        }),
    ).pipe(Scope.provide(scope));
  // two ws servers sharing one listener — compression negotiated only on authenticated feature-socket paths
  const featureWebSocketServer = yield* makeBoundedWebSocketServer(true);
  const bootstrapWebSocketServer = yield* makeBoundedWebSocketServer(false);

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
      const featureUpgradeHandler = yield* NodeHttpServer.makeUpgradeHandler(
        Effect.succeed(featureWebSocketServer),
        httpApp,
        {
          middleware: middleware as any,
          scope: serveScope,
        },
      );
      const bootstrapUpgradeHandler = yield* NodeHttpServer.makeUpgradeHandler(
        Effect.succeed(bootstrapWebSocketServer),
        httpApp,
        {
          middleware: middleware as any,
          scope: serveScope,
        },
      );
      const upgradeHandler = (
        nodeRequest: http.IncomingMessage,
        socket: Parameters<typeof featureUpgradeHandler>[1],
        head: Parameters<typeof featureUpgradeHandler>[2],
      ) => {
        const dispatch = upgradePathAllowsCompression(nodeRequest.url)
          ? featureUpgradeHandler
          : bootstrapUpgradeHandler;
        dispatch(nodeRequest, socket, head);
      };

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
