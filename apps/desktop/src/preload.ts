import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "@t3tools/contracts";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const BROWSER_STATE_CHANNEL = "desktop:browser-state";
const BROWSER_OPEN_CHANNEL = "desktop:browser-open";
const BROWSER_CLOSE_CHANNEL = "desktop:browser-close";
const BROWSER_HIDE_CHANNEL = "desktop:browser-hide";
const BROWSER_GET_STATE_CHANNEL = "desktop:browser-get-state";
const BROWSER_SET_BOUNDS_CHANNEL = "desktop:browser-set-bounds";
const BROWSER_NAVIGATE_CHANNEL = "desktop:browser-navigate";
const BROWSER_RELOAD_CHANNEL = "desktop:browser-reload";
const BROWSER_GO_BACK_CHANNEL = "desktop:browser-go-back";
const BROWSER_GO_FORWARD_CHANNEL = "desktop:browser-go-forward";
const BROWSER_NEW_TAB_CHANNEL = "desktop:browser-new-tab";
const BROWSER_CLOSE_TAB_CHANNEL = "desktop:browser-close-tab";
const BROWSER_SELECT_TAB_CHANNEL = "desktop:browser-select-tab";
const BROWSER_OPEN_DEVTOOLS_CHANNEL = "desktop:browser-open-devtools";
const wsUrl = process.env.T3CODE_DESKTOP_WS_URL ?? null;

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: () => wsUrl,
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  setTheme: (theme) => ipcRenderer.invoke(SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
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
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
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
  browser: {
    open: (input) => ipcRenderer.invoke(BROWSER_OPEN_CHANNEL, input),
    close: (input) => ipcRenderer.invoke(BROWSER_CLOSE_CHANNEL, input),
    hide: (input) => ipcRenderer.invoke(BROWSER_HIDE_CHANNEL, input),
    getState: (input) => ipcRenderer.invoke(BROWSER_GET_STATE_CHANNEL, input),
    setPanelBounds: (input) => ipcRenderer.invoke(BROWSER_SET_BOUNDS_CHANNEL, input),
    navigate: (input) => ipcRenderer.invoke(BROWSER_NAVIGATE_CHANNEL, input),
    reload: (input) => ipcRenderer.invoke(BROWSER_RELOAD_CHANNEL, input),
    goBack: (input) => ipcRenderer.invoke(BROWSER_GO_BACK_CHANNEL, input),
    goForward: (input) => ipcRenderer.invoke(BROWSER_GO_FORWARD_CHANNEL, input),
    newTab: (input) => ipcRenderer.invoke(BROWSER_NEW_TAB_CHANNEL, input),
    closeTab: (input) => ipcRenderer.invoke(BROWSER_CLOSE_TAB_CHANNEL, input),
    selectTab: (input) => ipcRenderer.invoke(BROWSER_SELECT_TAB_CHANNEL, input),
    openDevTools: (input) => ipcRenderer.invoke(BROWSER_OPEN_DEVTOOLS_CHANNEL, input),
    onState: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (typeof state !== "object" || state === null) return;
        listener(state as Parameters<typeof listener>[0]);
      };

      ipcRenderer.on(BROWSER_STATE_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(BROWSER_STATE_CHANNEL, wrappedListener);
      };
    },
  },
} satisfies DesktopBridge);
