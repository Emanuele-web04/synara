// FILE: main.ts
// Purpose: Starts the Electron shell, backend process, native menus, IPC bridges, and updater.
// Layer: Desktop main process
// Depends on: Electron, backend startup helpers, browser manager, and update runtime.

import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  protocol,
  session,
  shell,
  systemPreferences,
} from "electron";
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from "electron";
import * as Effect from "effect/Effect";
import { autoUpdater, BaseUpdater, CancellationToken } from "electron-updater";
import { NetService } from "@t3tools/shared/Net";
import { getMacTrafficLightPosition } from "@t3tools/shared/desktopChrome";
import { RotatingFileSink } from "@t3tools/shared/logging";
import { isBackendReadinessAborted, waitForHttpReady } from "./backendReadiness";
import { waitForBackendStartupReady } from "./backendStartupReadiness";
import { showDesktopConfirmDialog } from "./confirmDialog";
import { openInitialBackendWindow } from "./initialBackendWindowOpen";
import { shouldAllowMediaPermissionRequest } from "./mediaPermissions";
import {
  installResumableUpdateDownloader,
  type ResumableDownloaderTarget,
} from "./resumableUpdateDownload";
import { hardenElectronUpdater } from "./electronUpdaterSecurity";
import { ServerListeningDetector } from "./serverListeningDetector";
import { syncShellEnvironment } from "./syncShellEnvironment";
import { getAutoUpdateDisabledReason } from "./updateState";
import { registerDesktopVoiceTranscriptionHandler } from "./voiceTranscription";
import { resolveDesktopRuntimeInfo } from "./runtimeArch";
import { DesktopBrowserManager } from "./browserManager";
import {
  BROWSER_IPC_CHANNELS,
  registerBrowserIpcHandlers,
  sendBrowserCopyLink,
  sendBrowserState,
} from "./browserIpc";
import {
  BrowserUsePipeServer,
  DPCODE_BROWSER_USE_PIPE_ENV,
  SYNARA_BROWSER_USE_PIPE_ENV,
  SYNARA_BROWSER_USE_PIPE_PATH,
  T3CODE_BROWSER_USE_PIPE_ENV,
} from "./browserUsePipeServer";
import { normalizeDesktopWsUrl, resolveDesktopWsUrlFromEnv } from "./desktopWsBridge";
import {
  resolveDesktopAppDataBase,
  resolveDesktopUserDataPath,
  resolveLegacyDesktopUserDataPaths,
  seedDesktopUserDataProfileFromLegacy,
} from "./desktopUserDataProfile";
import {
  AUTO_UPDATE_CHECK_TIMEOUT_MS,
  AUTO_UPDATE_DOWNLOAD_SETTLE_TIMEOUT_MS,
  AUTO_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS,
  AUTO_UPDATE_FEED_CACHE_TTL_MS,
  AUTO_UPDATE_FEED_REFRESH_TIMEOUT_MS,
  AUTO_UPDATE_FOREGROUND_RECHECK_MIN_BACKGROUND_MS,
  AUTO_UPDATE_FOREGROUND_RECHECK_MIN_INTERVAL_MS,
  AUTO_UPDATE_POLL_INTERVAL_MS,
  AUTO_UPDATE_STALLED_DOWNLOAD_CANCELLATION_SUPPRESSION_MS,
  AUTO_UPDATE_STARTUP_DELAY_MS,
  BACKEND_FORCE_KILL_DELAY_MS,
  BACKEND_SHUTDOWN_TIMEOUT_MS,
  BROWSER_PERF_SAMPLE_INTERVAL_MS,
  DESKTOP_MENU_MAX_ZOOM_FACTOR,
  DESKTOP_MENU_MIN_ZOOM_FACTOR,
  DESKTOP_SCHEME,
  DESKTOP_UPDATE_ALLOW_PRERELEASE,
  DESKTOP_UPDATE_CHANNEL,
  LOG_FILE_MAX_BYTES,
  LOG_FILE_MAX_FILES,
  MENU_ACTION_CHANNEL,
  SYNARA_BROWSER_LABEL,
  UPDATE_STATE_CHANNEL,
  WINDOW_STATE_CHANNEL,
  ZOOM_FACTOR_CHANGED_CHANNEL,
} from "./main.constants";
import { formatErrorMessage, getSafeExternalUrl, normalizeCommitHash } from "./main.inputGuards";
import {
  resolveIconPath as resolveIconPathFromDir,
  resolveNotificationIconPath as resolveNotificationIconPathFromDir,
  resolveResourcePath as resolveResourcePathFromDir,
} from "./main.resources";
import { isStaticAssetRequest, resolveDesktopStaticPath } from "./main.staticAssets";
import { buildApplicationMenuTemplate } from "./main.menu";
import { NotificationBadgeState } from "./main.notificationBadge";
import { registerMainIpc } from "./main.ipc";
import { BackendProcessController } from "./main.backendProcess";
import { DesktopUpdateController } from "./main.updateController";

syncShellEnvironment();

function isBrokenStdIoError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EIO"
  );
}

