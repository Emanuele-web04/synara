import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { WS_COMPATIBILITY_QUERY, WS_METHODS } from "@synara/contracts";
import {
  computeExternalMcpRuntimeProof,
  EXTERNAL_MCP_RUNTIME_CHALLENGE_HEADER,
} from "../externalMcp/runtimeProof";
import { controllerProtocol } from "../hostConnections/dialer";
import { requestLocalRemoteAccess } from "./cli";

it.each([true, false])(
  "negotiates with a separately identified owner process only after its runtime proof (valid=%s)",
  async (validProof) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-remote-cli-test-"));
    const secret = "isolated-runtime-secret-12345678901234567890";
    const peerInstance = "separate-server-process-instance";
    let upgraded = false;
    let received: unknown;
    const server = http.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.startsWith("/api/mcp/external/runtime-challenge")) {
        response.end(
          JSON.stringify({
            proof: computeExternalMcpRuntimeProof(
              validProof ? secret : "wrong",
              String(request.headers[EXTERNAL_MCP_RUNTIME_CHALLENGE_HEADER]),
            ),
          }),
        );
      } else {
        response.end(
          JSON.stringify({
            protocolEpoch: controllerProtocol.protocolEpoch,
            negotiatedRevision: controllerProtocol.maxRevision,
            serverBuild: "0.9.2",
            serverInstanceId: peerInstance,
            capabilities: controllerProtocol.requiredCapabilities,
          }),
        );
      }
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      upgraded = true;
      const query = new URL(request.url!, "http://localhost").searchParams;
      if (query.get(WS_COMPATIBILITY_QUERY.serverInstanceId) !== peerInstance) {
        socket.end("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      sockets.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (data) => {
          received = JSON.parse(data.toString());
          ws.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: "1",
              exit: {
                _tag: "Success",
                value: {
                  kind: "host-state",
                  invitations: [],
                  devices: [],
                  rootExpiresAt: null,
                  rootNeedsRepair: true,
                },
              },
            }),
          );
        });
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      const stateDir = path.join(directory, "userdata");
      await fs.mkdir(stateDir, { mode: 0o700 });
      await fs.writeFile(
        path.join(stateDir, "server-runtime.json"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          host: "127.0.0.1",
          port: address.port,
          origin: `http://127.0.0.1:${address.port}`,
          startedAt: new Date().toISOString(),
          externalMcpRuntimeSecret: secret,
        }),
        { mode: 0o600 },
      );
      const result = requestLocalRemoteAccess(directory, { operation: "list" });
      if (validProof) {
        await expect(result).resolves.toMatchObject({ kind: "host-state", rootNeedsRepair: true });
        expect(received).toMatchObject({
          tag: WS_METHODS.hostsRemoteAccess,
          payload: { request: { operation: "list" } },
        });
      } else {
        await expect(result).rejects.toThrow("did not prove");
        expect(upgraded).toBe(false);
      }
    } finally {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
