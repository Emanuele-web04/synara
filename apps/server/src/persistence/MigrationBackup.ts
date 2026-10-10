import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS,
  migrationBackupDirectory,
  migrationBackupProvenancePath,
  migrationRecoveryMarkerPath,
  parseMigrationRecoveryResumeState,
  type MigrationSchemaTooNewRecovery,
} from "@synara/shared/migrationRecovery";
export {
  migrationBackupDirectory,
  migrationBackupProvenancePath,
  migrationRecoveryMarkerPath,
} from "@synara/shared/migrationRecovery";

import {
  sameFileIdentity,
  syncDirectoryEntry,
  syncRegularFile,
} from "@synara/shared/filesystemPlatform";
import { ensurePrivateDirectorySync, repairPrivateFile } from "../privatePathPermissions.ts";
import { withDatabaseLifecycleLock } from "./DatabaseLifecycleLock.ts";
import {
  createMigrationDivergenceConsentChallenge,
  MigrationDivergenceConsentRequiredError,
  type MigrationDivergencePlan,
} from "./MigrationDivergenceConsent.ts";
export { MigrationDivergenceConsentRequiredError } from "./MigrationDivergenceConsent.ts";
import {
  findFirstMigrationLineageDivergence,
  LAST_SHARED_LINEAGE_MIGRATION_ID,
  migrationEntries,
  planLegacyMigration32Rename,
  planMigrationLineageAliasRepairs,
} from "./Migrations.ts";

/** keep at most this many finished pre-migration backups (issue #618) */
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "an unknown amount";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** raised instead of starting a backup that cannot fit — migrating without a restorable snapshot risks user data; half-writing one risks their disk */
export class InsufficientMigrationBackupSpaceError extends Error {
  readonly _tag = "InsufficientMigrationBackupSpaceError";

  constructor(
    readonly requiredBytes: number,
    readonly availableBytes: number,
    readonly directory: string,
  ) {
    super(
      `Not enough free disk space to back up the database before upgrading it. ` +
        `About ${formatBytes(requiredBytes)} is needed in ${directory}, but only ` +
        `${formatBytes(availableBytes)} is free. Free up disk space and start Synara again.`,
    );
    this.name = "InsufficientMigrationBackupSpaceError";
  }
}

const MIGRATION_BACKUP_FREE_SPACE_FACTOR = 2;

const logicalDatabaseSizeBytes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly pageCount: number;
    readonly pageSize: number;
  }>`
    SELECT
      page_count AS "pageCount",
      page_size AS "pageSize"
    FROM pragma_page_count(), pragma_page_size()
  `;
  const pageCount = Number(rows[0]?.pageCount);
  const pageSize = Number(rows[0]?.pageSize);
  const logicalBytes = pageCount * pageSize;
  return Number.isFinite(logicalBytes) && logicalBytes >= 0 ? logicalBytes : null;
});

/** `page_count * page_size` includes committed pages still only in the WAL; fallback is main file + physical WAL; failure to inspect either is deliberately null — an indeterminate estimate must not block an upgrade */
export const estimateMigrationBackupRequiredBytes = (dbPath: string) =>
  Effect.gen(function* () {
    const logicalBytes = yield* logicalDatabaseSizeBytes.pipe(
      Effect.matchCause({
        onFailure: () => null,
        onSuccess: (bytes) => bytes,
      }),
    );
    return yield* Effect.promise(async () => {
      let mainFileBytes: number;
      try {
        mainFileBytes = (await fs.stat(dbPath)).size;
      } catch {
        return null;
      }

      let snapshotBytes: number;
      if (logicalBytes !== null) {
        snapshotBytes = Math.max(mainFileBytes, logicalBytes);
      } else {
        let walBytes = 0;
        try {
          walBytes = (await fs.stat(`${dbPath}-wal`)).size;
        } catch {
          // the WAL is optional, and an unreadable fallback must not make startup less reliable than before the guard existed
        }
        snapshotBytes = mainFileBytes + walBytes;
      }

      const requiredBytes = snapshotBytes * MIGRATION_BACKUP_FREE_SPACE_FACTOR;
      return Number.isFinite(requiredBytes) && requiredBytes >= 0 ? requiredBytes : null;
    });
  });

/** an unavailable/racing statfs must never block an upgrade — indeterminate is treated as "proceed" */
async function assertBackupSpaceAvailable(
  requiredBytes: number | null,
  backupDirectory: string,
): Promise<void> {
  if (requiredBytes === null) return;
  let availableBytes: number;
  try {
    const filesystem = await fs.statfs(backupDirectory);
    availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  } catch {
    return;
  }
  if (!Number.isFinite(requiredBytes) || !Number.isFinite(availableBytes)) return;
  if (availableBytes < requiredBytes) {
    throw new InsufficientMigrationBackupSpaceError(requiredBytes, availableBytes, backupDirectory);
  }
}

type MigrationBackupPlan = MigrationDivergencePlan;

export type MigrationBackupResult = MigrationBackupPlan & {
  readonly backupPath: string;
  readonly createdAt: string;
};

const attemptPromise = <A>(tryPromise: () => Promise<A>) =>
  Effect.tryPromise({ try: tryPromise, catch: (cause) => cause });

