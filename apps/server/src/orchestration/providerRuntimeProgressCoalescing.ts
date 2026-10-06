import { isToolLifecycleItemType, type ProviderRuntimeEvent } from "@synara/contracts";

export const PROVIDER_RUNTIME_PROGRESS_WINDOW_MS = 50;

/**
 * Only complete tool snapshots qualify. task.progress can append workflow agent
 * phases or noncumulative reasoning sections, so it is always lossless.
 */
export function providerRuntimeProgressKey(event: ProviderRuntimeEvent): string | undefined {
  let identity: string | undefined;
  switch (event.type) {
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
 * Within each thread's progress run, retain its newest snapshot per identity.
 * Other threads' text/terminals do not close that run. Survivors remain in
 * original global source order; callers still process and ACK every raw row.
 * State is bounded by the caller's journal page, not a provider session.
 */
export function coalesceProviderRuntimeProgress<A extends { readonly event: ProviderRuntimeEvent }>(
  page: ReadonlyArray<A>,
): ReadonlyArray<A> {
  const retained = new Set<A>();
  const latestByThread = new Map<string, Map<string, A>>();
  for (const row of page) {
    const key = providerRuntimeProgressKey(row.event);
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
