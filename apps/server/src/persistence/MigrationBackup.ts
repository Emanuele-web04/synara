import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  migrationBackupDirectory,
  migrationRecoveryMarkerPath,
} from "@synara/shared/migrationRecovery";
export {
  migrationBackupDirectory,
  migrationRecoveryMarkerPath,
} from "@synara/shared/migrationRecovery";

import { ensurePrivateDirectorySync, repairPrivateFile } from "../privatePathPermissions.ts";
import { withDatabaseLifecycleLock } from "./DatabaseLifecycleLock.ts";
import { migrationEntries } from "./Migrations.ts";

export const MIGRATION_BACKUP_RETENTION = 5;
export const FAILED_MIGRATION_BUNDLE_RETENTION = 3;

const STALE_RECOVERY_ARTIFACT_AGE_MS = 24 * 60 * 60 * 1_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export class MigrationRecoveryRequiredError extends Error {
  readonly _tag = "MigrationRecoveryRequiredError";

  constructor(
    readonly dbPath: string,
    readonly markerPath: string,
    readonly backupPath: string,
    detail?: string,
  ) {
    super(
      `Migration recovery is required for ${dbPath}.${detail ? ` ${detail}` : ""} Stop every Synara process, then run: synara-restore-migration-backup ${shellQuote(dbPath)}`,
    );
    this.name = "MigrationRecoveryRequiredError";
  }
}

type MigrationBackupPlan = {
  readonly sourceVersion: string;
  readonly targetVersion: number;
};

export type MigrationBackupFileOperations = {
  readonly open?: typeof fs.open;
};

type MigrationFileHandle = Awaited<ReturnType<typeof fs.open>>;

export type MigrationRecoveryFileOperations = {
  readonly open?: typeof fs.open;
  readonly writeFile?: (
    handle: MigrationFileHandle,
    contents: string,
    filePath: string,
  ) => Promise<void>;
  readonly copyFile?: typeof fs.copyFile;
  readonly rename?: typeof fs.rename;
  readonly unlink?: typeof fs.unlink;
  readonly syncFile?: (handle: MigrationFileHandle, filePath: string) => Promise<void>;
  readonly closeFile?: (handle: MigrationFileHandle, filePath: string) => Promise<void>;
  readonly syncDirectory?: (directoryPath: string) => Promise<void>;
  readonly validateTemporary?: (filePath: string) => Promise<void>;
};

export type MigrationBackupResult = MigrationBackupPlan & {
  readonly backupPath: string;
};

const attemptPromise = <A>(tryPromise: () => Promise<A>) =>
  Effect.tryPromise({ try: tryPromise, catch: (cause) => cause });

const latestMigrationId = Math.max(...migrationEntries.map(([id]) => id));
const UUID_V4_PATTERN_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function exclusiveWritableFileFlags(): number {
  return (
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_RDWR |
    (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW)
  );
}

function syncableFileFlags(): number {
  return process.platform === "win32"
    ? fsConstants.O_RDWR
    : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
}

function withSecondaryFailures(
  primary: unknown,
  secondary: ReadonlyArray<unknown>,
  message: string,
): unknown {
  return secondary.length === 0
    ? primary
    : new AggregateError([primary, ...secondary], message, { cause: primary });
}

async function useAndCloseFileHandle<A>(
  handle: MigrationFileHandle,
  filePath: string,
  fileOperations: MigrationRecoveryFileOperations,
  use: (handle: MigrationFileHandle) => Promise<A>,
): Promise<A> {
  let completed = false;
  let value: A | undefined;
  let primary: unknown;
  try {
    value = await use(handle);
    completed = true;
  } catch (cause) {
    primary = cause;
  }

  try {
    await (fileOperations.closeFile ?? ((current) => current.close()))(handle, filePath);
  } catch (closeCause) {
    if (!completed) {
      throw withSecondaryFailures(
        primary,
        [closeCause],
        `Migration recovery file operation and close both failed: ${filePath}`,
      );
    }
    throw closeCause;
  }

  if (!completed) throw primary;
  return value as A;
}

