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
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  cpSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  BETA_IMPORT_REQUEST_FILE_NAME,
  BETA_IMPORT_RESULT_FILE_NAME,
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

const SNAPSHOT_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

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
 * second connection can `VACUUM INTO` it while it runs. Copying the sidecars
 * first and the main file last yields a crash-consistent pair: a checkpoint or
 * commit landing between the copies can only add committed state, and a torn
 * WAL tail is discarded by SQLite's frame checksums on recovery.
 */
function copyLiveDatabase(sourceDbPath: string, stagingDir: string): string {
  mkdirSync(stagingDir, { recursive: true });
  for (const suffix of SNAPSHOT_SIDECAR_SUFFIXES) {
    const sidecarPath = `${sourceDbPath}${suffix}`;
    if (!existsSync(sidecarPath)) continue;
    try {
      if (statSync(sidecarPath).isFile()) {
        cpSync(sidecarPath, join(stagingDir, `state.sqlite${suffix}`), { force: true });
      }
    } catch {
      // A sidecar vanishing mid-import means the source checkpointed; the copy
      // of the main file below already carries that state.
    }
  }
  const stagedDbPath = join(stagingDir, "state.sqlite");
  cpSync(sourceDbPath, stagedDbPath, { force: true });
  return stagedDbPath;
}

async function snapshotStableDatabase(sourceDbPath: string, targetDbPath: string): Promise<void> {
  const stagingPath = `${targetDbPath}.import-${process.pid}`;
  const stagingDir = `${stagingPath}.src`;
  rmSync(stagingPath, { force: true });
  rmSync(stagingDir, { recursive: true, force: true });
  try {
    try {
      await vacuumInto(sourceDbPath, stagingPath);
    } catch {
      const stagedDbPath = copyLiveDatabase(sourceDbPath, stagingDir);
      // Opening the staged copy replays its WAL, so the vacuumed output is a
      // fully checkpointed database — and a corrupt copy surfaces here as an
      // error instead of landing in the beta home.
      await vacuumInto(stagedDbPath, stagingPath);
    }
    renameSync(stagingPath, targetDbPath);
  } finally {
    rmSync(stagingPath, { force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

export async function runBetaImportIfRequested(input: {
  readonly betaHomeDir: string;
  readonly stateDir: string;
}): Promise<{ readonly consumed: boolean; readonly ok: boolean; readonly error?: string }> {
  const markerPath = join(input.betaHomeDir, BETA_IMPORT_REQUEST_FILE_NAME);
  if (!existsSync(markerPath)) {
    return { consumed: false, ok: true };
  }

  const finish = (ok: boolean, error?: string) => {
    try {
      writeImportResult(input.betaHomeDir, { ok, ...(error ? { error } : {}) });
    } finally {
      rmSync(markerPath, { force: true });
    }
    return { consumed: true, ok, ...(error ? { error } : {}) };
  };

  const request = readImportRequest(markerPath);
  if (!request) {
    return finish(false, "import marker was malformed");
  }

  const sourceHomeDir = resolve(request.sourceHomeDir);
  if (sourceHomeDir === resolve(input.betaHomeDir)) {
    return finish(false, "import source points at the beta home itself");
  }

  const sourceStateDir = join(sourceHomeDir, "userdata");
  const sourceDbPath = join(sourceStateDir, "state.sqlite");
  if (!existsSync(sourceDbPath)) {
    return finish(false, `stable database not found at ${sourceDbPath}`);
  }

  try {
    copyStateEntries(sourceStateDir, input.stateDir);
    await snapshotStableDatabase(sourceDbPath, join(input.stateDir, "state.sqlite"));
    return finish(true);
  } catch (error) {
    return finish(false, error instanceof Error ? error.message : String(error));
  }
}
