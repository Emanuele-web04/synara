#!/usr/bin/env bun
/**
 * Standalone macOS Cua driver host — the same {@link CuaDriverHost} the
 * Electron desktop embeds, plus the full native safety layer, running
 * outside Electron as a sidecar for alternative shells (e.g. the GPUI
 * frame). The Synara server reaches it through `SYNARA_CUA_HOST_SOCKET`
 * and authenticates every request with `SYNARA_BROWSER_HOST_CAPABILITY`.
 *
 *   bun apps/desktop/src/cuaDriverHostMac.ts \
 *     --driver <binary-or-bundle-dir> \
 *     [--helper <synara-appsnap-helper>] \
 *     [--socket <unix-path>] [--capability-file <path>] \
 *     [--bundle-id <id>] [--app-bundle <path>] [--capture-dir <dir>]
 *
 * Safety layer parity with the Electron host:
 *   - Escape kill switch: the helper's listen-only event tap reports
 *     physical Escape to {@link CuaDriverHost.emergencyStopInput}, gated by
 *     the same arm/disarm generation flag.
 *   - AppSnap helper: permission checks/setup, held-input release and
 *     capture plumbing through the shared `synara-appsnap-helper`.
 *   - Masked activation shield via {@link ComputerShield}.
 *
 * Deliberate gaps versus the Electron host (each fails closed):
 *   - Preview frames reach the renderer through a dedicated relay socket
 *     (`--frame-socket`, default `<socket>.frames`) the shell bridges into
 *     the page — not Electron IPC. Subscriptions travel back over the same
 *     relay so the tap only runs while a preview is open.
 *   - The backend emergency-stop notice posts the same loopback route the
 *     Electron host uses; it needs `SYNARA_DESKTOP_SHUTDOWN_TOKEN` (server
 *     env) plus `--backend-url`/`SYNARA_CUA_BACKEND_URL` pointing at the
 *     loopback backend. Without them the notice is skipped and the local
 *     interrupt — the real stop — still runs.
 *   - powerMonitor suspend/resume/lock is relayed by the shell over
 *     SIGUSR1 (pause) / SIGUSR2 (resume) since a sidecar cannot observe
 *     distributed notifications portably.
 *   - Key-chord capture shortcuts are grabbed with Carbon
 *     `RegisterEventHotKey` (carbonHotKey.ts) — the same exclusive grab
 *     `globalShortcut` performs — with the Carbon event queue pumped on a
 *     timer since a Node process has no event loop.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";

import { COMPUTER_PERMISSION_KINDS } from "@synara/shared/computerGrants";
import { CUA_NATIVE_REVISION } from "@synara/shared/cuaDriverProtocol";
import { MODEL_SCREEN_IMAGE_MAX_DIMENSION } from "@synara/shared/modelImageBudget";

import { APP_SNAP_SETTINGS_PANE_URLS } from "./appSnapIpc";
import { DesktopAppSnapManager } from "./appSnapManager";
import { createCarbonShortcutRegistry } from "./carbonHotKey";
import { notifyBackendComputerEmergencyStop } from "./computerEmergencyStopNotice";
import { ComputerFrameTap } from "./computerFrameTap";
import { ComputerShield } from "./computerShield";
import { CuaDriverHost, sweepOrphanedCuaDrivers } from "./cuaDriverHost";
import { clearStaleCuaHostSocket } from "./cuaHostSocket";
import { EscapeKillSwitchMonitor } from "./escapeKillSwitchMonitor";
import { readAgentCursorPreference } from "./agentCursorPreference";

const HERE = dirname(fileURLToPath(import.meta.url));

// A relay client that goes away mid-write raises EPIPE on the write callback
// and on its readline interface; both must be swallowed or the whole sidecar
// dies taking every live client with it.
function safeWrite(client: Socket, data: Buffer | string): void {
  if (client.destroyed || !client.writable) return;
  try {
    client.write(data, () => {});
  } catch {
    // closed between check and write
  }
}

// Snapshot at module load: main() is async and may read options after the
// launcher (synaraSidecars.ts) has already swapped process.argv for the next
// co-hosted module.
const ARGV = process.argv.slice();
function option(name: string): string | undefined {
  const index = ARGV.indexOf(name);
  return index >= 0 ? ARGV[index + 1] : undefined;
}

type AppSnapPane = keyof typeof APP_SNAP_SETTINGS_PANE_URLS;

function parseSettingsPane(value: unknown): AppSnapPane | null {
  return value === "accessibility" || value === "input-monitoring" || value === "screen-recording"
    ? value
    : null;
}

type AppSnapPermissionKind = "accessibility" | "inputMonitoring" | "screenRecording";

function parsePermissionKinds(value: unknown): AppSnapPermissionKind[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) return null;
  const kinds = new Set<AppSnapPermissionKind>();
  for (const entry of value) {
    if (entry !== "accessibility" && entry !== "inputMonitoring" && entry !== "screenRecording") {
      return null;
    }
    kinds.add(entry);
  }
  return [...kinds];
}

function usage(message: string): never {
  console.error(`cua-driver-host-mac: ${message}`);
  console.error(
    "usage: cua-driver-host-mac --driver <binary-or-bundle-dir> " +
      "[--helper <path>] [--socket <unix-path>] [--capability-file <path>] " +
      "[--bundle-id <id>] [--app-bundle <path>] [--capture-dir <dir>]",
  );
  process.exit(2);
}

/** Processes that belong to the host shell: this sidecar's whole subtree
 * plus the parent shell binary that spawned it (its windows must never be
 * computer-use targets). */
