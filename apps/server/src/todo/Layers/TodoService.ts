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

const CHAT_OWNED_ELSEWHERE_MESSAGE = "That chat is already working on another task.";

// The unique index on open to-dos' thread_id rejected a save: a concurrent claim won.
function isChatOwnershipConflict(cause: unknown): boolean {
  for (let current = cause, depth = 0; current && depth < 6; depth += 1) {
    if (current instanceof Error && current.message.includes("idx_todos_open_thread")) {
      return true;
    }
    if (current instanceof Error && current.message.includes("todos.thread_id")) return true;
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
          const patched = applyTodoPatch(
            current.value,
            input,
            nextTodoUpdatedAt(current.value.updatedAt),
          );
          // One chat works on one open to-do: both would read the same turns as theirs.
          // Checked on the result, so reopening a done to-do counts as well as linking.
          const linksNewly = patched.threadId !== current.value.threadId;
          const reopens = current.value.completedAt !== null && patched.completedAt === null;
          let next = patched;
          if (
            patched.threadId !== null &&
            patched.completedAt === null &&
            (linksNewly || reopens)
          ) {
            const owners = yield* repository.list();
            const ownedElsewhere = owners.some(
              (todo) =>
                todo.id !== input.id &&
                todo.threadId === patched.threadId &&
                todo.completedAt === null,
            );
            if (ownedElsewhere && linksNewly) {
              return yield* new TodoServiceError({ message: CHAT_OWNED_ELSEWHERE_MESSAGE });
            }
            // Reopening keeps the to-do but gives up a chat another to-do now works in.
            if (ownedElsewhere) {
              next = { ...patched, threadId: null, delegationBaseTurnId: null, linkedAt: null };
            }
          }
          const saved = yield* repository
            .save({ todo: next, expectedUpdatedAt: current.value.updatedAt })
            .pipe(
              // A claim of the same chat landed after the ownership read. A reopen keeps
              // the to-do: retry, and the next read drops the link. A new link fails.
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
        Effect.mapError((cause) =>
          cause instanceof TodoServiceError
            ? cause
            : isChatOwnershipConflict(cause)
              ? new TodoServiceError({ message: CHAT_OWNED_ELSEWHERE_MESSAGE, cause })
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
