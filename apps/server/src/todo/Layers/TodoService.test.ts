import { ProjectId, ThreadId, TodoId, type TodoStreamEvent } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Queue, Stream } from "effect";

import { TodoRepositoryLive } from "../../persistence/Layers/TodoRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { TodoService } from "../Services/TodoService.ts";
import { TodoServiceLive } from "./TodoService.ts";

const layer = it.layer(
  TodoServiceLive.pipe(
    Layer.provideMerge(TodoRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("TodoService", (it) => {
  it.effect("creates a to-do once per id and lists it", () =>
    Effect.gen(function* () {
      const todos = yield* TodoService;
      const id = TodoId.makeUnsafe("todo-create");

      const created = yield* todos.create({ id, title: "Clean up Downloads", priority: "high" });
      const retried = yield* todos.create({ id, title: "A different title" });

      assert.strictEqual(retried.title, "Clean up Downloads");
      assert.strictEqual(created.priority, "high");
      assert.strictEqual(created.notes, "");
      assert.strictEqual(created.threadId, null);
      const { todos: listed } = yield* todos.list();
      assert.deepStrictEqual(
        listed.filter((todo) => todo.id === id),
        [created],
      );
    }),
  );

  it.effect("patches fields, links a chat, and toggles completion", () =>
    Effect.gen(function* () {
      const todos = yield* TodoService;
      const id = TodoId.makeUnsafe("todo-update");
      const created = yield* todos.create({ id, title: "Write release notes" });

      const linked = yield* todos.update({
        id,
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        dueDate: "2026-10-03",
      });
      assert.strictEqual(linked.threadId, "thread-1");
      assert.strictEqual(linked.projectId, "project-1");
      assert.strictEqual(linked.dueDate, "2026-10-03");
      assert.strictEqual(linked.title, "Write release notes");
      assert.isTrue(linked.updatedAt > created.updatedAt);

      const completed = yield* todos.update({ id, completed: true });
      assert.isNotNull(completed.completedAt);
      const completedAgain = yield* todos.update({ id, completed: true });
      assert.strictEqual(completedAgain.completedAt, completed.completedAt);

      const reopened = yield* todos.update({ id, completed: false, projectId: null });
      assert.strictEqual(reopened.completedAt, null);
      assert.strictEqual(reopened.projectId, null);
    }),
  );

  it.effect("claims a to-do for a chat only while it is still unlinked", () =>
    Effect.gen(function* () {
      const todos = yield* TodoService;
      const id = TodoId.makeUnsafe("todo-claim");
      yield* todos.create({ id, title: "Review the release notes" });
      const first = ThreadId.makeUnsafe("thread-claim-first");
      const second = ThreadId.makeUnsafe("thread-claim-second");

      const claimed = yield* todos.update({ id, threadId: first, expectedThreadId: null });
      assert.strictEqual(claimed.threadId, first);

      // Targeting the same chat still loses the claim: only the first caller owns it.
      for (const threadId of [first, second]) {
        const lost = yield* Effect.exit(todos.update({ id, threadId, expectedThreadId: null }));
        assert.isTrue(Exit.isFailure(lost));
      }
      const { todos: listed } = yield* todos.list();
      assert.strictEqual(listed.find((todo) => todo.id === id)?.threadId, first);
    }),
  );

  it.effect("lets one chat work on only one open to-do", () =>
    Effect.gen(function* () {
      const todos = yield* TodoService;
      const chat = ThreadId.makeUnsafe("thread-shared-chat");
      const first = TodoId.makeUnsafe("todo-owner-first");
      const second = TodoId.makeUnsafe("todo-owner-second");
      yield* todos.create({ id: first, title: "Draft the changelog" });
      yield* todos.create({ id: second, title: "Tag the release" });
      yield* todos.update({ id: first, threadId: chat });

      const refused = yield* Effect.exit(todos.update({ id: second, threadId: chat }));
      assert.isTrue(Exit.isFailure(refused));

      // Once the first is done, the chat is free again.
      yield* todos.update({ id: first, completed: true });
      const linked = yield* todos.update({ id: second, threadId: chat });
      assert.strictEqual(linked.threadId, chat);
      assert.strictEqual(linked.delegationBaseTurnId, null);

      // Reopening the first keeps it, but not the chat the second now works in.
      const reopened = yield* todos.update({ id: first, completed: false });
      assert.strictEqual(reopened.completedAt, null);
      assert.strictEqual(reopened.threadId, null);
    }),
  );

  it.effect("lets only one of two concurrent claims of a chat succeed", () =>
    Effect.gen(function* () {
      const todos = yield* TodoService;
      const chat = ThreadId.makeUnsafe("thread-race");
      const left = TodoId.makeUnsafe("todo-race-left");
      const right = TodoId.makeUnsafe("todo-race-right");
      yield* todos.create({ id: left, title: "Left" });
      yield* todos.create({ id: right, title: "Right" });

      const results = yield* Effect.all(
        [
          Effect.exit(todos.update({ id: left, threadId: chat })),
          Effect.exit(todos.update({ id: right, threadId: chat })),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(results.filter(Exit.isSuccess).length, 1);
      const { todos: listed } = yield* todos.list();
      assert.strictEqual(listed.filter((todo) => todo.threadId === chat).length, 1);
    }),
  );

  it.effect("fails to update a missing to-do and publishes deletes", () =>
    Effect.gen(function* () {
      const todos = yield* TodoService;
      const missing = yield* Effect.exit(
        todos.update({ id: TodoId.makeUnsafe("todo-missing"), title: "Nope" }),
      );
      assert.isTrue(Exit.isFailure(missing));

      const id = TodoId.makeUnsafe("todo-delete");
      const created = yield* todos.create({ id, title: "Call the accountant" });
      const received = yield* Queue.unbounded<TodoStreamEvent>();
      yield* todos.streamChanges.pipe(
        Stream.runForEach((event) => Queue.offer(received, event)),
        Effect.forkChild,
      );
      // The snapshot comes first and only after the stream subscribed, so the
      // delete below cannot slip in before the live feed.
      const snapshot = yield* Queue.take(received);
      assert.isTrue(
        snapshot.type === "snapshot" && snapshot.todos.some((todo) => todo.id === created.id),
      );
      yield* todos.delete({ id });
      assert.deepStrictEqual(yield* Queue.take(received), { type: "todo-deleted", todoId: id });
      const { todos: listed } = yield* todos.list();
      assert.isFalse(listed.some((todo) => todo.id === id));
    }),
  );
});
