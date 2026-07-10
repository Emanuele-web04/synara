import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "@synara/contracts";
import { BROWSER_IPC_CHANNELS } from "./browserIpc";
import {
  DESKTOP_WS_URL_CHANNEL,
  normalizeDesktopWsUrl,
  resolveDesktopWsUrlFromEnv,
} from "./desktopWsBridge";
import { SERVER_TRANSCRIBE_VOICE_CHANNEL } from "./voiceTranscription";
import { STORAGE_MIGRATION_IPC_CHANNELS } from "./desktopStorageMigration";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const SAVE_FILE_CHANNEL = "desktop:save-file";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const SHOW_IN_FOLDER_CHANNEL = "desktop:show-in-folder";
const CLIPBOARD_WRITE_IMAGE_CHANNEL = "desktop:clipboard-write-image";
const WINDOW_MINIMIZE_CHANNEL = "desktop:window-minimize";
const WINDOW_TOGGLE_MAXIMIZE_CHANNEL = "desktop:window-toggle-maximize";
const WINDOW_CLOSE_CHANNEL = "desktop:window-close";
const WINDOW_GET_STATE_CHANNEL = "desktop:window-get-state";
const WINDOW_STATE_CHANNEL = "desktop:window-state";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const NOTIFICATIONS_IS_SUPPORTED_CHANNEL = "desktop:notifications-is-supported";
const NOTIFICATIONS_SHOW_CHANNEL = "desktop:notifications-show";
const ZOOM_FACTOR_CHANNEL = "desktop:zoom-factor";
const ZOOM_FACTOR_CHANGED_CHANNEL = "desktop:zoom-factor-changed";

function getDesktopWsUrl(): string | null {
  try {
    const ipcWsUrl = normalizeDesktopWsUrl(ipcRenderer.sendSync(DESKTOP_WS_URL_CHANNEL));
    return ipcWsUrl ?? resolveDesktopWsUrlFromEnv(process.env);
  } catch {
    return resolveDesktopWsUrlFromEnv(process.env);
  }
}

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: getDesktopWsUrl,
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
  saveFile: (input) => ipcRenderer.invoke(SAVE_FILE_CHANNEL, input),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  setTheme: (theme) => ipcRenderer.invoke(SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  showInFolder: (path: string) => ipcRenderer.invoke(SHOW_IN_FOLDER_CHANNEL, path),
  shell: {
    showInFolder: (path: string) => ipcRenderer.invoke(SHOW_IN_FOLDER_CHANNEL, path),
  },
  clipboard: {
    writeImagePngDataUrl: (dataUrl: string) =>
      ipcRenderer.invoke(CLIPBOARD_WRITE_IMAGE_CHANNEL, dataUrl),
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke(WINDOW_MINIMIZE_CHANNEL),
    toggleMaximize: () => ipcRenderer.invoke(WINDOW_TOGGLE_MAXIMIZE_CHANNEL),
    close: () => ipcRenderer.invoke(WINDOW_CLOSE_CHANNEL),
    getState: () => ipcRenderer.invoke(WINDOW_GET_STATE_CHANNEL),
    onState: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (typeof state !== "object" || state === null) return;
        listener(state as Parameters<typeof listener>[0]);
      };

      ipcRenderer.on(WINDOW_STATE_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(WINDOW_STATE_CHANNEL, wrappedListener);
      };
    },
  },
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  getZoomFactor: () => {
    const factor = ipcRenderer.sendSync(ZOOM_FACTOR_CHANNEL);
    return typeof factor === "number" && Number.isFinite(factor) && factor > 0 ? factor : 1;
  },
  onZoomFactorChange: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, factor: unknown) => {
      if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) return;
      listener(factor);
    };

    ipcRenderer.on(ZOOM_FACTOR_CHANGED_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(ZOOM_FACTOR_CHANGED_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  checkForUpdates: () => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  notifications: {
    isSupported: () => ipcRenderer.invoke(NOTIFICATIONS_IS_SUPPORTED_CHANNEL),
    show: (input) => ipcRenderer.invoke(NOTIFICATIONS_SHOW_CHANNEL, input),
  },
  storageMigration: {
    readSnapshot: () => ipcRenderer.sendSync(STORAGE_MIGRATION_IPC_CHANNELS.read),
    acknowledgeSnapshot: () => ipcRenderer.invoke(STORAGE_MIGRATION_IPC_CHANNELS.acknowledge),
  },
  server: {
    transcribeVoice: (input) => ipcRenderer.invoke(SERVER_TRANSCRIBE_VOICE_CHANNEL, input),
  },
  browser: {
    open: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.open, input),
    close: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.close, input),
    hide: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.hide, input),
    getState: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.getState, input),
    setPanelBounds: async (input) => {
      ipcRenderer.send(BROWSER_IPC_CHANNELS.setBounds, input);
    },
    attachWebview: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.attachWebview, input),
    detachWebview: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.detachWebview, input),
    copyLink: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.requestCopyLink, input),
    copyScreenshotToClipboard: (input) =>
      ipcRenderer.invoke(BROWSER_IPC_CHANNELS.copyScreenshotToClipboard, input),
    captureScreenshot: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.captureScreenshot, input),
    executeCdp: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.executeCdp, input),
    navigate: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.navigate, input),
    reload: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.reload, input),
    goBack: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.goBack, input),
    goForward: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.goForward, input),
    newTab: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.newTab, input),
    closeTab: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.closeTab, input),
    selectTab: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.selectTab, input),
    openDevTools: (input) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.openDevTools, input),
    onState: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (typeof state !== "object" || state === null) return;
        listener(state as Parameters<typeof listener>[0]);
      };

      ipcRenderer.on(BROWSER_IPC_CHANNELS.state, wrappedListener);
      return () => {
        ipcRenderer.removeListener(BROWSER_IPC_CHANNELS.state, wrappedListener);
      };
    },
    onBrowserUseOpenPanelRequest: (listener) => {
      const wrappedListener = () => listener();
      ipcRenderer.on(BROWSER_IPC_CHANNELS.requestOpenPanel, wrappedListener);
      return () => {
        ipcRenderer.removeListener(BROWSER_IPC_CHANNELS.requestOpenPanel, wrappedListener);
      };
    },
    onBrowserCopyLink: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (typeof payload !== "object" || payload === null) return;
        listener(payload as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(BROWSER_IPC_CHANNELS.copyLink, wrappedListener);
      return () => {
        ipcRenderer.removeListener(BROWSER_IPC_CHANNELS.copyLink, wrappedListener);
      };
    },
  },
} satisfies DesktopBridge);
