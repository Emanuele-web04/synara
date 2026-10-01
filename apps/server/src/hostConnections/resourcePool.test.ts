import http from "node:http";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { HttpRouter } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime, Scope, Exit } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { EnvironmentId, type RemoteResourceReference } from "@synara/contracts";
import { createRemoteDialFixture } from "../__fixtures__/remoteDial";
import { SessionCredentialServiceLive } from "../auth/Layers/SessionCredentialService";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { ServerConfig } from "../config";
import {
  attachmentPrincipalForSession,
  bindRemoteAttachmentSession,
} from "../managedAttachmentPrincipal";
import { ServerAuthLive } from "../auth/Layers/ServerAuth";
import { AuthControlPlaneLive } from "../auth/Layers/AuthControlPlane";
import { BootstrapCredentialServiceLive } from "../auth/Layers/BootstrapCredentialService";
import { ServerAuthPolicyLive } from "../auth/Layers/ServerAuthPolicy";
import { HostConnectionRegistry, HostConnectionRegistryService } from "./registry";
import { hostConnectionRouteLayer } from "./httpRoute";
import { dialHost } from "./dialer";
import { RemoteResourcePool } from "./resourcePool";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as { port: number }).port;
}

it("streams encrypted resources with client authority, stable attachment ownership, ranges, bounded pooling and revocation", async () => {
  const registry = new HostConnectionRegistry();
  const controlPlane = AuthControlPlaneLive.pipe(
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(SessionCredentialServiceLive),
  );
  const auth = ServerAuthLive.pipe(
    Layer.provide(ServerAuthPolicyLive),
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(SessionCredentialServiceLive),
    Layer.provide(controlPlane),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      auth,
      SessionCredentialServiceLive,
      Layer.succeed(HostConnectionRegistryService, registry),
    ).pipe(
      Layer.provide(SqlitePersistenceMemory),
      Layer.provide(ServerSecretStoreLive),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "synara-resource-test-" }),
      ),
      Layer.provide(NodeServices.layer),
    ),
  );
  cleanups.push(() => runtime.dispose());
  const localSessions = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* SessionCredentialService;
    }),
  );
  const payload = randomBytes(1024 * 1024);
  const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const observed: Array<{
    path: string;
    role: string;
    ownerId: string;
    headers: http.IncomingHttpHeaders;
  }> = [];
  let hold = false;
  let slow = false;
  let slowClosed = false;
  let slowBytes = 0;
  let partial = false;
  let partialBytes = 0;
  let partialAborted = false;
  const held: http.ServerResponse[] = [];
  const port = await serve((request, response) => {
    void (async () => {
      const session = await Effect.runPromise(
        localSessions.verify(request.headers.authorization!.slice(7)),
      );
      observed.push({
        path: request.url!,
        role: session.role,
        ownerId: attachmentPrincipalForSession(session.sessionId).ownerId,
        headers: request.headers,
      });
      if (hold) {
        held.push(response);
        return;
      }
      if (partial && request.method === "POST") {
        request.on("data", (chunk: Buffer) => {
          partialBytes += chunk.length;
        });
        request.once("aborted", () => {
          partialAborted = true;
        });
        request.resume();
        return;
      }
      if (slow) {
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": 128 * 1024 * 1024,
        });
        response.once("close", () => {
          slowClosed = true;
        });
        const chunk = Buffer.alloc(64 * 1024, 1);
        const pump = () => {
          while (!response.destroyed && slowBytes < 128 * 1024 * 1024) {
            slowBytes += chunk.length;
            if (!response.write(chunk)) {
              response.once("drain", pump);
              return;
            }
          }
          if (!response.destroyed) response.end();
        };
        pump();
        return;
      }
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        response.end(hash(Buffer.concat(chunks)));
        return;
      }
      if (request.headers.range) {
        response.writeHead(206, {
          "content-range": `bytes 11-99/${payload.length}`,
          "content-length": "89",
          "accept-ranges": "bytes",
          "set-cookie": "must-not-leak=1",
        });
        response.end(payload.subarray(11, 100));
        return;
      }
      response.writeHead(200, { "content-length": payload.length });
      response.end(payload);
    })().catch(() => response.writeHead(500).end());
  });
  const fixture = await createRemoteDialFixture(cleanups, true, {
    listeningPort: port,
    localSessions,
  });
  const rpc = await dialHost(fixture);
  const pool = new RemoteResourcePool({
    ...fixture,
    credential: rpc.credential,
    credentialExpiresAtSeconds: rpc.credentialExpiresAtSeconds,
  });
  cleanups.push(() => pool.close());
  const environmentId = EnvironmentId.makeUnsafe(fixture.host.environmentId);
  let resource: RemoteResourceReference["resource"] = {
    kind: "attachment-upload",
    threadId: "same-thread-id",
    type: "file",
    name: "test.bin",
    mimeType: "application/octet-stream",
  };
  registry.setConnector(fixture.host.id, "Fixture Mini", () => dialHost(fixture));
  registry.add({ hostId: fixture.host.id, hostName: "Fixture Mini", session: rpc });
  registry.setResourceFactory(fixture.host.id, async () => pool);
  const scope = await Effect.runPromise(Scope.make("sequential"));
  cleanups.push(async () => {
    registry.closeAll();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
  const controller = await runtime.runPromise(
    Scope.provide(
      Effect.gen(function* () {
        const server = yield* NodeHttpServer.make(() => http.createServer(), {
          port: 0,
          host: "127.0.0.1",
        });
        const handler = yield* HttpRouter.toHttpEffect(hostConnectionRouteLayer);
        yield* server.serve(handler);
        if (server.address._tag !== "TcpAddress") throw new Error("Expected TCP");
        return server.address.port;
      }),
      scope,
    ),
  );
  const url = () =>
    `http://127.0.0.1:${controller}/api/remote/resource/${fixture.host.id}?${new URLSearchParams({ reference: JSON.stringify({ environmentId, resource }) })}`;
  const owner = await Effect.runPromise(localSessions.issue({ role: "owner" }));
  const client = await Effect.runPromise(localSessions.issue({ role: "client" }));
  expect((await fetch(url())).status).toBe(403);
  expect(
    (await fetch(url(), { headers: { authorization: `Bearer ${client.token}` } })).status,
  ).toBe(403);
  expect(observed.length).toBe(0);
  const fetchOwned = (target: string, init: RequestInit = {}) =>
    fetch(target, {
      ...init,
      headers: { authorization: `Bearer ${owner.token}`, ...init.headers },
    });
  const upload = await fetchOwned(url(), {
    method: "POST",
    body: payload,
    headers: {
      "content-type": "application/octet-stream",
      cookie: "controller-cookie=1",
      origin: `http://127.0.0.1:${controller}`,
    },
  });
  expect(await upload.text()).toBe(hash(payload));
  expect(observed[0]).toMatchObject({ role: "client" });
  expect(observed[0]!.headers.cookie).toBeUndefined();
  expect(observed[0]!.headers.authorization).not.toContain(owner.token);
  expect(observed[0]!.headers.origin).toBe(`http://127.0.0.1:${port}`);
  const unbind = bindRemoteAttachmentSession("separate-rpc-lease", {
    environmentId,
    rootFingerprint: fixture.anchor.rootFingerprint,
    userId: "owner",
    deviceJkt: fixture.deviceJkt,
    trustGeneration: 1,
  });
  cleanups.push(unbind);
  expect(observed[0]!.ownerId).toBe(attachmentPrincipalForSession("separate-rpc-lease").ownerId);
  resource = { kind: "attachment", attachmentId: "att_v2_test" };
  const downloaded = new Uint8Array(await (await fetchOwned(url())).arrayBuffer());
  expect(downloaded.length).toBe(payload.length);
  expect(hash(downloaded)).toBe(hash(payload));
  const ranged = await fetchOwned(url(), { headers: { range: "bytes=11-99" } });
  expect(ranged.status).toBe(206);
  expect(ranged.headers.get("content-range")).toBe(`bytes 11-99/${payload.length}`);
  expect(ranged.headers.get("set-cookie")).toBeNull();
  expect(Buffer.from(await ranged.arrayBuffer())).toEqual(payload.subarray(11, 100));
  const before = observed.length;
  expect((await fetchOwned(url(), { headers: { range: "bytes=0-1,4-5" } })).status).toBe(403);
  expect(observed.length).toBe(before);
  for (const attachmentId of ["../secrets", "%2e%2e%2fsecrets", "https://attacker.test/private"]) {
    resource = { kind: "attachment", attachmentId };
    expect((await fetchOwned(url())).status).toBe(403);
  }
  expect(observed.length).toBe(before);
  resource = { kind: "attachment", attachmentId: "att_v2_test" };
  slow = true;
  const slowAbort = new AbortController();
  const slowResponse = await fetchOwned(url(), { signal: slowAbort.signal });
  const reader = slowResponse.body!.getReader();
  expect((await reader.read()).value?.length).toBeGreaterThan(0);
  // Leave the body unread: backpressure must prevent buffering the whole object.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(slowBytes).toBeLessThan(128 * 1024 * 1024);
  slowAbort.abort();
  await vi.waitFor(() => expect(slowClosed).toBe(true));
  slow = false;
  partial = true;
  resource = {
    kind: "attachment-upload",
    threadId: "same-thread-id",
    type: "file",
    name: "partial.bin",
    mimeType: "application/octet-stream",
  };
  const uploadAbort = new AbortController();
  const callsBeforePartial = observed.length;
  let uploadController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      uploadController = controller;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
  });
  const incomplete = fetchOwned(url(), {
    method: "POST",
    body,
    duplex: "half",
    signal: uploadAbort.signal,
    headers: { "content-type": "application/octet-stream" },
  } as RequestInit);
  const failedUpload = expect(incomplete).rejects.toThrow();
  await vi.waitFor(() => expect(partialBytes).toBe(64 * 1024));
  uploadAbort.abort();
  uploadController.close();
  await failedUpload;
  await vi.waitFor(() => expect(partialAborted).toBe(true));
  expect(observed.length).toBe(callsBeforePartial + 1);
  partial = false;
  resource = { kind: "attachment", attachmentId: "att_v2_test" };
  hold = true;
  const transfers = Array.from({ length: 6 }, () =>
    fetchOwned(url()).then(
      async (response) => {
        await response.arrayBuffer();
        return response.ok ? "finished" : "refused";
      },
      () => "closed",
    ),
  );
  await vi.waitFor(() => expect(held.length).toBe(2));
  expect(fixture.tunnel.connectionCount).toBeLessThanOrEqual(3); // One RPC and two HTTP TLS channels.
  fixture.authorize.mockRejectedValue(new Error("Revoked on host"));
  fixture.sessions.closeDevice(fixture.deviceJkt);
  expect(await Promise.all(transfers.slice(0, 2))).toEqual(["closed", "closed"]);
  pool.close();
  expect(await Promise.all(transfers)).not.toContain("finished");
  expect(held.length).toBe(2);
  await vi.waitFor(() => expect(fixture.sessions.size).toBe(0));
}, 20_000);
