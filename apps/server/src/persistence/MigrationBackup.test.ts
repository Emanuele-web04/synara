import { constants as fsConstants } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  DatabaseLifecycleLockedError,
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
  withDatabaseLifecycleLock,
} from "./DatabaseLifecycleLock.ts";
import {
  MIGRATION_BACKUP_RETENTION,
  MigrationRecoveryRequiredError,
  createMigrationBackup,
  migrationBackupDirectory,
  migrationRecoveryMarkerPath,
  requireNoPendingMigrationRecovery,
  restoreMarkedMigrationBackup,
  runWithPreMigrationBackup,
  type MigrationRecoveryFileOperations,
} from "./MigrationBackup.ts";
import { migrationEntries, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";

const tempDirectories: Array<string> = [];
const publishedV055FixtureDirectory = fileURLToPath(
  new URL("./__fixtures__/v0.5.5/", import.meta.url),
);
const publishedV055FixturePath = path.join(publishedV055FixtureDirectory, "synara-v0.5.5.sqlite");
const publishedV055ManifestPath = path.join(publishedV055FixtureDirectory, "manifest.json");
const publishedV055FixtureSha256 =
  "fe4eb795121d62dfe37e6ff15e961bf24f5fe9d6121f78dde39ab8910fdf02dc";

type PublishedV055Pin = {
  readonly project_id: string;
  readonly repository_key: string;
  readonly pull_request_number: number;
};

type PublishedV055Manifest = {
  readonly schemaVersion: number;
  readonly fixture: {
    readonly file: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly immutable: boolean;
    readonly sidecars: ReadonlyArray<string>;
    readonly sqlite: {
      readonly pageSizeBytes: number;
      readonly pageCount: number;
      readonly freelistCount: number;
      readonly journalMode: string;
    };
  };
  readonly source: {
    readonly release: {
      readonly id: number;
      readonly tag: string;
      readonly url: string;
    };
    readonly tag: {
      readonly commitSha: string;
    };
    readonly releaseWorkflow: {
      readonly id: number;
      readonly conclusion: string;
    };
    readonly windowsAsset: {
      readonly id: number;
      readonly sha256: string;
      readonly authenticodeStatus: string;
    };
  };
  readonly capture: {
    readonly invocation: {
      readonly controls: {
        readonly providerCredentialsInherited: boolean;
        readonly preExistingSynaraOrAgentStateRead: boolean;
        readonly codingAgentsLaunched: boolean;
        readonly projectsImported: boolean;
      };
    };
  };
  readonly rawCapture: {
    readonly committedToRepository: boolean;
  };
  readonly sanitization: {
    readonly syntheticRows: {
      readonly project_pull_request_pins: ReadonlyArray<PublishedV055Pin>;
    };
    readonly rowCensus: Readonly<Record<string, number>>;
  };
  readonly validation: {
    readonly integrityCheck: string;
    readonly foreignKeyCheckRows: number;
    readonly freelistCount: number;
    readonly sidecars: ReadonlyArray<string>;
    readonly migrationTracker: {
      readonly count: number;
      readonly minimumId: number;
      readonly maximumId: number;
      readonly contiguous: boolean;
      readonly migration54Name: string;
    };
    readonly projectPullRequestPinsSchema: {
      readonly columns: ReadonlyArray<string>;
      readonly compositePrimaryKeyOrder: ReadonlyArray<string>;
      readonly positivePullRequestNumberCheck: boolean;
      readonly limitTrigger: string;
      readonly limitPerProject: number;
    };
  };
  readonly privacyScan: {
    readonly patterns: ReadonlyArray<string>;
    readonly hitCount: number;
    readonly hits: ReadonlyArray<string>;
  };
  readonly redistribution: {
    readonly containsRealUserState: boolean;
    readonly containsCredentials: boolean;
    readonly rawCaptureIncluded: boolean;
  };
};

const publishedV055PrivacyPatterns = [
  {
    name: "Windows absolute path",
    expression: /[a-z]:[\\/](?:[a-z0-9._ -]+[\\/])+[a-z0-9._ -]*/i,
  },
  { name: "UNC path", expression: /\\\\[a-z0-9._-]+\\[a-z0-9.$ _-]+/i },
  { name: "macOS user-home path", expression: /\/users\/[a-z0-9._-]+\//i },
  { name: "Linux user-home path", expression: /\/home\/[a-z0-9._-]+\//i },
  { name: "root user-home path", expression: /\/root\//i },
  { name: "email address", expression: /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { name: "private-key header", expression: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "GitHub classic token", expression: /gh[pousr]_[a-z0-9]{20,}/i },
  { name: "GitHub fine-grained token", expression: /github_pat_[a-z0-9_]{20,}/i },
  { name: "OpenAI secret key", expression: /sk-(?:proj-)?[a-z0-9_-]{20,}/i },
  { name: "AWS access-key ID", expression: /(?:AKIA|ASIA)[0-9A-Z]{16}/ },
  {
    name: "JSON web token",
    expression: /eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}/i,
  },
  { name: "Bearer credential", expression: /bearer\s+[a-z0-9._~+/-]{12,}={0,2}/i },
  { name: "capture username", expression: /fixture-user/i },
  { name: "capture computer name", expression: /SYNARA-FIXTURE/i },
  {
    name: "capture root fragment",
    expression: /SynaraFixture-20[0-9]{6}-windows-migration-recovery/i,
  },
] as const;

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

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

function readMigrationTracker(database: DatabaseSync) {
  const rows = database
    .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
    .all() as Array<{ readonly migration_id: number | bigint; readonly name: string }>;
  return rows.map(({ migration_id, name }) => ({ migrationId: Number(migration_id), name }));
}

function readPublishedPin(database: DatabaseSync): PublishedV055Pin {
  const row = database
    .prepare(
      "SELECT project_id, repository_key, pull_request_number FROM project_pull_request_pins",
    )
    .get() as
    | {
        readonly project_id: string;
        readonly repository_key: string;
        readonly pull_request_number: number | bigint;
      }
    | undefined;
  if (!row) throw new Error("Published v0.5.5 fixture is missing its synthetic pin");
  return { ...row, pull_request_number: Number(row.pull_request_number) };
}

function readRowCensus(database: DatabaseSync): Record<string, number> {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ readonly name: string }>;
  return Object.fromEntries(
    tables.map(({ name }) => {
      const quotedName = `"${name.replaceAll('"', '""')}"`;
      const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quotedName}`).get() as {
        readonly count: number | bigint;
      };
      return [name, Number(row.count)];
    }),
  );
}

function expectHealthyDatabase(database: DatabaseSync): void {
  expect(database.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

function expectPublishedPinSchema(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(project_pull_request_pins)").all() as Array<{
    readonly name: string;
    readonly pk: number | bigint;
  }>;
  expect(columns.map(({ name }) => name)).toEqual([
    "project_id",
    "repository_key",
    "pull_request_number",
  ]);
  expect(
    columns
      .filter(({ pk }) => Number(pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map(({ name }) => name),
  ).toEqual(["project_id", "repository_key", "pull_request_number"]);

  const table = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("project_pull_request_pins") as { readonly sql: string } | undefined;
  expect(table?.sql).toMatch(/CHECK\s*\(\s*pull_request_number\s*>\s*0\s*\)/i);

  const trigger = database
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
    .get("project_pull_request_pins") as
    | { readonly name: string; readonly sql: string }
    | undefined;
  expect(trigger?.name).toBe("trg_project_pull_request_pins_limit");
  expect(trigger?.sql).toMatch(/COUNT\(\*\)[\s\S]*>=\s*20/i);
  expect(trigger?.sql).toContain("project pull request pin limit exceeded");
}

function privacyHits(bytes: Buffer): Array<string> {
  const decoded = [bytes.toString("latin1"), bytes.toString("utf8"), bytes.toString("utf16le")];
  return publishedV055PrivacyPatterns
    .filter(({ expression }) => decoded.some((text) => expression.test(text)))
    .map(({ name }) => name);
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

const staleArtifactDate = () => new Date(Date.now() - 48 * 60 * 60 * 1_000);

async function markerPartialPaths(dbPath: string): Promise<Array<string>> {
  const markerBasename = path.basename(migrationRecoveryMarkerPath(dbPath));
  return (await fs.readdir(path.dirname(dbPath)))
    .filter((name) => name.startsWith(`${markerBasename}.`) && name.endsWith(".partial"))
    .map((name) => path.join(path.dirname(dbPath), name));
}

async function restoreTemporaryPaths(dbPath: string): Promise<Array<string>> {
  const databaseBasename = path.basename(dbPath);
  return (await fs.readdir(path.dirname(dbPath)))
    .filter((name) => name.startsWith(`${databaseBasename}.`) && name.endsWith(".restore"))
    .map((name) => path.join(path.dirname(dbPath), name));
}

async function makeMarkedRecoveryScenario(): Promise<{
  readonly dbPath: string;
  readonly markerPath: string;
  readonly backupPath: string;
}> {
  const dbPath = await makeDbPath();
  await expect(
    runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* sql`CREATE TABLE restore_failure_probe(value TEXT NOT NULL)`;
        yield* sql`INSERT INTO restore_failure_probe(value) VALUES ('known-good')`;
        yield* runWithPreMigrationBackup(
          dbPath,
          Effect.gen(function* () {
            yield* sql`DELETE FROM restore_failure_probe`;
            return yield* Effect.fail(new Error("prepare marked recovery"));
          }),
        );
      }),
    ),
  ).rejects.toThrow("prepare marked recovery");

  const markerPath = migrationRecoveryMarkerPath(dbPath);
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as {
    readonly backupPath: string;
  };
  return { dbPath, markerPath, backupPath: marker.backupPath };
}

async function fileFingerprints(paths: ReadonlyArray<string>): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (filePath) => [filePath, await sha256File(filePath)] as const),
    ),
  );
}

async function expectValidRestoredProbe(dbPath: string): Promise<void> {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    expect(database.prepare("PRAGMA integrity_check").get()).toMatchObject({
      integrity_check: "ok",
    });
    expect(database.prepare("SELECT value FROM restore_failure_probe").get()).toMatchObject({
      value: "known-good",
    });
  } finally {
    database.close();
  }
}

async function makeMigrationCandidate(): Promise<string> {
  const dbPath = await makeDbPath();
  await runWithDatabase(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`CREATE TABLE marker_failure_probe(value TEXT NOT NULL)`;
      yield* sql`INSERT INTO marker_failure_probe(value) VALUES ('preserved')`;
    }),
  );
  return dbPath;
}

async function captureRejection(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected operation to reject");
}

function expectAggregateCauses(
  cause: unknown,
  primaryMessage: string,
  cleanupMessage: string,
): void {
  expect(cause).toBeInstanceOf(AggregateError);
  const aggregate = cause as AggregateError;
  expect(aggregate.cause).toBeInstanceOf(Error);
  expect((aggregate.cause as Error).message).toBe(primaryMessage);
  expect(aggregate.errors).toHaveLength(2);
  expect((aggregate.errors[0] as Error).message).toBe(primaryMessage);
  expect((aggregate.errors[1] as Error).message).toBe(cleanupMessage);
}

async function failedBundleMainPaths(dbPath: string): Promise<Array<string>> {
  const basename = path.basename(dbPath);
  return (await fs.readdir(path.dirname(dbPath)))
    .filter(
      (name) =>
        name.startsWith(`${basename}.failed-migration-`) &&
        !name.endsWith("-wal") &&
        !name.endsWith("-shm"),
    )
    .map((name) => path.join(path.dirname(dbPath), name));
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

  it.each(["open", "write", "sync", "close", "rename"] as const)(
    "cleans only its marker partial after an injected %s failure and retries deterministically",
    async (stage) => {
      const dbPath = await makeMigrationCandidate();
      let migrationRan = false;
      const failure = new Error(`injected marker ${stage} failure`);
      const fileOperations: MigrationRecoveryFileOperations =
        stage === "open"
          ? {
              open: async () => {
                throw failure;
              },
            }
          : stage === "write"
            ? {
                writeFile: async (handle) => {
                  await handle.writeFile("partial marker", "utf8");
                  throw failure;
                },
              }
            : stage === "sync"
              ? {
                  syncFile: async () => {
                    throw failure;
                  },
                }
              : stage === "close"
                ? {
                    closeFile: async (handle) => {
                      await handle.close();
                      throw failure;
                    },
                  }
                : {
                    rename: async () => {
                      throw failure;
                    },
                  };

      await expect(
        runWithDatabase(
          dbPath,
          runWithPreMigrationBackup(
            dbPath,
            Effect.gen(function* () {
              migrationRan = true;
              const sql = yield* SqlClient.SqlClient;
              yield* sql`DELETE FROM marker_failure_probe`;
            }),
            fileOperations,
          ),
        ),
      ).rejects.toThrow(failure.message);

      expect(migrationRan).toBe(false);
      expect(await markerPartialPaths(dbPath)).toEqual([]);
      await expect(fs.stat(migrationRecoveryMarkerPath(dbPath))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const failedAttemptBackups = await backupPaths(dbPath);
      expect(failedAttemptBackups).toHaveLength(1);
      const backup = new DatabaseSync(failedAttemptBackups[0]!, { readOnly: true });
      try {
        expect(backup.prepare("PRAGMA integrity_check").get()).toMatchObject({
          integrity_check: "ok",
        });
        expect(backup.prepare("SELECT value FROM marker_failure_probe").get()).toMatchObject({
          value: "preserved",
        });
      } finally {
        backup.close();
      }

      await runWithDatabase(dbPath, runWithPreMigrationBackup(dbPath, runMigrations()));

      const retried = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(readMigrationTracker(retried)).toEqual(
          migrationEntries.map(([migrationId, name]) => ({ migrationId, name })),
        );
        expect(retried.prepare("SELECT value FROM marker_failure_probe").get()).toMatchObject({
          value: "preserved",
        });
      } finally {
        retried.close();
      }
      expect(await markerPartialPaths(dbPath)).toEqual([]);
      await expect(fs.stat(migrationRecoveryMarkerPath(dbPath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("retains a published marker when its directory sync fails", async () => {
    const dbPath = await makeMigrationCandidate();
    let migrationRan = false;

    await expect(
      runWithDatabase(
        dbPath,
        runWithPreMigrationBackup(
          dbPath,
          Effect.sync(() => {
            migrationRan = true;
          }),
          {
            syncDirectory: async () => {
              throw new Error("injected marker directory sync failure");
            },
          },
        ),
      ),
    ).rejects.toThrow("injected marker directory sync failure");

    expect(migrationRan).toBe(false);
    expect(await markerPartialPaths(dbPath)).toEqual([]);
    expect(
      JSON.parse(await fs.readFile(migrationRecoveryMarkerPath(dbPath), "utf8")),
    ).toMatchObject({
      databasePath: dbPath,
      phase: "migration-in-progress",
    });
    await expect(Effect.runPromise(requireNoPendingMigrationRecovery(dbPath))).rejects.toThrow(
      MigrationRecoveryRequiredError,
    );
  });

  it("does not delete an unowned marker partial when exclusive creation reports EEXIST", async () => {
    const dbPath = await makeMigrationCandidate();
    const sentinel = "foreign marker partial";
    let foreignPath: string | undefined;
    let migrationRan = false;

    await expect(
      runWithDatabase(
        dbPath,
        runWithPreMigrationBackup(
          dbPath,
          Effect.sync(() => {
            migrationRan = true;
          }),
          {
            open: async (filePath, flags, mode) => {
              foreignPath = String(filePath);
              await fs.writeFile(filePath, sentinel, { flag: "wx" });
              return fs.open(filePath, flags, mode);
            },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(migrationRan).toBe(false);
    expect(foreignPath).toBeDefined();
    expect(await fs.readFile(foreignPath!, "utf8")).toBe(sentinel);
    await expect(fs.stat(migrationRecoveryMarkerPath(dbPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports both marker publication and non-ENOENT cleanup failures", async () => {
    const dbPath = await makeMigrationCandidate();
    const primaryMessage = "injected marker write failure";
    const cleanupMessage = "injected marker cleanup failure";
    let ownedPath: string | undefined;

    const cause = await captureRejection(
      runWithDatabase(
        dbPath,
        runWithPreMigrationBackup(dbPath, Effect.void, {
          writeFile: async (handle, _contents, filePath) => {
            ownedPath = filePath;
            await handle.writeFile("partial marker", "utf8");
            throw new Error(primaryMessage);
          },
          unlink: async () => {
            const cleanupError = new Error(cleanupMessage) as NodeJS.ErrnoException;
            cleanupError.code = "EACCES";
            throw cleanupError;
          },
        }),
      ),
    );

    expectAggregateCauses(cause, primaryMessage, cleanupMessage);
    expect(ownedPath).toBeDefined();
    expect(await fs.readFile(ownedPath!, "utf8")).toBe("partial marker");
    await expect(fs.stat(migrationRecoveryMarkerPath(dbPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes the current partial when backup publication fails", async () => {
    const dbPath = await makeDbPath();

    await expect(
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE publication_probe(value TEXT NOT NULL)`;
          yield* createMigrationBackup(
            dbPath,
            { sourceVersion: "v52", targetVersion: 53 },
            {
              open: async () => {
                throw new Error("injected backup publication failure");
              },
            },
          );
        }),
      ),
    ).rejects.toThrow("injected backup publication failure");

    expect(await fs.readdir(migrationBackupDirectory(dbPath))).toEqual([]);
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

  it("preserves the existing stale backup-partial cleanup behavior", async () => {
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
    const staleDate = staleArtifactDate();
    await fs.utimes(stalePartial, staleDate, staleDate);

    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE backup_artifact_probe(value TEXT NOT NULL)`;
        yield* createMigrationBackup(dbPath, { sourceVersion: "v52", targetVersion: 53 });
      }),
    );

    await expect(fs.stat(stalePartial)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(recentPartial)).resolves.toBeDefined();
  });

  it("sweeps only stale exact marker partials under the lifecycle lock", async () => {
    const dbPath = await makeDbPath();
    await Effect.runPromise(
      Layer.build(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))).pipe(
        Effect.scoped,
      ),
    );

    const directory = path.dirname(dbPath);
    const markerPath = migrationRecoveryMarkerPath(dbPath);
    const markerBasename = path.basename(markerPath);
    const staleExact = path.join(
      directory,
      `${markerBasename}.123e4567-e89b-42d3-a456-426614174000.partial`,
    );
    const recentExact = path.join(
      directory,
      `${markerBasename}.123e4567-e89b-42d3-a456-426614174001.partial`,
    );
    const preservedRegularFiles = [
      path.join(directory, `${markerBasename}.00000000-0000-0000-0000-000000000000.partial`),
      path.join(directory, `${markerBasename}.123e4567-e89b-12d3-a456-426614174002.partial`),
      path.join(directory, `${markerBasename}.123e4567-e89b-42d3-7456-426614174003.partial`),
      path.join(directory, `${markerBasename}.123E4567-E89B-42D3-A456-426614174004.partial`),
      path.join(directory, `prefix-${markerBasename}.123e4567-e89b-42d3-a456-426614174005.partial`),
      path.join(directory, `${markerBasename}.123e4567-e89b-42d3-a456-426614174006.partial.extra`),
      path.join(
        directory,
        `other.sqlite.migration-recovery.json.123e4567-e89b-42d3-a456-426614174007.partial`,
      ),
    ];
    const exactDirectory = path.join(
      directory,
      `${markerBasename}.123e4567-e89b-42d3-a456-426614174008.partial`,
    );
    const symlinkTarget = path.join(directory, "marker-partial-symlink-target.txt");
    const exactSymlink = path.join(
      directory,
      `${markerBasename}.123e4567-e89b-42d3-a456-426614174009.partial`,
    );
    const finalizedBackup = path.join(
      migrationBackupDirectory(dbPath),
      `${path.basename(dbPath)}.pre-migration-v52-to-v69-20260718T120000000Z-123e4567-e89b-42d3-a456-426614174010.sqlite`,
    );

    await fs.writeFile(staleExact, "stale exact marker partial");
    await fs.writeFile(recentExact, "recent exact marker partial");
    for (const filePath of preservedRegularFiles) await fs.writeFile(filePath, "preserve");
    await fs.mkdir(exactDirectory);
    await fs.writeFile(symlinkTarget, "symlink target");
    await fs.symlink(symlinkTarget, exactSymlink);
    await fs.mkdir(migrationBackupDirectory(dbPath), { recursive: true });
    await fs.writeFile(finalizedBackup, "finalized backup");
    await fs.writeFile(markerPath, "final marker");
    const staleDate = staleArtifactDate();
    await fs.utimes(staleExact, staleDate, staleDate);
    for (const filePath of preservedRegularFiles) await fs.utimes(filePath, staleDate, staleDate);
    await fs.utimes(exactDirectory, staleDate, staleDate);
    await fs.utimes(symlinkTarget, staleDate, staleDate);
    await fs.utimes(finalizedBackup, staleDate, staleDate);
    await fs.utimes(markerPath, staleDate, staleDate);

    await Effect.runPromise(
      withDatabaseLifecycleLock(
        dbPath,
        runWithPreMigrationBackup(dbPath, Effect.void).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
        ),
      ),
    );

    await expect(fs.stat(staleExact)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(recentExact, "utf8")).toBe("recent exact marker partial");
    for (const filePath of preservedRegularFiles) {
      expect(await fs.readFile(filePath, "utf8")).toBe("preserve");
    }
    await expect(fs.stat(exactDirectory)).resolves.toMatchObject({});
    expect(await fs.readFile(exactSymlink, "utf8")).toBe("symlink target");
    expect(await fs.readFile(symlinkTarget, "utf8")).toBe("symlink target");
    expect(await fs.readFile(markerPath, "utf8")).toBe("final marker");
    expect(await fs.readFile(finalizedBackup, "utf8")).toBe("finalized backup");
  });

  it("does not sweep a stale marker partial while another lifecycle owner is live", async () => {
    const dbPath = await makeDbPath();
    await Effect.runPromise(
      Layer.build(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))).pipe(
        Effect.scoped,
      ),
    );
    const stalePartial = `${migrationRecoveryMarkerPath(dbPath)}.123e4567-e89b-42d3-a456-426614174011.partial`;
    await fs.writeFile(stalePartial, "locked stale marker partial");
    const staleDate = staleArtifactDate();
    await fs.utimes(stalePartial, staleDate, staleDate);

    const lock = await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));
    try {
      await expect(
        Effect.runPromise(
          Layer.build(
            makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
          ).pipe(Effect.scoped),
        ),
      ).rejects.toBeInstanceOf(DatabaseLifecycleLockedError);
      expect(await fs.readFile(stalePartial, "utf8")).toBe("locked stale marker partial");
    } finally {
      await Effect.runPromise(releaseDatabaseLifecycleLock(lock));
    }

    await Effect.runPromise(
      Layer.build(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))).pipe(
        Effect.scoped,
      ),
    );
    await expect(fs.stat(stalePartial)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sweeps only stale exact restore copies and preserves every near match", async () => {
    const { dbPath, markerPath, backupPath } = await makeMarkedRecoveryScenario();
    const directory = path.dirname(dbPath);
    const basename = path.basename(dbPath);
    const staleRestore = `${dbPath}.123e4567-e89b-42d3-a456-426614174012.restore`;
    const recentRestore = `${dbPath}.123e4567-e89b-42d3-a456-426614174013.restore`;
    const preservedRegularFiles = [
      `${dbPath}.00000000-0000-0000-0000-000000000000.restore`,
      `${dbPath}.123e4567-e89b-12d3-a456-426614174014.restore`,
      `${dbPath}.123e4567-e89b-42d3-7456-426614174015.restore`,
      `${dbPath}.123E4567-E89B-42D3-A456-426614174016.restore`,
      path.join(directory, `prefix-${basename}.123e4567-e89b-42d3-a456-426614174017.restore`),
      `${dbPath}.123e4567-e89b-42d3-a456-426614174018.restore.extra`,
      path.join(directory, `other.sqlite.123e4567-e89b-42d3-a456-426614174019.restore`),
    ];
    const exactDirectory = `${dbPath}.123e4567-e89b-42d3-a456-426614174020.restore`;
    const symlinkTarget = path.join(directory, "restore-symlink-target.txt");
    const exactSymlink = `${dbPath}.123e4567-e89b-42d3-a456-426614174021.restore`;
    const backupBefore = await sha256File(backupPath);

    await fs.writeFile(staleRestore, "stale exact restore");
    await fs.writeFile(recentRestore, "recent exact restore");
    for (const filePath of preservedRegularFiles) await fs.writeFile(filePath, "preserve");
    await fs.mkdir(exactDirectory);
    await fs.writeFile(symlinkTarget, "restore symlink target");
    await fs.symlink(symlinkTarget, exactSymlink);
    const staleDate = staleArtifactDate();
    await fs.utimes(staleRestore, staleDate, staleDate);
    for (const filePath of preservedRegularFiles) await fs.utimes(filePath, staleDate, staleDate);
    await fs.utimes(exactDirectory, staleDate, staleDate);
    await fs.utimes(symlinkTarget, staleDate, staleDate);

    await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));

    await expect(fs.stat(staleRestore)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(recentRestore, "utf8")).toBe("recent exact restore");
    for (const filePath of preservedRegularFiles) {
      expect(await fs.readFile(filePath, "utf8")).toBe("preserve");
    }
    await expect(fs.stat(exactDirectory)).resolves.toMatchObject({});
    expect(await fs.readFile(exactSymlink, "utf8")).toBe("restore symlink target");
    expect(await fs.readFile(symlinkTarget, "utf8")).toBe("restore symlink target");
    expect(await sha256File(backupPath)).toBe(backupBefore);
    await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectValidRestoredProbe(dbPath);
    expect(await failedBundleMainPaths(dbPath)).toHaveLength(1);
  });

  it.each(["copy", "validation", "open", "sync", "close", "move"] as const)(
    "cleans an owned restore copy after an injected %s failure and retries safely",
    async (stage) => {
      const { dbPath, markerPath, backupPath } = await makeMarkedRecoveryScenario();
      await fs.writeFile(`${dbPath}-wal`, `live ${stage} wal`);
      await fs.writeFile(`${dbPath}-shm`, `live ${stage} shm`);
      const existingBundle = `${dbPath}.failed-migration-existing`;
      await fs.writeFile(existingBundle, `existing ${stage} database`);
      await fs.writeFile(`${existingBundle}-wal`, `existing ${stage} wal`);
      await fs.writeFile(`${existingBundle}-shm`, `existing ${stage} shm`);
      const preservedPaths = [
        dbPath,
        `${dbPath}-wal`,
        `${dbPath}-shm`,
        markerPath,
        backupPath,
        existingBundle,
        `${existingBundle}-wal`,
        `${existingBundle}-shm`,
      ];
      const before = await fileFingerprints(preservedPaths);
      const failure = new Error(`injected restore ${stage} failure`);
      let closeCount = 0;
      const fileOperations: MigrationRecoveryFileOperations =
        stage === "copy"
          ? {
              copyFile: async (source, destination) => {
                await fs.copyFile(source, destination);
                throw failure;
              },
            }
          : stage === "validation"
            ? {
                validateTemporary: async () => {
                  throw failure;
                },
              }
            : stage === "open"
              ? {
                  open: async (filePath, flags, mode) => {
                    if (typeof flags === "number" && (flags & fsConstants.O_EXCL) === 0) {
                      throw failure;
                    }
                    return fs.open(filePath, flags, mode);
                  },
                }
              : stage === "sync"
                ? {
                    syncFile: async () => {
                      throw failure;
                    },
                  }
                : stage === "close"
                  ? {
                      closeFile: async (handle) => {
                        closeCount += 1;
                        await handle.close();
                        if (closeCount === 2) throw failure;
                      },
                    }
                  : {
                      rename: async (source, destination) => {
                        const sourcePath = String(source);
                        const destinationPath = String(destination);
                        if (sourcePath === `${dbPath}-wal`) throw failure;
                        await fs.rename(sourcePath, destinationPath);
                      },
                    };

      await expect(
        Effect.runPromise(restoreMarkedMigrationBackup(dbPath, fileOperations)),
      ).rejects.toThrow(failure.message);

      expect(await fileFingerprints(preservedPaths)).toEqual(before);
      expect(await restoreTemporaryPaths(dbPath)).toEqual([]);
      await expect(Effect.runPromise(requireNoPendingMigrationRecovery(dbPath))).rejects.toThrow(
        MigrationRecoveryRequiredError,
      );

      await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));

      await expectValidRestoredProbe(dbPath);
      expect(await sha256File(backupPath)).toBe(before[backupPath]);
      expect(await sha256File(existingBundle)).toBe(before[existingBundle]);
      expect(await sha256File(`${existingBundle}-wal`)).toBe(before[`${existingBundle}-wal`]);
      expect(await sha256File(`${existingBundle}-shm`)).toBe(before[`${existingBundle}-shm`]);
      await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await restoreTemporaryPaths(dbPath)).toEqual([]);
      expect(await failedBundleMainPaths(dbPath)).toHaveLength(2);
    },
  );

  it("does not delete an unowned restore destination when exclusive creation reports EEXIST", async () => {
    const { dbPath, markerPath, backupPath } = await makeMarkedRecoveryScenario();
    const preservedBefore = await fileFingerprints([dbPath, markerPath, backupPath]);
    const sentinel = "foreign restore destination";
    let foreignPath: string | undefined;

    await expect(
      Effect.runPromise(
        restoreMarkedMigrationBackup(dbPath, {
          open: async (filePath, flags, mode) => {
            foreignPath = String(filePath);
            await fs.writeFile(filePath, sentinel, { flag: "wx" });
            return fs.open(filePath, flags, mode);
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(await fileFingerprints([dbPath, markerPath, backupPath])).toEqual(preservedBefore);
    expect(foreignPath).toBeDefined();
    expect(await fs.readFile(foreignPath!, "utf8")).toBe(sentinel);

    await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));

    await expectValidRestoredProbe(dbPath);
    expect(await fs.readFile(foreignPath!, "utf8")).toBe(sentinel);
    await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await sha256File(backupPath)).toBe(preservedBefore[backupPath]);
  });

  it("reports both restore preparation and non-ENOENT cleanup failures", async () => {
    const { dbPath, markerPath, backupPath } = await makeMarkedRecoveryScenario();
    const preservedBefore = await fileFingerprints([dbPath, markerPath, backupPath]);
    const primaryMessage = "injected restore copy failure";
    const cleanupMessage = "injected restore cleanup failure";
    let ownedPath: string | undefined;

    const cause = await captureRejection(
      Effect.runPromise(
        restoreMarkedMigrationBackup(dbPath, {
          copyFile: async (source, destination) => {
            ownedPath = String(destination);
            await fs.copyFile(source, destination);
            throw new Error(primaryMessage);
          },
          unlink: async () => {
            const cleanupError = new Error(cleanupMessage) as NodeJS.ErrnoException;
            cleanupError.code = "EACCES";
            throw cleanupError;
          },
        }),
      ),
    );

    expectAggregateCauses(cause, primaryMessage, cleanupMessage);
    expect(await fileFingerprints([dbPath, markerPath, backupPath])).toEqual(preservedBefore);
    expect(ownedPath).toBeDefined();
    await expect(fs.stat(ownedPath!)).resolves.toMatchObject({});
  });

  it("reverse-rolls DB, WAL, and SHM moves after a swap rename failure, then retries", async () => {
    const { dbPath, markerPath, backupPath } = await makeMarkedRecoveryScenario();
    await fs.writeFile(`${dbPath}-wal`, "live swap wal");
    await fs.writeFile(`${dbPath}-shm`, "live swap shm");
    const preservedPaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, markerPath, backupPath];
    const before = await fileFingerprints(preservedPaths);
    const renameCalls: Array<readonly [string, string]> = [];

    await expect(
      Effect.runPromise(
        restoreMarkedMigrationBackup(dbPath, {
          rename: async (source, destination) => {
            const sourcePath = String(source);
            const destinationPath = String(destination);
            renameCalls.push([sourcePath, destinationPath]);
            if (sourcePath.endsWith(".restore") && destinationPath === dbPath) {
              throw new Error("injected restore swap failure");
            }
            await fs.rename(sourcePath, destinationPath);
          },
        }),
      ),
    ).rejects.toThrow("injected restore swap failure");

    expect(await fileFingerprints(preservedPaths)).toEqual(before);
    expect(await restoreTemporaryPaths(dbPath)).toEqual([]);
    expect(await failedBundleMainPaths(dbPath)).toEqual([]);
    expect(renameCalls).toHaveLength(7);
    expect(renameCalls.slice(0, 3).map(([source]) => source)).toEqual([
      dbPath,
      `${dbPath}-wal`,
      `${dbPath}-shm`,
    ]);
    expect(renameCalls[3]?.[0]).toMatch(/\.restore$/u);
    expect(renameCalls[3]?.[1]).toBe(dbPath);
    const forwardDestinations = renameCalls.slice(0, 3).map(([, destination]) => destination);
    expect(renameCalls.slice(4)).toEqual([
      [forwardDestinations[2], `${dbPath}-shm`],
      [forwardDestinations[1], `${dbPath}-wal`],
      [forwardDestinations[0], dbPath],
    ]);

    await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));

    await expectValidRestoredProbe(dbPath);
    await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await sha256File(backupPath)).toBe(before[backupPath]);
    expect(await restoreTemporaryPaths(dbPath)).toEqual([]);
    const [failedMain] = await failedBundleMainPaths(dbPath);
    expect(failedMain).toBeDefined();
    expect(await sha256File(failedMain!)).toBe(before[dbPath]);
    expect(await sha256File(`${failedMain!}-wal`)).toBe(before[`${dbPath}-wal`]);
    expect(await sha256File(`${failedMain!}-shm`)).toBe(before[`${dbPath}-shm`]);
  });

  it("preserves an installed restore, failed evidence, and marker after post-swap sync failure", async () => {
    const { dbPath, markerPath, backupPath } = await makeMarkedRecoveryScenario();
    await fs.writeFile(`${dbPath}-wal`, "live post-swap wal");
    await fs.writeFile(`${dbPath}-shm`, "live post-swap shm");
    const markerBefore = await sha256File(markerPath);
    const backupBefore = await sha256File(backupPath);
    let syncDirectoryCalls = 0;

    await expect(
      Effect.runPromise(
        restoreMarkedMigrationBackup(dbPath, {
          syncDirectory: async () => {
            syncDirectoryCalls += 1;
            throw new Error("injected post-swap directory sync failure");
          },
        }),
      ),
    ).rejects.toThrow("injected post-swap directory sync failure");

    expect(syncDirectoryCalls).toBe(1);
    await expectValidRestoredProbe(dbPath);
    expect(await sha256File(markerPath)).toBe(markerBefore);
    expect(await sha256File(backupPath)).toBe(backupBefore);
    expect(await restoreTemporaryPaths(dbPath)).toEqual([]);
    expect(await failedBundleMainPaths(dbPath)).toHaveLength(1);
    await expect(Effect.runPromise(requireNoPendingMigrationRecovery(dbPath))).rejects.toThrow(
      MigrationRecoveryRequiredError,
    );

    await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));

    await expectValidRestoredProbe(dbPath);
    expect(await sha256File(backupPath)).toBe(backupBefore);
    await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await restoreTemporaryPaths(dbPath)).toEqual([]);
    expect(await failedBundleMainPaths(dbPath)).toHaveLength(2);
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

  it("backs up and upgrades the immutable published v0.5.5 Windows fixture", async () => {
    const dbPath = await makeDbPath();
    const manifest = JSON.parse(
      await fs.readFile(publishedV055ManifestPath, "utf8"),
    ) as PublishedV055Manifest;
    const fixtureBytes = await fs.readFile(publishedV055FixturePath);
    const expectedPin = {
      project_id: "fixture-project",
      repository_key: "example.invalid/fixture/repository",
      pull_request_number: 55,
    } satisfies PublishedV055Pin;

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.fixture).toMatchObject({
      file: "synara-v0.5.5.sqlite",
      sizeBytes: 385024,
      sha256: publishedV055FixtureSha256,
      immutable: true,
      sidecars: [],
    });
    expect(manifest.fixture.sqlite).toMatchObject({
      pageSizeBytes: 4096,
      pageCount: 94,
      freelistCount: 0,
      journalMode: "delete",
    });
    expect(manifest.source).toMatchObject({
      release: {
        id: 355430801,
        tag: "v0.5.5",
        url: "https://github.com/Emanuele-web04/synara/releases/tag/v0.5.5",
      },
      tag: {
        commitSha: "9be46c3ce6a7521b64436b7334bc6fce16e3cac4",
      },
      releaseWorkflow: {
        id: 29547141464,
        conclusion: "success",
      },
      windowsAsset: {
        id: 479827056,
        sha256: "a61ffa7dce8babf9b04ab417a63fb788277244e23e95d19995848a4d618630d9",
        authenticodeStatus: "NotSigned",
      },
    });
    expect(manifest.capture.invocation.controls).toMatchObject({
      providerCredentialsInherited: false,
      preExistingSynaraOrAgentStateRead: false,
      codingAgentsLaunched: false,
      projectsImported: false,
    });
    expect(manifest.rawCapture.committedToRepository).toBe(false);
    expect(manifest.redistribution).toMatchObject({
      containsRealUserState: false,
      containsCredentials: false,
      rawCaptureIncluded: false,
    });
    expect(fixtureBytes.byteLength).toBe(manifest.fixture.sizeBytes);
    expect(await sha256File(publishedV055FixturePath)).toBe(publishedV055FixtureSha256);
    expect(manifest.privacyScan.patterns).toEqual(
      publishedV055PrivacyPatterns.map(({ name }) => name),
    );
    expect(manifest.privacyScan.hitCount).toBe(0);
    expect(manifest.privacyScan.hits).toEqual([]);
    expect(privacyHits(fixtureBytes)).toEqual([]);
    expect((await fs.readdir(publishedV055FixtureDirectory)).sort()).toEqual([
      "README.md",
      "manifest.json",
      "synara-v0.5.5.sqlite",
    ]);

    const source = new DatabaseSync(publishedV055FixturePath, { readOnly: true });
    const expectedHistoricalTracker = migrationEntries
      .filter(([migrationId]) => migrationId <= 54)
      .map(([migrationId, name]) => ({
        migrationId,
        name: migrationId === 54 ? "ProjectPullRequestPins" : name,
      }));
    let sourceTracker: ReturnType<typeof readMigrationTracker> = [];
    try {
      expectHealthyDatabase(source);
      expect(source.prepare("PRAGMA freelist_count").get()).toMatchObject({
        freelist_count: manifest.fixture.sqlite.freelistCount,
      });
      expect(source.prepare("PRAGMA journal_mode").get()).toMatchObject({
        journal_mode: manifest.fixture.sqlite.journalMode,
      });
      expect(source.prepare("PRAGMA page_size").get()).toMatchObject({
        page_size: manifest.fixture.sqlite.pageSizeBytes,
      });
      expect(source.prepare("PRAGMA page_count").get()).toMatchObject({
        page_count: manifest.fixture.sqlite.pageCount,
      });
      sourceTracker = readMigrationTracker(source);
      expect(sourceTracker.map(({ migrationId }) => migrationId)).toEqual(
        Array.from({ length: 54 }, (_, index) => index + 1),
      );
      expect(sourceTracker).toEqual(expectedHistoricalTracker);
      expect(sourceTracker.at(-1)).toEqual({
        migrationId: 54,
        name: "ProjectPullRequestPins",
      });
      expect(readPublishedPin(source)).toEqual(expectedPin);
      expectPublishedPinSchema(source);
      expect(readRowCensus(source)).toEqual(manifest.sanitization.rowCensus);
      expect(Object.keys(readRowCensus(source))).toHaveLength(25);
      expect(
        Object.fromEntries(
          Object.entries(readRowCensus(source)).filter(([, count]) => count !== 0),
        ),
      ).toEqual({ effect_sql_migrations: 54, project_pull_request_pins: 1 });
    } finally {
      source.close();
    }
    expect(manifest.sanitization.syntheticRows.project_pull_request_pins).toEqual([expectedPin]);
    expect(manifest.validation).toMatchObject({
      integrityCheck: "ok",
      foreignKeyCheckRows: 0,
      freelistCount: 0,
      sidecars: [],
      migrationTracker: {
        count: 54,
        minimumId: 1,
        maximumId: 54,
        contiguous: true,
        migration54Name: "ProjectPullRequestPins",
      },
      projectPullRequestPinsSchema: {
        columns: ["project_id", "repository_key", "pull_request_number"],
        compositePrimaryKeyOrder: ["project_id", "repository_key", "pull_request_number"],
        positivePullRequestNumberCheck: true,
        limitTrigger: "trg_project_pull_request_pins_limit",
        limitPerProject: 20,
      },
    });

    await fs.copyFile(publishedV055FixturePath, dbPath, fsConstants.COPYFILE_EXCL);
    expect(await sha256File(dbPath)).toBe(publishedV055FixtureSha256);

    await Effect.runPromise(
      Layer.build(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))).pipe(
        Effect.scoped,
      ),
    );

    const backups = await backupPaths(dbPath);
    expect(backups).toHaveLength(1);
    expect(path.basename(backups[0]!)).toMatch(
      /^state\.sqlite\.pre-migration-imported-v54-from54-to-v69-\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite$/,
    );
    const backup = new DatabaseSync(backups[0]!, { readOnly: true });
    try {
      expectHealthyDatabase(backup);
      expect(readMigrationTracker(backup)).toEqual(sourceTracker);
      expect(readPublishedPin(backup)).toEqual(expectedPin);
      expectPublishedPinSchema(backup);
      expect(readRowCensus(backup)).toEqual(manifest.sanitization.rowCensus);
    } finally {
      backup.close();
    }

    const upgraded = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expectHealthyDatabase(upgraded);
      expect(readMigrationTracker(upgraded)).toEqual(
        migrationEntries.map(([migrationId, name]) => ({ migrationId, name })),
      );
      expect(
        readMigrationTracker(upgraded).filter(
          ({ migrationId }) => migrationId === 54 || migrationId === 69,
        ),
      ).toEqual([
        { migrationId: 54, name: "DurableProviderCommandDelivery" },
        { migrationId: 69, name: "ProjectPullRequestPins" },
      ]);
      expect(readPublishedPin(upgraded)).toEqual(expectedPin);
      expectPublishedPinSchema(upgraded);
      const terminalSchemaObjects = upgraded
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ORDER BY name",
        )
        .all(
          "git_handoff_operations",
          "managed_attachment_blobs",
          "managed_attachment_cleanup_jobs",
          "orchestration_consumer_state",
          "orchestration_event_deliveries",
          "project_pull_request_pins",
          "provider_runtime_event_consumers",
          "provider_runtime_events",
          "provider_runtime_open_turns",
          "queued_turn_promotions",
          "trg_project_pull_request_pins_limit",
        ) as Array<{ readonly name: string }>;
      expect(terminalSchemaObjects.map(({ name }) => name)).toEqual([
        "git_handoff_operations",
        "managed_attachment_blobs",
        "managed_attachment_cleanup_jobs",
        "orchestration_consumer_state",
        "orchestration_event_deliveries",
        "project_pull_request_pins",
        "provider_runtime_event_consumers",
        "provider_runtime_events",
        "provider_runtime_open_turns",
        "queued_turn_promotions",
        "trg_project_pull_request_pins_limit",
      ]);
    } finally {
      upgraded.close();
    }

    const backupEntries = await fs.readdir(migrationBackupDirectory(dbPath));
    expect(backupEntries.some((name) => name.endsWith(".partial"))).toBe(false);
    await expect(fs.stat(migrationRecoveryMarkerPath(dbPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await sha256File(publishedV055FixturePath)).toBe(publishedV055FixtureSha256);
    expect(await fs.readFile(publishedV055FixturePath)).toEqual(fixtureBytes);
    await expect(fs.stat(`${publishedV055FixturePath}-wal`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(`${publishedV055FixturePath}-shm`)).rejects.toMatchObject({
      code: "ENOENT",
    });
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
