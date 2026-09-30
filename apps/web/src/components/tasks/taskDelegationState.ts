import type { ThreadId, Todo, TodoId } from "@synara/contracts";
import { create } from "zustand";

import { isTaskLinkSettling, type TaskStatusKind } from "./tasks.logic";

type DelegationState = { kind: "pending" } | { kind: "uncertain"; threadId: ThreadId };
// Local RPC ownership must outlive a card closing. Nothing here is persisted: other
// windows and reloads use the durable link's existing settle window instead.
const useDelegations = create<Record<string, DelegationState>>(() => ({}));

export function beginTaskDelegation(id: TodoId): boolean {
  if (useDelegations.getState()[id]?.kind === "pending") return false;
  useDelegations.setState({ [id]: { kind: "pending" } });
  return true;
}

export function finishTaskDelegation(id: TodoId, uncertainThread: ThreadId | null): void {
  useDelegations.setState((state) => {
    const next = { ...state };
    if (uncertainThread) next[id] = { kind: "uncertain", threadId: uncertainThread };
    else delete next[id];
    return next;
  }, true);
}

export function useTaskCanUnlink(
  todo: Pick<Todo, "id" | "threadId" | "linkedAt">,
  status: TaskStatusKind,
  now: Date,
): boolean {
  const delegation = useDelegations((state) => state[todo.id]);
  if (todo.threadId === null || delegation?.kind === "pending") return false;
  if (delegation?.kind === "uncertain" && delegation.threadId === todo.threadId) return true;
  return status !== "starting" || !isTaskLinkSettling(todo, now);
}
