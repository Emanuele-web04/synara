import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as filesystemPlatform from "@synara/shared/filesystemPlatform";

import { runCompactDatabaseCli } from "./compactDatabase.ts";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "./persistence/DatabaseLifecycleLock.ts";
import { migrationRecoveryMarkerPath } from "./persistence/MigrationBackup.ts";
import { reclaimLegacySqliteDatabase } from "./persistence/SqliteReclamation.ts";

const directories: string[] = [];

async function fixture(mode = 0) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "synara-compact-")));
  directories.push(directory);
  const dbPath = path.join(directory, "state.sqlite");
  const database = new DatabaseSync(dbPath);
  database.exec(`
    PRAGMA auto_vacuum=${mode};
    PRAGMA application_id=1379031410;
    PRAGMA user_version=17;
    CREATE TABLE retained(id INTEGER PRIMARY KEY, value TEXT);
    INSERT INTO retained VALUES(1, 'keep first'), (2, 'keep second');
    CREATE TABLE churn(payload BLOB);
    INSERT INTO churn VALUES(zeroblob(32*1024*1024));
    DELETE FROM churn;
  `);
  database.close();
  return { directory, dbPath };
}

function capture() {
  const errors: string[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  return {
    errors,
    logs,
    warnings,
    output: {
      error: (text: string) => errors.push(text),
      log: (text: string) => logs.push(text),
      warn: (text: string) => warnings.push(text),
    },
  };
}

const digest = async (filename: string) =>
  createHash("sha256")
    .update(await fs.readFile(filename))
    .digest("hex");

async function preload(directory: string, source: string) {
  const filename = path.join(directory, "preload.mjs");
  await fs.writeFile(filename, source);
  vi.stubEnv("NODE_OPTIONS", `--import=${filename}`);
}

function assertRetained(dbPath: string, mode = 2) {
  const database = new DatabaseSync(dbPath);
  try {
    expect(database.prepare("SELECT * FROM retained ORDER BY id").all()).toEqual([
      { id: 1, value: "keep first" },
      { id: 2, value: "keep second" },
    ]);
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(database.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: mode });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 17 });
    expect(database.prepare("PRAGMA application_id").get()).toEqual({ application_id: 1379031410 });
  } finally {
    database.close();
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("offline SQLite compaction", () => {
  it("compacts with room for the live copy when shutdown reclamation cannot start", async () => {
    const { directory, dbPath } = await fixture();
    const before = await digest(dbPath);
    await preload(
      directory,
      `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      fs.statfs = async () => ({ bavail: 96 * 1024, bsize: 1024 });
      syncBuiltinESMExports();
    `,
    );
    await Effect.runPromise(reclaimLegacySqliteDatabase(dbPath));
    expect(await digest(dbPath)).toBe(before);
    const output = capture();
    expect(await runCompactDatabaseCli([dbPath], output.output)).toBe(0);
    expect(output.errors).toEqual([]);
    expect(output.logs.join("\n")).toContain("Compacted");
    expect((await fs.stat(dbPath)).size).toBeLessThan(64 * 1024);
    if (process.platform !== "win32") expect((await fs.stat(dbPath)).mode & 0o777).toBe(0o600);
    assertRetained(dbPath);
    await expect(fs.stat(`${dbPath}.lifecycle-lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([1, 2])("preserves an existing auto_vacuum policy of %s", async (mode) => {
    const { dbPath } = await fixture(mode);
    expect(await runCompactDatabaseCli([dbPath], capture().output)).toBe(0);
    assertRetained(dbPath, mode);
  });

  it("preserves the source when even the compact copy will not fit", async () => {
    const { directory, dbPath } = await fixture();
    const before = await digest(dbPath);
    await preload(
      directory,
      `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      fs.statfs = async () => ({ bavail: 0, bsize: 4096 });
      syncBuiltinESMExports();
    `,
    );
    const output = capture();
    expect(await runCompactDatabaseCli([dbPath], output.output)).toBe(1);
    expect(output.errors.join("\n")).toContain("Insufficient free space");
    expect(await digest(dbPath)).toBe(before);
    assertRetained(dbPath, 0);
    await expect(fs.stat(`${dbPath}.lifecycle-lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses active owners and pending migration recovery without touching data", async () => {
    const { dbPath } = await fixture();
    const before = await digest(dbPath);
    const lock = await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));
    try {
      const output = capture();
      expect(await runCompactDatabaseCli([dbPath], output.output)).toBe(1);
      expect(output.errors.join("\n")).toContain("locked");
      expect(await digest(dbPath)).toBe(before);
    } finally {
      await Effect.runPromise(releaseDatabaseLifecycleLock(lock));
    }
    await fs.writeFile(migrationRecoveryMarkerPath(dbPath), "{}");
    const output = capture();
    expect(await runCompactDatabaseCli([dbPath], output.output)).toBe(1);
    expect(output.errors.join("\n")).toContain("recovery");
    expect(await digest(dbPath)).toBe(before);
    expect(await fs.readFile(migrationRecoveryMarkerPath(dbPath), "utf8")).toBe("{}");
  });

  it("retries an abandoned copy without installing it or removing unrelated recovery data", async () => {
    const { directory, dbPath } = await fixture();
    const lockPath = `${dbPath}.lifecycle-lock`;
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        token: randomUUID(),
        createdAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    await fs.writeFile(path.join(lockPath, "compact.sqlite"), "interrupted copy");
    const backup = path.join(directory, "migration-backup.sqlite.gz");
    await fs.writeFile(backup, "retained recovery data");
    expect(await runCompactDatabaseCli([dbPath], capture().output)).toBe(0);
    assertRetained(dbPath);
    expect(await fs.readFile(backup, "utf8")).toBe("retained recovery data");
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps committed WAL rows when the previous process did not checkpoint", async () => {
    const { directory, dbPath } = await fixture();
    const seedPath = path.join(directory, "seed.sqlite");
    await fs.rename(dbPath, seedPath);
    const seed = new DatabaseSync(seedPath);
    try {
      seed.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO retained VALUES(3, 'committed in WAL');",
      );
      await Promise.all(
        ["", "-wal", "-shm"].map((suffix) =>
          fs.copyFile(`${seedPath}${suffix}`, `${dbPath}${suffix}`),
        ),
      );
    } finally {
      seed.close();
    }
    const output = capture();
    const code = await runCompactDatabaseCli([dbPath], output.output);
    expect(code, output.errors.join("\n")).toBe(0);
    const database = new DatabaseSync(dbPath);
    try {
      expect(database.prepare("SELECT value FROM retained WHERE id=3").get()).toEqual({
        value: "committed in WAL",
      });
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      database.close();
    }
  });

  it("refuses an external SQLite writer even without a Synara lifecycle lock", async () => {
    const { dbPath } = await fixture();
    const database = new DatabaseSync(dbPath);
    database.exec("BEGIN IMMEDIATE; INSERT INTO retained VALUES(3, 'external work');");
    try {
      expect(await runCompactDatabaseCli([dbPath], capture().output)).toBe(1);
      expect(database.prepare("SELECT value FROM retained WHERE id=3").get()).toEqual({
        value: "external work",
      });
      database.exec("ROLLBACK;");
      assertRetained(dbPath, 0);
    } finally {
      database.close();
    }
  });

  it("reports installation explicitly if the final directory flush fails", async () => {
    const { directory, dbPath } = await fixture();
    const sync = filesystemPlatform.syncDirectoryEntry;
    vi.spyOn(filesystemPlatform, "syncDirectoryEntry").mockImplementation(
      async (target, platform) => {
        if (target === directory && (await fs.stat(dbPath)).size < 64 * 1024) {
          throw new Error("injected directory sync failure");
        }
        return sync(target, platform);
      },
    );
    const output = capture();
    expect(await runCompactDatabaseCli([dbPath], output.output)).toBe(1);
    expect(output.errors.join("\n")).toContain("Compact database installed");
    expect(output.logs).toEqual([]);
    assertRetained(dbPath);
  });

  it("rejects a corrupt copy and retains the original", async () => {
    const { directory, dbPath } = await fixture();
    const before = await digest(dbPath);
    await preload(
      directory,
      `
      import { DatabaseSync } from "node:sqlite";
      import { writeFileSync } from "node:fs";
      const prepare = DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare = function(sql) {
        const statement = prepare.call(this, sql);
        if (sql === "VACUUM INTO ?") {
          const run = statement.run.bind(statement);
          statement.run = function(target) { const result = run(target); writeFileSync(target, "not a database"); return result; };
        }
        return statement;
      };
    `,
    );
    expect(await runCompactDatabaseCli([dbPath], capture().output)).toBe(1);
    expect(await digest(dbPath)).toBe(before);
    assertRetained(dbPath, 0);
  });

  it("keeps child ownership when runtime diagnostics exceed the output limit", async () => {
    const { directory, dbPath } = await fixture();
    await preload(directory, `process.stderr.write("diagnostic ".repeat(2000));`);
    expect(await runCompactDatabaseCli([dbPath], capture().output)).toBe(0);
    assertRetained(dbPath);
    await expect(fs.stat(`${dbPath}.lifecycle-lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for cancellation of native copy work before releasing ownership, then retries", async () => {
    const { directory, dbPath } = await fixture();
    const before = await digest(dbPath);
    const marker = path.join(directory, "child-started");
    await preload(
      directory,
      `
      import { DatabaseSync } from "node:sqlite";
      import { writeFileSync } from "node:fs";
      const prepare = DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare = function(sql) {
        if (sql === "VACUUM INTO ?") {
          writeFileSync(${JSON.stringify(marker)}, String(process.pid));
          this.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) SELECT count(*) FROM n a,n b,n c;");
        }
        return prepare.call(this, sql);
      };
    `,
    );
    const controller = new AbortController();
    const completion = runCompactDatabaseCli([dbPath], capture().output, controller.signal);
    await vi.waitFor(async () => expect(await fs.readFile(marker, "utf8")).toMatch(/^\d+$/), {
      timeout: 5000,
    });
    const childPid = Number(await fs.readFile(marker, "utf8"));
    controller.abort();
    expect(await completion).toBe(1);
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(await digest(dbPath)).toBe(before);
    await expect(fs.stat(`${dbPath}.lifecycle-lock`)).rejects.toMatchObject({ code: "ENOENT" });
    vi.unstubAllEnvs();
    expect(await runCompactDatabaseCli([dbPath], capture().output)).toBe(0);
    assertRetained(dbPath);
  });

  it("refuses Bun before inspecting or locking the database", async () => {
    const { directory, dbPath } = await fixture();
    const before = await digest(dbPath);
    const original = Object.getOwnPropertyDescriptor(process.versions, "bun");
    Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.4.4" });
    try {
      const output = capture();
      expect(await runCompactDatabaseCli([dbPath], output.output)).toBe(1);
      expect(output.errors.join("\n")).toContain("Bun is not supported");
      expect(output.logs).toEqual([]);
      expect(output.warnings).toEqual([]);
      expect(await digest(dbPath)).toBe(before);
      expect(await fs.readdir(directory)).toEqual(["state.sqlite"]);
    } finally {
      if (original) Object.defineProperty(process.versions, "bun", original);
      else Reflect.deleteProperty(process.versions, "bun");
    }
  });

  it("requires an explicit target and keeps other channel databases untouched", async () => {
    const { directory, dbPath } = await fixture();
    const channelPaths = await Promise.all(
      [".synara", ".synara-beta", ".synara-remote"].map(async (channel) => {
        const target = path.join(directory, channel, "userdata", "state.sqlite");
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(dbPath, target);
        return target;
      }),
    );
    vi.stubEnv("HOME", directory);
    vi.stubEnv("USERPROFILE", directory);
    vi.stubEnv("SYNARA_HOME", path.join(directory, ".synara"));
    vi.stubEnv("SYNARA_DESKTOP_FLAVOR", "remote");
    const before = await Promise.all(channelPaths.map(digest));

    expect(await runCompactDatabaseCli([], capture().output)).toBe(2);
    expect(await runCompactDatabaseCli(["state.sqlite"], capture().output)).toBe(2);
    expect(await Promise.all(channelPaths.map(digest))).toEqual(before);

    const remotePath = channelPaths[2]!;
    expect(await runCompactDatabaseCli([remotePath], capture().output)).toBe(0);
    expect(await Promise.all(channelPaths.slice(0, 2).map(digest))).toEqual(before.slice(0, 2));
    expect((await fs.stat(remotePath)).size).toBeLessThan((await fs.stat(dbPath)).size);
    assertRetained(remotePath);
  });

  it("requires an explicit existing absolute database and rejects links", async () => {
    const output = capture();
    expect(await runCompactDatabaseCli(["state.sqlite"], output.output)).toBe(2);
    expect(output.warnings.join("\n")).toContain("Stop every Synara process");
    const { directory, dbPath } = await fixture();
    const missing = path.join(directory, "missing.sqlite");
    expect(await runCompactDatabaseCli([missing], capture().output)).toBe(1);
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    if (process.platform !== "win32") {
      const link = path.join(directory, "linked.sqlite");
      await fs.symlink(dbPath, link);
      const before = await digest(dbPath);
      expect(await runCompactDatabaseCli([link], capture().output)).toBe(1);
      expect(await digest(dbPath)).toBe(before);
    }
  });
});
