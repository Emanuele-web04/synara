import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ensureAgentGatewayStdioProxyScript } from "./stdioProxyScript.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs).unref();
    }),
  ]);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await withTimeout(new Promise<void>((resolve) => child.once("exit", () => resolve()))).catch(
    () => undefined,
  );
}

describe("agent gateway stdio proxy", () => {
  it("forwards cancellation immediately and lets a later ping bypass a hung request", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "synara-stdio-proxy-"));
    const slowStarted = deferred<void>();
    const duplicateStarted = deferred<void>();
    const slowAborted = deferred<void>();
    const cancellationReceived = deferred<void>();
    let slowRequestCount = 0;
    let duplicateAborted = false;
    let server: Server | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;

    try {
      server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id?: string;
          method?: string;
          params?: { requestId?: string };
        };
        if (message.id === "slow") {
          slowRequestCount += 1;
          if (slowRequestCount === 1) {
            response.once("close", () => slowAborted.resolve(undefined));
            slowStarted.resolve(undefined);
          } else {
            response.once("close", () => {
              duplicateAborted = true;
            });
            duplicateStarted.resolve(undefined);
          }
          return;
        }
        if (message.method === "notifications/cancelled") {
          expect(message.params?.requestId).toBe("slow");
          cancellationReceived.resolve(undefined);
          response.statusCode = 202;
          response.end();
          return;
        }
        if (message.method === "ping") {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
          return;
        }
        response.statusCode = 500;
        response.end();
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server!.once("error", onError);
        server!.listen(0, "127.0.0.1", () => {
          server!.off("error", onError);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");

      const scriptPath = await Effect.runPromise(
        ensureAgentGatewayStdioProxyScript(stateDir).pipe(Effect.provide(NodeServices.layer)),
      );
      child = spawn(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          SYNARA_AGENT_GATEWAY_URL: `http://127.0.0.1:${address.port}/mcp`,
          SYNARA_AGENT_GATEWAY_TOKEN: "test-token",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const pingResponse = deferred<Record<string, unknown>>();
      const stderr: string[] = [];
      let stdoutBuffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        let newlineIndex: number;
        while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (!line) continue;
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.id === "ping-after-cancel") pingResponse.resolve(message);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => stderr.push(chunk));

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "slow",
          method: "tools/call",
          params: { name: "browser_wait", arguments: { timeoutMs: 30_000 } },
        })}\n`,
      );
      await withTimeout(slowStarted.promise);
      // A duplicate id must not steal the proxy's cancellation route from the
      // first call. This test intentionally leaves the duplicate open so
      // targeting the wrong fetch is visible.
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "slow",
          method: "tools/call",
          params: { name: "browser_wait", arguments: { timeoutMs: 30_000 } },
        })}\n`,
      );
      await withTimeout(duplicateStarted.promise);

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "slow", reason: "user-stop" },
        })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "ping-after-cancel",
          method: "ping",
        })}\n`,
      );

      expect(await withTimeout(pingResponse.promise)).toEqual({
        jsonrpc: "2.0",
        id: "ping-after-cancel",
        result: {},
      });
      await withTimeout(cancellationReceived.promise);
      await withTimeout(slowAborted.promise);
      expect(duplicateAborted).toBe(false);
      expect(stderr).toEqual([]);

      child.stdin.end();
      await withTimeout(new Promise<void>((resolve) => child!.once("exit", () => resolve())));
    } finally {
      if (child) await stopChild(child);
      if (server) await closeServer(server);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("exchanges an ambient one-shot bootstrap and keeps the bearer inside the proxy", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "synara-stdio-bootstrap-"));
    const bootstrapStarted = deferred<void>();
    let bootstrapExchanges = 0;
    let forwardedRequests = 0;
    let server: Server | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;

    try {
      server = createServer(async (request, response) => {
        if (request.url === "/mcp/bootstrap") {
          bootstrapExchanges += 1;
          expect(request.headers.authorization).toBe("Bearer one-shot-bootstrap");
          if (bootstrapExchanges > 1) {
            response.statusCode = 401;
            response.end();
            return;
          }
          bootstrapStarted.resolve(undefined);
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ bearerToken: "private-session-bearer" }));
          return;
        }
        expect(request.url).toBe("/mcp");
        expect(request.headers.authorization).toBe("Bearer private-session-bearer");
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string };
        forwardedRequests += 1;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server!.once("error", onError);
        server!.listen(0, "127.0.0.1", () => {
          server!.off("error", onError);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");

      const scriptPath = await Effect.runPromise(
        ensureAgentGatewayStdioProxyScript(stateDir).pipe(Effect.provide(NodeServices.layer)),
      );
      const providerEnvironment = {
        PATH: process.env.PATH,
        SYNARA_AGENT_GATEWAY_URL: `http://127.0.0.1:${address.port}/mcp`,
        SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN: "one-shot-bootstrap",
      };
      child = spawn(process.execPath, [scriptPath], {
        env: providerEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const responses = new Map<string, ReturnType<typeof deferred<Record<string, unknown>>>>();
      let stdoutBuffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        let newlineIndex: number;
        while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (!line) continue;
          const message = JSON.parse(line) as Record<string, unknown>;
          responses.get(String(message.id))?.resolve(message);
        }
      });

      // The exchange is eager: by the time a provider command descendant can
      // run, it inherits no real bearer and the ambient one-shot credential is
      // already spent.
      await withTimeout(bootstrapStarted.promise);
      const runProviderDescendant = async (): Promise<unknown> => {
        const descendant = spawn(
          process.execPath,
          [
            "-e",
            `const url = process.env.SYNARA_AGENT_GATEWAY_URL + "/bootstrap";
             fetch(url, { method: "POST", headers: { Authorization: "Bearer " + process.env.SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN } })
               .then((response) => process.stdout.write(JSON.stringify({ status: response.status, bearer: process.env.SYNARA_AGENT_GATEWAY_TOKEN ?? null })))
               .catch((error) => { console.error(error); process.exitCode = 1; });`,
          ],
          { env: providerEnvironment, stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        descendant.stdout.setEncoding("utf8");
        descendant.stdout.on("data", (chunk: string) => (output += chunk));
        await withTimeout(new Promise<void>((resolve) => descendant.once("exit", () => resolve())));
        return JSON.parse(output) as unknown;
      };
      // Before the first MCP initialize/ping message, the proxy has already
      // consumed the bootstrap and a peer descendant cannot win the race.
      expect(await runProviderDescendant()).toEqual({ status: 401, bearer: null });

      for (const id of ["first", "second"]) {
        const response = deferred<Record<string, unknown>>();
        responses.set(id, response);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "ping" })}\n`);
        expect(await withTimeout(response.promise)).toEqual({
          jsonrpc: "2.0",
          id,
          result: {},
        });
      }

      // Replay remains impossible after normal MCP traffic as well.
      expect(await runProviderDescendant()).toEqual({ status: 401, bearer: null });

      expect(bootstrapExchanges).toBe(3);
      expect(forwardedRequests).toBe(2);
      child.stdin.end();
      await withTimeout(new Promise<void>((resolve) => child!.once("exit", () => resolve())));
    } finally {
      if (child) await stopChild(child);
      if (server) await closeServer(server);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("aborts a hung eager bootstrap when stdin closes", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "synara-stdio-bootstrap-abort-"));
    const bootstrapStarted = deferred<void>();
    let server: Server | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;

    try {
      server = createServer((request) => {
        if (request.url === "/mcp/bootstrap") bootstrapStarted.resolve(undefined);
        // Intentionally never respond. Closing stdin must still stop the proxy.
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server!.once("error", onError);
        server!.listen(0, "127.0.0.1", () => {
          server!.off("error", onError);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");

      const scriptPath = await Effect.runPromise(
        ensureAgentGatewayStdioProxyScript(stateDir).pipe(Effect.provide(NodeServices.layer)),
      );
      child = spawn(process.execPath, [scriptPath], {
        env: {
          PATH: process.env.PATH,
          SYNARA_AGENT_GATEWAY_URL: `http://127.0.0.1:${address.port}/mcp`,
          SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN: "hung-bootstrap",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      await withTimeout(bootstrapStarted.promise);
      child.stdin.end();
      await withTimeout(
        new Promise<void>((resolve) => child!.once("exit", () => resolve())),
        1_000,
      );
    } finally {
      if (child) await stopChild(child);
      if (server) await closeServer(server);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