function installBrokenStdIoGuard(): void {
  const patchWrite = (stream: NodeJS.WriteStream): void => {
    const originalWrite = stream.write.bind(stream);
    stream.write = ((
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      try {
        if (typeof encodingOrCallback === "function") {
          return originalWrite(chunk, encodingOrCallback);
        }
        if (callback !== undefined) {
          return originalWrite(chunk, encodingOrCallback, callback);
        }
        if (encodingOrCallback !== undefined) {
          return originalWrite(chunk, encodingOrCallback);
        }
        return originalWrite(chunk);
      } catch (error) {
        if (!isBrokenStdIoError(error)) {
          throw error;
        }
        if (typeof encodingOrCallback === "function") {
          encodingOrCallback(null);
        }
        callback?.(null);
        return false;
      }
    }) as typeof stream.write;
    stream.on("error", (error) => {
      if (!isBrokenStdIoError(error)) {
        throw error;
      }
    });
  };

  patchWrite(process.stdout);
  patchWrite(process.stderr);
}

installBrokenStdIoGuard();

const BASE_DIR =
  process.env.SYNARA_HOME?.trim() ||
  process.env.DPCODE_HOME?.trim() ||
  process.env.T3CODE_HOME?.trim() ||
  Path.join(OS.homedir(), ".synara");
const STATE_DIR = Path.join(BASE_DIR, "userdata");
const ROOT_DIR = Path.resolve(__dirname, "../../..");
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const APP_DISPLAY_NAME = isDevelopment ? "Synara (Dev)" : "Synara";
const APP_USER_MODEL_ID = isDevelopment ? "com.t3tools.synara.dev" : "com.t3tools.synara";
const LOG_DIR = Path.join(STATE_DIR, "logs");
const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const browserPerfLoggingEnabled =
  process.env.SYNARA_BROWSER_PERF === "1" ||
  process.env.DPCODE_BROWSER_PERF === "1" ||
  process.env.T3CODE_BROWSER_PERF === "1";

let mainWindow: BrowserWindow | null = null;
let backendPort = 0;
let backendAuthToken = "";
let backendHttpUrl = "";
let backendWsUrl = "";
let backendReadinessAbortController: AbortController | null = null;
let backendInitialWindowOpenInFlight: Promise<void> | null = null;
let isQuitting = false;
let desktopShutdownPromise: Promise<void> | null = null;
let desktopShutdownComplete = false;
let desktopProtocolRegistered = false;
let aboutCommitHashCache: string | null | undefined;
let appUpdateYmlCache: Record<string, string> | null | undefined;
let desktopLogSink: RotatingFileSink | null = null;
let backendLogSink: RotatingFileSink | null = null;
let restoreStdIoCapture: (() => void) | null = null;
let browserPerfInterval: ReturnType<typeof setInterval> | null = null;
const browserManager = new DesktopBrowserManager();
const notificationBadge = new NotificationBadgeState({
  setBadgeCount: (count) => app.setBadgeCount(count),
  getWindow: () => mainWindow,
});
let browserUsePipeServer: BrowserUsePipeServer | null = null;

browserManager.subscribe((state) => {
  sendBrowserState(mainWindow?.webContents, state);
});

browserManager.subscribeCopyLink((event) => {
  sendBrowserCopyLink(mainWindow?.webContents, event);
});

function startBrowserPerformanceLogging(): void {
  if (browserPerfInterval || !browserPerfLoggingEnabled) {
    return;
  }

  browserPerfInterval = setInterval(() => {
    const snapshot = browserManager.getPerformanceSnapshot();
    const trackedProcessIds = new Set(snapshot.trackedProcessIds);
    const processMetrics = app
      .getAppMetrics()
      .filter((metric) => trackedProcessIds.has(metric.pid))
      .map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        cpu: Number(metric.cpu.percentCPUUsage.toFixed(1)),
        memMb: Math.round(metric.memory.workingSetSize / 1024),
        name: metric.name,
      }));

    console.info(`[${SYNARA_BROWSER_LABEL} perf]`, {
      ...snapshot.counters,
      trackedProcessIds: snapshot.trackedProcessIds,
      processes: processMetrics,
    });
  }, BROWSER_PERF_SAMPLE_INTERVAL_MS);
  browserPerfInterval.unref();
}

async function ensureBrowserUsePipeServer(): Promise<void> {
  if (browserUsePipeServer) {
    return;
  }
  const server = new BrowserUsePipeServer(browserManager, {
    requestOpenPanel: () => {
      mainWindow?.webContents.send(BROWSER_IPC_CHANNELS.requestOpenPanel);
    },
  });
  await server.start();
  browserUsePipeServer = server;
}

let destructiveMenuIconCache: Electron.NativeImage | null | undefined;
const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
  platform: process.platform,
  processArch: process.arch,
  runningUnderArm64Translation: app.runningUnderARM64Translation === true,
});
function logTimestamp(): string {
  return new Date().toISOString();
}

function logScope(scope: string): string {
  return `${scope} run=${APP_RUN_ID}`;
}

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function writeDesktopLogHeader(message: string): void {
  if (!desktopLogSink) return;
  desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop")}] ${message}\n`);
}

function writeBackendSessionBoundary(phase: "START" | "END", details: string): void {
  if (!backendLogSink) return;
  const normalizedDetails = sanitizeLogValue(details);
  backendLogSink.write(
    `[${logTimestamp()}] ---- APP SESSION ${phase} run=${APP_RUN_ID} ${normalizedDetails} ----\n`,
  );
}

