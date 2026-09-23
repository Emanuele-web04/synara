import { describe, expect, it, vi } from "vitest";

import type { AtspiTreeReader } from "./atspiClient.ts";
import type { ComputerBackendEvent } from "./ComputerBackend.ts";
import type { KWinComputerDbus } from "./kwinDbus.ts";
import {
  NestedComputerBackend,
  parseNestedIdleShutdownEnv,
  type NestedComputerBackendOptions,
} from "./nestedComputerBackend.ts";
import {
  NestedPluginLoadRefusedError,
  type NestedAtspiMode,
  type NestedKWinSession,
  type NestedKWinSessionOptions,
} from "./nestedKWinSession.ts";
import type { SystemPackagePlan } from "./provisioning/systemPackages.ts";

const PLUGIN_ID = "SynaraComputerUsePluginV3";

const PACMAN_PLAN: SystemPackagePlan = {
  manager: "pacman",
  args: ["-S", "--needed", "--noconfirm"],
  packages: ["kwin", "cmake"],
};

/** What the fake desktop reports, shared by every fake bus a harness dials. */
const fakeDesktop = { windowsJson: "[]", stateGate: undefined as Promise<void> | undefined };

/** The narrow slice of the D-Bus surface the connect path exercises. */
function fakeDbusHandle(loaded: readonly string[] = [PLUGIN_ID]): {
  readonly dbus: KWinComputerDbus;
  readonly fireDisconnect: () => void;
} {
  const plugin = {
    healthJson: async () =>
      JSON.stringify({ ok: true, running: false, capture: true, kwinVersion: "6.7.3" }),
    // An empty desktop, enough for a state read to reach the AT-SPI reader.
    stateJson: async () => {
      await fakeDesktop.stateGate;
      return JSON.stringify({ position: { x: 0, y: 0 }, targetWindowId: null });
    },
    windowsJson: async () => fakeDesktop.windowsJson,
    stop: async () => true,
    setAgentName: async () => true,
  };
  let disconnectListener: (() => void) | undefined;
  const dbus = {
    loaded: [...loaded],
    // Owned once a plugin is loaded, with a stable unique name: the connect
    // path pins its proxy to the owner and refuses a service nobody owns.
    nameOwner: async () => (dbus.loaded.length > 0 ? ":1.42" : undefined),
    listLoadedPluginIds: async () => dbus.loaded,
    loadPlugin: async (id: string) => {
      dbus.loaded = [id];
      return true;
    },
    unloadPlugin: async (id: string) => {
      dbus.loaded = dbus.loaded.filter((candidate) => candidate !== id);
      return true;
    },
    connectPlugin: async () => plugin,
    onDisconnect: (listener: () => void) => {
      disconnectListener = listener;
      return () => undefined;
    },
    close: async () => undefined,
  };
  return {
    dbus: dbus as unknown as KWinComputerDbus,
    fireDisconnect: () => disconnectListener?.(),
  };
}

function fakeDbus(loaded: readonly string[] = [PLUGIN_ID]): KWinComputerDbus {
  return fakeDbusHandle(loaded).dbus;
}

interface Harness {
  readonly backend: NestedComputerBackend;
  readonly sessionStarts: NestedKWinSessionOptions[];
  /**
   * One entry per default-fixture session, with a way to end its processes.
   * `busSurvives` holds back the bus disconnect, leaving the session's own
   * exit notice as the only signal.
   */
  readonly startedSessions: Array<{
    readonly busAddress: string;
    kill: (reason?: string, options?: { readonly busSurvives?: boolean }) => void;
  }>;
  readonly disposedSessions: string[];
  /** One entry per connectDbus call, with a way to drop that connection. */
  readonly dbusHandles: Array<ReturnType<typeof fakeDbusHandle>>;
  readonly installedPlans: SystemPackagePlan[];
  readonly pluginProvisions: number[];
  readonly events: ComputerBackendEvent[];
  installedPlugins: string[];
}

