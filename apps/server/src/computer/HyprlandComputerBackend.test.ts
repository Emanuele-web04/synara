import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HyprlandComputerBackend,
  type HyprlandComputerBackendOptions,
} from "./HyprlandComputerBackend.ts";
import { COMPUTER_SERVICE, type KWinComputerPluginApi } from "./kwinDbus.ts";
import type { HyprlandComputerDbus } from "./hyprlandPluginHost.ts";
import { SESSION_LOCKED_REFUSAL } from "./KWinComputerBackend.ts";
import { dbusError, FakeDbus } from "./computerPluginTestDoubles.ts";

const temp = () => mkdtemp(join(tmpdir(), "synara-hypr-backend-"));

/** Just enough plugin for the start-free health gate `availability()` runs. */
const fakePlugin = {
  healthJson: async () => JSON.stringify({ ok: true, running: false, capture: true }),
  stop: async () => true,
} as unknown as KWinComputerPluginApi;

function fakeDbus(
  overrides: Partial<HyprlandComputerDbus> = {},
): HyprlandComputerDbus & { readonly loads: string[] } {
  const loads: string[] = [];
  return {
    loads,
    // The service is owned once something loaded the plugin, the same shape as
    // the KWin fake: the owner check after a load has to find a unique name.
    nameOwner: async () => (loads.length > 0 ? ":1.42" : undefined),
    listLoadedPluginIds: async () => [],
    loadPlugin: async (pluginId: string) => {
      loads.push(pluginId);
      return true;
    },
    unloadPlugin: async () => false,
    connectPlugin: async () => fakePlugin,
    onDisconnect: () => () => undefined,
    close: async () => undefined,
    lastLoadRefusal: () => undefined,
    ...overrides,
  };
}

/** Every host probe stubbed inert, so no test asks the developer's machine. */
async function makeBackend(
  options: Partial<HyprlandComputerBackendOptions> = {},
): Promise<HyprlandComputerBackend> {
  const dir = await temp();
  return new HyprlandComputerBackend({
    platform: "linux",
    resolveInstance: async () => "test-instance",
    pluginDirectory: join(dir, "plugins"),
    installStampPath: join(dir, "install.stamp"),
    runHyprctl: async (args) => {
      throw new Error(`no hyprctl in tests: ${args.join(" ")}`);
    },
    busNameHasOwner: async () => false,
    buildToolingPresent: () => false,
    headersVersion: async () => undefined,
    provisionPlugin: async () => {
      throw new Error("provisioning must not run in this test");
    },
    dbusFactory: async () => fakeDbus(),
    atspi: {
      readTrees: async () => [],
      setText: async () => false,
      dispose: async () => undefined,
    },
    ...options,
  });
}

async function installedPluginDirectory(...names: readonly string[]): Promise<string> {
  const directory = join(await temp(), "plugins");
  await mkdir(directory, { recursive: true });
  for (const name of names) await writeFile(join(directory, name), "so bytes");
  return directory;
}

describe("HyprlandComputerBackend passive probe", () => {
  it("reports the platform and a missing session without asking further", async () => {
    const notLinux = await makeBackend({ platform: "darwin" });
    await expect(notLinux.probeAvailability()).resolves.toEqual({
      kind: "unsupported-platform",
      platform: "darwin",
    });

    const noSession = await makeBackend({
      resolveInstance: async () => undefined,
      busNameHasOwner: async () => {
        throw new Error("the bus probe must not run without a session");
      },
    });
    await expect(noSession.probeAvailability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("No Hyprland session"),
    });

    await Promise.all([notLinux.dispose(), noSession.dispose()]);
  });

  it("is available when the plugin is already answering on the bus", async () => {
    const backend = await makeBackend({
      busNameHasOwner: async (name) => name === COMPUTER_SERVICE,
    });

    await expect(backend.probeAvailability()).resolves.toEqual({
      kind: "available",
      backend: "hyprland",
    });
    await backend.dispose();
  });

  it("is available from an installed plugin file alone", async () => {
    const backend = await makeBackend({
      pluginDirectory: await installedPluginDirectory("SynaraComputerUsePluginV2.so"),
    });

    await expect(backend.probeAvailability()).resolves.toMatchObject({ kind: "available" });
    await backend.dispose();
  });

  it("is available when this machine could build the plugin itself", async () => {
    const backend = await makeBackend({ buildToolingPresent: () => true });
    await expect(backend.probeAvailability()).resolves.toMatchObject({ kind: "available" });
    await backend.dispose();
  });

  it("refuses with the install pointer when no plugin exists and none could be made", async () => {
    const backend = await makeBackend();
    await expect(backend.probeAvailability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("install-and-load.sh"),
    });
    await backend.dispose();
  });
});

