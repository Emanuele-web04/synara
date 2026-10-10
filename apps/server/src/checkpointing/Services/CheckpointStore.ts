import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { CheckpointStoreError } from "../Errors.ts";
import { CheckpointRef } from "@synara/contracts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** treat an existing ref as success — the first baseline snapshot must win; overwriting it would record an agent-modified tree */
  readonly skipIfExists?: boolean;
}

export interface CopyCheckpointRefInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly maxOutputBytes?: number;
}

export interface ReverseCheckpointDiffInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly maxOutputBytes?: number;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface CheckpointStoreShape {
  readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

  /** capture via an isolated temporary Git index, written to a hidden ref */
  readonly captureCheckpoint: (
    input: CaptureCheckpointInput,
  ) => Effect.Effect<void, CheckpointStoreError>;

  /** bind a pre-send message snapshot to the provider turn id once known */
  readonly copyCheckpointRef: (
    input: CopyCheckpointRefInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  readonly hasCheckpointRef: (
    input: Omit<RestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /** optionally falls back to current HEAD when the ref is missing */
  readonly restoreCheckpoint: (
    input: RestoreCheckpointInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  readonly diffCheckpoints: (
    input: DiffCheckpointsInput,
  ) => Effect.Effect<string, CheckpointStoreError>;

  /** reverse only the changes between two checkpoints onto the current workspace */
  readonly reverseCheckpointDiff: (
    input: ReverseCheckpointDiffInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /** missing refs are tolerated, but a ref that exists and can't be deleted fails — callers use this to protect a user's only way back */
  readonly deleteCheckpointRefs: (
    input: DeleteCheckpointRefsInput,
  ) => Effect.Effect<void, CheckpointStoreError>;
}

export class CheckpointStore extends ServiceMap.Service<CheckpointStore, CheckpointStoreShape>()(
  "synara/checkpointing/Services/CheckpointStore",
) {}
