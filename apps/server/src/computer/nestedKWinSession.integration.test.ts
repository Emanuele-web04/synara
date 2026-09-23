/**
 * Tier 3 end to end, against a real compositor.
 *
 * Off unless `SYNARA_NESTED_KWIN_TEST` is set: it spawns kwin_wayland and a
 * session bus, which no ordinary test run or CI runner without KWin can do.
 * Everything it starts lives on a private bus and an invisible virtual output,
 * so it never touches the desktop the developer is sitting in.
 *
 *   SYNARA_NESTED_KWIN_TEST=1 bunx vitest run src/computer/nestedKWinSession.integration.test.ts
 *
 * Run it with a private XDG_RUNTIME_DIR: the orphan-sweep case sweeps every
 * stale nested-session marker in that directory, and the marker assertions
 * expect to see only this suite's own.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KWinComputerBackend } from "./KWinComputerBackend.ts";
import { NestedComputerBackend } from "./nestedComputerBackend.ts";
import {
  nestedKWinBackendOptions,
  startNestedKWinSession,
  type NestedKWinSession,
} from "./nestedKWinSession.ts";
import {
  isProcessAlive,
  nestedSessionStateDirectory,
  type NestedSessionMarker,
} from "./nestedSessionRegistry.ts";

const NESTED_SIZE = { width: 1_280, height: 800 };
const BOOT_TIMEOUT_MS = 90_000;
const WINDOW_TIMEOUT_MS = 30_000;
const POLL_MS = 250;
const TEST_APP = "kcalc";
/** An X11 client that exits 0 only after connecting and authenticating. */
const X11_PROBE = "xprop";
const X11_PROBE_ARGS = ["-root", "-len", "0", "_NET_SUPPORTED"];
/** What a server's environment carries that no nested helper may inherit. */
const HOST_ONLY_VARIABLES = [
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "XAUTHORITY",
  "HYPRLAND_INSTANCE_SIGNATURE",
  "SYNARA_AUTH_TOKEN",
  "SYNARA_NESTED_KWIN_TEST",
];
const KWIN_VERSION = async () => kwinPackageVersion();

const enabled = Boolean(process.env.SYNARA_NESTED_KWIN_TEST);