async function removeOwnedTemporaryFile(
  filePath: string,
  fileOperations: MigrationRecoveryFileOperations,
  failures: Array<unknown>,
): Promise<void> {
  try {
    await (fileOperations.unlink ?? fs.unlink)(filePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") failures.push(cause);
  }
}

export const inspectMigrationBackupPlan = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `;
  if (tables.length === 0) {
    return null;
  }

  const hasTracker = tables.some((table) => table.name === "effect_sql_migrations");
  if (!hasTracker) {
    return { sourceVersion: "untracked", targetVersion: latestMigrationId };
  }

  const recordedResult = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC
  `.pipe(
    Effect.map((rows) => ({ status: "read" as const, rows })),
    Effect.catch(() => Effect.succeed({ status: "malformed" as const })),
  );
  if (recordedResult.status === "malformed") {
    return { sourceVersion: "malformed-tracker", targetVersion: latestMigrationId };
  }
  const recorded = recordedResult.rows;
  const userTables = tables.filter((table) => table.name !== "effect_sql_migrations");
  if (recorded.length === 0) {
    return userTables.length === 0
      ? null
      : { sourceVersion: "untracked", targetVersion: latestMigrationId };
  }

  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name] as const));
  const highWaterMark = recorded[recorded.length - 1]!.migration_id;
  const canonicalPrefixThrough31 = migrationEntries
    .filter(([id]) => id < 32)
    .every(([id, name]) => recordedNames.get(id) === name);
  if (
    canonicalPrefixThrough31 &&
    recordedNames.has(32) &&
    recordedNames.get(32) !== "ReconcileImportedSchemaLineage"
  ) {
    return { sourceVersion: `v${highWaterMark}-legacy32`, targetVersion: latestMigrationId };
  }

  const firstDivergedId = migrationEntries.find(
    ([id, name]) => id <= highWaterMark && recordedNames.get(id) !== name,
  )?.[0];
  if (firstDivergedId !== undefined) {
    // Shared-lineage divergence is rejected before the migrator mutates data.
    if (firstDivergedId <= 16) {
      return null;
    }
    return {
      sourceVersion: `imported-v${highWaterMark}-from${firstDivergedId}`,
      targetVersion: latestMigrationId,
    };
  }

  if (highWaterMark < latestMigrationId) {
    return { sourceVersion: `v${highWaterMark}`, targetVersion: latestMigrationId };
  }
  return null;
});

function compactTimestamp(date: Date): string {
  return date.toISOString().replaceAll(/[-:.]/gu, "");
}

function safeVersionLabel(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "-");
}

async function ensurePrivateBackupDirectory(directory: string): Promise<void> {
  ensurePrivateDirectorySync(directory);
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw cause;
  } finally {
    await handle.close();
  }
}

