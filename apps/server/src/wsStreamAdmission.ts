import * as Crypto from "node:crypto";

import { WS_STREAM_LIMITS, WsRpcError } from "@synara/contracts";
import { Effect, Ref, Stream } from "effect";

export const MAX_STREAMS_PER_RPC_CLIENT = WS_STREAM_LIMITS.totalPerClient;
export const MAX_THREAD_STREAMS_PER_RPC_CLIENT = WS_STREAM_LIMITS.threadPerClient;
const STREAM_CAPACITY_RETRY_AFTER_MS = 1_000;

export interface WsStreamSubscription {
  readonly key: string;
  readonly threadId?: string;
}

export interface WsStreamLease extends WsStreamSubscription {
  readonly clientId: number;
  readonly leaseId: string;
}

interface ClientLedger {
  readonly leases: ReadonlyMap<string, WsStreamLease>;
}

interface AdmissionLedger {
  readonly clients: ReadonlyMap<number, ClientLedger>;
  readonly admittedTotal: number;
  readonly releasedTotal: number;
  readonly rejectedDuplicateTotal: number;
  readonly rejectedCapacityTotal: number;
}

export interface WsStreamAdmissionSnapshot {
  readonly clients: number;
  readonly active: number;
  readonly admittedTotal: number;
  readonly releasedTotal: number;
  readonly rejectedDuplicateTotal: number;
  readonly rejectedCapacityTotal: number;
}

type AdmissionOutcome =
  | { readonly _tag: "Admitted"; readonly lease: WsStreamLease }
  | {
      readonly _tag: "Rejected";
      readonly error: WsRpcError;
      readonly reason: "duplicate" | "stream-capacity" | "thread-capacity";
      readonly active: number;
      readonly activeThreads: number;
    };

const initialLedger = (): AdmissionLedger => ({
  clients: new Map(),
  admittedTotal: 0,
  releasedTotal: 0,
  rejectedDuplicateTotal: 0,
  rejectedCapacityTotal: 0,
});

function activeThreadCount(leases: ReadonlyMap<string, WsStreamLease>): number {
  return new Set(
    Array.from(leases.values()).flatMap((lease) =>
      lease.threadId === undefined ? [] : [lease.threadId],
    ),
  ).size;
}

