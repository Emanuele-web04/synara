// FILE: schemaHelpers.ts
// Purpose: Shared SQLite schema-introspection helpers for idempotent migrations.
// Layer: Server persistence migrations
// Exports: columnExists, primaryKeyColumns, tableExists

import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

// Checks SQLite table metadata without relying on driver-specific duplicate-column errors.
export const columnExists = (sql: SqlClient.SqlClient, tableName: string, columnName: string) =>
  sql<{ readonly exists: number }>`
    SELECT EXISTS(
      SELECT 1
      FROM pragma_table_info(${tableName})
      WHERE name = ${columnName}
    ) AS "exists"
  `.pipe(Effect.map(([row]) => row?.exists === 1));

export const tableExists = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly exists: number }>`
    SELECT EXISTS(
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = ${tableName}
    ) AS "exists"
  `.pipe(Effect.map(([row]) => row?.exists === 1));

export const primaryKeyColumns = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly name: string; readonly position: number }>`
    SELECT name, pk AS "position"
    FROM pragma_table_info(${tableName})
    WHERE pk > 0
    ORDER BY pk
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));
