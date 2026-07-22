// FILE: islandIpc.ts
// Purpose: Validates renderer island snapshots and centralizes desktop island IPC wiring.
// Layer: Desktop IPC adapter
// Depends on: Electron IPC, the bounded island snapshot contract, and the helper manager port.

import type { IpcMain, WebContents } from "electron";
import {
  DESKTOP_ISLAND_MAX_SESSIONS,
  DESKTOP_ISLAND_TEXT_LIMITS,
  type DesktopIslandAction,
  type DesktopIslandApprovalSnapshot,
  type DesktopIslandSessionSnapshot,
  type DesktopIslandSessionStatus,
  type DesktopIslandSnapshot,
  type DesktopIslandState,
} from "@synara/contracts";

import { ISLAND_IPC_CHANNELS } from "./ipcChannels";

export { DESKTOP_ISLAND_MAX_SESSIONS, DESKTOP_ISLAND_TEXT_LIMITS } from "@synara/contracts";

const MAX_IDENTIFIER_CHARACTERS = 512;
const DISPLAY_CONTROL_CHARACTERS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/u;
const SESSION_STATUSES = new Set<DesktopIslandSessionStatus>([
  "working",
  "approval",
  "responding",
  "done",
  "error",
  "idle",
]);
const APPROVAL_REQUEST_KINDS = new Set<DesktopIslandApprovalSnapshot["requestKind"]>([
  "command",
  "file-read",
  "file-change",
]);

interface DesktopIslandManagerPort {
  getState(): DesktopIslandState;
  publishSnapshot(payload: object): number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    codePointLength(value) <= MAX_IDENTIFIER_CHARACTERS &&
    value.trim() === value &&
    !DISPLAY_CONTROL_CHARACTERS.test(value)
  );
}

function isDisplayText(
  value: unknown,
  maximumCharacters: number,
  required: boolean,
): value is string {
  return (
    typeof value === "string" &&
    (!required || value.length > 0) &&
    codePointLength(value) <= maximumCharacters &&
    !DISPLAY_CONTROL_CHARACTERS.test(value) &&
    value.replace(/\s+/gu, " ").trim() === value
  );
}

function parseSession(value: unknown): DesktopIslandSessionSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    !hasOnlyKeys(
      value,
      new Set([
        "id",
        "title",
        "provider",
        "elapsed",
        "activity",
        "detail",
        "status",
        "changeSummary",
      ]),
    ) ||
    !isIdentifier(value.id) ||
    !isDisplayText(value.title, DESKTOP_ISLAND_TEXT_LIMITS.title, true) ||
    !isDisplayText(value.provider, DESKTOP_ISLAND_TEXT_LIMITS.provider, true) ||
    !isDisplayText(value.elapsed, DESKTOP_ISLAND_TEXT_LIMITS.elapsed, false) ||
    !isDisplayText(value.activity, DESKTOP_ISLAND_TEXT_LIMITS.activity, true) ||
    !isDisplayText(value.detail, DESKTOP_ISLAND_TEXT_LIMITS.detail, false) ||
    !isDisplayText(value.changeSummary, DESKTOP_ISLAND_TEXT_LIMITS.changeSummary, false) ||
    typeof value.status !== "string" ||
    !SESSION_STATUSES.has(value.status as DesktopIslandSessionStatus)
  ) {
    return null;
  }

  return {
    id: value.id,
    title: value.title,
    provider: value.provider,
    elapsed: value.elapsed,
    activity: value.activity,
    detail: value.detail,
    status: value.status as DesktopIslandSessionStatus,
    changeSummary: value.changeSummary,
  };
}

function parseApproval(value: unknown): DesktopIslandApprovalSnapshot | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["threadId", "requestId", "requestKind"])) ||
    !isIdentifier(value.threadId) ||
    !isIdentifier(value.requestId) ||
    typeof value.requestKind !== "string" ||
    !APPROVAL_REQUEST_KINDS.has(value.requestKind as DesktopIslandApprovalSnapshot["requestKind"])
  ) {
    return null;
  }

  return {
    threadId: value.threadId,
    requestId: value.requestId,
    requestKind: value.requestKind as DesktopIslandApprovalSnapshot["requestKind"],
  };
}

/**
 * Treat the renderer as untrusted at the context-isolation boundary. Rebuild a
 * small value containing only the fields Swift understands instead of passing
 * the incoming structured-clone object through to the helper.
 */
export function parseDesktopIslandSnapshot(value: unknown): DesktopIslandSnapshot | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.mode !== "activity" && value.mode !== "approval" && value.mode !== "idle") ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > DESKTOP_ISLAND_MAX_SESSIONS
  ) {
    return null;
  }

  const allowedKeys =
    value.mode === "approval"
      ? new Set(["version", "mode", "primaryThreadId", "sessions", "approval"])
      : new Set(["version", "mode", "primaryThreadId", "sessions"]);
  if (!hasOnlyKeys(value, allowedKeys)) return null;

  const sessions: DesktopIslandSessionSnapshot[] = [];
  const sessionIds = new Set<string>();
  for (const candidate of value.sessions) {
    const session = parseSession(candidate);
    if (!session || sessionIds.has(session.id)) return null;
    sessionIds.add(session.id);
    sessions.push(session);
  }

  const primaryThreadId = value.primaryThreadId;
  if (primaryThreadId !== null && !isIdentifier(primaryThreadId)) return null;
  if (primaryThreadId !== null && !sessionIds.has(primaryThreadId)) return null;

  if (value.mode === "idle") {
    if (primaryThreadId !== null || sessions.length !== 0) return null;
    return {
      version: 1,
      mode: "idle",
      primaryThreadId: null,
      sessions: [],
    };
  }

  if (typeof primaryThreadId !== "string" || sessions.length === 0) return null;
  if (value.mode === "activity") {
    return {
      version: 1,
      mode: "activity",
      primaryThreadId,
      sessions,
    };
  }

  const approval = parseApproval(value.approval);
  const primarySession = sessions.find((session) => session.id === primaryThreadId);
  if (!approval || approval.threadId !== primaryThreadId || primarySession?.status !== "approval") {
    return null;
  }

  return {
    version: 1,
    mode: "approval",
    primaryThreadId,
    sessions,
    approval,
  };
}

export function sendIslandState(
  webContents: WebContents | null | undefined,
  state: DesktopIslandState,
): void {
  webContents?.send(ISLAND_IPC_CHANNELS.state, state);
}

export function sendIslandAction(
  webContents: WebContents | null | undefined,
  action: DesktopIslandAction,
): void {
  webContents?.send(ISLAND_IPC_CHANNELS.action, action);
}

export function registerIslandIpcHandlers(
  ipcMain: IpcMain,
  manager: DesktopIslandManagerPort,
): void {
  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.getState);
  ipcMain.handle(ISLAND_IPC_CHANNELS.getState, async () => manager.getState());

  ipcMain.removeHandler(ISLAND_IPC_CHANNELS.updateSnapshot);
  ipcMain.handle(ISLAND_IPC_CHANNELS.updateSnapshot, async (_event, input: unknown) => {
    const snapshot = parseDesktopIslandSnapshot(input);
    return snapshot ? manager.publishSnapshot(snapshot) : null;
  });
}
