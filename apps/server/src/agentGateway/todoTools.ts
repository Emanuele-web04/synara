import { createHash } from "node:crypto";

import {
  ProjectId,
  TODO_NOTES_MAX_LENGTH,
  TODO_TITLE_MAX_LENGTH,
  TodoCreateInput,
  TodoId,
  TodoPriority,
  TodoUpdateInput,
  type OrchestrationThreadShell,
  type Todo,
} from "@synara/contracts";
import { Effect, Option, Schema } from "effect";

import {
  isOrdinaryProjectRow,
  type SpaceAssignmentWorkspacePaths,
} from "../orchestration/commandInvariants.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { TodoServiceShape } from "../todo/Services/TodoService.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { ToolInputError, errorText, readBooleanArg, readStringArg } from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime.ts";

export interface TodoToolsInput {
  readonly todos: TodoServiceShape;
  readonly snapshotQuery: Pick<ProjectionSnapshotQueryShape, "getProjectShellById">;
  readonly workspacePaths: SpaceAssignmentWorkspacePaths;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown, never>;
}

/**
 * Hard cap on the to-dos one `synara_list_todos` response carries. Past it the
 * read reports `truncated: true` so the caller narrows by project instead.
 */
const MAX_LISTED_TODOS = 200;
/** A list row carries a notes preview; selecting one to-do by id returns its notes whole. */
const LISTED_NOTES_PREVIEW_CHARS = 500;

const TODO_FIELD_PROPERTIES = {
  title: {
    type: "string",
    maxLength: TODO_TITLE_MAX_LENGTH,
    description: "What needs doing, as one line.",
  },
  notes: {
    type: "string",
    maxLength: TODO_NOTES_MAX_LENGTH,
    description: "Optional details. An agent the to-do is later handed to receives them.",
  },
  priority: { type: "string", enum: TodoPriority.literals },
} as const;

/**
 * The to-do id a create request maps to. Derived from the caller's thread and its
 * requestId, so a retried call lands on the to-do the first one stored instead of
 * adding a second.
 */
function todoIdForRequest(callerThreadId: string, requestId: string): TodoId {
  const digest = createHash("sha256").update(`${callerThreadId}\n${requestId}`).digest("hex");
  return TodoId.makeUnsafe(`todo:${digest.slice(0, 32)}`);
}

/** Copies the listed args that were sent; null counts as sent only for `nullable` keys. */
function pickSentArgs(
  args: Record<string, unknown>,
  keys: ReadonlyArray<string>,
  nullable: ReadonlyArray<string> = [],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const value = args[key];
    if (value === undefined || (value === null && !nullable.includes(key))) continue;
    picked[key] = value;
  }
  return picked;
}

function toToolTodo(todo: Todo, options?: { readonly previewNotes?: boolean }) {
  const cutsNotes =
    options?.previewNotes === true && todo.notes.length > LISTED_NOTES_PREVIEW_CHARS;
  return {
    id: todo.id,
    title: todo.title,
    notes: cutsNotes ? todo.notes.slice(0, LISTED_NOTES_PREVIEW_CHARS) : todo.notes,
    ...(cutsNotes ? { notesTruncated: true } : {}),
    priority: todo.priority,
    projectId: todo.projectId,
    dueDate: todo.dueDate,
    // The chat the user handed this to-do to, when there is one.
    threadId: todo.threadId,
    completed: todo.completedAt !== null,
    completedAt: todo.completedAt,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
  };
}