async function waitForBackendHttpReady(
  baseUrl: string,
  options?: Parameters<typeof waitForHttpReady>[1],
): Promise<void> {
  cancelBackendReadinessWait();
  const controller = new AbortController();
  backendReadinessAbortController = controller;

  try {
    await waitForHttpReady(baseUrl, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    if (backendReadinessAbortController === controller) {
      backendReadinessAbortController = null;
    }
  }
}

function cancelBackendReadinessWait(): void {
  backendReadinessAbortController?.abort();
  backendReadinessAbortController = null;
}

async function reserveBackendEndpoint(reason: string): Promise<void> {
  backendPort = await Effect.service(NetService).pipe(
    Effect.flatMap((net) => net.reserveLoopbackPort()),
    Effect.provide(NetService.layer),
    Effect.runPromise,
  );
  backendHttpUrl = `http://127.0.0.1:${backendPort}`;
  backendWsUrl = `ws://127.0.0.1:${backendPort}/?token=${encodeURIComponent(backendAuthToken)}`;
  process.env.SYNARA_DESKTOP_WS_URL = backendWsUrl;
  process.env.DPCODE_DESKTOP_WS_URL = backendWsUrl;
  process.env.T3CODE_DESKTOP_WS_URL = backendWsUrl;
  writeDesktopLogHeader(`${reason} resolved backend endpoint port=${backendPort}`);
}

async function waitForBackendWindowReady(baseUrl: string): Promise<"listening" | "http"> {
  return await waitForBackendStartupReady({
    listeningPromise: backendProcessController.getListeningPromise(),
    waitForHttpReady: () =>
      waitForBackendHttpReady(baseUrl, {
        path: "/health",
        timeoutMs: 60_000,
        isReady: async (response) => {
          if (!response.ok) {
            return false;
          }
          try {
            const payload = (await response.json()) as {
              startupReady?: unknown;
            };
            return payload.startupReady === true;
          } catch {
            return false;
          }
        },
      }),
    cancelHttpWait: cancelBackendReadinessWait,
  });
}

function ensureInitialBackendWindowOpen(baseUrl: string): void {
  openInitialBackendWindow({
    isDevelopment,
    baseUrl,
    hasExistingWindow: () => (mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null) !== null,
    createWindow: () => {
      mainWindow = createWindow();
    },
    getReadinessInFlight: () => backendInitialWindowOpenInFlight,
    setReadinessInFlight: (promise) => {
      backendInitialWindowOpenInFlight = promise;
    },
    waitForBackendWindowReady,
    writeLog: writeDesktopLogHeader,
    isReadinessAborted: isBackendReadinessAborted,
    formatErrorMessage,
    warn: (message, error) => {
      console.warn(message, error);
    },
  });
}

function writeDesktopStreamChunk(
  streamName: "stdout" | "stderr",
  chunk: unknown,
  encoding: BufferEncoding | undefined,
): void {
  if (!desktopLogSink) return;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : undefined);
  desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName)}] `);
  desktopLogSink.write(buffer);
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    desktopLogSink.write("\n");
  }
}

function installStdIoCapture(): void {
  if (!app.isPackaged || desktopLogSink === null || restoreStdIoCapture !== null) {
    return;
  }

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const patchWrite =
    (streamName: "stdout" | "stderr", originalWrite: typeof process.stdout.write) =>
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      writeDesktopStreamChunk(streamName, chunk, encoding);
      if (typeof encodingOrCallback === "function") {
        return originalWrite(chunk, encodingOrCallback);
      }
      if (callback !== undefined) {
        return originalWrite(chunk, encoding, callback);
      }
      if (encoding !== undefined) {
        return originalWrite(chunk, encoding);
      }
      return originalWrite(chunk);
    };

  process.stdout.write = patchWrite("stdout", originalStdoutWrite);
  process.stderr.write = patchWrite("stderr", originalStderrWrite);

  restoreStdIoCapture = () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    restoreStdIoCapture = null;
  };
}

function initializePackagedLogging(): void {
  if (!app.isPackaged) return;
  try {
    desktopLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "desktop-main.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    backendLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "server-child.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    installStdIoCapture();
    writeDesktopLogHeader(`runtime log capture enabled logDir=${LOG_DIR}`);
  } catch (error) {
    // Logging setup should never block app startup.
    console.error("[desktop] failed to initialize packaged logging", error);
  }
}

initializePackagedLogging();

function getDestructiveMenuIcon(): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") return undefined;
  if (destructiveMenuIconCache !== undefined) {
    return destructiveMenuIconCache ?? undefined;
  }
  try {
    const icon = nativeImage.createFromNamedImage("trash").resize({
      width: 14,
      height: 14,
    });
    if (icon.isEmpty()) {
      destructiveMenuIconCache = null;
      return undefined;
    }
    icon.setTemplateImage(true);
    destructiveMenuIconCache = icon;
    return icon;
  } catch {
    destructiveMenuIconCache = null;
    return undefined;
  }
}
const updateController = new DesktopUpdateController({
  autoUpdater,
  createCancellationToken: () => new CancellationToken(),
  getAppVersion: () => app.getVersion(),
  getAppName: () => app.getName(),
  desktopRuntimeInfo,
  getAllWindows: () => BrowserWindow.getAllWindows(),
  resolveAutoUpdateDisabledReason,
  readAppUpdateYml,
  getIsQuitting: () => isQuitting,
  setIsQuitting: (value) => {
    isQuitting = value;
  },
  stopBackendAndWaitForExit: () => stopBackendAndWaitForExit(),
  clearNotificationBadge: () => notificationBadge.clear(),
  formatErrorMessage,
  githubToken: () =>
    process.env.T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || "",
  constants: {
    stateChannel: UPDATE_STATE_CHANNEL,
    updateChannel: DESKTOP_UPDATE_CHANNEL,
    allowPrerelease: DESKTOP_UPDATE_ALLOW_PRERELEASE,
    checkTimeoutMs: AUTO_UPDATE_CHECK_TIMEOUT_MS,
    downloadSettleTimeoutMs: AUTO_UPDATE_DOWNLOAD_SETTLE_TIMEOUT_MS,
    downloadStallTimeoutMs: AUTO_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS,
    feedCacheTtlMs: AUTO_UPDATE_FEED_CACHE_TTL_MS,
    feedRefreshTimeoutMs: AUTO_UPDATE_FEED_REFRESH_TIMEOUT_MS,
    foregroundRecheckMinBackgroundMs: AUTO_UPDATE_FOREGROUND_RECHECK_MIN_BACKGROUND_MS,
    foregroundRecheckMinIntervalMs: AUTO_UPDATE_FOREGROUND_RECHECK_MIN_INTERVAL_MS,
    pollIntervalMs: AUTO_UPDATE_POLL_INTERVAL_MS,
    stalledCancellationSuppressionMs: AUTO_UPDATE_STALLED_DOWNLOAD_CANCELLATION_SUPPRESSION_MS,
    startupDelayMs: AUTO_UPDATE_STARTUP_DELAY_MS,
  },
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function resolveAppRoot(): string {
  if (!app.isPackaged) {
    return ROOT_DIR;
  }
  return app.getAppPath();
}

/**
 * Read the baked-in app-update.yml config (if applicable). The file ships inside
 * the package and never changes at runtime, so the parsed result is cached to keep
 * repeated callers off the synchronous-FS path on the main thread.
 */
function readAppUpdateYml(): Record<string, string> | null {
  if (appUpdateYmlCache !== undefined) {
    return appUpdateYmlCache;
  }
  appUpdateYmlCache = parseAppUpdateYml();
  return appUpdateYmlCache;
}

function parseAppUpdateYml(): Record<string, string> | null {
  try {
    // electron-updater reads from process.resourcesPath in packaged builds,
    // or dev-app-update.yml via app.getAppPath() in dev.
    const ymlPath = app.isPackaged
      ? Path.join(process.resourcesPath, "app-update.yml")
      : Path.join(app.getAppPath(), "dev-app-update.yml");
    const raw = FS.readFileSync(ymlPath, "utf-8");
    // The YAML is simple key-value pairs — avoid pulling in a YAML parser by
    // doing a line-based parse (fields: provider, owner, repo, releaseType, …).
    const entries: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
    }
    return entries.provider ? entries : null;
  } catch {
    return null;
  }
}

function resolveEmbeddedCommitHash(): string | null {
  const packageJsonPath = Path.join(resolveAppRoot(), "package.json");
  if (!FS.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const raw = FS.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { t3codeCommitHash?: unknown };
    return normalizeCommitHash(parsed.t3codeCommitHash);
  } catch {
    return null;
  }
}

function resolveAboutCommitHash(): string | null {
  if (aboutCommitHashCache !== undefined) {
    return aboutCommitHashCache;
  }

  const envCommitHash = normalizeCommitHash(process.env.T3CODE_COMMIT_HASH);
  if (envCommitHash) {
    aboutCommitHashCache = envCommitHash;
    return aboutCommitHashCache;
  }

  // Only packaged builds are required to expose commit metadata.
  if (!app.isPackaged) {
    aboutCommitHashCache = null;
    return aboutCommitHashCache;
  }

  aboutCommitHashCache = resolveEmbeddedCommitHash();

  return aboutCommitHashCache;
}

function resolveBackendEntry(): string {
  return Path.join(resolveAppRoot(), "apps/server/dist/index.mjs");
}

function resolveBackendCwd(): string {
  if (!app.isPackaged) {
    return resolveAppRoot();
  }
  return OS.homedir();
}

function resolveDesktopStaticDir(): string | null {
  const appRoot = resolveAppRoot();
  const candidates = [
    Path.join(appRoot, "apps/server/dist/client"),
    Path.join(appRoot, "apps/web/dist"),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(Path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

function handleFatalStartupError(stage: string, error: unknown): void {
  const message = formatErrorMessage(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  writeDesktopLogHeader(`fatal startup error stage=${stage} message=${message}`);
  console.error(`[desktop] fatal startup error (${stage})`, error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox("Synara failed to start", `Stage: ${stage}\n${message}${detail}`);
  }
  stopBackend();
  restoreStdIoCapture?.();
  app.quit();
}

function registerDesktopProtocol(): void {
  if (isDevelopment || desktopProtocolRegistered) return;

  const staticRoot = resolveDesktopStaticDir();
  if (!staticRoot) {
    throw new Error(
      "Desktop static bundle missing. Build apps/server (with bundled client) first.",
    );
  }

  const staticRootResolved = Path.resolve(staticRoot);
  const staticRootPrefix = `${staticRootResolved}${Path.sep}`;
  const fallbackIndex = Path.join(staticRootResolved, "index.html");

  protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
    try {
      const candidate = resolveDesktopStaticPath(staticRootResolved, request.url);
      const resolvedCandidate = Path.resolve(candidate);
      const isInRoot =
        resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
      const isAssetRequest = isStaticAssetRequest(request.url);

      if (!isInRoot || !FS.existsSync(resolvedCandidate)) {
        if (isAssetRequest) {
          callback({ error: -6 });
          return;
        }
        callback({ path: fallbackIndex });
        return;
      }

      callback({ path: resolvedCandidate });
    } catch {
      callback({ path: fallbackIndex });
    }
  });

  desktopProtocolRegistered = true;
}

function dispatchMenuAction(action: string): void {
  const existingWindow =
    BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0];
  const targetWindow = existingWindow ?? createWindow();
  if (!existingWindow) {
    mainWindow = targetWindow;
  }

  const send = () => {
    if (targetWindow.isDestroyed()) return;
    targetWindow.webContents.send(MENU_ACTION_CHANNEL, action);
    if (!targetWindow.isVisible()) {
      targetWindow.show();
    }
    targetWindow.focus();
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", send);
    return;
  }

  send();
}

function resolveMenuTargetWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
}

function resetWindowZoomFromMenu(): void {
  const window = resolveMenuTargetWindow();
  window?.webContents.setZoomFactor(1);
  emitZoomFactorChanged(window);
}

function adjustWindowZoomFromMenu(multiplier: number): void {
  const window = resolveMenuTargetWindow();
  const webContents = window?.webContents;
  if (!webContents) return;
  const nextZoomFactor = Math.min(
    DESKTOP_MENU_MAX_ZOOM_FACTOR,
    Math.max(DESKTOP_MENU_MIN_ZOOM_FACTOR, webContents.getZoomFactor() * multiplier),
  );
  webContents.setZoomFactor(nextZoomFactor);
  emitZoomFactorChanged(window);
}

function getDesktopWindowState(window: BrowserWindow | null) {
  return {
    isMaximized: window?.isMaximized() ?? false,
    isFullscreen: window?.isFullScreen() ?? false,
  };
}

function emitDesktopWindowState(window: BrowserWindow | null): void {
  window?.webContents.send(WINDOW_STATE_CHANNEL, getDesktopWindowState(window));
}

function emitZoomFactorChanged(window: BrowserWindow | null): void {
  if (!window) {
    return;
  }
  window.webContents.send(ZOOM_FACTOR_CHANGED_CHANNEL, window.webContents.getZoomFactor());
}

// A configured app-update.yml (or the mock-updates flag) is the prerequisite for any
// auto-update activity; centralized so the menu and the enable check stay in lockstep.
function hasConfiguredUpdateFeed(): boolean {
  return readAppUpdateYml() !== null || Boolean(process.env.T3CODE_DESKTOP_MOCK_UPDATES);
}

function resolveAutoUpdateDisabledReason(): string | null {
  return getAutoUpdateDisabledReason({
    isDevelopment,
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
    hasUpdateFeedConfig: hasConfiguredUpdateFeed(),
  });
}

function handleCheckForUpdatesMenuClick(): void {
  const disabledReason = resolveAutoUpdateDisabledReason();
  if (disabledReason) {
    console.info("[desktop-updater] Manual update check requested, but updates are disabled.");
    void dialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason,
      buttons: ["OK"],
    });
    return;
  }

  if (!BrowserWindow.getAllWindows().length) {
    mainWindow = createWindow();
  }
  void checkForUpdatesFromMenu();
}

async function checkForUpdatesFromMenu(): Promise<void> {
  await checkForUpdates("menu");

  const state = updateController.getState();
  if (state.status === "up-to-date") {
    void dialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `Synara ${state.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (state.status === "error") {
    void dialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: state.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    });
  }
}

