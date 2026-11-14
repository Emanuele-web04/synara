// FILE: historyIntegration.ts
// Purpose: Pure helpers that separate a turn's own edits from history it only checked out.
// Layer: Checkpointing utilities.
// Exports: checkpoint HEAD trailer helpers and `git diff -z` parsers used by CheckpointStore.

import { createHash } from "node:crypto";

/** Checkpoints record the HEAD and its reflog anchor at capture time. */
export const CHECKPOINT_HEAD_TRAILER = "Synara-Head";
const CHECKPOINT_REFLOG_TRAILER = "Synara-Head-Reflog";
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REFLOG_ANCHOR = /^[0-9a-f]{64}$/;

export function formatCheckpointHeadTrailer(headCommit: string, reflogEntry?: string): string {
  const head = `${CHECKPOINT_HEAD_TRAILER}: ${headCommit}`;
  return reflogEntry === undefined
    ? head
    : `${head}\n${CHECKPOINT_REFLOG_TRAILER}: ${checkpointReflogAnchor(reflogEntry)}`;
}

export function checkpointReflogAnchor(entry: string): string {
  return createHash("sha256").update(entry, "utf8").digest("hex");
}

export interface CheckpointCommitMetadata {
  /** HEAD at capture time; null for legacy checkpoints and unborn branches. */
  readonly head: string | null;
  readonly reflogAnchor?: string;
}

/** Reads the HEAD and reflog anchor from the checkpoint commit message. */
export function parseCheckpointCommit(raw: string): CheckpointCommitMetadata {
  const separator = raw.indexOf("\n\n");
  const message = separator === -1 ? "" : raw.slice(separator + 2);
  let head: string | null = null;
  let reflogAnchor: string | undefined;
  for (const line of message.split("\n")) {
    const headPrefix = `${CHECKPOINT_HEAD_TRAILER}: `;
    const reflogPrefix = `${CHECKPOINT_REFLOG_TRAILER}: `;
    if (line.startsWith(headPrefix)) {
      const value = line.slice(headPrefix.length).trim();
      head = OBJECT_ID.test(value) ? value : null;
    } else if (line.startsWith(reflogPrefix)) {
      const value = line.slice(reflogPrefix.length).trim();
      reflogAnchor = REFLOG_ANCHOR.test(value) ? value : undefined;
    }
  }
  return reflogAnchor === undefined ? { head } : { head, reflogAnchor };
}

/** A reflog operation attesting how existing history entered the working branch. */
export interface IntegratedHistoryTip {
  readonly commit: string;
  readonly kind: "direct" | "incoming";
}

interface HeadReflogEntry {
  readonly head: string;
  readonly action: string;
  readonly anchor: string;
}

/** Reject incomplete or ambiguous slices instead of treating dates as provenance. */
export function checkpointHeadTransitions(
  raw: string,
  from: CheckpointCommitMetadata,
  to: CheckpointCommitMetadata,
): HeadReflogEntry[] | null {
  if (!from.reflogAnchor || !to.reflogAnchor || !from.head || !to.head) return null;
  const entries: HeadReflogEntry[] = [];
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const match = /^([0-9a-f]+)\tHEAD@\{[0-9]+ [+-][0-9]{4}\}\t(.*)$/.exec(record);
    if (!match?.[1] || !OBJECT_ID.test(match[1]) || match[2] === undefined) return null;
    entries.push({ head: match[1], action: match[2], anchor: checkpointReflogAnchor(record) });
  }
  const starts = entries.filter(
    (entry) => entry.head === from.head && entry.anchor === from.reflogAnchor,
  );
  const ends = entries.filter(
    (entry) => entry.head === to.head && entry.anchor === to.reflogAnchor,
  );
  if (starts.length !== 1 || ends.length !== 1) return null;
  const start = entries.indexOf(starts[0]!);
  const end = entries.indexOf(ends[0]!);
  return start > end ? entries.slice(end, start + 1).toReversed() : null;
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
