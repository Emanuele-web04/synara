import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withDatabaseLifecycleLock } from "./persistence/DatabaseLifecycleLock";

const backendFixture = fileURLToPath(
  new URL("./fixtures/desktopParentLifetime.ts", import.meta.url),
);
const ownerFixture = fileURLToPath(new URL("./fixtures/desktopParentOwner.mjs", import.meta.url));

async function waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw cause;
  }
}

async function killOwner(owner: ChildProcess): Promise<void> {
  if (owner.exitCode !== null || owner.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => owner.once("exit", () => resolve()));
  owner.kill("SIGKILL");
  await exited;
}

// SIGKILL of the owning process reproduces the confirmed POSIX orphan condition.
const describePosix = process.platform === "win32" ? describe.skip : describe;
describePosix("desktop parent loss subprocess integration", () => {
  let fixtureDirectory: string;
  let bundledFixture: string;
  beforeAll(async () => {
    fixtureDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "synara-parent-fixture-"));
    bundledFixture = path.join(fixtureDirectory, "backend.mjs");
    // Exercise the production Node runtime, including code requiring TS
    // transforms, rather than relying on Node's strip-only TypeScript loader.
    execFileSync("bun", ["build", backendFixture, "--target=node", "--outfile", bundledFixture]);
  });
  afterAll(async () => {
    if (fixtureDirectory) await fsPromises.rm(fixtureDirectory, { recursive: true, force: true });
  });
  it.each(["close", "crash", "stubborn"] as const)(
    "releases database ownership after %s without admitting a concurrent owner",
    async (mode) => {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "synara-parent-lifetime-"));
      const dbPath = path.join(directory, "state.sqlite");
      const statePath = path.join(directory, "ready.json");
      const owner = spawn(
        process.execPath,
        [ownerFixture, bundledFixture, dbPath, statePath, mode],
        {
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      let backendPid: number | undefined;
      let stderr = "";
      owner.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      try {
        const state = await waitFor(() => {
          if (owner.exitCode !== null || owner.signalCode !== null || stderr) {
            throw new Error(`Backend fixture failed: ${stderr}`);
          }
          if (!fs.existsSync(statePath)) return undefined;
          return JSON.parse(fs.readFileSync(statePath, "utf8")) as { pid: number; marker: null };
        }, `backend startup (${stderr})`);
        backendPid = state.pid;
        expect(state.marker).toBeNull();
        expect(isAlive(state.pid)).toBe(true);
        await expect(
          Effect.runPromise(withDatabaseLifecycleLock(dbPath, Effect.void)),
        ).rejects.toThrow(`owner pid ${state.pid} is live`);

        if (mode === "close") owner.send("close");
        else await killOwner(owner);

        await waitFor(() => (isAlive(state.pid) ? undefined : true), "orphan backend exit");
        if (mode === "stubborn") {
          expect(fs.existsSync(`${statePath}.stopped`)).toBe(false);
          // A timed-out finalizer leaves a dead-owner lock for the existing safe
          // stale-owner recovery path; no live lock is ever bypassed.
          expect(fs.existsSync(`${dbPath}.lifecycle-lock`)).toBe(true);
        } else {
          expect(fs.readFileSync(`${statePath}.stopped`, "utf8")).toBe("cleaned up");
          expect(fs.existsSync(`${dbPath}.lifecycle-lock`)).toBe(false);
        }
        await Effect.runPromise(withDatabaseLifecycleLock(dbPath, Effect.void));
        expect(fs.existsSync(`${dbPath}.lifecycle-lock`)).toBe(false);
      } finally {
        await killOwner(owner);
        if (backendPid && isAlive(backendPid)) process.kill(backendPid, "SIGKILL");
        owner.stderr?.destroy();
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
