// FILE: main.ipc.ts
// Purpose: Register the desktop main-process IPC handlers against injected runtime dependencies.
// Layer: Desktop main process
// Exports: registerMainIpc, MainIpcDeps.

import * as FS from "node:fs";
import * as Path from "node:path";

import {
  BrowserWindow,
  dialog,
  type IpcMain,
  type IpcMainEvent,
  Menu,
  type MenuItemConstructorOptions,
  nativeTheme,
  Notification,
  shell,
} from "electron";
import type {
  ContextMenuItem,
  DesktopWindowState,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@t3tools/contracts";

import {
  CONFIRM_CHANNEL,
  CONTEXT_MENU_CHANNEL,
  NOTIFICATIONS_IS_SUPPORTED_CHANNEL,
  NOTIFICATIONS_SHOW_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  PICK_FOLDER_CHANNEL,
  SAVE_FILE_CHANNEL,
  SET_THEME_CHANNEL,
  SHOW_IN_FOLDER_CHANNEL,
  WINDOW_CLOSE_CHANNEL,
  WINDOW_GET_STATE_CHANNEL,
  WINDOW_MINIMIZE_CHANNEL,
  WINDOW_STATE_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
  ZOOM_FACTOR_CHANNEL,
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_GET_STATE_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
} from "./main.constants";
import { getSafeExternalUrl, getSafeTheme, isSaveFileInput } from "./main.inputGuards";
import { DESKTOP_WS_URL_CHANNEL } from "./desktopWsBridge";

interface UpdateActionResult {
  readonly accepted: boolean;
  readonly completed: boolean;
}

function getDesktopWindowState(window: BrowserWindow | null): DesktopWindowState {
  return {
    isMaximized: window?.isMaximized() ?? false,
    isFullscreen: window?.isFullScreen() ?? false,
  };
}

function emitDesktopWindowState(window: BrowserWindow | null): DesktopWindowState {
  const state = getDesktopWindowState(window);
  window?.webContents.send(WINDOW_STATE_CHANNEL, state);
  return state;
}

function getTargetWindow(deps: MainIpcDeps): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? deps.getMainWindow();
}

export interface MainIpcDeps {
  readonly getBackendWsUrl: () => string;
  readonly resolveWsUrl: (backendWsUrl: string) => string | null;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly showConfirmDialog: (
    message: string,
    owner: BrowserWindow | null,
  ) => Promise<boolean> | boolean;
  readonly showNotification: (input: {
    title: string;
    body?: string;
    silent?: boolean;
    threadId?: string;
  }) => boolean;
  readonly getDestructiveMenuIcon: () => Electron.NativeImage | undefined;
  readonly getUpdateState: () => DesktopUpdateState;
  readonly isQuitting: () => boolean;
  readonly checkForUpdates: (reason: string) => Promise<void>;
  readonly downloadAvailableUpdate: () => Promise<UpdateActionResult>;
  readonly installDownloadedUpdate: () => Promise<UpdateActionResult>;
  readonly registerExtraHandlers: (ipcMain: IpcMain) => void;
}

