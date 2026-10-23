import { isToolLifecycleItemType, type ProviderRuntimeEvent } from "@synara/contracts";

export const PROVIDER_RUNTIME_PROGRESS_WINDOW_MS = 50;

/**
 * Only complete snapshots qualify: in-progress tool snapshots and the
 * cumulative turn diff (one per (thread, turn); Codex resends the whole diff on
 * every patch). task.progress can append workflow agent phases or
 * noncumulative reasoning sections, so it is always lossless.
 */
export function providerRuntimeProgressKey(event: ProviderRuntimeEvent): string | undefined {
  let identity: string | undefined;
  switch (event.type) {
    case "turn.diff.updated":
      identity = event.turnId;
      break;
    case "tool.progress":
      identity = event.payload.toolUseId;
      break;
    case "item.updated":
      if (
        event.payload.status !== "inProgress" ||
        !isToolLifecycleItemType(event.payload.itemType) ||
        event.payload.itemType === "collab_agent_tool_call"
      )
        return undefined;
      identity = event.itemId;
      break;
    default:
      return undefined;
  }
  if (!identity) return undefined;
  return JSON.stringify([
    event.provider,
    event.providerInstanceId ?? null,
    event.lifecycleGeneration ?? null,
    event.threadId,
    event.turnId ?? null,
    event.providerRefs?.providerThreadId ?? null,
    event.type,
    identity,
  ]);
}

/**
 * Events that settle a turn's live diff placeholder. Only these close a thread's
 * turn-diff run: the diff is a whole-turn snapshot that nothing else reads, so
 * the thread's text, tool and item events between two patches do not.
 */
function closesTurnDiffRun(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "session.exited" ||
    event.type === "runtime.error"
  );
}

/**
 * Within each thread's progress run, retain its newest snapshot per identity.
 * Other threads' text/terminals do not close that run. Turn diffs use a longer
 * run that only the thread's turn-settling events close (see closesTurnDiffRun).
 * Survivors remain in original global source order; callers still process and
 * ACK every raw row. State is bounded by the caller's journal page, not a
 * provider session.
 */
export function coalesceProviderRuntimeProgress<A extends { readonly event: ProviderRuntimeEvent }>(
  page: ReadonlyArray<A>,
): ReadonlyArray<A> {
  const retained = new Set<A>();
  const latestByThread = new Map<string, Map<string, A>>();
  const latestTurnDiffByThread = new Map<string, Map<string, A>>();
  for (const row of page) {
    const key = providerRuntimeProgressKey(row.event);
    if (row.event.type === "turn.diff.updated" && key !== undefined) {
      let latestDiff = latestTurnDiffByThread.get(row.event.threadId);
      if (latestDiff === undefined) {
        latestDiff = new Map();
        latestTurnDiffByThread.set(row.event.threadId, latestDiff);
      }
      const previous = latestDiff.get(key);
      if (previous !== undefined) retained.delete(previous);
      latestDiff.set(key, row);
      retained.add(row);
      continue;
    }
    if (closesTurnDiffRun(row.event)) latestTurnDiffByThread.get(row.event.threadId)?.clear();
    let latest = latestByThread.get(row.event.threadId);
    if (key === undefined) {
      latest?.clear();
    } else {
      if (latest === undefined) {
        latest = new Map();
        latestByThread.set(row.event.threadId, latest);
      }
      const previous = latest.get(key);
      if (previous !== undefined) retained.delete(previous);
      latest.set(key, row);
    }
    retained.add(row);
  }
  return page.filter((row) => retained.has(row));
}
