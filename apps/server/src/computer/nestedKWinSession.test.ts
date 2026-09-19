import { EventEmitter } from "node:events";
import { readdir, rm, stat } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { ComputerBackendError } from "./ComputerBackend.ts";
import { resolveSynaraPluginLoad } from "./KWinComputerBackend.ts";
import type { KWinComputerDbus, KWinComputerPluginApi } from "./kwinDbus.ts";
import {
  NestedPluginLoadRefusedError,
  nestedAtspiMode,
  nestedKWinBackendOptions,
  nestedModeLabel,
  nestedSessionEnv,
  nestedSessionMode,
  parseNestedSizeEnv,
  startNestedKWinSession,
  unavailableAtspiReader,
  type NestedKWinSession,
  type NestedKWinSessionOptions,
} from "./nestedKWinSession.ts";

const BUS_ADDRESS = "unix:path=/tmp/synara-nested-test,guid=abc";
/** What the backend hands a launch: already scrubbed, with the user's home. */
const SPAWN_OPTIONS = { env: { PATH: "/usr/bin" }, cwd: "/home/agent" };

describe("nested session geometry", () => {
  it("reads WxH and rejects anything else", () => {
    expect(parseNestedSizeEnv("1280x800")).toEqual({ width: 1_280, height: 800 });
    expect(parseNestedSizeEnv("  1920X1080  ")).toEqual({ width: 1_920, height: 1_080 });
    expect(parseNestedSizeEnv(undefined)).toBeUndefined();
    expect(parseNestedSizeEnv("")).toBeUndefined();
    expect(parseNestedSizeEnv("1280*800")).toBeUndefined();
    expect(parseNestedSizeEnv("1280x")).toBeUndefined();
    expect(parseNestedSizeEnv("-1280x800")).toBeUndefined();
    expect(parseNestedSizeEnv("1280.5x800")).toBeUndefined();
  });

  it("drops a size outside the supported range rather than booting one", () => {
    expect(parseNestedSizeEnv("32x32")).toBeUndefined();
    expect(parseNestedSizeEnv("40000x1080")).toBeUndefined();
    expect(parseNestedSizeEnv("64x64")).toEqual({ width: 64, height: 64 });
  });
});

