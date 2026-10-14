// FILE: threadGoalMaterialization.ts
// Purpose: Codex-style large-goal handling. A goal longer than the inline
//   threshold would blow up every provider turn (the persisted goal is injected
//   into each prompt), so the full text is materialized to a per-thread file and
//   the stored goal becomes a short "read this file" reference that stays
//   resolvable on every subsequent turn.
// Layer: Orchestration command normalization
// Depends on: contracts thresholds, private path permission helpers.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { THREAD_GOAL_INLINE_MAX_CHARS } from "@synara/contracts";

import { ensurePrivateDirectorySync, repairPrivateFile } from "../privatePathPermissions";

export function isOversizedThreadGoal(goal: string | undefined): goal is string {
  return typeof goal === "string" && goal.length > THREAD_GOAL_INLINE_MAX_CHARS;
}

// IDs are case-sensitive arbitrary contract strings, while Windows and common
// macOS volumes fold filename case. Hash every ID into a bounded lowercase
// segment, including already-clean IDs, so encoded and literal IDs cannot alias.
const safePathSegment = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * One immutable file per accepted-update candidate. A shared `goal.md` would
 * let a rejected or stale `thread.meta.update` overwrite the file a still-live
 * "read this file" reference points at; keying by commandId keeps each write
 * isolated — the reference is only published when the command commits.
 */
export function threadGoalFileName(commandId: string): string {
  return `goal-${safePathSegment(commandId)}.md`;
}

function threadGoalFilePath(stateDir: string, threadId: string, commandId: string): string {
  return path.join(threadGoalDirPath(stateDir, threadId), threadGoalFileName(commandId));
}

function threadGoalDirPath(stateDir: string, threadId: string): string {
  return path.join(stateDir, "thread-goals", safePathSegment(threadId));
}

const THREAD_GOAL_FILE_REF_PREFIX = "Read this file: ";

/** The persisted goal text once the full objective lives on disk. */
export function threadGoalFileReference(filePath: string): string {
  return `${THREAD_GOAL_FILE_REF_PREFIX}${filePath}`;
}

/**
 * Writes the oversized goal to `<stateDir>/thread-goals/<threadId>/goal-<commandId>.md`
 * and returns the path to embed in the stored goal.
 */
export async function materializeThreadGoalFile(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly commandId: string;
  readonly goal: string;
}): Promise<string> {
  const filePath = threadGoalFilePath(input.stateDir, input.threadId, input.commandId);
  ensurePrivateDirectorySync(path.dirname(filePath));
  await fs.writeFile(filePath, input.goal, "utf8");
  await repairPrivateFile(filePath);
  return filePath;
}

/**
 * Best-effort removal of a thread's materialized goal files. Called after a
 * command commits: when the thread is deleted or its goal moved back inline
 * (cleared, achieved, or set under the threshold), drops the whole directory;
 * when a new oversized goal just landed, keeps `keepFileName` and removes the
 * rest (superseded refs and files orphaned by rejected updates).
 */
export async function pruneThreadGoalFiles(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly keepFileName?: string | undefined;
}): Promise<void> {
  const dirPath = threadGoalDirPath(input.stateDir, input.threadId);
  if (input.keepFileName === undefined) {
    await fs.rm(dirPath, { recursive: true, force: true });
    return;
  }
  const entries = await fs.readdir(dirPath).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((entry) => entry !== input.keepFileName)
      .map((entry) => fs.rm(path.join(dirPath, entry), { recursive: true, force: true })),
  );
}

/**
 * Deletes one materialized candidate file. A `thread.meta.update` writes the
 * file before its invariants run, so every rejected/failed/interrupted command
 * must drop its candidate — otherwise each refusal leaves up to the payload
 * bound on disk forever. Best-effort; a survivor is swept by the next commit's
 * prune.
 */
export async function discardMaterializedThreadGoalFile(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true }).catch(() => undefined);
}

/**
 * Recognizes the filename of a persisted goal reference owned by this thread,
 * or returns null when the goal is not such a reference.
 * The path must resolve inside this thread's own goal
 * directory — anything else is an ordinary goal string that happens to start
 * with the prefix, not a ref we wrote.
 */
export function threadGoalFileNameFromReference(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly goal: string;
}): string | null {
  if (!input.goal.startsWith(THREAD_GOAL_FILE_REF_PREFIX)) {
    return null;
  }
  const refPath = input.goal.slice(THREAD_GOAL_FILE_REF_PREFIX.length).trim();
  const goalDir = threadGoalDirPath(input.stateDir, input.threadId);
  const resolved = path.resolve(refPath);
  const name = path.basename(resolved);
  return path.dirname(resolved) === path.resolve(goalDir) && /^goal-[a-zA-Z0-9_-]+\.md$/.test(name)
    ? name
    : null;
}

export async function readMaterializedThreadGoalText(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly goal: string;
}): Promise<string | null> {
  const name = threadGoalFileNameFromReference(input);
  return name === null
    ? null
    : fs
        .readFile(path.join(threadGoalDirPath(input.stateDir, input.threadId), name), "utf8")
        .catch(() => null);
}
