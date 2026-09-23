import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNestedSessionDirectory,
  nestedSessionStateDirectory,
  prepareNestedStateDirectory,
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
const SESSION_ID = "90001-0a1b2c3d";
const KWIN_COMMAND = "kwin_wayland --virtual --socket synara-nested-7";
const BUS_COMMAND =
  "dbus-daemon --config-file /run/user/1000/x/bus.conf --print-address=1 --nofork";

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
    serverStartTime: "4000",
    sessionId: SESSION_ID,
    startedAt: 1_700_000_000_000,
    waylandDisplay: "synara-nested-7",
    processes: [
      { pid: KWIN_PID, command: KWIN_COMMAND, startTime: "5500", role: "compositor" },
      { pid: BUS_PID, command: BUS_COMMAND, startTime: "5490", role: "bus" },
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
  readonly serverStartTime?: string;
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
      serverStartTime: options.serverStartTime ?? "7000",
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
  });

  it("falls back to the user's own cache, never the shared temp directory", () => {
    // Anyone can create a directory in /tmp first and fill it with markers.
    expect(nestedSessionStateDirectory({ XDG_CACHE_HOME: "/home/a/.cache", HOME: "/home/a" })).toBe(
      "/home/a/.cache/synara/synara-nested-sessions",
    );
    expect(nestedSessionStateDirectory({ HOME: "/home/a" })).toBe(
      "/home/a/.cache/synara/synara-nested-sessions",
    );
    expect(nestedSessionStateDirectory({ XDG_RUNTIME_DIR: "relative", HOME: "/home/a" })).toBe(
      "/home/a/.cache/synara/synara-nested-sessions",
    );
    expect(nestedSessionStateDirectory({})).toBeUndefined();
    expect(nestedSessionStateDirectory({ HOME: "relative" })).toBeUndefined();
  });
});

describe("prepareNestedStateDirectory", () => {
  it("creates a private directory", async () => {
    const stateDirectory = join(await makeStateDirectory(), "markers");
    await expect(prepareNestedStateDirectory({ stateDirectory })).resolves.toBe(stateDirectory);
    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
  });

  it("refuses a directory anyone else could have written markers into", async () => {
    const loose = await makeStateDirectory();
    await chmod(loose, 0o755);
    await expect(prepareNestedStateDirectory({ stateDirectory: loose })).rejects.toThrow(
      /has mode 755 instead of 700/,
    );

    const target = await makeStateDirectory();
    const link = join(await makeStateDirectory(), "link");
    await symlink(target, link);
    await expect(prepareNestedStateDirectory({ stateDirectory: link })).rejects.toThrow(
      /symbolic link/,
    );

    const foreign = await makeStateDirectory();
    await expect(
      prepareNestedStateDirectory({ stateDirectory: foreign, uid: 4_242 }),
    ).rejects.toThrow(/owned by uid/);
  });

  it("refuses to boot with nowhere private to put its sockets", async () => {
    await expect(prepareNestedStateDirectory({ hostEnv: {} })).rejects.toThrow(
      /needs a private directory/,
    );
  });

  it("never adopts a session directory that already exists", async () => {
    const stateDirectory = await makeStateDirectory();
    const created = await createNestedSessionDirectory(stateDirectory, SESSION_ID);
    expect(created).toBe(join(stateDirectory, SESSION_ID));
    expect((await stat(created)).mode & 0o777).toBe(0o700);
    await expect(createNestedSessionDirectory(stateDirectory, SESSION_ID)).rejects.toThrow();
    await expect(createNestedSessionDirectory(stateDirectory, "../escape")).rejects.toThrow(
      /Invalid nested session id/,
    );
  });
});