describe("HyprlandComputerBackend instance selection", () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  /** A live instance socket where Hyprland would put one. */
  async function liveInstance(signature: string): Promise<string> {
    const runtimeDir = await temp();
    const directory = join(runtimeDir, "hypr", signature);
    await mkdir(directory, { recursive: true });
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(join(directory, ".socket.sock"), resolve));
    closers.push(() => server.close());
    return runtimeDir;
  }

  it("drives the instance the override names, not the one it inherited", async () => {
    // Dev-testing against a nested Hyprland is an environment variable, and
    // the liveness check has to follow it: reading the inherited signature
    // would report "no Hyprland session" on a host whose own compositor is
    // dead, or worse, report the human's while every call went elsewhere.
    const runtimeDir = await liveInstance("nested");
    const backend = new HyprlandComputerBackend({
      platform: "linux",
      env: {
        HYPRLAND_INSTANCE_SIGNATURE: "the-humans-dead-session",
        SYNARA_HYPRLAND_INSTANCE_SIGNATURE: "nested",
        XDG_RUNTIME_DIR: runtimeDir,
      },
      pluginDirectory: await installedPluginDirectory("SynaraComputerUsePluginV1.so"),
      busNameHasOwner: async () => false,
      buildToolingPresent: () => false,
      dbusFactory: async () => fakeDbus(),
      atspi: {
        readTrees: async () => [],
        setText: async () => false,
        dispose: async () => undefined,
      },
    });

    await expect(backend.probeAvailability()).resolves.toEqual({
      kind: "available",
      backend: "hyprland",
    });
    await backend.dispose();
  });

  it("refuses when the named instance has no live socket", async () => {
    const runtimeDir = await liveInstance("nested");
    const backend = new HyprlandComputerBackend({
      platform: "linux",
      env: { HYPRLAND_INSTANCE_SIGNATURE: "nested", XDG_RUNTIME_DIR: runtimeDir },
      signature: "some-other-instance",
      pluginDirectory: await installedPluginDirectory("SynaraComputerUsePluginV1.so"),
      busNameHasOwner: async () => false,
      dbusFactory: async () => fakeDbus(),
      atspi: {
        readTrees: async () => [],
        setText: async () => false,
        dispose: async () => undefined,
      },
    });

    await expect(backend.probeAvailability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("No Hyprland session"),
    });
    await backend.dispose();
  });
});

describe("HyprlandComputerBackend availability", () => {
  it("connects through the plugin host and names the backend hyprland", async () => {
    const dbus = fakeDbus();
    const backend = await makeBackend({
      pluginDirectory: await installedPluginDirectory("SynaraComputerUsePluginV3.so"),
      dbusFactory: async () => dbus,
    });

    await expect(backend.availability()).resolves.toEqual({
      kind: "available",
      backend: "hyprland",
    });
    expect(dbus.loads).toEqual(["SynaraComputerUsePluginV3"]);
    await backend.dispose();
  });

  it("refuses without dialing anything when no Hyprland session is live", async () => {
    const backend = await makeBackend({
      resolveInstance: async () => undefined,
      dbusFactory: async () => {
        throw new Error("must not connect without a session");
      },
    });

    await expect(backend.availability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("No Hyprland session"),
    });
    await backend.dispose();
  });

  it("passes Hyprland's own refusal words through to the failure message", async () => {
    const path = "/plugins/SynaraComputerUsePluginV3.so";
    const backend = await makeBackend({
      pluginDirectory: await installedPluginDirectory("SynaraComputerUsePluginV3.so"),
      dbusFactory: async () =>
        fakeDbus({
          loadPlugin: async () => false,
          lastLoadRefusal: () => `Plugin ${path} could not be loaded: API version mismatch.`,
        }),
    });

    const availability = await backend.availability();
    expect(availability).toMatchObject({ kind: "backend-unavailable" });
    const message = availability.kind === "backend-unavailable" ? availability.message : "";
    expect(message).toContain("Hyprland refused to load SynaraComputerUsePluginV3");
    // Hyprland's reason survives verbatim, minus its trailing period, so the
    // sentence reads as one and never as "mismatch.. If".
    expect(message).toContain("API version mismatch. If Hyprland was upgraded");
    expect(message).toContain("install-and-load.sh");
    await backend.dispose();
  });

  it("falls back to the generic version-mismatch cause when hyprctl gave no words", async () => {
    const backend = await makeBackend({
      pluginDirectory: await installedPluginDirectory("SynaraComputerUsePluginV3.so"),
      dbusFactory: async () => fakeDbus({ loadPlugin: async () => false }),
    });

    const availability = await backend.availability();
    expect(availability).toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining(
        "only loads into the exact Hyprland version it was built against",
      ),
    });
    await backend.dispose();
  });
});

