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
import { useShallow } from "zustand/react/shallow";

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
  UNSAVED_TODO_UPDATED_AT,
  unmarkTodoDeleted,
  upsertTodo,
} from "./tasks.logic";

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
// A lost delete reply retains its tombstone until a list requested after that outcome
// confirms the row still exists. Entry identity prevents old requests/callbacks from
// settling a newer delete of the same ID; confirmed deletions keep their tombstones.
interface PendingDelete {
  uncertain: boolean;
}
const pendingDeletesById = new Map<TodoId, PendingDelete>();
// Edits still on their way to the server, oldest first. A reply carries the whole stored
// row as of that edit, so a create's reply, or an earlier edit's, must not drop the later
// optimistic edits: those are laid back over it until their own replies land. Earlier ones
// are already in it, or land after it with their own (newer) reply.
interface PendingUpdate {
  input: TodoUpdateInput;
  appliedAt: string;
}
const pendingUpdatesById = new Map<TodoId, PendingUpdate[]>();
const beginPendingUpdate = (input: TodoUpdateInput): PendingUpdate => {
  const pending = { input, appliedAt: new Date().toISOString() };
  pendingUpdatesById.set(input.id, [...(pendingUpdatesById.get(input.id) ?? []), pending]);
  return pending;
};
// Local action timestamps (linkedAt/completedAt) use the action's own time, while the
// server revision stays unchanged so authoritative replies can still replace the row.
const applyPendingUpdate = (todo: Todo, pending: PendingUpdate): Todo => ({
  ...applyTodoPatch(todo, pending.input, pending.appliedAt),
  updatedAt: todo.updatedAt,
});
const endPendingUpdate = (input: TodoUpdateInput) => {
  const rest = (pendingUpdatesById.get(input.id) ?? []).filter(
    (pending) => pending.input !== input,
  );
  if (rest.length > 0) pendingUpdatesById.set(input.id, rest);
  else pendingUpdatesById.delete(input.id);
};
/** `todo` with the edits queued after `settled`, still in flight, applied over it. */
const withLaterPendingUpdates = (todo: Todo, settled: TodoUpdateInput): Todo => {
  const pending = pendingUpdatesById.get(todo.id) ?? [];
  return pending
    .slice(pending.findIndex((entry) => entry.input === settled) + 1)
    .reduce(applyPendingUpdate, todo);
};

/** Keep only pending edited fields over server events; unrelated remote changes stay live. */
function applyTodoEventHoldingEdits(
  prev: TodoListResult | undefined,
  event: Parameters<typeof applyTodoEvent>[1],
): TodoListResult {
  if (event.type === "todo-deleted") pendingDeletesById.delete(event.todoId);
  const next = applyTodoEvent(prev, event);
  if (pendingUpdatesById.size === 0) return next;
  return {
    todos: next.todos.map((todo) =>
      (pendingUpdatesById.get(todo.id) ?? []).reduce(applyPendingUpdate, todo),
    ),
  };
}