describe("writeNestedSessionMarker", () => {
  it("records the session where the next server will look for it", async () => {
    const stateDirectory = join(await makeStateDirectory(), "markers");
    const path = await writeNestedSessionMarker(marker(), { stateDirectory });

    expect(await readdir(stateDirectory)).toEqual([`${SESSION_ID}.json`]);
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

    await expect(reapStaleNestedSessions(fake.dependencies)).resolves.toEqual([SESSION_ID]);
    expect(fake.torndown).toEqual([KWIN_PID, BUS_PID]);
    expect(await readdir(stateDirectory)).toEqual([]);
  });

  it("removes the private runtime directory the dead session made", async () => {
    const stateDirectory = await makeStateDirectory();
    const runtimeDirectory = await createNestedSessionDirectory(stateDirectory, SESSION_ID);
    await writeNestedSessionMarker(marker({ runtimeDirectory }), { stateDirectory });

    await reapStaleNestedSessions(host({ stateDirectory }).dependencies);
    await expect(stat(runtimeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never deletes a directory the marker names outside its own session directory", async () => {
    // A marker is an instruction to rm -rf; only a path this module would
    // have created is honoured.
    const stateDirectory = await makeStateDirectory();
    const elsewhere = await makeStateDirectory();
    const sibling = join(stateDirectory, "90001-ffffffff");
    await mkdir(sibling);
    for (const runtimeDirectory of [elsewhere, sibling, join(stateDirectory, SESSION_ID, "..")]) {
      await writeNestedSessionMarker(marker({ runtimeDirectory }), { stateDirectory });
      await reapStaleNestedSessions(host({ stateDirectory }).dependencies);
    }
    await expect(stat(elsewhere)).resolves.toBeTruthy();
    await expect(stat(sibling)).resolves.toBeTruthy();
    await expect(stat(stateDirectory)).resolves.toBeTruthy();
  });

  it("sweeps nothing from a directory that is not private", async () => {
    const stateDirectory = await makeStateDirectory();
    await writeNestedSessionMarker(marker(), { stateDirectory });
    await chmod(stateDirectory, 0o777);
    const fake = host({ stateDirectory });

    await expect(reapStaleNestedSessions(fake.dependencies)).resolves.toEqual([]);
    expect(fake.torndown).toEqual([]);
    await chmod(stateDirectory, 0o700);
  });

  it("only signals the executable a helper role names", async () => {
    // Argv and start time can both be copied into a marker; the executable a
    // role names is the last check before a signal.
    const stateDirectory = await makeStateDirectory();
    await writeNestedSessionMarker(
      marker({
        processes: [
          { pid: KWIN_PID, command: "firefox --new-window", startTime: "5500", role: "compositor" },
          { pid: BUS_PID, command: BUS_COMMAND, startTime: "5490", role: "bus" },
        ],
      }),
      { stateDirectory },
    );
    const fake = host({
      stateDirectory,
      commands: { [KWIN_PID]: "firefox --new-window", [BUS_PID]: BUS_COMMAND },
    });

    await reapStaleNestedSessions(fake.dependencies);
    expect(fake.torndown).toEqual([BUS_PID]);
  });

  it("ends the accessibility bus and registry a killed server left running", async () => {
    const stateDirectory = await makeStateDirectory();
    const launcher = "/usr/lib/at-spi-bus-launcher --launch-immediately";
    const registry = "/usr/lib/at-spi2-registryd";
    await writeNestedSessionMarker(
      marker({
        processes: [
          { pid: KWIN_PID, command: KWIN_COMMAND, startTime: "5500", role: "compositor" },
          { pid: 4101, command: launcher, startTime: "5510", role: "accessibility" },
          { pid: 4102, command: registry, startTime: "5520", role: "accessibility-registry" },
          // A registry recorded under the launcher's role is not the launcher.
          { pid: 4103, command: registry, startTime: "5530", role: "accessibility" },
        ],
      }),
      { stateDirectory },
    );
    const fake = host({
      stateDirectory,
      living: [KWIN_PID, 4101, 4102, 4103],
      commands: { [KWIN_PID]: KWIN_COMMAND, 4101: launcher, 4102: registry, 4103: registry },
      startTimes: { [KWIN_PID]: "5500", 4101: "5510", 4102: "5520", 4103: "5530" },
    });

    await reapStaleNestedSessions(fake.dependencies);
    expect(fake.torndown.toSorted()).toEqual([KWIN_PID, 4101, 4102].toSorted());
  });

  it("ends an app the dead server recorded launching", async () => {
    const stateDirectory = await makeStateDirectory();
    const appPid = 91_003;
    await writeNestedSessionMarker(
      marker({
        processes: [{ pid: appPid, command: "kcalc", startTime: "5600", role: "app" }],
      }),
      { stateDirectory },
    );
    const fake = host({
      stateDirectory,
      living: [appPid],
      commands: { [appPid]: "kcalc" },
      startTimes: { [appPid]: "5600" },
    });

    await reapStaleNestedSessions(fake.dependencies);
    expect(fake.torndown).toEqual([appPid]);
  });

  it("signals nothing recorded without a start time", async () => {
    const stateDirectory = await makeStateDirectory();
    await writeFile(
      join(stateDirectory, `${SESSION_ID}.json`),
      JSON.stringify({
        serverPid: DEAD_SERVER_PID,
        processes: [{ pid: KWIN_PID, command: KWIN_COMMAND, role: "compositor" }],
      }),
      { mode: 0o600 },
    );
    const fake = host({ stateDirectory });

    await reapStaleNestedSessions(fake.dependencies);
    expect(fake.torndown).toEqual([]);
  });

  it("reaps a session whose server pid was reused by another process", async () => {
    // The dead server's pid now belongs to something else: same number,
    // different start time.
    const stateDirectory = await makeStateDirectory();
    await writeNestedSessionMarker(marker({ serverPid: 90_050 }), { stateDirectory });
    const fake = host({
      stateDirectory,
      living: [90_050, KWIN_PID, BUS_PID],
      startTimes: { 90_050: "99999", [KWIN_PID]: "5500", [BUS_PID]: "5490" },
    });

    await expect(reapStaleNestedSessions(fake.dependencies)).resolves.toEqual([SESSION_ID]);
    expect(fake.torndown).toEqual([KWIN_PID, BUS_PID]);
  });

  it("reaps a session a previous process with this server's own pid left behind", async () => {
    // A container restart hands the new server the old one's pid.
    const stateDirectory = await makeStateDirectory();
    await writeNestedSessionMarker(marker({ serverPid: LIVE_SERVER_PID, serverStartTime: "10" }), {
      stateDirectory,
    });
    const fake = host({ stateDirectory, serverStartTime: "7000" });

    await expect(reapStaleNestedSessions(fake.dependencies)).resolves.toEqual([SESSION_ID]);
    expect(fake.torndown).toEqual([KWIN_PID, BUS_PID]);
  });

  it("leaves a session whose server is still running completely alone", async () => {
    const stateDirectory = await makeStateDirectory();
    await writeNestedSessionMarker(marker({ serverPid: 90_050 }), { stateDirectory });
    const fake = host({
      stateDirectory,
      living: [90_050, KWIN_PID, BUS_PID],
      startTimes: { 90_050: "4000", [KWIN_PID]: "5500", [BUS_PID]: "5490" },
    });

    await expect(reapStaleNestedSessions(fake.dependencies)).resolves.toEqual([]);
    expect(fake.torndown).toEqual([]);
    expect(await readdir(stateDirectory)).toHaveLength(1);
  });

  it("never reaps this server's own session", async () => {
    const stateDirectory = await makeStateDirectory();
    await writeNestedSessionMarker(
      marker({ serverPid: LIVE_SERVER_PID, serverStartTime: "7000" }),
      {
        stateDirectory,
      },
    );
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
    await writeFile(join(stateDirectory, `${SESSION_ID}.json`), "{ not json");
    await writeFile(join(stateDirectory, "garbage.json"), "{}");

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