/**
 * The engine's plugin contract, driven through the Hyprland subclass.
 *
 * Every one of these behaviours is implemented once, in `KWinComputerBackend`,
 * against a D-Bus surface both plugins serve — so the thing worth testing here
 * is not the behaviour a second time but that the Hyprland backend still
 * inherits it: it overrides the connect, load and availability paths these all
 * run through, and an override that quietly bypassed one of them would be
 * invisible in the KWin suite.
 */
describe("HyprlandComputerBackend inherited plugin contract", () => {
  async function connectedBackend(dbus: FakeDbus): Promise<HyprlandComputerBackend> {
    const backend = await makeBackend({
      pluginDirectory: await installedPluginDirectory("SynaraComputerUsePluginV1.so"),
      dbusFactory: async () => dbus as unknown as HyprlandComputerDbus,
    });
    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    return backend;
  }

  it("hands input delivery back to the human seat, falling back on an older plugin", async () => {
    const dbus = new FakeDbus();
    const backend = await connectedBackend(dbus);

    // Nothing is held before a session runs, so nothing is reset — and no
    // session is started to do it.
    await backend.resetInputDelivery();
    expect(dbus.plugin.calls.map((call) => call.method)).not.toContain("start");
    await backend.focusWindow("window-1");
    await backend.resetInputDelivery();
    expect(dbus.plugin.calls.map((call) => call.method)).toContain("resetInputDelivery");

    // A Hyprland build predating the method: the aim is still cleared, which
    // is the half it can do.
    dbus.plugin.resetInputDeliveryFailure = dbusError(
      "org.freedesktop.DBus.Error.UnknownMethod",
      "No such method",
    );
    dbus.plugin.calls.length = 0;
    await backend.resetInputDelivery();
    expect(dbus.plugin.calls.map((call) => call.method)).toEqual([
      "resetInputDelivery",
      "clearFocusWindow",
    ]);
    await backend.dispose();
  });

  it("refuses character synthesis on a non-US layout and allows named keys", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.keyboardLayout = "de";
    const backend = await connectedBackend(dbus);

    await expect(backend.typeText("hallo")).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining('"de"'),
    });
    await expect(backend.pressKey("a")).rejects.toMatchObject({ retryable: false });
    await expect(backend.hotkey(["ctrl", "c"])).rejects.toMatchObject({ retryable: false });
    // Refused before anything was sent, which is the whole point: text that
    // lands wrong on a German keyboard is worse than text that never lands.
    expect(dbus.plugin.calls.filter((call) => call.method === "key")).toEqual([]);

    await backend.pressKey("Enter");
    expect(dbus.plugin.calls.filter((call) => call.method === "key").length).toBeGreaterThan(0);

    dbus.plugin.keyboardLayout = "us(altgr-intl)";
    dbus.plugin.calls.length = 0;
    await backend.typeText("ok");
    expect(dbus.plugin.calls.filter((call) => call.method === "key")).toHaveLength(4);
    await backend.dispose();
  });

  it("maps a locked session to a retryable refusal that keeps the connection", async () => {
    const dbus = new FakeDbus();
    const backend = await connectedBackend(dbus);
    dbus.plugin.inputFailure = {
      method: "key",
      error: dbusError("org.synara.ComputerUse.Error.SessionLocked", "the session is locked"),
    };

    await expect(backend.pressKey("Enter")).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining(SESSION_LOCKED_REFUSAL),
    });
    // A lock screen is not a broken connection: reconnecting would drop the
    // session the human is about to unlock.
    expect(dbus.calls.map((call) => call.method)).not.toContain("close");
    expect(backend.health().status).toBe("connected");
    await backend.dispose();
  });

  it("surfaces a locked session through health while staying available", async () => {
    const dbus = new FakeDbus();
    const healthy = dbus.plugin.healthJson;
    dbus.plugin.healthJson = async () =>
      JSON.stringify({ ...JSON.parse(await healthy()), locked: true });
    const backend = await connectedBackend(dbus);

    expect(backend.health().lastFailure?.message).toContain(SESSION_LOCKED_REFUSAL);
    await backend.dispose();
  });
});

