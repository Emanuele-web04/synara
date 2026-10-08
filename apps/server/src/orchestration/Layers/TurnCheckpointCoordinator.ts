import { Effect, Layer, Semaphore } from "effect";

import {
  canonicalImportPath,
  findImportGitWorkspace,
  importPathIdentity,
} from "../projectImportPaths.ts";

import {
  TurnCheckpointCoordinator,
  type TurnCheckpointCoordinatorShape,
} from "../Services/TurnCheckpointCoordinator.ts";

const make = Effect.sync(() => {
  const leases = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();

  const withLease = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        let entry = leases.get(key);
        if (entry === undefined) {
          entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          leases.set(key, entry);
        }
        entry.users += 1;
        const acquiredEntry = entry;

        return restore(acquiredEntry.semaphore.withPermits(1)(effect)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              acquiredEntry.users -= 1;
              if (acquiredEntry.users === 0 && leases.get(key) === acquiredEntry) {
                leases.delete(key);
              }
            }),
          ),
        );
      }),
    );

  const withThreadLease: TurnCheckpointCoordinatorShape["withThreadLease"] = (threadId, effect) =>
    withLease(`thread:${threadId}`, effect);
  const resolveWorkspaceIdentity: TurnCheckpointCoordinatorShape["resolveWorkspaceIdentity"] = (
    cwd,
  ) =>
    Effect.tryPromise(async () => {
      const physicalCwd = await canonicalImportPath(cwd);
      const workspace = await findImportGitWorkspace(physicalCwd);
      return importPathIdentity(workspace?.worktree ?? workspace?.root ?? physicalCwd);
    }).pipe(Effect.orDie);
  const withWorkspaceIdentityLease: TurnCheckpointCoordinatorShape["withWorkspaceIdentityLease"] = (
    identity,
    effect,
  ) => withLease(`workspace:${identity}`, effect);
  const withWorkspaceLease: TurnCheckpointCoordinatorShape["withWorkspaceLease"] = (cwd, effect) =>
    resolveWorkspaceIdentity(cwd).pipe(
      Effect.flatMap((identity) => withWorkspaceIdentityLease(identity, effect)),
    );

  return {
    withThreadLease,
    withWorkspaceLease,
    withWorkspaceIdentityLease,
    resolveWorkspaceIdentity,
  } satisfies TurnCheckpointCoordinatorShape;
});

export const TurnCheckpointCoordinatorLive = Layer.effect(TurnCheckpointCoordinator, make);