function configureApplicationMenu(): void {
  const template = buildApplicationMenuTemplate({
    platform: process.platform,
    appName: app.name,
    dispatchMenuAction,
    handleCheckForUpdatesMenuClick,
    resetWindowZoomFromMenu,
    adjustWindowZoomFromMenu,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function resolveResourcePath(fileName: string): string | null {
  return resolveResourcePathFromDir(__dirname, fileName);
}

function resolveIconPath(ext: "ico" | "icns" | "png"): string | null {
  return resolveIconPathFromDir(__dirname, ext);
}

function resolveNotificationIconPath(): string | null {
  return resolveNotificationIconPathFromDir(__dirname);
}

// Reuse the existing desktop window when the app is launched again so users
// don't end up with multiple packaged instances racing the same local state.
function focusMainWindow(): void {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
}

// Show a native OS notification and refocus the app window when the alert is clicked.
function showDesktopNotification(input: {
  title: string;
  body?: string;
  silent?: boolean;
  threadId?: string;
}): boolean {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const threadId = typeof input.threadId === "string" ? input.threadId.trim() : "";
  if (title.length === 0 || !Notification.isSupported()) {
    return false;
  }

  const iconPath = resolveNotificationIconPath();
  const notification = new Notification({
    title,
    body,
    silent: input.silent === true,
    ...(iconPath ? { icon: iconPath } : {}),
  });
  if (!notificationBadge.isMainWindowForeground()) {
    notificationBadge.increment();
  }

  notification.on("click", () => {
    notificationBadge.clear();
    focusMainWindow();
    if (!mainWindow) {
      return;
    }
    if (threadId.length > 0) {
      mainWindow.webContents.send(MENU_ACTION_CHANNEL, `notification-open-thread:${threadId}`);
    }
  });

  notification.show();
  return true;
}

/**
 * Resolve the Electron userData directory path.
 *
 * Electron derives the default userData path from `productName` in
 * package.json. We override it to a clean lowercase Synara name while seeding
 * from legacy app profiles when needed.
 */
function resolveUserDataPath(): string {
  const appDataBase = resolveDesktopAppDataBase();
  const userDataPath = resolveDesktopUserDataPath({
    appDataBase,
    isDevelopment,
  });
  const seedResult = seedDesktopUserDataProfileFromLegacy({
    targetPath: userDataPath,
    legacyPaths: resolveLegacyDesktopUserDataPaths({
      appDataBase,
      isDevelopment,
    }),
  });
  if (seedResult.status === "seeded") {
    console.info("[desktop] Seeded Synara Electron profile from legacy profile", {
      sourcePath: seedResult.sourcePath,
      targetPath: seedResult.targetPath,
    });
  } else if (seedResult.status === "seed-failed") {
    console.warn("[desktop] Failed to seed Synara Electron profile from legacy profile", {
      sourcePath: seedResult.sourcePath,
      targetPath: seedResult.targetPath,
      error: seedResult.error,
    });
  }
  return userDataPath;
}

function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME);
  const commitHash = resolveAboutCommitHash();
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    version: commitHash ?? "unknown",
    copyright: `© ${new Date().getFullYear()} Emanuele Di Pietro`,
  });

  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }
}

