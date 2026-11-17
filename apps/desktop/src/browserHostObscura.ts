// FILE: browserHostObscura.ts
// Purpose: Standalone "Synara browser" host driving an Obscura headless browser
// over CDP. Speaks the same private pipe protocol the server expects
// (SYNARA_BROWSER_HOST_PIPE_PATH + SYNARA_BROWSER_HOST_CAPABILITY), so browser_*
// tools work without an Electron BrowserView. Used by the GPUI frame; the
// Electron path (BrowserHostPipeServer + DesktopBrowserAutomationHost) is
// unchanged.
// Layer: Desktop browser automation bridge (non-Electron)

import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, unknown>;

const FRAME_HEADER_BYTES = 4;
const MAX_MESSAGE_BYTES = 12 * 1024 * 1024;
const PIPE_LE = process.platform !== "win32"; // matches OS.endianness() usage upstream

function usage(): never {
  console.error(
    "usage: bun browserHostObscura.ts --socket <pipe> --capability-file <path|-> --obscura <bin> [--port N] [--storage-dir dir] [--url ws://...]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const SOCKET_PATH = argValue("--socket");
const CAP_FILE = argValue("--capability-file") ?? "-";
const OBSCURA_BIN = argValue("--obscura") ?? "obscura";
const CDP_URL = argValue("--url"); // attach to an already-running Obscura
const PORT = Number(argValue("--port") ?? 0) || 0; // 0 → pick via --port 0? obscura needs explicit port
const STORAGE_DIR = argValue("--storage-dir") ?? join("/tmp", `synara-obscura-${process.pid}`);
if (!SOCKET_PATH) usage();

// ---------- frames ----------

function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  if (PIPE_LE) header.writeUInt32LE(payload.length, 0);
  else header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer: Buffer): { messages: string[]; remaining: Buffer } {
  const messages: string[] = [];
  let offset = 0;
  while (buffer.length - offset >= FRAME_HEADER_BYTES) {
    const length = PIPE_LE ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const frameLength = FRAME_HEADER_BYTES + length;
    if (length > MAX_MESSAGE_BYTES) throw new Error("oversized frame");
    if (buffer.length - offset < frameLength) break;
    messages.push(
      buffer.subarray(offset + FRAME_HEADER_BYTES, offset + frameLength).toString("utf8"),
    );
    offset += frameLength;
  }
  return { messages, remaining: buffer.subarray(offset) };
}

function safeWrite(client: Socket, data: Buffer | string): void {
  try {
    if (client.destroyed || !client.writable) return;
    client.write(data, () => {});
  } catch {
    /* client gone */
  }
}

// ---------- Obscura process ----------

const CDP_PORT = PORT || 10_000 + (process.pid % 40_000);
let obscuraProc: ChildProcess | undefined;

function spawnObscura(): void {
  if (CDP_URL) return;
  mkdirSync(STORAGE_DIR, { recursive: true });
  obscuraProc = spawn(
    OBSCURA_BIN,
    [
      "serve",
      "--host",
      "127.0.0.1",
      "-p",
      String(CDP_PORT),
      "--storage-dir",
      STORAGE_DIR,
      "--allow-private-network",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  obscuraProc.on("exit", (code) => {
    console.error(`[obscura-host] obscura exited (${code}); shutting down`);
    void shutdown("obscura-exit");
  });
}

async function waitForCdp(): Promise<string> {
  const http = CDP_URL?.startsWith("ws") ? CDP_URL.replace(/^ws/, "http") : CDP_URL;
  const base = http ?? `http://127.0.0.1:${CDP_PORT}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/json/version`);
      if (res.ok) {
        const info = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("Obscura CDP endpoint did not come up");
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---------- minimal CDP client ----------

interface CdpReply {
  id?: number;
  method?: string;
  params?: Json;
  sessionId?: string;
  result?: Json;
  error?: { code: number; message: string };
}

class CdpConnection {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(msg: CdpReply) => void>();
  readonly ready: Promise<void>;

  constructor(url: string) {
    this.ready = new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(new Error(`cdp ws error: ${String(e)}`)));
      this.ws.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as CdpReply;
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const entry = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) entry.reject(new Error(msg.error.message));
            else entry.resolve(msg.result ?? {});
          } else {
            for (const l of this.listeners) l(msg);
          }
        } catch {
          /* malformed frame */
        }
      });
      this.ws.addEventListener("close", () => {
        for (const { reject } of this.pending.values()) reject(new Error("cdp closed"));
        this.pending.clear();
        void shutdown("cdp-closed");
      });
    });
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    const id = this.nextId++;
    const payload: Json = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  onMessage(listener: (msg: CdpReply) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// ---------- tab state ----------

interface Tab {
  tabId: string; // minted UUID seen by agents
  targetId: string; // Obscura CDP target id
  sessionId: string; // flattened CDP session
  url: string;
  title: string;
  loading: boolean;
  active: boolean;
  dead: boolean;
  consoleEntries: Json[];
}

const tabs = new Map<string, Tab>();
const byTarget = new Map<string, Tab>();
let cdp!: CdpConnection;
let cdpWsUrl = "";

async function attachTab(targetId: string): Promise<Tab> {
  const existing = byTarget.get(targetId);
  if (existing && !existing.dead) return existing;
  const { sessionId } = (await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  })) as { sessionId: string };
  const tab: Tab = {
    tabId: randomUUID(),
    targetId,
    sessionId,
    url: "about:blank",
    title: "",
    loading: false,
    active: false,
    dead: false,
    consoleEntries: [],
  };
  tabs.set(tab.tabId, tab);
  byTarget.set(targetId, tab);
  for (const method of ["Page.enable", "Runtime.enable", "Log.enable"]) {
    await cdp.send(method, {}, sessionId).catch(() => {});
  }
  return tab;
}

