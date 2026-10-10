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
import { useTodoEventSubscription, useTodoMutations, useTaskRows, useTodoList } from "./useTodos";

const transport = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  onEvent: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
}));
const notifications = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: notifications }));
vi.mock("../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => ({ todo: transport }),
}));

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

async function mountTodos(id: string, listEnabled = false) {
  const todo = makeTodo(id);
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retryDelay: 0 } },
  });
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
      useTodoList(listEnabled);
      const mutations = useTodoMutations();
      const secondMutations = useTodoMutations();
      return { ...mutations, secondDeleteTodo: secondMutations.deleteTodo };
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
    pendingBackgroundWorkCount: 0,
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

it("holds an uncertain deletion against late events and update replies until a fresh list reconciles it", async () => {
  const test = await mountTodos("unknown-delete", true);
  notifications.add.mockClear();
  transport.delete.mockRejectedValue(
    Object.assign(new Error("Connection changed"), {
      _tag: "WsTransportRequestInterruptedError",
      code: "WS_REQUEST_RECONNECTED",
    }),
  );
  transport.list.mockRejectedValue(new Error("Still offline"));
  const pendingUpdate = test.hook.result.current.updateTodoAsync({
    id: test.todo.id,
    title: "Edited",
  });
  try {
    await vi.waitFor(() => expect(test.current().title).toBe("Edited"));
    await new Promise<void>((resolve) =>
      test.hook.result.current.deleteTodo(test.todo.id, { onSettled: () => resolve() }),
    );
    await vi.waitFor(() => expect(test.client.isFetching({ queryKey: todoQueryKey })).toBe(0));
    expect(notifications.add).not.toHaveBeenCalled();
    test.emit({ type: "todo-upserted", todo: test.todo });
    expect(test.client.getQueryData<TodoListResult>(todoQueryKey)?.todos).toEqual([]);
    test.reply.resolve({ ...test.todo, title: "Edited" });
    await pendingUpdate;
    expect(test.client.getQueryData<TodoListResult>(todoQueryKey)?.todos).toEqual([]);
    await vi.waitFor(() => expect(test.client.isFetching({ queryKey: todoQueryKey })).toBe(0));
    // Stream snapshots can predate the delete; only a fresh successful list settles it.
    test.emit({ type: "snapshot", todos: [test.todo] });
    expect(test.client.getQueryData<TodoListResult>(todoQueryKey)?.todos).toEqual([]);
    transport.list.mockResolvedValue({ todos: [test.todo] });
    await test.client.refetchQueries({ queryKey: todoQueryKey });
    expect(test.current()).toEqual(test.todo);
  } finally {
    test.reply.resolve(test.todo);
    await pendingUpdate;
    await test.hook.unmount();
    test.client.clear();
  }
});

it("keeps a confirmed deletion guarded when an older reconciliation list arrives later", async () => {
  const test = await mountTodos("confirmed-delete-during-list", true);
  let resolveList!: (value: TodoListResult) => void;
  transport.list.mockImplementation(
    () =>
      new Promise<TodoListResult>((resolve) => {
        resolveList = resolve;
      }),
  );
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
    await vi.waitFor(() => expect(resolveList).toBeDefined());
    test.emit({ type: "todo-deleted", todoId: test.todo.id });
    resolveList({ todos: [test.todo] });
    await vi.waitFor(() => expect(test.client.isFetching({ queryKey: todoQueryKey })).toBe(0));
    expect(test.client.getQueryData<TodoListResult>(todoQueryKey)?.todos).toEqual([]);
    test.emit({ type: "todo-upserted", todo: test.todo });
    expect(test.client.getQueryData<TodoListResult>(todoQueryKey)?.todos).toEqual([]);
  } finally {
    resolveList?.({ todos: [] });
    await test.hook.unmount();
    test.client.clear();
  }
});

it("preserves server confirmation received before the delete's lost reply", async () => {
  const test = await mountTodos("delete-confirmed-before-error", true);
  let rejectDelete!: (error: Error) => void;
  transport.delete.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectDelete = reject;
      }),
  );
  transport.list.mockResolvedValue({ todos: [test.todo] });
  let settled: Promise<void> | undefined;
  try {
    settled = new Promise<void>((resolve) =>
      test.hook.result.current.deleteTodo(test.todo.id, { onSettled: () => resolve() }),
    );
    await vi.waitFor(() => expect(rejectDelete).toBeDefined());
    test.emit({ type: "todo-deleted", todoId: test.todo.id });
    rejectDelete(
      Object.assign(new Error("Reply lost"), {
        _tag: "WsTransportRequestInterruptedError",
        code: "WS_REQUEST_RECONNECTED",
      }),
    );
    await settled;
    await test.client.refetchQueries({ queryKey: todoQueryKey });
    expect(test.client.getQueryData<TodoListResult>(todoQueryKey)?.todos).toEqual([]);
  } finally {
    rejectDelete?.(new Error("Test cleanup"));
    await settled;
    await test.hook.unmount();
    test.client.clear();
  }
});