export const makeWsStreamAdmission = (
  options: {
    readonly recordRejection?: (input: {
      readonly threadId?: string;
      readonly reason: "duplicate" | "stream-capacity" | "thread-capacity";
      readonly errorCode: string;
      readonly active: number;
      readonly activeThreads: number;
    }) => Effect.Effect<void, never>;
  } = {},
) =>
  Effect.gen(function* () {
    const ledgerRef = yield* Ref.make<AdmissionLedger>(initialLedger());

    const acquire = (clientId: number, subscription: WsStreamSubscription) =>
      Ref.modify(ledgerRef, (ledger): readonly [AdmissionOutcome, AdmissionLedger] => {
        const client = ledger.clients.get(clientId) ?? { leases: new Map() };
        const leases = client.leases;
        const active = leases.size;
        const activeThreads = activeThreadCount(leases);
        const duplicate = Array.from(leases.values()).some(
          (lease) => lease.key === subscription.key,
        );
        if (duplicate) {
          return [
            {
              _tag: "Rejected",
              reason: "duplicate",
              active,
              activeThreads,
              error: new WsRpcError({
                message: "Duplicate streaming RPC subscription.",
                code: "STREAM_DUPLICATE_SUBSCRIPTION",
                retryable: false,
              }),
            },
            { ...ledger, rejectedDuplicateTotal: ledger.rejectedDuplicateTotal + 1 },
          ];
        }
        if (active >= MAX_STREAMS_PER_RPC_CLIENT) {
          return [
            {
              _tag: "Rejected",
              reason: "stream-capacity",
              active,
              activeThreads,
              error: new WsRpcError({
                message: "Streaming RPC capacity exceeded.",
                code: "STREAM_CAPACITY_EXCEEDED",
                retryable: true,
                retryAfterMs: STREAM_CAPACITY_RETRY_AFTER_MS,
              }),
            },
            { ...ledger, rejectedCapacityTotal: ledger.rejectedCapacityTotal + 1 },
          ];
        }
        if (
          subscription.threadId !== undefined &&
          activeThreads >= MAX_THREAD_STREAMS_PER_RPC_CLIENT
        ) {
          return [
            {
              _tag: "Rejected",
              reason: "thread-capacity",
              active,
              activeThreads,
              error: new WsRpcError({
                message: "Thread streaming RPC capacity exceeded.",
                code: "THREAD_STREAM_CAPACITY_EXCEEDED",
                retryable: true,
                retryAfterMs: STREAM_CAPACITY_RETRY_AFTER_MS,
              }),
            },
            { ...ledger, rejectedCapacityTotal: ledger.rejectedCapacityTotal + 1 },
          ];
        }

        const lease: WsStreamLease = {
          ...subscription,
          clientId,
          leaseId: Crypto.randomUUID(),
        };
        const nextLeases = new Map(leases);
        nextLeases.set(lease.leaseId, lease);
        const nextClients = new Map(ledger.clients);
        nextClients.set(clientId, { leases: nextLeases });
        return [
          { _tag: "Admitted", lease },
          { ...ledger, clients: nextClients, admittedTotal: ledger.admittedTotal + 1 },
        ];
      }).pipe(
        Effect.flatMap((outcome) =>
          outcome._tag === "Admitted"
            ? Effect.succeed(outcome.lease)
            : Effect.gen(function* () {
                yield* Effect.logWarning("Rejected streaming RPC admission.").pipe(
                  Effect.annotateLogs({
                    reason: outcome.reason,
                    active: outcome.active,
                    activeThreads: outcome.activeThreads,
                    streamLimit: MAX_STREAMS_PER_RPC_CLIENT,
                    threadLimit: MAX_THREAD_STREAMS_PER_RPC_CLIENT,
                    requestedThreadId: subscription.threadId ?? null,
                  }),
                );
                if (options.recordRejection) {
                  const recordRejection = options.recordRejection;
                  yield* Effect.sync(() => {
                    Effect.runFork(
                      recordRejection({
                        ...(subscription.threadId ? { threadId: subscription.threadId } : {}),
                        reason: outcome.reason,
                        errorCode: outcome.error.code ?? "STREAM_ADMISSION_REJECTED",
                        active: outcome.active,
                        activeThreads: outcome.activeThreads,
                      }),
                    );
                  });
                }
                return yield* Effect.fail(outcome.error);
              }),
        ),
      );

    const release = (lease: WsStreamLease) =>
      Ref.update(ledgerRef, (ledger) => {
        const client = ledger.clients.get(lease.clientId);
        if (!client?.leases.has(lease.leaseId)) return ledger;
        const nextLeases = new Map(client.leases);
        nextLeases.delete(lease.leaseId);
        const nextClients = new Map(ledger.clients);
        if (nextLeases.size === 0) nextClients.delete(lease.clientId);
        else nextClients.set(lease.clientId, { leases: nextLeases });
        return {
          ...ledger,
          clients: nextClients,
          releasedTotal: ledger.releasedTotal + 1,
        };
      });

    const guard = <A, E, R>(
      clientId: number,
      subscription: WsStreamSubscription,
      stream: Stream.Stream<A, E, R>,
    ): Stream.Stream<A, E | WsRpcError, R> =>
      Stream.unwrap(
        Effect.acquireRelease(acquire(clientId, subscription), release).pipe(Effect.as(stream)),
      );

    const snapshot = Ref.get(ledgerRef).pipe(
      Effect.map(
        (ledger): WsStreamAdmissionSnapshot => ({
          clients: ledger.clients.size,
          active: Array.from(ledger.clients.values()).reduce(
            (total, client) => total + client.leases.size,
            0,
          ),
          admittedTotal: ledger.admittedTotal,
          releasedTotal: ledger.releasedTotal,
          rejectedDuplicateTotal: ledger.rejectedDuplicateTotal,
          rejectedCapacityTotal: ledger.rejectedCapacityTotal,
        }),
      ),
    );

    return { acquire, release, guard, snapshot } as const;
  });
