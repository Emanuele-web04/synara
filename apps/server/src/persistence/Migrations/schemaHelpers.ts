// FILE: schemaHelpers.ts
// Purpose: Shared SQLite schema-introspection helpers for idempotent migrations.
// Layer: Server persistence migrations
// Exports: columnExists, tableExists, primaryKeyColumns

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

// Base tables only: a migration that rebuilds or retires a table must guard on
// the presence of the pre-state, which a same-named view would not satisfy.
export const tableExists = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly exists: number }>`
    SELECT EXISTS(
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = ${tableName}
    ) AS "exists"
  `.pipe(Effect.map(([row]) => row?.exists === 1));

// Primary-key columns in key order. Table rebuilds that only change the key
// shape use this to recognize their own post-state and skip a destructive replay.
export const primaryKeyColumns = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info(${tableName})
    WHERE pk > 0
    ORDER BY pk ASC
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));
