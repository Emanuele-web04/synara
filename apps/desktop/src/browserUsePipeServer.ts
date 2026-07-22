// FILE: browserUsePipeServer.ts
// Purpose: Exposes the in-app browser over a Codex-compatible browser-use native pipe.
// Layer: Desktop browser automation bridge
// Depends on: DesktopBrowserManager and Node net server primitives

import * as FS from "node:fs";
import * as Crypto from "node:crypto";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import type { BrowserExecuteCdpInput, ThreadBrowserState, ThreadId } from "@synara/contracts";

import type { DesktopBrowserManager } from "./browserManager";

const BROWSER_USE_HEADER_BYTES = 4;
const BROWSER_USE_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const BROWSER_USE_MAX_CLIENTS = 8;
const BROWSER_USE_MAX_IN_FLIGHT_REQUESTS = 16;
const BROWSER_USE_MAX_QUEUED_OUTPUT_BYTES = 1024 * 1024;
const BROWSER_USE_INITIAL_URL = "about:blank";
const BROWSER_USE_PANEL_READY_TIMEOUT_MS = 2_000;
const BROWSER_USE_PANEL_READY_POLL_MS = 50;
// The Browser plugin scans this fixed directory; OS.tmpdir() differs on macOS.
const BROWSER_USE_DISCOVERY_DIR = "/tmp/codex-browser-use";
const BROWSER_USE_PIPE_NAME_PREFIX = "synara-iab";
// Production Browser plugins reject IAB backends from another build flavor.
const BROWSER_USE_CODEX_APP_BUILD_FLAVOR = "prod";
export const SYNARA_BROWSER_USE_PIPE_ENV = "SYNARA_BROWSER_USE_PIPE_PATH";

type BrowserUseRpcId = string | number;
type BrowserUseWriteResult = "written" | "overflow" | "closed";

interface BrowserUseRpcRequest {
  id?: BrowserUseRpcId;
  method?: string;
  params?: unknown;
}

interface BrowserUseTrackedTab {
  id: number;
  leaseId: string;
  threadId: ThreadId;
  tabId: string;
}

interface BrowserUseClient {
  readonly leaseId: string;
  readonly socket: Net.Socket;
  pending: Buffer;
  inFlightRequests: number;
  codexSessionId: string | null;
  outputBackpressured: boolean;
  cdpOutputOverflowed: boolean;
  boundThreadId: ThreadId | null;
  selectedTrackedTabId: number | null;
  disposeCdpListener: (() => void) | null;
}

interface BrowserUsePipeServerOptions {
  pipePath?: string;
  requestOpenPanel?: () => void | Promise<void>;
  maxInFlightRequests?: number;
  maxQueuedOutputBytes?: number;
}

export function resolveDefaultBrowserUsePipePath(platform = process.platform): string {
  if (platform === "win32") return "";
  return Path.posix.join(
    BROWSER_USE_DISCOVERY_DIR,
    `${BROWSER_USE_PIPE_NAME_PREFIX}-${process.pid}-${Crypto.randomUUID()}.sock`,
  );
}

export function resolveConfiguredBrowserUsePipePath(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  if (platform === "win32") return "";
  const configured = env[SYNARA_BROWSER_USE_PIPE_ENV]?.trim();
  return configured || resolveDefaultBrowserUsePipePath(platform);
}

export const SYNARA_BROWSER_USE_PIPE_PATH = resolveConfiguredBrowserUsePipePath();

export function resolveBrowserUsePipeBackendEnv(
  inheritedEnv: NodeJS.ProcessEnv,
  activePipePath: string | null | undefined,
): NodeJS.ProcessEnv {
  const backendEnv = { ...inheritedEnv };
  delete backendEnv[SYNARA_BROWSER_USE_PIPE_ENV];
  const pipePath = activePipePath?.trim();
  if (pipePath) {
    backendEnv[SYNARA_BROWSER_USE_PIPE_ENV] = pipePath;
  }
  return backendEnv;
}

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

function requireCodexSessionId(params: unknown, expectedSessionId: string | null): void {
  const sessionId = asString(asObject(params)?.session_id);
  if (expectedSessionId === null || sessionId !== expectedSessionId) {
    throw new Error("Missing or invalid browser capability lease");
  }
}

