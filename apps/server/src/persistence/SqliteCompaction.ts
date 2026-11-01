import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Effect } from "effect";

import { runProcess } from "../processRunner.ts";
import {
  PRIVATE_FILE_MODE,
  sameFileIdentity,
  syncDirectoryEntry,
  syncRegularFile,
} from "../privatePathPermissions.ts";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "./DatabaseLifecycleLock.ts";
import { requireNoPendingMigrationRecovery } from "./MigrationBackup.ts";

// The child only builds and verifies a copy. The lock-owning parent alone may
// install it, so killing the command cannot leave an orphan child replacing data.
const compactCopySource = String.raw`
const fs = await import("node:fs/promises");
const path = await import("node:path");
const { DatabaseSync } = await import("node:sqlite");
const [sourcePath, destinationPath] = process.argv.slice(1);
let source;
let destination;
let result;
try {
  const before = await fs.lstat(sourcePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Database is not a regular file");
  source = new DatabaseSync(sourcePath);
  source.exec("PRAGMA busy_timeout=100;");
  // Open/recover WAL in NORMAL mode first so SQLite owns any stale SHM. Going
  // EXCLUSIVE before the first WAL read bypasses it and leaves the old file.
  if (source.prepare("PRAGMA journal_mode=DELETE").get().journal_mode !== "delete") {
    throw new Error("Database WAL could not be retired; stop every process using it");
  }
  source.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
  const pages = source.prepare("PRAGMA page_count").get().page_count;
  const free = source.prepare("PRAGMA freelist_count").get().freelist_count;
  const pageSize = source.prepare("PRAGMA page_size").get().page_size;
  const mode = source.prepare("PRAGMA auto_vacuum").get().auto_vacuum;
  const liveBytes = (pages - free) * pageSize;
  // VACUUM INTO only needs a compact output, not a second full-size journal.
  // This is an admission estimate: SQLite still handles disk-full atomically.
  const required = Math.ceil(liveBytes * 1.25) + 64 * 1024 * 1024;
  const disk = await fs.statfs(path.dirname(sourcePath));
  const available = Number(disk.bavail) * Number(disk.bsize);
  if (!Number.isSafeInteger(required) || required < 0 || !Number.isFinite(available) || available < required) {
    throw new Error("Insufficient free space for a compact copy: requires approximately " + required + " bytes; available " + available + " bytes. Free space on this volume before retrying.");
  }
  const checkpoint = source.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (checkpoint.busy !== 0) throw new Error("Database WAL is busy; stop every process using it");
  const metadata = source.prepare("SELECT user_version, application_id FROM pragma_user_version(), pragma_application_id()").get();
  const tables = source.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const counts = tables.map(({name}) => [name, source.prepare('SELECT count(*) AS count FROM "' + name.replaceAll('"','""') + '"').get().count]);
  if (mode === 0) source.exec("PRAGMA auto_vacuum=INCREMENTAL;");
  source.exec("PRAGMA synchronous=FULL;");
  source.prepare("VACUUM INTO ?").run(destinationPath);
  destination = new DatabaseSync(destinationPath, { readOnly: true });
  const checks = destination.prepare("PRAGMA integrity_check").all();
  if (checks.length !== 1 || checks[0].integrity_check !== "ok") throw new Error("Compact copy failed integrity_check");
  const copiedMetadata = destination.prepare("SELECT user_version, application_id FROM pragma_user_version(), pragma_application_id()").get();
  if (JSON.stringify(metadata) !== JSON.stringify(copiedMetadata)) throw new Error("Compact copy changed database metadata");
  if (destination.prepare("PRAGMA auto_vacuum").get().auto_vacuum !== (mode || 2)) throw new Error("Compact copy has an unexpected auto_vacuum policy");
  for (const [name, count] of counts) {
    if (destination.prepare('SELECT count(*) AS count FROM "' + name.replaceAll('"','""') + '"').get().count !== count) {
      throw new Error("Compact copy changed a table row count");
    }
  }
  destination.close();
  destination = undefined;
  source.close();
  source = undefined;
  const after = await fs.lstat(sourcePath);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("Database identity changed during compaction");
  result = { beforeBytes: after.size, afterBytes: (await fs.stat(destinationPath)).size, source: { dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs } };
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  destination?.close();
  source?.close();
}
if (result) console.log(JSON.stringify(result));
`;

