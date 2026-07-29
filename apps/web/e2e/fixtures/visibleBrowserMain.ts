import * as path from "node:path";

import { app, BrowserWindow, ipcMain } from "electron";
import type { ThreadBrowserState, ThreadId } from "@synara/contracts";

import { DesktopBrowserManager } from "../../../desktop/src/browserManager";
import { BrowserUsePipeServer } from "../../../desktop/src/browserUsePipeServer";
import { createBrowserPanelHideScheduler } from "../../src/components/BrowserPanel.logic";

const pipePath = process.env.SYNARA_BROWSER_HOST_PIPE_PATH;
const capability = process.env.SYNARA_BROWSER_HOST_CAPABILITY;
const shellPath = process.env.SYNARA_E2E_SHELL_PATH;
const threadId = process.env.SYNARA_E2E_THREAD_ID as ThreadId | undefined;
const synaraHome = process.env.SYNARA_HOME;

if (!pipePath || !capability || !shellPath || !threadId || !synaraHome) {
  throw new Error("The visible-browser Electron fixture requires its isolated E2E environment.");
}

app.setPath("userData", path.join(synaraHome, "electron-userdata"));

const browserManager = new DesktopBrowserManager();
let mainWindow: BrowserWindow | null = null;
let latestState: ThreadBrowserState | null = null;
let shellReady = false;
const rendererLifecycleHide = createBrowserPanelHideScheduler();
function pushState(): void {
  if (shellReady && latestState && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("synara-e2e:browser-state", latestState);
  }
}

browserManager.subscribe((state) => {
  latestState = state;
  pushState();
});

ipcMain.on("synara-e2e:shell-ready", () => {
  shellReady = true;
  pushState();
});

ipcMain.handle(
  "synara-e2e:attach-webview",
  (event, input: { readonly tabId: string; readonly webContentsId: number }) =>
    browserManager.attachWebview({ threadId, ...input }, event.sender.id),
);

const pipeServer = new BrowserUsePipeServer(browserManager, {
  pipePath,
  capability,
  requestOpenPanel: (requestedThreadId) => {
    if (requestedThreadId !== threadId) throw new Error("Unexpected E2E thread scope.");
    // Exercise React development's setup/cleanup/setup sequence against the
    // real desktop human-control boundary. The remount must cancel the passive
    // cleanup before it can masquerade as a user takeover.
    rendererLifecycleHide.schedule(threadId, () => browserManager.hide({ threadId }));
    rendererLifecycleHide.cancel(threadId);
    browserManager.setPanelBounds({
      threadId,
      surface: "renderer",
      bounds: { x: 0, y: 34, width: 1_000, height: 726 },
    });
    pushState();
    mainWindow?.webContents.send("synara-e2e:open-panel");
  },
});

Object.assign(globalThis, {
  __synaraVisibleBrowserE2E: {
    browserManager,
    threadId,
    pipePath,
  },
});

app.whenReady().then(async () => {
  mainWindow = new BrowserWindow({
    width: 1_000,
    height: 760,
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  browserManager.setWindow(mainWindow);
  await mainWindow.loadFile(shellPath);
  await pipeServer.start();
});

app.on("before-quit", () => {
  browserManager.dispose();
  void pipeServer.dispose();
});