function requireTab(tabId: string | undefined): Tab {
  const tab = tabId
    ? [...tabs.values()].find((t) => t.tabId === tabId && !t.dead)
    : ([...tabs.values()].find((t) => t.active && !t.dead) ??
      [...tabs.values()].find((t) => !t.dead));
  if (!tab) {
    const err = new Error("No browser tab is bound to this thread.");
    (err as Error & { code?: string }).code = "BrowserTabScopeViolation";
    throw err;
  }
  return tab;
}

function pageSend(tab: Tab, method: string, params: Json = {}): Promise<Json> {
  return cdp.send(method, params, tab.sessionId);
}

function tabSummary(tab: Tab): Json {
  return {
    tabId: tab.tabId,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    loading: tab.loading,
    routable: true,
    state: tab.dead ? "crashed" : "live",
  };
}

async function waitForLoad(tab: Tab, waitUntil: string, timeoutMs = 15_000): Promise<void> {
  const want =
    waitUntil === "domcontentloaded"
      ? "Page.domContentEventFired"
      : waitUntil === "networkidle"
        ? "Page.loadEventFired" // Obscura has no network-idle event; load is the honest bound
        : "Page.loadEventFired";
  const deadline = Date.now() + timeoutMs;
  const navFired = tab.loading ? waitUntil : null;
  await new Promise<void>((resolve) => {
    const off = cdp.onMessage((msg) => {
      if (msg.sessionId !== tab.sessionId) return;
      if (msg.method === want || (navFired === null && msg.method === "Page.loadEventFired")) {
        off();
        resolve();
      }
    });
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        off();
        clearInterval(timer);
        resolve();
      }
    }, 250);
    setTimeout(() => clearInterval(timer), timeoutMs + 100);
  });
}

// ---------- tool implementations ----------

const assignedByThread = new Map<string, string>(); // threadId → tabId

function assignedTab(threadId: string): string | null {
  const id = assignedByThread.get(threadId);
  const tab = id ? tabs.get(id) : undefined;
  return tab && !tab.dead ? tab.tabId : null;
}

function assign(threadId: string, tab: Tab): void {
  for (const t of tabs.values()) if (t.active && t !== tab) t.active = false;
  tab.active = true;
  assignedByThread.set(threadId, tab.tabId);
}

function threadTab(request: Json, threadId: string, args: Json): Tab {
  const explicit = typeof args.tabId === "string" ? args.tabId : undefined;
  if (explicit) return requireTab(explicit);
  const assigned = assignedTab(threadId);
  return requireTab(assigned ?? undefined);
}

function navOutput(tab: Tab, extra: Json = {}): Json {
  return {
    tabId: tab.tabId,
    finalUrl: tab.url,
    redirects: [],
    loadState: "load",
    ...extra,
  };
}

