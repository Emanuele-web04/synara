import {
  ProjectId,
  TODO_TITLE_MAX_LENGTH,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { TodoRepositoryLive } from "../persistence/Layers/TodoRepository.ts";
import { TodoServiceLive } from "../todo/Layers/TodoService.ts";
import { TodoService, type TodoServiceShape } from "../todo/Services/TodoService.ts";
import type { McpToolCallResult } from "./protocol.ts";
import { makeAgentGatewayTodoTools } from "./todoTools.ts";
import type { ToolContext, ToolEntry } from "./toolRuntime.ts";

const PROJECTS = [
  { id: "project-a", kind: "project", title: "Project A", workspaceRoot: "/repos/project-a" },
  { id: "project-b", kind: "project", title: "Project B", workspaceRoot: "/repos/project-b" },
  // The service is shared by every test here, so the list test files under its own project.
  { id: "project-list", kind: "project", title: "Listed", workspaceRoot: "/repos/listed" },
  { id: "project-chat", kind: "chat", title: "Chats", workspaceRoot: "/home/tester/chats" },
] as const;

const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "gateway-session:todo",
    threadId: "thread-caller",
    provider: "claudeAgent",
    turnId: "turn-caller",
  },
  callerThreadId: "thread-caller",
  callerThreadLabel: "Caller",
  callerSessionKey: "gateway-session:todo",
  callerProvider: "claudeAgent",
  callerCapabilities: new Set(["thread:read", "thread:write"]),
  callerTurnId: "turn-caller",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};

function makeTools(todos: TodoServiceShape, callerProjectId = "project-a") {
  const tools = makeAgentGatewayTodoTools({
    todos,
    snapshotQuery: {
      getProjectShellById: (projectId) =>
        Effect.succeed(
          Option.fromNullishOr(
            PROJECTS.find((project) => project.id === projectId) as
              | OrchestrationProjectShell
              | undefined,
          ),
        ),
    },
    workspacePaths: { homeDir: "/home/tester", chatWorkspaceRoot: "/home/tester/chats" },
    requireThreadShell: (threadId) =>
      Effect.succeed({
        id: ThreadId.makeUnsafe(threadId),
        projectId: ProjectId.makeUnsafe(callerProjectId),
      } as OrchestrationThreadShell),
  });
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const call = (name: string, args: Record<string, unknown>) =>
    (byName.get(name) as ToolEntry).handler(args, context);
  return { byName, call };
}

function resultText(result: McpToolCallResult): string {
  const content = result.content[0];
  return content?.type === "text" ? content.text : "";
}

function resultJson(result: McpToolCallResult) {
  assert.isNotTrue(result.isError, resultText(result));
  return JSON.parse(resultText(result));
}

const ids = (result: { todos: Array<{ id: string }> }) => result.todos.map((todo) => todo.id);