describe("HyprlandComputerBackend setup gate", () => {
  /** Reaches the protected hook without going through clipboard provisioning. */
  class SetupProbe extends HyprlandComputerBackend {
    setUp() {
      return this.provisionOnce();
    }
  }

  it("does not judge a Hyprland host by the KWin compatibility gate", async () => {
    // The engine's gate asks whether the installed "KWin" is version 6 or
    // newer. Hyprland's versions are 0.x, so inheriting that gate refuses
    // setup on every Hyprland machine there is, with a message about KDE
    // Frameworks — for a compositor that has nothing to do with them.
    const directory = await temp();
    const backend = new SetupProbe({
      platform: "linux",
      resolveInstance: async () => "test-instance",
      pluginDirectory: join(directory, "plugins"),
      runHyprctl: async (args) =>
        args.join(" ").endsWith("-j version") ? JSON.stringify({ version: "0.56.2" }) : "",
      busNameHasOwner: async () => false,
      dbusFactory: async () => fakeDbus(),
      atspi: {
        readTrees: async () => [],
        setText: async () => false,
        dispose: async () => undefined,
      },
      provisionPlugin: async () => ({
        action: "installed-from-source" as const,
        pluginId: "SynaraComputerUsePluginV1",
        pluginDirectory: join(directory, "plugins"),
        requiresRelogin: false,
        summary: "The computer-use plugin is installed and ready.",
      }),
    });

    await expect(backend.setUp()).resolves.toMatchObject({ action: "installed-from-source" });
    await backend.dispose();
  });
});

