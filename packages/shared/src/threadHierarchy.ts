interface HierarchyThread {
  readonly id: string;
  readonly parentThreadId?: string | null | undefined;
}

// subagent threads are only reachable through their parent — lifecycle changes apply to the whole subtree; visited tracking keeps corrupted cyclic linkage from hanging the caller
export function collectSubagentDescendants<T extends HierarchyThread>(
  threads: readonly T[],
  rootThreadId: T["id"],
): T[] {
  const childrenByParentId = new Map<string, T[]>();
  for (const thread of threads) {
    const parentThreadId = thread.parentThreadId ?? null;
    if (parentThreadId === null) {
      continue;
    }
    const siblings = childrenByParentId.get(parentThreadId);
    if (siblings === undefined) {
      childrenByParentId.set(parentThreadId, [thread]);
    } else {
      siblings.push(thread);
    }
  }

  const descendants: T[] = [];
  const visitedThreadIds = new Set<string>([rootThreadId]);
  const queue: string[] = [rootThreadId];
  for (let index = 0; index < queue.length; index += 1) {
    const parentThreadId = queue[index];
    if (parentThreadId === undefined) {
      break;
    }
    for (const child of childrenByParentId.get(parentThreadId) ?? []) {
      if (visitedThreadIds.has(child.id)) {
        continue;
      }
      visitedThreadIds.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return descendants;
}
