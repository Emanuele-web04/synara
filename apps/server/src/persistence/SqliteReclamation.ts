// Owns bounded reclamation on the live connection and legacy conversion after it closes.
// The lifecycle layer keeps its lock until the isolated shutdown helper has exited.
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { runProcess } from "../processRunner.ts";

// Keep each live pass small; unlike FULL, INCREMENTAL does not move pages on every delete.
export const reclaimFreedSqlitePages = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly freeBytes: number; readonly freePages: number }>`
      SELECT freelist_count * page_size AS "freeBytes", freelist_count AS "freePages"
      FROM pragma_freelist_count(), pragma_page_size()
    `;
    if ((rows[0]?.freeBytes ?? 0) < 1024 * 1024) return;
    // node:sqlite's Statement.run() only steps this zero-column PRAGMA once.
    // One-page statements make the work bound identical under Node and Bun.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (let page = 0; page < Math.min(rows[0]?.freePages ?? 0, 256); page += 1) {
          yield* sql`PRAGMA incremental_vacuum(1)`;
        }
      }),
    );
    // A completed checkpoint applies the smaller database size to the main file.
    // PASSIVE never waits for readers; ordinary WAL policy remains unchanged.
    yield* sql`PRAGMA wal_checkpoint(PASSIVE)`;
  });

// Static source avoids a second packaged entrypoint and runs under both supported runtimes.
// Filename data is passed in argv, never interpolated into executable source.
const legacyReclamationSource = String.raw`
const fs = await import("node:fs/promises");
const path = await import("node:path");
const { DatabaseSync } = await import("node:sqlite");
const dbPath = process.argv[1];
let db;
try {
  const file = await fs.lstat(dbPath);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error("Database is not a regular file");
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE;");
  const mode = db.prepare("PRAGMA auto_vacuum").get().auto_vacuum;
  if (mode !== 0) {
    console.log(JSON.stringify({ status: "not-needed" }));
  } else {
    const pages = db.prepare("PRAGMA page_count").get().page_count;
    const free = db.prepare("PRAGMA freelist_count").get().freelist_count;
    const pageSize = db.prepare("PRAGMA page_size").get().page_size;
    const freeBytes = free * pageSize;
    if (freeBytes < 16 * 1024 * 1024 || free < pages / 4) {
      console.log(JSON.stringify({ status: "not-needed" }));
    } else {
      const disk = await fs.statfs(path.dirname(dbPath));
      const available = Number(disk.bavail) * Number(disk.bsize);
      const required = 2 * Math.max(file.size, pages * pageSize) + 64 * 1024 * 1024;
      // VACUUM may require twice the original file, not merely its retained rows.
      if (!Number.isFinite(available) || available < required) {
        console.log(JSON.stringify({ status: "insufficient-space", required, available }));
      } else {
        db.exec("PRAGMA auto_vacuum=INCREMENTAL; VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
        console.log(JSON.stringify({ status: "reclaimed", freeBytes }));
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  db?.close();
}
`;

// Called only after successful migration/setup and after the live SQL connection closes.
// A process (not a worker thread) lets the existing timeout kill native SQLite work.
export const reclaimLegacySqliteDatabase = (dbPath: string) =>
  Effect.tryPromise(() =>
    runProcess(process.execPath, ["--input-type=module", "-e", legacyReclamationSource, dbPath], {
      // Windows starts forcing backend exit at eight seconds. Leave room for other finalizers.
      timeoutMs: 1500,
      maxBufferBytes: 4096,
      outputMode: "truncate",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    }),
  ).pipe(
    Effect.flatMap(({ stdout }) =>
      stdout.includes('"status":"insufficient-space"')
        ? Effect.logWarning("SQLite reclamation deferred: insufficient free disk space")
        : Effect.void,
    ),
    Effect.catch((cause) => Effect.logWarning("SQLite shutdown reclamation deferred", { cause })),
  );