export type SqliteCompactionResult = {
  readonly beforeBytes: number;
  readonly afterBytes: number;
};

/** Explicit offline maintenance. Never called from startup or normal shutdown. */
export const compactSqliteDatabase = (dbPath: string, signal?: AbortSignal) =>
  Effect.gen(function* () {
    let installed: SqliteCompactionResult | undefined;
    if (!path.isAbsolute(dbPath))
      return yield* Effect.fail(new Error("Database path must be absolute"));
    const sourceStat = yield* Effect.tryPromise(() => fs.lstat(dbPath));
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      return yield* Effect.fail(new Error("Database is not a regular file"));
    }
    return yield* Effect.acquireUseRelease(
      acquireDatabaseLifecycleLock(dbPath),
      (lock) =>
        Effect.gen(function* () {
          yield* requireNoPendingMigrationRecovery(lock.dbPath);
          return yield* Effect.tryPromise({
            try: async () => {
              signal?.throwIfAborted();
              // The existing lifecycle-lock reaper removes this private copy if its
              // owning process crashes. No unowned directory or backup is swept.
              const copyPath = path.join(lock.lockPath, "compact.sqlite");
              const copy = await fs.open(copyPath, "wx", PRIVATE_FILE_MODE);
              const copyStat = await copy.stat();
              await copy.close();
              const { stdout, stderr, code, timedOut } = await runProcess(
                process.execPath,
                ["--input-type=module", "-e", compactCopySource, lock.dbPath, copyPath],
                {
                  timeoutMs: 15 * 60 * 1000,
                  maxBufferBytes: 8192,
                  outputMode: "truncate",
                  signal,
                  allowNonZeroExit: true,
                  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
                },
              );
              if (timedOut || code !== 0)
                throw new Error(
                  stderr.trim() ||
                    "Compact copy process did not complete within its 15-minute deadline",
                );
              const result = JSON.parse(stdout) as SqliteCompactionResult & {
                source: {
                  dev: number;
                  ino: number;
                  size: number;
                  mtimeMs: number;
                  ctimeMs: number;
                };
              };
              const current = await fs.lstat(lock.dbPath);
              const candidate = await fs.lstat(copyPath);
              if (
                !current.isFile() ||
                current.isSymbolicLink() ||
                !candidate.isFile() ||
                candidate.isSymbolicLink() ||
                !sameFileIdentity(sourceStat, current) ||
                !sameFileIdentity(result.source, current) ||
                !sameFileIdentity(copyStat, candidate) ||
                current.size !== result.source.size ||
                current.mtimeMs !== result.source.mtimeMs ||
                current.ctimeMs !== result.source.ctimeMs ||
                result.beforeBytes !== current.size ||
                result.afterBytes !== candidate.size
              )
                throw new Error("Database or compact copy changed before installation");
              // Never attach an old WAL/journal to a replacement database, and never
              // delete sidecars to make this check pass. SQLite must close them itself.
              for (const suffix of ["-wal", "-shm", "-journal"]) {
                try {
                  await fs.lstat(`${lock.dbPath}${suffix}`);
                } catch (cause) {
                  if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
                  throw cause;
                }
                throw new Error(
                  "Database sidecar remains; stop every process using it before retrying",
                );
              }
              await syncRegularFile(copyPath);
              await syncDirectoryEntry(lock.lockPath);
              signal?.throwIfAborted();
              // Atomic same-volume rename is the commit point. Both files are closed
              // and the copy is durable first; interruption leaves either valid file.
              await fs.rename(copyPath, lock.dbPath);
              installed = { beforeBytes: result.beforeBytes, afterBytes: result.afterBytes };
              await syncDirectoryEntry(path.dirname(lock.dbPath));
              return installed;
            },
            catch: (cause) => cause,
          });
        }),
      releaseDatabaseLifecycleLock,
    ).pipe(
      Effect.catch((cause) =>
        installed
          ? Effect.fail(
              new Error(
                `Compact database installed (${installed.beforeBytes} → ${installed.afterBytes} bytes), but final durability or lock cleanup could not be confirmed. Keep Synara closed and inspect the database before retrying. ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
            )
          : Effect.fail(cause),
      ),
    );
  }).pipe(Effect.uninterruptible);
