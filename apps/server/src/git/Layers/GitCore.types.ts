// FILE: GitCore.types.ts
// Purpose: Pure type and constant definitions shared by the GitCore service implementation.
// Layer: Server Git service (pure)
// Exports: GitCore tuning constants, working-tree stat types, and helper option types.
import { Duration } from "effect";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
export const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
export const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);
export const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;
export const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;
export const EMPTY_TREE_OBJECT_ID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const WORKING_TREE_DIFF_TIMEOUT_MS = 15_000;
export const MAX_UNTRACKED_DIFF_CONCURRENCY = 4;
export const MOVE_AWARE_WORKING_TREE_STATUS_TIMEOUT_MS = 15_000;
export const AUTO_DETACHED_WORKTREE_DIRNAME = "synara";
export const NON_REPOSITORY_STATUS_DETAILS = Object.freeze({
  isRepo: false,
  hasOriginRemote: false,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  upstreamBranch: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
});

export type TraceTailState = {
  processedChars: number;
  remainder: string;
};

export interface ExecuteGitOptions {
  timeoutMs?: number | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorMessage?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  progress?: import("../Services/GitCore.ts").ExecuteGitProgress | undefined;
}

export type WorkingTreeFileStat = { path: string; insertions: number; deletions: number };

export type WorkingTreeStatSummary = {
  files: WorkingTreeFileStat[];
  insertions: number;
  deletions: number;
};

export type StashEntry = {
  ref: string;
  hash: string;
};