function makeHarness(
  options: {
    readonly mode?: "window" | "virtual";
    readonly platform?: string;
    readonly linuxDistribution?: NestedComputerBackendOptions["linuxDistribution"];
    readonly runningKwinVersion?: NestedComputerBackendOptions["runningKwinVersion"];
    readonly installedKwinVersion?: NestedComputerBackendOptions["installedKwinVersion"];
    readonly hostEnv?: NodeJS.ProcessEnv;
    readonly kwinInstalled?: boolean;
    readonly clipboardInstalled?: boolean;
    readonly pluginInstalled?: boolean;
    readonly buildToolingPresent?: boolean;
    readonly prebuiltRoot?: string | undefined;
    readonly verifiedPrebuilt?: boolean;
    readonly plan?: SystemPackagePlan | undefined;
    readonly startSession?: (
      sessionOptions: NestedKWinSessionOptions,
    ) => Promise<NestedKWinSession>;
    readonly installPackages?: (plan: SystemPackagePlan, signal: AbortSignal) => Promise<string>;
    readonly onPluginProvision?: () => void;
    readonly provisionPlugin?: NestedComputerBackendOptions["provisionPlugin"];
    readonly atspiMode?: NestedAtspiMode;
    readonly createAtspiClient?: (env: NodeJS.ProcessEnv) => AtspiTreeReader;
    readonly sweepStaleSessions?: () => Promise<unknown>;
    readonly idleShutdownMs?: number;
    readonly liveApplications?: () => number;
  } = {},
): Harness {
  const sessionStarts: NestedKWinSessionOptions[] = [];
  const startedSessions: Harness["startedSessions"] = [];
  const disposedSessions: string[] = [];
  const dbusHandles: Harness["dbusHandles"] = [];
  const busHandles = new Map<string, ReturnType<typeof fakeDbusHandle>>();
  const installedPlans: SystemPackagePlan[] = [];
  const pluginProvisions: number[] = [];
  const events: ComputerBackendEvent[] = [];
  const state = {
    installedPlugins: options.pluginInstalled === false ? [] : [PLUGIN_ID],
    clipboardInstalled: options.clipboardInstalled ?? true,
  };

  const startSession =
    options.startSession ??
    (async (sessionOptions: NestedKWinSessionOptions): Promise<NestedKWinSession> => {
      sessionStarts.push(sessionOptions);
      const busAddress = `unix:abstract=fake-${sessionStarts.length}`;
      let exitReason: string | undefined;
      const exitListeners = new Set<(reason: string) => void>();
      startedSessions.push({
        busAddress,
        // A real session announces its exit, then takes its private bus down
        // with the compositor, which is what makes the disconnect reach every
        // client. Nothing here fires that by hand: a test that has to nudge
        // the connection is a test that would pass with the self-heal removed.
        kill: (reason = "exit code 0, signal null", killOptions = {}) => {
          exitReason = reason;
          for (const listener of exitListeners) listener(reason);
          if (killOptions.busSurvives !== true) busHandles.get(busAddress)?.fireDisconnect();
        },
      });
      return {
        busAddress,
        waylandDisplay: "synara-nested-test",
        size: { width: 1920, height: 1080 },
        pluginId: PLUGIN_ID,
        xDisplay: ":7",
        exited: () => exitReason,
        onExit: (listener) => {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
        liveApplicationCount: () => options.liveApplications?.() ?? 0,
        spawnApp: () => {
          throw new Error("no application is launched in this suite");
        },
        dispose: async () => {
          disposedSessions.push(busAddress);
        },
      };
    });

  const backendOptions: NestedComputerBackendOptions = {
    // Left unset unless a test names it, so the suite exercises the real
    // default (headless) rather than baking its own into every test.
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    ...(options.atspiMode !== undefined ? { atspiMode: options.atspiMode } : {}),
    ...(options.createAtspiClient ? { createAtspiClient: options.createAtspiClient } : {}),
    platform: options.platform ?? "linux",
    linuxDistribution: options.linuxDistribution ?? (() => ({ id: "arch" })),
    runningKwinVersion: options.runningKwinVersion ?? (async () => "6.7.3"),
    // Never the host's own kwin_wayland: the setup gate reads the installed
    // version, and a test that shells out to the developer's machine answers
    // differently on every machine.
    installedKwinVersion:
      options.installedKwinVersion ?? options.runningKwinVersion ?? (async () => "6.7.3"),
    hostEnv: options.hostEnv ?? { WAYLAND_DISPLAY: "wayland-0", PATH: "/usr/bin" },
    startSession,
    // Never the host's own marker directory or process table.
    sweepStaleSessions: options.sweepStaleSessions ?? (async () => []),
    // Off unless a test is about it: the suite drives fake clocks a long way.
    idleShutdownMs: options.idleShutdownMs ?? 0,
    connectDbus: async (busAddress) => {
      const handle = fakeDbusHandle([PLUGIN_ID]);
      dbusHandles.push(handle);
      busHandles.set(busAddress, handle);
      return handle.dbus;
    },
    hasCommand: (command) =>
      command === "kwin_wayland"
        ? (options.kwinInstalled ?? true)
        : (command === "wl-copy" || command === "wl-paste") && state.clipboardInstalled,
    installedPluginPresent: () => state.installedPlugins.length > 0,
    installedPluginIds: async () => state.installedPlugins,
    buildToolingPresent: () => options.buildToolingPresent ?? true,
    prebuiltRoot: () => options.prebuiltRoot,
    verifiedPrebuiltAvailable: async () => options.verifiedPrebuilt ?? false,
    planPackages: () => ("plan" in options ? options.plan : PACMAN_PLAN),
    installPackages:
      options.installPackages ??
      (async (plan) => {
        installedPlans.push(plan);
        state.clipboardInstalled = true;
        return `Installed ${plan.packages.join(", ")} with ${plan.manager}.`;
      }),
    provisionPlugin:
      options.provisionPlugin ??
      (async () => {
        options.onPluginProvision?.();
        pluginProvisions.push(1);
        state.installedPlugins = [PLUGIN_ID];
        return {
          action: "installed-from-source",
          pluginId: PLUGIN_ID,
          pluginDirectory: "/home/agent/.local/lib/qt6/plugins/kwin/effects/plugins",
          requiresRelogin: false,
          summary: "Compiled and installed the Synara KWin plugin.",
        };
      }),
  };
  const backend = new NestedComputerBackend(backendOptions);
  backend.onEvent?.((event) => events.push(event));
  const harness: Harness = {
    backend,
    sessionStarts,
    startedSessions,
    disposedSessions,
    dbusHandles,
    installedPlans,
    pluginProvisions,
    events,
    get installedPlugins() {
      return state.installedPlugins;
    },
    set installedPlugins(value: string[]) {
      state.installedPlugins = value;
    },
  };
  return harness;
}

describe("probeAvailability", () => {
  it("is passive and optimistic: available without booting anything", async () => {
    const harness = makeHarness({ kwinInstalled: false, pluginInstalled: false });
    await expect(harness.backend.probeAvailability()).resolves.toEqual({
      kind: "available",
      backend: "nested-kwin",
    });
    expect(harness.sessionStarts).toHaveLength(0);
    expect(harness.installedPlans).toHaveLength(0);
  });

  it("refuses a windowed session with no Wayland host to nest into", async () => {
    const harness = makeHarness({ mode: "window", hostEnv: { PATH: "/usr/bin" } });
    const availability = await harness.backend.probeAvailability();
    expect(availability).toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("WAYLAND_DISPLAY"),
    });
    expect(harness.sessionStarts).toHaveLength(0);
  });

  it("keeps the default headless mode independent of the host display", async () => {
    const harness = makeHarness({ hostEnv: { PATH: "/usr/bin" } });
    await expect(harness.backend.probeAvailability()).resolves.toMatchObject({
      kind: "available",
    });
  });

  it("refuses a non-Linux platform", async () => {
    const harness = makeHarness({ platform: "darwin" });
    await expect(harness.backend.probeAvailability()).resolves.toEqual({
      kind: "unsupported-platform",
      platform: "darwin",
    });
  });
});

