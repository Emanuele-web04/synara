import * as Crypto from "node:crypto";

import { WsRpcError } from "@synara/contracts";
import {
  classifyWsRequest,
  makeWsRequestCapacityError,
  WS_REQUEST_CLASS_LIMITS,
  type WsRequestClass,
} from "@synara/shared/wsRequestClass";
import { Clock, Effect, Layer, Ref } from "effect";
import { Headers } from "effect/unstable/http";
import { RpcMiddleware, RpcSchema } from "effect/unstable/rpc";
import {
  remoteMethodUnavailable,
  REMOTE_NATIVE_UNAVAILABLE,
} from "@synara/shared/remoteCapabilities";
import {
  provideWsConnectionSession,
  WS_CONNECTION_SESSION_HEADER,
  WsConnectionSessions,
} from "./wsConnectionSessions";

export interface WsRequestLease {
  readonly clientId: number;
  readonly leaseId: string;
  readonly method: string;
  readonly requestClass: WsRequestClass;
  readonly acquiredAtMs: number;
}

/**
 * Capacity rejections are logged at most once per client and class in this
 * interval, so a saturated lane names what holds it without flooding the log.
 */
export const WS_REQUEST_REJECTION_LOG_INTERVAL_MS = 10_000;

interface RejectionLogState {
  readonly loggedAtMs: number;
  readonly suppressed: number;
}

interface AdmissionLedger {
  readonly clients: ReadonlyMap<number, ReadonlyMap<string, WsRequestLease>>;
  /** Keyed by `${clientId}:${requestClass}`; dropped when the client drains. */
  readonly rejectionLogs: ReadonlyMap<string, RejectionLogState>;
  readonly admittedTotal: number;
  readonly releasedTotal: number;
  readonly rejectedTotal: number;
}

export interface WsRequestAdmissionSnapshot {
  readonly clients: number;
  readonly active: number;
  readonly admittedTotal: number;
  readonly releasedTotal: number;
  readonly rejectedTotal: number;
}

const initialLedger = (): AdmissionLedger => ({
  clients: new Map(),
  rejectionLogs: new Map(),
  admittedTotal: 0,
  releasedTotal: 0,
  rejectedTotal: 0,
});

