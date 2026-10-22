import {
  NOTION_WS_METHODS,
  WsRpcError,
  type NotionApi,
  type TodoStreamEvent,
} from "@synara/contracts";
import { Effect, Stream } from "effect";
import { CurrentWsSessionRole } from "../wsConnectionSessions";
import { requireWsOwnerSession } from "../wsOwnerAuthorization";
import type { TodoServiceShape } from "../todo/Services/TodoService";
import { TodoServiceError } from "../todo/Errors";
import type { NotionIntegrationShape } from "./Services/NotionIntegration";
import { NotionFailure } from "./client";

/** Connection ownership is supplied by the authenticated socket, never by RPC input. */
export function makeNotionHandlers(integration: NotionIntegrationShape | null) {
  const call = <A>(run: () => Promise<A>) =>
    requireWsOwnerSession.pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: run,
          catch: (error) =>
            new WsRpcError({
              message:
                error instanceof NotionFailure
                  ? error.message
                  : "Notion could not complete this request. Review its connection and source schema.",
              retryable: false,
            }),
        }),
      ),
    );
  const runtime = () => {
    if (!integration?.runtime)
      throw new NotionFailure(
        "Notion is unavailable. Check the hosted OAuth broker and protected storage.",
        "unavailable",
      );
    return integration.runtime;
  };
  const state: NotionApi["state"] = async () =>
    integration?.state() ?? {
      configured: false,
      connections: [],
      mappings: [],
      changes: [],
      syncing: false,
      lastSyncedAt: null,
      syncError: "This server does not provide the Notion integration.",
    };
  return {
    [NOTION_WS_METHODS.state]: () => call(state),
    [NOTION_WS_METHODS.connect]: () => call(() => runtime().connect()),
    [NOTION_WS_METHODS.complete]: (input: Parameters<NotionApi["complete"]>[0]) =>
      call(() => runtime().complete(input)),
    [NOTION_WS_METHODS.disconnect]: (input: Parameters<NotionApi["disconnect"]>[0]) =>
      call(() => runtime().disconnect(input)),
    [NOTION_WS_METHODS.read]: (input: Parameters<NotionApi["read"]>[0]) =>
      call(() => runtime().read(input)),
    [NOTION_WS_METHODS.write]: (input: Parameters<NotionApi["write"]>[0]) =>
      call(() => runtime().write(input)),
    [NOTION_WS_METHODS.saveMapping]: (input: Parameters<NotionApi["saveMapping"]>[0]) =>
      call(() => runtime().saveMapping(input)),
    [NOTION_WS_METHODS.deleteMapping]: (input: Parameters<NotionApi["deleteMapping"]>[0]) =>
      call(() => runtime().deleteMapping(input)),
    [NOTION_WS_METHODS.sync]: () => call(() => runtime().sync()),
    [NOTION_WS_METHODS.resolve]: (input: Parameters<NotionApi["resolve"]>[0]) =>
      call(() => runtime().resolve(input)),
  };
}
const externalId = (id: string) => id.startsWith("notion:");
export function filterClientTodoEvent(event: TodoStreamEvent): TodoStreamEvent | null {
  switch (event.type) {
    case "snapshot":
      return { ...event, todos: event.todos.filter((todo) => !externalId(todo.id)) };
    case "todo-upserted":
      return externalId(event.todo.id) ? null : event;
    case "todo-deleted":
      return externalId(event.todoId) ? null : event;
  }
}
/** Native task access is unchanged. Provider data remains private to the connecting owner. */
export function ownerScopedNotionTodos(todos: TodoServiceShape): TodoServiceShape {
  return {
    ...todos,
    list: () =>
      Effect.gen(function* () {
        const role = yield* CurrentWsSessionRole;
        const result = yield* todos.list();
        return role === "owner"
          ? result
          : { todos: result.todos.filter((todo) => !externalId(todo.id)) };
      }),
    update: (input) =>
      externalId(input.id)
        ? requireWsOwnerSession.pipe(
            Effect.mapError((error) => new TodoServiceError({ message: error.message })),
            Effect.andThen(todos.update(input)),
          )
        : todos.update(input),
    delete: (input) =>
      externalId(input.id)
        ? requireWsOwnerSession.pipe(
            Effect.mapError((error) => new TodoServiceError({ message: error.message })),
            Effect.andThen(todos.delete(input)),
          )
        : todos.delete(input),
    streamChanges: Stream.unwrap(
      Effect.gen(function* () {
        const role = yield* CurrentWsSessionRole;
        return role === "owner"
          ? todos.streamChanges
          : todos.streamChanges.pipe(
              Stream.map(filterClientTodoEvent),
              Stream.filter((event): event is TodoStreamEvent => event !== null),
            );
      }),
    ),
  };
}
