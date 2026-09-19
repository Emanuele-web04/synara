import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  nestedSessionStateDirectory,
  reapStaleNestedSessions,
  removeNestedSessionMarker,
  writeNestedSessionMarker,
  type NestedSessionMarker,
  type NestedSessionRegistryDependencies,
} from "./nestedSessionRegistry.ts";

const DEAD_SERVER_PID = 90_001;
const LIVE_SERVER_PID = 90_002;
const KWIN_PID = 91_001;
const BUS_PID = 91_002;
const KWIN_COMMAND = "kwin_wayland --virtual --socket synara-nested-7";
const BUS_COMMAND = "dbus-daemon --session --print-address=1 --nofork";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) await rmDirectory(directory);
  }
});

async function makeStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "synara-nested-registry-"));
  directories.push(directory);
  return directory;
}

async function rmDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

function marker(overrides: Partial<NestedSessionMarker> = {}): NestedSessionMarker {
  return {
    serverPid: DEAD_SERVER_PID,
    startedAt: 1_700_000_000_000,
    waylandDisplay: "synara-nested-7",
    processes: [
      { pid: KWIN_PID, command: KWIN_COMMAND, startTime: "5500" },
      { pid: BUS_PID, command: BUS_COMMAND, startTime: "5490" },
    ],
    ...overrides,
  };
}

interface Host {
  readonly dependencies: NestedSessionRegistryDependencies;
  readonly torndown: number[];
  readonly living: Set<number>;
}

/** A fake process table: nothing here ever signals a real pid. */
function host(options: {
  readonly stateDirectory: string;
  readonly living?: readonly number[];
  readonly commands?: Readonly<Record<number, string>>;
  readonly startTimes?: Readonly<Record<number, string>>;
}): Host {
  const living = new Set(options.living ?? [KWIN_PID, BUS_PID]);
  const torndown: number[] = [];
  const commands: Record<number, string> = options.commands ?? {
    [KWIN_PID]: KWIN_COMMAND,
    [BUS_PID]: BUS_COMMAND,
  };
  const startTimes: Record<number, string> = options.startTimes ?? {
    [KWIN_PID]: "5500",
    [BUS_PID]: "5490",
  };
  return {
    torndown,
    living,
    dependencies: {
      stateDirectory: options.stateDirectory,
      serverPid: LIVE_SERVER_PID,
      processAlive: (pid) => living.has(pid),
      processCommand: (pid) => commands[pid],
      processStartTime: (pid) => startTimes[pid],
      now: () => 0,
      sleep: async () => undefined,
      teardownProcessTree: async (input) => {
        torndown.push(input.rootPid);
        living.delete(input.rootPid);
        return { escalated: false, signalErrors: [] };
      },
    },
  };
}

