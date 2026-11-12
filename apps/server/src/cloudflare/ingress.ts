import http from "node:http";
import { WebSocketServer } from "ws";
import { REMOTE_OUTER_PATH, type RemoteTlsServer } from "../remoteTransport/tunnel";
import { reportReliabilityIssue } from "../reliability";

/**
 * This listener has no local RPC/admin handler; forwarded headers confer no authority.
 * `prepare` runs before `available` is read, for a request addressed to this
 * host, so admission can first fetch a fresh authorization; it must not reject.
 */
export async function startCloudflareIngress(
  tunnel: RemoteTlsServer,
  available: () => boolean,
  prepare: () => Promise<void> = async () => {},
) {
  let hostname: string | undefined;
  const allowed = async (request: http.IncomingMessage) => {
    if (hostname === undefined || request.headers.host !== hostname) return false;
    await prepare();
    return available();
  };
  const server = http.createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    void allowed(request)
      .catch(() => false)
      .then((admitted) =>
        response
          .writeHead(admitted && request.method === "GET" && request.url === "/health" ? 200 : 404)
          .end(),
      );
  });
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
    perMessageDeflate: false,
  });
  server.on("upgrade", (request, socket, head) => {
    // Node removes its HTTP socket error listener when handing off an upgrade.
    const onError = () => {
      reportReliabilityIssue("remote.ingress_socket_error");
      socket.destroy();
    };
    socket.on("error", onError);
    const refuse = () => socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    if (request.url !== REMOTE_OUTER_PATH || request.method !== "GET") {
      refuse();
      return;
    }
    void allowed(request)
      .catch(() => false)
      .then((admitted) => {
        if (socket.destroyed) return;
        if (!admitted) {
          refuse();
          return;
        }
        socket.off("error", onError);
        websocket.handleUpgrade(request, socket, head, (outer) =>
          tunnel.accept(outer, { via: "cloudflare" }),
        );
      });
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