describe("capabilities", () => {
  it("reports nothing before setup, so the settings card offers Set up", () => {
    const harness = makeHarness({ kwinInstalled: false, pluginInstalled: false });
    const capabilities = harness.backend.capabilities();
    expect(capabilities.input).toBe(false);
    expect(capabilities.capture).toBe(false);
  });

  it("reports the full set once the compositor and plugin are installed", () => {
    const harness = makeHarness();
    const capabilities = harness.backend.capabilities();
    expect(capabilities.input).toBe(true);
    expect(capabilities.capture).toBe(true);
    expect(capabilities.visibleDesktop).toBe(false);
  });

  it("needs both artifacts, not either", () => {
    expect(makeHarness({ kwinInstalled: false }).backend.capabilities().input).toBe(false);
    expect(makeHarness({ pluginInstalled: false }).backend.capabilities().input).toBe(false);
  });
});

describe("stale sessions a crashed server left behind", () => {
  it("are swept when the backend is built, not at the first boot", async () => {
    // A server that never boots a desktop of its own would otherwise leave a
    // dead server's ~260 MB desktop running for as long as it lives.
    const sweeps: string[] = [];
    let finishSweep: (() => void) | undefined;
    const harness = makeHarness({
      sweepStaleSessions: () => {
        sweeps.push("swept");
        return new Promise<void>((resolve) => {
          finishSweep = resolve;
        });
      },
    });
    expect(sweeps).toEqual(["swept"]);
    expect(harness.sessionStarts).toHaveLength(0);

    // A boot waits for the sweep rather than racing it over the same pids.
    const availability = harness.backend.availability();
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(harness.sessionStarts).toHaveLength(0);
    finishSweep?.();
    await expect(availability).resolves.toMatchObject({ kind: "available" });
    expect(harness.sessionStarts).toHaveLength(1);
    expect(sweeps).toHaveLength(1);
    await harness.backend.dispose();
  });

  it("are not swept off Linux, and a failed sweep never blocks a boot", async () => {
    let sweeps = 0;
    makeHarness({
      platform: "darwin",
      sweepStaleSessions: async () => {
        sweeps += 1;
      },
    });
    expect(sweeps).toBe(0);

    const harness = makeHarness({
      sweepStaleSessions: async () => {
        throw new Error("EACCES");
      },
    });
    await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });
    await harness.backend.dispose();
  });
});

