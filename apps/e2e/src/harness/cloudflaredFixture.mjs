#!/usr/bin/env node
// Isolated external-edge fixture. No provider credentials or production Cloudflare access.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
const config = JSON.parse(Buffer.from(process.env.TUNNEL_TOKEN, "base64url").toString());
const metrics = process.argv[process.argv.indexOf("--metrics") + 1];
const sockets = new Set();
const available = () => !fs.existsSync(config.pause);
const edge = https.createServer(
  { key: fs.readFileSync(config.key), cert: fs.readFileSync(config.cert) },
  (request, response) => {
    if (!available()) {
      response.writeHead(503).end();
      return;
    }
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: config.originPort,
        path: request.url,
        method: request.method,
        headers: { ...request.headers, host: config.hostname },
      },
      (remote) => {
        response.writeHead(remote.statusCode, remote.headers);
        remote.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  },
);
edge.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
edge.on("upgrade", (request, socket, head) => {
  if (!available()) {
    socket.destroy();
    return;
  }
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: config.originPort,
    path: request.url,
    headers: { ...request.headers, host: config.hostname },
  });
  upstream.on("upgrade", (response, remote, remoteHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n")}\r\n\r\n`,
    );
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    remote.on("error", () => socket.destroy());
    socket.on("error", () => remote.destroy());
    socket.on("close", () => remote.destroy());
    remote.on("close", () => socket.destroy());
    socket.pipe(remote).pipe(socket);
  });
  upstream.on("response", () => socket.destroy());
  upstream.on("error", () => socket.destroy());
  upstream.end();
});
await new Promise((resolve) => edge.listen(config.port, "127.0.0.1", resolve));
const readiness = http.createServer((_request, response) =>
  response.writeHead(available() ? 200 : 503).end(),
);
await new Promise((resolve) =>
  readiness.listen(Number(metrics.split(":")[1]), "127.0.0.1", resolve),
);
fs.writeFileSync(config.pid, String(process.pid), { mode: 0o600 });
const paused = setInterval(() => {
  if (!available()) for (const socket of sockets) socket.destroy();
}, 50);
function stop() {
  clearInterval(paused);
  for (const socket of sockets) socket.destroy();
  readiness.close();
  edge.close();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
