import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  decodeRemoteResourceReference,
  REMOTE_RESOURCE_LOCAL_PREFIX,
} from "@synara/shared/remoteResources";
// FILE: httpRoute.ts
// Purpose: The local `/ws/remote/:hostId` upgrade a renderer uses to reach a
//          host this shell has dialed, plus the negotiate answer the renderer's
//          transport asks for before upgrading.
// Layer: server host connections
//
// Owner-only: the socket is a full-privilege bridge onto another machine, so
// only a connection the shell itself trusts as its console (the same rule the
// local `/ws` applies for the desktop bridge and loopback) may take it.

import { EffectRelaySocket } from "../effectRelaySocket";

import {
  WS_FEATURE_PATH,
  WS_NEGOTIATE_HTTP_PATH,
  WS_COMPATIBILITY_QUERY,
  WsCompatibilityError,
} from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerAuth } from "../auth/Services/ServerAuth";
import { makeEffectAuthRequest } from "../auth/effectHttp";
import { ServerConfig } from "../config";
import {
  isTrustedAppOrigin,
  normalizeCorsOrigin,
  requiresWebSocketAuthentication,
  shouldRejectAuthMutationOrigin,
  shouldRejectUntrustedRequestOrigin,
} from "../trustedOrigins";
import { parseWsNegotiateSearchParams } from "../wsCompatibility";
import { authenticateRpcWebSocketUpgrade } from "../wsRpc";
import {
  HOST_CONNECTION_WS_PATH_PREFIX,
  REMOTE_ATTACHMENT_QUERY,
  HostConnectionRegistryService,
} from "./registry";