describe("idle shutdown", () => {
  const IDLE_MS = 60_000;

  async function withFakeClock(run: () => Promise<void>): Promise<void> {
    vi.useFakeTimers();
    fakeDesktop.windowsJson = "[]";
    fakeDesktop.stateGate = undefined;
    try {
      await run();
    } finally {
      fakeDesktop.windowsJson = "[]";
      fakeDesktop.stateGate = undefined;
      vi.useRealTimers();
    }
  }

  it("reads SYNARA_COMPUTER_NESTED_IDLE_MINUTES, with 0 turning it off", () => {
    expect(parseNestedIdleShutdownEnv(undefined)).toBe(600_000);
    expect(parseNestedIdleShutdownEnv("")).toBe(600_000);
    expect(parseNestedIdleShutdownEnv("3")).toBe(180_000);
    expect(parseNestedIdleShutdownEnv("0.5")).toBe(30_000);
    expect(parseNestedIdleShutdownEnv("0")).toBe(0);
    expect(parseNestedIdleShutdownEnv("-1")).toBe(600_000);
    expect(parseNestedIdleShutdownEnv("ten")).toBe(600_000);
  });

  it("shuts an unused desktop down and boots it again on the next real use", async () => {
    await withFakeClock(async () => {
      const harness = makeHarness({ idleShutdownMs: IDLE_MS });
      await harness.backend.getState({});
      expect(harness.sessionStarts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
      expect(harness.disposedSessions).toEqual([]);
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      expect(harness.disposedSessions).toEqual(["unix:abstract=fake-1"]);
      // Idle, not lost: the manager keeps the desktop available off this.
      expect(harness.backend.health()).toMatchObject({ status: "unavailable", dormant: true });

      // Parked, not dead: the settings card and every state publish read it
      // without booting it, and nobody is told to click Set up.
      await expect(harness.backend.statusAvailability()).resolves.toMatchObject({
        kind: "available",
      });
      await expect(harness.backend.availability()).resolves.toMatchObject({
        kind: "available",
      });
      await expect(harness.backend.listWindows()).resolves.toEqual([]);
      await expect(harness.backend.getScreenSize()).resolves.toEqual({
        width: 1920,
        height: 1080,
        scale: 1,
      });
      expect(harness.sessionStarts).toHaveLength(1);
      // The reconnect loop does not reboot it either.
      await vi.advanceTimersByTimeAsync(IDLE_MS * 5);
      expect(harness.sessionStarts).toHaveLength(1);

      await harness.backend.getState({});
      expect(harness.sessionStarts).toHaveLength(2);
      expect(harness.backend.health().status).toBe("connected");
      expect(harness.backend.health().dormant).toBeUndefined();
      await harness.backend.dispose();
    });
  });

  it("stops the session's accessibility helper with the desktop", async () => {
    await withFakeClock(async () => {
      const clients: Array<{ disposed: boolean }> = [];
      const harness = makeHarness({
        idleShutdownMs: IDLE_MS,
        atspiMode: "session",
        createAtspiClient: () => {
          const record = { disposed: false };
          clients.push(record);
          return {
            readTrees: async () => [],
            setText: async () => false,
            dispose: async () => {
              record.disposed = true;
            },
          };
        },
      });
      await harness.backend.getState({ includeTree: true });
      expect(clients).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
      expect(harness.disposedSessions).toEqual(["unix:abstract=fake-1"]);
      expect(clients[0]?.disposed).toBe(true);
      await harness.backend.dispose();
    });
  });

  it("keeps the desktop while a lease is held, the pane watches, or an app runs", async () => {
    await withFakeClock(async () => {
      let apps = 0;
      const harness = makeHarness({ idleShutdownMs: IDLE_MS, liveApplications: () => apps });
      await harness.backend.getState({});

      await harness.backend.setDrivingAgent("Agent");
      await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
      expect(harness.disposedSessions).toEqual([]);
      await harness.backend.setDrivingAgent(null);

      apps = 1;
      await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
      expect(harness.disposedSessions).toEqual([]);
      apps = 0;

      // The fake plugin cannot capture; the pane is attached all the same.
      await harness.backend.attachStream(() => undefined).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
      expect(harness.disposedSessions).toEqual([]);
      await harness.backend.detachStream();

      // An app that forked and let its launcher exit still has a window.
      fakeDesktop.windowsJson = JSON.stringify([
        {
          id: "w1",
          title: "kcalc",
          appName: "kcalc",
          bounds: { x: 0, y: 0, width: 10, height: 10 },
        },
      ]);
      await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
      expect(harness.disposedSessions).toEqual([]);
      fakeDesktop.windowsJson = "[]";

      await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
      expect(harness.disposedSessions).toEqual(["unix:abstract=fake-1"]);
      await harness.backend.dispose();
    });
  });

  it("never shuts down under a call that is still running", async () => {
    await withFakeClock(async () => {
      const harness = makeHarness({ idleShutdownMs: IDLE_MS });
      await harness.backend.getState({});
      let release: (() => void) | undefined;
      fakeDesktop.stateGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow = harness.backend.getState({});
      await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
      expect(harness.disposedSessions).toEqual([]);

      release?.();
      fakeDesktop.stateGate = undefined;
      await slow;
      // The idle clock restarts when the call ends, not when it began.
      await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
      expect(harness.disposedSessions).toEqual([]);
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      expect(harness.disposedSessions).toEqual(["unix:abstract=fake-1"]);
      await harness.backend.dispose();
    });
  });

  it("is off at 0", async () => {
    await withFakeClock(async () => {
      const harness = makeHarness({ idleShutdownMs: 0 });
      await harness.backend.getState({});
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(harness.disposedSessions).toEqual([]);
      await harness.backend.dispose();
    });
  });
});

describe("lazy session boot", () => {
  it("boots the nested session on the first establishing read, not before", async () => {
    const harness = makeHarness();
    expect(harness.sessionStarts).toHaveLength(0);
    await expect(harness.backend.availability()).resolves.toEqual({
      kind: "available",
      backend: "nested-kwin",
    });
    expect(harness.sessionStarts).toHaveLength(1);
    // The default session is headless: real use must never pop a window
    // onto the host desktop.
    expect(harness.sessionStarts[0]?.mode).toBe("virtual");
    // Perception is off by default, so the session starts no accessibility bus.
    expect(harness.sessionStarts[0]?.accessibility).toBe(false);
  });

  it("boots once and reuses the session across reads", async () => {
    const harness = makeHarness();
    await harness.backend.availability();
    await harness.backend.availability();
    expect(harness.sessionStarts).toHaveLength(1);
  });

  it("announces the capability change the boot causes", async () => {
    const harness = makeHarness({ kwinInstalled: false, pluginInstalled: false });
    // Pre-boot the panel was told "nothing"; the running session must push the
    // correction rather than waiting to be asked.
    harness.installedPlugins = [PLUGIN_ID];
    await harness.backend.availability();
    const change = harness.events.find((event) => event.type === "capabilities-changed");
    expect(change).toBeDefined();
    expect(change?.type === "capabilities-changed" && change.capabilities.input).toBe(true);
  });

  it("installs the plugin in user space before booting when it is missing", async () => {
    const harness = makeHarness({ pluginInstalled: false });
    await harness.backend.availability();
    expect(harness.pluginProvisions).toHaveLength(1);
    expect(harness.sessionStarts).toHaveLength(1);
    // Never the polkit path: booting must not raise an authorization dialog.
    expect(harness.installedPlans).toHaveLength(0);
  });

  it("points a failed silent install at the Set up button", async () => {
    const failing = new NestedComputerBackend({
      mode: "window",
      platform: "linux",
      linuxDistribution: () => ({ id: "arch" }),
      runningKwinVersion: async () => "6.7.3",
      hostEnv: { WAYLAND_DISPLAY: "wayland-0", PATH: "/usr/bin" },
      startSession: async () => {
        throw new Error("must not boot");
      },
      connectDbus: async () => fakeDbus(),
      installedPluginIds: async () => [],
      provisionPlugin: async () => {
        throw new Error("cmake is not installed");
      },
    });
    const availability = await failing.availability();
    expect(availability).toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringMatching(/cmake is not installed.*Set up/s),
    });
    await failing.dispose();
  });
});

