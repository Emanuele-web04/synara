import {
  ThreadId,
  TodoId,
  type Todo,
  type TodoListResult,
  type TodoStreamEvent,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { deriveTaskStatus, todoQueryKey } from "./tasks.logic";
import { useStore } from "../../store";
import { makeThread } from "../../storeTestFixtures";
import { useTodoEventSubscription, useTodoMutations, useTaskRows } from "./useTodos";

const transport = vi.hoisted(() => ({ update: vi.fn(), onEvent: vi.fn(), delete: vi.fn() }));
const notifications = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: notifications }));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ todo: transport }) }));

function makeTodo(id: string): Todo {
  return {
    id: TodoId.makeUnsafe(id),
    title: "Original",
    notes: "",
    priority: "none",
    projectId: null,
    dueDate: null,
    threadId: null,
    delegationBaseTurnId: null,
    linkedAt: null,
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function mountTodos(id: string) {
  const todo = makeTodo(id);
  const client = new QueryClient();
  client.setQueryData(todoQueryKey, { todos: [todo] });
  let listener: ((event: TodoStreamEvent) => void) | undefined;
  transport.onEvent.mockImplementation((callback) => {
    listener = callback;
    return () => {};
  });
  let resolveReply!: (todo: Todo) => void;
  const promise = new Promise<Todo>((resolve) => {
    resolveReply = resolve;
  });
  const reply = { promise, resolve: resolveReply };
  transport.update.mockImplementation(() => reply.promise);
  const hook = await renderHook(
    () => {
      useTodoEventSubscription();
      return useTodoMutations();
    },
    {
      wrapper: ({ children }: { children?: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return {
    todo,
    hook,
    reply,
    client,
    emit: (event: TodoStreamEvent) => listener!(event),
    current: () => client.getQueryData<TodoListResult>(todoQueryKey)!.todos[0]!,
  };
}

it("keeps a newly linked old task in Starting before its mutation reply", async () => {
  const test = await mountTodos("optimistic-link-clock");
  const threadId = ThreadId.makeUnsafe("new-chat");
  const started = Date.now();
  const pending = test.hook.result.current.updateTodoAsync({ id: test.todo.id, threadId });
  try {
    await vi.waitFor(() => expect(test.current().threadId).toBe(threadId));
    expect(
      deriveTaskStatus({
        todo: test.current(),
        thread: null,
        hasDraftThread: false,
        threadsHydrated: true,
        now: new Date(),
      }).kind,
    ).toBe("starting");
    expect(Date.parse(test.current().linkedAt!)).toBeGreaterThanOrEqual(started);
    expect(test.current().updatedAt).toBe(test.todo.updatedAt);
  } finally {
    test.reply.resolve({ ...test.todo, threadId, linkedAt: new Date().toISOString() });
    await pending;
    await test.hook.unmount();
    test.client.clear();
  }
});

it("preserves a newer remote delegation while a local title edit and its older reply are in flight", async () => {
  const test = await mountTodos("remote-link-during-edit");
  const pending = test.hook.result.current.updateTodoAsync({ id: test.todo.id, title: "Edited" });
  const remote = {
    ...test.todo,
    title: "Edited",
    threadId: ThreadId.makeUnsafe("remote-chat"),
    linkedAt: "2026-01-01T00:00:02.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
  };
  try {
    await vi.waitFor(() => expect(test.current().title).toBe("Edited"));
    // An unrelated link arrives before the rename is stored: keep our title over it.
    test.emit({ type: "todo-upserted", todo: { ...remote, title: "Original" } });
    expect(test.current()).toMatchObject({
      title: "Edited",
      threadId: remote.threadId,
      updatedAt: remote.updatedAt,
    });
    // Then a remote completion follows the stored rename, but beats its RPC reply.
    const completed = {
      ...remote,
      completedAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
    };
    test.emit({ type: "todo-upserted", todo: completed });
    test.reply.resolve({ ...remote, updatedAt: "2026-01-01T00:00:03.000Z" });
    await pending;
    expect(test.current()).toMatchObject({
      title: "Edited",
      threadId: remote.threadId,
      updatedAt: "2026-01-01T00:00:04.000Z",
      completedAt: "2026-01-01T00:00:04.000Z",
    });
  } finally {
    test.reply.resolve(test.todo);
    await pending;
    await test.hook.unmount();
    test.client.clear();
  }
});

it("ignores unrelated chat updates for empty and unlinked task lists, while following linked chats", async () => {
  const previous = useStore.getState().sidebarThreadSummaryById;
  const unrelated = {
    ...makeThread({ id: ThreadId.makeUnsafe("unrelated") }),
    hasLiveTailWork: false,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
  let todos: Todo[] = [];
  let renders = 0;
  const hook = await renderHook(() => {
    renders += 1;
    return useTaskRows(todos);
  });
  try {
    const emptyRenders = renders;
    flushSync(() =>
      useStore.setState({ sidebarThreadSummaryById: { ...previous, [unrelated.id]: unrelated } }),
    );
    expect(renders).toBe(emptyRenders);
    todos = [makeTodo("unlinked")];
    await hook.rerender();
    const unlinkedRenders = renders;
    flushSync(() =>
      useStore.setState({
        sidebarThreadSummaryById: {
          ...previous,
          [unrelated.id]: { ...unrelated, title: "Changed elsewhere" },
        },
      }),
    );
    expect(renders).toBe(unlinkedRenders);
    todos = [{ ...todos[0]!, threadId: unrelated.id }];
    await hook.rerender();
    flushSync(() =>
      useStore.setState({
        sidebarThreadSummaryById: {
          ...previous,
          [unrelated.id]: { ...unrelated, title: "Linked chat changed" },
        },
      }),
    );
    expect(hook.result.current[0]?.thread?.title).toBe("Linked chat changed");
  } finally {
    await hook.unmount();
    useStore.setState({ sidebarThreadSummaryById: previous });
  }
});

it("reconciles an interrupted delete without restoring the row or reporting a definitive failure", async () => {
  const test = await mountTodos("unknown-delete");
  notifications.add.mockClear();
  transport.delete.mockRejectedValue(
    Object.assign(new Error("Connection changed"), {
      _tag: "WsTransportRequestInterruptedError",
      code: "WS_REQUEST_RECONNECTED",
    }),
  );
  try {
    await new Promise<void>((resolve) =>
      test.hook.result.current.deleteTodo(test.todo.id, { onSettled: () => resolve() }),
    );
    expect(test.client.getQueryData<TodoListResult>(todoQueryKey)?.todos).toEqual([]);
    expect(notifications.add).not.toHaveBeenCalled();
    // If the server did not apply it, reconciliation must be able to restore its row.
    test.emit({ type: "snapshot", todos: [test.todo] });
    expect(test.current()).toEqual(test.todo);
  } finally {
    await test.hook.unmount();
    test.client.clear();
  }
});
