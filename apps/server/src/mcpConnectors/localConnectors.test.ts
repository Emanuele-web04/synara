import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import * as Http from "node:http";
import { describe, expect, it } from "vitest";
import { McpConnectorRuntime } from "./runtime.ts";
import { normalizeConnectorInput } from "./config.ts";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

function harness() {
  let saved: string | null = null;
  let registrations: ReadonlyArray<{ name: string; connectorId: string }> = [];
  let now = Date.now();
  const runtime = new McpConnectorRuntime({
    load: async () => saved,
    save: async (document) => {
      saved = document;
    },
    publish: (next) => {
      registrations = next;
    },
    redirectUrl: () => "http://127.0.0.1/oauth/mcp/callback",
    clientVersion: "1",
    logWarning: () => {},
    ownerActive: (token) => token === "owner" || token === "other",
    now: () => now,
  });
  return {
    runtime,
    saved: () => saved,
    registrations: () => registrations,
    advance: () => {
      now += 20_000;
    },
  };
}

describe("local connector approval and execution", () => {
  it("keeps a stdio proposal inert, hides env values, binds sessions, cancels calls and confirms removal", async () => {
    const dir = await mkdtemp(Path.join(tmpdir(), "synara-mcp-stdio-"));
    const fixture = Path.join(dir, "server.mjs");
    const marker = Path.join(dir, "started");
    await writeFile(
      fixture,
      `
      import { appendFileSync } from "node:fs";
      import { createInterface } from "node:readline";
      appendFileSync("started", "start\\n");
      const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:"2.0", id, result}) + "\\n");
      createInterface({input:process.stdin}).on("line", (line) => {
        const m = JSON.parse(line);
        if(m.method === "initialize") send(m.id, {protocolVersion:"2025-06-18", capabilities:{tools:{}}, serverInfo:{name:"fixture", version:"1"}});
        else if(m.method === "tools/list") send(m.id, {tools:[{name:"ping", inputSchema:{type:"object"}}]});
        else if(m.method === "tools/call" && m.params.name === "wait") appendFileSync("started", "waiting\\n");
        else if(m.method === "notifications/cancelled") appendFileSync("started", "cancelled\\n");
        else if(m.method === "tools/call") send(m.id, {content:[{type:"text",text:process.env.MCP_TEST_SECRET === "test-secret" ? "configured" : "missing"}]});
      });
      process.stdin.on("end", () => process.exit(0));
    `,
    );
    const h = harness();
    try {
      await h.runtime.init();
      const proposal = await h.runtime.proposeAdd(
        {
          name: "Fixture",
          command: process.execPath,
          args: [fixture],
          cwd: dir,
          env: { MCP_TEST_SECRET: "test-secret" },
        },
        "thread",
      );
      expect(proposal.connector).toMatchObject({
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        cwd: dir,
        envKeys: ["MCP_TEST_SECRET"],
      });
      expect(JSON.stringify(h.runtime.listProposals())).not.toContain("test-secret");
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(h.registrations()).toEqual([]);
      await h.runtime.resolveProposal({ proposalId: proposal.proposalId, resolution: "accepted" });
      const connector = h.runtime.list()[0]!;
      expect(connector).toMatchObject({ status: "connected", transport: "stdio" });
      expect(JSON.stringify(h.runtime.list())).not.toContain("test-secret");
      expect(h.saved()).toContain("test-secret"); // This document is written only through ServerSecretStore.
      expect(h.registrations()).toEqual([
        { name: connector.serverName, connectorId: connector.connectorId },
      ]);
      const start = await h.runtime.forward(connector.connectorId, {
        method: "POST",
        ownerToken: "owner",
        body: initialize,
      });
      expect(start.sessionId).toBeTruthy();
      const sessionId = start.sessionId!;
      const call = (id: string, name: string) => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
      const result = await h.runtime.forward(connector.connectorId, {
        method: "POST",
        ownerToken: "owner",
        sessionId,
        body: call("ping", "ping"),
      });
      expect(result.body).toMatchObject({
        kind: "json",
        value: { result: { content: [{ text: "configured" }] } },
      });
      const stolen = await h.runtime.forward(connector.connectorId, {
        method: "POST",
        ownerToken: "other",
        sessionId,
        body: call("stolen", "ping"),
      });
      expect(stolen.body).toMatchObject({ kind: "json", value: { error: expect.any(Object) } });
      const waiting = h.runtime.forward(connector.connectorId, {
        method: "POST",
        ownerToken: "owner",
        sessionId,
        body: call("caller-77", "wait"),
      });
      await expect.poll(async () => readFile(marker, "utf8")).toContain("waiting");
      await h.runtime.forward(connector.connectorId, {
        method: "POST",
        ownerToken: "owner",
        sessionId,
        body: {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "caller-77" },
        },
      });
      expect((await waiting).body).toMatchObject({
        kind: "json",
        value: { error: expect.any(Object) },
      });
      await expect.poll(async () => readFile(marker, "utf8")).toContain("cancelled");
      const removal = await h.runtime.proposeRemove(connector.connectorId, "thread");
      expect(h.runtime.list()).toHaveLength(1);
      await h.runtime.resolveProposal({ proposalId: removal.proposalId, resolution: "dismissed" });
      expect(h.runtime.list()).toHaveLength(1);
      const approvedRemoval = await h.runtime.proposeRemove(connector.connectorId, "thread");
      await h.runtime.resolveProposal({
        proposalId: approvedRemoval.proposalId,
        resolution: "accepted",
      });
      expect(h.runtime.list()).toEqual([]);
      expect(h.registrations()).toEqual([]);
      expect(h.saved()).not.toContain("test-secret");
    } finally {
      await h.runtime.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps an offline loopback connector and publishes it only when the server answers", async () => {
    let probes = 0;
    const server = Http.createServer((_req, res) => {
      probes += 1;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "local", version: "1" },
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as import("node:net").AddressInfo;
    const h = harness();
    try {
      const proposal = await h.runtime.proposeAdd(
        { name: "Local", url: `http://127.0.0.1:${address.port}/mcp` },
        "thread",
      );
      expect(probes).toBe(0);
      await h.runtime.resolveProposal({ proposalId: proposal.proposalId, resolution: "accepted" });
      expect(h.runtime.list()[0]).toMatchObject({ transport: "local-http", status: "connected" });
      expect(probes).toBe(1);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      h.advance();
      await h.runtime.refreshLocalStatus();
      expect(h.runtime.list()[0]?.status).toBe("unreachable");
      expect(h.registrations()).toEqual([]);
      await new Promise<void>((resolve) => server.listen(address.port, "127.0.0.1", resolve));
      h.advance();
      await h.runtime.refreshLocalStatus();
      expect(h.runtime.list()[0]?.status).toBe("connected");
      expect(h.registrations()).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await h.runtime.dispose();
    }
  });

  it.each([
    { name: "Bad", command: "node", args: "--help" },
    { name: "Bad", command: "node", args: ["a\0b"] },
    { name: "Bad", command: "node", args: [], env: { "BAD=KEY": "secret" } },
    { name: "Bad", command: "node", args: [], url: "https://example.com" },
  ])("rejects invalid stdio settings before execution: %j", (input) => {
    expect(() => normalizeConnectorInput(input)).toThrow();
  });
});
