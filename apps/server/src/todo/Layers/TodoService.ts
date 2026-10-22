import type { Todo, TodoStreamEvent } from "@synara/contracts";
import { applyTodoPatch } from "@synara/shared/todo";
import { Effect, Layer, Option, PubSub, Semaphore, Stream } from "effect";

import { TodoRepository } from "../../persistence/Services/TodoRepository.ts";
import { NotionIntegration } from "../../notion/Services/NotionIntegration.ts";
import { TodoServiceError } from "../Errors.ts";
import { TodoService, type TodoServiceShape } from "../Services/TodoService.ts";

const TODO_UPDATE_MAX_ATTEMPTS = 3;
function isoNow(): string {
  return new Date().toISOString();
}
/** Keeps updatedAt strictly increasing so clients can merge events by it. */
export function nextTodoUpdatedAt(previousUpdatedAt: string): string {
  const candidate = isoNow();
  const previousTime = Date.parse(previousUpdatedAt);
  const candidateTime = Date.parse(candidate);
  return Number.isFinite(previousTime) && candidateTime <= previousTime
    ? new Date(previousTime + 1).toISOString()
    : candidate;
}
const CHAT_OWNED_ELSEWHERE_MESSAGE = "That chat is already working on another task.";
function isChatOwnershipConflict(cause: unknown): boolean {
  for (let current = cause, depth = 0; current && depth < 6; depth += 1) {
    if (
      current instanceof Error &&
      (current.message.includes("idx_todos_open_thread") ||
        current.message.includes("todos.thread_id"))
    )
      return true;
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}
function toServiceError(message: string) {
  return (cause: unknown) => new TodoServiceError({ message, cause });
}
const isExternal = (id: string) => id.startsWith("notion:");
export const TodoServiceLive = Layer.effect(
  TodoService,
  Effect.gen(function* () {
    const repository = yield* TodoRepository;
    const maybeNotion = yield* Effect.serviceOption(NotionIntegration);
    const notion = Option.isSome(maybeNotion) ? maybeNotion.value : null;
    const runtime = notion?.runtime ?? null;
    const events = yield* PubSub.unbounded<TodoStreamEvent>();
    const ownership = yield* Semaphore.make(1);
    const publish = (event: TodoStreamEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
    const list: TodoServiceShape["list"] = () =>
      repository.list().pipe(
        Effect.map((todos) => ({ todos: [...todos, ...(runtime?.listTodos() ?? [])] })),
        Effect.mapError(toServiceError("Failed to list tasks.")),
      );
    const create: TodoServiceShape["create"] = (input) =>
      Effect.gen(function* () {
        if (isExternal(input.id))
          return yield* new TodoServiceError({
            message: "Notion records must be created through their mapped data source.",
          });
        const now = isoNow();
        const todo: Todo = {
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
          updatedAt: now,
        };
        const inserted = yield* repository.insert(todo);
        if (Option.isSome(inserted)) {
          yield* publish({ type: "todo-upserted", todo: inserted.value });
          return inserted.value;
        }
        const existing = yield* repository.getById({ id: input.id });
        if (Option.isNone(existing))
          return yield* new TodoServiceError({ message: "The task was not saved." });
        return existing.value;
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof TodoServiceError
            ? cause
            : new TodoServiceError({ message: "Failed to create the task.", cause }),
        ),
      );
    const update: TodoServiceShape["update"] = (input) =>
      Effect.gen(function* () {
        if (isExternal(input.id)) {
          if (!runtime)
            return yield* new TodoServiceError({ message: "The Notion provider is unavailable." });
          const current = runtime.listTodos().find((todo) => todo.id === input.id);
          if (!current)
            return yield* new TodoServiceError({
              message: "This Notion task is no longer available.",
            });
          const patched = applyTodoPatch(current, input, nextTodoUpdatedAt(current.updatedAt));
          const linksNewly = patched.threadId !== current.threadId;
          let nextInput = input;
          if (patched.threadId !== null && patched.completedAt === null) {
            const { todos } = yield* list();
            const owned = todos.some(
              (todo) =>
                todo.id !== input.id &&
                todo.threadId === patched.threadId &&
                todo.completedAt === null,
            );
            if (owned && linksNewly)
              return yield* new TodoServiceError({ message: CHAT_OWNED_ELSEWHERE_MESSAGE });
            if (owned && current.completedAt !== null)
              nextInput = { ...input, threadId: null, delegationBaseTurnId: null };
          }
          return yield* Effect.tryPromise({
            try: () => runtime.updateTodo(nextInput),
            catch: (cause) =>
              new TodoServiceError({
                message:
                  cause instanceof Error ? cause.message : "Failed to update the Notion task.",
              }),
          });
        }
        for (let attempt = 0; attempt < TODO_UPDATE_MAX_ATTEMPTS; attempt += 1) {
          const current = yield* repository.getById({ id: input.id });
          if (Option.isNone(current))
            return yield* new TodoServiceError({ message: "This task no longer exists." });
          if (
            input.expectedThreadId !== undefined &&
            current.value.threadId !== input.expectedThreadId
          )
            return yield* new TodoServiceError({
              message: "This task was delegated somewhere else in the meantime.",
            });
          const patched = applyTodoPatch(
            current.value,
            input,
            nextTodoUpdatedAt(current.value.updatedAt),
          );
          const linksNewly = patched.threadId !== current.value.threadId;
          const reopens = current.value.completedAt !== null && patched.completedAt === null;
          let next = patched;
          if (
            patched.threadId !== null &&
            patched.completedAt === null &&
            (linksNewly || reopens)
          ) {
            const { todos } = yield* list();
            const ownedElsewhere = todos.some(
              (todo) =>
                todo.id !== input.id &&
                todo.threadId === patched.threadId &&
                todo.completedAt === null,
            );
            if (ownedElsewhere && linksNewly)
              return yield* new TodoServiceError({ message: CHAT_OWNED_ELSEWHERE_MESSAGE });
            if (ownedElsewhere)
              next = { ...patched, threadId: null, delegationBaseTurnId: null, linkedAt: null };
          }
          const saved = yield* repository
            .save({ todo: next, expectedUpdatedAt: current.value.updatedAt })
            .pipe(
              Effect.catchIf(
                (cause) => !linksNewly && isChatOwnershipConflict(cause),
                () => Effect.succeed(Option.none()),
              ),
            );
          if (Option.isSome(saved)) {
            yield* publish({ type: "todo-upserted", todo: saved.value });
            return saved.value;
          }
        }
        return yield* new TodoServiceError({
          message: "The task changed while it was being saved. Try again.",
        });
      }).pipe(
        ownership.withPermits(1),
        Effect.mapError((cause) =>
          cause instanceof TodoServiceError
            ? cause
            : isChatOwnershipConflict(cause)
              ? new TodoServiceError({ message: CHAT_OWNED_ELSEWHERE_MESSAGE, cause })
              : new TodoServiceError({ message: "Failed to update the task.", cause }),
        ),
      );
    const deleteTodo: TodoServiceShape["delete"] = (input) =>
      isExternal(input.id)
        ? runtime
          ? Effect.tryPromise({
              try: () => runtime.deleteTodo(input.id),
              catch: toServiceError("Failed to archive the Notion task."),
            })
          : Effect.fail(new TodoServiceError({ message: "The Notion provider is unavailable." }))
        : repository
            .delete(input)
            .pipe(
              Effect.andThen(publish({ type: "todo-deleted", todoId: input.id })),
              Effect.mapError(toServiceError("Failed to delete the task.")),
            );
    const streamChanges: TodoServiceShape["streamChanges"] = Stream.unwrap(
      Effect.gen(function* () {
        // Both subscriptions precede the snapshot. Notion rows use the same native Tasks feed.
        const subscription = yield* PubSub.subscribe(events);
        const external = notion ? yield* PubSub.subscribe(notion.events) : null;
        const { todos } = yield* list();
        const changes = external
          ? Stream.merge(Stream.fromSubscription(subscription), Stream.fromSubscription(external))
          : Stream.fromSubscription(subscription);
        return Stream.concat(Stream.make({ type: "snapshot", todos } as TodoStreamEvent), changes);
      }),
    );
    return { list, create, update, delete: deleteTodo, streamChanges } satisfies TodoServiceShape;
  }),
);