async function ensurePrivateRegularFile(filePath: string) {
  await repairPrivateFile(filePath);
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Migration backup is not a regular file: ${filePath}`);
  }
  return stat;
}

async function removeStaleRegularFiles(
  directory: string,
  matches: (name: string) => boolean,
  unlink: (filePath: string) => Promise<void> = fs.unlink,
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  });
  const cutoff = Date.now() - STALE_RECOVERY_ARTIFACT_AGE_MS;
  for (const entry of entries) {
    if (!entry.isFile() || !matches(entry.name)) continue;
    const artifactPath = path.join(directory, entry.name);
    let stat;
    try {
      stat = await fs.lstat(artifactPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw cause;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs >= cutoff) continue;
    try {
      await unlink(artifactPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
}

function generatedMarkerPartialNamePattern(dbPath: string): RegExp {
  const markerBasename = escapeRegExp(path.basename(migrationRecoveryMarkerPath(dbPath)));
  return new RegExp(`^${markerBasename}\\.${UUID_V4_PATTERN_SOURCE}\\.partial$`, "u");
}

function generatedRestoreTemporaryNamePattern(dbPath: string): RegExp {
  const databaseBasename = escapeRegExp(path.basename(dbPath));
  return new RegExp(`^${databaseBasename}\\.${UUID_V4_PATTERN_SOURCE}\\.restore$`, "u");
}

async function removeStaleMarkerPartials(
  dbPath: string,
  fileOperations: MigrationRecoveryFileOperations,
): Promise<void> {
  const markerPattern = generatedMarkerPartialNamePattern(dbPath);
  await removeStaleRegularFiles(
    path.dirname(dbPath),
    (name) => markerPattern.test(name),
    fileOperations.unlink,
  );
}

async function pruneFailedMigrationBundles(dbPath: string): Promise<void> {
  const directory = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.failed-migration-`;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const bundleNames = new Set(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
      .map((entry) => entry.name.replace(/-(?:wal|shm)$/u, "")),
  );
  const bundles = (
    await Promise.all(
      [...bundleNames].map(async (name) => {
        try {
          return {
            name,
            modifiedAt: (await fs.lstat(path.join(directory, name))).mtimeMs,
          };
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          // A crash can leave only WAL/SHM sidecars. They are not a restorable
          // failed bundle and must not keep a completed restore retrying forever.
          await Promise.all(
            ["-wal", "-shm"].map((suffix) =>
              fs.unlink(path.join(directory, `${name}${suffix}`)).catch((unlinkCause) => {
                if ((unlinkCause as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkCause;
              }),
            ),
          );
          return null;
        }
      }),
    )
  ).filter(
    (bundle): bundle is { readonly name: string; readonly modifiedAt: number } => bundle !== null,
  );
  bundles.sort(
    (left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name),
  );
  await Promise.all(
    bundles.slice(FAILED_MIGRATION_BUNDLE_RETENTION).flatMap(({ name }) =>
      ["", "-wal", "-shm"].map((suffix) =>
        fs.unlink(path.join(directory, `${name}${suffix}`)).catch((cause) => {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }),
      ),
    ),
  );
}

export const pruneMigrationBackups = (dbPath: string, retention = MIGRATION_BACKUP_RETENTION) =>
  attemptPromise(async () => {
    const backupDirectory = migrationBackupDirectory(dbPath);
    const prefix = `${path.basename(dbPath)}.pre-migration-`;
    const entries = await fs.readdir(backupDirectory, { withFileTypes: true }).catch((cause) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    });
    const backupNames = entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".sqlite"),
      )
      .map((entry) => entry.name);
    const backups = await Promise.all(
      backupNames.map(async (name) => {
        const stat = await ensurePrivateRegularFile(path.join(backupDirectory, name));
        return { name, modifiedAt: stat.mtimeMs };
      }),
    );
    backups.sort(
      (left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name),
    );
    await Promise.all(
      backups
        .slice(Math.max(0, retention))
        .map(({ name }) => fs.unlink(path.join(backupDirectory, name))),
    );
  });

export const createMigrationBackup = (
  dbPath: string,
  plan: MigrationBackupPlan,
  fileOperations: MigrationBackupFileOperations = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const backupDirectory = migrationBackupDirectory(dbPath);
    yield* attemptPromise(() => ensurePrivateBackupDirectory(backupDirectory));
    const basename = path.basename(dbPath);
    yield* attemptPromise(() =>
      removeStaleRegularFiles(
        backupDirectory,
        (name) => name.startsWith(`.${basename}.pre-migration-`) && name.endsWith(".partial"),
      ),
    );
    const uniqueSuffix = `${compactTimestamp(new Date())}-${randomUUID()}`;
    const finalName = `${basename}.pre-migration-${safeVersionLabel(plan.sourceVersion)}-to-v${plan.targetVersion}-${uniqueSuffix}.sqlite`;
    const backupPath = path.join(backupDirectory, finalName);
    const temporaryPath = path.join(backupDirectory, `.${finalName}.partial`);

    yield* sql`VACUUM INTO ${temporaryPath}`.pipe(
      Effect.tapError(() => attemptPromise(() => fs.unlink(temporaryPath)).pipe(Effect.ignore)),
    );
    yield* attemptPromise(async () => {
      try {
        await ensurePrivateRegularFile(temporaryPath);
        const flags =
          process.platform === "win32"
            ? fsConstants.O_RDWR
            : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
        const handle = await (fileOperations.open ?? fs.open)(temporaryPath, flags);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporaryPath, backupPath);
        await syncDirectory(backupDirectory);
      } catch (cause) {
        await fs.unlink(temporaryPath).catch(() => undefined);
        throw cause;
      }
    });
    yield* pruneMigrationBackups(dbPath);
    return { ...plan, backupPath } satisfies MigrationBackupResult;
  });

