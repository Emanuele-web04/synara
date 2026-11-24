import { realpathSync } from "node:fs";

import { Deferred, Effect, Layer, PubSub, Ref, Stream } from "effect";
import type {
  GitStatusLocalResult,
  GitStatusRemoteResult,
  GitStatusResult,
  GitStatusStreamEvent,
} from "@synara/contracts";
import { mergeGitStatusParts } from "@synara/shared/git";

import { GitCore } from "../Services/GitCore";
import { GitManager } from "../Services/GitManager";
import {
  GitStatusBroadcaster,
  type GitStatusBroadcasterShape,
} from "../Services/GitStatusBroadcaster";
import {
  canReuseCachedRemoteStatus,
  type CachedGitStatus,
  isCachedRemoteStatusFresh,
  makeCachedStatusValue,
  setCachedGitStatus,
  splitLocalStatus,
  splitLocalStatusDetails,
  splitRemoteStatus,
  splitRemoteStatusDetails,
} from "../gitStatusCache";

interface GitStatusChange {
  readonly cwd: string;
  readonly event: GitStatusStreamEvent;
}

function normalizeCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

export const GitStatusBroadcasterLive = Layer.effect(
  GitStatusBroadcaster,
  Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const gitManager = yield* GitManager;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<GitStatusChange>(),
      (pubsub) => PubSub.shutdown(pubsub),
    );
    const cacheRef = yield* Ref.make(new Map<string, CachedGitStatus>());
    // Single-flight coalesce concurrent read-only git status loads for the same
    // cwd so bursty sidebar/header/panel mounts share one subprocess wave instead
    // of multiplying git executions. Refreshes are never coalesced: a refresh is
    // requested because the repository just changed, so it must not join a read
    // whose git subprocesses already ran.
    type StatusFlightOutcome =
      | { readonly _tag: "settled"; readonly status: GitStatusResult }
      | { readonly _tag: "abandoned" };
    const ABANDONED_STATUS_FLIGHT: StatusFlightOutcome = { _tag: "abandoned" };
    const inFlightStatusByKey = new Map<string, Deferred.Deferred<StatusFlightOutcome, unknown>>();

    const singleFlightStatus = <E, R>(
      key: string,
      compute: Effect.Effect<GitStatusResult, E, R>,
    ): Effect.Effect<GitStatusResult, E, R> =>
      Effect.suspend(() => {
        const existing = inFlightStatusByKey.get(key);
        if (existing) {
          return (Deferred.await(existing) as Effect.Effect<StatusFlightOutcome, E>).pipe(
            Effect.flatMap(
              (outcome): Effect.Effect<GitStatusResult, E, R> =>
                outcome._tag === "settled"
                  ? Effect.succeed(outcome.status)
                  : // The leader was interrupted or died before producing a result.
                    // Its entry is already gone, so this waiter starts (or joins) a new flight.
                    singleFlightStatus(key, compute),
            ),
          );
        }
        return Effect.gen(function* () {
          const deferred = yield* Deferred.make<StatusFlightOutcome, unknown>();
          inFlightStatusByKey.set(key, deferred);
          return yield* compute.pipe(
            Effect.tap((status) => Deferred.succeed(deferred, { _tag: "settled", status })),
            Effect.tapError((error) => Deferred.fail(deferred, error)),
            // Runs on success, failure, interruption and defects. Completing is a
            // no-op once the flight settled; otherwise it releases every waiter so
            // none is left pending behind a leader that will never finish.
            Effect.ensuring(
              Effect.suspend(() => {
                if (inFlightStatusByKey.get(key) === deferred) {
                  inFlightStatusByKey.delete(key);
                }
                return Deferred.succeed(deferred, ABANDONED_STATUS_FLIGHT);
              }),
            ),
          );
        });
      });

    const getCachedStatus = (cwd: string) =>
      Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));

    const updateCachedLocalStatus = (
      cwd: string,
      local: GitStatusLocalResult,
      options?: { readonly publish?: boolean },
    ) =>
      Effect.gen(function* () {
        const nextLocal = makeCachedStatusValue(local);
        const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          const nextCache = setCachedGitStatus(cache, cwd, { ...previous, local: nextLocal });
          return [previous.local?.fingerprint !== nextLocal.fingerprint, nextCache] as const;
        });

        if (options?.publish && shouldPublish) {
          yield* PubSub.publish(changesPubSub, {
            cwd,
            event: { _tag: "localUpdated", local },
          });
        }

        return local;
      });

    const updateCachedRemoteStatus = (
      cwd: string,
      remote: GitStatusRemoteResult | null,
      options?: { readonly publish?: boolean },
    ) =>
      Effect.gen(function* () {
        const nextRemote = makeCachedStatusValue(remote);
        const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          const nextCache = setCachedGitStatus(cache, cwd, { ...previous, remote: nextRemote });
          return [previous.remote?.fingerprint !== nextRemote.fingerprint, nextCache] as const;
        });

        if (options?.publish && shouldPublish) {
          yield* PubSub.publish(changesPubSub, {
            cwd,
            event: { _tag: "remoteUpdated", remote },
          });
        }

        return remote;
      });

    const loadStatus = (cwd: string, options?: { readonly publish?: boolean }) => {
      const load = Effect.gen(function* () {
        const status = yield* gitManager.status({ cwd });
        const local = yield* updateCachedLocalStatus(cwd, splitLocalStatus(status), options);
        const remote = yield* updateCachedRemoteStatus(cwd, splitRemoteStatus(status), options);
        return mergeGitStatusParts(local, remote) as GitStatusResult;
      });
      return options?.publish ? load : singleFlightStatus(cwd, load);
    };

    const getStatus: GitStatusBroadcasterShape["getStatus"] = (input) =>
      Effect.gen(function* () {
        const normalizedCwd = normalizeCwd(input.cwd);
        const cached = yield* getCachedStatus(normalizedCwd);
        // Only probe git for details when the cached remote metadata could still be
        // reused. `statusDetails` spawns several git subprocesses, and a full status
        // load runs it again, so probing against expired cache state would double the
        // git work on every poll (the sidebar polls at 60 s against a 30 s TTL, so the
        // reuse check could never pass on that path).
        if (cached?.remote && isCachedRemoteStatusFresh({ cached })) {
          const details = yield* gitCore.statusDetails(normalizedCwd);
          if (canReuseCachedRemoteStatus({ cached, details })) {
            const local = yield* updateCachedLocalStatus(
              normalizedCwd,
              splitLocalStatusDetails(details),
            );
            const remote = splitRemoteStatusDetails(details, cached.remote.value);
            return mergeGitStatusParts(local, remote) as GitStatusResult;
          }
        }
        return yield* loadStatus(normalizedCwd);
      });

    const refreshStatus: GitStatusBroadcasterShape["refreshStatus"] = (cwd) =>
      loadStatus(normalizeCwd(cwd), { publish: true });

    const refreshLocalStatus: GitStatusBroadcasterShape["refreshLocalStatus"] = (cwd) =>
      refreshStatus(cwd).pipe(Effect.map(splitLocalStatus));

    const streamStatus: GitStatusBroadcasterShape["streamStatus"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const normalizedCwd = normalizeCwd(input.cwd);
          const subscription = yield* PubSub.subscribe(changesPubSub);
          const status = yield* getStatus({ cwd: normalizedCwd });
          const snapshot: GitStatusStreamEvent = {
            _tag: "snapshot",
            local: splitLocalStatus(status),
            remote: splitRemoteStatus(status),
          };

          return Stream.concat(
            Stream.make(snapshot),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((change) => change.cwd === normalizedCwd),
              Stream.map((change) => change.event),
            ),
          );
        }),
      );

    return {
      getStatus,
      refreshLocalStatus,
      refreshStatus,
      streamStatus,
    } satisfies GitStatusBroadcasterShape;
  }),
);