const latestMigrationId = Math.max(...migrationEntries.map(([id]) => id));

function migrationLineageFingerprint(
  recorded: ReadonlyArray<{ readonly migration_id: number; readonly name: string }>,
): string {
  return createHash("sha256")
    .update(JSON.stringify(recorded.map(({ migration_id, name }) => [migration_id, name])))
    .digest("hex");
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
  const inspectedNames = new Map(recordedNames);
  const migration32Rename = planLegacyMigration32Rename(recordedNames);
  if (migration32Rename !== null) {
    inspectedNames.set(32, migration32Rename);
  }
  for (const repair of planMigrationLineageAliasRepairs(inspectedNames)) {
    if (repair.kind === "rename") {
      inspectedNames.set(repair.migrationId, repair.name);
    } else {
      inspectedNames.delete(repair.migrationId);
    }
  }
  const inspectedHighWaterMark = Math.max(...inspectedNames.keys(), 0);
  // same post-alias predicate the reconciler uses — "needs consent" and "will be replayed" stay aligned
  const firstDiverged = findFirstMigrationLineageDivergence(inspectedNames, inspectedHighWaterMark);
  if (firstDiverged !== undefined) {
    const [firstDivergedId, expectedName] = firstDiverged;
    // shared-lineage divergence rejected before the migrator mutates data
    if (firstDivergedId <= LAST_SHARED_LINEAGE_MIGRATION_ID) {
      return null;
    }
    return {
      sourceVersion:
        migration32Rename === null
          ? `imported-v${highWaterMark}-from${firstDivergedId}`
          : `v${highWaterMark}-legacy32`,
      targetVersion: latestMigrationId,
      lineageDivergence: {
        firstDivergedId,
        expectedName,
        recordedName: inspectedNames.get(firstDivergedId) ?? "<missing>",
        highWaterMark,
        lineageFingerprint: migrationLineageFingerprint(recorded),
      },
    };
  }

  if (migration32Rename !== null) {
    return { sourceVersion: `v${highWaterMark}-legacy32`, targetVersion: latestMigrationId };
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

async function ensurePrivateRegularFile(filePath: string) {
  await repairPrivateFile(filePath);
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Migration backup is not a regular file: ${filePath}`);
  }
  return stat;
}

async function assertDirectoryIdentity(directory: string, openedStat: Stats): Promise<void> {
  const currentStat = await fs.lstat(directory);
  if (
    !currentStat.isDirectory() ||
    currentStat.isSymbolicLink() ||
    !sameFileIdentity(openedStat, currentStat)
  ) {
    throw new Error(`Directory identity changed while it was open: ${directory}`);
  }
}

function nullOnMissing(cause: unknown): null {
  if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw cause;
}

/** the only guarded delete in this module: lstat each name and re-check it is still a regular non-symlink file before unlink; the directory stays open with no-follow for the whole sweep so a symlinked root can't redirect cleanup; a missing dir is not an error */
type DirectorySweep = {
  readonly names: ReadonlyArray<string>;
  readonly lstat: (name: string) => Promise<Stats | null>;
  readonly unlink: (name: string) => Promise<void>;
};

async function withCleanupDirectory(
  directory: string,
  sweep: (context: DirectorySweep) => Promise<void>,
): Promise<void> {
  const pathStat = await fs.lstat(directory).catch(nullOnMissing);
  if (pathStat === null) return;
  if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
    throw new Error(`Cleanup root is not a real directory: ${directory}`);
  }

  const run = async (openedStat: Stats) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    await sweep({
      names: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
      lstat: (name) => fs.lstat(path.join(directory, name)).catch(nullOnMissing),
      unlink: async (name) => {
        const artifactPath = path.join(directory, name);
        const stat = await fs.lstat(artifactPath).catch(nullOnMissing);
        if (!stat || !stat.isFile() || stat.isSymbolicLink()) return;
        await assertDirectoryIdentity(directory, openedStat);
        await fs.unlink(artifactPath).catch((cause) => {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        });
      },
    });
  };

  // Windows can't portably fsync directory handles; on Unix keep an O_NOFOLLOW descriptor open for the entire sweep
  if (process.platform === "win32") {
    await run(pathStat);
    return;
  }

  const directoryHandle = await fs.open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const openedStat = await directoryHandle.stat();
    if (!openedStat.isDirectory() || !sameFileIdentity(openedStat, pathStat)) {
      throw new Error(`Cleanup root changed while it was opened: ${directory}`);
    }
    await run(openedStat);
  } finally {
    await directoryHandle.close();
  }
}

/** omitting `olderThanMs` removes every match — correct only for artifacts whose exclusive owner is the caller holding the lifecycle lock */
async function removeRegularFiles(
  directory: string,
  matches: (name: string) => boolean,
  options: { readonly olderThanMs?: number } = {},
): Promise<void> {
  await withCleanupDirectory(directory, async ({ names, lstat, unlink }) => {
    const cutoff =
      options.olderThanMs === undefined
        ? Number.POSITIVE_INFINITY
        : Date.now() - options.olderThanMs;
    await Promise.all(
      names.filter(matches).map(async (name) => {
        if (cutoff !== Number.POSITIVE_INFINITY) {
          const stat = await lstat(name);
          if (!stat || stat.mtimeMs >= cutoff) return;
        }
        await unlink(name);
      }),
    );
  });
}

const removeStaleRegularFiles = (directory: string, matches: (name: string) => boolean) =>
  removeRegularFiles(directory, matches, { olderThanMs: STALE_RECOVERY_ARTIFACT_AGE_MS });

/** the leading dot is load-bearing — it is why these orphans never matched the finished-backup prefix retention filters on */
function isMigrationBackupPartial(dbBasename: string): (name: string) => boolean {
  const partialPrefix = `.${dbBasename}.pre-migration-`;
  return (name) => name.startsWith(partialPrefix) && name.endsWith(".partial");
}

/** lands next to the database, not the backup dir — the backup-partial sweep never sees them; a crash in the tiny write window strands the file permanently */
function isAtomicMigrationJsonPartial(basename: string): (name: string) => boolean {
  const partialPrefix = `${basename}.`;
  return (name) => name !== basename && name.startsWith(partialPrefix) && name.endsWith(".partial");
}

const BUNDLE_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;
const BUNDLE_SIDECAR_PATTERN = /-(?:wal|shm)$/u;

/** compactTimestamp emits YYYYMMDDThhmmssmmmZ but older artifacts (pre-tracker-repair) use YYYYMMDDThhmm — seconds/milliseconds optional, Z not required; lookarounds stop a longer digit run reading as a timestamp */
const ARTIFACT_TIMESTAMP_PATTERN =
  /(?<!\d)(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(\d{3})?Z?(?!\d)/gu;

/** orders on the filename timestamp — the only key surviving restore/copy/backup tools that rewrite mtime; reordering by mtime is how the newest snapshot gets pruned; null = retain, never delete */
function artifactTimestampMs(name: string): number | null {
  let parsed: number | null = null;
  for (const match of name.matchAll(ARTIFACT_TIMESTAMP_PATTERN)) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = match[6] === undefined ? 0 : Number(match[6]);
    const millisecond = match[7] === undefined ? 0 : Number(match[7]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    if (hour > 23 || minute > 59 || second > 59) continue;
    parsed = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  }
  return parsed;
}

/** `directory` is part of the descriptor — families live in different trees and one pointed wrong either reclaims nothing or reclaims something it doesn't own */
type MigrationArtifactFamily = {
  readonly directory: string;
  /** never matches the live database */
  readonly prefix: string;
  readonly suffix?: string;
  readonly retention: number;
  /** members own their -wal/-shm sidecars, reclaimed together */
  readonly bundled?: boolean;
  readonly ensurePrivate?: boolean;
};

/** single retention implementation for every family — families differ only in location/names/count, never in safety rules: regular files only, no symlink following, no deletion of unclaimed or unrankable names, ENOENT tolerated */
async function pruneMigrationArtifactFamily(family: MigrationArtifactFamily): Promise<void> {
  const suffix = family.suffix ?? "";
  await withCleanupDirectory(family.directory, async ({ names, unlink }) => {
    const present = new Set(names);
    const members = new Set(
      names
        .filter((name) => name.startsWith(family.prefix) && name.endsWith(suffix))
        .map((name) => (family.bundled ? name.replace(BUNDLE_SIDECAR_PATTERN, "") : name)),
    );

    const ranked = (
      await Promise.all(
        [...members].map(async (name) => {
          if (family.bundled && !present.has(name)) {
            // a crash can leave only WAL/SHM sidecars — not a restorable bundle, reclaimed outright rather than ranked
            await Promise.all(
              BUNDLE_SIDECAR_SUFFIXES.map((sidecar) => unlink(`${name}${sidecar}`)),
            );
            return null;
          }
          const timestampMs = artifactTimestampMs(name);
          if (timestampMs === null) return null;
          if (
            family.ensurePrivate &&
            (await ensurePrivateRegularFile(path.join(family.directory, name)).catch(
              nullOnMissing,
            )) === null
          ) {
            return null;
          }
          return { name, timestampMs };
        }),
      )
    ).filter(
      (member): member is { readonly name: string; readonly timestampMs: number } =>
        member !== null,
    );

    ranked.sort(
      (left, right) => right.timestampMs - left.timestampMs || right.name.localeCompare(left.name),
    );
    await Promise.all(
      ranked
        .slice(Math.max(0, family.retention))
        .flatMap(({ name }) =>
          family.bundled
            ? ["", ...BUNDLE_SIDECAR_SUFFIXES].map((sidecar) => unlink(`${name}${sidecar}`))
            : [unlink(name)],
        ),
    );
  });
}

const preMigrationBackupFamily = (dbPath: string, retention: number): MigrationArtifactFamily => ({
  directory: migrationBackupDirectory(dbPath),
  prefix: `${path.basename(dbPath)}.pre-migration-`,
  suffix: ".sqlite",
  retention,
  ensurePrivate: true,
});

/** nothing writes these any more and no recovery path restores them — same size as the database; a single newest copy kept as forensic last resort */
export const TRACKER_REPAIR_SNAPSHOT_RETENTION = 1;

const trackerRepairSnapshotFamily = (dbPath: string): MigrationArtifactFamily => ({
  directory: migrationBackupDirectory(dbPath),
  prefix: `${path.basename(dbPath)}.pre-tracker-repair-`,
  suffix: ".sqlite",
  retention: TRACKER_REPAIR_SNAPSHOT_RETENTION,
  ensurePrivate: true,
});

/** can hold writes made after the last snapshot — more than one kept, which is why the bound matters */
const failedMigrationBundleFamily = (dbPath: string): MigrationArtifactFamily => ({
  directory: path.dirname(dbPath),
  prefix: `${path.basename(dbPath)}.failed-migration-`,
  retention: FAILED_MIGRATION_BUNDLE_RETENTION,
  bundled: true,
});

const pruneFailedMigrationBundles = (dbPath: string): Promise<void> =>
  pruneMigrationArtifactFamily(failedMigrationBundleFamily(dbPath));

/** runs ahead of the recovery-marker guard, so restorable pre-migration snapshots are deliberately excluded; prunes only families no code path restores from — the ones that could grow without bound */
const pruneUnreferencedMigrationArtifacts = (dbPath: string): Promise<void> =>
  Promise.all([
    pruneMigrationArtifactFamily(trackerRepairSnapshotFamily(dbPath)),
    pruneFailedMigrationBundles(dbPath),
  ]).then(() => undefined);

/** per-family retention is the point — a shared bound would let one family's churn evict another's */
export const pruneMigrationBackups = (dbPath: string, retention = MIGRATION_BACKUP_RETENTION) =>
  attemptPromise(async () => {
    // partials are unreferenced by construction — the only writer holds the lifecycle lock; reclaim unconditionally (an age cutoff is what let them accumulate)
    await removeRegularFiles(
      migrationBackupDirectory(dbPath),
      isMigrationBackupPartial(path.basename(dbPath)),
    );
    await Promise.all([
      pruneMigrationArtifactFamily(preMigrationBackupFamily(dbPath, retention)),
      pruneUnreferencedMigrationArtifacts(dbPath),
    ]);
  });

export const createMigrationBackup = (dbPath: string, plan: MigrationBackupPlan) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const backupDirectory = migrationBackupDirectory(dbPath);
    yield* attemptPromise(() => ensurePrivateBackupDirectory(backupDirectory));
    const basename = path.basename(dbPath);
    // unconditional, not age-gated — every partial outlived its writer; the old 24h cutoff let a restart loop accumulate without bound
    yield* attemptPromise(() =>
      removeRegularFiles(backupDirectory, isMigrationBackupPartial(basename)),
    );
    const requiredBytes = yield* estimateMigrationBackupRequiredBytes(dbPath);
    yield* attemptPromise(() => assertBackupSpaceAvailable(requiredBytes, backupDirectory));
    const createdAt = new Date().toISOString();
    const uniqueSuffix = `${compactTimestamp(new Date(createdAt))}-${randomUUID()}`;
    const finalName = `${basename}.pre-migration-${safeVersionLabel(plan.sourceVersion)}-to-v${plan.targetVersion}-${uniqueSuffix}.sqlite`;
    const backupPath = path.join(backupDirectory, finalName);
    const temporaryPath = path.join(backupDirectory, `.${finalName}.partial`);

    yield* Effect.gen(function* () {
      yield* sql`VACUUM INTO ${temporaryPath}`;
      yield* attemptPromise(async () => {
        await ensurePrivateRegularFile(temporaryPath);
        await syncRegularFile(temporaryPath);
        await fs.rename(temporaryPath, backupPath);
        await syncDirectoryEntry(backupDirectory);
      });
    }).pipe(
      // must span the whole critical section — a failure while syncing/renaming otherwise strands a full-size copy nothing reclaims
      Effect.tapError(() => attemptPromise(() => fs.unlink(temporaryPath)).pipe(Effect.ignore)),
    );
    yield* pruneMigrationBackups(dbPath);
    return { ...plan, backupPath, createdAt } satisfies MigrationBackupResult;
  });

/** durably replaces private JSON in one atomic rename */
async function writePrivateJsonFile(filePath: string, payload: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.partial`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await ensurePrivateRegularFile(temporaryPath);
    await syncRegularFile(temporaryPath);
    await fs.rename(temporaryPath, filePath);
    await syncDirectoryEntry(path.dirname(filePath));
  } catch (cause) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw cause;
  }
}

