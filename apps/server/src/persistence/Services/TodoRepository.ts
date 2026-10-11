/**
 * Durable storage for the Tasks view's personal to-dos.
 *
 * The repository only persists rows; the service owns ids, timestamps, patch
 * semantics, and change events.
 */
import { Todo, TodoId } from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { TodoRepositoryError } from "../Errors.ts";

export const TodoByIdInput = Schema.Struct({
  id: TodoId,
});
export type TodoByIdInput = typeof TodoByIdInput.Type;

export const SaveTodoInput = Schema.Struct({
  todo: Todo,
  /** Optimistic concurrency: the row is written only while it still has this updatedAt. */
  expectedUpdatedAt: Schema.String,
});
export type SaveTodoInput = typeof SaveTodoInput.Type;

export interface TodoRepositoryShape {
  /** Every to-do, oldest first. */
  readonly list: () => Effect.Effect<ReadonlyArray<Todo>, TodoRepositoryError>;
  readonly getById: (
    input: TodoByIdInput,
  ) => Effect.Effect<Option.Option<Todo>, TodoRepositoryError>;
  /** Inserts the to-do and returns it; none when the id already exists (that row is kept). */
  readonly insert: (todo: Todo) => Effect.Effect<Option.Option<Todo>, TodoRepositoryError>;
  /** Replaces the row when it is unchanged since `expectedUpdatedAt`; none on a lost race. */
  readonly save: (input: SaveTodoInput) => Effect.Effect<Option.Option<Todo>, TodoRepositoryError>;
  readonly delete: (input: TodoByIdInput) => Effect.Effect<void, TodoRepositoryError>;
}

export class TodoRepository extends ServiceMap.Service<TodoRepository, TodoRepositoryShape>()(
  "synara/persistence/Services/TodoRepository",
) {}
