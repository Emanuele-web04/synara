import http from "node:http";
import { WebSocketServer } from "ws";
import { REMOTE_OUTER_PATH, type RemoteTlsServer } from "../remoteTransport/tunnel";

/** This listener has no local RPC/admin handler; forwarded headers confer no authority. */
export async function startCloudflareIngress(tunnel: RemoteTlsServer, available: () => boolean) {
  let hostname: string | undefined;
  const allowed = (request: http.IncomingMessage) =>
    hostname !== undefined && request.headers.host === hostname && available();
  const server = http.createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response
      .writeHead(
        allowed(request) && request.method === "GET" && request.url === "/health" ? 200 : 404,
      )
      .end();
  });
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
    perMessageDeflate: false,
  });
  server.on("upgrade", (request, socket, head) => {
    if (!allowed(request) || request.url !== REMOTE_OUTER_PATH || request.method !== "GET") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    websocket.handleUpgrade(request, socket, head, (outer) =>
      tunnel.accept(outer, { via: "cloudflare" }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as import("node:net").AddressInfo).port,
    setHostname: (value: string) => {
      hostname = value;
    },
    close: async () => {
      for (const socket of websocket.clients) socket.terminate();
      websocket.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
