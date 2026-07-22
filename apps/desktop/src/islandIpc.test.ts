import type { IpcMain, WebContents } from "electron";
import type {
  DesktopIslandAction,
  DesktopIslandSessionSnapshot,
  DesktopIslandSnapshot,
  DesktopIslandState,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { ISLAND_IPC_CHANNELS } from "./ipcChannels";
import {
  DESKTOP_ISLAND_MAX_SESSIONS,
  DESKTOP_ISLAND_TEXT_LIMITS,
  parseDesktopIslandSnapshot,
  registerIslandIpcHandlers,
  sendIslandAction,
  sendIslandState,
} from "./islandIpc";

function makeSession(
  overrides: Partial<DesktopIslandSessionSnapshot> = {},
): DesktopIslandSessionSnapshot {
  return {
    id: "thread-1",
    title: "Fix transcript scroll",
    provider: "Codex",
    elapsed: "1m",
    activity: "Reading file",
    detail: "Read MessagesTimeline.tsx 219 lines",
    status: "working",
    changeSummary: "+42 −11",
    ...overrides,
  };
}

function activitySnapshot(): DesktopIslandSnapshot {
  return {
    version: 1,
    mode: "activity",
    primaryThreadId: "thread-1",
    sessions: [makeSession()],
  };
}

describe("parseDesktopIslandSnapshot", () => {
  it("rebuilds valid activity, approval, and canonical hidden snapshots", () => {
    const activity = activitySnapshot();
    expect(parseDesktopIslandSnapshot(activity)).toEqual(activity);

    const approval: DesktopIslandSnapshot = {
      version: 1,
      mode: "approval",
      primaryThreadId: "thread-1",
      sessions: [
        makeSession({
          activity: "Waiting for permission",
          detail: "Edit apps/server/src/auth/middleware.ts",
          status: "approval",
        }),
      ],
      approval: {
        threadId: "thread-1",
        requestId: "request-1",
        requestKind: "file-change",
      },
    };
    expect(parseDesktopIslandSnapshot(approval)).toEqual(approval);

    expect(
      parseDesktopIslandSnapshot({
        version: 1,
        mode: "idle",
        primaryThreadId: null,
        sessions: [],
      }),
    ).toEqual({
      version: 1,
      mode: "idle",
      primaryThreadId: null,
      sessions: [],
    });
  });

  it("enforces session count, code-point text caps, and sanitized display text", () => {
    const tooManySessions = {
      ...activitySnapshot(),
      sessions: Array.from({ length: DESKTOP_ISLAND_MAX_SESSIONS + 1 }, (_, index) =>
        makeSession({ id: `thread-${index}` }),
      ),
    };
    expect(parseDesktopIslandSnapshot(tooManySessions)).toBeNull();

    expect(
      parseDesktopIslandSnapshot({
        ...activitySnapshot(),
        sessions: [makeSession({ title: "😀".repeat(DESKTOP_ISLAND_TEXT_LIMITS.title + 1) })],
      }),
    ).toBeNull();
    expect(
      parseDesktopIslandSnapshot({
        ...activitySnapshot(),
        sessions: [makeSession({ detail: "Read safe.ts\u202Ehidden" })],
      }),
    ).toBeNull();
    expect(
      parseDesktopIslandSnapshot({
        ...activitySnapshot(),
        sessions: [makeSession({ activity: "  Reading   file  " })],
      }),
    ).toBeNull();
  });

  it("rejects ambiguous identities, extra fields, and incomplete approval targets", () => {
    expect(
      parseDesktopIslandSnapshot({
        ...activitySnapshot(),
        primaryThreadId: "missing-thread",
      }),
    ).toBeNull();
    expect(
      parseDesktopIslandSnapshot({
        ...activitySnapshot(),
        sessions: [makeSession(), makeSession()],
      }),
    ).toBeNull();
    expect(
      parseDesktopIslandSnapshot({
        ...activitySnapshot(),
        surprise: "untrusted",
      }),
    ).toBeNull();
    expect(
      parseDesktopIslandSnapshot({
        version: 1,
        mode: "approval",
        primaryThreadId: "thread-1",
        sessions: [makeSession({ status: "approval" })],
        approval: {
          threadId: "different-thread",
          requestId: "request-1",
          requestKind: "command",
        },
      }),
    ).toBeNull();
    expect(
      parseDesktopIslandSnapshot({
        version: 1,
        mode: "idle",
        primaryThreadId: "thread-1",
        sessions: [],
      }),
    ).toBeNull();
    expect(
      parseDesktopIslandSnapshot({
        version: 1,
        mode: "idle",
        primaryThreadId: "thread-1",
        sessions: [makeSession()],
      }),
    ).toBeNull();
    expect(
      parseDesktopIslandSnapshot({
        version: 1,
        mode: "idle",
        primaryThreadId: null,
        sessions: [makeSession()],
      }),
    ).toBeNull();
  });
});

describe("native island IPC handlers", () => {
  it("publishes only validated snapshots and exposes the manager state", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      removeHandler: vi.fn(),
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    const state: DesktopIslandState = {
      status: "ready",
      nativeActive: true,
      restartCount: 0,
      renderedRevision: 7,
      failure: null,
    };
    const manager = {
      getState: vi.fn(() => state),
      publishSnapshot: vi.fn(() => 8),
    };

    registerIslandIpcHandlers(ipcMain, manager);

    const getState = handlers.get(ISLAND_IPC_CHANNELS.getState);
    const updateSnapshot = handlers.get(ISLAND_IPC_CHANNELS.updateSnapshot);
    expect(await getState?.({})).toEqual(state);
    expect(await updateSnapshot?.({}, activitySnapshot())).toBe(8);
    expect(manager.publishSnapshot).toHaveBeenCalledWith(activitySnapshot());

    expect(await updateSnapshot?.({}, { version: 2, mode: "idle", sessions: [] })).toBeNull();
    expect(manager.publishSnapshot).toHaveBeenCalledTimes(1);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(ISLAND_IPC_CHANNELS.getState);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(ISLAND_IPC_CHANNELS.updateSnapshot);
  });

  it("pushes state and action events over dedicated channels", () => {
    const webContents = { send: vi.fn() } as unknown as WebContents;
    const state: DesktopIslandState = {
      status: "restarting",
      nativeActive: false,
      restartCount: 1,
      renderedRevision: null,
      failure: { code: "helper-crashed", message: "The helper exited." },
    };
    const action: DesktopIslandAction = {
      actionId: "action-1",
      revision: 3,
      kind: "allow-once",
      threadId: "thread-1",
      requestId: "request-1",
    };

    sendIslandState(webContents, state);
    sendIslandAction(webContents, action);

    expect(webContents.send).toHaveBeenNthCalledWith(1, ISLAND_IPC_CHANNELS.state, state);
    expect(webContents.send).toHaveBeenNthCalledWith(2, ISLAND_IPC_CHANNELS.action, action);
    expect(() => sendIslandState(null, state)).not.toThrow();
    expect(() => sendIslandAction(undefined, action)).not.toThrow();
  });
});