describe("provision", () => {
  it("refuses Ubuntu 24.04 in the probe, setup and first use without side effects", async () => {
    const harness = makeHarness({
      linuxDistribution: () => ({ id: "ubuntu", versionId: "24.04" }),
      kwinInstalled: false,
      pluginInstalled: false,
    });
    await expect(harness.backend.probeAvailability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("Ubuntu 24.04 ships KWin 5"),
    });
    await expect(harness.backend.provision()).rejects.toThrow("Ubuntu 24.04 ships KWin 5");
    await expect(harness.backend.availability()).resolves.toMatchObject({
      kind: "backend-unavailable",
    });
    expect(harness.backend.capabilities().input).toBe(false);
    expect(harness.installedPlans).toHaveLength(0);
    expect(harness.pluginProvisions).toHaveLength(0);
    expect(harness.sessionStarts).toHaveLength(0);
    await harness.backend.dispose();
  });

  it("refuses an existing KWin 5 on any distro before privileged setup", async () => {
    const harness = makeHarness({
      runningKwinVersion: async () => "5.27.11",
      buildToolingPresent: false,
    });
    await expect(harness.backend.provision()).rejects.toThrow("KWin 5.27.11 is unsupported");
    expect(harness.installedPlans).toHaveLength(0);
    expect(harness.pluginProvisions).toHaveLength(0);
    expect(harness.sessionStarts).toHaveLength(0);
    await harness.backend.dispose();
  });

  it("installs missing clipboard tools even with a usable compositor and plugin", async () => {
    const harness = makeHarness({ clipboardInstalled: false, verifiedPrebuilt: true });
    expect(harness.backend.capabilities().clipboard).toBe(false);
    await harness.backend.provision();
    expect(harness.installedPlans).toHaveLength(1);
    expect(harness.backend.capabilities().clipboard).toBe(true);
    await harness.backend.dispose();
  });

  it("does not report successful setup when clipboard utilities are still missing", async () => {
    const harness = makeHarness({
      clipboardInstalled: false,
      installPackages: async () => "Installed",
    });
    await expect(harness.backend.provision()).rejects.toThrow("Clipboard setup is incomplete");
    expect(harness.pluginProvisions).toHaveLength(0);
    expect(harness.sessionStarts).toHaveLength(0);
    await harness.backend.dispose();
  });

  it("installs packages, provisions the plugin, and boots, in that order", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      kwinInstalled: false,
      pluginInstalled: false,
      installPackages: async (plan) => {
        order.push("packages");
        return `Installed ${plan.packages.join(", ")} with ${plan.manager}.`;
      },
      onPluginProvision: () => order.push("plugin"),
      startSession: async () => {
        order.push("boot");
        return {
          busAddress: "unix:abstract=fake",
          waylandDisplay: "synara-nested-test",
          size: { width: 1920, height: 1080 },
          pluginId: PLUGIN_ID,
          xDisplay: undefined,
          exited: () => undefined,
          spawnApp: () => {
            throw new Error("no application is launched in this suite");
          },
          dispose: async () => undefined,
        };
      },
    });
    const summary = await harness.backend.provision();
    expect(order).toEqual(["packages", "plugin", "boot"]);
    expect(summary).toContain("Installed kwin, cmake with pacman.");
    expect(summary).toContain("Compiled and installed the Synara KWin plugin.");
    expect(summary).toContain("The agent's isolated desktop is running.");
  });

  it("skips the privileged step when nothing privileged is missing", async () => {
    const harness = makeHarness();
    const summary = await harness.backend.provision();
    expect(harness.installedPlans).toHaveLength(0);
    expect(harness.pluginProvisions).toHaveLength(1);
    expect(summary).toContain("The agent's isolated desktop is running.");
  });

  it("asks for packages when the plugin must be built and nothing can build it", async () => {
    const harness = makeHarness({
      kwinInstalled: true,
      pluginInstalled: false,
      buildToolingPresent: false,
      prebuiltRoot: undefined,
    });
    await harness.backend.provision();
    expect(harness.installedPlans).toHaveLength(1);
  });

  it("trusts a shipped prebuilt instead of installing a toolchain", async () => {
    const harness = makeHarness({
      kwinInstalled: true,
      pluginInstalled: false,
      buildToolingPresent: false,
      prebuiltRoot: "/opt/synara/prebuilt",
      verifiedPrebuilt: true,
    });
    await harness.backend.provision();
    expect(harness.installedPlans).toHaveLength(0);
    expect(harness.pluginProvisions).toHaveLength(1);
  });

  it("installs build packages when a bundled directory has no verified exact match", async () => {
    const harness = makeHarness({
      kwinInstalled: true,
      pluginInstalled: true,
      buildToolingPresent: false,
      prebuiltRoot: "/opt/synara/prebuilt",
      verifiedPrebuilt: false,
    });
    await harness.backend.provision();
    expect(harness.installedPlans).toHaveLength(1);
    expect(harness.pluginProvisions).toHaveLength(1);
  });

  it("names the gap on a distribution with no known package manager", async () => {
    const harness = makeHarness({ kwinInstalled: false, plan: undefined });
    await expect(harness.backend.provision()).rejects.toThrow(
      /No supported package manager.*kwin/s,
    );
  });

  it("is single-flight while running and retryable after a failure", async () => {
    let installs = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = makeHarness({
      kwinInstalled: false,
      pluginInstalled: false,
      installPackages: async () => {
        installs += 1;
        await gate;
        throw new Error("the authorization dialog was dismissed");
      },
    });
    const first = harness.backend.provision();
    const second = harness.backend.provision();
    release?.();
    await expect(first).rejects.toThrow("dismissed");
    await expect(second).rejects.toThrow("dismissed");
    expect(installs).toBe(1);
    // The failed run cleared the flight, so the user's retry actually retries.
    await expect(harness.backend.provision()).rejects.toThrow("dismissed");
    expect(installs).toBe(2);
  });

  it("replaces a session that is alive but broken only on another explicit Set up", async () => {
    const sessions: string[] = [];
    const disposed: string[] = [];
    const installPackages = vi.fn(async () => {
      throw new Error("Unexpected system installation");
    });
    const deadBuses = new Set<string>();
    const handles = new Map<string, ReturnType<typeof fakeDbusHandle>>();
    const backend = new NestedComputerBackend({
      mode: "window",
      platform: "linux",
      linuxDistribution: () => ({ id: "arch" }),
      runningKwinVersion: async () => "6.7.3",
      hostEnv: { WAYLAND_DISPLAY: "wayland-0", PATH: "/usr/bin" },
      hasCommand: () => true,
      buildToolingPresent: () => true,
      verifiedPrebuiltAvailable: async () => false,
      planPackages: () => PACMAN_PLAN,
      installPackages,
      installedPluginPresent: () => true,
      installedPluginIds: async () => [PLUGIN_ID],
      provisionPlugin: async () => ({
        action: "already-current",
        pluginDirectory: "/home/agent/.local/lib/qt6/plugins/kwin/effects/plugins",
        summary: "Current",
        requiresRelogin: false,
      }),
      startSession: async () => {
        const busAddress = `unix:abstract=fake-${sessions.length + 1}`;
        sessions.push(busAddress);
        return {
          busAddress,
          waylandDisplay: "synara-nested-test",
          size: { width: 1920, height: 1080 },
          pluginId: PLUGIN_ID,
          xDisplay: undefined,
          // Alive the whole time: this is the wedged compositor, not the
          // closed window, so the exit check must not reap it.
          exited: () => undefined,
          spawnApp: () => {
            throw new Error("no application is launched in this suite");
          },
          dispose: async () => {
            disposed.push(busAddress);
          },
        };
      },
      connectDbus: async (busAddress) => {
        if (deadBuses.has(busAddress)) throw new Error("dbus connection refused");
        const handle = fakeDbusHandle();
        handles.set(busAddress, handle);
        return handle.dbus;
      },
    });
    await backend.availability();
    expect(sessions).toHaveLength(1);

    // The session wedges: its processes still run, but its bus stops
    // answering and the live connection reports the disconnect. A second
    // compositor must not be booted next to a live one — the establishing
    // read stays failed.
    deadBuses.add(sessions[0]!);
    handles.get(sessions[0]!)?.fireDisconnect();
    const failed = await backend.availability();
    expect(failed.kind).toBe("backend-unavailable");
    expect(sessions).toHaveLength(1);

    // Set up is the explicit request that may replace it.
    const summary = await backend.provision();
    expect(sessions).toHaveLength(2);
    expect(disposed).toContain(sessions[0]);
    expect(installPackages).not.toHaveBeenCalled();
    expect(summary).toContain("The agent's isolated desktop is running.");
    await backend.dispose();
  });

  it("disposes the session with the backend", async () => {
    const harness = makeHarness();
    await harness.backend.availability();
    await harness.backend.dispose();
    expect(harness.disposedSessions).toHaveLength(1);
  });

  it("reaps a session whose processes exited and boots a fresh one on the next real use", async () => {
    const harness = makeHarness();
    await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(harness.sessionStarts).toHaveLength(1);

    // The human closes the nested window: the compositor exits and the live
    // connection drops. The next real use must get a working desktop, not an
    // eternity of reconnects to a bus address that can never answer again.
    harness.startedSessions[0]?.kill();

    await expect(harness.backend.statusAvailability()).resolves.toMatchObject({
      kind: "backend-unavailable",
    });
    await expect(harness.backend.statusAvailability()).resolves.toMatchObject({
      kind: "backend-unavailable",
    });
    expect(harness.sessionStarts).toHaveLength(1);
    // A state publish's read answers passively; it boots nothing.
    await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(harness.sessionStarts).toHaveLength(1);
    await harness.backend.getState({});
    expect(harness.sessionStarts).toHaveLength(2);
    expect(harness.disposedSessions).toEqual(["unix:abstract=fake-1"]);
    await harness.backend.dispose();
  });

  it("drops the connection the moment its session exits, without waiting on the bus", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });
      expect(harness.backend.health().status).toBe("connected");

      // The compositor is gone and the bus has not noticed yet: the session's
      // own exit notice is enough to stop calling the desktop connected.
      harness.startedSessions[0]?.kill("exit code 1, signal null", { busSurvives: true });
      expect(harness.backend.health()).toMatchObject({
        status: "unavailable",
        lastFailure: { message: expect.stringContaining("not running") },
      });

      // Dormant straight away, so no reconnect loop spins up to find that out.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(harness.dbusHandles).toHaveLength(1);
      expect(harness.sessionStarts).toHaveLength(1);

      // The next real use boots a fresh desktop.
      await harness.backend.getState({});
      expect(harness.sessionStarts).toHaveLength(2);
      // An exit of the session it already replaced changes nothing.
      harness.startedSessions[0]?.kill("exit code 1, signal null", { busSurvives: true });
      expect(harness.backend.health().status).toBe("connected");
      await harness.backend.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the AT-SPI helper the session's environment, never the host's accessibility bus", async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const harness = makeHarness({
      atspiMode: "session",
      hostEnv: {
        PATH: "/usr/bin",
        WAYLAND_DISPLAY: "wayland-0",
        AT_SPI_BUS_ADDRESS: "unix:path=/run/user/1000/at-spi/bus_0",
        SYNARA_AUTH_TOKEN: "secret",
        SYNARA_ATSPI_EVENTS: "0",
      },
      createAtspiClient: (env) => {
        envs.push(env);
        return { readTrees: async () => [], setText: async () => false, dispose: async () => {} };
      },
    });
    await harness.backend.getState({ includeTree: true });
    expect(envs).toHaveLength(1);
    expect(envs[0]).toMatchObject({
      PATH: "/usr/bin",
      DBUS_SESSION_BUS_ADDRESS: "unix:abstract=fake-1",
      WAYLAND_DISPLAY: "synara-nested-test",
      SYNARA_ATSPI_EVENTS: "0",
    });
    expect(envs[0]).not.toHaveProperty("AT_SPI_BUS_ADDRESS");
    expect(envs[0]).not.toHaveProperty("SYNARA_AUTH_TOKEN");
    await harness.backend.dispose();
  });

  it("recreates the AT-SPI client for the replacement session after the desktop dies", async () => {
    const clients: Array<{ readonly env: NodeJS.ProcessEnv; disposed: boolean }> = [];
    const harness = makeHarness({
      atspiMode: "session",
      createAtspiClient: (env) => {
        const record = { env, disposed: false };
        clients.push(record);
        return {
          readTrees: async () => [],
          setText: async () => false,
          dispose: async () => {
            record.disposed = true;
          },
        };
      },
    });
    await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });
    await harness.backend.getState({ includeTree: true });
    expect(clients).toHaveLength(1);
    expect(clients[0]?.env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:abstract=fake-1");
    // The private bus activates nothing, so the session is asked to start the
    // accessibility bus the client will read from.
    expect(harness.sessionStarts[0]?.accessibility).toBe(true);

    // The compositor dies and the next real use boots a replacement with a
    // bus of its own; a client still bound to the old address would answer
    // every semantic read from a bus nothing listens on.
    harness.startedSessions[0]?.kill();
    await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });
    await harness.backend.getState({ includeTree: true });
    expect(harness.sessionStarts).toHaveLength(2);
    expect(clients).toHaveLength(2);
    expect(clients[0]?.disposed).toBe(true);
    expect(clients[1]?.env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:abstract=fake-2");

    await harness.backend.dispose();
    expect(clients[1]?.disposed).toBe(true);
  });

  it("never lets the reconnect loop reopen a window the human closed", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness({ mode: "window" });
      await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });

      harness.startedSessions[0]?.kill();
      // Give the reconnect loop every chance it would ever take: it must reap
      // the dead session, report the desktop dormant, and stand down.
      await vi.advanceTimersByTimeAsync(120_000);

      expect(harness.sessionStarts).toHaveLength(1);
      expect(harness.disposedSessions).toEqual(["unix:abstract=fake-1"]);
      expect(harness.backend.health()).toMatchObject({
        status: "unavailable",
        lastFailure: { message: expect.stringContaining("its window may have been closed") },
      });

      // Dormant, not dead: a panel read reopens nothing, and the next real
      // use still boots a fresh desktop.
      await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });
      await expect(harness.backend.listWindows()).resolves.toEqual([]);
      expect(harness.sessionStarts).toHaveLength(1);
      await harness.backend.getState({});
      expect(harness.sessionStarts).toHaveLength(2);
      await harness.backend.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not blame a closed window when the headless desktop dies", async () => {
    // The headless desktop has no window anyone could have closed; sending the
    // user hunting for one would be worse than saying nothing.
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });

      harness.startedSessions[0]?.kill();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(harness.sessionStarts).toHaveLength(1);
      const health = harness.backend.health();
      expect(health).toMatchObject({
        status: "unavailable",
        lastFailure: { message: expect.stringContaining("is not running") },
      });
      expect(health.lastFailure?.message).not.toContain("window");
      await harness.backend.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A session fixture that never launches anything and never dies. */