function migrationRecoveryPayload(dbPath: string, backup: MigrationBackupResult) {
  return {
    version: 1,
    databasePath: dbPath,
    backupPath: backup.backupPath,
    sourceVersion: backup.sourceVersion,
    targetVersion: backup.targetVersion,
    lineageDivergence: backup.lineageDivergence ?? null,
    phase: "migration-in-progress",
    createdAt: backup.createdAt,
    resumeAttempts: 0,
    restore: {
      executable: "synara-restore-migration-backup",
      arguments: [dbPath],
    },
    recovery:
      "Stop every Synara process, then run the explicit migration-backup restore command for this database.",
  } as const;
}

const writeRecoveryMarker = (dbPath: string, payload: Record<string, unknown>) =>
  attemptPromise(() => writePrivateJsonFile(migrationRecoveryMarkerPath(dbPath), payload));

const writeCompletedMigrationProvenance = (dbPath: string, payload: Record<string, unknown>) =>
  attemptPromise(() =>
    writePrivateJsonFile(migrationBackupProvenancePath(dbPath), {
      ...payload,
      version: 1,
      databasePath: dbPath,
      phase: "migration-completed",
      completedAt: new Date().toISOString(),
    }),
  );

const removeRecoveryMarker = (dbPath: string) =>
  attemptPromise(async () => {
    await fs.unlink(migrationRecoveryMarkerPath(dbPath));
    await syncDirectoryEntry(path.dirname(dbPath));
  });

