import { randomUUID } from "node:crypto";
import { ipcMain, session, type WebContents } from "electron";
import { Schema } from "effect";
import { RemoteResourceReference } from "@synara/contracts";
import { REMOTE_RESOURCE_LOCAL_PREFIX, remoteResourceRoute } from "@synara/shared/remoteResources";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

export const REMOTE_RESOURCE_SCHEME = "synara-resource";
interface ResourceHandle {
  readonly cacheKey: string;
  readonly hostId: string;
  readonly reference: RemoteResourceReference;
  readonly owner: WebContents;
  readonly frameProcessId: number;
  readonly frameRoutingId: number;
  readonly lifetime: AbortController;
  readonly expiresAt: number;
}

/** Handles identify resources, but Electron's trusted caller identity authorizes
 * them. A copied URL cannot be used by another window or embedded web page. */
export function registerRemoteResourceBroker(options: {
  readonly trustedRenderer: () => WebContents | null;
  readonly trustedOrigin: () => string;
  readonly backendWsUrl: () => string | null;
}): () => void {
  const handles = new Map<string, ResourceHandle>();
  const keys = new Map<string, string>();
  const ownerCleanup = new Map<number, () => void>();
  let bearer: { endpoint: string; token: string; expiresAt: number } | undefined;
  let issuing: Promise<string> | undefined;
  const origin = (value: string) => {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  };
  const remove = (id: string) => {
    const handle = handles.get(id);
    handle?.lifetime.abort();
    if (handle) keys.delete(handle.cacheKey);
    handles.delete(id);
  };
  const watchOwner = (owner: WebContents) => {
    if (ownerCleanup.has(owner.id)) return;
    const clear = () => {
      for (const [id, handle] of handles) if (handle.owner === owner) remove(id);
    };
    const navigate = (_event: unknown, _url: string, inPlace: boolean, main: boolean) => {
      if (main && !inPlace) clear();
    };
    const dispose = () => {
      clear();
      owner.off("did-start-navigation", navigate);
      owner.off("destroyed", dispose);
      ownerCleanup.delete(owner.id);
    };
    owner.on("did-start-navigation", navigate);
    owner.once("destroyed", dispose);
    ownerCleanup.set(owner.id, dispose);
  };
  const lookup = (value: string) => {
    const url = new URL(value);
    if (
      url.protocol !== `${REMOTE_RESOURCE_SCHEME}:` ||
      url.host !== "broker" ||
      url.search ||
      url.hash
    )
      return undefined;
    const handle = handles.get(url.pathname.slice(1));
    if (
      !handle ||
      handle.expiresAt <= Date.now() ||
      handle.owner.isDestroyed() ||
      handle.owner !== options.trustedRenderer() ||
      origin(handle.owner.getURL()) !== origin(options.trustedOrigin()) ||
      handle.owner.mainFrame.processId !== handle.frameProcessId ||
      handle.owner.mainFrame.routingId !== handle.frameRoutingId
    )
      return undefined;
    return handle;
  };
  const backend = () => {
    const ws = new URL(options.backendWsUrl() ?? "");
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(ws.hostname) ||
      !["ws:", "wss:"].includes(ws.protocol)
    )
      throw new Error("Local controller unavailable");
    const base = new URL(`${ws.protocol === "wss:" ? "https:" : "http:"}//${ws.host}`);
    return { ws, base };
  };
  const controllerToken = async () => {
    const { ws, base } = backend();
    const endpoint = ws.toString();
    if (bearer?.endpoint === endpoint && bearer.expiresAt > Date.now() + 30_000)
      return bearer.token;
    if (issuing) return issuing;
    issuing = (async () => {
      const credential = ws.searchParams.get("token");
      if (!credential) throw new Error("Controller authentication unavailable");
      const result = await fetch(new URL("/api/auth/bootstrap/bearer", base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!result.ok) throw new Error("Controller authentication failed");
      const value = (await result.json()) as {
        role?: string;
        sessionToken?: string;
        expiresAt?: string;
      };
      if (
        value.role !== "owner" ||
        typeof value.sessionToken !== "string" ||
        !Number.isFinite(Date.parse(value.expiresAt ?? ""))
      )
        throw new Error("Controller owner authentication required");
      if (options.backendWsUrl() !== endpoint)
        throw new Error("Controller changed during authentication");
      bearer = { endpoint, token: value.sessionToken, expiresAt: Date.parse(value.expiresAt!) };
      return bearer.token;
    })();
    try {
      return await issuing;
    } finally {
      issuing = undefined;
    }
  };
  ipcMain.on(
    DESKTOP_IPC_CHANNELS.remoteResourceUrl,
    (event, hostId: unknown, rawReference: unknown) => {
      let result: string | null = null;
      try {
        if (
          event.sender !== options.trustedRenderer() ||
          event.senderFrame !== event.sender.mainFrame ||
          origin(event.senderFrame.url) !== origin(options.trustedOrigin()) ||
          typeof hostId !== "string" ||
          !/^[A-Za-z0-9_-]{1,256}$/.test(hostId)
        )
          return;
        const reference = Schema.decodeUnknownSync(RemoteResourceReference)(rawReference);
        const key = JSON.stringify([
          event.sender.id,
          event.sender.mainFrame.processId,
          event.sender.mainFrame.routingId,
          hostId,
          reference,
        ]);
        const old = keys.get(key);
        if (old && lookup(`${REMOTE_RESOURCE_SCHEME}://broker/${old}`)) {
          result = `${REMOTE_RESOURCE_SCHEME}://broker/${old}`;
          return;
        }
        for (const [id, handle] of handles)
          if (
            handle.expiresAt <= Date.now() ||
            handle.owner.isDestroyed() ||
            handle.frameProcessId !== handle.owner.mainFrame.processId ||
            handle.frameRoutingId !== handle.owner.mainFrame.routingId
          )
            remove(id);
        if (handles.size >= 2048) return;
        const id = randomUUID();
        watchOwner(event.sender);
        handles.set(id, {
          cacheKey: key,
          hostId,
          reference,
          owner: event.sender,
          frameProcessId: event.sender.mainFrame.processId,
          frameRoutingId: event.sender.mainFrame.routingId,
          lifetime: new AbortController(),
          expiresAt: Date.now() + 30 * 60_000,
        });
        keys.set(key, id);
        result = `${REMOTE_RESOURCE_SCHEME}://broker/${id}`;
      } catch {
        /* Untrusted or malformed IPC receives no resource handle. */
      } finally {
        event.returnValue = result;
      }
    },
  );
  const targetSession = session.defaultSession;
  targetSession.webRequest.onBeforeRequest(
    { urls: [`${REMOTE_RESOURCE_SCHEME}://*/*`] },
    (details, callback) => {
      try {
        const handle = lookup(details.url);
        callback({
          cancel:
            !handle ||
            details.webContentsId !== handle.owner.id ||
            details.frame?.processId !== handle.frameProcessId ||
            details.frame?.routingId !== handle.frameRoutingId,
        });
      } catch {
        callback({ cancel: true });
      }
    },
  );
  targetSession.protocol.handle(REMOTE_RESOURCE_SCHEME, async (request) => {
    try {
      const handle = lookup(request.url);
      if (!handle) return new Response("Resource unavailable", { status: 403 });
      const cors = {
        "Access-Control-Allow-Origin": origin(options.trustedOrigin()),
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Range",
        "Access-Control-Allow-Credentials": "true",
        "Cache-Control": "no-store",
      };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      const route = remoteResourceRoute(handle.reference.resource);
      if (request.method !== route.method)
        return new Response("Invalid method", { status: 405, headers: cors });
      const token = await controllerToken();
      const { base } = backend();
      const url = new URL(
        `${REMOTE_RESOURCE_LOCAL_PREFIX}${encodeURIComponent(handle.hostId)}`,
        base,
      );
      url.searchParams.set("reference", JSON.stringify(handle.reference));
      const headers = new Headers({ authorization: `Bearer ${token}` });
      for (const key of ["range", "content-type", "content-length"]) {
        const value = request.headers.get(key);
        if (value) headers.set(key, value);
      }
      const response = await fetch(url, {
        method: route.method,
        headers,
        ...(request.body ? { body: request.body, duplex: "half" } : {}),
        redirect: "error",
        signal: AbortSignal.any([request.signal, handle.lifetime.signal]),
      } as RequestInit);
      if (response.status === 401) bearer = undefined; // No replay, including partial uploads.
      const resultHeaders = new Headers(cors);
      for (const key of [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "content-disposition",
        "content-security-policy",
        "x-content-type-options",
      ]) {
        const value = response.headers.get(key);
        if (value) resultHeaders.set(key, value);
      }
      return new Response(response.body, { status: response.status, headers: resultHeaders });
    } catch {
      return new Response("Remote resource unavailable", { status: 503 });
    }
  });
  return () => {
    for (const id of handles.keys()) remove(id);
    for (const dispose of ownerCleanup.values()) dispose();
    keys.clear();
    bearer = undefined;
    ipcMain.removeAllListeners(DESKTOP_IPC_CHANNELS.remoteResourceUrl);
    targetSession.webRequest.onBeforeRequest(null);
    targetSession.protocol.unhandle(REMOTE_RESOURCE_SCHEME);
  };
}
