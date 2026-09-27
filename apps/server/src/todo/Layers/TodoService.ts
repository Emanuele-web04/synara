import type { Todo, TodoStreamEvent } from "@synara/contracts";
import { applyTodoPatch } from "@synara/shared/todo";
import { Effect, Layer, Option, PubSub, Stream } from "effect";

import { TodoRepository } from "../../persistence/Services/TodoRepository.ts";
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

function toServiceError(message: string) {
  return (cause: unknown) => new TodoServiceError({ message, cause });
}

export const TodoServiceLive = Layer.effect(
  TodoService,
  Effect.gen(function* () {
    const repository = yield* TodoRepository;
    const events = yield* PubSub.unbounded<TodoStreamEvent>();
    const publish = (event: TodoStreamEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

    const list: TodoServiceShape["list"] = () =>
      repository.list().pipe(
        Effect.map((todos) => ({ todos })),
        Effect.mapError(toServiceError("Failed to list tasks.")),
      );

    const create: TodoServiceShape["create"] = (input) =>
      Effect.gen(function* () {
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
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        const inserted = yield* repository.insert(todo);
        if (Option.isSome(inserted)) {
          yield* publish({ type: "todo-upserted", todo: inserted.value });
          return inserted.value;
        }
        // A retried create: the id is already stored, so return that row unchanged.
        const existing = yield* repository.getById({ id: input.id });
        if (Option.isNone(existing)) {
          return yield* new TodoServiceError({ message: "The task was not saved." });
        }
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
        for (let attempt = 0; attempt < TODO_UPDATE_MAX_ATTEMPTS; attempt += 1) {
          const current = yield* repository.getById({ id: input.id });
          if (Option.isNone(current)) {
            return yield* new TodoServiceError({ message: "This task no longer exists." });
          }
          if (
            input.expectedThreadId !== undefined &&
            current.value.threadId !== input.expectedThreadId
          ) {
            return yield* new TodoServiceError({
              message: "This task was delegated somewhere else in the meantime.",
            });
          }
          // One chat works on one open to-do: both would read the same turns as theirs.
          if (
            input.threadId !== undefined &&
            input.threadId !== null &&
            input.threadId !== current.value.threadId
          ) {
            const owners = yield* repository.list();
            if (
              owners.some(
                (todo) =>
                  todo.id !== input.id &&
                  todo.threadId === input.threadId &&
                  todo.completedAt === null,
              )
            ) {
              return yield* new TodoServiceError({
                message: "That chat is already working on another task.",
              });
            }
          }
          const next = applyTodoPatch(
            current.value,
            input,
            nextTodoUpdatedAt(current.value.updatedAt),
          );
          const saved = yield* repository.save({
            todo: next,
            expectedUpdatedAt: current.value.updatedAt,
          });
          if (Option.isSome(saved)) {
            yield* publish({ type: "todo-upserted", todo: saved.value });
            return saved.value;
          }
        }
        return yield* new TodoServiceError({
          message: "The task changed while it was being saved. Try again.",
        });
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof TodoServiceError
            ? cause
            : new TodoServiceError({ message: "Failed to update the task.", cause }),
        ),
      );

    const deleteTodo: TodoServiceShape["delete"] = (input) =>
      repository
        .delete(input)
        .pipe(
          Effect.andThen(publish({ type: "todo-deleted", todoId: input.id })),
          Effect.mapError(toServiceError("Failed to delete the task.")),
        );

    const streamChanges: TodoServiceShape["streamChanges"] = Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading, so no change can land between the snapshot and the feed.
        const subscription = yield* PubSub.subscribe(events);
        const { todos } = yield* list();
        const snapshot: TodoStreamEvent = { type: "snapshot", todos };
        return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
      }),
    );

    return {
      list,
      create,
      update,
      delete: deleteTodo,
      streamChanges,
    } satisfies TodoServiceShape;
  }),
);
