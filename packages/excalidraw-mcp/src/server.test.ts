import { createServer as createHttpServer, type Server } from "node:http";
import { once } from "node:events";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeSceneSnapshot } from "./bridge";
import { createServer } from "./server";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

async function startBridge() {
  let revision = "revision-1";
  let scene: BridgeSceneSnapshot["scene"] = { elements: [], appState: {}, files: {} };
  const server = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    expect(request.headers.authorization).toBe("Bearer bridge-secret");
    expect(body.threadId).toBe("drawing-1");

    if (request.url?.endsWith("/save")) {
      expect(body.expectedRevision).toBe(revision);
      scene = body.scene as BridgeSceneSnapshot["scene"];
      revision = `revision-${Number(revision.split("-")[1]) + 1}`;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ relativePath: "drawings/drawing-1.excalidraw", scene, revision }),
    );
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Bridge did not bind a port.");
  return {
    config: {
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "bridge-secret",
      threadId: "drawing-1",
    },
    readScene: () => scene,
  };
}

describe("Synara Excalidraw MCP server", () => {
  it("initializes, lists bounded tools, and edits only the configured drawing", async () => {
    const bridge = await startBridge();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpServer = createServer(bridge.config);
    const client = new Client({ name: "synara-mcp-test", version: "1.0.0" });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "read_me",
      "read_scene",
      "create_view",
    ]);
    const read = await client.callTool({ name: "read_scene", arguments: {} });
    expect(read.isError).not.toBe(true);

    const first = await client.callTool({
      name: "create_view",
      arguments: {
        elements: JSON.stringify([
          {
            id: "layer-transport",
            type: "rectangle",
            x: 100,
            y: 200,
            width: 500,
            height: 100,
            label: { text: "Transport · TCP · UDP" },
          },
        ]),
      },
    });
    expect(first.isError).not.toBe(true);
    expect(bridge.readScene().elements).toHaveLength(1);
    expect(bridge.readScene().elements[0]?.id).toBe("layer-transport");

    await client.close();
    await mcpServer.close();
  });
});