it("does not let a canceled list release a newer delete's guard", async () => {
  const test = await mountTodos("delete-replaces-canceled-list", true);
  const replies: Array<(value: TodoListResult) => void> = [];
  let firstListReturned = false;
  transport.list.mockImplementation(() => {
    const index = replies.length;
    return new Promise<TodoListResult>((resolve) => {
      replies.push(resolve);
    }).then((result) => {
      if (index === 0) firstListReturned = true;
      return result;
    });
  });
  transport.delete.mockRejectedValue(
    Object.assign(new Error("Reply lost"), {
      _tag: "WsTransportRequestInterruptedError",
      code: "WS_REQUEST_RECONNECTED",
    }),
  );
  const deleteTask = () =>
    new Promise<void>((resolve) =>
      test.hook.result.current.deleteTodo(test.todo.id, { onSettled: () => resolve() }),
    );
  try {
    await deleteTask();
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await deleteTask();
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[0]!({ todos: [test.todo] });
    await vi.waitFor(() => expect(firstListReturned).toBe(true));
    test.emit({ type: "todo-upserted", todo: test.todo });
    expect(test.client.getQueryData<TodoListResult>(todoQueryKey)?.todos).toEqual([]);
    replies[1]!({ todos: [] });
    await vi.waitFor(() => expect(test.client.isFetching({ queryKey: todoQueryKey })).toBe(0));
    test.emit({ type: "todo-upserted", todo: test.todo });
    expect(test.client.getQueryData<TodoListResult>(todoQueryKey)?.todos).toEqual([]);
  } finally {
    for (const reply of replies) reply({ todos: [] });
    await test.hook.unmount();
    test.client.clear();
  }
});

it.each(["success-first", "failure-first", "success-before-next-attempt"])(
  "keeps successful deletion authoritative across overlapping replies (%s)",
  async (order) => {
    const test = await mountTodos(`overlapping-delete-${order}`);
    const deletes: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    transport.delete.mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          deletes.push({ resolve, reject });
        }),
    );
    const deleteTask = () =>
      new Promise<void>((resolve) =>
        test.hook.result.current.deleteTodo(test.todo.id, { onSettled: () => resolve() }),
      );
    const first = deleteTask();
    await vi.waitFor(() => expect(deletes).toHaveLength(1));
    if (order === "success-before-next-attempt") {
      deletes[0]!.resolve();
      await first;
    }
    const second = new Promise<void>((resolve) =>
      test.hook.result.current.secondDeleteTodo(test.todo.id, { onSettled: () => resolve() }),
    );
    await vi.waitFor(() => expect(deletes).toHaveLength(2));
    try {
      if (order !== "failure-first") {
        deletes[0]!.resolve();
        await first;
        deletes[1]!.reject(new Error("Delete refused"));
        await second;
      } else {
        deletes[1]!.reject(new Error("Delete refused"));
        await second;
        // An old copy can arrive before the authoritative success callback.
        test.emit({ type: "todo-upserted", todo: test.todo });
        deletes[0]!.resolve();
        await first;
      }
      expect(test.client.getQueryData<TodoListResult>(todoQueryKey)?.todos).toEqual([]);
      test.emit({ type: "todo-upserted", todo: test.todo });
      expect(test.client.getQueryData<TodoListResult>(todoQueryKey)?.todos).toEqual([]);
    } finally {
      for (const reply of deletes) reply.resolve();
      await Promise.all([first, second]);
      await test.hook.unmount();
      test.client.clear();
    }
  },
);