const removeRecoveryMarkerIfPresent = async (dbPath: string): Promise<void> => {
  try {
    await fs.unlink(migrationRecoveryMarkerPath(dbPath));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  await syncDirectoryEntry(path.dirname(dbPath));
};

export interface RunWithPreMigrationBackupOptions {
  readonly divergenceConsent?: string | undefined;
}

export const runWithPreMigrationBackup = <A, E, R>(
  dbPath: string,
  migration: Effect.Effect<A, E, R>,
  options: RunWithPreMigrationBackupOptions = {},
) =>
  Effect.gen(function* () {
    const plan = yield* inspectMigrationBackupPlan;
    if (plan) {
      const challenge = createMigrationDivergenceConsentChallenge(dbPath, plan);
      if (challenge && options.divergenceConsent !== challenge.consentToken) {
        return yield* Effect.fail(new MigrationDivergenceConsentRequiredError(challenge));
      }
    }
    const backup = plan ? yield* createMigrationBackup(dbPath, plan) : null;
    const recoveryPayload = backup ? migrationRecoveryPayload(dbPath, backup) : null;
    if (recoveryPayload) {
      // the write-ahead marker must be durable before migrations mutate the live database — a later startup fails closed until an operator restores
      yield* writeRecoveryMarker(dbPath, recoveryPayload);
    }
    const result = yield* migration;
    if (recoveryPayload) {
      yield* writeCompletedMigrationProvenance(dbPath, recoveryPayload);
      yield* removeRecoveryMarker(dbPath);
    }
    return result;
  });

/** caller must stop every process using the database first; stale WAL/SHM moved aside so they can't replay into the restored snapshot */
const restoreSqliteMigrationBackup = (input: {
  readonly dbPath: string;
  readonly backupPath: string;
  readonly latestSupportedMigrationId: number;
  readonly beforeLiveDatabaseSwap?: (() => Promise<void>) | undefined;
  readonly afterLiveDatabaseRollback?: (() => Promise<void>) | undefined;
}) =>
  attemptPromise(async () => {
    const sourceInspection = await inspectSqliteMigrationBackup(input.backupPath);
    assertMigrationBackupCompatible(sourceInspection, input.latestSupportedMigrationId);
    const dbDirectory = path.dirname(input.dbPath);
    const dbBasename = path.basename(input.dbPath);
    await removeStaleRegularFiles(
      dbDirectory,
      (name) => name.startsWith(`${dbBasename}.`) && name.endsWith(".restore"),
    );
    const restoredTemporaryPath = `${input.dbPath}.${randomUUID()}.restore`;
    try {
      await fs.copyFile(input.backupPath, restoredTemporaryPath, fsConstants.COPYFILE_EXCL);
      await ensurePrivateRegularFile(restoredTemporaryPath);
      await syncRegularFile(restoredTemporaryPath);
      const copiedInspection = await inspectSqliteMigrationBackup(restoredTemporaryPath);
      assertMigrationBackupCompatible(copiedInspection, input.latestSupportedMigrationId);
      if (copiedInspection.migrationId !== sourceInspection.migrationId) {
        throw new Error(`Migration backup changed while it was copied: ${input.backupPath}`);
      }
    } catch (cause) {
      await fs.unlink(restoredTemporaryPath).catch(() => undefined);
      throw cause;
    }

    const failedSuffix = `.failed-migration-${compactTimestamp(new Date())}-${randomUUID()}`;
    const moved: Array<readonly [string, string]> = [];
    let swapPrepared = false;
    try {
      swapPrepared = true;
      await input.beforeLiveDatabaseSwap?.();
      for (const suffix of ["", "-wal", "-shm"]) {
        const source = `${input.dbPath}${suffix}`;
        const destination = `${input.dbPath}${failedSuffix}${suffix}`;
        try {
          await fs.rename(source, destination);
          moved.push([source, destination]);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
      }
      await fs.rename(restoredTemporaryPath, input.dbPath);
    } catch (cause) {
      // rollback valid only before the restored main database is installed
      await fs.unlink(restoredTemporaryPath).catch(() => undefined);
      let rollbackSucceeded = true;
      for (const [source, destination] of moved.reverse()) {
        await fs.rename(destination, source).catch(() => {
          rollbackSucceeded = false;
        });
      }
      if (swapPrepared && rollbackSucceeded) {
        await input.afterLiveDatabaseRollback?.();
      }
      throw cause;
    }

    // make the swap durable before the caller records the restore — until both happen a crash remains an explicit retryable state
    await syncDirectoryEntry(path.dirname(input.dbPath));
    await pruneFailedMigrationBundles(input.dbPath);
    await syncDirectoryEntry(path.dirname(input.dbPath));
  });

interface SqliteMigrationBackupInspection {
  readonly migrationId: number;
  readonly lineage: "canonical" | "imported" | "incompatible";
}

async function inspectSqliteMigrationBackup(
  backupPath: string,
): Promise<SqliteMigrationBackupInspection> {
  const backupStat = await fs.lstat(backupPath);
  if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
    throw new Error(`Migration backup is not a regular file: ${backupPath}`);
  }

  let integrity: unknown;
  let migration: SqliteMigrationBackupInspection;
  if (process.versions.bun !== undefined) {
    const { Database } = await import("bun:sqlite");
    const database = new Database(backupPath, { readonly: true });
    try {
      integrity = database.query("PRAGMA integrity_check").get();
      migration = readBunMigrationInspection(database);
    } finally {
      database.close();
    }
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(backupPath, { readOnly: true });
    try {
      integrity = database.prepare("PRAGMA integrity_check").get();
      migration = readNodeMigrationInspection(database);
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
  return migration;
}

function readBunMigrationInspection(
  database: import("bun:sqlite").Database,
): SqliteMigrationBackupInspection {
  const tracker = database
    .query(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
    )
    .get();
  if (!tracker) return inspectMigrationRows([]);
  return inspectMigrationRows(
    database
      .query(
        "SELECT migration_id AS migrationId, name FROM effect_sql_migrations ORDER BY migration_id ASC",
      )
      .all(),
  );
}

function readNodeMigrationInspection(
  database: import("node:sqlite").DatabaseSync,
): SqliteMigrationBackupInspection {
  const tracker = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
    )
    .get();
  if (!tracker) return inspectMigrationRows([]);
  return inspectMigrationRows(
    database
      .prepare(
        "SELECT migration_id AS migrationId, name FROM effect_sql_migrations ORDER BY migration_id ASC",
      )
      .all(),
  );
}

function inspectMigrationRows(rows: ReadonlyArray<unknown>): SqliteMigrationBackupInspection {
  const recordedNames = new Map<number, string>();
  for (const row of rows) {
    const migration = row as { readonly migrationId?: unknown; readonly name?: unknown };
    if (
      typeof migration.migrationId !== "number" ||
      !Number.isSafeInteger(migration.migrationId) ||
      migration.migrationId < 0 ||
      typeof migration.name !== "string"
    ) {
      throw new Error("Migration backup has an unreadable migration tracker.");
    }
    recordedNames.set(migration.migrationId, migration.name);
  }

  for (const repair of planMigrationLineageAliasRepairs(recordedNames)) {
    if (repair.kind === "rename") {
      recordedNames.set(repair.migrationId, repair.name);
    } else {
      recordedNames.delete(repair.migrationId);
    }
  }
  const migrationId = Math.max(...recordedNames.keys(), 0);
  const divergence = findFirstMigrationLineageDivergence(recordedNames, migrationId);
  return {
    migrationId,
    lineage:
      divergence === undefined
        ? "canonical"
        : divergence[0] > LAST_SHARED_LINEAGE_MIGRATION_ID
          ? "imported"
          : "incompatible",
  };
}

function assertMigrationBackupCompatible(
  inspection: SqliteMigrationBackupInspection,
  latestSupportedMigrationId: number,
): void {
  if (inspection.lineage === "incompatible") {
    throw new Error("Migration backup has an unrecognized migration lineage.");
  }
  if (inspection.lineage === "canonical" && inspection.migrationId > latestSupportedMigrationId) {
    throw new Error(
      `Migration backup schema ${inspection.migrationId} is newer than this build ` +
        `(latest supported migration: ${latestSupportedMigrationId}).`,
    );
  }
}

export type MigrationRecoveryMarker = {
  readonly markerPath: string;
  readonly backupPath: string;
  /** how many times startup has re-run the interrupted migration */
  readonly resumeAttempts: number;
  /** the marker verbatim — a resume bumps one field without losing the rest */
  readonly payload: Record<string, unknown>;
};

function generatedBackupNamePattern(dbPath: string): RegExp {
  const escapedBasename = path.basename(dbPath).replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

async function readMigrationBackupRecord(
  dbPath: string,
  recordPath: string,
  recordLabel: string,
): Promise<MigrationRecoveryMarker | null> {
  let recordText: string;
  try {
    recordText = await readRegularFileNoFollow(recordPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }

  const record = JSON.parse(recordText) as {
    readonly databasePath?: unknown;
    readonly backupPath?: unknown;
  };
  if (record.databasePath !== dbPath || typeof record.backupPath !== "string") {
    throw new Error(`Invalid ${recordLabel}: ${recordPath}`);
  }
  const resumeState = parseMigrationRecoveryResumeState(recordText);
  if (resumeState === null) {
    throw new Error(`${recordLabel} has an unreadable resume counter: ${recordPath}`);
  }
  const backupDirectory = path.resolve(migrationBackupDirectory(dbPath));
  const backupDirectoryStat = await fs.lstat(backupDirectory);
  if (!backupDirectoryStat.isDirectory() || backupDirectoryStat.isSymbolicLink()) {
    throw new Error(`Invalid migration backup directory: ${backupDirectory}`);
  }
  const backupPath = path.resolve(record.backupPath);
  const backupName = path.basename(backupPath);
  if (
    record.backupPath !== backupPath ||
    path.dirname(backupPath) !== backupDirectory ||
    !generatedBackupNamePattern(dbPath).test(backupName)
  ) {
    throw new Error(`${recordLabel} references an invalid backup: ${backupPath}`);
  }
  const backupStat = await fs.lstat(backupPath);
  if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
    throw new Error(`${recordLabel} references a non-regular backup: ${backupPath}`);
  }
  const canonicalBackupDirectory = await fs.realpath(backupDirectory);
  const canonicalBackupPath = await fs.realpath(backupPath);
  if (path.dirname(canonicalBackupPath) !== canonicalBackupDirectory) {
    throw new Error(`${recordLabel} backup escapes its canonical directory: ${backupPath}`);
  }
  return {
    markerPath: recordPath,
    backupPath,
    resumeAttempts: resumeState.attempts,
    payload: record as Record<string, unknown>,
  };
}

const readMigrationRecoveryMarker = (dbPath: string) =>
  readMigrationBackupRecord(
    dbPath,
    migrationRecoveryMarkerPath(dbPath),
    "migration recovery marker",
  );

const readCompletedMigrationProvenance = (dbPath: string) =>
  readMigrationBackupRecord(
    dbPath,
    migrationBackupProvenancePath(dbPath),
    "migration backup provenance",
  );

export async function inspectCompletedMigrationBackupForSchemaTooNew(
  dbPath: string,
  input: {
    readonly databaseMigrationId: number;
    readonly latestSupportedMigrationId: number;
  },
): Promise<MigrationSchemaTooNewRecovery> {
  let record: MigrationRecoveryMarker | null;
  try {
    record = await readCompletedMigrationProvenance(dbPath);
  } catch {
    return { kind: "restore-unavailable", reason: "invalid-provenance" };
  }
  if (!record) {
    return { kind: "restore-unavailable", reason: "missing-provenance" };
  }
  if (
    record.payload.phase !== "migration-completed" ||
    record.payload.targetVersion !== input.databaseMigrationId
  ) {
    return { kind: "restore-unavailable", reason: "invalid-provenance" };
  }

  let inspection: SqliteMigrationBackupInspection;
  try {
    inspection = await inspectSqliteMigrationBackup(record.backupPath);
  } catch {
    return { kind: "restore-unavailable", reason: "invalid-backup" };
  }
  if (
    inspection.lineage === "incompatible" ||
    (inspection.lineage === "canonical" &&
      inspection.migrationId > input.latestSupportedMigrationId)
  ) {
    return { kind: "restore-unavailable", reason: "incompatible-backup" };
  }
  return {
    kind: "restore-available",
    backupPath: record.backupPath,
    provenancePath: record.markerPath,
    backupMigrationId: inspection.migrationId,
  };
}

/** a database needing recovery never reaches the backup path — this runs ahead of the guard or a wedged install keeps every partial its restart loop produced; safe unconditionally only because every caller holds the lifecycle lock; never removes a finished backup, a live marker, or the database/WAL/SHM */
export const reclaimOrphanedMigrationArtifacts = (dbPath: string) =>
  attemptPromise(async () => {
    const markerPath = migrationRecoveryMarkerPath(dbPath);
    const provenancePath = migrationBackupProvenancePath(dbPath);
    await Promise.all([
      removeRegularFiles(
        migrationBackupDirectory(dbPath),
        isMigrationBackupPartial(path.basename(dbPath)),
      ),
      removeRegularFiles(
        path.dirname(markerPath),
        isAtomicMigrationJsonPartial(path.basename(markerPath)),
      ),
      removeRegularFiles(
        path.dirname(provenancePath),
        isAtomicMigrationJsonPartial(path.basename(provenancePath)),
      ),
      pruneUnreferencedMigrationArtifacts(dbPath),
    ]);
  }).pipe(Effect.ignore);

/** read-only startup guard — never restores, renames, or removes recovery files */
export const requireNoPendingMigrationRecovery = (dbPath: string) =>
  attemptPromise(async () => {
    const marker = await readValidatedRecoveryMarker(dbPath);
    if (marker) {
      throw new MigrationRecoveryRequiredError(dbPath, marker.markerPath, marker.backupPath);
    }
  });

async function readValidatedRecoveryMarker(
  dbPath: string,
): Promise<MigrationRecoveryMarker | null> {
  try {
    return await readMigrationRecoveryMarker(dbPath);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new MigrationRecoveryRequiredError(
      dbPath,
      migrationRecoveryMarkerPath(dbPath),
      "unknown",
      `The recovery marker could not be validated: ${detail}.`,
    );
  }
}

/** returns the pending marker while a re-run is still allowed, null when nothing pending, fails closed once the budget is spent or the marker can't be validated */
export const inspectPendingMigrationRecovery = (dbPath: string) =>
  attemptPromise(async () => {
    const marker = await readValidatedRecoveryMarker(dbPath);
    if (marker && marker.resumeAttempts >= MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS) {
      throw new MigrationRecoveryRequiredError(
        dbPath,
        marker.markerPath,
        marker.backupPath,
        `Startup already re-ran the interrupted migration ${marker.resumeAttempts} time(s) without success.`,
      );
    }
    return marker;
  });

/** deliberately takes no fresh backup and doesn't rewrite the marker's pointer — the fallback must stay the snapshot taken before the first attempt; the attempt is charged to the durable budget before running so a mid-migration death still terminates the loop; only success clears the marker */
export const resumeMarkedMigration = <A, E, R>(
  dbPath: string,
  marker: MigrationRecoveryMarker,
  migration: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* Effect.logWarning("Resuming an interrupted database migration", {
      databasePath: dbPath,
      backupPath: marker.backupPath,
      previousAttempts: marker.resumeAttempts,
      remainingAttempts: MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS - marker.resumeAttempts,
    });
    const resumedPayload = {
      ...marker.payload,
      resumeAttempts: marker.resumeAttempts + 1,
      lastResumeAt: new Date().toISOString(),
    };
    yield* attemptPromise(() => writePrivateJsonFile(marker.markerPath, resumedPayload));
    const result = yield* migration;
    yield* writeCompletedMigrationProvenance(dbPath, resumedPayload);
    yield* removeRecoveryMarker(dbPath);
    yield* Effect.logInfo("Interrupted database migration completed on resume", {
      databasePath: dbPath,
    });
    return result;
  });

/** operator must stop every Synara process first; startup deliberately never calls this */
export interface RestoreMarkedMigrationBackupOptions {
  readonly expectedBackupPath?: string | undefined;
  readonly expectedProvenancePath?: string | undefined;
}

export const restoreMarkedMigrationBackup = (
  dbPath: string,
  options: RestoreMarkedMigrationBackupOptions = {},
) =>
  withDatabaseLifecycleLock(
    dbPath,
    attemptPromise(async () => {
      const hasExpectedCompletedBackup =
        options.expectedBackupPath !== undefined || options.expectedProvenancePath !== undefined;
      if (
        hasExpectedCompletedBackup &&
        (options.expectedBackupPath === undefined || options.expectedProvenancePath === undefined)
      ) {
        throw new Error("Both expected migration backup and provenance paths are required.");
      }
      let activeMarker: MigrationRecoveryMarker | null;
      if (hasExpectedCompletedBackup) {
        try {
          activeMarker = await readMigrationRecoveryMarker(dbPath);
        } catch {
          activeMarker = null;
        }
      } else {
        activeMarker = await readMigrationRecoveryMarker(dbPath);
      }
      const completedProvenance =
        hasExpectedCompletedBackup || !activeMarker
          ? await readCompletedMigrationProvenance(dbPath)
          : null;
      const matchingRestoreMarker =
        hasExpectedCompletedBackup &&
        activeMarker !== null &&
        activeMarker.backupPath === options.expectedBackupPath &&
        activeMarker.payload.phase === "migration-restore-in-progress"
          ? activeMarker
          : null;
      const record = hasExpectedCompletedBackup
        ? (matchingRestoreMarker ?? completedProvenance)
        : (activeMarker ?? completedProvenance);
      if (!record) {
        throw new Error(
          `No migration recovery marker or completed backup provenance exists for ${dbPath}.`,
        );
      }
      if (hasExpectedCompletedBackup) {
        if (
          completedProvenance === null ||
          completedProvenance.backupPath !== options.expectedBackupPath ||
          completedProvenance.markerPath !== options.expectedProvenancePath
        ) {
          throw new Error("Completed migration provenance no longer matches the selected backup.");
        }
      }

      const restoringCompletedProvenance = record === completedProvenance;
      if (restoringCompletedProvenance) {
        if (record.payload.phase !== "migration-completed") {
          throw new Error(`Migration backup provenance is not restorable: ${record.markerPath}`);
        }
        const liveInspection = await inspectSqliteMigrationBackup(dbPath);
        if (record.payload.targetVersion !== liveInspection.migrationId) {
          throw new Error(
            `Migration backup provenance does not describe the current database: ${record.markerPath}`,
          );
        }
      }
      const restoreMarkerPath = migrationRecoveryMarkerPath(dbPath);
      const restoreMarkerPayload = {
        ...record.payload,
        version: 1,
        databasePath: dbPath,
        backupPath: record.backupPath,
        phase: "migration-restore-in-progress",
        restoreStartedAt: new Date().toISOString(),
        resumeAttempts: MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS,
      };
      await Effect.runPromise(
        restoreSqliteMigrationBackup({
          dbPath,
          backupPath: record.backupPath,
          latestSupportedMigrationId: latestMigrationId,
          // defer the fail-closed marker until the backup is copied and verified — a full rollback restores the prior marker state
          beforeLiveDatabaseSwap: () =>
            writePrivateJsonFile(restoreMarkerPath, restoreMarkerPayload),
          afterLiveDatabaseRollback: restoringCompletedProvenance
            ? () => removeRecoveryMarkerIfPresent(dbPath)
            : () => writePrivateJsonFile(record.markerPath, record.payload),
        }),
      );
      await writePrivateJsonFile(migrationBackupProvenancePath(dbPath), {
        ...record.payload,
        version: 1,
        databasePath: dbPath,
        phase: "migration-restored",
        restoredAt: new Date().toISOString(),
      });
      await fs.unlink(migrationRecoveryMarkerPath(dbPath)).catch((cause) => {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      });
      await syncDirectoryEntry(path.dirname(dbPath));
    }),
  );
