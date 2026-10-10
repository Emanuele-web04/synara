import * as Crypto from "node:crypto";

import { WS_STREAM_LIMITS, WsRpcError } from "@synara/contracts";
import { Deferred, Effect, Ref, Stream } from "effect";

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
  // Resolves when unsubscribe ends the lease. Guarded streams interrupt on it:
  // removing the lease from the ledger alone would leave its live tap running
  // until the scope happens to finalize, letting a client exceed the caps.
  readonly ended: Deferred.Deferred<void>;
}

interface LeaseEntry {
  readonly lease: WsStreamLease;
  // Live guarded streams currently attached to the lease. An identical
  // resubscribe — same client, same key — returns the existing lease, so one
  // lease can be shared by several streams; the entry is freed only when the
  // last holder's scope finalizes.
  readonly holds: number;
}

interface ClientLedger {
  readonly leases: ReadonlyMap<string, LeaseEntry>;
}

interface AdmissionLedger {
  readonly clients: ReadonlyMap<number, ClientLedger>;
  readonly admittedTotal: number;
  readonly releasedTotal: number;
  readonly rejectedCapacityTotal: number;
}

export interface WsStreamAdmissionSnapshot {
  readonly clients: number;
  readonly active: number;
  readonly admittedTotal: number;
  readonly releasedTotal: number;
  readonly rejectedCapacityTotal: number;
}

type AdmissionOutcome =
  | {
      readonly _tag: "Admitted";
      readonly lease: WsStreamLease;
    }
  | {
      readonly _tag: "Rejected";
      readonly error: WsRpcError;
      readonly reason: "stream-capacity" | "thread-capacity";
      readonly active: number;
      readonly activeThreads: number;
    };

const initialLedger = (): AdmissionLedger => ({
  clients: new Map(),
  admittedTotal: 0,
  releasedTotal: 0,
  rejectedCapacityTotal: 0,
});

function activeThreadCount(leases: ReadonlyMap<string, LeaseEntry>): number {
  return new Set(
    Array.from(leases.values()).flatMap((entry) =>
      entry.lease.threadId === undefined ? [] : [entry.lease.threadId],
    ),
  ).size;
}

export const makeWsStreamAdmission = (
  options: {
    readonly recordRejection?: (input: {
      readonly threadId?: string;
      readonly reason: "stream-capacity" | "thread-capacity";
      readonly errorCode: string;
      readonly active: number;
      readonly activeThreads: number;
    }) => Effect.Effect<void, never>;
  } = {},
) =>
  Effect.gen(function* () {
    const ledgerRef = yield* Ref.make<AdmissionLedger>(initialLedger());

    const acquire = (clientId: number, subscription: WsStreamSubscription) =>
      Effect.gen(function* () {
        const ended = yield* Deferred.make<void>();
        const outcome = yield* Ref.modify(
          ledgerRef,
          (ledger): readonly [AdmissionOutcome, AdmissionLedger] => {
            const client = ledger.clients.get(clientId) ?? {
              leases: new Map<string, LeaseEntry>(),
            };
            // Each client owns an independent ledger. Reusing a key within
            // that ledger attaches to the existing lease instead of tearing
            // down and replaying its live stream.
            const heldEntry = Array.from(client.leases.values()).find(
              (entry) => entry.lease.key === subscription.key,
            );
            if (heldEntry !== undefined) {
              const nextLeases = new Map(client.leases);
              nextLeases.set(heldEntry.lease.leaseId, {
                lease: heldEntry.lease,
                holds: heldEntry.holds + 1,
              });
              const nextClients = new Map(ledger.clients);
              nextClients.set(clientId, { leases: nextLeases });
              return [
                {
                  _tag: "Admitted",
                  lease: heldEntry.lease,
                },
                {
                  ...ledger,
                  clients: nextClients,
                },
              ];
            }
            const active = client.leases.size;
            const activeThreads = activeThreadCount(client.leases);
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
              ended,
            };
            const nextLeases = new Map(client.leases);
            nextLeases.set(lease.leaseId, { lease, holds: 1 });
            const nextClients = new Map(ledger.clients);
            nextClients.set(clientId, { leases: nextLeases });
            return [
              { _tag: "Admitted", lease },
              {
                ...ledger,
                clients: nextClients,
                admittedTotal: ledger.admittedTotal + 1,
              },
            ];
          },
        );
        if (outcome._tag === "Admitted") {
          return outcome.lease;
        }
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
      });

    const release = (lease: WsStreamLease) =>
      Ref.update(ledgerRef, (ledger) => {
        const client = ledger.clients.get(lease.clientId);
        const entry = client?.leases.get(lease.leaseId);
        // Only the current holder releases: a stale lease whose slot was taken
        // over is already gone, and a shared lease (identical resubscribe)
        // survives until its last stream's scope finalizes.
        if (!client || !entry || entry.lease !== lease) return ledger;
        if (entry.holds > 1) {
          const nextLeases = new Map(client.leases);
          nextLeases.set(lease.leaseId, { lease: entry.lease, holds: entry.holds - 1 });
          const nextClients = new Map(ledger.clients);
          nextClients.set(lease.clientId, { leases: nextLeases });
          return { ...ledger, clients: nextClients };
        }
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

    /**
     * Releases this client's lease for a key — the unsubscribe path. The
     * lease is removed from the ledger and its end latch completes so every
     * attached stream ends promptly instead of waiting for its scope to finalize.
     */
    const releaseKey = (clientId: number, key: string) =>
      Effect.gen(function* () {
        const removed = yield* Ref.modify(
          ledgerRef,
          (ledger): readonly [WsStreamLease | undefined, AdmissionLedger] => {
            const client = ledger.clients.get(clientId);
            if (!client) return [undefined, ledger];
            for (const [leaseId, entry] of client.leases) {
              if (entry.lease.key !== key) continue;
              const nextLeases = new Map(client.leases);
              nextLeases.delete(leaseId);
              const nextClients = new Map(ledger.clients);
              if (nextLeases.size === 0) nextClients.delete(clientId);
              else nextClients.set(clientId, { leases: nextLeases });
              return [
                entry.lease,
                {
                  ...ledger,
                  clients: nextClients,
                  releasedTotal: ledger.releasedTotal + 1,
                },
              ];
            }
            return [undefined, ledger];
          },
        );
        if (removed === undefined) return;
        yield* Deferred.succeed(removed.ended, undefined);
      });

    const guard = <A, E, R>(
      clientId: number,
      subscription: WsStreamSubscription,
      stream: Stream.Stream<A, E, R>,
    ): Stream.Stream<A, E | WsRpcError, R> =>
      Stream.unwrap(
        Effect.acquireRelease(acquire(clientId, subscription), release).pipe(
          // Unsubscribe ends the stream gracefully. Scope finalization then
          // detaches this holder; a shared lease survives until every holder
          // has finalized.
          Effect.map((lease) => stream.pipe(Stream.interruptWhen(Deferred.await(lease.ended)))),
        ),
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
          rejectedCapacityTotal: ledger.rejectedCapacityTotal,
        }),
      ),
    );

    return { acquire, release, releaseKey, guard, snapshot } as const;
  });
