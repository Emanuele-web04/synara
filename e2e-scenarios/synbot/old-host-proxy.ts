// A host built before SynBot, made from the current one (`start-app.ts --old-host` only).
//
//   bun old-host-proxy.ts <port> <serverPort>
//
// It sits between the web app and the server and passes everything through, except that every
// `bots.*` request reaches the server under a method name the server has never heard of. The
// server then answers exactly as a host without those methods does; nothing here makes up a
// reply. `GET /__scenario/state` counts the WebSocket connections the web app opened and the
// `bots.*` requests it sent, so a scenario can tell a reconnect loop from a quiet socket.
// `POST /__scenario/mode {"renameBots": false}` passes `bots.*` through untouched (the control).
//
// Run with Bun: it is the one runtime here with a WebSocket server and client built in.

interface ClientSocket {
  readonly data: {
    readonly path: string;
    upstream?: WebSocket;
    queue: Array<string | Uint8Array>;
  };
  send(message: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

const [port, serverPort] = process.argv.slice(2).map(Number);
const UPSTREAM = `127.0.0.1:${serverPort}`;
const UNKNOWN_SUFFIX = ".unknownOnThisHost";

let connections = 0;
let botRequests = 0;
const botTags: string[] = [];
/** Off: a plain pass-through, the control that shows the proxy itself changes nothing. */
let renameBots = true;

/** Renames `bots.*` requests in one client frame (a message or a batch of them). */
const rewrite = (frame: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return frame;
  }
  let changed = false;
  const visit = (message: unknown) => {
    if (!message || typeof message !== "object") return message;
    const request = message as { _tag?: unknown; tag?: unknown };
    if (
      request._tag === "Request" &&
      typeof request.tag === "string" &&
      request.tag.startsWith("bots.")
    ) {
      botRequests += 1;
      botTags.push(request.tag);
      if (!renameBots) return message;
      changed = true;
      return { ...request, tag: `${request.tag}${UNKNOWN_SUFFIX}` };
    }
    return message;
  };
  const next = Array.isArray(parsed) ? parsed.map(visit) : visit(parsed);
  return changed ? JSON.stringify(next) : frame;
};

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request: Request, server: { upgrade(request: Request, options: unknown): boolean }) {
    const url = new URL(request.url);
    if (url.pathname === "/__scenario/state") {
      return Response.json({ connections, botRequests, botTags: botTags.slice(-50), renameBots });
    }
    if (url.pathname === "/__scenario/mode" && request.method === "POST") {
      renameBots = ((await request.json()) as { renameBots?: unknown }).renameBots !== false;
      return Response.json({ renameBots });
    }
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const upgraded = server.upgrade(request, {
        data: { path: `${url.pathname}${url.search}`, queue: [] },
      });
      return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
    }
    const headers = new Headers(request.headers);
    headers.delete("host");
    const answer = await fetch(`http://${UPSTREAM}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
    return new Response(answer.body, { status: answer.status, headers: answer.headers });
  },
  websocket: {
    open(ws: ClientSocket) {
      connections += 1;
      const upstream = new WebSocket(`ws://${UPSTREAM}${ws.data.path}`);
      upstream.binaryType = "arraybuffer";
      ws.data.upstream = upstream;
      upstream.addEventListener("open", () => {
        for (const frame of ws.data.queue.splice(0)) upstream.send(frame);
      });
      upstream.addEventListener("message", (event: MessageEvent) => {
        ws.send(event.data as string | ArrayBuffer);
      });
      upstream.addEventListener("close", (event: CloseEvent) => {
        ws.close(event.code === 1005 || event.code === 1006 ? 1000 : event.code, event.reason);
      });
      upstream.addEventListener("error", () => ws.close(1011, "upstream error"));
    },
    message(ws: ClientSocket, message: string | Uint8Array) {
      const frame = typeof message === "string" ? rewrite(message) : message;
      const upstream = ws.data.upstream;
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(frame);
      else ws.data.queue.push(frame);
    },
    close(ws: ClientSocket) {
      ws.data.upstream?.close();
    },
  },
});

console.error(`[old-host-proxy] listening on ${port}, server ${serverPort}`);