function bindCodexSessionId(client: BrowserUseClient, params: unknown): string {
  const sessionId = asString(asObject(params)?.session_id);
  if (!sessionId) {
    throw new Error("getInfo requires a session_id");
  }
  if (client.codexSessionId !== null && client.codexSessionId !== sessionId) {
    throw new Error("Browser session does not belong to this IAB pipe");
  }
  client.codexSessionId = sessionId;
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
  const parent = Path.dirname(pipePath);
  FS.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = FS.lstatSync(parent);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Browser-use pipe parent is not a private directory: ${parent}`);
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error(`Browser-use pipe parent is not owned by this user: ${parent}`);
  }
  FS.chmodSync(parent, 0o700);
}

function cleanupPipePath(pipePath: string): void {
  try {
    const stat = FS.lstatSync(pipePath);
    if (stat.isSymbolicLink() || (!stat.isSocket() && !stat.isFile())) {
      throw new Error(`Refusing to replace unsafe browser-use pipe path: ${pipePath}`);
    }
    FS.unlinkSync(pipePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export class BrowserUsePipeServer {
  private readonly sockets = new Set<Net.Socket>();
  private readonly clientBySocket = new Map<Net.Socket, BrowserUseClient>();
  private readonly trackedTabByKey = new Map<string, BrowserUseTrackedTab>();
  private readonly trackedTabById = new Map<number, BrowserUseTrackedTab>();
  private readonly server: Net.Server;
  private readonly pipePath: string;
  private readonly requestOpenPanel: (() => void | Promise<void>) | undefined;
  private readonly maxInFlightRequests: number;
  private readonly maxQueuedOutputBytes: number;
  private nextTrackedTabId = 1;
  private started = false;

  constructor(
    private readonly browserManager: DesktopBrowserManager,
    options: BrowserUsePipeServerOptions | string = SYNARA_BROWSER_USE_PIPE_PATH,
  ) {
    this.pipePath =
      typeof options === "string" ? options : (options.pipePath ?? SYNARA_BROWSER_USE_PIPE_PATH);
    this.requestOpenPanel = typeof options === "string" ? undefined : options.requestOpenPanel;
    this.maxInFlightRequests =
      typeof options === "string"
        ? BROWSER_USE_MAX_IN_FLIGHT_REQUESTS
        : (options.maxInFlightRequests ?? BROWSER_USE_MAX_IN_FLIGHT_REQUESTS);
    this.maxQueuedOutputBytes =
      typeof options === "string"
        ? BROWSER_USE_MAX_QUEUED_OUTPUT_BYTES
        : (options.maxQueuedOutputBytes ?? BROWSER_USE_MAX_QUEUED_OUTPUT_BYTES);
    this.server = Net.createServer((socket) => this.handleSocketConnection(socket));
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (!this.pipePath) {
      throw new Error("Browser-use native pipe is disabled without a proven private Windows ACL");
    }
    ensurePipeParentDirectory(this.pipePath);
    cleanupPipePath(this.pipePath);
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ path: this.pipePath, readableAll: false, writableAll: false }, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    FS.chmodSync(this.pipePath, 0o600);
    this.started = true;
  }

  async dispose(): Promise<void> {
    for (const client of this.clientBySocket.values()) {
      client.disposeCdpListener?.();
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.clientBySocket.clear();
    if (this.started) {
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
      });
      this.started = false;
    }
    cleanupPipePath(this.pipePath);
  }

  private handleSocketConnection(socket: Net.Socket): void {
    if (this.sockets.size >= BROWSER_USE_MAX_CLIENTS) {
      socket.destroy();
      return;
    }
    const client: BrowserUseClient = {
      leaseId: Crypto.randomUUID(),
      socket,
      pending: Buffer.alloc(0),
      inFlightRequests: 0,
      codexSessionId: null,
      outputBackpressured: false,
      cdpOutputOverflowed: false,
      boundThreadId: null,
      selectedTrackedTabId: null,
      disposeCdpListener: null,
    };
    this.sockets.add(socket);
    this.clientBySocket.set(socket, client);
    socket.on("data", (chunk) => this.handleSocketData(socket, chunk));
    socket.on("close", () => this.releaseClient(client));
    socket.on("error", () => this.releaseClient(client));
  }

  private releaseClient(client: BrowserUseClient): void {
    client.disposeCdpListener?.();
    client.disposeCdpListener = null;
    client.outputBackpressured = false;
    client.cdpOutputOverflowed = false;
    this.sockets.delete(client.socket);
    this.clientBySocket.delete(client.socket);
    for (const [id, tracked] of this.trackedTabById) {
      if (tracked.leaseId !== client.leaseId) continue;
      this.trackedTabById.delete(id);
      this.trackedTabByKey.delete(`${tracked.leaseId}:${tracked.threadId}:${tracked.tabId}`);
    }
  }

  private handleSocketData(socket: Net.Socket, chunk: Buffer): void {
    const client = this.clientBySocket.get(socket);
    if (!client) return;
    const decoded = decodeBrowserUseFrames(Buffer.concat([client.pending, chunk]));
    if (!decoded) {
      socket.destroy();
      return;
    }
    client.pending = decoded.remaining;
    for (const message of decoded.messages) {
      if (client.inFlightRequests >= this.maxInFlightRequests) {
        let request: BrowserUseRpcRequest | null = null;
        try {
          request = JSON.parse(message) as BrowserUseRpcRequest;
        } catch {
          // Invalid JSON has no request id that can be settled.
        }
        if (request?.id !== undefined) {
          this.writeToClient(client, {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: 1, message: "Too many in-flight browser-use requests" },
          });
        }
        continue;
      }
      client.inFlightRequests += 1;
      void this.handleIncomingMessage(client, message).finally(() => {
        client.inFlightRequests -= 1;
      });
    }
  }

  private async handleIncomingMessage(client: BrowserUseClient, rawMessage: string): Promise<void> {
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
      const result = await this.handleRequest(client, request.method, request.params);
      this.writeToClient(client, { jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      this.writeToClient(client, {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: 1,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async handleRequest(
    client: BrowserUseClient,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case "ping":
        return "pong";
      case "getInfo": {
        const codexSessionId = bindCodexSessionId(client, params);
        return {
          name: "Synara In-app Browser",
          version: "0.1.0",
          type: "iab",
          metadata: {
            codexAppBuildFlavor: BROWSER_USE_CODEX_APP_BUILD_FLAVOR,
            codexSessionId,
          },
        };
      }
      case "getTabs":
        requireCodexSessionId(params, client.codexSessionId);
        return this.getTabsForClient(client);
      case "createTab":
        requireCodexSessionId(params, client.codexSessionId);
        return this.createTabForClient(client);
      case "nameSession":
        requireCodexSessionId(params, client.codexSessionId);
        if (!asString(asObject(params)?.name)) {
          throw new Error("nameSession requires a name");
        }
        return {};
      case "attach":
        requireCodexSessionId(params, client.codexSessionId);
        return this.attachForClient(client, params);
      case "detach":
        requireCodexSessionId(params, client.codexSessionId);
        return this.detachForClient(client);
      case "executeCdp":
        requireCodexSessionId(params, client.codexSessionId);
        return this.executeCdpForClient(client, params);
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

  private bindClientToThread(client: BrowserUseClient, threadId: ThreadId): void {
    if (client.boundThreadId !== null && client.boundThreadId !== threadId) {
      throw new Error("Browser capability lease is stale for the active thread");
    }
    client.boundThreadId = threadId;
  }

  private trackTab(
    client: BrowserUseClient,
    threadId: ThreadId,
    tabId: string,
  ): BrowserUseTrackedTab {
    const key = `${client.leaseId}:${threadId}:${tabId}`;
    const existing = this.trackedTabByKey.get(key);
    if (existing) {
      return existing;
    }
    const tracked = {
      id: this.nextTrackedTabId,
      leaseId: client.leaseId,
      threadId,
      tabId,
    } satisfies BrowserUseTrackedTab;
    this.nextTrackedTabId += 1;
    this.trackedTabByKey.set(key, tracked);
    this.trackedTabById.set(tracked.id, tracked);
    return tracked;
  }

  private getTabsForClient(client: BrowserUseClient): Array<{
    id: number;
    title: string;
    active: boolean;
    url: string;
  }> {
    const snapshot = this.getActiveBrowserHostState();
    if (!snapshot) {
      return [];
    }
    this.bindClientToThread(client, snapshot.threadId);
    return snapshot.state.tabs.map((tab) => {
      const tracked = this.trackTab(client, snapshot.threadId, tab.id);
      return {
        id: tracked.id,
        title: tab.title,
        active:
          client.selectedTrackedTabId === tracked.id ||
          (client.selectedTrackedTabId === null && snapshot.state.activeTabId === tab.id),
        url: tab.lastCommittedUrl ?? tab.url,
      };
    });
  }

  private async createTabForClient(client: BrowserUseClient): Promise<{
    id: number;
    title: string;
    active: boolean;
    url: string;
  }> {
    const snapshot = await this.waitForActiveBrowserHostState();
    if (!snapshot) {
      throw new Error("No active Synara browser pane available");
    }
    this.bindClientToThread(client, snapshot.threadId);
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
    const tracked = this.trackTab(client, snapshot.threadId, activeTab.id);
    client.selectedTrackedTabId = tracked.id;
    return {
      id: tracked.id,
      title: activeTab.title,
      active: true,
      url: activeTab.lastCommittedUrl ?? activeTab.url,
    };
  }

  private resolveTrackedTabForClient(
    client: BrowserUseClient,
    params: unknown,
  ): BrowserUseTrackedTab {
    const requestedTrackedTabId = asNumber(asObject(params)?.tabId);
    const trackedTabId = requestedTrackedTabId ?? client.selectedTrackedTabId;
    if (trackedTabId === null) {
      throw new Error("No browser tab selected for this session.");
    }
    const tracked = this.trackedTabById.get(trackedTabId);
    if (!tracked || tracked.leaseId !== client.leaseId) {
      throw new Error(`Unknown tab: ${trackedTabId}`);
    }
    const snapshot = this.getActiveBrowserHostState();
    if (
      !snapshot ||
      snapshot.threadId !== tracked.threadId ||
      !snapshot.state.tabs.some((tab) => tab.id === tracked.tabId)
    ) {
      throw new Error(`Stale tab: ${trackedTabId}`);
    }
    this.bindClientToThread(client, tracked.threadId);
    return tracked;
  }

  private async attachForClient(
    client: BrowserUseClient,
    params: unknown,
  ): Promise<Record<string, never>> {
    const tracked = this.resolveTrackedTabForClient(client, params);
    client.selectedTrackedTabId = tracked.id;
    client.disposeCdpListener?.();
    client.disposeCdpListener = null;
    client.cdpOutputOverflowed = false;
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
        if (client.cdpOutputOverflowed) return;
        const result = this.writeToClient(client, {
          jsonrpc: "2.0",
          method: "onCDPEvent",
          params: {
            source: {
              tabId: tracked.id,
            },
            method: event.method,
            ...(event.params !== undefined ? { params: event.params } : {}),
          },
        });
        if (result === "overflow") {
          this.signalCdpOutputOverflow(client, tracked.id);
        }
      },
    );
    if (client.cdpOutputOverflowed) {
      dispose();
    } else {
      client.disposeCdpListener = dispose;
    }
    return {};
  }

  private async detachForClient(client: BrowserUseClient): Promise<Record<string, never>> {
    client.disposeCdpListener?.();
    client.disposeCdpListener = null;
    client.cdpOutputOverflowed = false;
    return {};
  }

  private async executeCdpForClient(client: BrowserUseClient, params: unknown): Promise<unknown> {
    const request = asObject(params);
    const method = asString(request?.method);
    if (!method) {
      throw new Error("executeCdp requires a method");
    }
    const tracked = this.resolveTrackedTabForClient(client, asObject(request?.target) ?? null);
    client.selectedTrackedTabId = tracked.id;
    const commandParams = asObject(request?.commandParams);
    return this.browserManager.executeCdp({
      threadId: tracked.threadId,
      tabId: tracked.tabId,
      method,
      ...(commandParams ? { params: commandParams } : {}),
    } satisfies BrowserExecuteCdpInput);
  }

  private signalCdpOutputOverflow(client: BrowserUseClient, trackedTabId: number): void {
    if (client.cdpOutputOverflowed) return;
    client.cdpOutputOverflowed = true;
    client.disposeCdpListener?.();
    client.disposeCdpListener = null;
    this.writeToClient(
      client,
      {
        jsonrpc: "2.0",
        method: "onCDPEvent",
        params: {
          source: { tabId: trackedTabId },
          method: "Inspector.detached",
          params: { reason: "Browser-use output capacity exceeded" },
        },
      },
      true,
    );
  }

  private writeToClient(
    client: BrowserUseClient,
    message: unknown,
    allowBoundedOverflow = false,
  ): BrowserUseWriteResult {
    const { socket } = client;
    if (socket.destroyed || socket.writableEnded) return "closed";
    const frame = encodeBrowserUseFrame(message);
    if (!allowBoundedOverflow && socket.writableLength + frame.length > this.maxQueuedOutputBytes) {
      const requestId = asObject(message)?.id;
      if (typeof requestId !== "string" && typeof requestId !== "number") {
        return "overflow";
      }
      // A completed RPC response must preserve the handler's actual outcome. Replacing a
      // successful response here would make a browser action look failed after it already ran.
      // The in-flight request cap bounds how many such response frames can be queued, while
      // unsolicited notifications remain subject to the strict output budget above.
    }
    const didAccept = socket.write(frame);
    if (!didAccept && !client.outputBackpressured) {
      client.outputBackpressured = true;
      socket.pause();
      socket.once("drain", () => {
        client.outputBackpressured = false;
        if (!socket.destroyed) socket.resume();
      });
    }
    return "written";
  }
}
