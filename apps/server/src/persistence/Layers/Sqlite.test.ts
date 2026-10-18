import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeSqlitePersistenceLive } from "./Sqlite.ts";
import { resolveSqliteMemoryBudget } from "../sqliteMemoryBudget.ts";
import { reclaimFreedSqlitePages, reclaimLegacySqliteDatabase } from "../SqliteReclamation.ts";
import { runProcess } from "../../processRunner.ts";

const tempDirectories: Array<string> = [];

async function makeDbPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-sqlite-live-"));
  tempDirectories.push(directory);
  return path.join(directory, "state.sqlite");
}

async function createNormalWalSnapshot(dbPath: string): Promise<Buffer> {
  const seedPath = `${dbPath}.seed`;
  const seed = new DatabaseSync(seedPath);
  try {
    seed.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE recovery_probe(value TEXT NOT NULL);
    `);
    seed.prepare("INSERT INTO recovery_probe(value) VALUES (?)").run("survives-recovery");
    await Promise.all(
      ["", "-wal", "-shm"].map((suffix) =>
        fs.copyFile(`${seedPath}${suffix}`, `${dbPath}${suffix}`),
      ),
    );
    return fs.readFile(`${dbPath}-shm`);
  } finally {
    seed.close();
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

describe("SQLite persistence", () => {
  it("reclaims a bounded batch of deleted pages without removing retained rows", async () => {
    const dbPath = await makeDbPath();
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [mode] = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
        expect(mode?.auto_vacuum).toBe(2);
        yield* sql`CREATE TABLE reclaim_probe(id INTEGER PRIMARY KEY, payload BLOB)`;
        yield* sql`
          WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<512)
          INSERT INTO reclaim_probe SELECT x, zeroblob(16384) FROM n
        `;
        yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        yield* sql`DELETE FROM reclaim_probe WHERE id>32`;
        const [before] = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
        expect(before!.freelist_count).toBeGreaterThan(256);
        const sizeBefore = yield* Effect.promise(() => fs.stat(dbPath));
        yield* reclaimFreedSqlitePages(sql);
        const [after] = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
        expect(after!.freelist_count).toBeGreaterThan(0);
        expect(before!.freelist_count - after!.freelist_count).toBe(256);
        const sizeAfter = yield* Effect.promise(() => fs.stat(dbPath));
        expect(sizeAfter.size).toBeLessThan(sizeBefore.size);
        const rows = yield* sql<{ readonly count: number; readonly bytes: number }>`
          SELECT count(*) AS count, sum(length(payload)) AS bytes FROM reclaim_probe
        `;
        expect(rows).toEqual([{ count: 32, bytes: 32 * 16384 }]);
        expect(yield* sql`PRAGMA integrity_check`).toEqual([{ integrity_check: "ok" }]);
      }).pipe(
        Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
      ),
    );
  });

  it("enables incremental reclamation before Bun's client can create a WAL database", async () => {
    const dbPath = await makeDbPath();
    const source = `
      import { Effect, Layer } from "effect";
      import * as NodeServices from "@effect/platform-node/NodeServices";
      import * as SqlClient from "effect/unstable/sql/SqlClient";
      import { makeSqlitePersistenceLive } from ${JSON.stringify(new URL("./Sqlite.ts", import.meta.url).href)};
      await Effect.runPromise(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [mode] = yield* sql\x60PRAGMA auto_vacuum\x60;
        if (mode.auto_vacuum !== 2) throw new Error("New Bun database did not enable incremental reclamation");
      }).pipe(Effect.provide(makeSqlitePersistenceLive(process.argv[1]).pipe(Layer.provide(NodeServices.layer)))));
    `;
    await runProcess("bun", ["--eval", source, dbPath], { timeoutMs: 10_000 });
  });

  it.each([0, 1])(
    "reclaims legacy free space on close and preserves existing mode %s",
    async (mode) => {
      const dbPath = await makeDbPath();
      const seeded = new DatabaseSync(dbPath);
      seeded.exec(`
      PRAGMA auto_vacuum=${mode};
      CREATE TABLE reclaim_probe(id INTEGER PRIMARY KEY, payload BLOB);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2048)
      INSERT INTO reclaim_probe SELECT x, zeroblob(16384) FROM n;
      DELETE FROM reclaim_probe WHERE id>32;
    `);
      seeded.close();
      const marker = path.join(path.dirname(dbPath), "maintenance-lock-owner");
      const preload = path.join(path.dirname(dbPath), "lock-owner.mjs");
      await fs.writeFile(
        preload,
        `
      import { existsSync, writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, existsSync(process.argv[1] + ".lifecycle-lock") ? "owned" : "missing");
    `,
      );
      vi.stubEnv("NODE_OPTIONS", `--import=${preload}`);
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [liveMode] = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
          expect(liveMode?.auto_vacuum).toBe(mode);
        }).pipe(
          Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
        ),
      );
      const reopened = new DatabaseSync(dbPath);
      try {
        expect(reopened.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: mode || 2 });
        expect(
          reopened
            .prepare("SELECT count(*) AS count, sum(length(payload)) AS bytes FROM reclaim_probe")
            .get(),
        ).toEqual({ count: 32, bytes: 32 * 16384 });
        expect(reopened.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect((await fs.stat(dbPath)).size).toBeLessThan(4 * 1024 * 1024);
      } finally {
        reopened.close();
      }
      if (mode === 0) expect(await fs.readFile(marker, "utf8")).toBe("owned");
      await expect(fs.stat(`${dbPath}.lifecycle-lock`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("leaves a legacy database unchanged when the disk cannot hold the rebuild", async () => {
    const dbPath = await makeDbPath();
    const database = new DatabaseSync(dbPath);
    database.exec(`
      CREATE TABLE reclaim_probe(id INTEGER PRIMARY KEY, payload BLOB);
      INSERT INTO reclaim_probe VALUES(1, zeroblob(32*1024*1024));
      INSERT INTO reclaim_probe VALUES(2, x'cafe');
      DELETE FROM reclaim_probe WHERE id=1;
    `);
    database.close();
    const original = createHash("sha256")
      .update(await fs.readFile(dbPath))
      .digest("hex");
    const preload = path.join(path.dirname(dbPath), "low-space.mjs");
    await fs.writeFile(
      preload,
      `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      fs.statfs = async () => ({ bavail: 0, bsize: 4096 });
      syncBuiltinESMExports();
    `,
    );
    vi.stubEnv("NODE_OPTIONS", `--import=${preload}`);
    await Effect.runPromise(reclaimLegacySqliteDatabase(dbPath));
    expect(
      createHash("sha256")
        .update(await fs.readFile(dbPath))
        .digest("hex"),
    ).toBe(original);
  });

  it("waits for a timed-out native SQL child to exit and recovers its uncommitted writes", async () => {
    const dbPath = await makeDbPath();
    const database = new DatabaseSync(dbPath);
    database.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE reclaim_probe(id INTEGER PRIMARY KEY, payload BLOB);
      INSERT INTO reclaim_probe VALUES(1, zeroblob(32*1024*1024));
      INSERT INTO reclaim_probe VALUES(2, x'cafe');
      DELETE FROM reclaim_probe WHERE id=1;
    `);
    database.close();
    const marker = path.join(path.dirname(dbPath), "native-sql-started");
    const preload = path.join(path.dirname(dbPath), "interrupted-sql.mjs");
    await fs.writeFile(
      preload,
      `
      import { DatabaseSync } from "node:sqlite";
      import { writeFileSync } from "node:fs";
      const original = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) {
        if (sql.includes("VACUUM;")) {
          original.call(this, "PRAGMA cache_size=1; BEGIN EXCLUSIVE; DELETE FROM reclaim_probe;");
          writeFileSync(${JSON.stringify(marker)}, "started");
          original.call(this, "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) SELECT count(*) FROM n a,n b,n c");
        }
        return original.call(this, sql);
      };
    `,
    );
    vi.stubEnv("NODE_OPTIONS", `--import=${preload}`);
    await Effect.runPromise(reclaimLegacySqliteDatabase(dbPath));
    expect(await fs.readFile(marker, "utf8")).toBe("started");
    const reopened = new DatabaseSync(dbPath);
    try {
      expect(
        reopened.prepare("SELECT id, hex(payload) AS payload FROM reclaim_probe").all(),
      ).toEqual([{ id: 2, payload: "CAFE" }]);
      expect(reopened.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(reopened.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 0 });
    } finally {
      reopened.close();
    }
  });

  it("owns the live WAL exclusively without exposing a shared-memory sidecar", async () => {
    const dbPath = await makeDbPath();

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [lockingMode] = yield* sql<{ readonly locking_mode: string }>`
          PRAGMA locking_mode;
        `;
        const [journalMode] = yield* sql<{ readonly journal_mode: string }>`
          PRAGMA journal_mode;
        `;

        expect(lockingMode?.locking_mode).toBe("exclusive");
        expect(journalMode?.journal_mode).toBe("wal");

        // Large-database tuning must actually take effect, not silently
        // no-op: a reverted or ignored cache_size reintroduces multi-minute
        // startups on multi-GB event logs. mmap_size may be capped by the
        // runtime build, so only require that mapping is enabled at all.
        const [cacheSize] = yield* sql<{ readonly cache_size: number }>`
          PRAGMA cache_size;
        `;
        const [mmapSize] = yield* sql<{ readonly mmap_size: number }>`
          PRAGMA mmap_size;
        `;
        expect(cacheSize?.cache_size).toBe(
          resolveSqliteMemoryBudget(os.totalmem()).cacheSizePragma,
        );
        expect(mmapSize?.mmap_size).toBeGreaterThan(0);

        yield* sql`CREATE TABLE ownership_probe(value TEXT NOT NULL)`;
        yield* sql`INSERT INTO ownership_probe(value) VALUES ('owned-by-synara')`;
        yield* Effect.promise(async () => {
          await expect(fs.stat(`${dbPath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
        });

        let external: DatabaseSync | undefined;
        expect(() => {
          external = new DatabaseSync(dbPath, { readOnly: true });
          external.prepare("SELECT value FROM ownership_probe").get();
        }).toThrow(/database is locked/i);
        external?.close();

        const rows = yield* sql<{ readonly value: string }>`
          SELECT value FROM ownership_probe
        `;
        expect(rows).toEqual([{ value: "owned-by-synara" }]);
        yield* Effect.promise(async () => {
          await expect(fs.stat(`${dbPath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
        });
      }).pipe(
        Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
      ),
    );
  });

  it("recovers an existing WAL without touching its stale shared-memory sidecar", async () => {
    const dbPath = await makeDbPath();
    const staleShm = await createNormalWalSnapshot(dbPath);

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly value: string }>`
          SELECT value FROM recovery_probe
        `;
        const [lockingMode] = yield* sql<{ readonly locking_mode: string }>`
          PRAGMA locking_mode;
        `;

        expect(rows).toEqual([{ value: "survives-recovery" }]);
        expect(lockingMode?.locking_mode).toBe("exclusive");
        yield* Effect.promise(async () => {
          expect(await fs.readFile(`${dbPath}-shm`)).toEqual(staleShm);
        });
      }).pipe(
        Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
      ),
    );

    expect(await fs.readFile(`${dbPath}-shm`)).toEqual(staleShm);
  });
});
