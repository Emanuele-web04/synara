import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type RequestListener,
  type Server as HttpServer,
} from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { decodeOutboundJson, outboundHttp } from "./outboundHttp";

/**
 * A port nothing is listening on, so every connection attempt is refused.
 *
 * HTTPS because the outbound policy rejects plain HTTP destinations outright,
 * which would fail the request before it ever reaches a socket.
 *
 * Taken by opening a server and closing it, which is more reliable than picking
 * a number and hoping: the OS will not hand the same port out again while this
 * process holds the reference.
 */
async function refusedPort(): Promise<number> {
  const server: NetServer = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const policyFor = (port: number) => ({
  service: "test",
  allowedOrigins: [`https://127.0.0.1:${port}`],
  timeoutMs: 5_000,
  maxRequestBytes: 0,
  maxResponseBytes: 64 * 1024,
  maxRedirects: 0,
  maxConcurrent: 2,
  maxQueued: 4,
  requirePublicAddress: false,
});

async function listenHttpServer(
  listener: RequestListener,
): Promise<{ readonly server: HttpServer; readonly origin: string }> {
  const server = createHttpServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Expected HTTP server address.");
  }
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const loopbackPolicyFor = (allowedOrigins: ReadonlyArray<string>, maxRedirects = 0) => ({
  service: "loopback-test",
  allowedOrigins,
  timeoutMs: 5_000,
  maxRequestBytes: 0,
  maxResponseBytes: 64 * 1024,
  maxRedirects,
  maxConcurrent: 2,
  maxQueued: 4,
  requirePublicAddress: true,
  allowLoopbackHttp: true,
});

/**
 * These cover the observable contract: a refused connection rejects, and the
 * client is still usable afterwards.
 *
 * The specific regression behind the `on`/`once` change is not reproducible
 * here. It needs a host whose addresses all refuse so Happy Eyeballs emits
 * `error` more than once, and the client pins DNS to a single address, so a
 * request from this suite can only ever emit once. It was reproduced by hand
 * against a real multi-address host: the request rejected correctly, execution
 * continued, and the process then died on the second emit.
 */
describe("outbound requests that cannot connect", () => {
  it("survives an immediate TLS connection error and serves the next request", async () => {
    // A synchronous pinned lookup can destroy the TLS socket during its
    // constructor, before Node attaches its error handlers. Keep the fatal
    // regression in a child process and exercise the real transport there.
    const directory = await mkdtemp(join(tmpdir(), "synara-outbound-tls-"));
    try {
      for (const name of ["outboundHttpPolicy", "outboundHttp"]) {
        const source = await readFile(new URL(`./${name}.ts`, import.meta.url), "utf8");
        const transformed = stripTypeScriptTypes(source, { mode: "transform" }).replace(
          '"./outboundHttpPolicy"',
          '"./outboundHttpPolicy.mjs"',
        );
        await writeFile(join(directory, `${name}.mjs`), transformed);
      }
      const fixture = join(directory, "connection-failure.mjs");
      await writeFile(
        fixture,
        `import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createServer } from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { outboundHttp, OutboundHttpError } from "./outboundHttp.mjs";

// Pin localhost to IPv4; the connection failure itself comes from the OS.
const lookup = dns.lookup;
dns.lookup = (hostname, options) => hostname === "localhost"
  ? Promise.resolve([{ address: "127.0.0.1", family: 4 }])
  : lookup(hostname, options);
syncBuiltinESMExports();
const policy = {
  service: "tls-lifecycle-test", allowedOrigins: ["https://localhost"],
  timeoutMs: 1000, maxRequestBytes: 0, maxResponseBytes: 1024,
  maxRedirects: 0, maxConcurrent: 1, maxQueued: 1, requirePublicAddress: false,
};
// TEST-NET-1 is not a local interface, so bind fails before TLS setup completes.
https.globalAgent.options.localAddress = "192.0.2.123";
await assert.rejects(outboundHttp.request({ policy, url: "https://localhost/" }),
  (error) => error instanceof OutboundHttpError && error.code === "request"
    && error.cause?.code === "EADDRNOTAVAIL");
delete https.globalAgent.options.localAddress;

const server = createServer((_request, response) => response.end("ok"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const origin = "http://127.0.0.1:" + server.address().port;
  const response = await outboundHttp.request({
    policy: { ...policy, allowedOrigins: [origin], allowLoopbackHttp: true },
    url: origin,
  });
  assert.equal(response.status, 200);
  assert.equal(new TextDecoder().decode(response.body), "ok");
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log("survived");
`,
      );
      const { stdout } = await promisify(execFile)(process.execPath, [fixture], {
        timeout: 10_000,
      });
      expect(stdout.trim()).toBe("survived");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects rather than hanging", async () => {
    const port = await refusedPort();

    await expect(
      outboundHttp.request({
        policy: policyFor(port),
        url: `https://127.0.0.1:${port}/favicon.ico`,
        headers: { Accept: "image/*" },
      }),
    ).rejects.toThrow(/Outbound request failed/u);
  });
});

describe("loopback HTTP transport", () => {
  it("performs an explicitly opted-in request against a local HTTP server", async () => {
    const { server, origin } = await listenHttpServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });

    try {
      const response = await outboundHttp.request({
        policy: loopbackPolicyFor([origin]),
        url: `${origin}/status`,
      });

      expect(response.status).toBe(200);
      expect(decodeOutboundJson(response, { maxDepth: 4, maxNodes: 10 })).toEqual({ ok: true });
    } finally {
      await closeHttpServer(server);
    }
  });

  it("rejects redirects to another origin even when both origins are allowed", async () => {
    let redirectOrigin = "";
    let targetRequests = 0;
    const { server, origin } = await listenHttpServer((request, response) => {
      if (request.url === "/target") {
        targetRequests += 1;
        response.end("unexpected");
        return;
      }
      response.statusCode = 302;
      response.setHeader("Location", `${redirectOrigin}/target`);
      response.end();
    });
    redirectOrigin = origin.replace("127.0.0.1", "localhost");

    try {
      await expect(
        outboundHttp.request({
          policy: loopbackPolicyFor([origin, redirectOrigin], 1),
          url: `${origin}/redirect`,
        }),
      ).rejects.toMatchObject({ code: "invalid-redirect" });
      expect(targetRequests).toBe(0);
    } finally {
      await closeHttpServer(server);
    }
  });
});
