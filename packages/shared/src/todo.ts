// FILE: todo.ts
// Purpose: Patch semantics for Tasks-view to-dos, shared by the server (authoritative
//          write) and the web client (optimistic update) so both apply edits identically.
// Exports: applyTodoPatch

import type { Todo, TodoUpdateInput } from "@synara/contracts";

/**
 * Applies a partial update. `completed` stamps completedAt once (re-completing keeps
 * the original instant) and clears it on reopen; `updatedAt` is the caller's.
 */
export function applyTodoPatch(todo: Todo, patch: TodoUpdateInput, updatedAt: string): Todo {
  const completedAt =
    patch.completed === undefined
      ? todo.completedAt
      : patch.completed
        ? (todo.completedAt ?? updatedAt)
        : null;
  return {
    ...todo,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
    ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
    ...(patch.threadId !== undefined ? { threadId: patch.threadId } : {}),
    ...(patch.threadId !== undefined && patch.threadId !== todo.threadId
      ? { linkedAt: patch.threadId === null ? null : updatedAt }
      : {}),
    // A new link without its own base turn has none: the old one described another chat.
    ...(patch.delegationBaseTurnId !== undefined
      ? { delegationBaseTurnId: patch.delegationBaseTurnId }
      : patch.threadId !== undefined && patch.threadId !== todo.threadId
        ? { delegationBaseTurnId: null }
        : {}),
    completedAt,
    updatedAt,
  };
}
