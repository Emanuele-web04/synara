import type {
  Todo,
  TodoCreateInput,
  TodoDeleteInput,
  TodoListResult,
  TodoStreamEvent,
  TodoUpdateInput,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { TodoServiceError } from "../Errors.ts";

export interface TodoServiceShape {
  readonly list: () => Effect.Effect<TodoListResult, TodoServiceError>;
  /** Idempotent per id: retrying a create returns the stored to-do unchanged. */
  readonly create: (input: TodoCreateInput) => Effect.Effect<Todo, TodoServiceError>;
  readonly update: (input: TodoUpdateInput) => Effect.Effect<Todo, TodoServiceError>;
  readonly delete: (input: TodoDeleteInput) => Effect.Effect<void, TodoServiceError>;
  /** A snapshot of every to-do, then each change after it. */
  readonly streamChanges: Stream.Stream<TodoStreamEvent, TodoServiceError>;
}

export class TodoService extends ServiceMap.Service<TodoService, TodoServiceShape>()(
  "synara/todo/Services/TodoService",
) {}