function hostIdParam(params: Readonly<Record<string, string | undefined>>): string | null {
  const raw = params.hostId;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Negotiation is carried inside the paired TLS channel to the real host. */
export const hostConnectionRouteLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add(
      "*",
      `${REMOTE_RESOURCE_LOCAL_PREFIX}:hostId`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        const serverAuth = yield* ServerAuth;
        const registry = yield* HostConnectionRegistryService;
        const url = HttpServerRequest.toURL(request);
        if (!url || url.searchParams.has("token"))
          return HttpServerResponse.text("Invalid resource request", { status: 400 });
        const authRequest = makeEffectAuthRequest(request);
        const hasCredential =
          Boolean(request.headers.authorization) ||
          Object.entries(authRequest.cookies).some(
            ([name, value]) => /^synara_session(?:_\d+)?$/.test(name) && Boolean(value),
          );
        // Match the controller's auth-optional loopback policy. Explicit credentials
        // always retain their role; public/SSH-forwarded servers still require auth.
        const session =
          hasCredential || requiresWebSocketAuthentication(config)
            ? yield* serverAuth.authenticateHttpRequest(authRequest)
            : null;
        if (
          (session !== null && session.role !== "owner") ||
          shouldRejectUntrustedRequestOrigin({
            rawOrigin: request.headers.origin,
            requestOrigin: url.origin,
            config,
          }) ||
          (request.method !== "GET" &&
            shouldRejectAuthMutationOrigin({
              rawOrigin: request.headers.origin,
              requestOrigin: url.origin,
              config,
              credentialSource: session?.credentialSource ?? "cookie",
            }))
        ) {
          return HttpServerResponse.text("Forbidden", { status: 403 });
        }
        const hostId = hostIdParam(yield* HttpRouter.params);
        if (!hostId) return HttpServerResponse.text("Not Found", { status: 404 });
        const reference = yield* Effect.try({
          try: () => decodeRemoteResourceReference(url.searchParams.get("reference") ?? ""),
          catch: (error) => error,
        });
        const pool = yield* Effect.tryPromise(() => registry.resourcePool(hostId));
        const incoming = NodeHttpServerRequest.toIncomingMessage(request);
        const response = NodeHttpServerRequest.toServerResponse(request);
        yield* Effect.callback<void, unknown>((resume) => {
          const finish = () => resume(Effect.void);
          response.once("finish", finish);
          response.once("close", finish);
          void pool
            .forward(incoming, response, reference)
            .catch((error) => resume(Effect.fail(error)));
          return Effect.sync(() => {
            response.off("finish", finish);
            response.off("close", finish);
            if (!response.writableEnded) response.destroy();
          });
        });
        return HttpServerResponse.empty();
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("Remote resource unavailable", { status: 403 })),
        ),
      ),
    );

    yield* router.add(
      "GET",
      `${HOST_CONNECTION_WS_PATH_PREFIX}:hostId${WS_FEATURE_PATH}`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        const serverAuth = yield* ServerAuth;
        const registry = yield* HostConnectionRegistryService;
        const url = HttpServerRequest.toURL(request);
        if (
          !url ||
          shouldRejectUntrustedRequestOrigin({
            rawOrigin: request.headers.origin,
            requestOrigin: url.origin,
            config,
          })
        ) {
          return HttpServerResponse.text("Forbidden", { status: 403 });
        }
        const hostId = hostIdParam(yield* HttpRouter.params);
        if (!hostId) return HttpServerResponse.text("Not Found", { status: 404 });

        // Same admission as the local `/ws`: loopback/desktop-bridge trust, or
        // an authenticated owner session. A paired client-role session is not
        // allowed to pivot through this shell onto another machine.
        const authenticated = yield* authenticateRpcWebSocketUpgrade({
          config,
          legacyToken: url.searchParams.get("token"),
          request: makeEffectAuthRequest(request),
          serverAuth,
        }).pipe(Effect.catch(() => Effect.succeed("refused" as const)));
        if (authenticated === "refused") {
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        }
        if (authenticated && authenticated.role !== "owner") {
          return HttpServerResponse.text("Forbidden", { status: 403 });
        }
        if (!registry.get(hostId)) {
          return HttpServerResponse.text("No open connection to that host", { status: 404 });
        }

        const socket = yield* request.upgrade;
        const writer = yield* socket.writer;
        const adapter = new EffectRelaySocket(writer);
        if (
          !registry.attach(
            hostId,
            url.searchParams.get(REMOTE_ATTACHMENT_QUERY) ?? "",
            adapter,
            url.searchParams.get(WS_COMPATIBILITY_QUERY.serverInstanceId),
          )
        ) {
          return HttpServerResponse.empty();
        }
        yield* socket
          .runRaw((message) => adapter.receive(message))
          .pipe(Effect.ensuring(Effect.sync(() => adapter.closed())));
        return HttpServerResponse.empty();
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty()))),
    );

    // Each negotiation reserves a fresh far-side RPC stream.
    // (`/ws/remote/:hostId/ws/bootstrap` is deliberately not served: every
    // shell new enough to bridge also serves HTTP negotiate, so the legacy
    // bootstrap socket is never needed on this path.)
    yield* router.add(
      "GET",
      `${HOST_CONNECTION_WS_PATH_PREFIX}:hostId${WS_NEGOTIATE_HTTP_PATH}`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        const registry = yield* HostConnectionRegistryService;
        const url = HttpServerRequest.toURL(request);
        if (
          !url ||
          shouldRejectUntrustedRequestOrigin({
            rawOrigin: request.headers.origin,
            requestOrigin: url.origin,
            config,
          })
        ) {
          return HttpServerResponse.text("Forbidden", { status: 403 });
        }
        const hostId = hostIdParam(yield* HttpRouter.params);
        const serverAuth = yield* ServerAuth;
        const authenticated = yield* authenticateRpcWebSocketUpgrade({
          config,
          legacyToken: url.searchParams.get("token"),
          request: makeEffectAuthRequest(request),
          serverAuth,
        }).pipe(Effect.catch(() => Effect.succeed("refused" as const)));
        if (authenticated === "refused")
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        if (authenticated && authenticated.role !== "owner")
          return HttpServerResponse.text("Forbidden", { status: 403 });
        if (!hostId || !registry.hasConnector(hostId)) {
          return HttpServerResponse.text("No open connection to that host", { status: 404 });
        }
        // Desktop renderers fetch from synara://app, just as on the local
        // negotiation route. Reflect only origins the bridge already trusts.
        const origin = normalizeCorsOrigin(request.headers.origin);
        const corsHeaders =
          origin && isTrustedAppOrigin({ origin, requestOrigin: url.origin, config })
            ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
            : {};
        const headers = { "Cache-Control": "no-store", ...corsHeaders };
        const input = parseWsNegotiateSearchParams(url.searchParams);
        if (input instanceof WsCompatibilityError) {
          return HttpServerResponse.jsonUnsafe(input, { status: 426, headers });
        }
        return yield* Effect.tryPromise((signal) => registry.prepare(hostId, input, signal)).pipe(
          Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 200, headers })),
          Effect.catch((failure) => {
            const error = failure.cause;
            return Effect.succeed(
              Schema.is(WsCompatibilityError)(error)
                ? HttpServerResponse.jsonUnsafe(error, { status: 426, headers })
                : HttpServerResponse.text("Remote host unavailable", { status: 503, headers }),
            );
          }),
        );
      }),
    );
  }),
);
