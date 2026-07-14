// FILE: ipcChannels.ts
// Purpose: Defines the data-only IPC channel contract shared by Electron main and preload.
// Layer: Desktop IPC contract

export const DESKTOP_IPC_CHANNELS = {
  pickFolder: "desktop:pick-folder",
  saveFile: "desktop:save-file",
  confirm: "desktop:confirm",
  setTheme: "desktop:set-theme",
  contextMenu: "desktop:context-menu",
  openExternal: "desktop:open-external",
  showInFolder: "desktop:show-in-folder",
  clipboardWriteImage: "desktop:clipboard-write-image",
  windowMinimize: "desktop:window-minimize",
  windowToggleMaximize: "desktop:window-toggle-maximize",
  windowClose: "desktop:window-close",
  windowGetState: "desktop:window-get-state",
  windowState: "desktop:window-state",
  menuAction: "desktop:menu-action",
  updateState: "desktop:update-state",
  updateGetState: "desktop:update-get-state",
  updateCheck: "desktop:update-check",
  updateDownload: "desktop:update-download",
  updateInstall: "desktop:update-install",
  notificationsIsSupported: "desktop:notifications-is-supported",
  notificationsShow: "desktop:notifications-show",
  zoomFactor: "desktop:zoom-factor",
  zoomFactorChanged: "desktop:zoom-factor-changed",
  wsUrl: "desktop:get-ws-url",
  transcribeVoice: "desktop:server-transcribe-voice",
  storageMigration: {
    read: "desktop:storage-migration-read",
    acknowledge: "desktop:storage-migration-acknowledge",
  },
  browser: {
    state: "desktop:browser-state",
    open: "desktop:browser-open",
    close: "desktop:browser-close",
    hide: "desktop:browser-hide",
    getState: "desktop:browser-get-state",
    setBounds: "desktop:browser-set-bounds",
    attachWebview: "desktop:browser-attach-webview",
    detachWebview: "desktop:browser-detach-webview",
    requestOpenPanel: "desktop:browser-use-request-open-panel",
    copyLink: "desktop:browser-copy-link",
    requestCopyLink: "desktop:browser-request-copy-link",
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
  },
} as const;

export const BROWSER_IPC_CHANNELS = DESKTOP_IPC_CHANNELS.browser;
export const STORAGE_MIGRATION_IPC_CHANNELS = DESKTOP_IPC_CHANNELS.storageMigration;
export const DESKTOP_WS_URL_CHANNEL = DESKTOP_IPC_CHANNELS.wsUrl;
export const SERVER_TRANSCRIBE_VOICE_CHANNEL = DESKTOP_IPC_CHANNELS.transcribeVoice;
