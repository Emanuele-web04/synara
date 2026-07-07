// FILE: studioOutputs.ts
// Purpose: List the most recently modified files under the Studio Outbox so the web app can
//          surface "what Studio produced" next to the chats.
// Layer: Server workspace helper
// Exports: rankStudioOutputEntries (pure, tested) + listRecentStudioOutputs (Effect I/O).

import type { StudioOutputEntry } from "@t3tools/contracts";
import { Effect, FileSystem, Path } from "effect";

export const DEFAULT_STUDIO_RECENT_OUTPUTS_LIMIT = 20;

// Hard ceiling on how many directory entries a single request will ever enumerate AND stat —
// the iterative walk below stops descending once it is reached, so a pathological Outbox (an
// accidental symlink loop, a setting pointed at a huge unrelated directory) cannot make the
// 30s poll list an unbounded tree. An Outbox is a personal folder (tens to low thousands of
// files), so this is deliberately far above any realistic size: below the cap, every entry is
// statted and ranked by mtime before the result is truncated to `limit`, so a recently
// modified file is never dropped by walk order. Hitting the cap is logged, never silent.
export const MAX_SCANNED_OUTBOX_ENTRIES = 50_000;

// How many `stat` calls run concurrently while scanning the Outbox. Bounded so a very large
// tree doesn't open thousands of file descriptors at once, while still avoiding the cost of
// a fully sequential scan on every 30s poll.
export const STAT_CONCURRENCY = 16;

export interface StudioOutputCandidate {
  readonly name: string;
  readonly relativePath: string;
  readonly fullPath: string;
  readonly modifiedAtMs: number;
}

/** Drop hidden files (e.g. .DS_Store) anywhere in the relative path. */
function isHiddenPath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.startsWith("."));
}

export function rankStudioOutputEntries(
  candidates: readonly StudioOutputCandidate[],
  limit: number,
): StudioOutputEntry[] {
  return candidates
    .filter((candidate) => !isHiddenPath(candidate.relativePath))
    .toSorted((left, right) => right.modifiedAtMs - left.modifiedAtMs)
    .slice(0, limit)
    .map((candidate) => ({
      name: candidate.name,
      relativePath: candidate.relativePath,
      fullPath: candidate.fullPath,
      modifiedAt: new Date(candidate.modifiedAtMs).toISOString(),
    }));
}

/**
 * Walks the Outbox tree and returns the most recently modified files. A missing Outbox
 * (not scaffolded yet) or unreadable entries degrade to an empty/partial list rather than
 * failing the whole request.
 */
export const listRecentStudioOutputs = Effect.fnUntraced(function* (input: {
  readonly outboxRoot: string;
  readonly limit?: number | undefined;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const limit = input.limit ?? DEFAULT_STUDIO_RECENT_OUTPUTS_LIMIT;

  // Iterative breadth-first walk so the safety cap bounds the WALK itself, not just the stat
  // phase: a pathological subtree stops being enumerated once the cap is reached instead of
  // being fully listed by a recursive readDirectory first. Every scanned entry is statted with
  // bounded concurrency, and hidden directories (dot-prefixed) are skipped up front — their
  // contents would be filtered out by rankStudioOutputEntries anyway, so descending into them
  // (e.g. an accidental .git tree) would only burn the cap.
  const candidates: StudioOutputCandidate[] = [];
  let scannedEntryCount = 0;
  let scanWasTruncated = false;
  let pendingDirectories: string[] = [""];

  while (pendingDirectories.length > 0 && !scanWasTruncated) {
    const directoryBatch = pendingDirectories;
    pendingDirectories = [];

    const listings = yield* Effect.forEach(
      directoryBatch,
      (relativeDirectory) =>
        fileSystem.readDirectory(path.join(input.outboxRoot, relativeDirectory)).pipe(
          Effect.map((names) => ({ relativeDirectory, names })),
          Effect.catch(() => Effect.succeed({ relativeDirectory, names: [] as string[] })),
        ),
      { concurrency: STAT_CONCURRENCY },
    );

    const batchEntries: Array<{ rawRelativePath: string; fullPath: string }> = [];
    for (const listing of listings) {
      for (const name of listing.names) {
        if (name.startsWith(".")) {
          continue;
        }
        if (scannedEntryCount >= MAX_SCANNED_OUTBOX_ENTRIES) {
          scanWasTruncated = true;
          break;
        }
        scannedEntryCount += 1;
        const rawRelativePath = listing.relativeDirectory
          ? path.join(listing.relativeDirectory, name)
          : name;
        batchEntries.push({
          rawRelativePath,
          fullPath: path.join(input.outboxRoot, rawRelativePath),
        });
      }
      if (scanWasTruncated) {
        break;
      }
    }

    const statResults = yield* Effect.forEach(
      batchEntries,
      (entry) =>
        fileSystem.stat(entry.fullPath).pipe(
          Effect.map((info) => ({ ...entry, info })),
          Effect.catch(() => Effect.succeed(null)),
        ),
      { concurrency: STAT_CONCURRENCY },
    );

    for (const result of statResults) {
      if (!result) {
        continue;
      }
      if (result.info.type === "Directory") {
        pendingDirectories.push(result.rawRelativePath);
        continue;
      }
      if (result.info.type !== "File") {
        continue;
      }
      candidates.push({
        name: path.basename(result.rawRelativePath),
        // Contract paths always use "/" so hidden-file filtering and the web's subfolder
        // labels behave the same on Windows (path.join uses "\" there).
        relativePath: result.rawRelativePath.split(path.sep).join("/"),
        fullPath: result.fullPath,
        modifiedAtMs: result.info.mtime?.getTime() ?? 0,
      });
    }
  }

  if (scanWasTruncated) {
    yield* Effect.logWarning(
      "Studio Outbox scan hit the safety cap; some recently modified files may be omitted",
      {
        outboxRoot: input.outboxRoot,
        scannedEntryCount,
        maxScannedOutboxEntries: MAX_SCANNED_OUTBOX_ENTRIES,
      },
    );
  }

  return {
    outboxRoot: input.outboxRoot,
    entries: rankStudioOutputEntries(candidates, limit),
  };
});