// macOS 26 (Darwin 25+, "Tahoe") masks the full-bleed bundle icon into a clean squircle
// on its own, so we leave it completely untouched there. Older macOS does NOT round app
// icons, so the same square bundle icon would look square in the dock. Only on those
// older versions do we override the dock tile with a pre-rounded literal image (drawn
// as-is, no system styling). Baking transparent rounded corners into the bundle icon is
// not an option because that transparency is exactly what triggers Tahoe's Liquid Glass.
function applyLegacyMacDockIcon(): void {
  if (process.platform !== "darwin" || !app.dock) {
    return;
  }
  const darwinMajor = Number.parseInt(OS.release().split(".")[0] ?? "", 10);
  if (!Number.isFinite(darwinMajor) || darwinMajor >= 25) {
    return;
  }
  const iconPath = resolveResourcePath("dock-icon.png");
  if (!iconPath) {
    return;
  }
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    return;
  }
  app.dock.setIcon(image);
}

function emitUpdateState(): void {
  updateController.emitState();
}

function clearUpdatePollTimer(): void {
  updateController.clearPollTimer();
}

function clearUpdateBackgroundBlurTimer(): void {
  updateController.clearBackgroundBlurTimer();
}

function clearUpdateCheckTimeoutTimer(): void {
  updateController.clearCheckTimeoutTimer();
}

