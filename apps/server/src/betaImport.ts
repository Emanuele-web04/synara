// FILE: betaImport.ts
// Purpose: Beta-side consumer of the stable app's "Copy my data to Beta" handoff.
// Layer: Startup hook — runs before the beta server creates/opens its own database.
//
// Stable writes `<betaHome>/import-requested.json` when the user picks
// "Copy my data to Beta". The beta server finds the marker here (baseDir is the
// beta home), snapshots the stable home with a consistent `VACUUM INTO` copy of
// `userdata/state.sqlite` plus the small non-database files, then deletes the
// marker and reports through `<betaHome>/import-result.json` for the stable UI.
//
// The marker file is untrusted input: the source path is resolved and must not
// point back at this install's own home before anything is read or written.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  cpSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  BETA_IMPORT_REQUEST_FILE_NAME,
  BETA_IMPORT_RESULT_FILE_NAME,
  SYNARA_STABLE_HOME_ENV,
  type BetaImportRequest,
} from "@synara/shared/betaChannel";

/** Entries that describe this install's live runtime, not user data. */
const EXCLUDED_STATE_ENTRIES = new Set([
  "logs",
  "diagnostics",
  "server-runtime.json",
  "quit-resume.json",
  BETA_IMPORT_REQUEST_FILE_NAME,
  BETA_IMPORT_RESULT_FILE_NAME,
]);

/**
 * `state.sqlite` plus every adjacent sidecar that belongs to the live
 * database — WAL/SHM/journal files, the `.lifecycle-lock/` directory, and the
 * importer's own `.import-*` staging files all share this stem.
 */
const STATE_DB_ENTRY_PATTERN = /^state\.sqlite(?:[.-].*)?$/;

/**
 * A marker left behind by an aborted handoff must never import over a beta
 * home that has since accumulated its own data. Requests older than this are
 * discarded instead of consumed.
 */
const IMPORT_REQUEST_MAX_AGE_MS = 60 * 60 * 1000;

const sqlStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function readImportRequest(markerPath: string): BetaImportRequest | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== 1 ||
      typeof parsed.requestedAt !== "string" ||
      typeof parsed.sourceHomeDir !== "string" ||
      parsed.sourceHomeDir.trim() === ""
    ) {
      return null;
    }
    return parsed as BetaImportRequest;
  } catch {
    return null;
  }
}

function writeImportResult(betaHomeDir: string, result: { ok: boolean; error?: string }): void {
  const resultPath = join(betaHomeDir, BETA_IMPORT_RESULT_FILE_NAME);
  const tempPath = `${resultPath}.tmp-${process.pid}`;
  writeFileSync(
    tempPath,
    `${JSON.stringify({ version: 1, completedAt: new Date().toISOString(), ...result })}\n`,
    "utf8",
  );
  renameSync(tempPath, resultPath);
}

function copyStateEntries(sourceStateDir: string, targetStateDir: string): void {
  mkdirSync(targetStateDir, { recursive: true });
  for (const entry of readdirSync(sourceStateDir)) {
    if (EXCLUDED_STATE_ENTRIES.has(entry)) continue;
    if (STATE_DB_ENTRY_PATTERN.test(entry)) continue;
    if (entry.endsWith(".lifecycle-lock")) continue;
    const sourcePath = join(sourceStateDir, entry);
    const targetPath = join(targetStateDir, entry);
    try {
      const stats = statSync(sourcePath);
      if (stats.isDirectory()) {
        cpSync(sourcePath, targetPath, { recursive: true, force: true });
      } else if (stats.isFile()) {
        cpSync(sourcePath, targetPath, { force: true });
      }
    } catch {
      // A single unreadable entry must not fail the whole import.
    }
  }
}

/** Sidecars that carry committed state. `-shm` is only a rebuildable index. */
const SNAPSHOT_SIDECAR_SUFFIXES = ["-wal", "-journal"] as const;
const LIVE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const LIVE_COPY_ATTEMPTS = 5;

