import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  recoverDesktopMigrationIfRequired,
  resolveDesktopMigrationRecoveryPaths,
  restoreDesktopMigrationBackup,
  type DesktopMigrationRecoveryPaths,
} from "./desktopMigrationRecovery";

describe("desktop migration recovery", () => {
  it("targets the same production database and bundled restore authority as the server", () => {
    expect(
      resolveDesktopMigrationRecoveryPaths({
        baseDir: Path.join(Path.sep, "home", "synara"),
        appRoot: Path.join(Path.sep, "app"),
        isDevelopment: false,
      }),
    ).toEqual({
      dbPath: Path.join(Path.sep, "home", "synara", "userdata", "state.sqlite"),
      markerPath: Path.join(
        Path.sep,
        "home",
        "synara",
        "userdata",
        "state.sqlite.migration-recovery.json",
      ),
      restoreEntryPath: Path.join(
        Path.sep,
        "app",
        "apps",
        "server",
        "dist",
        "restoreMigrationBackup.mjs",
      ),
    });
  });

  it("uses the isolated development database when the desktop backend receives a dev URL", () => {
    const paths = resolveDesktopMigrationRecoveryPaths({
      baseDir: Path.join(Path.sep, "home", "synara"),
      appRoot: Path.join(Path.sep, "repo"),
      isDevelopment: true,
    });

    expect(paths.dbPath).toBe(Path.join(Path.sep, "home", "synara", "dev", "state.sqlite"));
  });

  it("continues only when the server-owned command clears the durable marker", async () => {
    const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "synara-desktop-recovery-"));
    const dbPath = Path.join(directory, "state.sqlite");
    const paths: DesktopMigrationRecoveryPaths = {
      dbPath,
      markerPath: `${dbPath}.migration-recovery.json`,
      restoreEntryPath: Path.join(directory, "restore.mjs"),
    };
    await FS.writeFile(paths.markerPath, "pending", "utf8");
    await FS.writeFile(
      paths.restoreEntryPath,
      'import fs from "node:fs/promises"; await fs.unlink(`${process.argv[2]}.migration-recovery.json`); console.log("restored");',
      "utf8",
    );

    await expect(
      restoreDesktopMigrationBackup({
        executablePath: process.execPath,
        nodeArgs: [],
        paths,
        cwd: directory,
        env: process.env,
      }),
    ).resolves.toBe("restored");
    await expect(FS.access(paths.markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when a successful command leaves the recovery marker behind", async () => {
    const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "synara-desktop-recovery-"));
    const dbPath = Path.join(directory, "state.sqlite");
    const paths: DesktopMigrationRecoveryPaths = {
      dbPath,
      markerPath: `${dbPath}.migration-recovery.json`,
      restoreEntryPath: Path.join(directory, "restore.mjs"),
    };
    await FS.writeFile(paths.markerPath, "pending", "utf8");
    await FS.writeFile(paths.restoreEntryPath, "process.exitCode = 0;", "utf8");

    await expect(
      restoreDesktopMigrationBackup({
        executablePath: process.execPath,
        nodeArgs: [],
        paths,
        cwd: directory,
        env: process.env,
      }),
    ).rejects.toThrow("without clearing its recovery marker");
  });

  it("does not prompt or mutate startup when no recovery marker exists", async () => {
    const choose = vi.fn();
    const restore = vi.fn();

    await expect(
      recoverDesktopMigrationIfRequired({
        markerExists: () => false,
        choose,
        restore,
        requestRestart: vi.fn(),
        requestQuit: vi.fn(),
        formatError: String,
        log: vi.fn(),
      }),
    ).resolves.toBe("continue");
    expect(choose).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("retries a failed restore and keeps the backend blocked until the user quits", async () => {
    const choose = vi.fn().mockResolvedValueOnce("restore").mockResolvedValueOnce("quit");
    const requestQuit = vi.fn();

    await expect(
      recoverDesktopMigrationIfRequired({
        markerExists: () => true,
        choose,
        restore: vi.fn().mockRejectedValue(new Error("database is locked")),
        requestRestart: vi.fn(),
        requestQuit,
        formatError: (error) => (error as Error).message,
        log: vi.fn(),
      }),
    ).resolves.toBe("quit-requested");
    expect(choose).toHaveBeenNthCalledWith(2, { previousFailure: "database is locked" });
    expect(requestQuit).toHaveBeenCalledWith("migration recovery declined");
  });

  it("requests a clean relaunch only after restore clears the marker", async () => {
    let markerExists = true;
    const requestRestart = vi.fn();
    const requestQuit = vi.fn();

    await expect(
      recoverDesktopMigrationIfRequired({
        markerExists: () => markerExists,
        choose: vi.fn().mockResolvedValue("restore"),
        restore: vi.fn(async () => {
          markerExists = false;
        }),
        requestRestart,
        requestQuit,
        formatError: String,
        log: vi.fn(),
      }),
    ).resolves.toBe("restart-requested");
    expect(requestRestart).toHaveBeenCalledTimes(1);
    expect(requestQuit).toHaveBeenCalledWith("migration recovery restart");
  });
});
