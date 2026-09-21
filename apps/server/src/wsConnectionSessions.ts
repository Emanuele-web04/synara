// RpcServer.toHttpEffectWebsocket forks the RPC server on the layer-build scope so services provided around the per-connection upgrade never reach handler fibers — this registry bridges that: upgrade registers the session under an unguessable key injected as a synthetic header, and admission middleware resolves it back into handler-scoped services
import { randomUUID } from "node:crypto";

import { Effect, Layer, Scope, ServiceMap } from "effect";

import {
  CurrentManagedAttachmentPrincipal,
  type ManagedAttachmentPrincipal,
} from "./managedAttachmentPrincipal";

export type WsSessionRole = "owner" | "client";

export const CurrentWsSessionRole = ServiceMap.Reference<WsSessionRole>(
  "synara/ws/CurrentSessionRole",
  { defaultValue: () => "client" },
);

export interface WsConnectionSession {
  readonly role: WsSessionRole;
  readonly attachmentPrincipal: ManagedAttachmentPrincipal;
}

/** set server-side on the upgrade request (never sent to clients) — Headers.set overrides any client-supplied value so entries can't be forged or replayed */
export const WS_CONNECTION_SESSION_HEADER = "x-synara-ws-connection-session";

export interface WsConnectionSessionsShape {
  readonly register: (session: WsConnectionSession) => Effect.Effect<string, never, Scope.Scope>;
  readonly lookup: (key: string | undefined) => WsConnectionSession | undefined;
}

export class WsConnectionSessions extends ServiceMap.Service<
  WsConnectionSessions,
  WsConnectionSessionsShape
>()("synara/ws/WsConnectionSessions") {}

export const makeWsConnectionSessions = Effect.sync(() => {
  const sessions = new Map<string, WsConnectionSession>();
  return {
    register: (session: WsConnectionSession) =>
      Effect.gen(function* () {
        const key = randomUUID();
        sessions.set(key, session);
        yield* Effect.addFinalizer(() => Effect.sync(() => sessions.delete(key)));
        return key;
      }),
    lookup: (key: string | undefined) => (key === undefined ? undefined : sessions.get(key)),
  } satisfies WsConnectionSessionsShape;
});

export const WsConnectionSessionsLive = Layer.effect(
  WsConnectionSessions,
  makeWsConnectionSessions,
);

/** with no session the effect keeps conservative defaults — role "client", loopback principal */
export function provideWsConnectionSession<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  session: WsConnectionSession | undefined,
): Effect.Effect<A, E, R> {
  return session
    ? effect.pipe(
        Effect.provideService(CurrentWsSessionRole, session.role),
        Effect.provideService(CurrentManagedAttachmentPrincipal, session.attachmentPrincipal),
      )
    : effect;
}
