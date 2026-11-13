// FILE: historyIntegration.ts
// Purpose: Pure helpers that separate a turn's own edits from history it only checked out.
// Layer: Checkpointing utilities.
// Exports: checkpoint HEAD trailer helpers and `git diff -z` parsers used by CheckpointStore.

/**
 * Checkpoint commits record the repository HEAD they were captured on. A turn
 * that merges, pulls, rebases, checks out or resets onto commits that already
 * existed changes the working tree without authoring those changes; the HEAD
 * pair lets diffs leave that history out.
 */
export const CHECKPOINT_HEAD_TRAILER = "Synara-Head";

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function formatCheckpointHeadTrailer(headCommit: string): string {
  return `${CHECKPOINT_HEAD_TRAILER}: ${headCommit}`;
}

export interface CheckpointCommitMetadata {
  /** Committer time of the checkpoint itself, in Unix seconds. */
  readonly capturedAtSeconds: number | null;
  /** HEAD at capture time; null for legacy checkpoints and unborn branches. */
  readonly head: string | null;
}

/** Reads `git cat-file commit` output for a checkpoint commit. */
export function parseCheckpointCommit(raw: string): CheckpointCommitMetadata {
  const separator = raw.indexOf("\n\n");
  const header = separator === -1 ? raw : raw.slice(0, separator);
  const message = separator === -1 ? "" : raw.slice(separator + 2);
  const committer = /^committer .* (\d+) [+-]\d{4}$/m.exec(header);
  const capturedAtSeconds = committer ? Number(committer[1]) : null;
  let head: string | null = null;
  for (const line of message.split("\n")) {
    const prefix = `${CHECKPOINT_HEAD_TRAILER}: `;
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length).trim();
    head = OBJECT_ID.test(value) ? value : null;
  }
  return {
    capturedAtSeconds:
      capturedAtSeconds !== null && Number.isSafeInteger(capturedAtSeconds)
        ? capturedAtSeconds
        : null,
    head,
  };
}

export interface RawDiffEntry {
  readonly path: string;
  readonly sourceMode: string;
  readonly sourceObject: string;
  /** Git status letter; "A" means the path did not exist in the source tree. */
  readonly status: string;
}

/** Parses `git diff --raw -z --no-renames --no-abbrev` output. */
export function parseRawDiff(stdout: string): RawDiffEntry[] {
  const fields = stdout.split("\0");
  const entries: RawDiffEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const meta = fields[index]!;
    const path = fields[index + 1]!;
    if (!meta.startsWith(":") || path.length === 0) continue;
    const [sourceMode, , sourceObject, , status] = meta.slice(1).split(" ");
    if (!sourceMode || !sourceObject || !status) continue;
    entries.push({ path, sourceMode, sourceObject, status: status.charAt(0) });
  }
  return entries;
}

/** Parses `git diff --name-only -z` output. */
export function parseNameOnlyPaths(stdout: string): Set<string> {
  return new Set(stdout.split("\0").filter((entry) => entry.length > 0));
}

/**
 * Splits repeated argument groups into commands that stay well under the
 * Windows command-line limit (32,767 characters) regardless of path count.
 */
export function chunkArgumentGroups(
  groups: ReadonlyArray<ReadonlyArray<string>>,
  maxCharacters = 8_000,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const group of groups) {
    const groupLength = group.reduce((total, arg) => total + arg.length + 3, 0);
    if (current.length > 0 && length + groupLength > maxCharacters) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(...group);
    length += groupLength;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
