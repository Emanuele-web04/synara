import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { accountFetch } from "./accountHttp.ts";

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/**
 * A bare HTTP/1.1 server that, like the account API's edge, sends no
 * `Keep-Alive: timeout` hint, so the client alone decides how long an idle
 * connection lives. Answers each request with its method and authorization.
 */
async function startServer(): Promise<{ url: string; connections: () => number }> {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const headerEnd = buffered.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const head = buffered.subarray(0, headerEnd).toString("latin1").split("\r\n");
        const header = (name: string) =>
          head
            .find((line) => line.toLowerCase().startsWith(`${name}:`))
            ?.slice(name.length + 1)
            .trim();
        const bodyLength = Number(header("content-length") ?? 0);
        if (buffered.length < headerEnd + 4 + bodyLength) return;
        buffered = buffered.subarray(headerEnd + 4 + bodyLength);
        const body = JSON.stringify({
          method: head[0]!.split(" ")[0],
          auth: header("authorization"),
        });
        socket.write(
          `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, connections: () => connections };
}

describe("accountFetch", () => {
  // Node's fetch drops an idle connection after 4 s; account polls are 10-60 s apart.
  it("reuses one connection across a gap longer than Node's 4 s default", async () => {
    const server = await startServer();
    const first = await accountFetch(server.url);
    await first.json();
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    const second = await accountFetch(server.url, {
      method: "POST",
      headers: { authorization: "Bearer test" },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    expect(await second.json()).toEqual({ method: "POST", auth: "Bearer test" });
    expect(server.connections()).toBe(1);
  }, 15_000);
});