describe("nested session environment", () => {
  it("points a child at the nested compositor and bus", () => {
    expect(
      nestedSessionEnv({ busAddress: BUS_ADDRESS, waylandDisplay: "synara-nested-1" }),
    ).toEqual({
      WAYLAND_DISPLAY: "synara-nested-1",
      DBUS_SESSION_BUS_ADDRESS: BUS_ADDRESS,
      DISPLAY: "",
      QT_QPA_PLATFORM: "wayland",
    });
  });

  it("points an X11 child at the nested Xwayland rather than the human's display", () => {
    expect(
      nestedSessionEnv({
        busAddress: BUS_ADDRESS,
        waylandDisplay: "synara-nested-1",
        xDisplay: ":9",
      }),
    ).toMatchObject({ DISPLAY: ":9" });
    // Emptied rather than left out: the child inherits the server's environment
    // underneath this one, so omitting the key would leave the human's display
    // in place and open an X11 client on their screen.
    expect(
      nestedSessionEnv({ busAddress: BUS_ADDRESS, waylandDisplay: "synara-nested-1" }),
    ).toMatchObject({ DISPLAY: "" });
  });

  it("is opt-in through the environment, which also names the mode", () => {
    expect(nestedSessionMode({})).toBeUndefined();
    expect(nestedSessionMode({ SYNARA_COMPUTER_NESTED: "" })).toBeUndefined();
    expect(nestedSessionMode({ SYNARA_COMPUTER_NESTED: "0" })).toBeUndefined();
    expect(nestedSessionMode({ SYNARA_COMPUTER_NESTED: "true" })).toBeUndefined();
    expect(nestedSessionMode({ SYNARA_COMPUTER_NESTED: "windowed" })).toBeUndefined();
    expect(nestedSessionMode({ SYNARA_COMPUTER_NESTED: "1" })).toBe("virtual");
    expect(nestedSessionMode({ SYNARA_COMPUTER_NESTED: "window" })).toBe("window");
    expect(nestedModeLabel("virtual")).toBe("virtual");
    expect(nestedModeLabel("window")).toBe("windowed");
    expect(nestedAtspiMode({})).toBe("off");
    expect(nestedAtspiMode({ SYNARA_COMPUTER_NESTED_ATSPI: "1" })).toBe("session");
  });

  it("binds a backend to the nested bus without semantic perception by default", async () => {
    const session: NestedKWinSession = {
      busAddress: BUS_ADDRESS,
      waylandDisplay: "synara-nested-1",
      size: { width: 1_920, height: 1_080 },
      pluginId: "SynaraComputerUsePluginV3",
      xDisplay: undefined,
      exited: () => undefined,
      spawnApp: () => {
        throw new Error("not launched in this test");
      },
      dispose: async () => undefined,
    };
    const options = nestedKWinBackendOptions(() => session);
    expect(options.busAddress).toBe(BUS_ADDRESS);
    expect(options.sessionType).toBe("wayland");
    expect(options.visibleDesktop).toBe(false);
    await expect(options.atspi?.readTrees([])).resolves.toEqual([]);
    await expect(unavailableAtspiReader().setText({} as never)).resolves.toBe(false);
  });

  it("calls a windowed nested desktop visible, because it is a window on this one", () => {
    // The headless compositor has no output at all, so the Computer pane is the
    // only view onto it; the windowed one is an ordinary window of the host
    // session and the human can see exactly what the agent is doing.
    expect(nestedKWinBackendOptions(() => undefined, { mode: "window" }).visibleDesktop).toBe(true);
    expect(nestedKWinBackendOptions(() => undefined, { mode: "virtual" }).visibleDesktop).toBe(
      false,
    );
    expect(nestedKWinBackendOptions(() => undefined).visibleDesktop).toBe(false);
  });

  it("resolves the session on every use, so a replacement is never driven through a dead bus", async () => {
    // The backend that owns these options is built before any session exists
    // and outlives each one it boots.
    let session: NestedKWinSession | undefined;
    const options = nestedKWinBackendOptions(() => session);
    expect(options.busAddress).toBeUndefined();
    expect(() => options.spawnProcess?.("kcalc", [], SPAWN_OPTIONS)).toThrow(
      /isolated desktop is not running/,
    );

    const launches: string[] = [];
    session = {
      busAddress: BUS_ADDRESS,
      waylandDisplay: "synara-nested-1",
      size: { width: 1_920, height: 1_080 },
      pluginId: "SynaraComputerUsePluginV3",
      xDisplay: undefined,
      exited: () => undefined,
      spawnApp: (app) => {
        launches.push(app);
        return {} as unknown as ReturnType<NestedKWinSession["spawnApp"]>;
      },
      dispose: async () => undefined,
    };
    options.spawnProcess?.("kcalc", [], SPAWN_OPTIONS);
    expect(launches).toEqual(["kcalc"]);
  });
});

describe("nested plugin shadowing", () => {
  it("unloads every loaded Synara plugin, the newest included, then loads the newest installed", () => {
    expect(
      resolveSynaraPluginLoad({
        loaded: [
          "kwin4_effect_something",
          "SynaraComputerUsePlugin",
          "SynaraComputerUsePluginV2",
          "SynaraComputerUsePluginV3",
        ],
        installed: ["SynaraComputerUsePluginV2", "SynaraComputerUsePluginV3"],
      }),
    ).toEqual({
      kind: "replace",
      unload: ["SynaraComputerUsePlugin", "SynaraComputerUsePluginV2", "SynaraComputerUsePluginV3"],
      pluginId: "SynaraComputerUsePluginV3",
    });
  });

  it("unloads nothing when the compositor auto-loaded nothing", () => {
    expect(
      resolveSynaraPluginLoad({ loaded: [], installed: ["SynaraComputerUsePluginV10"] }),
    ).toEqual({ kind: "replace", unload: [], pluginId: "SynaraComputerUsePluginV10" });
  });

  it("keeps a sole loaded plugin even when the disk scan finds nothing", () => {
    // A long-lived compositor can outlive the .so files it loaded from; the
    // loaded plugin is still serving and is strictly better than erroring.
    expect(
      resolveSynaraPluginLoad({ loaded: ["SynaraComputerUsePluginV3"], installed: [] }),
    ).toEqual({ kind: "keep", pluginId: "SynaraComputerUsePluginV3" });
  });

  it("has no plan when no Synara plugin exists anywhere", () => {
    expect(resolveSynaraPluginLoad({ loaded: ["kwin4_effect_something"], installed: [] })).toBe(
      undefined,
    );
  });
});