function markDesktopAppBackgrounded(): void {
  updateController.markBackgrounded();
}

function handleDesktopAppForegrounded(): void {
  updateController.handleForegrounded();
}

async function checkForUpdates(reason: string): Promise<void> {
  await updateController.checkForUpdates(reason);
}

async function downloadAvailableUpdate(): Promise<{
  accepted: boolean;
  completed: boolean;
}> {
  return updateController.downloadAvailableUpdate();
}

async function installDownloadedUpdate(): Promise<{
  accepted: boolean;
  completed: boolean;
}> {
  return updateController.installDownloadedUpdate();
}

function configureAutoUpdater(): void {
  hardenElectronUpdater({ BaseUpdater }, autoUpdater);
  if (!installResumableUpdateDownloader(autoUpdater as unknown as ResumableDownloaderTarget)) {
    console.warn(
      "[desktop-updater] Could not install resumable update downloader; falling back to default transfer.",
    );
  }
  updateController.configure();
}

function backendEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DPCODE_MODE: "desktop",
    DPCODE_NO_BROWSER: "1",
    DPCODE_PORT: String(backendPort),
    DPCODE_HOME: BASE_DIR,
    DPCODE_AUTH_TOKEN: backendAuthToken,
    [DPCODE_BROWSER_USE_PIPE_ENV]: SYNARA_BROWSER_USE_PIPE_PATH,
    [SYNARA_BROWSER_USE_PIPE_ENV]: SYNARA_BROWSER_USE_PIPE_PATH,
    T3CODE_MODE: "desktop",
    T3CODE_NO_BROWSER: "1",
    T3CODE_PORT: String(backendPort),
    T3CODE_HOME: BASE_DIR,
    T3CODE_AUTH_TOKEN: backendAuthToken,
    SYNARA_HOME: BASE_DIR,
    [T3CODE_BROWSER_USE_PIPE_ENV]: SYNARA_BROWSER_USE_PIPE_PATH,
  };
}

const backendProcessController = new BackendProcessController({
  spawn: ChildProcess.spawn,
  execPath: process.execPath,
  resolveBackendEntry,
  resolveBackendCwd,
  backendEntryExists: (entry) => FS.existsSync(entry),
  buildEnv: backendEnv,
  getBackendPort: () => backendPort,
  createListeningDetector: () => new ServerListeningDetector(),
  captureBackendLogs: () => true,
  writeBackendLog: (buffer) => {
    backendLogSink?.write(buffer);
  },
  writeSessionBoundary: writeBackendSessionBoundary,
  getIsQuitting: () => isQuitting,
  cancelReadinessWait: cancelBackendReadinessWait,
  reserveEndpoint: reserveBackendEndpoint,
  ensureInitialWindowOpen: () => ensureInitialBackendWindowOpen(backendHttpUrl),
  formatErrorMessage,
  forceKillDelayMs: BACKEND_FORCE_KILL_DELAY_MS,
  shutdownTimeoutMs: BACKEND_SHUTDOWN_TIMEOUT_MS,
});

function startBackend(): void {
  backendProcessController.start();
}

function stopBackend(): void {
  backendProcessController.stop();
}

async function stopBackendAndWaitForExit(timeoutMs = BACKEND_SHUTDOWN_TIMEOUT_MS): Promise<void> {
  await backendProcessController.stopAndWaitForExit(timeoutMs);
}