async function toolStatus(threadId: string): Promise<Json> {
  return {
    available: true,
    physicalScope: "visible-shared-electron-webview",
    assignedTabId: assignedTab(threadId),
    authorization: "granted",
  };
}

async function toolTabs(threadId: string): Promise<Json> {
  const list = [...tabs.values()].filter((t) => !t.dead).map(tabSummary);
  const active = list.find((t) => (t as { active?: boolean }).active);
  return {
    tabs: list,
    activeTabId: (active?.tabId as string | undefined) ?? null,
    assignedTabId: assignedTab(threadId),
  };
}

async function toolOpen(threadId: string, args: Json): Promise<Json> {
  const url = typeof args.url === "string" ? args.url : "about:blank";
  const reuse = args.reuse !== false;
  if (reuse) {
    const existing = assignedTab(threadId);
    if (existing) {
      const tab = requireTab(existing);
      if (url !== "about:blank") {
        await pageSend(tab, "Page.navigate", { url });
        tab.loading = true;
        await waitForLoad(tab, String(args.waitUntil ?? "load"));
        await syncLocation(tab);
      }
      return navOutput(tab, { disposition: "reused" });
    }
  }
  const { targetId } = (await cdp.send("Target.createTarget", {
    url: "about:blank",
  })) as { targetId: string };
  const tab = await attachTab(targetId);
  assign(threadId, tab);
  if (url !== "about:blank") {
    await pageSend(tab, "Page.navigate", { url });
    tab.loading = true;
    await waitForLoad(tab, String(args.waitUntil ?? "load"));
    await syncLocation(tab);
  }
  return navOutput(tab, { disposition: "created" });
}

async function toolNavigate(threadId: string, args: Json): Promise<Json> {
  const tab = threadTab({} as Json, threadId, args);
  const url = args.url;
  if (typeof url !== "string" || !/^https?:/u.test(url)) {
    throw toolError("BrowserNavigationBlocked", "browser_navigate requires an http(s) url.");
  }
  tab.loading = true;
  await pageSend(tab, "Page.navigate", { url });
  await waitForLoad(tab, String(args.waitUntil ?? "load"));
  await syncLocation(tab);
  return navOutput(tab);
}

async function toolHistory(threadId: string, args: Json, name: string): Promise<Json> {
  const tab = threadTab({} as Json, threadId, args);
  tab.loading = true;
  if (name === "browser_reload") {
    await pageSend(tab, "Page.reload", { ignoreCache: args.ignoreCache === true });
  } else {
    const history = (await pageSend(tab, "Page.getNavigationHistory")) as {
      currentIndex: number;
      entries: { id: number; url: string }[];
    };
    const index = history.currentIndex + (name === "browser_back" ? -1 : 1);
    const entry = history.entries[index];
    if (!entry) throw toolError("BrowserNavigationBlocked", `No history entry for ${name}.`);
    await pageSend(tab, "Page.navigateToHistoryEntry", { entryId: entry.id });
  }
  await waitForLoad(tab, String(args.waitUntil ?? "load"));
  await syncLocation(tab);
  return navOutput(tab);
}

async function syncLocation(tab: Tab): Promise<void> {
  try {
    const result = (await pageSend(tab, "Runtime.evaluate", {
      expression: "JSON.stringify({u: location.href, t: document.title})",
      returnByValue: true,
    })) as { result?: { value?: string } };
    const parsed = JSON.parse(result.result?.value ?? "{}") as { u?: string; t?: string };
    if (parsed.u) tab.url = parsed.u;
    if (parsed.t !== undefined) tab.title = parsed.t;
  } catch {
    /* keep last known */
  }
}

async function toolResize(threadId: string, args: Json): Promise<Json> {
  const tab = threadTab({} as Json, threadId, args);
  const width = Math.max(320, Math.min(3840, Number(args.width) || 1280));
  const height = Math.max(240, Math.min(2160, Number(args.height) || 800));
  await pageSend(tab, "Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return {
    tabId: tab.tabId,
    requested: { width, height },
    observed: { width, height, deviceScaleFactor: 1 },
  };
}

function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}