describe.skipIf(!enabled)("nested KWin session", () => {
  let session: NestedKWinSession | undefined;
  let backend: KWinComputerBackend | undefined;
  const appInstalled = commandExists(TEST_APP);

  beforeAll(async () => {
    session = await startNestedKWinSession({ size: NESTED_SIZE });
    backend = new KWinComputerBackend(nestedKWinBackendOptions(() => session));
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await backend?.dispose();
    await session?.dispose();
  });

  it("comes up with exactly one plugin loaded and reports availability", async () => {
    expect(session?.pluginId).toMatch(/^SynaraComputerUsePlugin/);
    await expect(backend!.availability()).resolves.toEqual({ kind: "available", backend: "kwin" });
    expect(backend!.health().status).toBe("connected");
  });

  it("reports the requested virtual geometry", async () => {
    await expect(backend!.getScreenSize()).resolves.toMatchObject(NESTED_SIZE);
  });

  it("lists windows, of which an empty desktop has none", async () => {
    await expect(backend!.listWindows()).resolves.toEqual([]);
  });

  it.skipIf(!commandExists("busctl"))("activates nothing on the private bus", async () => {
    // With the stock session.conf this call would start a notification daemon
    // with the bus daemon's environment, on whatever display that names.
    const address = session!.busAddress;
    const call = await busctl(address, [
      "call",
      "org.freedesktop.Notifications",
      "/org/freedesktop/Notifications",
      "org.freedesktop.Notifications",
      "GetServerInformation",
    ]);
    expect(call.ok).toBe(false);
    expect(call.output).toMatch(/activatable|ServiceUnknown|\.service/i);
    const start = await busctl(address, [
      "call",
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "StartServiceByName",
      "su",
      "org.freedesktop.portal.Desktop",
      "0",
    ]);
    expect(start.ok).toBe(false);
    const activatable = await busctl(address, [
      "call",
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "ListActivatableNames",
    ]);
    expect(activatable.output.trim()).toBe('as 1 "org.freedesktop.DBus"');
  });

  it.skipIf(!commandExists(X11_PROBE))(
    "lets an X11 client launched into the session connect to the nested Xwayland",
    async () => {
      expect(session!.xDisplay).toMatch(/^:\d+$/);
      // Launched the way the backend launches apps: over the server's own
      // environment, which carries the human's DISPLAY and XAUTHORITY.
      const probe = session!.spawnApp(X11_PROBE, X11_PROBE_ARGS, {
        env: { ...process.env },
        cwd: process.cwd(),
      });
      await expect(exitCode(probe)).resolves.toBe(0);
    },
    WINDOW_TIMEOUT_MS,
  );

  it("keeps the host's display and the server's secrets out of the session's processes", async () => {
    const marker = await sessionMarker(session!);
    const roles = marker.processes.map((entry) => entry.role);
    expect(roles).toEqual(expect.arrayContaining(["bus", "compositor"]));
    const compositor = marker.processes.find((entry) => entry.role === "compositor")!;
    // kwin_wayland makes itself non-dumpable, so its environ is unreadable; the
    // Xwayland it forked (started by the X11 case above) inherits it instead.
    const inspected = [
      ...marker.processes.filter((entry) => entry.role !== "compositor" && entry.role !== "app"),
      ...childPids(compositor.pid).map((pid) => ({ pid, role: "xwayland" as const })),
    ];
    console.info(
      `nested session processes inspected: ${inspected.map((entry) => entry.role).join(", ")}`,
    );
    expect(inspected.map((entry) => entry.role)).toEqual(
      expect.arrayContaining(["bus", "xwayland"]),
    );
    for (const recorded of inspected) {
      const environ = await processEnvironment(recorded.pid);
      for (const name of HOST_ONLY_VARIABLES) {
        // KWin hands the Xwayland it starts its own Wayland socket, display
        // and cookie; the human's values are what must never appear.
        if (
          recorded.role === "xwayland" &&
          (name === "WAYLAND_DISPLAY" || name === "DISPLAY" || name === "XAUTHORITY")
        ) {
          expect(environ[name], `${recorded.role} ${name}`).not.toBe(process.env[name]);
          if (name === "WAYLAND_DISPLAY") expect(environ[name]).toBe(session!.waylandDisplay);
          continue;
        }
        expect(environ[name], `${recorded.role} ${name}`).toBeUndefined();
      }
      expect(environ.XDG_RUNTIME_DIR, recorded.role).toBe(session!.runtimeDirectory);
    }
  });

  it.skipIf(!appInstalled)(
    "launches an app into the nested session and sees its window",
    async () => {
      await backend!.launchApp(TEST_APP, []);
      const window = await waitFor(async () => {
        const windows = await backend!.listWindows();
        return windows.find((candidate) => candidate.appName?.includes(TEST_APP));
      }, WINDOW_TIMEOUT_MS);
      // KWin is the one compositor that always reports geometry, so a nested
      // session missing it is a regression in the plugin, not a capability gap.
      const bounds = window?.bounds;
      expect(bounds).toBeDefined();
      expect(bounds!.width).toBeGreaterThan(0);
      // The virtual output is the only screen, so the window is inside it.
      expect(bounds!.x).toBeLessThan(NESTED_SIZE.width);
    },
    WINDOW_TIMEOUT_MS + 10_000,
  );

  it("captures the workspace when the loaded plugin supports capture", async (context) => {
    if (!backend!.health().captureAvailable) context.skip();
    const screenshot = await backend!.captureScreenshot({
      kind: "region",
      region: { x: 0, y: 0, ...NESTED_SIZE },
    });
    expect(screenshot.mimeType).toBe("image/png");
    expect(screenshot.width).toBeGreaterThan(0);
    expect(screenshot.height).toBeGreaterThan(0);
  });

  /** The nested compositor has its own seat0, so its clipboard is its own too. */
  it.skipIf(!commandExists("wl-copy"))("round-trips the nested clipboard", async () => {
    await backend!.writeClipboard("nested clipboard");
    await expect(backend!.readClipboard()).resolves.toBe("nested clipboard");
  });

  /**
   * A compositor that dies takes its session with it: the private bus is torn
   * down behind it, so this backend's connection really does drop rather than
   * staying open against a bus whose KWin names have quietly vanished. Health
   * turns over either way, and nothing respawns — the dead desktop is never
   * replaced behind anyone's back.
   */
  it("surfaces a compositor crash as lost health rather than a fresh desktop", async () => {
    expect(backend!.health().status).toBe("connected");
    const compositor = (await sessionMarker(session!)).processes.find(
      (entry) => entry.role === "compositor",
    );
    process.kill(compositor!.pid, "SIGKILL");
    const health = await waitFor(async () => {
      await backend!.listWindows().catch(() => undefined);
      const current = backend!.health();
      return current.status === "connected" ? undefined : current;
    }, WINDOW_TIMEOUT_MS);
    expect(health.status).toBe("reconnecting");
    expect(health.captureAvailable).toBe(false);
    // The proxy is pinned to a unique bus owner, so real D-Bus errors may
    // name :1.1 rather than the well-known service name.
    expect(health.lastFailure?.message).toBeTruthy();
    // The dead compositor is never replaced, so no empty desktop stands in.
    await expect(backend!.listWindows()).rejects.toThrow();
  }, 60_000);
});

