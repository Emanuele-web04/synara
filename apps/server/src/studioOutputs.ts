// FILE: studioOutputs.ts
// Purpose: List the most recently modified files under the Studio Outbox so the web app can
//          surface "what Studio produced" next to the chats.
// Layer: Server workspace helper
// Exports: rankStudioOutputEntries (pure, tested) + listRecentStudioOutputs (Effect I/O).

import type { StudioOutputEntry } from "@t3tools/contracts";
import { Effect, FileSystem, Path } from "effect";

export const DEFAULT_STUDIO_RECENT_OUTPUTS_LIMIT = 20;

// Safety cap on how many directory entries a single request will stat. An Outbox is a
// personal folder (tens of files), so hitting this means something is wrong with the tree;
// we rank whatever was scanned instead of stalling the request.
export const MAX_SCANNED_OUTBOX_ENTRIES = 2_000;

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

  const relativePaths = yield* fileSystem
    .readDirectory(input.outboxRoot, { recursive: true })
    .pipe(Effect.catch(() => Effect.succeed([] as string[])));

  const candidates: StudioOutputCandidate[] = [];
  for (const rawRelativePath of relativePaths.slice(0, MAX_SCANNED_OUTBOX_ENTRIES)) {
    const fullPath = path.join(input.outboxRoot, rawRelativePath);
    const info = yield* fileSystem.stat(fullPath).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!info || info.type !== "File") {
      continue;
    }
    candidates.push({
      name: path.basename(rawRelativePath),
      // Contract paths always use "/" so hidden-file filtering and the web's subfolder
      // labels behave the same on Windows (readDirectory returns "\"-separated paths there).
      relativePath: rawRelativePath.split(path.sep).join("/"),
      fullPath,
      modifiedAtMs: info.mtime?.getTime() ?? 0,
    });
  }

  return {
    outboxRoot: input.outboxRoot,
    entries: rankStudioOutputEntries(candidates, limit),
  };
});
