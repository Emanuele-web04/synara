import {
  ThreadId,
  TodoId,
  type Todo,
  type TodoListResult,
  type TodoStreamEvent,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { deriveTaskStatus, todoQueryKey } from "./tasks.logic";
import { useTodoEventSubscription, useTodoMutations } from "./useTodos";

const transport = vi.hoisted(() => ({ update: vi.fn(), onEvent: vi.fn() }));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ todo: transport }) }));

async function mountTodos(id: string) {
  const todo: Todo = {
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