describe.skipIf(!enabled)("nested session accessibility bus", () => {
  it.skipIf(!commandExists("busctl"))(
    "starts org.a11y.Bus inside the session, with the session's environment",
    async () => {
      const session = await startNestedKWinSession({ size: NESTED_SIZE, accessibility: true });
      try {
        expect(session.accessibility).toBe(true);
        const address = await busctl(session.busAddress, [
          "call",
          "org.a11y.Bus",
          "/org/a11y/bus",
          "org.a11y.Bus",
          "GetAddress",
        ]);
        expect(address.ok).toBe(true);
        // Its own bus socket, inside the session's runtime directory.
        expect(address.output).toContain(session.runtimeDirectory!);
        const launcher = (await sessionMarker(session)).processes.find(
          (entry) => entry.role === "accessibility",
        );
        const environ = await processEnvironment(launcher!.pid);
        expect(environ.DBUS_SESSION_BUS_ADDRESS).toBe(session.busAddress);
        expect(environ.WAYLAND_DISPLAY).toBe(session.waylandDisplay);
        expect(environ.XDG_RUNTIME_DIR).toBe(session.runtimeDirectory);
        expect(environ.SYNARA_AUTH_TOKEN).toBeUndefined();
        expect(environ.HYPRLAND_INSTANCE_SIGNATURE).toBeUndefined();
      } finally {
        await session.dispose();
      }
    },
    BOOT_TIMEOUT_MS,
  );
});

describe.skipIf(!enabled)("nested backend lifecycle", () => {
  it(
    "shuts an idle desktop down and boots it again on the next real use",
    async () => {
      const backend = nestedBackend({ idleShutdownMs: 1_500 });
      try {
        await backend.getState({});
        const first = await onlyMarker();
        const compositor = first.processes.find((entry) => entry.role === "compositor")!;
        expect(isProcessAlive(compositor.pid)).toBe(true);

        // Idle: every process of the session ends and its marker goes with it.
        await waitFor(
          async () =>
            (!isProcessAlive(compositor.pid) && (await markers()).length === 0) || undefined,
          WINDOW_TIMEOUT_MS,
        );
        for (const recorded of first.processes) expect(isProcessAlive(recorded.pid)).toBe(false);
        await expect(stat(first.runtimeDirectory!)).rejects.toMatchObject({ code: "ENOENT" });

        // Parked, not dormant: status and state reads do not boot it.
        await expect(backend.statusAvailability()).resolves.toMatchObject({ kind: "available" });
        await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
        await expect(backend.listWindows()).resolves.toEqual([]);
        expect(await markers()).toEqual([]);

        // The next real use boots a fresh one.
        const started = Date.now();
        await backend.getState({});
        const rebootMs = Date.now() - started;
        const second = await onlyMarker();
        expect(second.sessionId).not.toBe(first.sessionId);
        expect(backend.health().status).toBe("connected");
        console.info(`nested reboot after idle shutdown took ${rebootMs} ms`);
      } finally {
        await backend.dispose();
      }
      expect(await markers()).toEqual([]);
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    "sweeps a killed server's desktop when the next backend is built",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "synara-nested-orphan-"));
      const script = join(directory, "boot.ts");
      const sessionModule = join(import.meta.dirname, "nestedKWinSession.ts");
      await writeFile(
        script,
        [
          `import { startNestedKWinSession } from ${JSON.stringify(sessionModule)};`,
          `const session = await startNestedKWinSession({ size: { width: 640, height: 480 } });`,
          `console.log(JSON.stringify({ runtimeDirectory: session.runtimeDirectory }));`,
          `setInterval(() => undefined, 1 << 30);`,
        ].join("\n"),
      );
      // A stand-in server: its own process, booting a session and then dying
      // without running a single handler.
      const server = spawn("bun", [script], {
        stdio: ["ignore", "pipe", "inherit"],
        env: process.env,
      });
      try {
        const line = await firstLine(server, BOOT_TIMEOUT_MS);
        const { runtimeDirectory } = JSON.parse(line) as { runtimeDirectory: string };
        const marker = await readMarker(basename(runtimeDirectory));
        expect(marker.serverPid).toBe(server.pid);
        const orphans = marker.processes;
        expect(orphans.map((entry) => entry.role)).toEqual(
          expect.arrayContaining(["bus", "compositor"]),
        );

        server.kill("SIGKILL");
        await exitCode(server);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        for (const orphan of orphans) {
          expect(isProcessAlive(orphan.pid), `${orphan.role} survived its server`).toBe(true);
        }

        // Building the next backend is enough; nothing has to boot.
        const backend = nestedBackend({});
        try {
          await waitFor(
            async () =>
              ((await markers()).length === 0 && !(await exists(runtimeDirectory))) || undefined,
            WINDOW_TIMEOUT_MS,
          );
          for (const orphan of orphans) {
            expect(isProcessAlive(orphan.pid), `${orphan.role} was swept`).toBe(false);
          }
        } finally {
          await backend.dispose();
        }
      } finally {
        if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
        await rm(directory, { recursive: true, force: true });
      }
    },
    BOOT_TIMEOUT_MS,
  );
});