function ownPids(): Set<number> {
  const rows = spawnSync("ps", ["-Ao", "pid=,ppid="], { encoding: "utf8" });
  const pids = new Set<number>([process.pid, process.ppid]);
  if (rows.status !== 0) return pids;
  const parentOf = new Map<number, number>();
  for (const line of rows.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(pid) && Number.isFinite(ppid)) parentOf.set(pid, ppid);
  }
  // Children of the shell (and of this host) belong to the app too.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of parentOf) {
      if (!pids.has(pid) && pids.has(ppid)) {
        pids.add(pid);
        changed = true;
      }
    }
  }
  return pids;
}

/** The .app bundle that owns the parent process — the path permission
 * guides drag into System Settings privacy lists. */
function resolveAppBundlePath(): string {
  const explicit = option("--app-bundle") ?? process.env.SYNARA_CUA_APP_BUNDLE;
  if (explicit) return resolve(explicit);
  const comm = spawnSync("ps", ["-o", "comm=", "-p", String(process.ppid)], {
    encoding: "utf8",
  }).stdout.trim();
  let directory = comm.includes("/") ? dirname(comm) : "";
  while (directory && directory !== dirname(directory)) {
    if (directory.endsWith(".app")) return directory;
    directory = dirname(directory);
  }
  return "";
}

/** Downscale the overview screenshot like Electron's nativeImage does,
 * without Electron: `sips` ships with macOS. */
function normalizeOverview(result: { content?: { type: string; data?: string }[] }) {
  const image = result.content?.find((part) => part.type === "image" && part.data);
  if (!image?.data) return result;
  const dir = join(tmpdir(), "synara-cua-mac");
  let tmp = "";
  try {
    mkdirSync(dir, { recursive: true });
    tmp = join(dir, `overview-${process.pid}-${Date.now()}.png`);
    writeFileSync(tmp, Buffer.from(image.data, "base64"));
    const probe = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", tmp], {
      encoding: "utf8",
    });
    const [width, height] = [...probe.stdout.matchAll(/pixel\w+: (\d+)/g)].map((m) => Number(m[1]));
    if (Math.max(width, height) <= MODEL_SCREEN_IMAGE_MAX_DIMENSION) return result;
    const ratio = MODEL_SCREEN_IMAGE_MAX_DIMENSION / Math.max(width, height);
    const resized = spawnSync(
      "sips",
      ["-z", String(Math.round(height * ratio)), String(Math.round(width * ratio)), tmp],
      { encoding: "utf8" },
    );
    if (resized.status !== 0) return result;
    image.data = readFileSync(tmp).toString("base64");
    return result;
  } catch {
    return result;
  } finally {
    if (tmp) rmSync(tmp, { force: true });
  }
}