async function toolScreenshot(threadId: string, args: Json): Promise<Json> {
  const tab = threadTab({} as Json, threadId, args);
  const fullPage = args.fullPage === true;
  let clip: Json | undefined;
  if (fullPage) {
    const metrics = (await pageSend(tab, "Page.getLayoutMetrics")) as {
      contentSize?: { width: number; height: number };
    };
    const cs = metrics.contentSize;
    if (cs) {
      clip = {
        x: 0,
        y: 0,
        width: Math.min(cs.width, 3840),
        height: Math.min(cs.height, 16_384),
        scale: 1,
      };
    }
  }
  const shot = (await pageSend(tab, "Page.captureScreenshot", {
    format: "png",
    ...(clip ? { clip } : {}),
  })) as { data: string };
  const buf = Buffer.from(shot.data, "base64");
  const { width, height } = pngSize(buf);
  const image = {
    mimeType: "image/png",
    width: width || 1280,
    height: height || 800,
    byteLength: buf.length,
  };
  return {
    structuredContent: {
      tabId: tab.tabId,
      url: tab.url,
      capturedAt: new Date().toISOString(),
      mode: fullPage ? "fullPage" : "viewport",
      clipped: clip !== undefined,
      image,
    },
    image: { ...image, data: shot.data },
  };
}

async function toolLogs(threadId: string, args: Json): Promise<Json> {
  const tab = threadTab({} as Json, threadId, args);
  const limit = Math.min(Number(args.limit) || 100, 200);
  const entries = tab.consoleEntries.slice(-limit);
  return {
    tabId: tab.tabId,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    capturedAt: new Date().toISOString(),
    entries,
    droppedCount: Math.max(0, tab.consoleEntries.length - limit),
    truncated: tab.consoleEntries.length > limit,
  };
}

async function toolClose(threadId: string, args: Json): Promise<Json> {
  const tab = threadTab({} as Json, threadId, args);
  tab.dead = true;
  tabs.delete(tab.tabId);
  byTarget.delete(tab.targetId);
  await cdp.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => {});
  if (assignedByThread.get(threadId) === tab.tabId) assignedByThread.delete(threadId);
  const active = [...tabs.values()].find((t) => !t.dead && t.active);
  return { closedTabId: tab.tabId, activeTabId: active?.tabId ?? null };
}

function toolError(code: string, message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = code;
  return err;
}

// ---------- browser_run via betterwright on an Obscura WebContents facade ----------

