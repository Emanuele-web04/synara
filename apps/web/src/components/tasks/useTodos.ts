// FILE: useTodos.ts
// Purpose: React Query access to the Tasks view's to-dos — the cached list, optimistic
//          create/update/delete mutations, the live event subscription, and the rows
//          joined with each linked chat's live status.
// Layer: Tasks UI hooks
// Exports: useTodoList, useTodoMutations, useTodoEventSubscription, useTaskRows

import type {
  Todo,
  TodoCreateInput,
  TodoId,
  TodoListResult,
  TodoUpdateInput,
} from "@synara/contracts";
import { applyTodoPatch } from "@synara/shared/todo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { ensureNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { isTasksRefusal, noteTasksRefusal } from "../../tasksSurface";
import { isRequestOutcomeUnknown } from "~/lib/requestOutcome";
import { toastManager } from "../ui/toast";
import {
  applyTodoEvent,
  deriveTaskStatus,
  EMPTY_TODO_LIST,
  isTaskNeedingAttention,
  markTodoDeleted,
  type TaskRowModel,
  todoQueryKey,
  unmarkTodoDeleted,
  upsertTodo,
} from "./tasks.logic";

// Seeds an optimistic create, so the server's authoritative row always replaces it.
const UNSAVED_UPDATED_AT = "1970-01-01T00:00:00.000Z";

// Creates still on their way to the server, retries included. An update or delete of the
// same to-do waits for the whole create, so the server sees them in the order the user
// made them (a retried insert after a delete would bring the to-do back).
const pendingCreateById = new Map<TodoId, { settled: Promise<void>; settle: () => void }>();
const afterPendingCreate = (id: TodoId) => pendingCreateById.get(id)?.settled;
const beginPendingCreate = (id: TodoId) => {
  const entry = { settled: Promise.resolve(), settle: () => {} };
  entry.settled = new Promise<void>((resolve) => {
    entry.settle = resolve;
  });
  pendingCreateById.set(id, entry);
};
const endPendingCreate = (id: TodoId) => {
  pendingCreateById.get(id)?.settle();
  pendingCreateById.delete(id);
};
// Creates the server rejected: such a row never existed there, so a failed delete of it
// must not bring it back.
const failedCreateIds = new Set<TodoId>();
// Edits queued behind a create. Their reply carries the whole stored row, so the create's
// own reply (which predates them) must not overwrite the optimistic edits meanwhile.
const pendingUpdateCountById = new Map<TodoId, number>();
const trackPendingUpdate = (id: TodoId, delta: 1 | -1) => {
  const count = (pendingUpdateCountById.get(id) ?? 0) + delta;
  if (count > 0) pendingUpdateCountById.set(id, count);
  else pendingUpdateCountById.delete(id);
};

/** `enabled` is false where Tasks is a Beta-only feature, so Stable never asks the server. */
export function useTodoList(enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: todoQueryKey,
    // Merged like a stream snapshot, so a refetch can't undo newer live copies or bring
    // back a to-do that was just deleted.
    queryFn: async () => {
      try {
        const { todos } = await ensureNativeApi().todo.list();
        return applyTodoEvent(queryClient.getQueryData<TodoListResult>(todoQueryKey), {
          type: "snapshot",
          todos,
        });
      } catch (error) {
        // A server without Tasks (Stable, reached from a browser) turns Kanban back on.
        noteTasksRefusal(error);
        throw error;
      }
    },
    retry: (failureCount, error) => !isTasksRefusal(error) && failureCount < 3,
    enabled,
  });
  return {
    todos: (query.data ?? EMPTY_TODO_LIST).todos,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

/** Keeps the shared ["todos"] cache live. Mount once, where the app shell lives. */
export function useTodoEventSubscription(enabled = true) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const api = ensureNativeApi();
    return api.todo.onEvent((event) => {
      queryClient.setQueryData<TodoListResult>(todoQueryKey, (prev) => applyTodoEvent(prev, event));
    });
  }, [enabled, queryClient]);
}

function showMutationError(title: string) {
  return (error: Error) => {
    if (noteTasksRefusal(error)) return;
    toastManager.add({ type: "error", title, description: error.message });
  };
}

