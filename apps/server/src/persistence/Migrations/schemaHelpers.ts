import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

// checks table metadata without relying on driver-specific duplicate-column errors
export const columnExists = (sql: SqlClient.SqlClient, tableName: string, columnName: string) =>
  sql<{ readonly exists: number }>`
    SELECT EXISTS(
      SELECT 1
      FROM pragma_table_info(${tableName})
      WHERE name = ${columnName}
    ) AS "exists"
  `.pipe(Effect.map(([row]) => row?.exists === 1));

// base tables only — a rebuild/retire migration must guard on the pre-state, which a same-named view wouldn't satisfy
export const tableExists = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly exists: number }>`
    SELECT EXISTS(
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = ${tableName}
    ) AS "exists"
  `.pipe(Effect.map(([row]) => row?.exists === 1));

// primary-key columns in order — rebuilds that only change key shape use this to recognize their own post-state
export const primaryKeyColumns = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info(${tableName})
    WHERE pk > 0
    ORDER BY pk ASC
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));