/**
 * Identifies the moments a live copy can tear: a checkpoint rewrites the main
 * file (size/mtime change) and a WAL restart rewrites the WAL header salts.
 */
function liveDatabaseSignature(sourceDbPath: string): string {
  const main = statSync(sourceDbPath);
  let walHeader = "none";
  try {
    const fd = openSync(`${sourceDbPath}-wal`, "r");
    try {
      const header = Buffer.alloc(32);
      walHeader = header.subarray(0, readSync(fd, header, 0, 32, 0)).toString("hex");
    } finally {
      closeSync(fd);
    }
  } catch {
    // No WAL: nothing to tear against.
  }
  return `${main.size}:${main.mtimeMs}:${walHeader}`;
}

/** Highest applied migration in a database file, or null without a tracker. */
async function readMigrationHighWaterMark(dbPath: string): Promise<number | null> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
      )
      .get();
    if (!table) return null;
    const row = database
      .prepare("SELECT max(migration_id) AS id FROM effect_sql_migrations")
      .get() as { id: number | null } | undefined;
    return typeof row?.id === "number" ? row.id : null;
  } finally {
    database.close();
  }
}

async function vacuumInto(sourceDbPath: string, targetPath: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(sourceDbPath);
  try {
    database.exec(`VACUUM INTO ${sqlStringLiteral(targetPath)}`);
  } finally {
    database.close();
  }
}

/**
 * File-level snapshot of a database another process holds open. The stable
 * server keeps `state.sqlite` under `PRAGMA locking_mode = EXCLUSIVE`, so no
 * second connection can `VACUUM INTO` it while it runs. The main file and WAL
 * are only a consistent pair if no checkpoint or WAL restart lands between
 * the two copies, so the copy is retried until the database signature is the
 * same before and after, and fails rather than import a torn pair. Appends to
 * the WAL during the copy are fine: a torn tail frame fails its checksum and
 * is discarded on recovery.
 */
export function copyLiveDatabase(
  sourceDbPath: string,
  stagingDir: string,
  signature: (dbPath: string) => string = liveDatabaseSignature,
): string {
  const stagedDbPath = join(stagingDir, "state.sqlite");
  for (let attempt = 0; attempt < LIVE_COPY_ATTEMPTS; attempt += 1) {
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });
    const before = signature(sourceDbPath);
    cpSync(sourceDbPath, stagedDbPath, { force: true });
    for (const suffix of SNAPSHOT_SIDECAR_SUFFIXES) {
      const sidecarPath = `${sourceDbPath}${suffix}`;
      if (existsSync(sidecarPath) && statSync(sidecarPath).isFile()) {
        cpSync(sidecarPath, join(stagingDir, `state.sqlite${suffix}`), { force: true });
      }
    }
    if (signature(sourceDbPath) === before) return stagedDbPath;
  }
  throw new Error("Synara kept rewriting its database during the copy. Try again in a moment.");
}