const layer = it.layer(
  TodoServiceLive.pipe(
    Layer.provideMerge(TodoRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("agent gateway to-do tools", (it) => {
  it.effect("offers writes only to a caller with an active turn and write access", () =>
    Effect.gen(function* () {
      const { byName } = makeTools(yield* TodoService);

      assert.deepStrictEqual(
        [...byName.keys()],
        ["synara_create_todo", "synara_list_todos", "synara_update_todo"],
      );
      for (const name of ["synara_create_todo", "synara_update_todo"]) {
        assert.strictEqual(byName.get(name)?.requiredCapability, "thread:write");
        assert.isTrue(byName.get(name)?.requiresActiveTurn);
      }
      assert.strictEqual(byName.get("synara_list_todos")?.requiredCapability, "thread:read");
    }),
  );

  it.effect("adds a to-do under the caller's project and stores it for the Tasks view", () =>
    Effect.gen(function* () {
      const todos = yield* TodoService;
      const { call } = makeTools(todos);

      const { todo } = resultJson(
        yield* call("synara_create_todo", {
          requestId: "create-default",
          title: "  Fix the scroll jump  ",
          notes: "Happens after a reconnect.",
          priority: "high",
          dueDate: "2026-10-12",
        }),
      );

      assert.strictEqual(todo.title, "Fix the scroll jump");
      assert.strictEqual(todo.projectId, "project-a");
      assert.strictEqual(todo.completed, false);
      assert.strictEqual(todo.threadId, null);
      const stored = (yield* todos.list()).todos.find((candidate) => candidate.id === todo.id);
      assert.deepInclude(stored, {
        title: "Fix the scroll jump",
        notes: "Happens after a reconnect.",
        priority: "high",
        dueDate: "2026-10-12",
        projectId: ProjectId.makeUnsafe("project-a"),
      });
    }),
  );

  it.effect("returns the same to-do when a create is retried", () =>
    Effect.gen(function* () {
      const todos = yield* TodoService;
      const { call } = makeTools(todos);
      const args = { requestId: "create-retry", title: "Renew the certificate" };

      const first = resultJson(yield* call("synara_create_todo", args)).todo;
      const retried = resultJson(yield* call("synara_create_todo", args)).todo;
      const reused = yield* call("synara_create_todo", { ...args, title: "Another to-do" });

      assert.strictEqual(retried.id, first.id);
      assert.isTrue(reused.isError);
      assert.include(resultText(reused), "Use a new requestId");
      const titles = (yield* todos.list()).todos.map((todo) => todo.title);
      assert.strictEqual(titles.filter((title) => title === "Renew the certificate").length, 1);
      assert.notInclude(titles, "Another to-do");
    }),
  );

  it.effect("files a to-do under no project, another project, or none for a container", () =>
    Effect.gen(function* () {
      const todos = yield* TodoService;

      const personal = resultJson(
        yield* makeTools(todos).call("synara_create_todo", {
          requestId: "create-personal",
          title: "Call the dentist",
          projectId: null,
        }),
      ).todo;
      const elsewhere = resultJson(
        yield* makeTools(todos).call("synara_create_todo", {
          requestId: "create-elsewhere",
          title: "Bump the SDK",
          projectId: "project-b",
        }),
      ).todo;
      const fromChat = resultJson(
        yield* makeTools(todos, "project-chat").call("synara_create_todo", {
          requestId: "create-from-chat",
          title: "Read the changelog",
        }),
      ).todo;

      assert.strictEqual(personal.projectId, null);
      assert.strictEqual(elsewhere.projectId, "project-b");
      assert.strictEqual(fromChat.projectId, null);
    }),
  );

  it.effect("refuses a bad create without storing anything", () =>
    Effect.gen(function* () {
      const todos = yield* TodoService;
      const { call } = makeTools(todos);
      const before = (yield* todos.list()).todos.length;

      const results = [
        yield* call("synara_create_todo", { title: "No request id" }),
        yield* call("synara_create_todo", { requestId: "bad-blank", title: "   " }),
        yield* call("synara_create_todo", {
          requestId: "bad-long",
          title: "x".repeat(TODO_TITLE_MAX_LENGTH + 1),
        }),
        yield* call("synara_create_todo", {
          requestId: "bad-date",
          title: "Impossible day",
          dueDate: "2026-02-31",
        }),
        yield* call("synara_create_todo", {
          requestId: "bad-project",
          title: "Unknown project",
          projectId: "project-missing",
        }),
        yield* call("synara_create_todo", {
          requestId: "bad-container",
          title: "Container project",
          projectId: "project-chat",
        }),
      ];

      for (const result of results) {
        assert.isTrue(result.isError, resultText(result));
      }
      assert.strictEqual((yield* todos.list()).todos.length, before);
    }),
  );

  it.effect("lists open to-dos, with filters and a notes preview", () =>
    Effect.gen(function* () {
      const todos = yield* TodoService;
      const { call } = makeTools(todos);
      const longNotes = "n".repeat(900);
      const open = resultJson(
        yield* call("synara_create_todo", {
          requestId: "list-open",
          title: "List: open",
          notes: longNotes,
          projectId: "project-list",
        }),
      ).todo;
      const done = resultJson(
        yield* call("synara_create_todo", { requestId: "list-done", title: "List: done" }),
      ).todo;
      yield* todos.update({ id: done.id, completed: true });

      const listed = resultJson(yield* call("synara_list_todos", {}));
      const withDone = resultJson(yield* call("synara_list_todos", { includeCompleted: true }));
      const inProject = resultJson(yield* call("synara_list_todos", { projectId: "project-list" }));
      const one = resultJson(yield* call("synara_list_todos", { todoId: open.id }));
      const missing = yield* call("synara_list_todos", { todoId: "todo:missing" });
      assert.include(ids(listed), open.id);
      assert.notInclude(ids(listed), done.id);
      assert.include(ids(withDone), done.id);
      assert.deepStrictEqual(ids(inProject), [open.id]);
      assert.strictEqual(inProject.truncated, false);
      assert.strictEqual(inProject.todos[0].notes.length, 500);
      assert.isTrue(inProject.todos[0].notesTruncated);
      assert.strictEqual(one.todos[0].notes, longNotes);
      assert.isUndefined(one.todos[0].notesTruncated);
      assert.isTrue(missing.isError);
    }),
  );

  it.effect("edits a to-do and marks it done, but never links it to a chat", () =>
    Effect.gen(function* () {
      const todos = yield* TodoService;
      const { call } = makeTools(todos);
      const created = resultJson(
        yield* call("synara_create_todo", {
          requestId: "update-target",
          title: "Draft the release notes",
          dueDate: "2026-10-15",
        }),
      ).todo;

      const edited = resultJson(
        yield* call("synara_update_todo", {
          todoId: created.id,
          title: "Publish the release notes",
          priority: "urgent",
          dueDate: null,
          projectId: null,
          completed: true,
          threadId: "thread-caller",
        }),
      ).todo;

      assert.deepInclude(edited, {
        id: created.id,
        title: "Publish the release notes",
        priority: "urgent",
        dueDate: null,
        projectId: null,
        completed: true,
        threadId: null,
      });
      const reopened = resultJson(
        yield* call("synara_update_todo", { todoId: created.id, completed: false }),
      ).todo;
      assert.strictEqual(reopened.completed, false);
      assert.strictEqual(reopened.title, "Publish the release notes");
    }),
  );

  it.effect("refuses an update that changes nothing or names no stored to-do", () =>
    Effect.gen(function* () {
      const todos = yield* TodoService;
      const { call } = makeTools(todos);
      const created = resultJson(
        yield* call("synara_create_todo", { requestId: "update-refused", title: "Keep as is" }),
      ).todo;

      const nothing = yield* call("synara_update_todo", { todoId: created.id });
      const onlyLink = yield* call("synara_update_todo", {
        todoId: created.id,
        threadId: "thread-caller",
      });
      const badProject = yield* call("synara_update_todo", {
        todoId: created.id,
        projectId: "project-missing",
      });
      const unknown = yield* call("synara_update_todo", {
        todoId: "todo:missing",
        title: "Nobody home",
      });

      for (const result of [nothing, onlyLink, badProject, unknown]) {
        assert.isTrue(result.isError, resultText(result));
      }
      const stored = (yield* todos.list()).todos.find((todo) => todo.id === created.id);
      assert.deepInclude(stored, {
        title: "Keep as is",
        projectId: ProjectId.makeUnsafe("project-a"),
        threadId: null,
      });
    }),
  );
});