async function main(): Promise<void> {
  if (process.platform !== "darwin")
    usage("this host carries the macOS safety layer; use cuaDriverHostStandalone elsewhere.");

  const driverOption = option("--driver") ?? process.env.SYNARA_CUA_DRIVER;
  if (!driverOption) usage("--driver is required (provisioned cua-driver binary or bundle dir).");

  let binaryPath = driverOption;
  if ((await stat(driverOption).catch(() => undefined))?.isDirectory()) {
    binaryPath = join(driverOption, "cua-driver");
  }
  await access(binaryPath).catch(() => usage(`driver not found or not readable: ${binaryPath}`));

  const helperPath = resolve(
    option("--helper") ??
      process.env.SYNARA_CUA_HELPER ??
      join(HERE, "..", ".electron-runtime", "appsnap", "synara-appsnap-helper"),
  );
  if (!existsSync(helperPath))
    usage(`appsnap helper not found: ${helperPath} (run scripts/build-appsnap-helper.mjs)`);

  // Same rule as the generic host: the capability never travels through
  // argv, which every process on the machine can read.
  const capabilityFile = option("--capability-file");
  let capability = process.env.SYNARA_CUA_HOST_CAPABILITY?.trim() ?? "";
  let capabilitySource = "environment";
  if (!capability && capabilityFile) {
    capability = (await readFile(capabilityFile, "utf8").catch(() => "")).trim();
    capabilitySource = capabilityFile;
  }
  if (!capability) {
    capability = randomBytes(32).toString("base64url");
    if (capabilityFile) {
      await writeFile(capabilityFile, capability + "\n", { mode: 0o600 });
      capabilitySource = capabilityFile;
    } else {
      capabilitySource = "generated-below";
    }
  }
  if (Buffer.byteLength(capability, "utf8") < 32)
    usage(
      "capability must be at least 32 bytes (SYNARA_CUA_HOST_CAPABILITY or --capability-file).",
    );

  const endpoint = option("--socket");
  if (endpoint) await clearStaleCuaHostSocket(endpoint);

  const backendHttpUrl = option("--backend-url") ?? process.env.SYNARA_CUA_BACKEND_URL ?? "";
  const shutdownToken = process.env.SYNARA_DESKTOP_SHUTDOWN_TOKEN?.trim() ?? "";

  const bundleId =
    option("--bundle-id") ?? process.env.SYNARA_CUA_BUNDLE_ID ?? "com.emanueledipietro.synara.gpui";
  const captureDirectory =
    option("--capture-dir") ?? (await mkdtemp(join(tmpdir(), "synara-cua-mac-appsnap-")));

  // AppSnap control socket: the shell's webview bridge forwards the
  // `appSnap.*` surface here instead of Electron ipcMain. One JSON request
  // per line, one JSON reply per line; manager events broadcast to every
  // connected shell the same way ipcMain.send pushes to the renderer.
  const appSnapClients = new Set<Socket>();
  const broadcastAppSnapEvent = (event: string, data: unknown) => {
    const line = `${JSON.stringify({ event, data })}\n`;
    for (const client of appSnapClients) safeWrite(client, line);
  };

  const shortcutRegistry = createCarbonShortcutRegistry();
  const appSnapManager = new DesktopAppSnapManager({
    platform: process.platform,
    helperPath,
    captureDirectory,
    excludedBundleId: bundleId,
    appDisplayName: "Synara",
    appBundlePath: resolveAppBundlePath(),
    shortcutRegistry,
    openSettingsPane: (pane) => {
      const paneUrl = APP_SNAP_SETTINGS_PANE_URLS[pane];
      if (paneUrl) spawnSync("open", [paneUrl]);
    },
    closeSettingsApp: () => {
      try {
        spawnSync("/usr/bin/osascript", [
          "-e",
          'tell application "System Settings" to quit',
          "-e",
          'tell application "System Preferences" to quit',
        ]);
      } catch {
        // Grants already landed; a lingering Settings window is not a failure.
      }
    },
    // No renderer in a sidecar: AppSnap state, captures and errors surface
    // on stderr, the only channel a shell can tail.
    onPermissionGuideState: (state) => broadcastAppSnapEvent("appSnapPermissionGuide", state),
    onState: (state) => {
      console.error(`[appsnap] state: ${state.status}${state.message ? ` ${state.message}` : ""}`);
      broadcastAppSnapEvent("appSnapState", state);
    },
    onCaptured: (capture) => {
      console.error(`[appsnap] captured ${capture.id}`);
      broadcastAppSnapEvent("appSnapCaptured", capture);
    },
    onError: (error) => {
      console.error(`[appsnap] ${error.code}: ${error.message}`);
      broadcastAppSnapEvent("appSnapError", error);
    },
  });

  sweepOrphanedCuaDrivers();

  // Preview relay: the shell connects to this socket to stream tap frames
  // into its renderer, and writes `subscribe`/`unsubscribe` back so the tap
  // helper only streams while a preview is open — Electron's IPC roles,
  // mapped one to one.
  const frameSocketPath =
    option("--frame-socket") ??
    process.env.SYNARA_CUA_FRAME_SOCK ??
    (endpoint ? `${endpoint}.frames` : "");
  const frameClients = new Set<Socket>();
  let frameSubscribers = 0;
  let frameTap: ComputerFrameTap | undefined;
  let frameRelay: Server | undefined;
  if (frameSocketPath) {
    await clearStaleCuaHostSocket(frameSocketPath);
    frameRelay = createServer((client) => {
      frameClients.add(client);
      client.once("close", () => frameClients.delete(client));
      client.once("error", () => frameClients.delete(client));
      createInterface({ input: client })
        .on("line", (line) => {
          if (line === "subscribe") frameSubscribers += 1;
          else if (line === "unsubscribe") frameSubscribers = Math.max(0, frameSubscribers - 1);
          else return;
          frameTap?.setSubscribed(frameSubscribers > 0);
        })
        .on("error", () => frameClients.delete(client));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      frameRelay!.once("error", rejectListen);
      frameRelay!.listen(frameSocketPath, () => resolveListen());
    });
    frameTap = new ComputerFrameTap({
      helperPath,
      send: (_channel, frame) => {
        const header = Buffer.from(`frame ${frame.windowId} ${frame.seq} ${frame.jpeg.length}\n`);
        for (const client of frameClients) {
          safeWrite(client, header);
          safeWrite(client, frame.jpeg);
        }
      },
      onError: (error) => console.error("[cua-driver-host-mac] computer frame tap failed:", error),
    });
  }

  // AppSnap control socket — same method table Electron's
  // `registerAppSnapIpcHandlers` maps onto ipcMain.handle.
  const appSnapSocketPath =
    option("--appsnap-socket") ??
    process.env.SYNARA_CUA_APPSNAP_SOCK ??
    (endpoint ? `${endpoint}.appsnap` : "");
  let appSnapRelay: Server | undefined;
  if (appSnapSocketPath) {
    await clearStaleCuaHostSocket(appSnapSocketPath);
    const dispatch = async (method: string, args: unknown): Promise<unknown> => {
      const params = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      switch (method) {
        case "getState":
          return appSnapManager.refreshState(parsePermissionKinds(params.permissions) ?? undefined);
        case "setEnabled":
          return appSnapManager.setEnabled(params.enabled === true);
        case "checkShortcut":
          return appSnapManager.checkShortcut(params.shortcut);
        case "setShortcut":
          return appSnapManager.setShortcut(params.shortcut);
        case "requestPermissions":
          return appSnapManager.requestPermissions(
            parsePermissionKinds(params.permissions) ?? undefined,
          );
        case "startPermissionSetup": {
          const kinds = parsePermissionKinds(params.permissions);
          if (!kinds) throw new Error("Permission setup requires at least one grant.");
          return appSnapManager.startPermissionSetup(kinds);
        }
        case "listPendingCaptures":
          return appSnapManager.listPendingCaptures();
        case "acknowledgeCapture":
          if (typeof params.captureId === "string") {
            await appSnapManager.acknowledgeCapture(params.captureId);
          }
          return null;
        case "listWindows":
          return appSnapManager.listWindows();
        case "captureWindow": {
          const windowId = params.windowId;
          if (
            typeof windowId !== "number" ||
            !Number.isInteger(windowId) ||
            windowId <= 0 ||
            windowId > 4294967295
          ) {
            throw new Error("captureWindow requires a valid macOS window id.");
          }
          return appSnapManager.captureWindow(windowId);
        }
        case "captureCurrentApp": {
          const requestId = params.requestId;
          if (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(requestId)) {
            throw new Error("Invalid AppSnap request.");
          }
          return appSnapManager.captureCurrentApp(requestId);
        }
        case "cancelCapture":
          if (typeof params.requestId === "string") appSnapManager.cancelCapture(params.requestId);
          return null;
        case "openPermissionSettings": {
          const pane = parseSettingsPane(params.pane);
          if (!pane) return false;
          const paneUrl = APP_SNAP_SETTINGS_PANE_URLS[pane];
          if (!paneUrl) return false;
          spawnSync("open", [paneUrl]);
          return true;
        }
        case "showPermissionGuide": {
          const pane = parseSettingsPane(params.pane);
          if (pane) appSnapManager.showPermissionGuide(pane);
          return null;
        }
        case "hidePermissionGuide":
          appSnapManager.hidePermissionGuide();
          return null;
        case "restartApp":
          // A sidecar cannot relaunch its shell; the GPUI frame ignores this
          // the way the Electron stub resolves without relaunching.
          return null;
        default:
          throw new Error(`unknown AppSnap method ${method}`);
      }
    };
    appSnapRelay = createServer((client) => {
      appSnapClients.add(client);
      client.once("close", () => appSnapClients.delete(client));
      client.once("error", () => appSnapClients.delete(client));
      createInterface({ input: client })
        .on("line", (line) => {
          let request: { id?: unknown; method?: unknown; args?: unknown };
          try {
            request = JSON.parse(line);
          } catch {
            return;
          }
          const id = typeof request.id === "number" ? request.id : 0;
          const method = typeof request.method === "string" ? request.method : "";
          void dispatch(method, request.args)
            .then((result) => safeWrite(client, `${JSON.stringify({ id, result })}\n`))
            .catch((error) =>
              safeWrite(
                client,
                `${JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) })}\n`,
              ),
            );
        })
        .on("error", () => appSnapClients.delete(client));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      appSnapRelay!.once("error", rejectListen);
      appSnapRelay!.listen(appSnapSocketPath, () => resolveListen());
    });
  }

  let escapeMonitor: EscapeKillSwitchMonitor | undefined;
  let host: CuaDriverHost;
  escapeMonitor = new EscapeKillSwitchMonitor({
    helperPath,
    onPhysicalInput: (event) => {
      host.physicalInput(event);
    },
    onStateChange: (state) => host.inputMonitorStateChanged(state),
    onEscape: () => {
      // The local interrupt is the real stop; the backend notice only
      // relays the state to the backend's computer manager.
      if (!host.emergencyStopInput()) return;
      console.error("[cua-driver-host-mac] physical Escape: computer input interrupted");
      notifyBackendComputerEmergencyStop({
        backendHttpUrl,
        shutdownToken,
        onError: (message) => console.error(`[cua-driver-host-mac] ${message}`),
      });
    },
    onError: (message) => console.error(`[cua-driver-host-mac] Escape monitor: ${message}`),
  });
  escapeMonitor.start();

  host = new CuaDriverHost({
    binaryPath,
    bundleId,
    capability,
    nativeRevision: CUA_NATIVE_REVISION,
    ...(endpoint ? { hostEndpoint: endpoint } : {}),
    onInputMonitorArmedChange: (armed) => escapeMonitor?.setArmed(armed),
    inputMonitorState: () => escapeMonitor?.state ?? { ready: false },
    activateInputMonitor: async () => {
      await escapeMonitor?.activate();
    },
    ownPids,
    cursorStyle: () =>
      readAgentCursorPreference(
        process.env.SYNARA_AGENT_CURSOR_PREFERENCE ??
          join(process.env.HOME ?? "", ".synara", "userdata", "agent-cursor-colors.json"),
      ),
    checkPermissions: async (options) => {
      const state = await appSnapManager.refreshState(COMPUTER_PERMISSION_KINDS, {
        force: options?.force === true,
      });
      if (
        state.status === "error" &&
        (state.accessibilityPermission === "unknown" ||
          state.inputMonitoringPermission === "unknown" ||
          state.screenRecordingPermission === "unknown")
      ) {
        throw new Error(state.message ?? "The native helper could not verify macOS permissions.");
      }
      if (
        host.isInputMonitorRequested &&
        state.inputMonitoringPermission === "granted" &&
        escapeMonitor?.state.error === "input-monitoring-required"
      ) {
        await escapeMonitor.activate(true);
      }
      return {
        accessibility: state.accessibilityPermission === "granted",
        inputMonitoring: state.inputMonitoringPermission === "granted",
        screenRecording: state.screenRecordingPermission === "granted",
      };
    },
    setup: async () => {
      await appSnapManager.startPermissionSetup(COMPUTER_PERMISSION_KINDS);
    },
    releaseHeldInput: async () => {
      await appSnapManager.releaseHeldInput();
    },
    shield: new ComputerShield({
      helperPath,
      onError: (error) => console.error("[cua-driver-host-mac] computer shield failed:", error),
    }),
    frameTap,
    normalizeOverview,
  });

  // The shell relays OS lifecycle over signals: SIGUSR1 pauses computer
  // input, SIGUSR2 resumes it (lock screen, suspend, session switch).
  process.on("SIGUSR1", () => {
    void host.pauseDesktop("desktop-lifecycle").catch((error: unknown) => {
      console.error(`[cua-driver-host-mac] input pause failed: ${String(error)}`);
    });
  });
  process.on("SIGUSR2", () => host.resumeDesktop("desktop-lifecycle"));

  const bound = await host.listen();
  const shutdown = async (signal: string) => {
    console.error(`[cua-driver-host-mac] ${signal} received; disposing`);
    try {
      escapeMonitor?.dispose();
      appSnapManager.dispose();
      shortcutRegistry.dispose();
      frameRelay?.close();
      appSnapRelay?.close();
      await host.dispose();
      process.exit(0);
    } catch (error) {
      console.error("[cua-driver-host-mac] cleanup failed:", error);
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Orphan reaper: a shell killed without unwinding (SIGKILL, lldb abort)
  // leaves this sidecar reparented to launchd; a stray host keeps holding the
  // socket and the Escape monitor armed forever. The frame passes its own pid
  // so the check tracks the real parent instead of ppid — a host detached by
  // design (manual dev launch under nohup) would otherwise reap itself.
  const framePid = Number(process.env["SYNARA_CUA_FRAME_PID"] ?? "");
  if (Number.isSafeInteger(framePid) && framePid > 1) {
    const orphanCheck = setInterval(() => {
      try {
        process.kill(framePid, 0);
      } catch {
        void shutdown("orphaned");
      }
    }, 3000);
    orphanCheck.unref();
  }

  console.info(`CUA_HOST_ENDPOINT=${bound}`);
  if (capabilitySource === "generated-below") {
    console.info(`CUA_CAPABILITY=${capability}`);
    console.info(
      "[cua-driver-host-mac] generated an ephemeral capability (above). Set it on the server " +
        "as SYNARA_BROWSER_HOST_CAPABILITY; it dies with this host.",
    );
  } else {
    console.info(`[cua-driver-host-mac] capability source: ${capabilitySource}`);
  }
  console.info(
    `[cua-driver-host-mac] driver: ${basename(binaryPath)} ` +
      `(native revision ${CUA_NATIVE_REVISION}, safety layer armed)`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
