import * as Crypto from "node:crypto";

import type { WsRpcError } from "@synara/contracts";
import {
  classifyWsRequest,
  makeWsRequestCapacityError,
  WS_REQUEST_CLASS_LIMITS,
  type WsRequestClass,
} from "@synara/shared/wsRequestClass";
import { Effect, Ref } from "effect";

export interface WsRequestLease {
  readonly clientId: number;
  readonly leaseId: string;
  readonly method: string;
  readonly requestClass: WsRequestClass;
}

interface AdmissionLedger {
  readonly clients: ReadonlyMap<number, ReadonlyMap<string, WsRequestLease>>;
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
  admittedTotal: 0,
  releasedTotal: 0,
  rejectedTotal: 0,
});

export const makeWsRequestAdmission = Effect.gen(function* () {
  const ledgerRef = yield* Ref.make<AdmissionLedger>(initialLedger());

  const acquire = (clientId: number, method: string) =>
    Ref.modify(
      ledgerRef,
      (ledger): readonly [Effect.Effect<WsRequestLease, WsRpcError>, AdmissionLedger] => {
        const requestClass = classifyWsRequest(method);
        const clientLeases = ledger.clients.get(clientId) ?? new Map<string, WsRequestLease>();
        const activeForClass = Array.from(clientLeases.values()).reduce(
          (count, lease) => count + (lease.requestClass === requestClass ? 1 : 0),
          0,
        );
        if (activeForClass >= WS_REQUEST_CLASS_LIMITS[requestClass]) {
          return [
            Effect.fail(makeWsRequestCapacityError(requestClass)),
            { ...ledger, rejectedTotal: ledger.rejectedTotal + 1 },
          ] as const;
        }

        const lease: WsRequestLease = {
          clientId,
          leaseId: Crypto.randomUUID(),
          method,
          requestClass,
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
    ).pipe(Effect.flatten);

  const release = (lease: WsRequestLease) =>
    Ref.update(ledgerRef, (ledger) => {
      const clientLeases = ledger.clients.get(lease.clientId);
      if (!clientLeases?.has(lease.leaseId)) return ledger;
      const nextClientLeases = new Map(clientLeases);
      nextClientLeases.delete(lease.leaseId);
      const nextClients = new Map(ledger.clients);
      if (nextClientLeases.size === 0) nextClients.delete(lease.clientId);
      else nextClients.set(lease.clientId, nextClientLeases);
      return {
        ...ledger,
        clients: nextClients,
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