describe("startNestedKWinSession", () => {
  it("boots the bus and compositor, leaves one plugin loaded, and kills both on dispose", async () => {
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(harness.options({ socketName: "synara-test-1" }));

    expect(session.busAddress).toBe(BUS_ADDRESS);
    expect(session.waylandDisplay).toBe("synara-test-1");
    expect(session.pluginId).toBe("SynaraComputerUsePluginV3");
    expect(harness.spawns[0]?.command).toBe("dbus-daemon");
    expect(harness.spawns[0]?.args).toEqual(["--session", "--print-address=1", "--nofork"]);
    expect(harness.spawns[1]?.command).toBe("kwin_wayland");
    expect(harness.spawns[1]?.args).toEqual([
      "--virtual",
      "--xwayland",
      "--no-global-shortcuts",
      "--socket",
      "synara-test-1",
      "--width",
      "1920",
      "--height",
      "1080",
    ]);
    expect(harness.spawns[1]?.env.DBUS_SESSION_BUS_ADDRESS).toBe(BUS_ADDRESS);
    expect(harness.spawns[1]?.env.WAYLAND_DISPLAY).toBeUndefined();
    expect(harness.dbus.calls).toEqual([
      // The service owner is pinned across the LoadPlugin boundary, before and
      // after the load.
      "nameOwner:org.synara.ComputerUse",
      "connectPlugin",
      "listLoadedPluginIds",
      "unloadPlugin:SynaraComputerUsePlugin",
      "unloadPlugin:SynaraComputerUsePluginV3",
      "loadPlugin:SynaraComputerUsePluginV3",
      "nameOwner:org.synara.ComputerUse",
      "connectPlugin",
      "connectPlugin",
      "close",
    ]);
    // Only the plugin inside the compositor knows which display KWin gave the
    // Xwayland it started, and an X11 client cannot be launched here without it.
    expect(session.xDisplay).toBe(":9");

    await session.dispose();
    // Newest first, and by process tree rather than by root pid: kwin_wayland
    // forks an Xwayland that nothing else would ever reap.
    expect(harness.tornDown).toEqual([harness.spawns[1]?.child.pid, harness.spawns[0]?.child.pid]);
  });

  it("reports through exited() when either of its processes ends", async () => {
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(harness.options());
    expect(session.exited()).toBeUndefined();

    // The compositor is the process a human can end by closing the nested
    // window, and a clean exit is exactly what that looks like.
    harness.spawns[1]?.child.end(null, 0);
    expect(session.exited()).toBe("exit code 0, signal null");
    await session.dispose();

    const busHarness = new NestedHarness();
    const busSession = await startNestedKWinSession(busHarness.options());
    busHarness.spawns[0]?.child.end(null, 1);
    expect(busSession.exited()).toBe("exit code 1, signal null");
    await busSession.dispose();
  });

  it("keeps a virtual compositor off the host display", async () => {
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(
      harness.options({
        hostEnv: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", QT_QPA_PLATFORMTHEME: "gtk3" },
      }),
    );
    expect(harness.spawns[1]?.args[0]).toBe("--virtual");
    expect(harness.spawns[1]?.env.WAYLAND_DISPLAY).toBeUndefined();
    expect(harness.spawns[1]?.env.DISPLAY).toBeUndefined();
    expect(harness.spawns[1]?.env.QT_QPA_PLATFORMTHEME).toBeUndefined();
    const runtime = session.runtimeDirectory!;
    expect((await stat(runtime)).mode & 0o777).toBe(0o700);
    expect(harness.spawns[1]?.env.XDG_RUNTIME_DIR).toBe(runtime);
    expect(nestedSessionEnv(session).XDG_RUNTIME_DIR).toBe(runtime);
    await session.dispose();
    await expect(stat(runtime)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("nests a windowed compositor into the host display and drops --virtual", async () => {
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(
      harness.options({
        mode: "window",
        socketName: "synara-test-2",
        hostEnv: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      }),
    );

    expect(harness.spawns[1]?.args).toEqual([
      "--xwayland",
      "--no-global-shortcuts",
      "--socket",
      "synara-test-2",
      "--width",
      "1920",
      "--height",
      "1080",
    ]);
    expect(harness.spawns[1]?.env.WAYLAND_DISPLAY).toBe("wayland-0");
    expect(harness.spawns[1]?.env.DISPLAY).toBeUndefined();
    expect(harness.spawns[1]?.env.DBUS_SESSION_BUS_ADDRESS).toBe(BUS_ADDRESS);

    await session.dispose();
  });

  it("refuses a windowed session with no host display rather than going virtual", async () => {
    const harness = new NestedHarness();
    await expect(
      startNestedKWinSession(harness.options({ mode: "window", hostEnv: {} })),
    ).rejects.toThrow(/windowed nested session needs a running Wayland session/);
    expect(harness.spawns).toEqual([]);
  });

  it("names the mode that was booting when the compositor never appeared", async () => {
    const harness = new NestedHarness({ nameAppears: false });
    await expect(
      startNestedKWinSession(
        harness.options({
          mode: "window",
          hostEnv: { WAYLAND_DISPLAY: "wayland-0" },
          readyTimeoutMs: 25,
        }),
      ),
    ).rejects.toThrow(/kwin_wayland \(windowed mode\) did not take org\.kde\.KWin/);
  });

  it("passes the requested geometry to the compositor", async () => {
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(
      harness.options({ size: { width: 1_280, height: 800 } }),
    );
    expect(harness.spawns[1]?.args.slice(-4)).toEqual(["--width", "1280", "--height", "800"]);
    await session.dispose();
  });

  it("names a missing binary and kills what did start", async () => {
    const harness = new NestedHarness({
      spawnFailure: { command: "kwin_wayland", message: "spawn kwin_wayland ENOENT" },
    });
    await expect(startNestedKWinSession(harness.options())).rejects.toThrow(
      /kwin_wayland could not be started: spawn kwin_wayland ENOENT/,
    );
    expect(harness.spawns.map((spawn) => spawn.child.signal)).toEqual(["SIGTERM"]);
  });

  it("reports a compositor that exits before it is ready, with its own output", async () => {
    const harness = new NestedHarness({ kwinFailure: "could not open drm device\n" });
    await expect(startNestedKWinSession(harness.options())).rejects.toThrow(
      /exited before it was ready \(exit code 1, signal null\)\. Last kwin_wayland output: could not open drm device/,
    );
  });

  it("reports a compositor that never takes the KWin name", async () => {
    const harness = new NestedHarness({ nameAppears: false });
    await expect(startNestedKWinSession(harness.options({ readyTimeoutMs: 25 }))).rejects.toThrow(
      /did not take org\.kde\.KWin within 25 ms/,
    );
    expect(harness.tornDown).toEqual([harness.spawns[1]?.child.pid, harness.spawns[0]?.child.pid]);
  });

  it("reports an uninstalled plugin as the reason and tears the session down", async () => {
    // A compositor with nothing on disk auto-loads nothing either; a loaded
    // plugin with no file behind it would now be kept rather than refused.
    const harness = new NestedHarness({ installed: [], loaded: [] });
    await expect(startNestedKWinSession(harness.options())).rejects.toBeInstanceOf(
      ComputerBackendError,
    );
    await expect(startNestedKWinSession(harness.options())).rejects.toThrow(
      /No installed SynaraComputerUsePluginVn was found for the nested KWin session/,
    );
    expect(harness.dbus.closed).toBe(true);
  });

  it("reports a refused plugin load as its own error, not a message to parse", async () => {
    const harness = new NestedHarness({ loadAccepted: false });
    const refusal = await startNestedKWinSession(harness.options()).catch(
      (error: unknown) => error,
    );
    // The one boot failure a reinstall can fix, so the caller has to be able to
    // recognise it without reading English.
    expect(refusal).toBeInstanceOf(NestedPluginLoadRefusedError);
    expect((refusal as NestedPluginLoadRefusedError).pluginId).toBe("SynaraComputerUsePluginV3");
  });
});

describe("a session that loses one of its own processes", () => {
  it("ends the bus with the compositor, so clients really do see a disconnect", async () => {
    // The self-heal the whole reconnect path hangs off. The private bus outlives
    // kwin_wayland by default, so every D-Bus client keeps a connection that is
    // open and useless: nothing fires, nothing invalidates, and the next action
    // fails with NameHasNoOwner instead of the backend reporting a dead desktop.
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(harness.options());
    const [bus, kwin] = harness.spawns;
    expect(harness.tornDown).toEqual([]);

    kwin?.child.end(null, 1);
    await settle();

    expect(session.exited()).toBe("exit code 1, signal null");
    expect(harness.tornDown).toContain(bus?.child.pid);
  });

  it("ends the compositor when the bus dies, and keeps the first reason", async () => {
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(harness.options());
    const [bus, kwin] = harness.spawns;

    bus?.child.end(null, 7);
    await settle();

    // Not "signal SIGTERM": that is this module's own teardown answering.
    expect(session.exited()).toBe("exit code 7, signal null");
    expect(harness.tornDown).toContain(kwin?.child.pid);
  });

  it("removes its marker, so the next server does not try to reap a dead session", async () => {
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(harness.options());
    expect(await harness.markers()).toHaveLength(1);

    harness.spawns[1]?.child.end(null, 1);
    await settle();
    await session.dispose();

    expect(await harness.markers()).toEqual([]);
  });
});

describe("launching applications into a session", () => {
  it("keeps them as children and ends them with the desktop", async () => {
    // A detached app is a process group of its own that outlives the desktop it
    // was launched into, with nothing left that knows its pid.
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(harness.options());
    const app = session.spawnApp("kcalc", ["--foo"]);

    expect(harness.apps[0]?.command).toBe("kcalc");
    expect(harness.apps[0]?.args).toEqual(["--foo"]);
    await session.dispose();

    expect(harness.tornDown[0]).toBe((app as unknown as FakeChild).pid);
  });

  it("hands an agent-chosen executable a scrubbed environment", async () => {
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(harness.options());
    process.env.SYNARA_NESTED_TEST_SECRET = "must not leak";
    try {
      session.spawnApp("kcalc", []);
    } finally {
      delete process.env.SYNARA_NESTED_TEST_SECRET;
    }

    const env = harness.apps[0]?.env ?? {};
    expect(env.SYNARA_NESTED_TEST_SECRET).toBeUndefined();
    // Still pointed at the nested session rather than the human's.
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(BUS_ADDRESS);
    expect(env.WAYLAND_DISPLAY).toBe(session.waylandDisplay);
    await session.dispose();
  });

  it("forgets an app that exited on its own", async () => {
    const harness = new NestedHarness();
    const session = await startNestedKWinSession(harness.options());
    const app = session.spawnApp("kcalc", []) as unknown as FakeChild;
    app.end(null, 0);
    await settle();
    await session.dispose();

    expect(harness.tornDown).not.toContain(app.pid);
  });
});

/** Lets the session's own exit listeners and teardown run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

interface FakeSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly child: FakeChild;
}

const stateDirectories: string[] = [];

afterEach(async () => {
  while (stateDirectories.length > 0) {
    const directory = stateDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

let nextFakePid = 4_000_000;

/** A child process that records the signal it was sent instead of dying. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** As a real child has it: the same streams, indexed by fd, with stdin ignored. */
  readonly stdio = [null, this.stdout, this.stderr];
  /** A pid the process-tree teardown can target; never a real one. */
  readonly pid = (nextFakePid += 1);
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signal: string | undefined;
  killed = false;

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.end(signal ?? "SIGTERM");
    return true;
  }

  /** The process ending, as Node reports it. */
  end(signal: NodeJS.Signals | null, code: number | null = null): void {
    this.signal ??= signal ?? undefined;
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  unref(): void {}
}

class FakeDbus implements KWinComputerDbus {
  readonly calls: string[] = [];
  closed = false;
  /** The unique name owning the Synara service once a load is accepted. */
  serviceOwner: string | undefined;

  constructor(
    private readonly loaded: readonly string[],
    private readonly loadAccepted: boolean,
  ) {}

  nameOwner = async (name: string) => {
    this.calls.push(`nameOwner:${name}`);
    if (this.serviceOwner !== undefined) return this.serviceOwner;
    return this.loaded.some((id) => id.startsWith("SynaraComputerUsePlugin")) ? ":1.42" : undefined;
  };
  listLoadedPluginIds = async () => {
    this.calls.push("listLoadedPluginIds");
    return this.loaded;
  };
  loadPlugin = async (pluginId: string) => {
    this.calls.push(`loadPlugin:${pluginId}`);
    if (this.loadAccepted && pluginId.startsWith("SynaraComputerUsePlugin")) {
      this.serviceOwner = ":1.43";
    }
    return this.loadAccepted;
  };
  unloadPlugin = async (pluginId: string) => {
    this.calls.push(`unloadPlugin:${pluginId}`);
    return true;
  };
  xDisplay: string | undefined = ":9";
  connectPlugin = async () => {
    this.calls.push("connectPlugin");
    return {
      healthJson: async () =>
        JSON.stringify({ ok: true, ...(this.xDisplay ? { xDisplay: this.xDisplay } : {}) }),
    } as KWinComputerPluginApi;
  };
  onDisconnect = () => () => undefined;
  close = async () => {
    this.calls.push("close");
    this.closed = true;
  };
}

interface NestedHarnessOptions {
  readonly installed?: readonly string[];
  readonly loaded?: readonly string[];
  readonly loadAccepted?: boolean;
  readonly nameAppears?: boolean;
  /** Compositor stderr, followed by a non-zero exit. */
  readonly kwinFailure?: string;
  readonly spawnFailure?: { readonly command: string; readonly message: string };
}

/** Drives startNestedKWinSession with no processes and no bus. */
class NestedHarness {
  readonly spawns: FakeSpawn[] = [];
  /** Applications launched into the session, in order. */
  readonly apps: FakeSpawn[] = [];
  /** Process trees the teardown was asked to end, in order. */
  readonly tornDown: number[] = [];
  readonly dbus: FakeDbus;
  /** A private marker directory, so no test ever reads a real host's. */
  private stateDirectoryPath: string | undefined;

  constructor(private readonly harnessOptions: NestedHarnessOptions = {}) {
    this.dbus = new FakeDbus(
      harnessOptions.loaded ?? ["SynaraComputerUsePlugin", "SynaraComputerUsePluginV3"],
      harnessOptions.loadAccepted ?? true,
    );
  }

  /** Markers currently on disk for this harness. */
  async markers(): Promise<string[]> {
    if (!this.stateDirectoryPath) return [];
    return await readdir(this.stateDirectoryPath).catch(() => [] as string[]);
  }

  options(overrides: NestedKWinSessionOptions = {}): NestedKWinSessionOptions {
    return {
      spawnProcess: (command, args, env) => this.spawn(command, args, env),
      spawnApplication: (command, args, env) => {
        const child = new FakeChild();
        this.apps.push({ command, args, env, child });
        return child as unknown as ChildProcess;
      },
      registry: {
        stateDirectory: this.stateDirectory(),
        // Nothing in this suite may consult, or act on, a real process table.
        processAlive: () => false,
        processCommand: () => undefined,
        processStartTime: () => undefined,
      },
      teardownProcessTree: async (input) => {
        this.tornDown.push(input.rootPid);
        for (const spawned of [...this.spawns, ...this.apps]) {
          if (spawned.child.pid === input.rootPid) spawned.child.end("SIGTERM");
        }
        return { escalated: false, signalErrors: [] };
      },
      installedPluginIds: async () =>
        this.harnessOptions.installed ?? ["SynaraComputerUsePluginV2", "SynaraComputerUsePluginV3"],
      connectDbus: async () => this.dbus,
      waitForBusName: async (waitOptions) => {
        // The real wait polls, so it always gives a compositor that is dying a
        // chance to be noticed before it reports the name.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (waitOptions.abort?.() === true) return false;
        return this.harnessOptions.nameAppears ?? true;
      },
      ...overrides,
    };
  }

  private stateDirectory(): string {
    this.stateDirectoryPath ??= mkdtempSyncTracked();
    return this.stateDirectoryPath;
  }

  private spawn(command: string, args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
    if (this.harnessOptions.spawnFailure?.command === command) {
      throw new Error(this.harnessOptions.spawnFailure.message);
    }
    const child = new FakeChild();
    this.spawns.push({ command, args, env, child });
    if (command === "dbus-daemon") {
      queueMicrotask(() => child.stdout.write(`${BUS_ADDRESS}\n`));
    } else if (this.harnessOptions.kwinFailure !== undefined) {
      queueMicrotask(() => {
        child.stderr.write(this.harnessOptions.kwinFailure!);
        queueMicrotask(() => child.end(null, 1));
      });
    }
    return child as unknown as ChildProcess;
  }
}

/** A throwaway marker directory, removed after each test. */
function mkdtempSyncTracked(): string {
  const directory = mkdtempSync(join(tmpdir(), "synara-nested-session-test-"));
  stateDirectories.push(directory);
  return directory;
}
