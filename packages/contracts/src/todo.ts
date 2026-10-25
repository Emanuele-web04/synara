import { Schema } from "effect";

import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  TodoId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";

// Personal to-dos shown in the Tasks view. A to-do can stand alone, carry a project
// label, or be delegated to an agent chat — in which case `threadId` links the chat
// whose live status the client derives. The thread's model, folder, and worktree
// live on the thread itself, so the to-do never duplicates delegation settings.

/** WsRpcError code the server uses to refuse Tasks where it is not enabled. */
export const TASKS_UNAVAILABLE_ERROR_CODE = "TASKS_UNAVAILABLE";

export const TODO_TITLE_MAX_LENGTH = 500;
export const TODO_NOTES_MAX_LENGTH = 10_000;

export const TodoPriority = Schema.Literals(["none", "low", "medium", "high", "urgent"]);
export type TodoPriority = typeof TodoPriority.Type;

const TodoIsoDateTime = IsoDateTime.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
);

function isCalendarDay(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** A calendar day in the user's local time (`YYYY-MM-DD`), not an instant. */
export const TodoDueDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  // The pattern alone accepts 2026-02-31 or 2026-13-01, which sort and display apart.
  Schema.makeFilter(isCalendarDay),
);
export type TodoDueDate = typeof TodoDueDate.Type;

const TodoTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(TODO_TITLE_MAX_LENGTH));
const TodoNotes = Schema.String.check(Schema.isMaxLength(TODO_NOTES_MAX_LENGTH));

export const Todo = Schema.Struct({
  id: TodoId,
  title: TodoTitle,
  notes: TodoNotes,
  priority: TodoPriority,
  projectId: Schema.NullOr(ProjectId),
  dueDate: Schema.NullOr(TodoDueDate),
  threadId: Schema.NullOr(ThreadId),
  /**
   * The linked chat's latest turn when the to-do was handed to it. Until a newer turn
   * appears, that chat's state (an earlier reply, approval, or run) is not this to-do's.
   */
  delegationBaseTurnId: Schema.NullOr(TurnId),
  /** When threadId was last set; a fresh link's chat may not have reached every window yet. */
  linkedAt: Schema.NullOr(TodoIsoDateTime),
  completedAt: Schema.NullOr(TodoIsoDateTime),
  createdAt: TodoIsoDateTime,
  updatedAt: TodoIsoDateTime,
});
export type Todo = typeof Todo.Type;

/** The client picks the id so an optimistic row and a retried create stay one to-do. */
export const TodoCreateInput = Schema.Struct({
  id: TodoId,
  title: TodoTitle,
  notes: Schema.optional(TodoNotes).pipe(Schema.withDecodingDefault(() => "")),
  priority: Schema.optional(TodoPriority).pipe(Schema.withDecodingDefault(() => "none" as const)),
  projectId: Schema.optional(Schema.NullOr(ProjectId)).pipe(Schema.withDecodingDefault(() => null)),
  dueDate: Schema.optional(Schema.NullOr(TodoDueDate)).pipe(Schema.withDecodingDefault(() => null)),
});
export type TodoCreateInput = typeof TodoCreateInput.Type;

export const TodoUpdateInput = Schema.Struct({
  id: TodoId,
  title: Schema.optional(TodoTitle),
  notes: Schema.optional(TodoNotes),
  priority: Schema.optional(TodoPriority),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  dueDate: Schema.optional(Schema.NullOr(TodoDueDate)),
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  /** Set with threadId when linking an existing chat; a threadId change alone clears it. */
  delegationBaseTurnId: Schema.optional(Schema.NullOr(TurnId)),
  completed: Schema.optional(Schema.Boolean),
  /**
   * Applies the patch only while the to-do is still linked to this chat (null: to none),
   * so two windows delegating the same to-do can't both claim it.
   */
  expectedThreadId: Schema.optional(Schema.NullOr(ThreadId)),
});
export type TodoUpdateInput = typeof TodoUpdateInput.Type;

export const TodoDeleteInput = Schema.Struct({
  id: TodoId,
});
export type TodoDeleteInput = typeof TodoDeleteInput.Type;

export const TodoListResult = Schema.Struct({
  todos: Schema.Array(Todo),
});
export type TodoListResult = typeof TodoListResult.Type;

export const TodoStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    todos: Schema.Array(Todo),
  }),
  Schema.Struct({
    type: Schema.Literal("todo-upserted"),
    todo: Todo,
  }),
  Schema.Struct({
    type: Schema.Literal("todo-deleted"),
    todoId: TodoId,
  }),
]);
export type TodoStreamEvent = typeof TodoStreamEvent.Type;
