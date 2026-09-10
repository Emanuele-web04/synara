import type { ThreadId } from "@synara/contracts";

type TerminalRuntimeCleanup = (activeThreadIds: ReadonlySet<string>) => void;
let cleanupRuntimes: TerminalRuntimeCleanup | undefined;

// The lazy terminal module registers its cleanup here, so snapshot/lifecycle
// reconciliation can dispose loaded xterms without eagerly importing them.
export function registerTerminalRuntimeCleanup(cleanup: TerminalRuntimeCleanup): () => void {
  cleanupRuntimes = cleanup;
  return () => {
    if (cleanupRuntimes === cleanup) cleanupRuntimes = undefined;
  };
}

export function removeOrphanedTerminalRuntimes(activeThreadIds: ReadonlySet<string>): void {
  cleanupRuntimes?.(activeThreadIds);
}

interface TerminalRetentionThread {
  id: ThreadId;
  deletedAt: string | null;
  archivedAt: string | null;
}

interface CollectActiveTerminalThreadIdsInput {
  snapshotThreads: readonly TerminalRetentionThread[];
  draftThreadIds: Iterable<ThreadId>;
  retainedThreadIds?: Iterable<ThreadId>;
}

export function collectActiveTerminalThreadIds(
  input: CollectActiveTerminalThreadIdsInput,
): Set<ThreadId> {
  const activeThreadIds = new Set<ThreadId>();
  const snapshotThreadById = new Map(input.snapshotThreads.map((thread) => [thread.id, thread]));
  for (const thread of input.snapshotThreads) {
    if (thread.deletedAt !== null) continue;
    if (thread.archivedAt !== null) continue;
    activeThreadIds.add(thread.id);
  }
  for (const draftThreadId of input.draftThreadIds) {
    const snapshotThread = snapshotThreadById.get(draftThreadId);
    if (
      snapshotThread &&
      (snapshotThread.deletedAt !== null || snapshotThread.archivedAt !== null)
    ) {
      continue;
    }
    activeThreadIds.add(draftThreadId);
  }
  for (const retainedThreadId of input.retainedThreadIds ?? []) {
    activeThreadIds.add(retainedThreadId);
  }
  return activeThreadIds;
}