export const makeWsRequestAdmission = Effect.gen(function* () {
  const ledgerRef = yield* Ref.make<AdmissionLedger>(initialLedger());

  const acquire = (clientId: number, method: string) =>
    Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
      Ref.modify(
        ledgerRef,
        (ledger): readonly [Effect.Effect<WsRequestLease, WsRpcError>, AdmissionLedger] => {
          const requestClass = classifyWsRequest(method);
          const clientLeases = ledger.clients.get(clientId) ?? new Map<string, WsRequestLease>();
          const heldForClass = Array.from(clientLeases.values()).filter(
            (lease) => lease.requestClass === requestClass,
          );
          if (heldForClass.length >= WS_REQUEST_CLASS_LIMITS[requestClass]) {
            const rejected = Effect.fail(makeWsRequestCapacityError(requestClass));
            const logKey = `${clientId}:${requestClass}`;
            const previous = ledger.rejectionLogs.get(logKey);
            const rejectionLogs = new Map(ledger.rejectionLogs);
            if (
              previous !== undefined &&
              nowMs - previous.loggedAtMs < WS_REQUEST_REJECTION_LOG_INTERVAL_MS
            ) {
              rejectionLogs.set(logKey, { ...previous, suppressed: previous.suppressed + 1 });
              return [
                rejected,
                { ...ledger, rejectionLogs, rejectedTotal: ledger.rejectedTotal + 1 },
              ] as const;
            }
            rejectionLogs.set(logKey, { loggedAtMs: nowMs, suppressed: 0 });
            // Method names and hold times only; request payloads never reach the log.
            const logged = Effect.logWarning("WebSocket request rejected: class capacity in use", {
              clientId,
              method,
              requestClass,
              limit: WS_REQUEST_CLASS_LIMITS[requestClass],
              heldBy: heldForClass.map((lease) => ({
                method: lease.method,
                heldForMs: Math.max(0, nowMs - lease.acquiredAtMs),
              })),
              suppressedSinceLastLog: previous?.suppressed ?? 0,
            });
            return [
              logged.pipe(Effect.andThen(rejected)),
              { ...ledger, rejectionLogs, rejectedTotal: ledger.rejectedTotal + 1 },
            ] as const;
          }

          const lease: WsRequestLease = {
            clientId,
            leaseId: Crypto.randomUUID(),
            method,
            requestClass,
            acquiredAtMs: nowMs,
          };
          const nextClientLeases = new Map(clientLeases);
          nextClientLeases.set(lease.leaseId, lease);
          const nextClients = new Map(ledger.clients);
          nextClients.set(clientId, nextClientLeases);
          return [
            Effect.succeed(lease),
            { ...ledger, clients: nextClients, admittedTotal: ledger.admittedTotal + 1 },
          ] as const;
        },
      ).pipe(Effect.flatten),
    );

  const release = (lease: WsRequestLease) =>
    Ref.update(ledgerRef, (ledger) => {
      const clientLeases = ledger.clients.get(lease.clientId);
      if (!clientLeases?.has(lease.leaseId)) return ledger;
      const nextClientLeases = new Map(clientLeases);
      nextClientLeases.delete(lease.leaseId);
      const nextClients = new Map(ledger.clients);
      let rejectionLogs = ledger.rejectionLogs;
      if (nextClientLeases.size === 0) {
        nextClients.delete(lease.clientId);
        // A drained client starts its next saturation with a fresh log line.
        const prefix = `${lease.clientId}:`;
        if (Array.from(rejectionLogs.keys()).some((key) => key.startsWith(prefix))) {
          rejectionLogs = new Map(
            Array.from(rejectionLogs).filter(([key]) => !key.startsWith(prefix)),
          );
        }
      } else nextClients.set(lease.clientId, nextClientLeases);
      return {
        ...ledger,
        clients: nextClients,
        rejectionLogs,
        releasedTotal: ledger.releasedTotal + 1,
      };
    });

  const guard = <A, E, R>(clientId: number, method: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(acquire(clientId, method), () => effect, release);

  const snapshot = Ref.get(ledgerRef).pipe(
    Effect.map(
      (ledger): WsRequestAdmissionSnapshot => ({
        clients: ledger.clients.size,
        active: Array.from(ledger.clients.values()).reduce(
          (total, leases) => total + leases.size,
          0,
        ),
        admittedTotal: ledger.admittedTotal,
        releasedTotal: ledger.releasedTotal,
        rejectedTotal: ledger.rejectedTotal,
      }),
    ),
  );

  return { acquire, release, guard, snapshot } as const;
});

export class WsRequestAdmissionMiddleware extends RpcMiddleware.Service<WsRequestAdmissionMiddleware>()(
  "synara/WsRequestAdmissionMiddleware",
  { error: WsRpcError, requiredForClient: false },
) {}

export const wsRequestAdmissionMiddlewareLayer = Layer.effect(
  WsRequestAdmissionMiddleware,
  Effect.gen(function* () {
    const admission = yield* makeWsRequestAdmission;
    const connectionSessions = yield* WsConnectionSessions;
    return ((effect, options) => {
      // Handler fibers descend from the RPC server fiber (forked at layer build),
      // not from the connection's HTTP upgrade fiber, so connection-scoped
      // services must be re-provided here from the connection-session registry.
      const session = connectionSessions.lookup(
        Headers.get(options.headers, WS_CONNECTION_SESSION_HEADER),
      );
      // Unknown transport context must never inherit local-loopback identity.
      if (!session) {
        return Effect.fail(new WsRpcError({ message: "Unauthorized request." }));
      }
      if (
        session.attachmentPrincipal.ownerId.startsWith("remote-device:") &&
        remoteMethodUnavailable(options.rpc._tag)
      ) {
        return Effect.fail(new WsRpcError({ message: REMOTE_NATIVE_UNAVAILABLE }));
      }
      const scoped = provideWsConnectionSession(effect, session);
      return RpcSchema.isStreamSchema(options.rpc.successSchema)
        ? scoped
        : admission.guard(options.clientId, options.rpc._tag, scoped);
    }) satisfies RpcMiddleware.RpcMiddleware<never, WsRpcError, never>;
  }),
);
