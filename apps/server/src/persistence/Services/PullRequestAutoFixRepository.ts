/**
 * Durable "Auto-fix CI" state, one row per watched pull request of a chat. A row exists only
 * while auto-fix is on for that PR; turning it off deletes the row.
 */
import { PullRequestAutoFixState, ThreadId, TrimmedNonEmptyString } from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type PullRequestAutoFixRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export const PullRequestAutoFixThreadInput = Schema.Struct({ threadId: ThreadId });
export type PullRequestAutoFixThreadInput = typeof PullRequestAutoFixThreadInput.Type;

export const PullRequestAutoFixKey = Schema.Struct({
  threadId: ThreadId,
  pullRequestUrl: TrimmedNonEmptyString,
});
export type PullRequestAutoFixKey = typeof PullRequestAutoFixKey.Type;

export interface PullRequestAutoFixRepositoryShape {
  readonly listByThread: (
    input: PullRequestAutoFixThreadInput,
  ) => Effect.Effect<ReadonlyArray<PullRequestAutoFixState>, PullRequestAutoFixRepositoryError>;

  /** Rows the watcher should poll: everything not paused. */
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<PullRequestAutoFixState>,
    PullRequestAutoFixRepositoryError
  >;

  readonly upsert: (
    state: PullRequestAutoFixState,
  ) => Effect.Effect<void, PullRequestAutoFixRepositoryError>;

  readonly delete: (
    key: PullRequestAutoFixKey,
  ) => Effect.Effect<void, PullRequestAutoFixRepositoryError>;
}

export class PullRequestAutoFixRepository extends ServiceMap.Service<
  PullRequestAutoFixRepository,
  PullRequestAutoFixRepositoryShape
>()("synara/persistence/Services/PullRequestAutoFixRepository/PullRequestAutoFixRepository") {}