export function makeAgentGatewayTodoTools(input: TodoToolsInput): ReadonlyArray<ToolEntry> {
  const { todos, snapshotQuery, workspacePaths, requireThreadShell } = input;

  // Tool args are untrusted agent input: the arg readers and the contract schemas
  // throw on a bad value, and this turns that into a tool error.
  const readArgs = <A>(read: () => A): Effect.Effect<A, ToolInputError> =>
    Effect.try({
      try: read,
      catch: (error) =>
        error instanceof ToolInputError
          ? error
          : new ToolInputError(`Invalid tool input: ${errorText(error)}`),
    });

  const toToolError = (error: unknown) => new ToolInputError(errorText(error));

  /** The project when it is one the Tasks view lists; null for a container or a missing row. */
  const findOrdinaryProject = (projectId: ProjectId) =>
    snapshotQuery.getProjectShellById(projectId).pipe(
      Effect.mapError(toToolError),
      Effect.map((project) =>
        Option.isSome(project) &&
        isOrdinaryProjectRow({
          projectKind: project.value.kind,
          projectTitle: project.value.title,
          projectWorkspaceRoot: project.value.workspaceRoot,
          workspacePaths,
        })
          ? project.value.id
          : null,
      ),
    );

  /** A project the caller named must be one the user can see a to-do filed under. */
  const requireOrdinaryProject = (rawProjectId: unknown) =>
    Effect.gen(function* () {
      if (typeof rawProjectId !== "string" || rawProjectId.trim().length === 0) {
        return yield* Effect.fail(
          new ToolInputError(`Argument "projectId" must be a non-empty string or null.`),
        );
      }
      const projectId = yield* findOrdinaryProject(ProjectId.makeUnsafe(rawProjectId.trim()));
      if (projectId === null) {
        return yield* Effect.fail(
          new ToolInputError(
            `Project "${rawProjectId.trim()}" was not found. Use synara_list_projects, or pass null for a to-do with no project.`,
          ),
        );
      }
      return projectId;
    });

  /**
   * Where a new to-do is filed: the named project, none when the caller passed null,
   * and otherwise the caller's own project. A caller in a managed chat or Studio
   * container has no project the Tasks view lists, so its to-dos are filed under none.
   */
  const resolveNewTodoProject = (rawProjectId: unknown, callerThreadId: string) => {
    if (rawProjectId === null) return Effect.succeed(null);
    if (rawProjectId !== undefined) return requireOrdinaryProject(rawProjectId);
    return requireThreadShell(callerThreadId).pipe(
      Effect.mapError(toToolError),
      Effect.flatMap((caller) => findOrdinaryProject(caller.projectId)),
    );
  };

  const createTodo: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_create_todo",
      description:
        "Add a to-do to the user's Tasks list, also shown in Inbox when due. Use it when the user asks to note, remember, or add a task or to-do for later. It records the to-do only: no thread is created and no agent starts working. To start work now use synara_create_thread; for scheduled or recurring work use synara_create_automation. requestId is required and a retry with the same requestId returns the same to-do.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", maxLength: 256, description: "Idempotency key." },
          ...TODO_FIELD_PROPERTIES,
          priority: { ...TODO_FIELD_PROPERTIES.priority, description: 'Defaults to "none".' },
          dueDate: {
            type: "string",
            description: "Due day in the user's calendar, as YYYY-MM-DD.",
          },
          projectId: {
            type: ["string", "null"],
            description:
              "Project the to-do is filed under. Defaults to your own thread's project; pass null when the to-do is not about that project.",
          },
        },
        required: ["requestId", "title"],
        additionalProperties: false,
      },
      annotations: {
        title: "Add a to-do",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const requestId = yield* readArgs(
          () => readStringArg(args, "requestId", { required: true })!,
        );
        const projectId = yield* resolveNewTodoProject(args.projectId, context.callerThreadId);
        const fields = yield* readArgs(() =>
          Schema.decodeUnknownSync(TodoCreateInput)({
            id: todoIdForRequest(context.callerThreadId, requestId),
            ...pickSentArgs(args, ["title", "notes", "priority", "dueDate"]),
            projectId,
          }),
        );
        const todo = yield* todos.create(fields).pipe(Effect.mapError(toToolError));
        // A retried create returns the stored to-do. A different title means the
        // requestId was reused for another to-do, which would otherwise vanish silently.
        if (todo.title !== fields.title) {
          return yield* Effect.fail(
            new ToolInputError(
              `requestId "${requestId}" already created the to-do "${todo.title}". Use a new requestId for a different to-do.`,
            ),
          );
        }
        return mcpToolResultJson({ todo: toToolTodo(todo) });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const listTodos: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_list_todos",
      description: `List the user's to-dos from the Tasks list. Completed ones are hidden unless includeCompleted is true. Returns at most ${MAX_LISTED_TODOS} and reports truncated when there are more; notes are cut to ${LISTED_NOTES_PREVIEW_CHARS} characters unless todoId selects one to-do.`,
      inputSchema: {
        type: "object",
        properties: {
          includeCompleted: { type: "boolean" },
          projectId: {
            type: "string",
            description: "Only to-dos filed under this project.",
          },
          todoId: {
            type: "string",
            description: "Return only this to-do, completed or not, with its full notes.",
          },
        },
        additionalProperties: false,
      },
      annotations: { title: "List to-dos", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const filter = yield* readArgs(() => ({
          includeCompleted: readBooleanArg(args, "includeCompleted") ?? false,
          projectId: readStringArg(args, "projectId"),
          todoId: readStringArg(args, "todoId"),
        }));
        const all = (yield* todos.list().pipe(Effect.mapError(toToolError))).todos;
        if (filter.todoId !== undefined) {
          const todo = all.find((candidate) => candidate.id === filter.todoId);
          if (todo === undefined) {
            return yield* Effect.fail(
              new ToolInputError(`To-do "${filter.todoId}" was not found.`),
            );
          }
          return mcpToolResultJson({ todos: [toToolTodo(todo)], truncated: false });
        }
        const matching = all.filter(
          (todo) =>
            (filter.includeCompleted || todo.completedAt === null) &&
            (filter.projectId === undefined || todo.projectId === filter.projectId),
        );
        return mcpToolResultJson({
          todos: matching
            .slice(0, MAX_LISTED_TODOS)
            .map((todo) => toToolTodo(todo, { previewNotes: true })),
          truncated: matching.length > MAX_LISTED_TODOS,
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const updateTodo: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_update_todo",
      description:
        "Edit a to-do in the user's Tasks list, or mark it done or not done. Only the fields you send change. Get todoId from synara_list_todos. Handing a to-do to a chat and deleting it stay with the user in the Tasks view.",
      inputSchema: {
        type: "object",
        properties: {
          todoId: { type: "string" },
          ...TODO_FIELD_PROPERTIES,
          dueDate: {
            type: ["string", "null"],
            description: "Due day in the user's calendar, as YYYY-MM-DD. Pass null to clear it.",
          },
          projectId: {
            type: ["string", "null"],
            description: "Project the to-do is filed under. Pass null to file it under none.",
          },
          completed: {
            type: "boolean",
            description: "true marks the to-do done; false reopens it.",
          },
        },
        required: ["todoId"],
        additionalProperties: false,
      },
      annotations: { title: "Update a to-do", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const todoId = yield* readArgs(() => readStringArg(args, "todoId", { required: true })!);
        // Only these fields are the agent's to change: the chat link and its delegation
        // state are set by the user handing the to-do over in the Tasks view.
        const changes = pickSentArgs(
          args,
          ["title", "notes", "priority", "dueDate", "projectId", "completed"],
          ["dueDate", "projectId"],
        );
        if (Object.keys(changes).length === 0) {
          return yield* Effect.fail(
            new ToolInputError(
              "Nothing to update: send title, notes, priority, dueDate, projectId, or completed.",
            ),
          );
        }
        if ("projectId" in changes && changes.projectId !== null) {
          changes.projectId = yield* requireOrdinaryProject(changes.projectId);
        }
        const fields = yield* readArgs(() =>
          Schema.decodeUnknownSync(TodoUpdateInput)({ id: todoId, ...changes }),
        );
        const todo = yield* todos.update(fields).pipe(Effect.mapError(toToolError));
        return mcpToolResultJson({ todo: toToolTodo(todo) });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  return [createTodo, listTodos, updateTodo];
}