async function disposeBrowserUsePipeServerForShutdown(reason: string): Promise<void> {
  const pipeServer = browserUsePipeServer;
  browserUsePipeServer = null;
  if (!pipeServer) return;

  try {
    await pipeServer.dispose();
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    writeDesktopLogHeader(`${reason} browser-use pipe dispose failed message=${message}`);
    console.warn(`[desktop] Failed to dispose browser-use pipe during ${reason}: ${message}`);
  }
}

// Keeps Electron alive long enough for backend finalizers to reap provider child processes.
async function shutdownDesktopRuntime(reason: string): Promise<void> {
  if (desktopShutdownPromise) {
    return desktopShutdownPromise;
  }

  isQuitting = true;
  desktopShutdownPromise = (async () => {
    writeDesktopLogHeader(`${reason} shutdown start`);
    try {
      clearUpdateBackgroundBlurTimer();
      clearUpdateCheckTimeoutTimer();
      clearUpdatePollTimer();
      cancelBackendReadinessWait();
      await disposeBrowserUsePipeServerForShutdown(reason);
      await stopBackendAndWaitForExit();
      browserManager.dispose();
      restoreStdIoCapture?.();
      writeDesktopLogHeader(`${reason} shutdown complete`);
    } finally {
      desktopShutdownComplete = true;
    }
  })();

  return desktopShutdownPromise;
}

function requestGracefulAppQuit(reason: string): void {
  if (updateController.isInstallPreparing()) {
    writeDesktopLogHeader(`${reason} waiting for updater quit-and-install`);
    return;
  }

  void shutdownDesktopRuntime(reason)
    .catch((error: unknown) => {
      const message = formatErrorMessage(error);
      writeDesktopLogHeader(`${reason} shutdown failed message=${message}`);
      console.warn(`[desktop] Shutdown failed during ${reason}: ${message}`);
    })
    .finally(() => {
      app.quit();
    });
}

function registerIpcHandlers(): void {
  registerMainIpc(ipcMain, {
    getBackendWsUrl: () => backendWsUrl,
    resolveWsUrl: (url) => normalizeDesktopWsUrl(url) ?? resolveDesktopWsUrlFromEnv(process.env),
    getMainWindow: () => mainWindow,
    showConfirmDialog: showDesktopConfirmDialog,
    showNotification: showDesktopNotification,
    getDestructiveMenuIcon,
    getUpdateState: () => updateController.getState(),
    isQuitting: () => isQuitting,
    checkForUpdates,
    downloadAvailableUpdate,
    installDownloadedUpdate,
    registerExtraHandlers: (registeredIpcMain) => {
      registerDesktopVoiceTranscriptionHandler();
      startBrowserPerformanceLogging();
      void ensureBrowserUsePipeServer().catch((error) => {
        console.warn("[Synara browser] Failed to start browser-use native pipe", error);
      });
      registerBrowserIpcHandlers(registeredIpcMain, browserManager);
    },
  });
}

function getIconOption(): { icon: string } | Record<string, never> {
  if (process.platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = process.platform === "win32" ? "ico" : "png";
  const iconPath = resolveIconPath(ext);
  return iconPath ? { icon: iconPath } : {};
}

// macOS backs the translucent shell with window vibrancy, so the window is created
// transparent (`#00000000`) over the vibrancy material. Windows/Linux have no vibrancy:
// a transparent window there leaves backdrop-filter surfaces bleeding through and, on
// fractional DPI, rendering blurry. So off macOS we create an opaque window and skip the
// macOS-only options. The background tracks the OS light/dark appearance purely to avoid
// a bright flash before the renderer paints — the window is shown only after first paint
// (`show: false`), so this color is not expected to match a custom in-app theme exactly.
function getWindowMaterialOptions(): BrowserWindowConstructorOptions {
  if (process.platform !== "darwin") {
    return {
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#181818" : "#ffffff",
    };
  }
  return {
    vibrancy: "under-window",
    // "followWindow" lets macOS drop vibrancy blending to inactive when the
    // window is backgrounded, so WindowServer stops continuously recompositing
    // it. "active" forced full-cost blending even when the app was unfocused.
    visualEffectState: "followWindow",
    backgroundColor: "#00000000",
  };
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    ...getIconOption(),
    title: APP_DISPLAY_NAME,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: getMacTrafficLightPosition(),
    ...getWindowMaterialOptions(),
    webPreferences: {
      preload: Path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      // Let Chromium throttle renderer timers/rAF when the window is hidden.
      backgroundThrottling: true,
    },
  });
  browserManager.setWindow(window);

  window.webContents.on("context-menu", (event, params) => {
    event.preventDefault();

    const menuTemplate: MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuTemplate.push({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        });
      }
      if (params.dictionarySuggestions.length === 0) {
        menuTemplate.push({ label: "No suggestions", enabled: false });
      }
      menuTemplate.push({ type: "separator" });
    }

    if (params.mediaType === "image") {
      menuTemplate.push({
        label: "Copy Image",
        click: () => window.webContents.copyImageAt(params.x, params.y),
      });
      menuTemplate.push({ type: "separator" });
    }

    menuTemplate.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );

    Menu.buildFromTemplate(menuTemplate).popup({ window });
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });

  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_DISPLAY_NAME);
  });
  const emitCurrentWindowState = () => emitDesktopWindowState(window);
  window.on("maximize", emitCurrentWindowState);
  window.on("unmaximize", emitCurrentWindowState);
  window.on("minimize", emitCurrentWindowState);
  window.on("restore", emitCurrentWindowState);
  window.on("enter-full-screen", emitCurrentWindowState);
  window.on("leave-full-screen", emitCurrentWindowState);
  window.on("focus", emitCurrentWindowState);
  window.on("blur", emitCurrentWindowState);
  window.webContents.on("did-finish-load", () => {
    window.setTitle(APP_DISPLAY_NAME);
    emitDesktopWindowState(window);
    emitZoomFactorChanged(window);
    emitUpdateState();
  });
  window.once("ready-to-show", () => {
    // Launch filling the screen work area; the 1100x780 size above stays as the
    // restore bounds when the user toggles the window back out of maximized.
    window.maximize();
    window.show();
  });

  if (isDevelopment) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadURL(`${DESKTOP_SCHEME}://app/index.html`);
  }

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
    browserManager.setWindow(null);
  });

  return window;
}

