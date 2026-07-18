import { realpathSync } from "node:fs";

import { Deferred, Effect, Exit, Layer, PubSub, Ref, Semaphore, Stream } from "effect";
import type {
  GitStatusInput,
  GitStatusLocalResult,
  GitStatusRemoteResult,
  GitStatusResult,
  GitStatusStreamEvent,
} from "@synara/contracts";
import { mergeGitStatusParts } from "@synara/shared/git";

import type { GitManagerServiceError } from "../Errors";
import { GitCore } from "../Services/GitCore";
import { GitManager } from "../Services/GitManager";
import {
  GitStatusBroadcaster,
  type GitStatusBroadcasterShape,
} from "../Services/GitStatusBroadcaster";
import {
  canReuseCachedRemoteStatus,
  type CachedGitStatus,
  makeCachedStatusValue,
  splitLocalStatus,
  splitLocalStatusDetails,
  splitRemoteStatus,
  splitRemoteStatusDetails,
} from "../gitStatusCache";

interface GitStatusChange {
  readonly cacheKey: string;
  readonly event: GitStatusStreamEvent;
}

const STATUS_FAILURE_BACKOFF_MS = 5_000;

function normalizeCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

function statusCacheKey(input: GitStatusInput): string {
  return JSON.stringify([
    normalizeCwd(input.cwd),
    input.account?.host.toLowerCase() ?? null,
    input.account?.login.toLowerCase() ?? null,
  ]);
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
    const flightLock = yield* Semaphore.make(1);
    const inFlight = new Map<string, Deferred.Deferred<GitStatusResult, GitManagerServiceError>>();
    const failureBackoff = new Map<
      string,
      { readonly error: GitManagerServiceError; readonly retryAt: number }
    >();
    const inputsByCacheKey = new Map<string, GitStatusInput>();

    const rememberInput = (input: GitStatusInput): GitStatusInput => {
      const normalizedInput = { ...input, cwd: normalizeCwd(input.cwd) };
      inputsByCacheKey.set(statusCacheKey(normalizedInput), normalizedInput);
      return normalizedInput;
    };

    const getCachedStatus = (cacheKey: string) =>
      Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cacheKey) ?? null));

    const updateCachedLocalStatus = (
      cacheKey: string,
      local: GitStatusLocalResult,
      options?: { readonly publish?: boolean },
    ) =>
      Effect.gen(function* () {
        const nextLocal = makeCachedStatusValue(local);
        const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cacheKey) ?? { local: null, remote: null };
          const nextCache = new Map(cache);
          nextCache.set(cacheKey, { ...previous, local: nextLocal });
          return [previous.local?.fingerprint !== nextLocal.fingerprint, nextCache] as const;
        });

        if (options?.publish && shouldPublish) {
          yield* PubSub.publish(changesPubSub, {
            cacheKey,
            event: { _tag: "localUpdated", local },
          });
        }

        return local;
      });

    const updateCachedRemoteStatus = (
      cacheKey: string,
      remote: GitStatusRemoteResult | null,
      options?: { readonly publish?: boolean },
    ) =>
      Effect.gen(function* () {
        const nextRemote = makeCachedStatusValue(remote);
        const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cacheKey) ?? { local: null, remote: null };
          const nextCache = new Map(cache);
          nextCache.set(cacheKey, { ...previous, remote: nextRemote });
          return [previous.remote?.fingerprint !== nextRemote.fingerprint, nextCache] as const;
        });

        if (options?.publish && shouldPublish) {
          yield* PubSub.publish(changesPubSub, {
            cacheKey,
            event: { _tag: "remoteUpdated", remote },
          });
        }

        return remote;
      });

    const loadStatus = (
      input: GitStatusInput,
      cacheKey: string,
      options?: { readonly publish?: boolean },
    ) =>
      Effect.gen(function* () {
        const status = yield* gitManager.status(input);
        const local = yield* updateCachedLocalStatus(cacheKey, splitLocalStatus(status), options);
        const remote = yield* updateCachedRemoteStatus(
          cacheKey,
          splitRemoteStatus(status),
          options,
        );
        return mergeGitStatusParts(local, remote) as GitStatusResult;
      });

    const singleFlight = (
      cacheKey: string,
      operation: Effect.Effect<GitStatusResult, GitManagerServiceError>,
    ) =>
      Effect.gen(function* () {
        const registration = yield* flightLock.withPermits(1)(
          Effect.gen(function* () {
            const existing = inFlight.get(cacheKey);
            if (existing) return { owner: false as const, deferred: existing };
            const deferred = yield* Deferred.make<GitStatusResult, GitManagerServiceError>();
            inFlight.set(cacheKey, deferred);
            return { owner: true as const, deferred };
          }),
        );
        if (!registration.owner) return yield* Deferred.await(registration.deferred);

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(restore(operation));
            yield* Deferred.done(registration.deferred, exit);
            yield* flightLock.withPermits(1)(Effect.sync(() => inFlight.delete(cacheKey)));
            if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
            return exit.value;
          }),
        );
      });

    const withFailureBackoff = (
      cacheKey: string,
      operation: Effect.Effect<GitStatusResult, GitManagerServiceError>,
    ) =>
      Effect.gen(function* () {
        const failed = failureBackoff.get(cacheKey);
        if (failed && failed.retryAt > Date.now()) return yield* failed.error;

        return yield* singleFlight(
          cacheKey,
          operation.pipe(
            Effect.tap(() => Effect.sync(() => failureBackoff.delete(cacheKey))),
            Effect.tapError((error) =>
              Effect.sync(() =>
                failureBackoff.set(cacheKey, {
                  error,
                  retryAt: Date.now() + STATUS_FAILURE_BACKOFF_MS,
                }),
              ),
            ),
          ),
        );
      });

    const getStatus: GitStatusBroadcasterShape["getStatus"] = (input) =>
      Effect.gen(function* () {
        const normalizedInput = rememberInput(input);
        const cacheKey = statusCacheKey(normalizedInput);
        const cached = yield* getCachedStatus(cacheKey);
        if (cached?.local && cached.remote) {
          const details = yield* gitCore.statusDetails(normalizedInput.cwd);
          if (canReuseCachedRemoteStatus({ cached, details })) {
            const local = yield* updateCachedLocalStatus(
              cacheKey,
              splitLocalStatusDetails(details),
            );
            const remote = splitRemoteStatusDetails(details, cached.remote.value);
            return mergeGitStatusParts(local, remote) as GitStatusResult;
          }
        }
        return yield* loadStatus(normalizedInput, cacheKey);
      }).pipe((operation) =>
        withFailureBackoff(statusCacheKey({ ...input, cwd: normalizeCwd(input.cwd) }), operation),
      );

    const refreshInput = (input: GitStatusInput) => {
      const normalizedInput = rememberInput(input);
      const cacheKey = statusCacheKey(normalizedInput);
      return withFailureBackoff(cacheKey, loadStatus(normalizedInput, cacheKey, { publish: true }));
    };

    const refreshStatus: GitStatusBroadcasterShape["refreshStatus"] = (cwd) =>
      Effect.gen(function* () {
        const normalizedCwd = normalizeCwd(cwd);
        const defaultInput = rememberInput({ cwd: normalizedCwd });
        const defaultKey = statusCacheKey(defaultInput);
        const inputs = [
          defaultInput,
          ...Array.from(inputsByCacheKey.entries())
            .filter(([cacheKey, input]) => cacheKey !== defaultKey && input.cwd === normalizedCwd)
            .map(([, input]) => input),
        ];
        const exits = yield* Effect.all(
          inputs.map((input) => Effect.exit(refreshInput(input))),
          { concurrency: 4 },
        );
        const defaultExit = exits[0];
        if (!defaultExit) {
          return yield* Effect.die("Git status refresh did not produce a default result");
        }
        if (Exit.isFailure(defaultExit)) {
          return yield* Effect.failCause(defaultExit.cause);
        }
        return defaultExit.value;
      });

    const refreshLocalStatus: GitStatusBroadcasterShape["refreshLocalStatus"] = (cwd) =>
      refreshStatus(cwd).pipe(Effect.map(splitLocalStatus));

    const streamStatus: GitStatusBroadcasterShape["streamStatus"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const normalizedCwd = normalizeCwd(input.cwd);
          const normalizedInput = { ...input, cwd: normalizedCwd };
          const cacheKey = statusCacheKey(normalizedInput);
          const subscription = yield* PubSub.subscribe(changesPubSub);
          const status = yield* getStatus(normalizedInput);
          const snapshot: GitStatusStreamEvent = {
            _tag: "snapshot",
            local: splitLocalStatus(status),
            remote: splitRemoteStatus(status),
          };

          return Stream.concat(
            Stream.make(snapshot),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((change) => change.cacheKey === cacheKey),
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
