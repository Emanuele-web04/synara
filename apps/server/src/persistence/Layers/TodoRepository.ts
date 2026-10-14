import { Todo } from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  SaveTodoInput,
  TodoByIdInput,
  TodoRepository,
  type TodoRepositoryShape,
} from "../Services/TodoRepository.ts";

const makeTodoRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Todo,
    execute: () => sql`
      SELECT
        todo_id AS "id",
        title,
        notes,
        priority,
        project_id AS "projectId",
        due_date AS "dueDate",
        thread_id AS "threadId",
        delegation_base_turn_id AS "delegationBaseTurnId",
        linked_at AS "linkedAt",
        completed_at AS "completedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM todos
      ORDER BY created_at ASC, todo_id ASC
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: TodoByIdInput,
    Result: Todo,
    execute: ({ id }) => sql`
      SELECT
        todo_id AS "id",
        title,
        notes,
        priority,
        project_id AS "projectId",
        due_date AS "dueDate",
        thread_id AS "threadId",
        delegation_base_turn_id AS "delegationBaseTurnId",
        linked_at AS "linkedAt",
        completed_at AS "completedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM todos
      WHERE todo_id = ${id}
    `,
  });

  const insertRow = SqlSchema.findOneOption({
    Request: Todo,
    Result: Todo,
    execute: (todo) => sql`
      INSERT INTO todos (
        todo_id,
        title,
        notes,
        priority,
        project_id,
        due_date,
        thread_id,
        delegation_base_turn_id,
        linked_at,
        completed_at,
        created_at,
        updated_at
      )
      VALUES (
        ${todo.id},
        ${todo.title},
        ${todo.notes},
        ${todo.priority},
        ${todo.projectId},
        ${todo.dueDate},
        ${todo.threadId},
        ${todo.delegationBaseTurnId},
        ${todo.linkedAt},
        ${todo.completedAt},
        ${todo.createdAt},
        ${todo.updatedAt}
      )
      ON CONFLICT (todo_id) DO NOTHING
      RETURNING
        todo_id AS "id",
        title,
        notes,
        priority,
        project_id AS "projectId",
        due_date AS "dueDate",
        thread_id AS "threadId",
        delegation_base_turn_id AS "delegationBaseTurnId",
        linked_at AS "linkedAt",
        completed_at AS "completedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
  });

  const saveRow = SqlSchema.findOneOption({
    Request: SaveTodoInput,
    Result: Todo,
    execute: ({ todo, expectedUpdatedAt }) => sql`
      UPDATE todos SET
        title = ${todo.title},
        notes = ${todo.notes},
        priority = ${todo.priority},
        project_id = ${todo.projectId},
        due_date = ${todo.dueDate},
        thread_id = ${todo.threadId},
        delegation_base_turn_id = ${todo.delegationBaseTurnId},
        linked_at = ${todo.linkedAt},
        completed_at = ${todo.completedAt},
        updated_at = ${todo.updatedAt}
      WHERE todo_id = ${todo.id}
        AND updated_at = ${expectedUpdatedAt}
      RETURNING
        todo_id AS "id",
        title,
        notes,
        priority,
        project_id AS "projectId",
        due_date AS "dueDate",
        thread_id AS "threadId",
        delegation_base_turn_id AS "delegationBaseTurnId",
        linked_at AS "linkedAt",
        completed_at AS "completedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: TodoByIdInput,
    execute: ({ id }) => sql`
      DELETE FROM todos
      WHERE todo_id = ${id}
    `,
  });

  const list: TodoRepositoryShape["list"] = () =>
    listRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "TodoRepository.list:query",
          "TodoRepository.list:decodeRows",
        ),
      ),
    );

  const getById: TodoRepositoryShape["getById"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "TodoRepository.getById:query",
          "TodoRepository.getById:decodeRow",
        ),
      ),
    );

  const insert: TodoRepositoryShape["insert"] = (todo) =>
    insertRow(todo).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "TodoRepository.insert:query",
          "TodoRepository.insert:decodeRow",
        ),
      ),
    );

  const save: TodoRepositoryShape["save"] = (input) =>
    saveRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError("TodoRepository.save:query", "TodoRepository.save:decodeRow"),
      ),
    );

  const deleteTodo: TodoRepositoryShape["delete"] = (input) =>
    deleteRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "TodoRepository.delete:query",
          "TodoRepository.delete:encodeRequest",
        ),
      ),
    );

  return { list, getById, insert, save, delete: deleteTodo } satisfies TodoRepositoryShape;
});

export const TodoRepositoryLive = Layer.effect(TodoRepository, makeTodoRepository);
