// FILE: betaImport.test.ts
// Purpose: Coverage for the beta-side stable-data snapshot import.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BETA_IMPORT_REQUEST_FILE_NAME,
  BETA_IMPORT_RESULT_FILE_NAME,
} from "@synara/shared/betaChannel";
import { copyLiveDatabase, runBetaImportIfRequested } from "./betaImport";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-beta-import-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

async function seedStableHome(root: string): Promise<string> {
  const stableHome = join(root, ".synara");
  const stableState = join(stableHome, "userdata");
  mkdirSync(join(stableState, "secrets"), { recursive: true });
  mkdirSync(join(stableState, "logs"), { recursive: true });
  writeFileSync(join(stableState, "settings.json"), JSON.stringify({ theme: "dark" }));
  writeFileSync(join(stableState, "secrets", "token.json"), JSON.stringify({ token: "x" }));
  writeFileSync(join(stableState, "logs", "server.log"), "log line\n");
  writeFileSync(join(stableState, "server-runtime.json"), JSON.stringify({ pid: 1234 }));

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(stableState, "state.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)");
  db.exec("INSERT INTO threads VALUES ('t1', 'hello stable')");
  db.close();
  return stableHome;
}

function writeMarker(betaHome: string, sourceHomeDir: string): void {
  mkdirSync(betaHome, { recursive: true });
  writeFileSync(
    join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME),
    JSON.stringify({ version: 1, requestedAt: new Date().toISOString(), sourceHomeDir }),
  );
}

/** Runs the import allowing whatever source the marker names, unless overridden. */
function run(
  input: { readonly betaHomeDir: string; readonly stateDir: string },
  overrides: Partial<Parameters<typeof runBetaImportIfRequested>[0]> = {},
) {
  let allowedSourceHomes: string[] = [];
  try {
    const marker = JSON.parse(
      readFileSync(join(input.betaHomeDir, BETA_IMPORT_REQUEST_FILE_NAME), "utf8"),
    );
    allowedSourceHomes = [resolve(marker.sourceHomeDir)];
  } catch {
    // no or malformed marker
  }
  return runBetaImportIfRequested({
    ...input,
    latestMigrationId: 1_000,
    allowedSourceHomes,
    ...overrides,
  });
}