async function snapshotStableDatabase(
  sourceDbPath: string,
  targetDbPath: string,
  latestMigrationId: number,
): Promise<void> {
  const stagingPath = `${targetDbPath}.import-${process.pid}`;
  const stagingDir = `${stagingPath}.src`;
  rmSync(stagingPath, { force: true });
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(resolve(targetDbPath, ".."), { recursive: true });
  try {
    try {
      await vacuumInto(sourceDbPath, stagingPath);
    } catch {
      // VACUUM INTO refuses an existing target; drop any partial output.
      rmSync(stagingPath, { force: true });
      const stagedDbPath = copyLiveDatabase(sourceDbPath, stagingDir);
      // Opening the staged copy replays its WAL, so the vacuumed output is a
      // fully checkpointed database — and a corrupt copy surfaces here as an
      // error instead of landing in the beta home.
      await vacuumInto(stagedDbPath, stagingPath);
    }
    const sourceMigration = await readMigrationHighWaterMark(stagingPath);
    if (sourceMigration !== null && sourceMigration > latestMigrationId) {
      throw new Error(
        "Synara is newer than this Synara Beta. Update Synara Beta, then copy your data again.",
      );
    }
    // A leftover WAL from an earlier unclean beta exit is not tied to a
    // database file and would replay old pages over the imported one.
    for (const suffix of LIVE_SIDECAR_SUFFIXES) {
      rmSync(`${targetDbPath}${suffix}`, { force: true });
    }
    renameSync(stagingPath, targetDbPath);
  } finally {
    rmSync(stagingPath, { force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** Stable homes a beta may import from: the one stable handed over, else the default. */
export function allowedImportSourceHomes(env: NodeJS.ProcessEnv = process.env): string[] {
  const handedOver = env[SYNARA_STABLE_HOME_ENV]?.trim();
  return [handedOver ? resolve(handedOver) : resolve(homedir(), ".synara")];
}

export async function runBetaImportIfRequested(input: {
  readonly betaHomeDir: string;
  readonly stateDir: string;
  /** Newest migration this beta build knows; newer source databases are refused. */
  readonly latestMigrationId: number;
  readonly allowedSourceHomes?: readonly string[];
}): Promise<{ readonly consumed: boolean; readonly ok: boolean; readonly error?: string }> {
  const markerPath = join(input.betaHomeDir, BETA_IMPORT_REQUEST_FILE_NAME);
  if (!existsSync(markerPath)) {
    return { consumed: false, ok: true };
  }

  const finish = (ok: boolean, error?: string) => {
    try {
      writeImportResult(input.betaHomeDir, { ok, ...(error ? { error } : {}) });
    } catch {
      // Result reporting is best-effort.
    }
    try {
      // recursive: a stray directory named like the marker must not throw
      // here — any throw out of this path is a StartupError on every launch.
      rmSync(markerPath, { recursive: true, force: true });
    } catch {
      // The marker is gone or unremovable; startup continues either way.
    }
    return { consumed: true, ok, ...(error ? { error } : {}) };
  };

  const request = readImportRequest(markerPath);
  if (!request) {
    return finish(false, "import marker was malformed");
  }

  const requestedAtMs = Date.parse(request.requestedAt);
  if (Number.isFinite(requestedAtMs) && Date.now() - requestedAtMs > IMPORT_REQUEST_MAX_AGE_MS) {
    // A stale marker would overwrite beta data accumulated since it was
    // written; delete it without importing and without touching any older
    // import-result the stable UI may still show.
    try {
      rmSync(markerPath, { recursive: true, force: true });
    } catch {
      // best effort
    }
    return { consumed: true, ok: true };
  }

  const sourceHomeDir = resolve(request.sourceHomeDir);
  if (sourceHomeDir === resolve(input.betaHomeDir)) {
    return finish(false, "import source points at the beta home itself");
  }
  if (!(input.allowedSourceHomes ?? allowedImportSourceHomes()).includes(sourceHomeDir)) {
    return finish(false, "import source is not the Synara data folder");
  }

  const sourceStateDir = join(sourceHomeDir, "userdata");
  const sourceDbPath = join(sourceStateDir, "state.sqlite");
  if (!existsSync(sourceDbPath)) {
    return finish(false, `stable database not found at ${sourceDbPath}`);
  }

  try {
    // Snapshot the database first: if it fails, beta must keep its own db and
    // receive none of stable's files — copying entries first would leave
    // stable's settings/secrets on top of beta's existing database.
    await snapshotStableDatabase(
      sourceDbPath,
      join(input.stateDir, "state.sqlite"),
      input.latestMigrationId,
    );
    copyStateEntries(sourceStateDir, input.stateDir);
    return finish(true);
  } catch (error) {
    return finish(false, error instanceof Error ? error.message : String(error));
  }
}