function liveSession(busAddress: string, onDispose?: () => void): NestedKWinSession {
  return {
    busAddress,
    waylandDisplay: "synara-nested-test",
    size: { width: 1920, height: 1080 },
    pluginId: PLUGIN_ID,
    xDisplay: undefined,
    exited: () => undefined,
    spawnApp: () => {
      throw new Error("no application is launched in this suite");
    },
    dispose: async () => {
      onDispose?.();
    },
  };
}

describe("a desktop that has never booted", () => {
  it("reports why the boot failed instead of calling the desktop dormant", async () => {
    // Dormancy is a statement about a desktop that ran and stopped. Answering
    // it for a boot that failed replaces the reason — no kwin_wayland, a
    // refused plugin — with an instruction that cannot help. (Supervision does
    // not enter the picture: the reconnect loop only ever runs for a backend
    // that has connected at least once.)
    let attempts = 0;
    const harness = makeHarness({
      startSession: async () => {
        attempts += 1;
        throw new Error("spawn kwin_wayland ENOENT");
      },
    });
    // No clock to drive: a failed boot ends the connect ladder at once rather
    // than booting twice more inside the same call.
    await expect(harness.backend.availability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("ENOENT"),
    });
    expect(attempts).toBe(1);
    const failure = harness.backend.health().lastFailure?.message ?? "";
    expect(failure).toContain("ENOENT");
    expect(failure).not.toContain("Set up to start it now");
    // Nor is a reconnect timer armed for it: the next real use boots again.
    expect(harness.backend.health().status).toBe("unavailable");
    await expect(harness.backend.availability()).resolves.toMatchObject({
      kind: "backend-unavailable",
    });
    expect(attempts).toBe(2);
    await harness.backend.dispose();
  });

  it("still refuses an automatic call once a desktop has run and stopped", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      await harness.backend.availability();
      harness.startedSessions[0]?.kill();
      await vi.advanceTimersByTimeAsync(120_000);

      // One boot, and the loop stood down on the dormant verdict.
      expect(harness.sessionStarts).toHaveLength(1);
      expect(harness.backend.health().lastFailure?.message).toContain("Set up to start it now");
      await harness.backend.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("statusAvailability", () => {
  it("does not call a desktop that is still starting one that is not running", async () => {
    // The settings screen polls this every ten seconds. Reporting "not running,
    // click Set up" for as long as a cold start takes invites a
    // Set up that can only join the boot already under way.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = makeHarness({
      startSession: async () => {
        await gate;
        return liveSession("unix:abstract=slow");
      },
    });
    // A first session that dies, so the dormant branch is otherwise live.
    const availability = harness.backend.availability();
    await Promise.resolve();

    await expect(harness.backend.statusAvailability()).resolves.toMatchObject({
      kind: "available",
    });
    release?.();
    await availability;
    await harness.backend.dispose();
  });
});

