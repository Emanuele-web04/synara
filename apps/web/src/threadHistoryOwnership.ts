import type { OrchestrationThreadHistory } from "@synara/contracts";

// These ephemeral owners never enter contracts or durable storage. A live
// count change shares its window owner; a snapshot/correction owns a new one.
// Weak keys release the owner when its immutable store state is collected.
const owners = new WeakMap<OrchestrationThreadHistory, symbol>();
export function getThreadHistoryOwner(history: OrchestrationThreadHistory | undefined) {
  if (!history) return null;
  let owner = owners.get(history);
  if (!owner) {
    owner = Symbol();
    owners.set(history, owner);
  }
  return owner;
}
export function updateThreadHistoryLiveCount(
  history: OrchestrationThreadHistory,
  totalMessageCount: number,
): OrchestrationThreadHistory {
  const next = { ...history, totalMessageCount };
  return inheritThreadHistoryOwner(next, history);
}
export function inheritThreadHistoryOwner(
  next: OrchestrationThreadHistory,
  previous: OrchestrationThreadHistory,
): OrchestrationThreadHistory {
  owners.set(next, getThreadHistoryOwner(previous)!);
  return next;
}