const writeRecoveryMarker = (
  dbPath: string,
  backup: MigrationBackupResult,
  fileOperations: MigrationRecoveryFileOperations,
) =>
  attemptPromise(async () => {
    const markerPath = migrationRecoveryMarkerPath(dbPath);
    const temporaryPath = `${markerPath}.${randomUUID()}.partial`;
    const payload = {
      databasePath: dbPath,
      backupPath: backup.backupPath,
      sourceVersion: backup.sourceVersion,
      targetVersion: backup.targetVersion,
      phase: "migration-in-progress",
      createdAt: new Date().toISOString(),
      recovery:
        "Synara will refuse to open this database until an operator stops every Synara process and runs the explicit migration-backup restore command.",
    };
    let ownsTemporaryPath = false;
    try {
      const handle = await (fileOperations.open ?? fs.open)(
        temporaryPath,
        exclusiveWritableFileFlags(),
        0o600,
      );
      ownsTemporaryPath = true;
      await useAndCloseFileHandle(handle, temporaryPath, fileOperations, async (current) => {
        await (
          fileOperations.writeFile ??
          ((target, contents) => target.writeFile(contents, { encoding: "utf8" }))
        )(current, `${JSON.stringify(payload, null, 2)}\n`, temporaryPath);
        await ensurePrivateRegularFile(temporaryPath);
        await (fileOperations.syncFile ?? ((target) => target.sync()))(current, temporaryPath);
      });
      await (fileOperations.rename ?? fs.rename)(temporaryPath, markerPath);
      // A successful rename publishes durable recovery evidence. Never treat the
      // final marker as temporary, even if the following directory sync fails.
      ownsTemporaryPath = false;
      await (fileOperations.syncDirectory ?? syncDirectory)(path.dirname(markerPath));
    } catch (cause) {
      const cleanupFailures: Array<unknown> = [];
      if (ownsTemporaryPath) {
        await removeOwnedTemporaryFile(temporaryPath, fileOperations, cleanupFailures);
      }
      throw withSecondaryFailures(
        cause,
        cleanupFailures,
        `Migration recovery marker failure and temporary cleanup both failed: ${temporaryPath}`,
      );
    }
  });

const removeRecoveryMarker = (dbPath: string) =>
  attemptPromise(async () => {
    await fs.unlink(migrationRecoveryMarkerPath(dbPath));
    await syncDirectory(path.dirname(dbPath));
  });

export const runWithPreMigrationBackup = <A, E, R>(
  dbPath: string,
  migration: Effect.Effect<A, E, R>,
  fileOperations: MigrationRecoveryFileOperations = {},
) =>
  Effect.gen(function* () {
    // Production startup invokes this while holding the database lifecycle lock.
    // Sweep before plan inspection so an already-current database still removes
    // interrupted marker publication debris.
    yield* attemptPromise(() => removeStaleMarkerPartials(dbPath, fileOperations));
    const plan = yield* inspectMigrationBackupPlan;
    const backup = plan ? yield* createMigrationBackup(dbPath, plan) : null;
    if (backup) {
      // This write-ahead marker must be durable before migrations can mutate
      // the live database. A later startup will fail closed until an operator
      // explicitly restores the known-good snapshot.
      yield* writeRecoveryMarker(dbPath, backup, fileOperations);
    }
    const result = yield* migration;
    if (backup) {
      yield* removeRecoveryMarker(dbPath);
    }
    return result;
  });

/**
 * Restores a standalone SQLite migration snapshot. The caller must stop every
 * process using the database first; stale WAL/SHM files are moved aside with
 * the failed main database so they cannot replay into the restored snapshot.
 */
