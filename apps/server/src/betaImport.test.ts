// FILE: betaImport.test.ts
// Purpose: Coverage for the beta-side stable-data snapshot import.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
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

  it("keeps the existing Beta database and settings if a Stable secret is linked", async () => {
    const stableHome = await seedStableHome(makeRoot());
    const stableState = join(stableHome, "userdata");
    const betaHome = join(stableHome, "..", ".synara-beta");
    const betaState = join(betaHome, "userdata");
    mkdirSync(betaState, { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const betaDb = new DatabaseSync(join(betaState, "state.sqlite"));
    betaDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)");
    betaDb.exec("INSERT INTO threads VALUES ('beta', 'Beta-only chat')");
    betaDb.close();
    writeFileSync(join(betaState, "settings.json"), JSON.stringify({ theme: "beta" }));
    symlinkSync(join(stableState, "settings.json"), join(stableState, "secrets", "linked.json"));
    writeMarker(betaHome, stableHome);

    const outcome = await run({ betaHomeDir: betaHome, stateDir: betaState });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("linked state entry");
    const stillBeta = new DatabaseSync(join(betaState, "state.sqlite"), { readOnly: true });
    expect(stillBeta.prepare("SELECT title FROM threads").get()).toEqual({
      title: "Beta-only chat",
    });
    stillBeta.close();
    expect(readFileSync(join(betaState, "settings.json"), "utf8")).toContain("beta");
    expect(existsSync(join(betaState, "secrets", "linked.json"))).toBe(false);
  });

  it.each(["userdata", "state.sqlite"])(
    "rejects a linked Stable %s before changing Beta",
    async (linkedEntry) => {
      const stableHome = await seedStableHome(makeRoot());
      const stableState = join(stableHome, "userdata");
      const betaHome = join(stableHome, "..", ".synara-beta");
      const betaState = join(betaHome, "userdata");
      mkdirSync(betaState, { recursive: true });
      writeFileSync(join(betaState, "settings.json"), "beta-only");

      const sourcePath = linkedEntry === "userdata" ? stableState : join(stableState, linkedEntry);
      const realPath = `${sourcePath}-real`;
      renameSync(sourcePath, realPath);
      symlinkSync(realPath, sourcePath);
      writeMarker(betaHome, stableHome);

      const outcome = await run({ betaHomeDir: betaHome, stateDir: betaState });
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("linked state entry");
      expect(readFileSync(join(betaState, "settings.json"), "utf8")).toBe("beta-only");
      expect(existsSync(join(betaState, "state.sqlite"))).toBe(false);
    },
  );

  it("preserves Beta-only entries inside a directory while re-copying Stable data", async () => {
    const stableHome = await seedStableHome(makeRoot());
    const betaHome = join(stableHome, "..", ".synara-beta");
    const betaState = join(betaHome, "userdata");
    mkdirSync(join(betaState, "secrets"), { recursive: true });
    writeFileSync(join(betaState, "secrets", "beta-only.json"), "beta-only");
    writeMarker(betaHome, stableHome);

    const outcome = await run({ betaHomeDir: betaHome, stateDir: betaState });
    expect(outcome).toEqual({ consumed: true, ok: true });
    expect(readFileSync(join(betaState, "secrets", "beta-only.json"), "utf8")).toBe("beta-only");
    expect(existsSync(join(betaState, "secrets", "token.json"))).toBe(true);
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

  it("copies portable skills and MCP credentials, never pending pairings", async () => {
    const stableHome = await seedStableHome(makeRoot());
    mkdirSync(join(stableHome, "skills", "stable-skill"), { recursive: true });
    writeFileSync(join(stableHome, "skills", "stable-skill", "SKILL.md"), "stable skill\n");
    mkdirSync(join(stableHome, "mcp", "credentials"), { recursive: true });
    writeFileSync(
      join(stableHome, "mcp", "credentials", "client.json"),
      JSON.stringify({ token: "stable" }),
    );
    mkdirSync(join(stableHome, "mcp", "pending-pairing"), { recursive: true });
    writeFileSync(
      join(stableHome, "mcp", "pending-pairing", "secret.json"),
      JSON.stringify({ secret: "single-use" }),
    );
    // Runtime identity must not ride along even when beta has none of its own.
    writeFileSync(join(stableHome, "userdata", "environment-id"), "stable-env\n");

    const betaHome = join(stableHome, "..", ".synara-beta");
    mkdirSync(join(betaHome, "skills", "beta-only-skill"), { recursive: true });
    writeFileSync(join(betaHome, "skills", "beta-only-skill", "SKILL.md"), "beta only\n");
    mkdirSync(join(betaHome, "mcp", "credentials"), { recursive: true });
    writeFileSync(
      join(betaHome, "mcp", "credentials", "beta-only.json"),
      JSON.stringify({ token: "beta" }),
    );
    writeMarker(betaHome, stableHome);

    const outcome = await run({ betaHomeDir: betaHome, stateDir: join(betaHome, "userdata") });
    expect(outcome).toEqual({ consumed: true, ok: true });
    expect(readFileSync(join(betaHome, "skills", "stable-skill", "SKILL.md"), "utf8")).toContain(
      "stable skill",
    );
    expect(readFileSync(join(betaHome, "skills", "beta-only-skill", "SKILL.md"), "utf8")).toContain(
      "beta only",
    );
    expect(readFileSync(join(betaHome, "mcp", "credentials", "client.json"), "utf8")).toContain(
      "stable",
    );
    expect(readFileSync(join(betaHome, "mcp", "credentials", "beta-only.json"), "utf8")).toContain(
      "beta",
    );
    expect(existsSync(join(betaHome, "mcp", "pending-pairing"))).toBe(false);
    expect(existsSync(join(betaHome, "userdata", "environment-id"))).toBe(false);
  });

  it("keeps beta's own environment identity and boot-ownership claims", async () => {
    const stableHome = await seedStableHome(makeRoot());
    const stableState = join(stableHome, "userdata");
    writeFileSync(join(stableState, "environment-id"), "stable-env\n");
    writeFileSync(
      join(stableState, "device-boot-ownership.json"),
      JSON.stringify({ pid: 1, udids: ["stable-device"] }),
    );

    const betaHome = join(stableHome, "..", ".synara-beta");
    const betaState = join(betaHome, "userdata");
    mkdirSync(betaState, { recursive: true });
    writeFileSync(join(betaState, "environment-id"), "beta-env\n");
    writeFileSync(
      join(betaState, "device-boot-ownership.json"),
      JSON.stringify({ pid: 2, udids: ["beta-device"] }),
    );
    writeMarker(betaHome, stableHome);

    const outcome = await run({ betaHomeDir: betaHome, stateDir: betaState });
    expect(outcome).toEqual({ consumed: true, ok: true });
    expect(readFileSync(join(betaState, "environment-id"), "utf8")).toBe("beta-env\n");
    expect(readFileSync(join(betaState, "device-boot-ownership.json"), "utf8")).toContain(
      "beta-device",
    );
  });

  it("nulls source-home worktree paths while keeping branches and outside paths", async () => {
    const root = makeRoot();
    const stableHome = await seedStableHome(root);
    const { DatabaseSync } = await import("node:sqlite");
    const stableDb = new DatabaseSync(join(stableHome, "userdata", "state.sqlite"));
    stableDb.exec(
      "CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, branch TEXT, worktree_path TEXT, associated_worktree_path TEXT, associated_worktree_branch TEXT)",
    );
    const insideWorktree = join(stableHome, ".worktrees", "thread-a");
    const insideAssociated = join(stableHome, ".worktrees", "thread-a-associated");
    stableDb
      .prepare("INSERT INTO projection_threads VALUES ('inside', 'feature/a', ?, ?, 'feature/a')")
      .run(insideWorktree, insideAssociated);
    stableDb
      .prepare(
        "INSERT INTO projection_threads VALUES ('outside', 'feature/b', '/tmp/elsewhere', '/tmp/assoc', 'feature/b')",
      )
      .run();
    // A sibling of the source home shares the name prefix but is not inside
    // it; its paths must survive the import.
    stableDb
      .prepare("INSERT INTO projection_threads VALUES ('sibling', 'feature/c', ?, ?, 'feature/c')")
      .run(`${stableHome}-backup/wt`, `${stableHome}-backup/assoc`);
    stableDb.close();

    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    writeMarker(betaHome, stableHome);

    const outcome = await run({ betaHomeDir: betaHome, stateDir: betaState });
    expect(outcome).toEqual({ consumed: true, ok: true });
    const betaDb = new DatabaseSync(join(betaState, "state.sqlite"), { readOnly: true });
    const rows = betaDb
      .prepare(
        "SELECT thread_id, branch, worktree_path, associated_worktree_path, associated_worktree_branch FROM projection_threads ORDER BY thread_id",
      )
      .all() as Array<{
      thread_id: string;
      branch: string | null;
      worktree_path: string | null;
      associated_worktree_path: string | null;
      associated_worktree_branch: string | null;
    }>;
    betaDb.close();
    expect(rows).toEqual([
      {
        thread_id: "inside",
        branch: "feature/a",
        worktree_path: null,
        associated_worktree_path: null,
        associated_worktree_branch: "feature/a",
      },
      {
        thread_id: "outside",
        branch: "feature/b",
        worktree_path: "/tmp/elsewhere",
        associated_worktree_path: "/tmp/assoc",
        associated_worktree_branch: "feature/b",
      },
      {
        thread_id: "sibling",
        branch: "feature/c",
        worktree_path: `${stableHome}-backup/wt`,
        associated_worktree_path: `${stableHome}-backup/assoc`,
        associated_worktree_branch: "feature/c",
      },
    ]);
  });

  it("fails without touching beta when a skill file is linked", async () => {
    const stableHome = await seedStableHome(makeRoot());
    mkdirSync(join(stableHome, "skills", "linked-skill"), { recursive: true });
    writeFileSync(join(stableHome, "skills", "linked-skill", "SKILL.md"), "real\n");
    symlinkSync(
      join(stableHome, "skills", "linked-skill", "SKILL.md"),
      join(stableHome, "skills", "linked-skill", "evil.md"),
    );

    const betaHome = join(stableHome, "..", ".synara-beta");
    const betaState = join(betaHome, "userdata");
    mkdirSync(join(betaHome, "skills", "beta-only-skill"), { recursive: true });
    writeFileSync(join(betaHome, "skills", "beta-only-skill", "SKILL.md"), "beta only\n");
    writeMarker(betaHome, stableHome);

    const outcome = await run({ betaHomeDir: betaHome, stateDir: betaState });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("linked state entry");
    expect(existsSync(join(betaState, "state.sqlite"))).toBe(false);
    expect(readFileSync(join(betaHome, "skills", "beta-only-skill", "SKILL.md"), "utf8")).toContain(
      "beta only",
    );
    expect(existsSync(join(betaHome, "skills", "linked-skill"))).toBe(false);
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
