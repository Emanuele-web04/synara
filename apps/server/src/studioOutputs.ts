// FILE: studioOutputs.ts
// Purpose: List the most recently modified files under the Studio Outbox so the web app can
//          surface "what Studio produced" next to the chats.
// Layer: Server workspace helper
// Exports: rankStudioOutputEntries (pure, tested) + listRecentStudioOutputs (Effect I/O).

import type { StudioOutputEntry } from "@t3tools/contracts";
import { Effect, FileSystem, Path } from "effect";

export const DEFAULT_STUDIO_RECENT_OUTPUTS_LIMIT = 20;

// Hard ceiling on how many directory entries a single request will ever stat. An Outbox is a
// personal folder (tens to low thousands of files), so this is deliberately far above any
// realistic tree size and exists only to bound work for a truly pathological Outbox (e.g. an
// accidental symlink loop or someone pointing the setting at an unrelated huge directory).
// Unlike a small cap, this must NOT be relied on to bound normal traffic: every listed entry is
// statted and ranked by mtime before the result is truncated to `limit`, so a recently modified
// file is never dropped just because of its position in the (mtime-unaware) directory walk order.
// If this cap is ever hit, it is logged so the truncation is explicit rather than silent.
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

  const allRelativePaths = yield* fileSystem
    .readDirectory(input.outboxRoot, { recursive: true })
    .pipe(Effect.catch(() => Effect.succeed([] as string[])));

  const scanWasTruncated = allRelativePaths.length > MAX_SCANNED_OUTBOX_ENTRIES;
  if (scanWasTruncated) {
    yield* Effect.logWarning(
      "Studio Outbox scan hit the safety cap; some recently modified files may be omitted",
      {
        outboxRoot: input.outboxRoot,
        entryCount: allRelativePaths.length,
        maxScannedOutboxEntries: MAX_SCANNED_OUTBOX_ENTRIES,
      },
    );
  }
  const relativePaths = scanWasTruncated
    ? allRelativePaths.slice(0, MAX_SCANNED_OUTBOX_ENTRIES)
    : allRelativePaths;

  // Stat every listed entry (bounded concurrency, not a sequential loop) so a 30s poll never
  // pays for thousands of serial round-trips. Every candidate is statted and ranked by mtime
  // below before the result is truncated to `limit`, so ranking is never biased by directory
  // walk order.
  const statResults = yield* Effect.forEach(
    relativePaths,
    (rawRelativePath) => {
      const fullPath = path.join(input.outboxRoot, rawRelativePath);
      return fileSystem.stat(fullPath).pipe(
        Effect.map((info) => ({ rawRelativePath, fullPath, info })),
        Effect.catch(() => Effect.succeed(null)),
      );
    },
    { concurrency: STAT_CONCURRENCY },
  );

  const candidates: StudioOutputCandidate[] = [];
  for (const result of statResults) {
    if (!result || result.info.type !== "File") {
      continue;
    }
    candidates.push({
      name: path.basename(result.rawRelativePath),
      // Contract paths always use "/" so hidden-file filtering and the web's subfolder
      // labels behave the same on Windows (readDirectory returns "\"-separated paths there).
      relativePath: result.rawRelativePath.split(path.sep).join("/"),
      fullPath: result.fullPath,
      modifiedAtMs: result.info.mtime?.getTime() ?? 0,
    });
  }

  return {
    outboxRoot: input.outboxRoot,
    entries: rankStudioOutputEntries(candidates, limit),
  };
});
