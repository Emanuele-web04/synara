// FILE: main.ipc.test.ts
// Purpose: Lock the main-process IPC channel registration and dispatch against injected deps.

import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  getFocusedWindow: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  isNotificationSupported: vi.fn(() => true),
  setThemeSource: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getFocusedWindow: electronMocks.getFocusedWindow,
  },
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog,
    showSaveDialog: electronMocks.showSaveDialog,
  },
  Menu: { buildFromTemplate: vi.fn() },
  Notification: { isSupported: electronMocks.isNotificationSupported },
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
  },
  nativeTheme: {
    set themeSource(value: unknown) {
      electronMocks.setThemeSource(value);
    },
  },
}));

import type { IpcMain } from "electron";

import { registerMainIpc, type MainIpcDeps } from "./main.ipc";
import {
  CONFIRM_CHANNEL,
  NOTIFICATIONS_IS_SUPPORTED_CHANNEL,
  NOTIFICATIONS_SHOW_CHANNEL,
  PICK_FOLDER_CHANNEL,
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_GET_STATE_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
} from "./main.constants";
import { DESKTOP_WS_URL_CHANNEL } from "./desktopWsBridge";

type HandleFn = (event: unknown, ...args: unknown[]) => unknown;
type OnFn = (event: unknown, ...args: unknown[]) => void;

function createFakeIpcMain() {
  const handlers = new Map<string, HandleFn>();
  const listeners = new Map<string, OnFn>();
  const ipcMain = {
    handle: vi.fn((channel: string, fn: HandleFn) => handlers.set(channel, fn)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    on: vi.fn((channel: string, fn: OnFn) => listeners.set(channel, fn)),
    removeAllListeners: vi.fn((channel: string) => listeners.delete(channel)),
  } as unknown as IpcMain;
  return { ipcMain, handlers, listeners };
}

function createDeps(overrides: Partial<MainIpcDeps> = {}): MainIpcDeps {
  return {
    getBackendWsUrl: vi.fn(() => "ws://127.0.0.1:1234/?token=abc"),
    resolveWsUrl: vi.fn((url: string) => `resolved:${url}`),
    getMainWindow: vi.fn(() => null),
    showConfirmDialog: vi.fn(() => true),
    showNotification: vi.fn(() => true),
    getDestructiveMenuIcon: vi.fn(() => undefined),
    getUpdateState: vi.fn(() => ({ status: "idle" }) as never),
    isQuitting: vi.fn(() => false),
    checkForUpdates: vi.fn(async () => {}),
    downloadAvailableUpdate: vi.fn(async () => ({
      accepted: true,
      completed: true,
    })),
    installDownloadedUpdate: vi.fn(async () => ({
      accepted: true,
      completed: true,
    })),
    registerExtraHandlers: vi.fn(),
    ...overrides,
  };
}

describe("registerMainIpc", () => {
  beforeEach(() => {
    electronMocks.getFocusedWindow.mockReset().mockReturnValue(null);
    electronMocks.showOpenDialog.mockReset();
    electronMocks.isNotificationSupported.mockReset().mockReturnValue(true);
  });

  it("registers every renderer-facing channel and the ws-url listener", () => {
    const { ipcMain, handlers, listeners } = createFakeIpcMain();
    registerMainIpc(ipcMain, createDeps());

    expect(listeners.has(DESKTOP_WS_URL_CHANNEL)).toBe(true);
    for (const channel of [
      PICK_FOLDER_CHANNEL,
      CONFIRM_CHANNEL,
      UPDATE_GET_STATE_CHANNEL,
      UPDATE_CHECK_CHANNEL,
      UPDATE_DOWNLOAD_CHANNEL,
      UPDATE_INSTALL_CHANNEL,
      NOTIFICATIONS_IS_SUPPORTED_CHANNEL,
      NOTIFICATIONS_SHOW_CHANNEL,
    ]) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it("invokes registerExtraHandlers with the ipcMain instance", () => {
    const { ipcMain } = createFakeIpcMain();
    const deps = createDeps();
    registerMainIpc(ipcMain, deps);
    expect(deps.registerExtraHandlers).toHaveBeenCalledWith(ipcMain);
  });

  it("ws-url listener returns the resolved url from deps", () => {
    const { ipcMain, listeners } = createFakeIpcMain();
    registerMainIpc(ipcMain, createDeps());
    const event = { returnValue: "" };
    listeners.get(DESKTOP_WS_URL_CHANNEL)?.(event);
    expect(event.returnValue).toBe("resolved:ws://127.0.0.1:1234/?token=abc");
  });

  it("confirm channel delegates to showConfirmDialog and short-circuits non-strings", async () => {
    const { ipcMain, handlers } = createFakeIpcMain();
    const deps = createDeps();
    registerMainIpc(ipcMain, deps);
    const handler = handlers.get(CONFIRM_CHANNEL);

    await expect(handler?.({}, 42)).resolves.toBe(false);
    expect(deps.showConfirmDialog).not.toHaveBeenCalled();

    await expect(handler?.({}, "Proceed?")).resolves.toBe(true);
    expect(deps.showConfirmDialog).toHaveBeenCalledWith("Proceed?", null);
  });

  it("update channels return the latest state and route through deps", async () => {
    const { ipcMain, handlers } = createFakeIpcMain();
    const state = { status: "available" } as never;
    const deps = createDeps({ getUpdateState: vi.fn(() => state) });
    registerMainIpc(ipcMain, deps);

    await expect(handlers.get(UPDATE_GET_STATE_CHANNEL)?.({})).resolves.toBe(state);

    await expect(handlers.get(UPDATE_CHECK_CHANNEL)?.({})).resolves.toBe(state);
    expect(deps.checkForUpdates).toHaveBeenCalledWith("renderer");

    await expect(handlers.get(UPDATE_DOWNLOAD_CHANNEL)?.({})).resolves.toEqual({
      accepted: true,
      completed: true,
      state,
    });
  });

  it("install channel refuses to act while quitting", async () => {
    const { ipcMain, handlers } = createFakeIpcMain();
    const deps = createDeps({ isQuitting: vi.fn(() => true) });
    registerMainIpc(ipcMain, deps);

    const result = await handlers.get(UPDATE_INSTALL_CHANNEL)?.({});
    expect(result).toMatchObject({ accepted: false, completed: false });
    expect(deps.installDownloadedUpdate).not.toHaveBeenCalled();
  });

  it("notification channels delegate to deps and electron", async () => {
    const { ipcMain, handlers } = createFakeIpcMain();
    const deps = createDeps();
    registerMainIpc(ipcMain, deps);

    await expect(handlers.get(NOTIFICATIONS_IS_SUPPORTED_CHANNEL)?.({})).resolves.toBe(true);

    await handlers.get(NOTIFICATIONS_SHOW_CHANNEL)?.(
      {},
      {
        title: "Hi",
        body: "There",
        silent: true,
        threadId: "t1",
      },
    );
    expect(deps.showNotification).toHaveBeenCalledWith({
      title: "Hi",
      body: "There",
      silent: true,
      threadId: "t1",
    });
  });
});
