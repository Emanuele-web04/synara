import type { HubWorkItem, MessageId, ThreadId } from "@synara/contracts";

export function mergeHubWorkItems(
  current: readonly HubWorkItem[],
  incoming: readonly HubWorkItem[],
): readonly HubWorkItem[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    const previous = byId.get(item.id);
    if (!previous || item.revision > previous.revision) byId.set(item.id, item);
  }
  return [...byId.values()];
}

export function hubWorkItemsBySourceMessage(
  items: readonly HubWorkItem[],
  threadId: ThreadId | undefined,
): ReadonlyMap<MessageId, readonly HubWorkItem[]> {
  const byMessage = new Map<MessageId, HubWorkItem[]>();
  for (const item of items) {
    if (item.sourceThreadId !== threadId || item.sourceMessageId === null) continue;
    const siblings = byMessage.get(item.sourceMessageId) ?? [];
    siblings.push(item);
    byMessage.set(item.sourceMessageId, siblings);
  }
  return byMessage;
}
