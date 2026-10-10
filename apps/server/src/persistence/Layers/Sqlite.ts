import { totalmem } from "node:os";

import { Effect, Layer, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { MigrationSchemaTooNewError } from "../Errors.ts";
import {
  inspectPendingMigrationRecovery,
  reclaimOrphanedMigrationArtifacts,
  resumeMarkedMigration,
  runWithPreMigrationBackup,
  type MigrationRecoveryMarker,
} from "../MigrationBackup.ts";
import { createMigrationSchemaTooNewStartupBlockError } from "../MigrationSchemaTooNewStartupBlock.ts";
import { ensurePrivateFileSync, repairPrivateFile } from "../../privatePathPermissions.ts";
import { resolveSqliteMemoryBudget } from "../sqliteMemoryBudget.ts";
import { ServerConfig } from "../../config.ts";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "../DatabaseLifecycleLock.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = (
  config: RuntimeSqliteLayerConfig,
): Layer.Layer<SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const runtime = process.versions.bun !== undefined ? "bun" : "node";
    const loader = defaultSqliteClientLoaders[runtime];
    const clientModule = yield* Effect.promise<Loader>(loader);
    return clientModule.layer(config);
  }).pipe(Layer.unwrap);

function errnoCode(cause: unknown): string | undefined {
  const error = cause as (Error & { readonly code?: string; readonly cause?: unknown }) | null;
  return error?.code ?? (error?.cause as NodeJS.ErrnoException | undefined)?.code;
}

const repairSqliteFilePermissions = (dbPath: string) =>
  Effect.promise(async () => {
    await repairPrivateFile(dbPath);
    for (const suffix of ["-wal", "-shm"]) {
      await repairPrivateFile(`${dbPath}${suffix}`).catch((cause) => {
        if (errnoCode(cause) !== "ENOENT") throw cause;
      });
    }
  });

interface SqliteSetupOptions {
  readonly dbPath?: string | undefined;
  readonly pendingRecovery?: MigrationRecoveryMarker | null | undefined;
  readonly divergenceConsent?: string | undefined;
}

const makeSetup = ({
  dbPath,
  pendingRecovery = null,
  divergenceConsent,
}: SqliteSetupOptions = {}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (dbPath) {
        // the runtime owns this database for its lifetime — make SQLite enforce the same boundary; before the first WAL access so the WAL index stays in heap, not a shared -shm another client could truncate
        const lockingModeRows = yield* sql<{ readonly locking_mode: string }>`
          PRAGMA locking_mode = EXCLUSIVE;
        `;
        const lockingMode = lockingModeRows[0]?.locking_mode;
        if (lockingMode?.toLowerCase() !== "exclusive") {
          return yield* Effect.fail(
            new Error(
              `SQLite exclusive locking mode could not be enabled (result: ${lockingMode ?? "unknown"})`,
            ),
          );
        }
      }
      yield* sql`PRAGMA busy_timeout = 5000;`;
      const journalModeRows = yield* sql<{ readonly journal_mode: string }>`
        PRAGMA journal_mode = WAL;
      `;
      const journalMode = journalModeRows[0]?.journal_mode;
      if (journalMode?.toLowerCase() !== "wal") {
        yield* Effect.logWarning("SQLite WAL journal mode could not be enabled", {
          resultingJournalMode: journalMode ?? "unknown",
        });
      }
      // synchronous=NORMAL under WAL is consistent across app crashes; the accepted risk is losing the last committed transaction(s) on OS crash/power loss — FULL's per-commit fsync is too costly at this write rate
      yield* sql`PRAGMA synchronous = NORMAL;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      // the event log can exceed a GB — the 2MB default cache thrashes during replay; cache sized to host memory; temp_store stays default deliberately: MEMORY would turn snapshot temp b-trees into unbounded RSS
      const memoryBudget = resolveSqliteMemoryBudget(totalmem());
      yield* sql`PRAGMA cache_size = ${sql.literal(String(memoryBudget.cacheSizePragma))};`;
      if (dbPath) {
        // mmap serves large sequential reads through the OS cache; tradeoff: external truncation surfaces as SIGBUS instead of a SQLite error — locking_mode=EXCLUSIVE + lifecycle lock make that effectively impossible
        yield* sql`PRAGMA mmap_size = ${sql.literal(String(memoryBudget.mmapSizeBytes))};`;
        // this transaction acquires the lock before startup continues — closing the window where another client could attach
        yield* sql`BEGIN EXCLUSIVE;`;
        yield* sql`COMMIT;`;
      }
      // a pending marker means an earlier startup was interrupted mid-migration — resuming reuses that attempt's snapshot so the fallback stays last-known-good
      const migrations = dbPath
        ? pendingRecovery
          ? resumeMarkedMigration(dbPath, pendingRecovery, runMigrations())
          : runWithPreMigrationBackup(dbPath, runMigrations(), { divergenceConsent })
        : runMigrations();
      yield* migrations.pipe(
        Effect.catch((cause) =>
          cause instanceof MigrationSchemaTooNewError && dbPath
            ? Effect.promise(() =>
                createMigrationSchemaTooNewStartupBlockError(dbPath, cause),
              ).pipe(Effect.flatMap(Effect.fail))
            : Effect.fail(cause),
        ),
      );
    }),
  );

export const makeSqlitePersistenceLive = (
  dbPath: string,
  options: { readonly divergenceConsent?: string | undefined } = {},
) =>
  Effect.acquireRelease(acquireDatabaseLifecycleLock(dbPath), (lock) =>
    releaseDatabaseLifecycleLock(lock).pipe(Effect.orDie),
  ).pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
        // ahead of the guard on purpose — a database that fails closed never reaches the backup path, so this is the only chance to reclaim stranded artifacts
        yield* reclaimOrphanedMigrationArtifacts(dbPath);
        const pendingRecovery = yield* inspectPendingMigrationRecovery(dbPath);
        // set mode before SQLite opens the file; never reopen to chmod while live — closing a descriptor releases POSIX locks and can leave a mapped WAL index vulnerable to SIGBUS
        yield* Effect.sync(() => ensurePrivateFileSync(dbPath));
        yield* repairSqliteFilePermissions(dbPath);

        return Layer.provideMerge(
          makeSetup({
            dbPath,
            pendingRecovery,
            divergenceConsent: options.divergenceConsent,
          }),
          makeRuntimeSqliteLayer({ filename: dbPath }),
        );
      }),
    ),
    Layer.unwrap,
  );

export const SqlitePersistenceMemory = Layer.provideMerge(
  makeSetup(),
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath, migrationDivergenceConsent }) =>
    makeSqlitePersistenceLive(dbPath, { divergenceConsent: migrationDivergenceConsent }),
  ),
);