// Registers every renderer-facing IPC channel for the main process. Channel names and
// dispatch behavior must stay identical to the original inline registration.
export function registerMainIpc(ipcMain: IpcMain, deps: MainIpcDeps): void {
  ipcMain.removeAllListeners(DESKTOP_WS_URL_CHANNEL);
  ipcMain.on(DESKTOP_WS_URL_CHANNEL, (event: IpcMainEvent) => {
    // The backend port is reserved at runtime, so preload asks main for the
    // live URL instead of trusting build-time or inherited renderer env.
    event.returnValue = deps.resolveWsUrl(deps.getBackendWsUrl());
  });

  ipcMain.removeHandler(PICK_FOLDER_CHANNEL);
  ipcMain.handle(PICK_FOLDER_CHANNEL, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? deps.getMainWindow();
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.removeHandler(SAVE_FILE_CHANNEL);
  ipcMain.handle(SAVE_FILE_CHANNEL, async (_event, input: unknown) => {
    if (!isSaveFileInput(input)) {
      throw new Error("Invalid save file input.");
    }

    const owner = BrowserWindow.getFocusedWindow() ?? deps.getMainWindow();
    const options = {
      defaultPath: input.defaultFilename,
      ...(input.filters ? { filters: input.filters } : {}),
    };
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      return null;
    }

    await FS.promises.writeFile(result.filePath, input.contents, "utf8");
    return result.filePath;
  });

  ipcMain.removeHandler(CONFIRM_CHANNEL);
  ipcMain.handle(CONFIRM_CHANNEL, async (_event, message: unknown) => {
    if (typeof message !== "string") {
      return false;
    }

    const owner = BrowserWindow.getFocusedWindow() ?? deps.getMainWindow();
    return deps.showConfirmDialog(message, owner);
  });

  ipcMain.removeHandler(SET_THEME_CHANNEL);
  ipcMain.handle(SET_THEME_CHANNEL, async (_event, rawTheme: unknown) => {
    const theme = getSafeTheme(rawTheme);
    if (!theme) {
      return;
    }

    nativeTheme.themeSource = theme;
  });

  ipcMain.removeHandler(CONTEXT_MENU_CHANNEL);
  ipcMain.handle(
    CONTEXT_MENU_CHANNEL,
    async (_event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = items
        .filter((item) => typeof item.id === "string" && typeof item.label === "string")
        .map((item) => ({
          id: item.id,
          label: item.label,
          separatorBefore: item.separatorBefore === true,
          destructive: item.destructive === true,
        }));
      if (normalizedItems.length === 0) {
        return null;
      }

      const popupPosition =
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x >= 0 &&
        position.y >= 0
          ? {
              x: Math.floor(position.x),
              y: Math.floor(position.y),
            }
          : null;

      const window = BrowserWindow.getFocusedWindow() ?? deps.getMainWindow();
      if (!window) return null;

      return new Promise<string | null>((resolve) => {
        const template: MenuItemConstructorOptions[] = [];
        let hasInsertedDestructiveSeparator = false;
        for (const item of normalizedItems) {
          const shouldInsertSeparator =
            item.separatorBefore ||
            (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0);
          if (shouldInsertSeparator && template.length > 0) {
            template.push({ type: "separator" });
          }
          if (item.destructive) {
            hasInsertedDestructiveSeparator = true;
          }
          const itemOption: MenuItemConstructorOptions = {
            label: item.label,
            click: () => resolve(item.id),
          };
          if (item.destructive) {
            const destructiveIcon = deps.getDestructiveMenuIcon();
            if (destructiveIcon) {
              itemOption.icon = destructiveIcon;
            }
          }
          template.push(itemOption);
        }

        const menu = Menu.buildFromTemplate(template);
        menu.popup({
          window,
          ...popupPosition,
          callback: () => resolve(null),
        });
      });
    },
  );

  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, rawUrl: unknown) => {
    const externalUrl = getSafeExternalUrl(rawUrl);
    if (!externalUrl) {
      return false;
    }

    try {
      await shell.openExternal(externalUrl);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.removeHandler(SHOW_IN_FOLDER_CHANNEL);
  ipcMain.handle(SHOW_IN_FOLDER_CHANNEL, async (_event, rawPath: unknown) => {
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      throw new Error("Missing folder path.");
    }
    const resolvedPath = Path.resolve(rawPath);

    let stats: FS.Stats;
    try {
      stats = await FS.promises.stat(resolvedPath);
    } catch {
      throw new Error(`Folder not found: ${resolvedPath}`);
    }

    if (stats.isDirectory()) {
      const errorMessage = await shell.openPath(resolvedPath);
      if (errorMessage.trim().length > 0) {
        throw new Error(errorMessage);
      }
      return;
    }

    shell.showItemInFolder(resolvedPath);
  });

  ipcMain.removeHandler(WINDOW_MINIMIZE_CHANNEL);
  ipcMain.handle(WINDOW_MINIMIZE_CHANNEL, async () => {
    const window = getTargetWindow(deps);
    window?.minimize();
    return emitDesktopWindowState(window);
  });

  ipcMain.removeHandler(WINDOW_TOGGLE_MAXIMIZE_CHANNEL);
  ipcMain.handle(WINDOW_TOGGLE_MAXIMIZE_CHANNEL, async () => {
    const window = getTargetWindow(deps);
    if (window?.isMaximized()) {
      window.unmaximize();
    } else {
      window?.maximize();
    }
    return emitDesktopWindowState(window);
  });

  ipcMain.removeHandler(WINDOW_CLOSE_CHANNEL);
  ipcMain.handle(WINDOW_CLOSE_CHANNEL, async () => {
    const window = getTargetWindow(deps);
    const state = getDesktopWindowState(window);
    window?.close();
    return state;
  });

  ipcMain.removeHandler(WINDOW_GET_STATE_CHANNEL);
  ipcMain.handle(WINDOW_GET_STATE_CHANNEL, async () =>
    getDesktopWindowState(getTargetWindow(deps)),
  );

  ipcMain.removeAllListeners(ZOOM_FACTOR_CHANNEL);
  ipcMain.on(ZOOM_FACTOR_CHANNEL, (event: IpcMainEvent) => {
    event.returnValue = getTargetWindow(deps)?.webContents.getZoomFactor() ?? 1;
  });

  ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL);
  ipcMain.handle(UPDATE_GET_STATE_CHANNEL, async () => deps.getUpdateState());

  ipcMain.removeHandler(UPDATE_CHECK_CHANNEL);
  ipcMain.handle(UPDATE_CHECK_CHANNEL, async () => {
    await deps.checkForUpdates("renderer");
    return deps.getUpdateState();
  });

  ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL);
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
    const result = await deps.downloadAvailableUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: deps.getUpdateState(),
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, async () => {
    if (deps.isQuitting()) {
      return {
        accepted: false,
        completed: false,
        state: deps.getUpdateState(),
      } satisfies DesktopUpdateActionResult;
    }
    const result = await deps.installDownloadedUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: deps.getUpdateState(),
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(NOTIFICATIONS_IS_SUPPORTED_CHANNEL);
  ipcMain.handle(NOTIFICATIONS_IS_SUPPORTED_CHANNEL, async () => Notification.isSupported());

  ipcMain.removeHandler(NOTIFICATIONS_SHOW_CHANNEL);
  ipcMain.handle(
    NOTIFICATIONS_SHOW_CHANNEL,
    async (
      _event,
      input:
        | {
            title?: unknown;
            body?: unknown;
            silent?: unknown;
            threadId?: unknown;
          }
        | null
        | undefined,
    ) =>
      deps.showNotification({
        title: typeof input?.title === "string" ? input.title : "",
        body: typeof input?.body === "string" ? input.body : "",
        silent: input?.silent === true,
        ...(typeof input?.threadId === "string" ? { threadId: input.threadId } : {}),
      }),
  );

  deps.registerExtraHandlers(ipcMain);
}