const restoreSqliteMigrationBackup = (
  input: {
    readonly dbPath: string;
    readonly backupPath: string;
  },
  fileOperations: MigrationRecoveryFileOperations,
) =>
  attemptPromise(async () => {
    await validateSqliteMigrationBackup(input.backupPath);
    const dbDirectory = path.dirname(input.dbPath);
    const restoreTemporaryPattern = generatedRestoreTemporaryNamePattern(input.dbPath);
    await removeStaleRegularFiles(
      dbDirectory,
      (name) => restoreTemporaryPattern.test(name),
      fileOperations.unlink,
    );
    const restoredTemporaryPath = `${input.dbPath}.${randomUUID()}.restore`;
    const failedSuffix = `.failed-migration-${compactTimestamp(new Date())}-${randomUUID()}`;
    const moved: Array<readonly [string, string]> = [];
    let ownsRestoredTemporaryPath = false;
    let restoredDatabaseInstalled = false;
    try {
      const reservationHandle = await (fileOperations.open ?? fs.open)(
        restoredTemporaryPath,
        exclusiveWritableFileFlags(),
        0o600,
      );
      ownsRestoredTemporaryPath = true;
      await useAndCloseFileHandle(
        reservationHandle,
        restoredTemporaryPath,
        fileOperations,
        async () => undefined,
      );

      // COPYFILE_EXCL cannot target the reservation we already own. A normal
      // copy is safe here because the exact UUID path was exclusively created by
      // this operation and remains under its cleanup ownership.
      await (fileOperations.copyFile ?? fs.copyFile)(input.backupPath, restoredTemporaryPath);
      await ensurePrivateRegularFile(restoredTemporaryPath);
      await (fileOperations.validateTemporary ?? validateSqliteMigrationBackup)(
        restoredTemporaryPath,
      );
      const restoredHandle = await (fileOperations.open ?? fs.open)(
        restoredTemporaryPath,
        syncableFileFlags(),
      );
      await useAndCloseFileHandle(
        restoredHandle,
        restoredTemporaryPath,
        fileOperations,
        async (current) => {
          await (fileOperations.syncFile ?? ((target) => target.sync()))(
            current,
            restoredTemporaryPath,
          );
        },
      );

      for (const suffix of ["", "-wal", "-shm"]) {
        const source = `${input.dbPath}${suffix}`;
        const destination = `${input.dbPath}${failedSuffix}${suffix}`;
        try {
          await (fileOperations.rename ?? fs.rename)(source, destination);
          moved.push([source, destination]);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
      }
      await (fileOperations.rename ?? fs.rename)(restoredTemporaryPath, input.dbPath);
      restoredDatabaseInstalled = true;
      ownsRestoredTemporaryPath = false;
    } catch (cause) {
      const cleanupFailures: Array<unknown> = [];
      if (!restoredDatabaseInstalled) {
        if (ownsRestoredTemporaryPath) {
          await removeOwnedTemporaryFile(restoredTemporaryPath, fileOperations, cleanupFailures);
        }
        for (const [source, destination] of moved.reverse()) {
          try {
            await (fileOperations.rename ?? fs.rename)(destination, source);
          } catch (rollbackCause) {
            cleanupFailures.push(rollbackCause);
          }
        }
      }
      throw withSecondaryFailures(
        cause,
        cleanupFailures,
        `Migration restore failure and rollback both failed: ${input.dbPath}`,
      );
    }

    // Make the database/WAL/SHM swap durable before clearing the marker. A
    // crash or cleanup failure before the final unlink therefore remains an
    // explicit, retryable recovery state.
    await (fileOperations.syncDirectory ?? syncDirectory)(path.dirname(input.dbPath));
    await pruneFailedMigrationBundles(input.dbPath);
    await (fileOperations.syncDirectory ?? syncDirectory)(path.dirname(input.dbPath));
    await fs.unlink(migrationRecoveryMarkerPath(input.dbPath)).catch((cause) => {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    });
    await (fileOperations.syncDirectory ?? syncDirectory)(path.dirname(input.dbPath));
  });

async function validateSqliteMigrationBackup(backupPath: string): Promise<void> {
  const backupStat = await fs.lstat(backupPath);
  if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
    throw new Error(`Migration backup is not a regular file: ${backupPath}`);
  }

  let integrity: unknown;
  if (process.versions.bun !== undefined) {
    const { Database } = await import("bun:sqlite");
    const database = new Database(backupPath, { readonly: true });
    try {
      integrity = database.query("PRAGMA integrity_check").get();
    } finally {
      database.close();
    }
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(backupPath, { readOnly: true });
    try {
      integrity = database.prepare("PRAGMA integrity_check").get();
    } finally {
      database.close();
    }
  }
  if (
    !integrity ||
    typeof integrity !== "object" ||
    !Object.values(integrity as Record<string, unknown>).includes("ok")
  ) {
    throw new Error(`Migration backup failed SQLite integrity_check: ${backupPath}`);
  }
}