describe("HyprlandComputerBackend across compositor restarts (R6)", () => {
  class VersionProbe extends HyprlandComputerBackend {
    runningVersion() {
      return this.probeRunningKwinVersion();
    }
  }

  class SessionProbe extends HyprlandComputerBackend {
    sessionEnvironment() {
      return this.desktopSessionEnvironment();
    }
  }

  it("gives launched apps and the clipboard the live instance, not the inherited one", async () => {
    const runtime = await temp();
    await mkdir(join(runtime, "hypr", "second"), { recursive: true });
    await writeFile(join(runtime, "hypr", "second", "hyprland.lock"), "2042\nwayland-2\n");
    let instance: string | undefined = "first";
    const dir = await temp();
    const backend = new SessionProbe({
      platform: "linux",
      env: {
        XDG_RUNTIME_DIR: runtime,
        HYPRLAND_INSTANCE_SIGNATURE: "first",
        WAYLAND_DISPLAY: "wayland-1",
        DISPLAY: ":0",
      },
      resolveInstance: async () => instance,
      pluginDirectory: join(dir, "plugins"),
      installStampPath: join(dir, "install.stamp"),
      busNameHasOwner: async () => false,
      dbusFactory: async () => fakeDbus(),
    });
    await expect(backend.sessionEnvironment()).resolves.toEqual({
      HYPRLAND_INSTANCE_SIGNATURE: "first",
    });
    // Restarted: the old socket is dead and the old Xwayland with it.
    instance = "second";
    await expect(backend.sessionEnvironment()).resolves.toEqual({
      HYPRLAND_INSTANCE_SIGNATURE: "second",
      WAYLAND_DISPLAY: "wayland-2",
      DISPLAY: undefined,
    });
    instance = undefined;
    await expect(backend.sessionEnvironment()).rejects.toThrow("No Hyprland session");
  });

  it("follows the live instance, reloads into a new one and reads its version afresh", async () => {
    vi.useFakeTimers();
    try {
      const dbus = new FakeDbus();
      let instance: string | undefined = "first";
      const versions: Record<string, string> = { first: "0.56.1", second: "0.56.2" };
      let versionReads = 0;
      const directory = await temp();
      const backend = new VersionProbe({
        platform: "linux",
        resolveInstance: async () => instance,
        pluginDirectory: await installedPluginDirectory("SynaraComputerUsePluginV1.so"),
        installStampPath: join(directory, "install.stamp"),
        runHyprctl: async (args) => {
          if (args.join(" ") !== "-j version") throw new Error(`unexpected ${args.join(" ")}`);
          versionReads += 1;
          return JSON.stringify({ version: instance ? versions[instance] : undefined });
        },
        busNameHasOwner: async () => false,
        dbusFactory: async () => dbus as unknown as HyprlandComputerDbus,
        atspi: {
          readTrees: async () => [],
          setText: async () => false,
          dispose: async () => undefined,
        },
      });
      await backend.listWindows();
      await expect(backend.runningVersion()).resolves.toBe("0.56.1");
      await backend.runningVersion();
      expect(versionReads).toBe(1);
      const loads = () => dbus.calls.filter((call) => call.method === "LoadPlugin").length;
      const loadsBefore = loads();

      // Hyprland restarted: the plugin went with the old instance.
      instance = "second";
      dbus.loaded = [];
      dbus.serviceOwner = undefined;
      dbus.changeServiceOwner(undefined);
      // The reconnect reads the plugin directory from disk, so it is waited
      // for rather than timed.
      await vi.waitFor(() => expect(backend.health().status).toBe("connected"));
      expect(loads()).toBe(loadsBefore + 1);
      await expect(backend.runningVersion()).resolves.toBe("0.56.2");
      expect(versionReads).toBe(2);
      await backend.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the desktop gone when no instance comes back", async () => {
    vi.useFakeTimers();
    try {
      const dbus = new FakeDbus();
      let instance: string | undefined = "only";
      const backend = await makeBackend({
        resolveInstance: async () => instance,
        pluginDirectory: await installedPluginDirectory("SynaraComputerUsePluginV1.so"),
        dbusFactory: async () => dbus as unknown as HyprlandComputerDbus,
      });
      const gone: string[] = [];
      backend.onEvent((event) => {
        if (event.type === "desktop-gone") gone.push(event.message);
      });
      await backend.listWindows();

      instance = undefined;
      dbus.disconnect();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(gone).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(gone).toEqual([expect.stringContaining("No Hyprland session")]);
      expect(backend.health()).toMatchObject({ status: "unavailable", dormant: true });
      await backend.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HyprlandComputerBackend plugin upgrade under a running session (N5)", () => {
  it("keeps the loaded plugin rather than replacing it with a build for the newer Hyprland", async () => {
    const dir = await temp();
    const pluginDirectory = await installedPluginDirectory(
      "SynaraComputerUsePluginV2.so",
      "SynaraComputerUsePluginV3.so",
    );
    const stampPath = join(dir, "install.stamp");
    // The headers moved on to 0.57 and V3 was built against them; the running
    // compositor is still 0.56, which refuses V3.
    await writeFile(
      stampPath,
      "plugin_id=SynaraComputerUsePluginV3\nhyprland_version=0.57.0\nsource_hash=abc\n",
    );
    const dbus = fakeDbus({
      nameOwner: async () => ":1.42",
      listLoadedPluginIds: async () => ["SynaraComputerUsePluginV2"],
    });
    const unloads: string[] = [];
    const backend = await makeBackend({
      pluginDirectory,
      installStampPath: stampPath,
      runHyprctl: async (args) => {
        if (args.join(" ") === "-j version") return JSON.stringify({ version: "0.56.0" });
        throw new Error(`no hyprctl in tests: ${args.join(" ")}`);
      },
      dbusFactory: async () => ({
        ...dbus,
        unloadPlugin: async (pluginId: string) => {
          unloads.push(pluginId);
          return true;
        },
      }),
    });
    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(unloads).toEqual([]);
    expect(dbus.loads).toEqual([]);
    await backend.dispose();
  });
});

describe("HyprlandComputerBackend with several live instances", () => {
  it("never calls the desktop gone while instances are running, only ambiguous", async () => {
    vi.useFakeTimers();
    try {
      let resolution: Awaited<
        ReturnType<NonNullable<HyprlandComputerBackendOptions["resolveInstance"]>>
      > = "test-instance";
      let dropConnection: (() => void) | undefined;
      const backend = await makeBackend({
        resolveInstance: async () => resolution,
        dbusFactory: async () =>
          fakeDbus({
            nameOwner: async () => ":1.42",
            listLoadedPluginIds: async () => ["SynaraComputerUsePluginV2"],
            onDisconnect: (listener) => {
              dropConnection = listener;
              return () => undefined;
            },
          }),
      });
      const gone: string[] = [];
      backend.onEvent((event) => {
        if (event.type === "desktop-gone") gone.push(event.message);
      });
      await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });

      // The inherited instance died; the human's new session and a dev-test
      // instance are both live.
      resolution = { kind: "ambiguous", candidates: ["session", "dev-test"] };
      dropConnection?.();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(gone).toEqual([]);
      expect(backend.health().dormant).toBeUndefined();
      await expect(backend.probeAvailability()).resolves.toMatchObject({
        kind: "backend-unavailable",
        message: expect.stringContaining("2 Hyprland sessions are running"),
      });
      await backend.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
