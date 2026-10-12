// FILE: ConformanceScratchWorkspace.ts
// Purpose: Per-run scratch working directory for conformance verifications.
// Layer: Server conformance filesystem utility
// Exports: withConformanceScratchWorkspace, makeConformanceScratchWorkspace

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { Effect, Layer, Option, Scope, ServiceMap } from "effect";

/** Scope-owned temporary directory; cleanup also runs on timeout or interruption. */
export const withConformanceScratchWorkspace: <A, E, R>(
  use: (workspace: string) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | Error, R | Scope.Scope> = (use) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(path.join(tmpdir(), "synara-conformance-")),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }),
    (directory) =>
      Effect.tryPromise({
        try: () => rm(directory, { recursive: true, force: true }),
        catch: (error) => error,
      }).pipe(
        Effect.catch(() => Effect.logWarning("Conformance temporary directory cleanup failed.")),
      ),
  ).pipe(Effect.flatMap(use));

/**
 * Service-based variant so the runner can depend on a single service rather
 * than building scopes ad-hoc in each verifier.
 */
export interface ConformanceScratchWorkspaceShape {
  /**
   * Runs `use` inside a scope that guarantees the scratch directory is removed
   * when the effect completes or fails. Also bounded by `runTimeoutMs` when
   * provided, so a misbehaving verifier can never leak a workspace.
   */
  readonly inScratchWorkspace: <A, E, R>(
    use: (workspace: string) => Effect.Effect<A, E, R>,
    runTimeoutMs?: number,
  ) => Effect.Effect<A, E | Error, R | Scope.Scope>;
}

export class ConformanceScratchWorkspace extends ServiceMap.Service<
  ConformanceScratchWorkspace,
  ConformanceScratchWorkspaceShape
>()("synara/conformance/ConformanceScratchWorkspace") {}

export const makeConformanceScratchWorkspace: Effect.Effect<ConformanceScratchWorkspaceShape> =
  Effect.sync(
    (): ConformanceScratchWorkspaceShape => ({
      inScratchWorkspace: (use, runTimeoutMs) => {
        const scoped = withConformanceScratchWorkspace(use).pipe(Effect.scoped);
        if (runTimeoutMs === undefined) return scoped;
        return scoped.pipe(
          Effect.timeoutOption(runTimeoutMs),
          Effect.flatMap((maybe) =>
            Option.isNone(maybe)
              ? Effect.fail(
                  new Error(
                    `Conformance run exceeded the ${String(runTimeoutMs)}ms hard deadline.`,
                  ),
                )
              : Effect.succeed(maybe.value),
          ),
        );
      },
    }),
  );

export const ConformanceScratchWorkspaceLive = Layer.effect(
  ConformanceScratchWorkspace,
  makeConformanceScratchWorkspace,
);