/** `enabled` is false where Tasks is a Beta-only feature, so Stable never asks the server. */
export function useTodoList(enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: todoQueryKey,
    // Merged like a stream snapshot, so a refetch can't undo newer live copies or bring
    // back a to-do that was just deleted.
    queryFn: async ({ signal }) => {
      const uncertainDeletes = [...pendingDeletesById].filter(([, entry]) => entry.uncertain);
      try {
        const { todos } = await ensureNativeApi().todo.list();
        if (!signal.aborted && uncertainDeletes.length > 0) {
          const presentIds = new Set(todos.map((todo) => todo.id));
          for (const [id, entry] of uncertainDeletes) {
            if (pendingDeletesById.get(id) !== entry) continue;
            pendingDeletesById.delete(id);
            if (presentIds.has(id)) unmarkTodoDeleted(id);
            else markTodoDeleted(id, true);
          }
        }
        return applyTodoEventHoldingEdits(queryClient.getQueryData<TodoListResult>(todoQueryKey), {
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
      queryClient.setQueryData<TodoListResult>(todoQueryKey, (prev) =>
        applyTodoEventHoldingEdits(prev, event),
      );
      // A socket reconnect need not change navigator.onLine. Its snapshot can predate
      // the uncertain delete, so request a fresh list rather than lifting its guard.
      if (
        event.type === "snapshot" &&
        [...pendingDeletesById.values()].some((entry) => entry.uncertain)
      ) {
        void queryClient.invalidateQueries({ queryKey: todoQueryKey }, { cancelRefetch: false });
      }
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
  // Every mutation can cancel another operation's recovery read. Start a fresh one
  // after settling and clearing its pending state, regardless of success or failure.
  const reconcileList = () => {
    void queryClient.invalidateQueries({ queryKey: todoQueryKey });
  };

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
        linkedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: UNSAVED_TODO_UPDATED_AT,
      };
      setList((todos) => upsertTodo(todos, optimistic));
    },
    onSuccess: (todo) => {
      if (pendingUpdatesById.has(todo.id)) return;
      setList((todos) => upsertTodo(todos, todo));
    },
    onError: (error, input) => {
      failedCreateIds.add(input.id);
      setList((todos) => todos.filter((todo) => todo.id !== input.id));
      showMutationError("Couldn't add the task")(error);
    },
    onSettled: (_todo, _error, input) => {
      endPendingCreate(input.id);
      reconcileList();
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (input: TodoUpdateInput) => {
      await afterPendingCreate(input.id);
      return ensureNativeApi().todo.update(input);
    },
    onMutate: async (input) => {
      const pending = beginPendingUpdate(input);
      await cancelListFetch();
      const previous = readTodo(input.id);
      if (previous) {
        // Keep the stored updatedAt: the server's reply is newer and replaces this copy.
        const optimistic = applyPendingUpdate(previous, pending);
        setList((todos) => todos.map((todo) => (todo.id === input.id ? optimistic : todo)));
      }
      return { previous };
    },
    // This reply predates the edits queued after it that are still in flight: keep them showing.
    onSuccess: (todo, input) =>
      setList((todos) => upsertTodo(todos, withLaterPendingUpdates(todo, input))),
    onError: (error, input, context) => {
      // The edit may have been stored before the connection went: keep it showing and
      // let the server's copy settle it, instead of rolling back and reporting a failure.
      // (Linking a chat re-reads the to-do in this case before deciding.)
      if (isRequestOutcomeUnknown(error)) return;
      const previous = context?.previous;
      if (previous) {
        // Optimistic copies keep the stored updatedAt, so a changed one means the server
        // sent something newer meanwhile; that copy wins over the rollback. Edits queued
        // after this one stay applied; earlier ones are already in `previous`.
        const restored = withLaterPendingUpdates(previous, input);
        setList((todos) =>
          todos.map((todo) =>
            todo.id === input.id && todo.updatedAt === previous.updatedAt ? restored : todo,
          ),
        );
      }
      showMutationError("Couldn't update the task")(error);
    },
    onSettled: (_todo, _error, input) => {
      endPendingUpdate(input);
      reconcileList();
    },
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
      const deletion: PendingDelete = { uncertain: false };
      pendingDeletesById.set(id, deletion);
      markTodoDeleted(id);
      setList((todos) => todos.filter((todo) => todo.id !== id));
      return { previous, deletion };
    },
    onSuccess: (_result, id) => {
      pendingDeletesById.delete(id);
      markTodoDeleted(id, true);
      setList((todos) => todos.filter((todo) => todo.id !== id));
    },
    onError: (error, id, context) => {
      if (!context || pendingDeletesById.get(id) !== context.deletion) return;
      // A lost reply does not prove refusal. Keep the optimistic absence until a fresh
      // server snapshot confirms whether the delete landed; do not flash a false error.
      if (isRequestOutcomeUnknown(error)) {
        context.deletion.uncertain = true;
        return;
      }
      pendingDeletesById.delete(id);
      unmarkTodoDeleted(id);
      const previous = context.previous;
      // Restore unless its create failed. A created row can still carry the optimistic
      // stamp (the delete mark blocked the create's reply); any newer copy replaces it.
      if (previous && !failedCreateIds.has(id)) {
        setList((todos) => upsertTodo(todos, previous));
      }
      showMutationError("Couldn't delete the task")(error);
    },
    onSettled: reconcileList,
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
/** `now` lets a just-linked chat read as Starting until its link settles; omit it where only attention counts. */
export function useTaskRows(todos: readonly Todo[], now?: Date): TaskRowModel[] {
  // The sidebar uses this hook even with no to-dos. Unrelated chat activity must not
  // rerender its entire tree; subscribe only to summaries the current to-dos reference.
  const linkedThreads = useStore(
    useShallow((state) =>
      todos.map((todo) =>
        todo.threadId ? (state.sidebarThreadSummaryById[todo.threadId] ?? null) : null,
      ),
    ),
  );
  const threadsHydrated = useStore((state) => state.threadsHydrated);
  const draftThreadsByThreadId = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  return useMemo(
    () =>
      todos.map((todo, index) => {
        const thread = linkedThreads[index] ?? null;
        const hasDraftThread =
          todo.threadId !== null && draftThreadsByThreadId[todo.threadId] !== undefined;
        return {
          todo,
          thread,
          status: deriveTaskStatus({ todo, thread, hasDraftThread, threadsHydrated, now }),
        };
      }),
    [draftThreadsByThreadId, linkedThreads, now, threadsHydrated, todos],
  );
}

/** How many to-dos sit in "Needs you" — the Tasks nav badge. */
export function useTasksNeedingAttentionCount(enabled = true): number {
  const { todos } = useTodoList(enabled);
  const rows = useTaskRows(todos);
  return rows.filter((row) => isTaskNeedingAttention(row.status)).length;
}
