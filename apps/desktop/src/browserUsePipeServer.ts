// FILE: browserUsePipeServer.ts
// Purpose: Exposes the in-app browser over a Codex-compatible browser-use native pipe.
// Layer: Desktop browser automation bridge
// Depends on: DesktopBrowserManager and Node net server primitives

import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import type { BrowserExecuteCdpInput, ThreadBrowserState, ThreadId } from "@t3tools/contracts";

import type { DesktopBrowserManager } from "./browserManager";

const BROWSER_USE_HEADER_BYTES = 4;
const BROWSER_USE_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const BROWSER_USE_INITIAL_URL = "about:blank";
const BROWSER_USE_PANEL_READY_TIMEOUT_MS = 2_000;
const BROWSER_USE_PANEL_READY_POLL_MS = 50;
const BROWSER_USE_PIPE_DIR = "codex-browser-use";
const BROWSER_USE_PIPE_NAME_PREFIX = "dpcode-iab";
export const DPCODE_BROWSER_USE_PIPE_ENV = "DPCODE_BROWSER_USE_PIPE_PATH";
export const T3CODE_BROWSER_USE_PIPE_ENV = "T3CODE_BROWSER_USE_PIPE_PATH";

type BrowserUseRpcId = string | number;

interface BrowserUseRpcRequest {
  id?: BrowserUseRpcId;
  method?: string;
  params?: unknown;
}

interface BrowserUseTrackedTab {
  id: number;
  threadId: ThreadId;
  tabId: string;
}

interface BrowserUsePipeServerOptions {
  pipePath?: string;
  requestOpenPanel?: () => void | Promise<void>;
}

export function resolveDefaultBrowserUsePipePath(platform = process.platform): string {
  if (platform === "win32") {
    return String.raw`\\.\pipe\codex-browser-use-${BROWSER_USE_PIPE_NAME_PREFIX}-${process.pid}`;
  }
  return Path.join(
    OS.tmpdir(),
    BROWSER_USE_PIPE_DIR,
    `${BROWSER_USE_PIPE_NAME_PREFIX}-${process.pid}.sock`,
  );
}

export function resolveConfiguredBrowserUsePipePath(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  const configured =
    env[DPCODE_BROWSER_USE_PIPE_ENV]?.trim() || env[T3CODE_BROWSER_USE_PIPE_ENV]?.trim();
  return configured || resolveDefaultBrowserUsePipePath(platform);
}

export const DPCODE_BROWSER_USE_PIPE_PATH = resolveConfiguredBrowserUsePipePath();

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requireSessionId(params: unknown): string {
  const sessionId = asString(asObject(params)?.session_id);
  if (!sessionId) {
    throw new Error("Missing required browser session_id");
  }
  return sessionId;
}

function encodeBrowserUseFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(BROWSER_USE_HEADER_BYTES);
  if (OS.endianness() === "LE") {
    header.writeUInt32LE(payload.length, 0);
  } else {
    header.writeUInt32BE(payload.length, 0);
  }
  return Buffer.concat([header, payload]);
}

function decodeBrowserUseFrames(buffer: Buffer): { messages: string[]; remaining: Buffer } | null {
  let offset = 0;
  const messages: string[] = [];
  while (buffer.length - offset >= BROWSER_USE_HEADER_BYTES) {
    const messageLength =
      OS.endianness() === "LE" ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    if (messageLength > BROWSER_USE_MAX_MESSAGE_BYTES) {
      return null;
    }
    const frameLength = BROWSER_USE_HEADER_BYTES + messageLength;
    if (buffer.length - offset < frameLength) {
      break;
    }
    messages.push(
      buffer.subarray(offset + BROWSER_USE_HEADER_BYTES, offset + frameLength).toString("utf8"),
    );
    offset += frameLength;
  }
  return {
    messages,
    remaining: buffer.subarray(offset),
  };
}

function ensurePipeParentDirectory(pipePath: string): void {
  if (process.platform === "win32") {
    return;
  }
  FS.mkdirSync(Path.dirname(pipePath), { recursive: true });
}

function cleanupPipePath(pipePath: string): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    const stat = FS.lstatSync(pipePath);
    if (!stat.isSocket() && !stat.isFile()) {
      return;
    }
    FS.unlinkSync(pipePath);
  } catch {
    // Ignore stale socket cleanup failures.
  }
}

export class BrowserUsePipeServer {
  private readonly sockets = new Set<Net.Socket>();
  private readonly pendingBySocket = new Map<Net.Socket, Buffer>();
  private readonly trackedTabByKey = new Map<string, BrowserUseTrackedTab>();
  private readonly trackedTabById = new Map<number, BrowserUseTrackedTab>();
  private readonly selectedTrackedTabIdBySessionId = new Map<string, number>();
  private readonly cdpListenerDisposeBySessionId = new Map<string, () => void>();
  private readonly server: Net.Server;
  private readonly pipePath: string;
  private readonly requestOpenPanel: (() => void | Promise<void>) | undefined;
  private nextTrackedTabId = 1;
  private started = false;

