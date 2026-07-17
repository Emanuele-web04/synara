import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  MIGRATION_BACKUP_RETENTION,
  MigrationRecoveryRequiredError,
  createMigrationBackup,
  migrationBackupDirectory,
  migrationRecoveryMarkerPath,
  requireNoPendingMigrationRecovery,
  restoreMarkedMigrationBackup,
  runWithPreMigrationBackup,
} from "./MigrationBackup.ts";
import { migrationEntries, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";

const tempDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

async function makeDbPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-migration-backup-"));
  tempDirectories.push(directory);
  return path.join(directory, "state.sqlite");
}

const runWithDatabase = <A, E>(dbPath: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))));

async function backupPaths(dbPath: string): Promise<Array<string>> {
  const directory = migrationBackupDirectory(dbPath);
  const names = await fs.readdir(directory).catch((cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  });
  return names.filter((name) => name.endsWith(".sqlite")).map((name) => path.join(directory, name));
}

describe("migration backups", () => {
  it("includes committed WAL content in the SQLite snapshot", async () => {
    const dbPath = await makeDbPath();

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`PRAGMA wal_autocheckpoint = 0`;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* sql`CREATE TABLE backup_probe(value TEXT NOT NULL)`;
        yield* sql`INSERT INTO backup_probe(value) VALUES ('committed-in-wal')`;
        const walStat = yield* Effect.promise(() => fs.stat(`${dbPath}-wal`));
        expect(walStat.size).toBeGreaterThan(0);

        yield* runWithPreMigrationBackup(dbPath, Effect.void);
      }),
    );

    const [backupPath] = await backupPaths(dbPath);
    expect(backupPath).toBeDefined();
    const backup = new DatabaseSync(backupPath!, { readOnly: true });
    try {
      expect(backup.prepare("SELECT value FROM backup_probe").get()).toMatchObject({
        value: "committed-in-wal",
      });
      expect(backup.prepare("PRAGMA integrity_check").get()).toMatchObject({
        integrity_check: "ok",
      });
    } finally {
      backup.close();
    }
  });

  it("fails closed without mutating marked files, then restores only when explicitly requested", async () => {
    const dbPath = await makeDbPath();

    await expect(
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA journal_mode = WAL`;
          yield* runMigrations({ toMigrationInclusive: 52 });
          yield* sql`CREATE TABLE recovery_probe(value TEXT NOT NULL)`;
          yield* sql`INSERT INTO recovery_probe(value) VALUES ('before-failure')`;
          yield* runWithPreMigrationBackup(
            dbPath,
            Effect.gen(function* () {
              const markerBeforeMutation = JSON.parse(
                yield* Effect.promise(() =>
                  fs.readFile(migrationRecoveryMarkerPath(dbPath), "utf8"),
                ),
              ) as { phase: string };
              expect(markerBeforeMutation.phase).toBe("migration-in-progress");
              yield* sql`DELETE FROM recovery_probe`;
              return yield* Effect.fail(new Error("injected migration failure"));
            }),
          );
        }),
      ),
    ).rejects.toThrow("injected migration failure");

    const markerPath = migrationRecoveryMarkerPath(dbPath);
    const markerText = await fs.readFile(markerPath, "utf8");
    const marker = JSON.parse(markerText) as {
      backupPath: string;
      phase: string;
    };
    expect(marker.backupPath).toContain(migrationBackupDirectory(dbPath));
    expect(marker.phase).toBe("migration-in-progress");
    const backup = new DatabaseSync(marker.backupPath, { readOnly: true });
    try {
      expect(backup.prepare("SELECT value FROM recovery_probe").get()).toMatchObject({
        value: "before-failure",
      });
    } finally {
      backup.close();
    }

    const failedDatabaseText = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(failedDatabaseText.prepare("SELECT value FROM recovery_probe").all()).toEqual([]);
    } finally {
      failedDatabaseText.close();
    }
    const databaseStatBeforeStartup = await fs.stat(dbPath);
    const markerStatBeforeStartup = await fs.stat(markerPath);

    await expect(
      Effect.runPromise(
        Layer.build(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))).pipe(
          Effect.scoped,
        ),
      ),
    ).rejects.toThrow(MigrationRecoveryRequiredError);

    expect(await fs.readFile(markerPath, "utf8")).toBe(markerText);
    expect((await fs.stat(dbPath)).size).toBe(databaseStatBeforeStartup.size);
    expect((await fs.stat(dbPath)).mtimeMs).toBe(databaseStatBeforeStartup.mtimeMs);
    expect((await fs.stat(markerPath)).mtimeMs).toBe(markerStatBeforeStartup.mtimeMs);
    const stillFailed = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(stillFailed.prepare("SELECT value FROM recovery_probe").all()).toEqual([]);
    } finally {
      stillFailed.close();
    }

    const orphanFailedWal = `${dbPath}.failed-migration-orphan-wal`;
    const orphanFailedShm = `${dbPath}.failed-migration-orphan-shm`;
    await fs.writeFile(orphanFailedWal, "orphan");
    await fs.writeFile(orphanFailedShm, "orphan");
    await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));
    await expect(fs.stat(orphanFailedWal)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(orphanFailedShm)).rejects.toMatchObject({ code: "ENOENT" });

    const restoredValue = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly value: string }>`SELECT value FROM recovery_probe`;
        return rows[0]?.value;
      }).pipe(
        Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
      ),
    );
    expect(restoredValue).toBe("before-failure");

    const restored = new DatabaseSync(dbPath, { readOnly: true });
    expect(restored.prepare("PRAGMA integrity_check").get()).toMatchObject({
      integrity_check: "ok",
    });
    restored.close();
    await expect(fs.stat(markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await fs.readdir(path.dirname(dbPath))).some((name) =>
        name.startsWith(`${path.basename(dbPath)}.failed-migration-`),
      ),
    ).toBe(true);
  });

  it("publishes a private marker atomically with no temporary marker left behind", async () => {
    const dbPath = await makeDbPath();

    await expect(
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 52 });
          yield* sql`CREATE TABLE marker_probe(value TEXT NOT NULL)`;
          yield* runWithPreMigrationBackup(dbPath, Effect.fail(new Error("leave durable marker")));
        }),
      ),
    ).rejects.toThrow("leave durable marker");

    const markerPath = migrationRecoveryMarkerPath(dbPath);
    expect(JSON.parse(await fs.readFile(markerPath, "utf8"))).toMatchObject({
      databasePath: dbPath,
      phase: "migration-in-progress",
    });
    expect(
      (await fs.readdir(path.dirname(dbPath))).filter(
        (name) => name.startsWith(`${path.basename(markerPath)}.`) && name.endsWith(".partial"),
      ),
    ).toEqual([]);
    if (process.platform !== "win32") {
      expect((await fs.stat(markerPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects symlinked markers and non-generated nested backup paths", async () => {
    const dbPath = await makeDbPath();
    const markerPath = migrationRecoveryMarkerPath(dbPath);
    const outsideMarker = path.join(path.dirname(dbPath), "outside-marker.json");
    await fs.writeFile(outsideMarker, "{}\n");
    await fs.symlink(outsideMarker, markerPath);

    await expect(Effect.runPromise(requireNoPendingMigrationRecovery(dbPath))).rejects.toThrow(
      "could not be validated",
    );
    expect(await fs.readFile(outsideMarker, "utf8")).toBe("{}\n");

    await fs.unlink(markerPath);
    const backupDirectory = migrationBackupDirectory(dbPath);
    const nestedDirectory = path.join(backupDirectory, "nested");
    await fs.mkdir(nestedDirectory, { recursive: true });
    const nestedBackup = path.join(
      nestedDirectory,
      `${path.basename(dbPath)}.pre-migration-v52-to-v53-20260713T120000000Z-${randomUUID()}.sqlite`,
    );
    await fs.writeFile(nestedBackup, "not-used");
    await fs.writeFile(
      markerPath,
      `${JSON.stringify({ databasePath: dbPath, backupPath: nestedBackup })}\n`,
    );

    await expect(Effect.runPromise(requireNoPendingMigrationRecovery(dbPath))).rejects.toThrow(
      "invalid backup",
    );
  });

  it("removes only stale migration partials and restore copies", async () => {
    const dbPath = await makeDbPath();
    const backupDirectory = migrationBackupDirectory(dbPath);
    await fs.mkdir(backupDirectory, { recursive: true });
    const stalePartial = path.join(
      backupDirectory,
      `.${path.basename(dbPath)}.pre-migration-abandoned.sqlite.partial`,
    );
    const recentPartial = path.join(
      backupDirectory,
      `.${path.basename(dbPath)}.pre-migration-active.sqlite.partial`,
    );
    await fs.writeFile(stalePartial, "stale");
    await fs.writeFile(recentPartial, "recent");
    const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await fs.utimes(stalePartial, staleDate, staleDate);

    await expect(
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 52 });
          yield* sql`CREATE TABLE artifact_probe(value TEXT NOT NULL)`;
          yield* sql`INSERT INTO artifact_probe(value) VALUES ('restorable')`;
          yield* runWithPreMigrationBackup(
            dbPath,
            Effect.fail(new Error("leave recovery artifacts")),
          );
        }),
      ),
    ).rejects.toThrow("leave recovery artifacts");

    await expect(fs.stat(stalePartial)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(recentPartial)).resolves.toBeDefined();

    const staleRestore = `${dbPath}.00000000-0000-0000-0000-000000000000.restore`;
    const recentRestore = `${dbPath}.11111111-1111-1111-1111-111111111111.restore`;
    await fs.writeFile(staleRestore, "stale");
    await fs.writeFile(recentRestore, "recent");
    await fs.utimes(staleRestore, staleDate, staleDate);

    await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));

    await expect(fs.stat(staleRestore)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(recentRestore)).resolves.toBeDefined();
  });

  it("backs up an imported divergent lineage before reconciliation", async () => {
    const dbPath = await makeDbPath();
    const latestId = Math.max(...migrationEntries.map(([id]) => id));

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* runMigrations({ toMigrationInclusive: 16 });
        for (let id = 17; id <= latestId + 2; id += 1) {
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (${id}, ${`ImportedMigration${id}`})
          `;
        }
        yield* sql`CREATE TABLE imported_probe(value TEXT NOT NULL)`;
        yield* sql`INSERT INTO imported_probe(value) VALUES ('imported-state')`;
        yield* runWithPreMigrationBackup(dbPath, runMigrations());
      }),
    );

    const [backupPath] = await backupPaths(dbPath);
    const backup = new DatabaseSync(backupPath!, { readOnly: true });
    try {
      expect(
        backup.prepare("SELECT name FROM effect_sql_migrations WHERE migration_id = 17").get(),
      ).toMatchObject({ name: "ImportedMigration17" });
      expect(backup.prepare("SELECT value FROM imported_probe").get()).toMatchObject({
        value: "imported-state",
      });
    } finally {
      backup.close();
    }
  });

  it("prunes versioned snapshots to the bounded retention count", async () => {
    const dbPath = await makeDbPath();
    await fs.mkdir(migrationBackupDirectory(dbPath), { recursive: true, mode: 0o755 });
    await fs.chmod(migrationBackupDirectory(dbPath), 0o755);

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE prune_probe(value TEXT NOT NULL)`;
        for (let version = 0; version < MIGRATION_BACKUP_RETENTION + 3; version += 1) {
          yield* createMigrationBackup(dbPath, {
            sourceVersion: `v${version}`,
            targetVersion: version + 1,
          });
        }
      }),
    );

    const retainedBackups = await backupPaths(dbPath);
    expect(retainedBackups).toHaveLength(MIGRATION_BACKUP_RETENTION);
    if (process.platform !== "win32") {
      expect((await fs.stat(migrationBackupDirectory(dbPath))).mode & 0o777).toBe(0o700);
      for (const backupPath of retainedBackups) {
        expect((await fs.stat(backupPath)).mode & 0o777).toBe(0o600);
      }
    }
  });

  it("starts a new database without creating a meaningless backup", async () => {
    const dbPath = await makeDbPath();

    const startDatabase = () =>
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          yield* runWithPreMigrationBackup(dbPath, runMigrations());
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM effect_sql_migrations
          `;
          return rows[0]?.count ?? 0;
        }),
      );

    const migrationCount = await startDatabase();

    expect(migrationCount).toBe(migrationEntries.length);
    expect(await backupPaths(dbPath)).toEqual([]);

    // A current schema is a no-op startup and must not consume retention slots.
    expect(await startDatabase()).toBe(migrationEntries.length);
    expect(await backupPaths(dbPath)).toEqual([]);
  });

  it("creates the main database and live WAL files with private modes", async () => {
    const dbPath = await makeDbPath();

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE permission_probe(value TEXT NOT NULL)`;
        yield* sql`INSERT INTO permission_probe(value) VALUES ('private')`;
        if (process.platform !== "win32") {
          for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
            const stat = yield* Effect.promise(() => fs.stat(filePath));
            expect(stat.mode & 0o777).toBe(0o600);
          }
        }
      }).pipe(
        Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
      ),
    );
    expect(await backupPaths(dbPath)).toEqual([]);
  });
});
