// FILE: browserIpc.ts
// Purpose: Centralizes the desktop browser IPC contract and handler wiring.
// Layer: Desktop IPC adapter
// Depends on: Electron ipcMain/webContents and DesktopBrowserManager

import type { IpcMain, WebContents } from "electron";

import type {
  BrowserAttachWebviewInput,
  BrowserCaptureScreenshotResult,
  BrowserExecuteCdpInput,
  BrowserNavigateInput,
  BrowserNewTabInput,
  BrowserOpenInput,
  BrowserSetPanelBoundsInput,
  BrowserTabInput,
  BrowserThreadInput,
  ThreadBrowserState,
} from "@t3tools/contracts";

import type { DesktopBrowserManager } from "./browserManager";

export const BROWSER_IPC_CHANNELS = {
  state: "desktop:browser-state",
  open: "desktop:browser-open",
  close: "desktop:browser-close",
  hide: "desktop:browser-hide",
  getState: "desktop:browser-get-state",
  setBounds: "desktop:browser-set-bounds",
  attachWebview: "desktop:browser-attach-webview",
  requestOpenPanel: "desktop:browser-use-request-open-panel",
  copyScreenshotToClipboard: "desktop:browser-copy-screenshot-to-clipboard",
  captureScreenshot: "desktop:browser-capture-screenshot",
  executeCdp: "desktop:browser-execute-cdp",
  navigate: "desktop:browser-navigate",
  reload: "desktop:browser-reload",
  goBack: "desktop:browser-go-back",
  goForward: "desktop:browser-go-forward",
  newTab: "desktop:browser-new-tab",
  closeTab: "desktop:browser-close-tab",
  selectTab: "desktop:browser-select-tab",
  openDevTools: "desktop:browser-open-devtools",
} as const;

// Pushes the latest browser state snapshot to the renderer shell.
export function sendBrowserState(
  webContents: WebContents | null | undefined,
  state: ThreadBrowserState,
): void {
  webContents?.send(BROWSER_IPC_CHANNELS.state, state);
}

// Registers the desktop browser bridge in one place so main.ts stays focused on app boot.
export function registerBrowserIpcHandlers(
  ipcMain: IpcMain,
  browserManager: DesktopBrowserManager,
): void {
  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.open);
  ipcMain.handle(BROWSER_IPC_CHANNELS.open, async (_event, input: BrowserOpenInput) =>
    browserManager.open(input),
  );

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.close);
  ipcMain.handle(BROWSER_IPC_CHANNELS.close, async (_event, input: BrowserThreadInput) =>
    browserManager.close(input),
  );

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.hide);
  ipcMain.handle(BROWSER_IPC_CHANNELS.hide, async (_event, input: BrowserThreadInput) => {
    browserManager.hide(input);
  });

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.getState);
  ipcMain.handle(BROWSER_IPC_CHANNELS.getState, async (_event, input: BrowserThreadInput) =>
    browserManager.getState(input),
  );

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.setBounds);
  ipcMain.removeAllListeners(BROWSER_IPC_CHANNELS.setBounds);
  ipcMain.on(BROWSER_IPC_CHANNELS.setBounds, (_event, input: BrowserSetPanelBoundsInput) => {
    browserManager.setPanelBounds(input);
  });

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.attachWebview);
  ipcMain.handle(
    BROWSER_IPC_CHANNELS.attachWebview,
    async (_event, input: BrowserAttachWebviewInput) => browserManager.attachWebview(input),
  );

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.captureScreenshot);
  ipcMain.handle(
    BROWSER_IPC_CHANNELS.captureScreenshot,
    async (_event, input: BrowserTabInput): Promise<BrowserCaptureScreenshotResult> =>
      browserManager.captureScreenshot(input),
  );

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.copyScreenshotToClipboard);
  ipcMain.handle(
    BROWSER_IPC_CHANNELS.copyScreenshotToClipboard,
    async (_event, input: BrowserTabInput) => {
      await browserManager.copyScreenshotToClipboard(input);
    },
  );

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.executeCdp);
  ipcMain.handle(BROWSER_IPC_CHANNELS.executeCdp, async (_event, input: BrowserExecuteCdpInput) =>
    browserManager.executeCdp(input),
  );

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.navigate);
  ipcMain.handle(BROWSER_IPC_CHANNELS.navigate, async (_event, input: BrowserNavigateInput) =>
    browserManager.navigate(input),
  );

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.reload);
  ipcMain.handle(BROWSER_IPC_CHANNELS.reload, async (_event, input: BrowserTabInput) =>
    browserManager.reload(input),
  );

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.goBack);
  ipcMain.handle(BROWSER_IPC_CHANNELS.goBack, async (_event, input: BrowserTabInput) =>
    browserManager.goBack(input),
  );

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.goForward);
  ipcMain.handle(BROWSER_IPC_CHANNELS.goForward, async (_event, input: BrowserTabInput) =>
    browserManager.goForward(input),
  );

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.newTab);
  ipcMain.handle(BROWSER_IPC_CHANNELS.newTab, async (_event, input: BrowserNewTabInput) =>
    browserManager.newTab(input),
  );

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.closeTab);
  ipcMain.handle(BROWSER_IPC_CHANNELS.closeTab, async (_event, input: BrowserTabInput) =>
    browserManager.closeTab(input),
  );

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.selectTab);
  ipcMain.handle(BROWSER_IPC_CHANNELS.selectTab, async (_event, input: BrowserTabInput) =>
    browserManager.selectTab(input),
  );

  ipcMain.removeHandler(BROWSER_IPC_CHANNELS.openDevTools);
  ipcMain.handle(BROWSER_IPC_CHANNELS.openDevTools, async (_event, input: BrowserTabInput) => {
    browserManager.openDevTools(input);
  });
}