describe("runBetaImportIfRequested", () => {
  it("does nothing without a marker", async () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    const outcome = await run({
      betaHomeDir: betaHome,
      stateDir: join(betaHome, "userdata"),
    });
    expect(outcome.consumed).toBe(false);
    expect(existsSync(join(betaHome, "userdata"))).toBe(false);
  });

  it("imports the stable snapshot and reports success", async () => {
    const root = await seedStableHome(makeRoot());
    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    writeMarker(betaHome, root);

    const outcome = await run({ betaHomeDir: betaHome, stateDir: betaState });
    expect(outcome).toEqual({ consumed: true, ok: true });
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(false);

    // Marker consumed, result written for the stable UI to read back.
    const result = JSON.parse(readFileSync(join(betaHome, BETA_IMPORT_RESULT_FILE_NAME), "utf8"));
    expect(result.ok).toBe(true);

    // Database snapshot is a real, queryable copy.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(betaState, "state.sqlite"), { readOnly: true });
    const rows = db.prepare("SELECT title FROM threads").all() as Array<{ title: string }>;
    db.close();
    expect(rows[0]?.title).toBe("hello stable");

    // Small state copied; runtime files excluded.
    expect(readFileSync(join(betaState, "settings.json"), "utf8")).toContain("dark");
    expect(existsSync(join(betaState, "secrets", "token.json"))).toBe(true);
    expect(existsSync(join(betaState, "logs"))).toBe(false);
    expect(existsSync(join(betaState, "server-runtime.json"))).toBe(false);
  });

  it("never carries database sidecars or lifecycle locks into the beta home", async () => {
    const root = await seedStableHome(makeRoot());
    const stableState = join(root, "userdata");
    const lockDir = join(stableState, "state.sqlite.lifecycle-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "lock.json"), JSON.stringify({ pid: 9999, token: "x" }));
    writeFileSync(join(stableState, "state.sqlite.import-999"), "stale staging file");
    writeFileSync(join(stableState, "other.sqlite.lifecycle-lock"), "foreign lock");

    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    writeMarker(betaHome, root);

    const outcome = await run({ betaHomeDir: betaHome, stateDir: betaState });
    expect(outcome).toEqual({ consumed: true, ok: true });
    expect(existsSync(join(betaState, "state.sqlite"))).toBe(true);
    // Only the checkpointed snapshot lands — no live-database sidecars.
    expect(readdirSync(betaState).filter((entry) => entry.startsWith("state.sqlite"))).toEqual([
      "state.sqlite",
    ]);
    expect(existsSync(join(betaState, "other.sqlite.lifecycle-lock"))).toBe(false);
  });

  it("imports while the stable database is held under an exclusive lock", async () => {
    const root = await seedStableHome(makeRoot());
    const stableState = join(root, "userdata");
    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    writeMarker(betaHome, root);

    // The live stable server holds state.sqlite under
    // `PRAGMA locking_mode = EXCLUSIVE` (see persistence/Layers/Sqlite.ts), so
    // VACUUM INTO against it always reports "database is locked" — the importer
    // must fall back to a file-level snapshot of db + WAL.
    const { DatabaseSync } = await import("node:sqlite");
    const liveDb = new DatabaseSync(join(stableState, "state.sqlite"));
    try {
      liveDb.exec("PRAGMA journal_mode = WAL");
      liveDb.exec("PRAGMA locking_mode = EXCLUSIVE");
      liveDb.exec("INSERT INTO threads VALUES ('t2', 'written while locked')");

      const outcome = await run({
        betaHomeDir: betaHome,
        stateDir: betaState,
      });
      expect(outcome).toEqual({ consumed: true, ok: true });
    } finally {
      liveDb.close();
    }

    const db = new DatabaseSync(join(betaState, "state.sqlite"), { readOnly: true });
    const titles = (
      db.prepare("SELECT title FROM threads ORDER BY id").all() as Array<{ title: string }>
    ).map((row) => row.title);
    db.close();
    expect(titles).toEqual(["hello stable", "written while locked"]);
  });

  it("refuses an import that points at the beta home itself", async () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    writeMarker(betaHome, betaHome);

    const outcome = await run({
      betaHomeDir: betaHome,
      stateDir: join(betaHome, "userdata"),
    });
    expect(outcome.consumed).toBe(true);
    expect(outcome.ok).toBe(false);
    const result = JSON.parse(readFileSync(join(betaHome, BETA_IMPORT_RESULT_FILE_NAME), "utf8"));
    expect(result.error).toContain("beta home");
  });

  it("reports a missing stable database without crashing startup", async () => {
    const root = makeRoot();
    const stableHome = join(root, ".synara");
    mkdirSync(join(stableHome, "userdata"), { recursive: true });
    const betaHome = join(root, ".synara-beta");
    writeMarker(betaHome, stableHome);

    const outcome = await run({
      betaHomeDir: betaHome,
      stateDir: join(betaHome, "userdata"),
    });
    expect(outcome.consumed).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("stable database not found");
  });

  it("copies no state entries when the database snapshot fails", async () => {
    const root = makeRoot();
    const stableHome = join(root, ".synara");
    const stableState = join(stableHome, "userdata");
    mkdirSync(stableState, { recursive: true });
    // A corrupt source db fails both VACUUM INTO paths, so the import must
    // fail before any non-db entries land on top of beta's own database.
    writeFileSync(join(stableState, "state.sqlite"), "not a sqlite database");
    writeFileSync(join(stableState, "settings.json"), JSON.stringify({ theme: "dark" }));
    writeFileSync(join(stableState, "secrets.json"), JSON.stringify({ token: "x" }));

    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    writeMarker(betaHome, stableHome);

    const outcome = await run({
      betaHomeDir: betaHome,
      stateDir: betaState,
    });
    expect(outcome.consumed).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(existsSync(join(betaState, "settings.json"))).toBe(false);
    expect(existsSync(join(betaState, "secrets.json"))).toBe(false);
    expect(existsSync(join(betaState, "state.sqlite"))).toBe(false);
  });

  it("removes a directory-shaped marker without failing startup", async () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    // A stray directory named like the marker must not throw out of finish()
    // — that throw is a StartupError on every launch.
    mkdirSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME), { recursive: true });

    const outcome = await run({
      betaHomeDir: betaHome,
      stateDir: join(betaHome, "userdata"),
    });
    expect(outcome.consumed).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(false);
  });

  it("discards a stale import request instead of importing over newer data", async () => {
    const stableHome = await seedStableHome(makeRoot());
    const betaHome = join(stableHome, "..", ".synara-beta");
    const betaState = join(betaHome, "userdata");
    mkdirSync(betaHome, { recursive: true });
    writeFileSync(
      join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME),
      JSON.stringify({
        version: 1,
        requestedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        sourceHomeDir: stableHome,
      }),
    );
    // An existing success result must survive a stale-marker cleanup.
    writeFileSync(
      join(betaHome, BETA_IMPORT_RESULT_FILE_NAME),
      JSON.stringify({ version: 1, completedAt: new Date().toISOString(), ok: true }),
    );

    const outcome = await run({
      betaHomeDir: betaHome,
      stateDir: betaState,
    });
    expect(outcome).toEqual({ consumed: true, ok: true });
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(false);
    expect(existsSync(join(betaState, "state.sqlite"))).toBe(false);
    expect(existsSync(join(betaState, "settings.json"))).toBe(false);
    const result = JSON.parse(readFileSync(join(betaHome, BETA_IMPORT_RESULT_FILE_NAME), "utf8"));
    expect(result.ok).toBe(true);
  });

  it("replaces a stale marker without retry loops", async () => {
    const root = await seedStableHome(makeRoot());
    const betaHome = join(root, ".synara-beta");
    writeMarker(betaHome, root);
    writeFileSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME), "garbage");

    const outcome = await run({
      betaHomeDir: betaHome,
      stateDir: join(betaHome, "userdata"),
    });
    expect(outcome.consumed).toBe(true);
    expect(outcome.ok).toBe(false);
    // Marker is gone — a second boot does not retry a malformed request.
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(false);
  });

  it("refuses a source that is not the Synara data folder", async () => {
    const root = await seedStableHome(makeRoot());
    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    writeMarker(betaHome, root);

    const outcome = await run(
      { betaHomeDir: betaHome, stateDir: betaState },
      { allowedSourceHomes: [join(root, "..", "somewhere-else")] },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("not the Synara data folder");
    expect(existsSync(join(betaState, "state.sqlite"))).toBe(false);
  });

  it("refuses a stable database newer than this beta understands", async () => {
    const root = await seedStableHome(makeRoot());
    const { DatabaseSync } = await import("node:sqlite");
    const stableDb = new DatabaseSync(join(root, "userdata", "state.sqlite"));
    stableDb.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER, name TEXT)");
    stableDb.exec("INSERT INTO effect_sql_migrations VALUES (1, 'a'), (51, 'from-the-future')");
    stableDb.close();
    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    writeMarker(betaHome, root);

    const outcome = await run(
      { betaHomeDir: betaHome, stateDir: betaState },
      { latestMigrationId: 50 },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("Update Synara Beta");
    expect(existsSync(join(betaState, "state.sqlite"))).toBe(false);
    expect(existsSync(join(betaState, "settings.json"))).toBe(false);
  });

  it("drops a stale beta WAL so it cannot replay over the imported database", async () => {
    const root = await seedStableHome(makeRoot());
    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    mkdirSync(betaState, { recursive: true });

    // Leave a real, un-checkpointed WAL from an "unclean" earlier beta run.
    const { DatabaseSync } = await import("node:sqlite");
    const betaDbPath = join(betaState, "state.sqlite");
    const oldBeta = new DatabaseSync(betaDbPath);
    oldBeta.exec("PRAGMA journal_mode = WAL");
    oldBeta.exec("PRAGMA wal_autocheckpoint = 0");
    oldBeta.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)");
    oldBeta.exec("INSERT INTO threads VALUES ('old', 'stale beta row')");
    const staleWal = readFileSync(`${betaDbPath}-wal`);
    oldBeta.close();
    writeFileSync(`${betaDbPath}-wal`, staleWal);
    writeFileSync(`${betaDbPath}-shm`, "stale index");

    writeMarker(betaHome, root);
    const outcome = await run({ betaHomeDir: betaHome, stateDir: betaState });
    expect(outcome).toEqual({ consumed: true, ok: true });
    expect(existsSync(`${betaDbPath}-wal`)).toBe(false);
    expect(existsSync(`${betaDbPath}-shm`)).toBe(false);

    const db = new DatabaseSync(betaDbPath, { readOnly: true });
    const titles = (db.prepare("SELECT title FROM threads").all() as Array<{ title: string }>).map(
      (row) => row.title,
    );
    db.close();
    expect(titles).toEqual(["hello stable"]);
  });
});

describe("copyLiveDatabase", () => {
  function seedDbFile(root: string): string {
    const dbPath = join(root, "state.sqlite");
    writeFileSync(dbPath, "db");
    writeFileSync(`${dbPath}-wal`, "wal");
    writeFileSync(`${dbPath}-shm`, "shm");
    return dbPath;
  }

  it("retries a copy torn by a checkpoint and skips the shm index", () => {
    const root = makeRoot();
    const dbPath = seedDbFile(root);
    const stagingDir = join(root, "staging");
    const signatures = ["a", "b", "b", "b"];
    const staged = copyLiveDatabase(dbPath, stagingDir, () => signatures.shift() ?? "b");
    expect(signatures).toEqual([]);
    expect(readFileSync(staged, "utf8")).toBe("db");
    expect(readdirSync(stagingDir).toSorted()).toEqual(["state.sqlite", "state.sqlite-wal"]);
  });

  it("fails instead of importing a torn pair when the database never settles", () => {
    const root = makeRoot();
    const dbPath = seedDbFile(root);
    let tick = 0;
    expect(() => copyLiveDatabase(dbPath, join(root, "staging"), () => String(tick++))).toThrow(
      /kept rewriting/,
    );
  });
});