type MigrationRecoveryMarker = {
  readonly markerPath: string;
  readonly backupPath: string;
};

function generatedBackupNamePattern(dbPath: string): RegExp {
  const escapedBasename = escapeRegExp(path.basename(dbPath));
  return new RegExp(
    `^${escapedBasename}\\.pre-migration-[A-Za-z0-9_-]+-to-v\\d+-\\d{8}T\\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.sqlite$`,
    "iu",
  );
}

async function readRegularFileNoFollow(filePath: string): Promise<string> {
  const pathStat = await fs.lstat(filePath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`Path is not a real regular file: ${filePath}`);
  }
  const flags =
    process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const handle = await fs.open(filePath, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Path is not a regular file: ${filePath}`);
    if (process.platform !== "win32" && (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino)) {
      throw new Error(`Path identity changed while it was opened: ${filePath}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function readMigrationRecoveryMarker(
  dbPath: string,
): Promise<MigrationRecoveryMarker | null> {
  const markerPath = migrationRecoveryMarkerPath(dbPath);
  let markerText: string;
  try {
    markerText = await readRegularFileNoFollow(markerPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }

  const marker = JSON.parse(markerText) as {
    readonly databasePath?: unknown;
    readonly backupPath?: unknown;
  };
  if (marker.databasePath !== dbPath || typeof marker.backupPath !== "string") {
    throw new Error(`Invalid migration recovery marker: ${markerPath}`);
  }
  const backupDirectory = path.resolve(migrationBackupDirectory(dbPath));
  const backupDirectoryStat = await fs.lstat(backupDirectory);
  if (!backupDirectoryStat.isDirectory() || backupDirectoryStat.isSymbolicLink()) {
    throw new Error(`Invalid migration backup directory: ${backupDirectory}`);
  }
  const backupPath = path.resolve(marker.backupPath);
  const backupName = path.basename(backupPath);
  if (
    marker.backupPath !== backupPath ||
    path.dirname(backupPath) !== backupDirectory ||
    !generatedBackupNamePattern(dbPath).test(backupName)
  ) {
    throw new Error(`Migration recovery marker references an invalid backup: ${backupPath}`);
  }
  const backupStat = await fs.lstat(backupPath);
  if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
    throw new Error(`Migration recovery marker references a non-regular backup: ${backupPath}`);
  }
  const canonicalBackupDirectory = await fs.realpath(backupDirectory);
  const canonicalBackupPath = await fs.realpath(backupPath);
  if (path.dirname(canonicalBackupPath) !== canonicalBackupDirectory) {
    throw new Error(
      `Migration recovery marker backup escapes its canonical directory: ${backupPath}`,
    );
  }
  return { markerPath, backupPath };
}

/** Read-only startup guard. It never restores, renames, or removes recovery files. */
export const requireNoPendingMigrationRecovery = (dbPath: string) =>
  attemptPromise(async () => {
    let marker: MigrationRecoveryMarker | null;
    try {
      marker = await readMigrationRecoveryMarker(dbPath);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new MigrationRecoveryRequiredError(
        dbPath,
        migrationRecoveryMarkerPath(dbPath),
        "unknown",
        `The recovery marker could not be validated: ${detail}.`,
      );
    }
    if (marker) {
      throw new MigrationRecoveryRequiredError(dbPath, marker.markerPath, marker.backupPath);
    }
  });

/**
 * Explicit one-shot recovery path. The operator must stop every Synara process
 * before invoking it; startup itself deliberately never calls this function.
 */
export const restoreMarkedMigrationBackup = (
  dbPath: string,
  fileOperations: MigrationRecoveryFileOperations = {},
) =>
  withDatabaseLifecycleLock(
    dbPath,
    attemptPromise(async () => {
      const marker = await readMigrationRecoveryMarker(dbPath);
      if (!marker) {
        throw new Error(
          `No migration recovery marker exists: ${migrationRecoveryMarkerPath(dbPath)}`,
        );
      }
      await Effect.runPromise(
        restoreSqliteMigrationBackup({ dbPath, backupPath: marker.backupPath }, fileOperations),
      );
    }),
  );