function configureMediaPermissions(): void {
  const defaultSession = session.defaultSession;
  if (!defaultSession) {
    return;
  }

  defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === "media") {
      return process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("microphone") === "granted"
        : false;
    }
    return false;
  });

  defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission !== "media") {
      callback(false);
      return;
    }

    // Some Electron microphone requests omit `mediaTypes`, so denying here can suppress
    // the macOS permission prompt entirely even though the renderer asked for audio input.
    if (!shouldAllowMediaPermissionRequest(details)) {
      callback(false);
      return;
    }

    if (process.platform === "darwin") {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      if (status === "granted") {
        callback(true);
        return;
      }

      void systemPreferences.askForMediaAccess("microphone").then(callback, () => callback(false));
      return;
    }

    callback(true);
  });
}

// Override Electron's userData path before the `ready` event so that
// Chromium session data uses a filesystem-friendly directory name.
// Must be called synchronously at the top level — before `app.whenReady()`.
app.setPath("userData", resolveUserDataPath());

configureAppIdentity();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusMainWindow();
  });
}

async function bootstrap(): Promise<void> {
  writeDesktopLogHeader("bootstrap start");
  backendAuthToken = Crypto.randomBytes(24).toString("hex");
  await reserveBackendEndpoint("bootstrap");

  registerIpcHandlers();
  writeDesktopLogHeader("bootstrap ipc handlers registered");
  startBackend();
  writeDesktopLogHeader("bootstrap backend start requested");

  if (isDevelopment) {
    void waitForBackendWindowReady(backendHttpUrl)
      .then((source) => {
        writeDesktopLogHeader(`bootstrap backend ready source=${source}`);
        if (!mainWindow) {
          mainWindow = createWindow();
          writeDesktopLogHeader("bootstrap main window created");
        }
      })
      .catch((error) => {
        if (isBackendReadinessAborted(error)) {
          return;
        }
        writeDesktopLogHeader(
          `bootstrap backend readiness warning message=${formatErrorMessage(error)}`,
        );
        console.warn("[desktop] backend readiness check timed out during dev bootstrap", error);
        if (!mainWindow) {
          mainWindow = createWindow();
          writeDesktopLogHeader("bootstrap main window created after readiness warning");
        }
      });
    return;
  }

  ensureInitialBackendWindowOpen(backendHttpUrl);
}

app.on("before-quit", (event) => {
  writeDesktopLogHeader("before-quit received");
  if (desktopShutdownComplete) {
    return;
  }

  if (updateController.isQuitAndInstallInFlight()) {
    // Electron's updater owns this quit; canceling it would turn install into a plain app quit.
    writeDesktopLogHeader("before-quit allowing updater quit-and-install");
    return;
  }

  if (updateController.isInstallPreparing()) {
    // Keep user/system quits from preempting the pending updater install with a plain app.quit().
    writeDesktopLogHeader("before-quit waiting for updater quit-and-install");
    event.preventDefault();
    return;
  }

  event.preventDefault();
  requestGracefulAppQuit("before-quit");
});

if (hasSingleInstanceLock) {
  app
    .whenReady()
    .then(() => {
      writeDesktopLogHeader("app ready");
      configureAppIdentity();
      applyLegacyMacDockIcon();
      configureMediaPermissions();
      configureApplicationMenu();
      registerDesktopProtocol();
      configureAutoUpdater();
      void bootstrap().catch((error) => {
        handleFatalStartupError("bootstrap", error);
      });

      app.on("browser-window-blur", () => {
        markDesktopAppBackgrounded();
      });

      app.on("browser-window-focus", () => {
        handleDesktopAppForegrounded();
      });

      app.on("activate", () => {
        handleDesktopAppForegrounded();
        if (BrowserWindow.getAllWindows().length === 0) {
          if (!isDevelopment) {
            ensureInitialBackendWindowOpen(backendHttpUrl);
            return;
          }
          void waitForBackendWindowReady(backendHttpUrl)
            .catch((error) => {
              if (isBackendReadinessAborted(error)) {
                return;
              }
              console.warn(
                "[desktop] backend readiness check timed out during dev activate",
                error,
              );
            })
            .finally(() => {
              if (!mainWindow) {
                mainWindow = createWindow();
              }
            });
          return;
        }
        focusMainWindow();
      });
    })
    .catch((error) => {
      handleFatalStartupError("whenReady", error);
    });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

if (process.platform !== "win32") {
  process.on("SIGINT", () => {
    if (desktopShutdownPromise) return;
    writeDesktopLogHeader("SIGINT received");
    requestGracefulAppQuit("SIGINT");
  });

  process.on("SIGTERM", () => {
    if (desktopShutdownPromise) return;
    writeDesktopLogHeader("SIGTERM received");
    requestGracefulAppQuit("SIGTERM");
  });
}