describe("disposal during a boot", () => {
  it("disposes a session that was still starting when the server shut down", async () => {
    // startSession has spawned a bus and a compositor long before it resolves.
    // A dispose that only looks at the settled session returns with both still
    // running and nothing left holding a reference to them.
    const disposed: string[] = [];
    let starts = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = makeHarness({
      startSession: async () => {
        const name = `slow-${(starts += 1)}`;
        await gate;
        return liveSession(`unix:abstract=${name}`, () => disposed.push(name));
      },
    });
    const availability = harness.backend.availability();
    // Let the boot actually start before the shutdown arrives.
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();

    const disposal = harness.backend.dispose();
    release?.();
    await Promise.all([availability, disposal]);

    // Whatever the retry loop managed to boot, none of it is left running.
    expect(starts).toBeGreaterThan(0);
    expect(disposed).toHaveLength(starts);
  });
});

describe("disposal during a package install", () => {
  it("cancels an authorization dialog nobody answered", async () => {
    let installSignal: AbortSignal | undefined;
    const harness = makeHarness({
      kwinInstalled: false,
      installPackages: (_plan, signal) => {
        installSignal = signal;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    });
    const provision = harness.backend.provision().catch((error: unknown) => error);
    for (let turn = 0; turn < 20; turn += 1) {
      if (installSignal) break;
      await Promise.resolve();
    }
    expect(installSignal?.aborted).toBe(false);

    await harness.backend.dispose();
    expect(installSignal?.aborted).toBe(true);
    await expect(provision).resolves.toBeInstanceOf(Error);
  });
});

describe("disposal during a plugin build", () => {
  it("aborts the build instead of waiting minutes for a compiler", async () => {
    let provisionSignal: AbortSignal | undefined;
    const harness = makeHarness({
      pluginInstalled: false,
      provisionPlugin: async ({ signal }) => {
        provisionSignal = signal;
        // A source build that only ends when it is cancelled.
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      },
    });
    const availability = harness.backend.availability();
    for (let turn = 0; turn < 20; turn += 1) {
      if (provisionSignal) break;
      await Promise.resolve();
    }
    expect(provisionSignal?.aborted).toBe(false);

    await harness.backend.dispose();
    expect(provisionSignal?.aborted).toBe(true);
    await expect(availability).resolves.toMatchObject({ kind: "backend-unavailable" });
    // Nothing was booted after the shutdown began.
    expect(harness.sessionStarts).toHaveLength(0);
  });
});

describe("a stale plugin the compositor refuses", () => {
  it("installs one built against this compositor and boots once more", async () => {
    // An installed .so from the KWin this machine ran before its last upgrade
    // makes pluginInstalled() true, so the boot skips provisioning and then
    // fails on a load that will be refused forever.
    let starts = 0;
    const harness = makeHarness({
      startSession: async () => {
        starts += 1;
        if (starts === 1) {
          throw new NestedPluginLoadRefusedError(PLUGIN_ID, "refused to load");
        }
        return liveSession("unix:abstract=rebuilt");
      },
    });

    await expect(harness.backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(starts).toBe(2);
    expect(harness.pluginProvisions).toHaveLength(1);
    await harness.backend.dispose();
  });

  it("reports the compositor's refusal when no replacement can be built", async () => {
    let starts = 0;
    let rebuilds = 0;
    const harness = makeHarness({
      onPluginProvision: () => {
        rebuilds += 1;
        throw new Error("cmake is not installed");
      },
      startSession: async () => {
        starts += 1;
        throw new NestedPluginLoadRefusedError(PLUGIN_ID, "refused to load SynaraComputerUse");
      },
    });

    await expect(harness.backend.availability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      // The compositor's verdict, not the compiler's: the refusal is what the
      // user can act on, and cmake is not why the plugin was refused.
      message: expect.stringContaining("refused to load"),
    });
    // One rebuild per refusal and no more: a retry loop around a source build
    // costs minutes of compiler time per turn.
    expect(rebuilds).toBe(starts);
    await harness.backend.dispose();
  });
});