describe("nestedSessionStateDirectory", () => {
  it("lives in the runtime directory, which the session's end wipes", () => {
    expect(nestedSessionStateDirectory({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(
      "/run/user/1000/synara-nested-sessions",
    );
    expect(nestedSessionStateDirectory({})).toBe(join(tmpdir(), "synara-nested-sessions"));
  });
});

describe("writeNestedSessionMarker", () => {
  it("records the session where the next server will look for it", async () => {
    const stateDirectory = join(await makeStateDirectory(), "markers");
    const path = await writeNestedSessionMarker(marker(), { stateDirectory });

    expect(await readdir(stateDirectory)).toEqual(["90001-synara-nested-7.json"]);
    // Only this user's processes are named in it, so only this user reads it.
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await removeNestedSessionMarker(path);
    expect(await readdir(stateDirectory)).toEqual([]);
  });
});

describe("reapStaleNestedSessions", () => {
  it("ends the compositor and bus a killed server left running", async () => {
    // The whole failure this exists for: SIGKILL the server and its nested
    // desktop keeps running, with nothing left that knows about it.
    const stateDirectory = await makeStateDirectory();
    await writeNestedSessionMarker(marker(), { stateDirectory });
    const fake = host({ stateDirectory });

    await expect(reapStaleNestedSessions(fake.dependencies)).resolves.toEqual(["synara-nested-7"]);
    expect(fake.torndown).toEqual([KWIN_PID, BUS_PID]);
    expect(await readdir(stateDirectory)).toEqual([]);
  });

  it("removes the private runtime directory the dead session made", async () => {
    const stateDirectory = await makeStateDirectory();
    const runtimeDirectory = join(stateDirectory, "runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    await writeNestedSessionMarker(marker({ runtimeDirectory }), { stateDirectory });

    await reapStaleNestedSessions(host({ stateDirectory }).dependencies);
    await expect(stat(runtimeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a session whose server is still running completely alone", async () => {
    const stateDirectory = await makeStateDirectory();
    await writeNestedSessionMarker(marker({ serverPid: 90_050 }), { stateDirectory });
    const fake = host({ stateDirectory, living: [90_050, KWIN_PID, BUS_PID] });

    await expect(reapStaleNestedSessions(fake.dependencies)).resolves.toEqual([]);
    expect(fake.torndown).toEqual([]);
    expect(await readdir(stateDirectory)).toHaveLength(1);
  });

  it("never reaps this server's own session", async () => {
    const stateDirectory = await makeStateDirectory();
    await writeNestedSessionMarker(marker({ serverPid: LIVE_SERVER_PID }), { stateDirectory });
    const fake = host({ stateDirectory, living: [KWIN_PID, BUS_PID] });

    await expect(reapStaleNestedSessions(fake.dependencies)).resolves.toEqual([]);
    expect(fake.torndown).toEqual([]);
  });

  it("refuses a pid whose argv no longer matches what was recorded", async () => {
    // The pid was reused. Reaping a stale desktop must never become killing
    // whatever now holds that number.
    const stateDirectory = await makeStateDirectory();
    await writeNestedSessionMarker(marker(), { stateDirectory });
    const fake = host({
      stateDirectory,
      commands: { [KWIN_PID]: "firefox", [BUS_PID]: BUS_COMMAND },
    });

    await reapStaleNestedSessions(fake.dependencies);
    expect(fake.torndown).toEqual([BUS_PID]);
  });

  it("refuses a pid whose start time no longer matches, even with the same argv", async () => {
    // A private bus daemon's argv is generic, so argv alone is coincidence.
    const stateDirectory = await makeStateDirectory();
    await writeNestedSessionMarker(marker(), { stateDirectory });
    const fake = host({
      stateDirectory,
      startTimes: { [KWIN_PID]: "5500", [BUS_PID]: "999999" },
    });

    await reapStaleNestedSessions(fake.dependencies);
    expect(fake.torndown).toEqual([KWIN_PID]);
  });

  it("skips a pid that is already gone", async () => {
    const stateDirectory = await makeStateDirectory();
    await writeNestedSessionMarker(marker(), { stateDirectory });
    const fake = host({ stateDirectory, living: [KWIN_PID] });

    await reapStaleNestedSessions(fake.dependencies);
    expect(fake.torndown).toEqual([KWIN_PID]);
    expect(await readdir(stateDirectory)).toEqual([]);
  });

  it("clears a corrupt marker instead of re-reading it on every boot", async () => {
    const stateDirectory = await makeStateDirectory();
    await writeFile(join(stateDirectory, "garbage.json"), "{ not json");

    await expect(reapStaleNestedSessions(host({ stateDirectory }).dependencies)).resolves.toEqual(
      [],
    );
    expect(await readdir(stateDirectory)).toEqual([]);
  });

  it("is silent on a host that has never run one", async () => {
    await expect(
      reapStaleNestedSessions({ stateDirectory: join(tmpdir(), "synara-nested-absent-dir") }),
    ).resolves.toEqual([]);
  });
});