function nestedBackend(options: { readonly idleShutdownMs?: number }): NestedComputerBackend {
  return new NestedComputerBackend({
    size: NESTED_SIZE,
    // Never `kwin_wayland --version`: it aborts outside a real session.
    installedKwinVersion: KWIN_VERSION,
    runningKwinVersion: KWIN_VERSION,
    ...(options.idleShutdownMs !== undefined ? { idleShutdownMs: options.idleShutdownMs } : {}),
  });
}

function kwinPackageVersion(): string | undefined {
  for (const [command, args] of [
    ["pacman", ["-Q", "kwin"]],
    ["rpm", ["-q", "--qf", "%{VERSION}", "kwin"]],
    ["dpkg-query", ["-W", "-f=${Version}", "kwin-wayland"]],
  ] as const) {
    try {
      const output = execFileSync(command, [...args], { encoding: "utf8", stdio: "pipe" });
      const version = /\d+\.\d+\.\d+/.exec(output)?.[0];
      if (version) return version;
    } catch {
      // Not this distribution's package manager.
    }
  }
  return undefined;
}

async function markers(): Promise<string[]> {
  const entries = await readdir(nestedSessionStateDirectory(process.env)!).catch(
    () => [] as string[],
  );
  return entries.filter((entry) => entry.endsWith(".json") && !entry.startsWith("."));
}

async function readMarker(sessionId: string): Promise<NestedSessionMarker> {
  const directory = nestedSessionStateDirectory(process.env)!;
  return JSON.parse(
    await readFile(join(directory, `${sessionId}.json`), "utf8"),
  ) as NestedSessionMarker;
}

async function onlyMarker(): Promise<NestedSessionMarker> {
  const names = await waitFor(async () => {
    const found = await markers();
    return found.length === 1 ? found : undefined;
  }, WINDOW_TIMEOUT_MS);
  return await readMarker(names[0]!.replace(/\.json$/, ""));
}

/** The marker of a live session: its id is its runtime directory's name. */
async function sessionMarker(session: NestedKWinSession): Promise<NestedSessionMarker> {
  return await readMarker(basename(session.runtimeDirectory!));
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

function childPids(pid: number): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map(Number);
  } catch {
    return [];
  }
}

async function processEnvironment(pid: number): Promise<Record<string, string>> {
  const raw = await readFile(`/proc/${pid}/environ`, "utf8");
  const env: Record<string, string> = {};
  for (const entry of raw.split("\0")) {
    const separator = entry.indexOf("=");
    if (separator > 0) env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}

function busctl(
  address: string,
  args: readonly string[],
): Promise<{ readonly ok: boolean; readonly output: string }> {
  return new Promise((resolve) => {
    execFile(
      "busctl",
      [`--address=${address}`, ...args],
      { timeout: 10_000 },
      (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}` }),
    );
  });
}

function exitCode(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

function firstLine(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    const timer = setTimeout(() => reject(new Error("no output from the boot script")), timeoutMs);
    lines.once("line", (line) => {
      clearTimeout(timer);
      lines.close();
      resolve(line);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`boot script exited with ${code}`));
    });
  });
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs} ms.`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function commandExists(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}
