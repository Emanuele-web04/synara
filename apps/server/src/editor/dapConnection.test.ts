import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DapConnection } from "./dapConnection";
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});
async function peer(connected: (socket: net.Socket) => void) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    connected(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
  const connection = new DapConnection(address.port);
  cleanups.push(() => {
    connection.dispose();
    sockets.forEach((socket) => socket.destroy());
    server.close();
  });
  return connection;
}
const message = (value: unknown) => {
  const json = JSON.stringify(value);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
};
describe("DAP transport framing", () => {
  it("handles fragmented headers and UTF-8 bodies without losing an adjacent event", async () => {
    const connection = await peer((socket) =>
      socket.once("data", () => {
        const bytes = Buffer.concat([
          message({
            seq: 1,
            type: "response",
            request_seq: 1,
            success: true,
            body: { value: "你好" },
          }),
          message({ seq: 2, type: "event", event: "output", body: { output: "done" } }),
        ]);
        socket.write(bytes.subarray(0, 12));
        setTimeout(() => socket.write(bytes.subarray(12)), 5);
      }),
    );
    const events: string[] = [];
    connection.onEvent = (name) => events.push(name);
    expect(await connection.request("evaluate")).toEqual({ value: "你好" });
    expect(events).toEqual(["output"]);
  });
  it("rejects oversized protocol messages and all pending requests", async () => {
    const connection = await peer((socket) =>
      socket.once("data", () => socket.write("Content-Length: 99999999\r\n\r\n")),
    );
    await expect(connection.request("threads")).rejects.toThrow("length");
  });
  it("bounds commands whose adapter never answers", async () => {
    const connection = await peer((socket) => socket.on("data", () => undefined));
    await expect(connection.request("threads", {}, 30)).rejects.toThrow("timed out");
  });
});