export function useTodoMutations() {
  const queryClient = useQueryClient();
  const setList = (update: (todos: readonly Todo[]) => Todo[]) =>
    queryClient.setQueryData<TodoListResult>(todoQueryKey, (prev) => ({
      todos: update((prev ?? EMPTY_TODO_LIST).todos),
    }));
  const readTodo = (id: TodoId) =>
    queryClient.getQueryData<TodoListResult>(todoQueryKey)?.todos.find((todo) => todo.id === id);
  // An in-flight list fetch would land after the optimistic write and replace it.
  const cancelListFetch = () => queryClient.cancelQueries({ queryKey: todoQueryKey });

  const createMutation = useMutation({
    // Creates are idempotent per id, so one that died with the connection is retried with
    // the same id instead of dropping a row the server may already hold.
    retry: (failureCount, error) => isRequestOutcomeUnknown(error) && failureCount < 3,
    retryDelay: (attempt) => 1_000 * 2 ** attempt,
    mutationFn: (input: TodoCreateInput) => ensureNativeApi().todo.create(input),
    onMutate: async (input) => {
      beginPendingCreate(input.id);
      await cancelListFetch();
      const now = new Date().toISOString();
      // Seeded with the epoch so the server's authoritative row always replaces it.
      const optimistic: Todo = {
        id: input.id,
        title: input.title,
        notes: input.notes ?? "",
        priority: input.priority ?? "none",
        projectId: input.projectId ?? null,
        dueDate: input.dueDate ?? null,
        threadId: null,
        delegationBaseTurnId: null,
        completedAt: null,
        createdAt: now,
        updatedAt: UNSAVED_UPDATED_AT,
      };
      setList((todos) => upsertTodo(todos, optimistic));
    },
    onSuccess: (todo) => {
      if (pendingUpdateCountById.has(todo.id)) return;
      setList((todos) => upsertTodo(todos, todo));
    },
    onError: (error, input) => {
      failedCreateIds.add(input.id);
      setList((todos) => todos.filter((todo) => todo.id !== input.id));
      // If a lost reply hid a stored create, the server's list brings the row back.
      if (isRequestOutcomeUnknown(error)) {
        void queryClient.invalidateQueries({ queryKey: todoQueryKey });
      }
      showMutationError("Couldn't add the task")(error);
    },
    onSettled: (_todo, _error, input) => endPendingCreate(input.id),
  });

  const updateMutation = useMutation({
    mutationFn: async (input: TodoUpdateInput) => {
      await afterPendingCreate(input.id);
      return ensureNativeApi().todo.update(input);
    },
    onMutate: async (input) => {
      trackPendingUpdate(input.id, 1);
      await cancelListFetch();
      const previous = readTodo(input.id);
      if (previous) {
        // Keep the stored updatedAt: the server's reply is newer and replaces this copy.
        const optimistic = applyTodoPatch(previous, input, previous.updatedAt);
        setList((todos) => todos.map((todo) => (todo.id === input.id ? optimistic : todo)));
      }
      return { previous };
    },
    onSuccess: (todo) => setList((todos) => upsertTodo(todos, todo)),
    onError: (error, input, context) => {
      // The edit may have been stored before the connection went: keep it showing and
      // let the server's copy settle it, instead of rolling back and reporting a failure.
      // (Linking a chat re-reads the to-do in this case before deciding.)
      if (isRequestOutcomeUnknown(error)) {
        void queryClient.invalidateQueries({ queryKey: todoQueryKey });
        return;
      }
      const previous = context?.previous;
      if (previous) {
        // Optimistic copies keep the stored updatedAt, so a changed one means the server
        // sent something newer meanwhile; that copy wins over the rollback.
        setList((todos) =>
          todos.map((todo) =>
            todo.id === input.id && todo.updatedAt === previous.updatedAt ? previous : todo,
          ),
        );
      }
      // Overlapping edits share one updatedAt, so the rollback alone can't tell whose
      // change is showing; the server's copy settles it.
      void queryClient.invalidateQueries({ queryKey: todoQueryKey });
      showMutationError("Couldn't update the task")(error);
    },
    onSettled: (_todo, _error, input) => trackPendingUpdate(input.id, -1),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: TodoId) => {
      await afterPendingCreate(id);
      return ensureNativeApi().todo.delete({ id });
    },
    onMutate: async (id) => {
      await cancelListFetch();
      const previous = readTodo(id);
      // Marked now, so an update reply that lands before the delete can't re-add it.
      markTodoDeleted(id);
      setList((todos) => todos.filter((todo) => todo.id !== id));
      return { previous };
    },
    onError: (error, id, context) => {
      unmarkTodoDeleted(id);
      const previous = context?.previous;
      // Restore unless its create failed. A created row can still carry the optimistic
      // stamp (the delete mark blocked the create's reply); any newer copy replaces it.
      if (previous && !failedCreateIds.has(id)) {
        setList((todos) => upsertTodo(todos, previous));
      }
      void queryClient.invalidateQueries({ queryKey: todoQueryKey });
      showMutationError("Couldn't delete the task")(error);
    },
  });

  return {
    createTodo: createMutation.mutate,
    updateTodo: updateMutation.mutate,
    /** Resolves once the server stored the patch; rejects (after the toast) on failure. */
    updateTodoAsync: updateMutation.mutateAsync,
    deleteTodo: deleteMutation.mutate,
  };
}

/** Every to-do joined with its linked chat and the status that chat implies. */
export function useTaskRows(todos: readonly Todo[]): TaskRowModel[] {
  const threadSummaryById = useStore((state) => state.sidebarThreadSummaryById);
  const threadsHydrated = useStore((state) => state.threadsHydrated);
  const draftThreadsByThreadId = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  return useMemo(
    () =>
      todos.map((todo) => {
        const thread = todo.threadId ? (threadSummaryById[todo.threadId] ?? null) : null;
        const hasDraftThread =
          todo.threadId !== null && draftThreadsByThreadId[todo.threadId] !== undefined;
        return {
          todo,
          thread,
          status: deriveTaskStatus({ todo, thread, hasDraftThread, threadsHydrated }),
        };
      }),
    [draftThreadsByThreadId, threadSummaryById, threadsHydrated, todos],
  );
}

/** How many to-dos sit in "Needs you" — the Tasks nav badge. */
export function useTasksNeedingAttentionCount(enabled = true): number {
  const { todos } = useTodoList(enabled);
  const rows = useTaskRows(todos);
  return rows.filter((row) => isTaskNeedingAttention(row.status)).length;
}
