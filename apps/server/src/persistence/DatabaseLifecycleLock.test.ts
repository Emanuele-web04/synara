import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireDatabaseLifecycleLock,
  DatabaseLifecycleLockedError,
  releaseDatabaseLifecycleLock,
  withDatabaseLifecycleLock,
} from "./DatabaseLifecycleLock.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import { restoreMarkedMigrationBackup } from "./MigrationBackup.ts";

const tempDirectories: Array<string> = [];

async function makeDbPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-db-lock-"));
  tempDirectories.push(directory);
  return path.join(directory, "state.sqlite");
}

async function writeOwnedDirectory(directoryPath: string, pid: number): Promise<void> {
  await fs.mkdir(directoryPath, { mode: 0o700 });
  await fs.writeFile(
    path.join(directoryPath, "owner.json"),
    `${JSON.stringify({
      pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

describe("database lifecycle lock", () => {
  it("allows one same-process owner and releases only its owner token", async () => {
    const dbPath = await makeDbPath();
    const first = await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));

    try {
      await expect(Effect.runPromise(acquireDatabaseLifecycleLock(dbPath))).rejects.toBeInstanceOf(
        DatabaseLifecycleLockedError,
      );
      const parentEntries = await fs.readdir(path.dirname(dbPath));
      expect(parentEntries.some((entry) => entry.includes(".lifecycle-lock.acquiring."))).toBe(
        false,
      );
      await expect(fs.readFile(path.join(first.lockPath, "owner.json"), "utf8")).resolves.toContain(
        first.owner.token,
      );
      const forged = { ...first, owner: { ...first.owner, token: randomUUID() } };
      await expect(Effect.runPromise(releaseDatabaseLifecycleLock(forged))).rejects.toBeInstanceOf(
        DatabaseLifecycleLockedError,
      );
    } finally {
      await Effect.runPromise(releaseDatabaseLifecycleLock(first));
    }

    const next = await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));
    await Effect.runPromise(releaseDatabaseLifecycleLock(next));
    const releasedEntries = await fs.readdir(path.dirname(dbPath));
    expect(releasedEntries.some((entry) => entry.includes(".lifecycle-lock.released."))).toBe(
      false,
    );
  });

  it("recovers a well-formed lock owned by a dead process", async () => {
    const dbPath = await makeDbPath();
    const lockPath = `${dbPath}.lifecycle-lock`;
    await writeOwnedDirectory(lockPath, 2_147_483_647);

    const acquired = await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));
    expect(acquired.owner.pid).toBe(process.pid);
    await Effect.runPromise(releaseDatabaseLifecycleLock(acquired));
    await expect(fs.stat(`${lockPath}.reaper`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a reaper guard whose owner process died", async () => {
    const dbPath = await makeDbPath();
    const lockPath = `${dbPath}.lifecycle-lock`;
    const reaperPath = `${lockPath}.reaper`;
    await writeOwnedDirectory(lockPath, 2_147_483_647);
    await writeOwnedDirectory(reaperPath, 2_147_483_647);

    const acquired = await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));
    expect(acquired.owner.pid).toBe(process.pid);
    await Effect.runPromise(releaseDatabaseLifecycleLock(acquired));

    const entries = await fs.readdir(path.dirname(dbPath));
    expect(entries.some((entry) => entry.includes(".lifecycle-lock.reaper"))).toBe(false);
  });

  it("does not take over a reaper guard owned by a live process", async () => {
    const dbPath = await makeDbPath();
    const lockPath = `${dbPath}.lifecycle-lock`;
    const reaperPath = `${lockPath}.reaper`;
    await writeOwnedDirectory(lockPath, 2_147_483_647);
    await writeOwnedDirectory(reaperPath, process.pid);

    await expect(Effect.runPromise(acquireDatabaseLifecycleLock(dbPath))).rejects.toBeInstanceOf(
      DatabaseLifecycleLockedError,
    );
    await expect(fs.stat(lockPath)).resolves.toBeDefined();
    await expect(fs.stat(reaperPath)).resolves.toBeDefined();
  });

  it("recovers an ownerless directory and fails closed for an owner-file symlink", async () => {
    const dbPath = await makeDbPath();
    const lockPath = `${dbPath}.lifecycle-lock`;
    await fs.mkdir(lockPath, { mode: 0o700 });

    const recovered = await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));
    expect(recovered.owner.pid).toBe(process.pid);
    await Effect.runPromise(releaseDatabaseLifecycleLock(recovered));

    await fs.mkdir(lockPath, { mode: 0o700 });
    const outsideOwner = path.join(path.dirname(dbPath), "outside-owner.json");
    const outsideContents = `${JSON.stringify({
      pid: 2_147_483_647,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    })}\n`;
    await fs.writeFile(outsideOwner, outsideContents);
    await fs.symlink(outsideOwner, path.join(lockPath, "owner.json"));

    await expect(Effect.runPromise(acquireDatabaseLifecycleLock(dbPath))).rejects.toBeInstanceOf(
      DatabaseLifecycleLockedError,
    );
    expect(await fs.readFile(outsideOwner, "utf8")).toBe(outsideContents);
    expect((await fs.lstat(path.join(lockPath, "owner.json"))).isSymbolicLink()).toBe(true);
  });

  it("makes recovery refuse while a server layer owns the database", async () => {
    const dbPath = await makeDbPath();

    const recoveryExit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
          );
          return yield* Effect.exit(restoreMarkedMigrationBackup(dbPath));
        }),
      ),
    );

    expect(recoveryExit._tag).toBe("Failure");
    if (recoveryExit._tag === "Failure") {
      expect(String(recoveryExit.cause)).toContain("DatabaseLifecycleLockedError");
    }
  });

  it("makes server startup refuse while recovery owns the database", async () => {
    const dbPath = await makeDbPath();

    const startupExit = await Effect.runPromise(
      withDatabaseLifecycleLock(
        dbPath,
        Effect.exit(
          Layer.build(
            makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
          ).pipe(Effect.scoped),
        ),
      ),
    );

    expect(startupExit._tag).toBe("Failure");
    if (startupExit._tag === "Failure") {
      expect(String(startupExit.cause)).toContain("DatabaseLifecycleLockedError");
    }
  });
});
