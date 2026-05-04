import { realpathSync } from "node:fs";

import { Effect, Layer, PubSub, Ref, Stream } from "effect";
import type {
  GitStatusLocalResult,
  GitStatusRemoteResult,
  GitStatusResult,
  GitStatusStreamEvent,
} from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";

import { GitManager } from "../Services/GitManager";
import {
  GitStatusBroadcaster,
  type GitStatusBroadcasterShape,
} from "../Services/GitStatusBroadcaster";

interface GitStatusChange {
  readonly cwd: string;
  readonly event: GitStatusStreamEvent;
}

interface CachedValue<T> {
  readonly fingerprint: string;
  readonly value: T;
}

interface CachedGitStatus {
  readonly local: CachedValue<GitStatusLocalResult> | null;
  readonly remote: CachedValue<GitStatusRemoteResult | null> | null;
}

function normalizeCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

function fingerprintStatusPart(status: unknown): string {
  return JSON.stringify(status);
}

function splitLocalStatus(status: GitStatusResult): GitStatusLocalResult {
  return {
    branch: status.branch,
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    workingTree: status.workingTree,
  };
}

function splitRemoteStatus(status: GitStatusResult): GitStatusRemoteResult {
  return {
    hasUpstream: status.hasUpstream,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    pr: status.pr,
  };
}

export const GitStatusBroadcasterLive = Layer.effect(
  GitStatusBroadcaster,
  Effect.gen(function* () {
    const gitManager = yield* GitManager;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<GitStatusChange>(),
      (pubsub) => PubSub.shutdown(pubsub),
    );
    const cacheRef = yield* Ref.make(new Map<string, CachedGitStatus>());

    const getCachedStatus = (cwd: string) =>
      Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));

    const updateCachedLocalStatus = (
      cwd: string,
      local: GitStatusLocalResult,
      options?: { readonly publish?: boolean },
    ) =>
      Effect.gen(function* () {
        const nextLocal = {
          fingerprint: fingerprintStatusPart(local),
          value: local,
        } satisfies CachedValue<GitStatusLocalResult>;
        const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          const nextCache = new Map(cache);
          nextCache.set(cwd, { ...previous, local: nextLocal });
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
        const nextRemote = {
          fingerprint: fingerprintStatusPart(remote),
          value: remote,
        } satisfies CachedValue<GitStatusRemoteResult | null>;
        const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          const nextCache = new Map(cache);
          nextCache.set(cwd, { ...previous, remote: nextRemote });
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

    const loadStatus = (cwd: string, options?: { readonly publish?: boolean }) =>
      Effect.gen(function* () {
        const status = yield* gitManager.status({ cwd });
        const local = yield* updateCachedLocalStatus(cwd, splitLocalStatus(status), options);
        const remote = yield* updateCachedRemoteStatus(cwd, splitRemoteStatus(status), options);
        return mergeGitStatusParts(local, remote) as GitStatusResult;
      });

    const getStatus: GitStatusBroadcasterShape["getStatus"] = (input) =>
      Effect.gen(function* () {
        const normalizedCwd = normalizeCwd(input.cwd);
        const cached = yield* getCachedStatus(normalizedCwd);
        if (cached?.local && cached.remote) {
          return mergeGitStatusParts(cached.local.value, cached.remote.value) as GitStatusResult;
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