  constructor(
    private readonly browserManager: DesktopBrowserManager,
    options: BrowserUsePipeServerOptions | string = DPCODE_BROWSER_USE_PIPE_PATH,
  ) {
    this.pipePath =
      typeof options === "string" ? options : (options.pipePath ?? DPCODE_BROWSER_USE_PIPE_PATH);
    this.requestOpenPanel = typeof options === "string" ? undefined : options.requestOpenPanel;
    this.server = Net.createServer((socket) => this.handleSocketConnection(socket));
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    ensurePipeParentDirectory(this.pipePath);
    cleanupPipePath(this.pipePath);
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.pipePath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.started = true;
  }

  async dispose(): Promise<void> {
    for (const dispose of this.cdpListenerDisposeBySessionId.values()) {
      dispose();
    }
    this.cdpListenerDisposeBySessionId.clear();
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.pendingBySocket.clear();
    if (this.started) {
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
      });
      this.started = false;
    }
    cleanupPipePath(this.pipePath);
  }

  private handleSocketConnection(socket: Net.Socket): void {
    this.sockets.add(socket);
    this.pendingBySocket.set(socket, Buffer.alloc(0));
    socket.on("data", (chunk) => this.handleSocketData(socket, chunk));
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.pendingBySocket.delete(socket);
    });
    socket.on("error", () => {
      this.sockets.delete(socket);
      this.pendingBySocket.delete(socket);
      socket.destroy();
    });
  }

  private handleSocketData(socket: Net.Socket, chunk: Buffer): void {
    const decoded = decodeBrowserUseFrames(
      Buffer.concat([this.pendingBySocket.get(socket) ?? Buffer.alloc(0), chunk]),
    );
    if (!decoded) {
      this.pendingBySocket.delete(socket);
      socket.destroy();
      return;
    }
    this.pendingBySocket.set(socket, decoded.remaining);
    for (const message of decoded.messages) {
      void this.handleIncomingMessage(socket, message);
    }
  }

  private async handleIncomingMessage(socket: Net.Socket, rawMessage: string): Promise<void> {
    let request: BrowserUseRpcRequest;
    try {
      request = JSON.parse(rawMessage) as BrowserUseRpcRequest;
    } catch {
      return;
    }

    if (request.id === undefined || typeof request.method !== "string") {
      return;
    }

    try {
      const result = await this.handleRequest(request.method, request.params);
      socket.write(encodeBrowserUseFrame({ jsonrpc: "2.0", id: request.id, result }));
    } catch (error) {
      socket.write(
        encodeBrowserUseFrame({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: 1,
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "ping":
        return "pong";
      case "getInfo":
        const sessionId = asString(asObject(params)?.session_id);
        return {
          name: "DP Code In-app Browser",
          version: "0.1.0",
          type: "iab",
          ...(sessionId ? { metadata: { codexSessionId: sessionId } } : {}),
        };
      case "getTabs":
        return this.getTabsForSession(requireSessionId(params));
      case "createTab":
        return this.createTabForSession(requireSessionId(params));
      case "nameSession":
        requireSessionId(params);
        if (!asString(asObject(params)?.name)) {
          throw new Error("nameSession requires a name");
        }
        return {};
      case "attach":
        return this.attachForSession(requireSessionId(params), params);
      case "detach":
        return this.detachForSession(requireSessionId(params));
      case "executeCdp":
        return this.executeCdpForSession(requireSessionId(params), params);
      default:
        throw new Error(`No handler registered for method: ${method}`);
    }
  }

  private getActiveBrowserHostState(): {
    threadId: ThreadId;
    state: ThreadBrowserState;
  } | null {
    const snapshot = this.browserManager.getBrowserUseSnapshot();
    if (!snapshot || !snapshot.state.open) {
      return null;
    }
    return snapshot;
  }

  private async waitForActiveBrowserHostState(): Promise<{
    threadId: ThreadId;
    state: ThreadBrowserState;
  } | null> {
    const existing = this.getActiveBrowserHostState();
    if (existing) {
      return existing;
    }

    await this.requestOpenPanel?.();
    const deadline = Date.now() + BROWSER_USE_PANEL_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const snapshot = this.getActiveBrowserHostState();
      if (snapshot) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, BROWSER_USE_PANEL_READY_POLL_MS));
    }
    return null;
  }

  private trackTab(threadId: ThreadId, tabId: string): BrowserUseTrackedTab {
    const key = `${threadId}:${tabId}`;
    const existing = this.trackedTabByKey.get(key);
    if (existing) {
      return existing;
    }
    const tracked = {
      id: this.nextTrackedTabId,
      threadId,
      tabId,
    } satisfies BrowserUseTrackedTab;
    this.nextTrackedTabId += 1;
    this.trackedTabByKey.set(key, tracked);
    this.trackedTabById.set(tracked.id, tracked);
    return tracked;
  }

  private getTabsForSession(sessionId: string): Array<{
    id: number;
    title: string;
    active: boolean;
    url: string;
  }> {
    const snapshot = this.getActiveBrowserHostState();
    if (!snapshot) {
      return [];
    }
    const selectedTrackedTabId = this.selectedTrackedTabIdBySessionId.get(sessionId) ?? null;
    return snapshot.state.tabs.map((tab) => {
      const tracked = this.trackTab(snapshot.threadId, tab.id);
      return {
        id: tracked.id,
        title: tab.title,
        active:
          selectedTrackedTabId === tracked.id ||
          (selectedTrackedTabId === null && snapshot.state.activeTabId === tab.id),
        url: tab.lastCommittedUrl ?? tab.url,
      };
    });
  }

  private async createTabForSession(sessionId: string): Promise<{
    id: number;
    title: string;
    active: boolean;
    url: string;
  }> {
    const snapshot = await this.waitForActiveBrowserHostState();
    if (!snapshot) {
      throw new Error("No active DP Code browser pane available");
    }
    const nextState = this.browserManager.newTab({
      threadId: snapshot.threadId,
      url: BROWSER_USE_INITIAL_URL,
      activate: true,
    });
    const activeTab =
      nextState.tabs.find((tab) => tab.id === nextState.activeTabId) ?? nextState.tabs[0] ?? null;
    if (!activeTab) {
      throw new Error("Could not create a browser tab.");
    }
    const tracked = this.trackTab(snapshot.threadId, activeTab.id);
    this.selectedTrackedTabIdBySessionId.set(sessionId, tracked.id);
    return {
      id: tracked.id,
      title: activeTab.title,
      active: true,
      url: activeTab.lastCommittedUrl ?? activeTab.url,
    };
  }

  private resolveTrackedTabForSession(sessionId: string, params: unknown): BrowserUseTrackedTab {
    const requestedTrackedTabId = asNumber(asObject(params)?.tabId);
    const trackedTabId =
      requestedTrackedTabId ?? this.selectedTrackedTabIdBySessionId.get(sessionId) ?? null;
    if (trackedTabId === null) {
      throw new Error("No browser tab selected for this session.");
    }
    const tracked = this.trackedTabById.get(trackedTabId);
    if (!tracked) {
      throw new Error(`Unknown tab: ${trackedTabId}`);
    }
    return tracked;
  }

  private async attachForSession(
    sessionId: string,
    params: unknown,
  ): Promise<Record<string, never>> {
    const tracked = this.resolveTrackedTabForSession(sessionId, params);
    this.selectedTrackedTabIdBySessionId.set(sessionId, tracked.id);
    this.cdpListenerDisposeBySessionId.get(sessionId)?.();
    await this.browserManager.attachBrowserUseTab({
      threadId: tracked.threadId,
      tabId: tracked.tabId,
    });
    const dispose = this.browserManager.subscribeToCdpEvents(
      {
        threadId: tracked.threadId,
        tabId: tracked.tabId,
      },
      (event) => {
        this.broadcastNotification("onCDPEvent", {
          source: {
            tabId: tracked.id,
          },
          method: event.method,
          ...(event.params !== undefined ? { params: event.params } : {}),
        });
      },
    );
    this.cdpListenerDisposeBySessionId.set(sessionId, dispose);
    return {};
  }

  private async detachForSession(sessionId: string): Promise<Record<string, never>> {
    this.cdpListenerDisposeBySessionId.get(sessionId)?.();
    this.cdpListenerDisposeBySessionId.delete(sessionId);
    return {};
  }

  private async executeCdpForSession(sessionId: string, params: unknown): Promise<unknown> {
    const request = asObject(params);
    const method = asString(request?.method);
    if (!method) {
      throw new Error("executeCdp requires a method");
    }
    const tracked = this.resolveTrackedTabForSession(sessionId, asObject(request?.target) ?? null);
    this.selectedTrackedTabIdBySessionId.set(sessionId, tracked.id);
    const commandParams = asObject(request?.commandParams);
    return this.browserManager.executeCdp({
      threadId: tracked.threadId,
      tabId: tracked.tabId,
      method,
      ...(commandParams ? { params: commandParams } : {}),
    } satisfies BrowserExecuteCdpInput);
  }

  private broadcastNotification(method: string, params: unknown): void {
    const payload = encodeBrowserUseFrame({
      jsonrpc: "2.0",
      method,
      params,
    });
    for (const socket of this.sockets) {
      if (!socket.destroyed) {
        socket.write(payload);
      }
    }
  }
}
