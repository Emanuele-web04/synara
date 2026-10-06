import { isToolLifecycleItemType, type ProviderRuntimeEvent } from "@synara/contracts";

export const PROVIDER_RUNTIME_PROGRESS_WINDOW_MS = 50;

/** Only replaceable snapshots qualify; deltas and lifecycle transitions are boundaries. */
export function providerRuntimeProgressKey(event: ProviderRuntimeEvent): string | undefined {
  let identity: string | undefined;
  switch (event.type) {
    case "task.progress":
      identity = event.payload.taskId;
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
 * Preserve source order and all boundaries, retaining the newest snapshot for
 * each identity within a contiguous progress run. State is bounded by the
 * caller's durable journal page, never by the lifetime of a provider session.
 */
export function coalesceProviderRuntimeProgress<A extends { readonly event: ProviderRuntimeEvent }>(
  page: ReadonlyArray<A>,
): ReadonlyArray<A> {
  const retained: A[] = [];
  let run: Array<{ readonly row: A; readonly key: string }> = [];
  const latest = new Map<string, A>();
  const flush = () => {
    for (const { row, key } of run) {
      if (latest.get(key) === row) retained.push(row);
    }
    run = [];
    latest.clear();
  };
  for (const row of page) {
    const key = providerRuntimeProgressKey(row.event);
    if (key === undefined) {
      flush();
      retained.push(row);
    } else {
      run.push({ row, key });
      latest.set(key, row);
    }
  }
  flush();
  return retained;
}