it.each(["create", "delete"])(
  "resumes uncertain-delete reconciliation after another successful %s cancels its list",
  async (mutation) => {
    const test = await mountTodos(`cancel-delete-recovery-${mutation}`, true);
    const other = makeTodo(`other-task-${mutation}`);
    let releaseCanceledList!: (value: TodoListResult) => void;
    transport.list
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise<TodoListResult>((resolve) => {
            releaseCanceledList = resolve;
          }),
      )
      .mockResolvedValue({ todos: mutation === "create" ? [test.todo, other] : [test.todo] });
    transport.delete.mockImplementation(({ id }) =>
      id === test.todo.id
        ? Promise.reject(
            Object.assign(new Error("Reply lost"), {
              _tag: "WsTransportRequestInterruptedError",
              code: "WS_REQUEST_RECONNECTED",
            }),
          )
        : Promise.resolve({ deleted: true }),
    );
    transport.create.mockResolvedValue(other);
    try {
      if (mutation === "delete") test.emit({ type: "todo-upserted", todo: other });
      await new Promise<void>((resolve) =>
        test.hook.result.current.deleteTodo(test.todo.id, { onSettled: () => resolve() }),
      );
      await vi.waitFor(() => expect(releaseCanceledList).toBeDefined());
      await new Promise<void>((resolve) => {
        const options = { onSettled: () => resolve() };
        if (mutation === "create")
          test.hook.result.current.createTodo({ id: other.id, title: other.title }, options);
        else test.hook.result.current.deleteTodo(other.id, options);
      });
      await vi.waitFor(() =>
        expect(
          test.client
            .getQueryData<TodoListResult>(todoQueryKey)
            ?.todos.some((todo) => todo.id === test.todo.id),
        ).toBe(true),
      );
    } finally {
      releaseCanceledList?.({ todos: [test.todo] });
      await test.hook.unmount();
      test.client.clear();
    }
  },
);

it("requests fresh reconciliation on a reconnect snapshot after the previous list failed", async () => {
  const test = await mountTodos("reconnect-delete-recovery", true);
  transport.delete.mockRejectedValue(
    Object.assign(new Error("Reply lost"), {
      _tag: "WsTransportRequestInterruptedError",
      code: "WS_REQUEST_RECONNECTED",
    }),
  );
  transport.list.mockRejectedValue(new Error("Still offline"));
  let releaseFreshList!: (value: TodoListResult) => void;
  try {
    await new Promise<void>((resolve) =>
      test.hook.result.current.deleteTodo(test.todo.id, { onSettled: () => resolve() }),
    );
    await vi.waitFor(() => expect(test.client.isFetching({ queryKey: todoQueryKey })).toBe(0));
    transport.list.mockImplementation(
      () =>
        new Promise<TodoListResult>((resolve) => {
          releaseFreshList = resolve;
        }),
    );
    test.emit({ type: "snapshot", todos: [test.todo] });
    // The event may predate deletion; it schedules a read, but cannot clear the guard itself.
    expect(test.client.getQueryData<TodoListResult>(todoQueryKey)?.todos).toEqual([]);
    await vi.waitFor(() => expect(releaseFreshList).toBeDefined());
    releaseFreshList({ todos: [test.todo] });
    await vi.waitFor(() => expect(test.current()).toEqual(test.todo));
  } finally {
    releaseFreshList?.({ todos: [] });
    await test.hook.unmount();
    test.client.clear();
  }
});

it("keeps a created task when a pre-write list replies after create", async () => {
  const test = await mountTodos("create-before-stale-list", true);
  const created = makeTodo("created-while-list-pending");
  let resolveCreate!: (todo: Todo) => void;
  let resolveStaleList!: (value: TodoListResult) => void;
  transport.create.mockImplementation(
    () =>
      new Promise<Todo>((resolve) => {
        resolveCreate = resolve;
      }),
  );
  transport.list
    .mockReset()
    .mockImplementationOnce(
      () =>
        new Promise<TodoListResult>((resolve) => {
          resolveStaleList = resolve;
        }),
    )
    .mockResolvedValue({ todos: [test.todo, created] });
  const mutation = new Promise<void>((resolve) =>
    test.hook.result.current.createTodo(
      { id: created.id, title: created.title },
      { onSettled: () => resolve() },
    ),
  );
  let staleRead: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(resolveCreate).toBeDefined());
    staleRead = test.client.refetchQueries({ queryKey: todoQueryKey });
    await vi.waitFor(() => expect(resolveStaleList).toBeDefined());
    resolveCreate(created);
    await mutation;
    resolveStaleList({ todos: [test.todo] });
    await staleRead;
    await vi.waitFor(() => expect(test.client.isFetching({ queryKey: todoQueryKey })).toBe(0));
    expect(test.client.getQueryData<TodoListResult>(todoQueryKey)?.todos).toContainEqual(created);
  } finally {
    resolveCreate?.(created);
    resolveStaleList?.({ todos: [test.todo] });
    await mutation;
    await staleRead;
    await test.hook.unmount();
    test.client.clear();
  }
});