async function toolRun(threadId: string, args: Json): Promise<Json> {
  const tab = threadTab({} as Json, threadId, args);
  const code = args.code;
  if (typeof code !== "string" || !code.trim()) {
    throw toolError("BrowserEvaluationFailed", "browser_run requires a code string.");
  }
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 15_000, 1_000), 120_000);
  const { BetterWright } = await import("betterwright");
  // The worker talks to Obscura's browser-level CDP endpoint directly — it owns
  // its page context (the facade path stalls inside the vendored worker's
  // post-eval channel). Same storage dir, so page state is shared.
  const browser = new BetterWright({
    home: join(STORAGE_DIR, "browser-engine"),
    provider: { cdpUrl: cdpWsUrl },
    headless: true,
    downloadPolicy: "deny",
    vault: false,
    credentialCapture: false,
    adBlock: false,
    parkBackgroundPages: false,
  } as never);
  try {
    const result = await browser.run<unknown>(code, {
      timeout: timeoutMs / 1000,
      automaticUI: false,
    });
    if (!result.ok) {
      throw toolError("BrowserEvaluationFailed", result.error ?? "browser_run failed.");
    }
    const value = result.result;
    const serialized = JSON.stringify(value) ?? "";
    return {
      tabId: tab.tabId,
      value,
      serializedByteCount: Buffer.byteLength(serialized, "utf8"),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- executeTool dispatch ----------

async function executeTool(request: {
  sessionId: string;
  provider: string;
  threadId: string;
  name: string;
  args: Json;
}): Promise<unknown> {
  const { threadId, name, args } = request;
  switch (name) {
    case "browser_status":
      return toolStatus(threadId);
    case "browser_tabs":
      return toolTabs(threadId);
    case "browser_open":
      return toolOpen(threadId, args);
    case "browser_navigate":
      return toolNavigate(threadId, args);
    case "browser_back":
    case "browser_forward":
    case "browser_reload":
      return toolHistory(threadId, args, name);
    case "browser_resize":
      return toolResize(threadId, args);
    case "browser_screenshot":
      return toolScreenshot(threadId, args);
    case "browser_logs":
      return toolLogs(threadId, args);
    case "browser_run":
      return toolRun(threadId, args);
    case "browser_upload":
      throw toolError(
        "BrowserInputUnsupported",
        "browser_upload is not supported by the Obscura host yet.",
      );
    case "browser_close":
      return toolClose(threadId, args);
    default:
      throw toolError("BrowserInputUnsupported", `Unknown browser tool: ${name}`);
  }
}

// ---------- pipe server ----------

interface PipeClient {
  socket: Socket;
  chunks: Buffer[];
  sessionId: string | null;
  threadId: string | null;
}

let server: Server | undefined;

function startPipe(capability: string): void {
  mkdirSync(join(SOCKET_PATH!, ".."), { recursive: true });
  try {
    unlinkSync(SOCKET_PATH!);
  } catch {
    /* none */
  }
  server = createServer((socket) => {
    const client: PipeClient = { socket, chunks: [], sessionId: null, threadId: null };
    socket.on("data", async (data) => {
      client.chunks.push(data);
      const merged = Buffer.concat(client.chunks);
      let decoded;
      try {
        decoded = decodeFrames(merged);
      } catch {
        socket.destroy();
        return;
      }
      client.chunks = decoded.remaining.length ? [decoded.remaining] : [];
      for (const raw of decoded.messages) {
        let request: Json | null = null;
        try {
          request = JSON.parse(raw) as Json;
        } catch {
          continue;
        }
        const id = request?.id;
        if (id === undefined || typeof request?.method !== "string") continue;
        try {
          const result = await handleRpc(client, request.method as string, request.params);
          safeWrite(socket, encodeFrame({ jsonrpc: "2.0", id, result }));
        } catch (error) {
          const code = (error as Error & { code?: string })?.code;
          safeWrite(
            socket,
            encodeFrame({
              jsonrpc: "2.0",
              id,
              error: {
                code: typeof code === "string" && code.startsWith("Browser") ? -32_010 : -32_000,
                message: error instanceof Error ? error.message : String(error),
                ...(typeof code === "string" && code.startsWith("Browser")
                  ? { data: { error: { code } } }
                  : {}),
              },
            }),
          );
        }
      }
    });
    socket.on("error", () => {});
  });
  server.listen(SOCKET_PATH, () => {
    console.error(`[obscura-host] listening on ${SOCKET_PATH}`);
  });

  async function handleRpc(client: PipeClient, method: string, params: unknown): Promise<unknown> {
    const req = (params ?? {}) as Json;
    if (method === "ping") return "pong";
    if (method === "getInfo") {
      const sessionId = req.session_id;
      const supplied = req.capability;
      if (typeof sessionId !== "string" || !sessionId) throw new Error("session_id required");
      const expected = Buffer.from(capability, "utf8");
      const got = Buffer.from(typeof supplied === "string" ? supplied : "", "utf8");
      const { timingSafeEqual } = await import("node:crypto");
      if (got.byteLength !== expected.byteLength || !timingSafeEqual(got, expected)) {
        const err = new Error("Browser host authorization denied.");
        (err as Error & { code?: string }).code = "BrowserAuthorizationDenied";
        throw err;
      }
      if (client.sessionId && client.sessionId !== sessionId) {
        throw new Error("Browser session does not belong to this pipe connection");
      }
      client.sessionId = sessionId;
      return {
        name: "Synara Browser Host",
        version: "1.0.0",
        type: "synara-browser-host",
        metadata: {
          sessionId,
          protocolVersion: 1,
          physicalScope: "visible-shared-electron-webview",
          methods: ["executeTool"],
        },
      };
    }
    if (method === "executeTool") {
      const sessionId = req.session_id;
      const threadId = req.thread_id;
      const name = req.name;
      if (!client.sessionId || sessionId !== client.sessionId) {
        throw new Error("executeTool before getInfo");
      }
      if (typeof threadId !== "string" || !threadId || typeof name !== "string") {
        const err = new Error("executeTool requires thread_id and name");
        (err as Error & { code?: string }).code = "BrowserInputUnsupported";
        throw err;
      }
      if (client.threadId && client.threadId !== threadId) {
        const err = new Error("Thread scope violation on this connection");
        (err as Error & { code?: string }).code = "BrowserTabScopeViolation";
        throw err;
      }
      client.threadId = threadId;
      return executeTool({
        sessionId: client.sessionId,
        provider: String(req.provider ?? "unknown"),
        threadId,
        name,
        args: (req.arguments ?? {}) as Json,
      });
    }
    throw new Error(`No handler registered for method: ${method}`);
  }
}

// ---------- lifecycle ----------

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[obscura-host] shutdown: ${reason}`);
  try {
    server?.close();
  } catch {
    /* */
  }
  try {
    obscuraProc?.kill("SIGKILL");
  } catch {
    /* */
  }
  try {
    unlinkSync(SOCKET_PATH!);
  } catch {
    /* */
  }
  process.exit(0);
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => void shutdown(sig));
}
// Orphan reaper: die with the parent frame (same pattern as the CUA sidecar).
// Under synaraSidecars.ts this module shares a process with the CUA host, so
// ppid alone is wrong (a detached launcher reparents to launchd); the frame
// passes its pid via env like it does for the CUA host.
const framePid = Number(process.env["SYNARA_CUA_FRAME_PID"] ?? "");
const orphanCheck = setInterval(() => {
  if (Number.isSafeInteger(framePid) && framePid > 1) {
    try {
      process.kill(framePid, 0);
    } catch {
      void shutdown("orphaned");
    }
  } else if (process.ppid === 1) void shutdown("orphaned");
}, 3_000);
orphanCheck.unref();

// ---------- main ----------

const capabilityFile = CAP_FILE === "-" ? "/dev/stdin" : CAP_FILE;
let capability: string;
try {
  capability = readFileSync(capabilityFile, "utf8").trim();
} catch {
  console.error(`[obscura-host] cannot read capability from ${capabilityFile}`);
  process.exit(2);
}
if (capability.length < 32) {
  // Auto-mint and persist next to the socket for the launcher to pass onward.
  capability = randomBytes(32).toString("hex");
  writeFileSync(`${SOCKET_PATH}.cap`, capability, { mode: 0o600 });
}

spawnObscura();
const wsUrl = await waitForCdp();
cdpWsUrl = wsUrl;
cdp = new CdpConnection(wsUrl);
await cdp.ready;

// Track target lifecycle + page/console events.
cdp.onMessage((msg) => {
  if (process.env.OBST_DEBUG && msg.method) {
    console.error(`[cdp<<EVT] ${msg.method} session=${msg.sessionId ?? "-"}`);
  }
  if (msg.method === "Target.targetInfoChanged") {
    const info = (msg.params as { targetInfo?: { targetId: string; url?: string; title?: string } })
      ?.targetInfo;
    const tab = info ? byTarget.get(info.targetId) : undefined;
    if (tab && info) {
      if (info.url) tab.url = info.url;
      if (info.title) tab.title = info.title;
    }
  }
  if (msg.method === "Target.targetDestroyed") {
    const targetId = (msg.params as { targetId?: string })?.targetId;
    const tab = targetId ? byTarget.get(targetId) : undefined;
    if (tab) {
      tab.dead = true;
      tabs.delete(tab.tabId);
      if (targetId) byTarget.delete(targetId);
    }
  }
  const tab = [...byTarget.values()].find((t) => t.sessionId === msg.sessionId);
  if (!tab) return;
  if (msg.method === "Page.loadEventFired" || msg.method === "Page.domContentEventFired") {
    tab.loading = msg.method !== "Page.loadEventFired";
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    const p = msg.params as { type?: string; args?: { value?: unknown; description?: string }[] };
    tab.consoleEntries.push({
      level: p.type ?? "log",
      text: (p.args ?? [])
        .map((a) => a.value ?? a.description ?? "")
        .join(" ")
        .slice(0, 4096),
      at: new Date().toISOString(),
    });
    if (tab.consoleEntries.length > 500) tab.consoleEntries.splice(0, 100);
  }
  if (msg.method === "Log.entryAdded") {
    const p = msg.params as { entry?: { level?: string; text?: string } };
    if (p.entry?.text) {
      tab.consoleEntries.push({
        level: p.entry.level ?? "info",
        text: p.entry.text.slice(0, 4096),
        at: new Date().toISOString(),
      });
    }
  }
});
await cdp.send("Target.setDiscoverTargets", { discover: true });
await cdp
  .send("Target.setAutoAttach", {
    autoAttach: false,
    waitForDebuggerOnStart: false,
    flatten: true,
  })
  .catch(() => {});

startPipe(capability);
console.error(`[obscura-host] ready (cdp=${wsUrl})`);
